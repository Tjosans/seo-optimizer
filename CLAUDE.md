# seo-optimizer — Project Handoff

## Start here

Read [`ROADMAP.md`](./ROADMAP.md) first — it holds the phase list, what is done, what is next, and the decisions already made with their reasons. Update it in the same commit as the code change when you complete something.

## What is this?

seo-optimizer is an SEO launch-readiness auditor. It crawls a site, runs it against a versioned corpus of checks — v5.0, 98 checks across 8 corpus phases, is the current one — and grades what launched. The system is a pipeline of independent packages:

- **@seo/core** — types for checks, check state, both readiness assessments (launch readiness, and v5.0's READY FOR CUTOVER with review freshness), and the site inputs a person supplies (AI crawler policy)
- **@seo/corpus** — loader for the versioned check corpus (YAML phases 0-7, source TSV); `CURRENT_CORPUS_VERSION` names the methodology the detectors follow (5.0), and v4.4 stays on disk so audits pinned to it can be re-graded
- **@seo/crawler** — site crawler respecting robots.txt, redirect chains, sitemaps (and the video and news entries they declare), flagging any response body it had to cut; stops between requests on a caller's signal; makes the auxiliary requests probes are not allowed to make themselves; `renderPage` runs a page through a headless Chromium instead of a raw fetch, so `extract()` can read the DOM a browser builds, scripts included
- **@seo/probes** — 13 detector categories (accessibility, commerce, content, delivery, facets, indexability, markup, media, metadata, news, qa, site, video)
- **@seo/persistence** — sink that streams crawls and probe runs into Postgres
- **@seo/queue** — in-process job queue: bounded concurrency, one crawl at a time per origin, retries on a caller's policy, outstanding work written to an optional durable store and held on a lease it renews
- **@seo/job-store** — the Postgres `JobStore` behind that queue, so a restart resumes what was queued
- **@seo/scheduler** — the front door: submit an audit, get an id back, crawl and probes run on the queue, failures a repeat could fix are retried, and `recover()` resumes what a previous process left queued
- **@seo/grader** — reads probe evidence against the corpus, writes checkStates, freezes readiness
- **@seo/db** — Drizzle schema, migrations, client factory
- **@seo/storage** — content-addressed `BlobStore` over S3/GCS/MinIO for page bodies, keyed by their own sha256 so a body already stored costs a read, not a write; not yet called by anything (see gotcha 5)
- **@seo/testkit** — in-memory fixture website for tests

Note: the corpus's "phases 0-7" are a property of the SEO check taxonomy. They are unrelated to the delivery phases in `ROADMAP.md`.

## Stack

- Node.js >= 24 (ES modules)
- TypeScript 5.7 with project references
- Vitest (tests run against source; no build needed for most)
- Postgres 17 + Drizzle ORM + drizzle-kit migrations
- Redis 7 (in docker-compose, not yet integrated in code)
- MinIO (S3-compatible, in docker-compose for local dev) behind `@seo/storage`; production points the same client at real S3 or GCS
- No UI and no `apps/` directory yet — this is a library

## Getting started

Prerequisites: Node.js 24+, Docker.

```bash
npm install
npx playwright install chromium   # headless browser @seo/crawler's renderPage drives
cp .env.example .env
npm run stack:up          # Postgres on localhost:5433, Redis on localhost:6380, MinIO on localhost:9002
npm run db:migrate
npm run build
npm test                  # integration tests auto-skip if DATABASE_URL/STORAGE_ENDPOINT are unset
```

Key scripts:

- `npm run typecheck` — full TypeScript validation (`tsc --build --force`)
- `npm run test:watch` — Vitest in watch mode
- `npm run corpus:compile -- <version>` — bootstrap a new corpus version from its TSV export; refuses to overwrite one that exists
- `npm run corpus:validate` — corpus integrity
- `npm run probes:matrix` — detector coverage vs corpus checks
- `npm run analyze -- <url>` — prototype: crawl, probe and grade a live URL, print a report, save a snapshot to `benchmarks/runs/`
- `npm run compare -- <older.json> <newer.json>` — diff two snapshots to see whether a change improved coverage or verdicts
- `npm run release -- <file.yaml> [--dry-run]` — enter a site's release and review runs from a file (format: `scripts/release.example.yaml`); needs the database
- `npm run db:generate` — diff schema and write a new migration
- `npm run db:studio` — Drizzle Studio against the live database
- `npm run stack:down` — stop containers

## How it works

1. **Crawl** (`@seo/crawler`) — breadth-first from seeds, respects robots.txt, extracts links and metadata, paced politeness delay, bounded by page/depth budget. The page budget is spent across two lanes, one request for one: the walk (the seeds and whatever a link led to) and the sitemap URLs. A lane that runs dry gives the rest of the budget to the other, so a site with no sitemap is walked exactly as before and a site with a huge one no longer spends the whole budget on it. What either budget left unfetched is recorded on `CrawlResult.notReached`, not dropped. It also makes the *auxiliary* requests that sit outside the walk — the four scheme/host spellings of the seed, and the root document's declared icons — and records them on `CrawlResult.auxiliary`. One more is not a request at all: a TLS handshake with the host the root document landed on, offering `h2` and `http/1.1` as a browser does, recorded on `CrawlResult.protocol`, because Node's `fetch` speaks HTTP/1.1 whatever the server offers and so no page fetched says anything about HTTP/2. Probes never fetch: politeness is owed to a host, and the crawl loop is the only thing that knows what was promised. Host variants are skipped for a seed that cannot have them (an IP, `localhost`, any single-label host), which is why they never fire against the fixture site.
2. **Extract** — parse each page's HTML; record head tags, links, hierarchy, structure.
3. **Probe** (`@seo/probes`) — detectors observe the crawl result and emit evidence.
4. **Persist** (`@seo/persistence`) — stream pages and probes into Postgres.
5. **Grade** (`@seo/grader`) — read the evidence against the pinned corpus, write `checkStates`, link each verdict to the observations behind it, and freeze launch readiness (`@seo/core`) onto `audits.readiness`.

`@seo/scheduler` drives all five steps for one audit and owns its row's lifecycle; `@seo/queue` decides how many audits run at once and refuses to run two against one host — across workers too, when they share a leased store.

### What a lane is

- An audit's lane is the host its requests reach: `auditLane(origin)` in @seo/scheduler drops the scheme, a default port and a leading `www.`. Every crawl requests all four scheme/www spellings of its seed, so two site records spelled `http://example.com` and `https://www.example.com` are one lane. A non-default port and any other subdomain stay separate lanes.
- Within a process the queue's own memory keeps a lane to one job. Across processes it cannot, so a leasing queue asks the store first: `JobStore.acquire` writes the job down as `running` only if no other *live* worker is running a job in that lane, under a Postgres advisory lock on `(queue, lane)` so two workers asking at once cannot both win.
- A refusal costs no attempt. The job goes back in line, emits `lane-held`, and asks again a heartbeat later. A store that cannot answer counts as a refusal.
- A dead worker's `running` row stops holding its lane when its lease ages out, as its job does. `load` writes recovered jobs back as `queued`, so a job waiting for a slot holds no lane.
- Lanes are per namespace. Two queue namespaces crawling one host do not see each other.

### What durable means here

- The queue keeps scheduling state in memory — busy lanes, free slots, what runs next — and writes the one fact that has to outlive the process to a `JobStore`: this work was asked for and has not happened.
- `PostgresJobStore` (@seo/job-store) is that store, backed by the `jobs` table. Pass it to `AuditScheduler` as `store`, and call `await scheduler.recover()` once on the way up.
- Only the enqueue write blocks. `submit()` does not resolve until the job is written down, so an id handed back is a promise the work will happen. Every later transition is best-effort — a lost update costs a repeated run, never a lost audit.
- Settled jobs are deleted from `jobs`. What became of an audit is already on `audits`.
- Delivery is at-least-once: a process that dies between a handler returning and the removal landing runs that job again. Handlers must tolerate a repeat, which an audit already does.
- Recovery only finds work the store knows about. `scheduler.reconcile()` is the sweep for the rest: a row from before this process started, with no job behind it, is closed out as `failed` with `ORPHANED_AUDIT_ERROR` rather than left pending forever. Call it after `recover()`; it refuses to run before, and refuses without a store, because either way every pending audit would look abandoned.
- One process per `queue` namespace, unless the store leases. Without `leaseMs` the store claims everything under the name and `owner` is a diagnostic; nothing stops a second process, and nothing would divide the work sensibly if there were one.

### What a lease is for

- A second worker can share a namespace once the store hands out claims that expire. `new PostgresJobStore({ …, owner: 'worker-1', leaseMs: 30_000 })` and `heartbeatMs` on the scheduler or queue are the whole of the wiring.
- `load` then takes only what is free — never claimed, already this owner's, or held by a claim older than the lease — so two workers starting at once divide the backlog instead of both running it.
- `renew` is how a live worker keeps saying "still mine", and how it finds out when the answer has become no. A claim that is not renewed ages out and the job becomes anybody's; that is the only thing that makes a dead worker's work recoverable, and the only thing that makes a live worker's work safe.
- Expiry is measured by the database clock, for the same reason `reconcile`'s cutoff is.
- Set `heartbeatMs` well under `leaseMs` — a third is the usual shape. A claim that expires while the crawl is still running hands that site to a second crawler, which is precisely the politeness the lane rules exist to keep.
- Give each worker an `owner` that survives a restart (a pod name, a slot number). The default is host and pid, which is fine for diagnostics and wrong for recovery: a process back under a new name cannot reclaim its own rows and has to wait out its own lease.
- Losing a lease is not a failure of the work. The queue aborts the job's signal, settles it `failed` with `JobLeaseLostError`, does not retry it, and writes nothing further to the store — the row is the new owner's. `runAudit` leaves the `audits` row alone for the same reason: the audit is still running, just not here.
- `reconcile` asks the store what is outstanding for *anyone* before it writes a row off, so a second worker's audits are never closed out from under it.
- Two workers handed audits of one site crawl it one at a time — see "What a lane is" above.
- A worker takes on abandoned work twice over: `recover()` on the way up, and `JobStore.adopt` on every heartbeat thereafter. A claim that has aged out means nobody alive holds that job — a live worker renews its whole backlog, queued jobs included — so a worker that dies at noon has its work picked up by a healthy worker within a heartbeat instead of waiting for someone to restart a process. At most `ADOPTION_BATCH` (25) per beat, so two live workers divide a dead one's backlog; never a worker's own rows, because rewriting those would stamp a running job as queued and drop its lane; and never while paused, because a paused worker would hold the work without running it. A queue holding nothing of its own keeps beating to watch for this, on an unref'd timer that does not keep the process alive. @seo/scheduler puts an adopted audit's row back to `pending` when the `adopted` event arrives, which is `recover`'s reset by another route.

### What cancelling does

- `scheduler.cancel(auditId)` on a queued audit means it never starts. On a running one the signal reaches `crawl()`, which checks it between requests and inside the politeness delay, so the crawl stops after at most the one request already in flight.
- The request in flight is allowed to finish. Abandoning it saves the site nothing — the bytes are already coming — and a half-read response is not something to hand the extractor.
- Pages already streamed to the database stay. They are evidence of what was there, not debris.
- Both the `audits` row and the `crawls` row read `cancelled` with a null `error`. A cancelled audit is something a person did; a failed one is something to investigate, and the two must not be confused in a report.
- Cancellation is never retried. `runAudit` restates the crawler's `CrawlCancelledError` as `JobCancelledError`, which `auditRetryPolicy` treats as permanent.

### What a retry is and is not

- A retry is the *same* audit running again: one id, one row, a second crawl under it. The failed crawl stays, with whatever it persisted before it died.
- Between attempts the row goes back to `pending` with the last failure readable in `error`. `failed` on the row means no further attempt is coming.
- The queue holds the mechanism and `@seo/scheduler`'s `auditRetryPolicy` holds the policy: cancellation, an unknown site, an unavailable corpus and runtime errors about the program are permanent; everything else gets three attempts, backing off from 30 seconds.
- A site that answers 403, times out, or serves a broken page does not fail an audit at all — the crawler returns transport failures as data. By the time a retry is considered, the engine or its infrastructure fell over, not the site.

### How the corpus changes

- **The YAML is the source of record.** `corpus/v<version>/*.yaml` is what the engine reads and what you edit. The TSV under `corpus/source/` is the workbook's provenance record, and it is the source for exactly one event: the first compile of a version.
- **A methodology revision is a new version directory**, compiled from a new export: `npm run corpus:compile -- 4.5 --reviewed 2026-09-07`. Never a re-compile over a live one — a delivered report pins `audits.corpusVersion` and has to keep explaining itself afterwards.
- **Every row needs a triage entry.** `scripts/triage.ts` holds one table per version, mapping check id to `[automation tier, remediation class, detector ids]`, and `triageFor(version)` is what the compiler reads; it exits non-zero and names any untriaged row, and refuses a version with no table. Both tables are signed off: v4.4's on 2026-09-04, v5.0's on 2026-09-14.
- **Citations resolve by stable id from v5.0 on.** Notes say "Source IDs: SRC006; SRC040" and the Sources export carries the id in column E; an id the Sources sheet does not hold fails the compile. v4.4's "See Sources: X" topic match is kept for older exports.
- **Detectors follow the current methodology, not the version an audit pins.** Adopting a new version means changing `CURRENT_CORPUS_VERSION` and bringing the detectors to its wording. An older audit stays explainable because its probe results are stored and re-gradable; a new crawl is judged by the detectors as they are now.
- **A check id means what the current workbook says it means.** v5.0 gave 3.9 a new requirement (batch and AI-generated publishing), so the two content detectors that read authorship, dates and answer structure moved with their subject into 3.5.
- **Every "Applies to" wording needs a mapping** in the compiler's `APPLICABILITY` table, or the row compiles as `UNMAPPED` and the loader refuses it.
- **`manifest.yaml` carries `checkCount`**, and `loadCorpus` throws when it disagrees with the files. Editing checks by hand means editing that number.
- **Tests follow automatically.** `packages/corpus/test/corpus.test.ts` discovers every `corpus/v*` directory and applies the structural invariants to each; `provenance.test.ts` is frozen to v4.4 and `provenance-v5.0.test.ts` to v5.0, each against its own workbook, and neither is edited when the corpus grows.
- **Adding a detector needs no migration.** Write the probe, add it to its category array in `packages/probes/src/probes/`, and the matrix test will fail if no corpus check declares its id. `probe_results.probeId` is text, and the grader defaults to whatever the registry holds.
- **A site's AI crawler policy is an input, not an observation.** `sites.aiPolicy` (jsonb) holds `{ agents: { GPTBot: 'disallow', … }, approvedAt, approvedBy }` — see `AiCrawlerPolicy` in @seo/core. Nothing observable can stand in for it: a site that wants to be in AI answers and one that wants to be out look identical from outside. `ai-crawler-directive-verify` is `not-applicable` without one, and `submit()` refuses a malformed one before it writes the audit row. Agent names are text keys because new crawlers appear faster than a migration should.

- **A new site-profile flag needs no migration either** — `sites.flags` is `text[]` and the corpus defines the vocabulary. But an audit now fails fast (`UnknownSiteFlagsError`, permanent) when a site declares a flag the pinned corpus does not name, because `resolveScope` would otherwise narrow those checks to `no` with a rationale that reads deliberate.
- **A site profile is tied to the corpus version it was declared against.** `sites.profileCorpusVersion` records it, and an audit of a site with flags fails fast (`StaleSiteProfileError`, permanent) when that is not the pinned version. A version can make a universal check conditional on a flag the profile's author never saw — v5.0 did it to 2.2, image alt text, a launch gate — and a missing flag would read as a decision. An empty profile needs no version, because it states nothing. Migration 0007 recorded `4.4` on every profile filled in before the column existed.

### What supplied evidence is

- Some checks turn on facts nothing observable can supply — a URL matrix, a redirect map, Search Console exports. A person hands them over as `AuditInputs` (@seo/core `inputs.ts`): an optional bag of named sections on `SiteContext.inputs`, next to `aiPolicy` and `previous`. A probe reads it and never fetches.
- `parseInputs` is strict, as `parseReleaseFile` is: an unknown section, a number where text belongs and a date that does not parse are refused, every problem listed by path (`InputsError`). `npm run analyze -- <url> --inputs <file.yaml>` reads one; `scripts/inputs.example.yaml` documents the format. There are no sections yet — each arrives with the detector that reads it.
- Every record shares one shape, `InputRecord`: `{ owner, recordedAt, nextReviewAt? }`; sections validate it with `parseInputRecord`.
- **A missing section makes the detectors that read it `not-applicable`.** Absence is never read as an answer.
- **A record with no owner, or past its `nextReviewAt`, holds its check** (`warn`, so the check stays `in-progress`), judged by `inputRecordProblem(record, at)` at the crawl's time, never the wall clock. Evidence nobody answers for, or nobody has looked at lately, is not proof.

### What the grader will and will not say

- A machine may **fail** a check; only an `automated` check may be **passed** by one. `assisted` means the engine proposes and a person confirms.
- A warning holds a check `in-progress` with basis `held-by-warning`, on an `assisted` check as on an automated one, so the person confirming it sees the warning rather than "none failed".
- A detector that is unimplemented, errored, or observed nothing leaves the check `not-started` / `unknown`. Missing evidence is never good news, and never bad news either.
- Scope comes from `sites.flags`: an empty profile leaves conditional checks at `review`; a filled-in one narrows non-matching checks to `no` with a written rationale.
- Roughly half of v5.0's 134 detectors exist, so today most automated checks cannot be graded end to end and most audits come back mostly ungraded. That is the honest answer, not a bug. `npm run probes:matrix` prints the current figure; do not quote one from memory.
- A row a human attested is never overwritten by a re-grade, and it counts in the frozen readiness until its `attestationExpiresAt`; readiness is assessed at `gradedAt`, and a lapsed attestation stays on the record but holds its gate.

### What READY FOR CUTOVER adds

- v5.0 has two calculated assessments. `computeLaunchReadiness` is the first (gates passed, conditional gates decided). `computeCutoverReadiness(corpus, states, release)` in @seo/core is the second, and returns both READY FOR CUTOVER and the final GO.
- A gate's evidence class comes from its phase: 0 is `planning`, 5 is `live`, the rest `preflight`. Cutover needs every planning and preflight gate passed with complete evidence; final GO needs the live gates too, tested in production after `cutover.cutoverAt`, and a valid cutover record bound to a READY FOR CUTOVER result.
- Evidence is complete only when the gate's latest review run *in the current context* (release, scope revision, origin, criterion revision, an environment its class allows) is `current`: passed, not past `nextReviewAt`, and agreeing with the state's status and evidence. `reopened`, `failed`, overdue, tied or invalid history holds the gate. Runs are append-only; a retest is a later run.
- Freshness is judged at `release.assessedAt`, never the wall clock.
- Neither result is a human decision. A 5.7 GO recorded while the calculation says HOLD comes back as `launchDecision: 'conflict'`.
- Releases live in `releases` (one row per site and release name, blank fields allowed and counted) and review runs in `review_runs`, keyed by site. A trigger refuses any UPDATE or DELETE on `review_runs`; only a site's deletion cascades through. `recordReviewRun` (@seo/grader) refuses a run the assessment would count as an input error, because a bad row could never be removed.
- Until the audit API exists, a person enters both through a release file: `npm run release -- <file.yaml>`, backed by `parseReleaseFile` and `importReleaseFile` (@seo/grader `release-file.ts`). The site must already be on record. The import refuses an unknown key, a number where text belongs and an unparseable date rather than store a blank; checks every run before writing any and writes the release and runs in one transaction; and skips a run the log already holds unchanged while refusing one it holds differently, so a file that grows can be imported again.
- `submit({ release: '<name>' })` sets `audits.release_id`; `recordGrade` then freezes `cutover` onto `audits.readiness`, assessed at `gradedAt`. An audit with no release freezes no cutover block.
- A review run of a machine-verified pass cites `evidenceReference(auditId, checkId)` — `audit:<auditId>#<checkId>` — which `recordGrade` puts on every state it writes as `evidenceRef`. It survives a re-grade that rewords the summary; a run citing the summary text still matches too, until the wording changes. An attested row has no reference: its reviewer cites the person's own evidence.

### Guarantees the sink relies on

- Pages are processed breadth-first from seeds, interleaved with the sitemap lane — so a page is not always followed immediately by its own children, but every page still arrives after the page it was linked from.
- `onPage` is awaited before a page's links are enqueued, so a parent always persists before its children.
- A normalized URL is enqueued at most once, so there are no duplicates.

Together these let the sink resolve `discoveredFromId` from an in-memory map. Breaking any of them breaks persistence in a way the crawler tests will not catch.

### Probe scope

- `site` — runs once across all pages (e.g. redirect-chain-at-root)
- `page` — runs once per page (e.g. canonicalization)
- `template` — once per unique rendered template (not yet used)

### Two detectors can share a subject without sharing a question

International is the worked example, and the pattern generalises. `hreflang-cluster-qa` (4.9) reads the crawl as a whole and asks whether the pages agree with each other — reciprocity, self-references, targets the crawl reached. `hreflang-implementation` (1.14) asks whether what they agree on names anything: ISO 639-1 for the language, ISO 3166-1 alpha-2 for the region, one URL per locale, absolute hrefs. A cluster can be flawlessly reciprocal and completely inert because every page in it reciprocates `en-UK`, so folding the two together would let each hide the other's finding. `locale-canonical` (1.14) is the third: whether a page the cluster names is allowed to be indexed as itself, which is the one instruction that outranks every annotation on the site. It fails a canonical onto another language, where the general `canonicalization` detector only warns, because a translation collapsed into another language is never legitimate. A canonical onto another region of the same language (`en-GB` onto `en-US`) is a `warn`: v5.0 allows that consolidation when the locale plan (0.7) documents it, and only a person holds the plan.

Commerce is the second worked example. `product-variant-canonical` (1.15) asks whether one rule governs which of a product's addresses is the product's; `product-lifecycle-state` (1.15) asks what becomes of that address once the product stops being for sale. A catalogue can hold a flawless canonical rule and still delete every out-of-stock page, or keep every retired product alive at three addresses nobody chose. The two are kept from reporting one fact twice by the route test: a canonical onto a different route is lifecycle consolidation, a canonical onto the same route is variant consolidation.

Video is the third, and the only one where the three detectors split by *artefact* rather than by question. `video-watch-page` (2.14) judges the page a video sits on — indexable, with the player and thumbnail robots.txt actually allows, and with words around the player saying what it is — unless the page declares itself a product or an article, because v5.0 says a page with supplemental video is not a dedicated watch page. `videoobject-schema` (2.14) judges the description, and whether it names the video the page plays: markup complete to the last property still describes something else if the embed was swapped. `video-sitemap` (2.14) judges the file that lists the watch pages, and only where the site publishes one — its absence is a decision about discovery that no crawl can second-guess, but a sitemap named `video-sitemap.xml` that 404s is a site that believes it is publishing one.

Faceted navigation is the fourth, split into crawl and index. `parameter-crawl-space` (1.12) asks whether the parameter URL space is bounded: session ids in URLs, one filter state at several parameter orders, and a crawl budget spent on permutations of routes already fetched all say it is not. `faceted-nav-control` (1.12) asks whether each filtered page the crawl opened has a decision behind it — self-canonical and distinct from its listing, or noindexed or canonicalized away and kept out of the sitemap. A site can noindex every filter flawlessly and still hand a crawler ten thousand of them. Neither passes on what the crawl did not walk: filter URLs found and left unfetched hold the check with a `warn`, because whether a space closes is only observed by walking it. Pagination, internal search and product variant parameters stay with 1.13, 1.4 and 1.15.

Content is the fifth, split by how many pages a question needs. Both detectors grade 3.5 under v5.0 (3.9 under v4.4, whose 3.9 v5.0 replaced with batch publishing). `answer-first-structure` reads one page's reading matter — the main landmark, a lone article, or the body without navigation, asides and page chrome — and asks whether it is signposted and whether every question heading has text beneath it. `author-date-signals` reads every page declaring itself an article — a schema.org Article type, or an Open Graph article with a publication time, never `og:type` alone — together, because the failure the corpus names outright, bylines and dates "as site-wide boilerplate", cannot be seen from inside one page: a `dateModified` identical to the second on every article is a build, not an edit. Both fail only what is false on its face, and the check is `assisted` in either version, because whether a page answers its query is a reader's call.

News is the sixth, split by who answers for it. 2.18 declares `news-sitemap` and `news-article-policy`. The first judges the feed — news metadata only on articles from the last two days, at most 1,000 entries to a file, a publication name, language, W3C publication date and title on every entry — and only where a site publishes one: v5.0 says ordinary websites need no news sitemap and that an empty feed is acceptable. Age is measured against `SitemapFetch.fetchedAt`, the moment the file was served, never the clock when the probe runs. The second judges the publisher, on the pages the feed lists or that type themselves NewsArticle: a byline and a date on each, a page date the feed does not contradict by more than a day, a contact and an about link (or a publisher in structured data) somewhere in the crawl, and a disclosure on any page the site itself types or files as advertising. It fails only the contradiction and the undisclosed advertising; a missing byline or contact page is held for the policy review, which stays a person's because 2.18 is `assisted`.

Pre-launch QA is the seventh, and the split is by what a finding sits between. 4.1 declares `broken-links` and `metadata-completeness` beside `raw-rendered-crawl-diff`, which waits on Phase 5. `http-status` (1.4) judges one response; `broken-links` judges the pages that send visitors to it, so one dead URL on forty templates is reported with the pages carrying it. It checks external targets too, through a bounded, paced auxiliary pass the crawl loop runs after the walk (@seo/crawler: `AuxiliaryFetch` reason `external-link`, at most 3 requests per external host and 30 in total, round-robin across hosts); either kind holds with a `warn` when the crawl did not verify it, so a crawl smaller than the site — or with more external links than the auxiliary budget — never passes it outright. `metadata-completeness` fails a missing title and every indexation conflict (a noindex or robots-disallowed sitemap entry, noindex beside a canonical elsewhere, meta robots against `X-Robots-Tag`, a canonical onto a URL that redirects, errors or is noindex). It warns on a missing description, h1 or canonical, which the page-level detectors already judge, and on a canonical that redirects straight back to its page, which is what a geo-redirecting edition front looks like from one place.

## Testing

Unit tests (no database needed): `packages/core/test/{site,cutover}.test.ts`, `packages/corpus/test/{corpus,provenance,provenance-v5.0,versions}.test.ts`, `packages/crawler/test/{crawl,cancel,fetch,protocol,render,robots,sitemap,url}.test.ts`, `packages/probes/test/{probes,detectors,facets,news,qa,matrix}.test.ts`, `packages/queue/test/{queue,crawl-queue,retry,store,lease}.test.ts`, `packages/grader/test/{grade,release-file}.test.ts` (the parser half), `packages/scheduler/test/{retry,lane}.test.ts`.

Integration tests (need `npm run stack:up`): `packages/db/test/schema.test.ts`, `packages/persistence/test/persistence.test.ts`, `packages/scheduler/test/{scheduler,recovery,cancel,flags,ai-policy,release}.test.ts`, `packages/job-store/test/postgres.test.ts`, `packages/grader/test/{record,release,release-file}.test.ts`, `packages/storage/test/s3-blob-store.test.ts` (against MinIO; skips on `STORAGE_ENDPOINT`, not `DATABASE_URL`, and creates its bucket itself on first run).

All tests skip gracefully if `DATABASE_URL` is unset — which means a green local run does not prove the database layer works. `vitest.config.ts` aliases packages to source, so no build step is needed during test.

`provenance.test.ts` is frozen against the v4.4 workbook: 97 checks, phase distribution (9, 19, 17, 13, 12, 8, 9, 10), priority (P0:55, P1:35, P2:7), profile (core:68, extended:29), and the launch-readiness block. `provenance-v5.0.test.ts` is frozen against the v5.0 workbook (SHA-256 1165d18b…612a): 98 checks, phases (9, 19, 18, 13, 12, 8, 8, 11), priority (P0:54, P1:35, P2:9), profile (core:68, extended:30), 108 sources, and its final-assessment block, and its cutover-readiness block (HOLD; 25 pre-cutover and 4 live gates outstanding; 8 scope errors; evidence classes 5/43/6). Do not update those numbers — a newer methodology is a new version with a provenance file of its own.

`corpus.test.ts` runs the version-independent invariants against every `corpus/v*` directory it finds: unique ids, phases in range, the detector/tier contract, conditional checks having a way into scope, and launch-gate semantics. A new version is covered the moment it lands.

`versions.test.ts` proves two versions load and grade side by side, using the fixtures under `packages/corpus/test/fixtures/` (deliberately outside `corpus/`, and numbered 9.0/9.1 so no real version is shadowed).

## CI

`.github/workflows/ci.yml` runs on push to main/master and all PRs: spins up Postgres 17 as a service, starts a MinIO container directly (GitHub's `services:` cannot pass MinIO the `server /data` argument it needs to run rather than print its own help), then `npm ci`, `db:migrate`, `build`, `typecheck`, `test`. Integration tests do execute in CI because `DATABASE_URL` and `STORAGE_ENDPOINT` are both set there.

`master` is gated server-side by the repository ruleset "Require CI on master": a pull request is required, `test` and `roadmap` must pass, the branch must be up to date, and force-push and deletion are refused. Approvals are zero because GitHub forbids approving your own PR, so the checks are the gate. `roadmap` comes from `.github/workflows/roadmap-check.yml`, which asserts ROADMAP.md exists and still holds checkbox items.

`.githooks/pre-push` runs the same typecheck and test before a push to `master` (not feature branches), so a failure surfaces locally in seconds rather than in CI minutes later. Opt-in per clone:

```bash
git config core.hooksPath .githooks
```

It is bypassable with `--no-verify` and is a convenience, not the gate — the ruleset is.

## Layout

```
packages/
  core/src/{check,state,readiness,review,cutover,site}.ts
  corpus/src/{load,flags,current}.ts
  crawler/src/{crawl,extract,fetch,protocol,robots,sitemap,url}.ts
  db/src/{schema,enums,client}.ts  +  migrations/0000-0008
  persistence/src/{crawl-sink,map,probe-results}.ts
  probes/src/{registry,types,matrix}.ts  +  src/probes/*.ts
  queue/src/{queue,retry,store,types}.ts
  job-store/src/postgres.ts
  scheduler/src/{scheduler,run-audit,retry,lane,types}.ts
  grader/src/{grade,scope,record,release,release-file,types}.ts
  storage/src/{blob-store,s3-blob-store,config}.ts
  testkit/src/{fixture-site,tls-server}.ts
corpus/
  source/v4.4.tsv                  # immutable workbook export
  source/v5.0{,-sources,-progress,-how-to-use}.tsv  # v5.0 workbook export
  v4.4/phase-0.yaml … phase-7.yaml # compiled checks (97)
  v5.0/phase-0.yaml … phase-7.yaml # compiled checks (98), the current corpus
  v{4.4,5.0}/{manifest,sources}.yaml
scripts/{analyze,compare,compile-corpus,probe-matrix,record-release,triage}.ts  +  release.example.yaml
```

## Known gotchas

1. **drizzle-kit is strict.** Changing `schema.ts` without `npm run db:generate` makes migrations fail. Always diff first.
2. **`npm run corpus:compile` bootstraps a version and then refuses.** It takes a required version argument, reads `corpus/source/v<version>.tsv`, and will not overwrite a version directory that already exists. `--force` does, discarding every hand edit — it is for fixing a botched bootstrap, not for editing the corpus.
3. **Integration tests skip silently** when `DATABASE_URL` or `STORAGE_ENDPOINT` is unset. Run `npm run stack:up` before trusting a green test run.
4. **The pre-push hook is opt-in** and must be enabled in each clone. It is a local convenience; the real gate is the server-side ruleset on `master`.
5. **Response bodies are external by design.** The schema stores hashes and keys only. `@seo/storage`'s `BlobStore` is the content-addressed object store behind that key — `put(bytes)` hashes them, skips the write if that hash is already there, and returns the key `renders.bodyKey` holds. `@seo/persistence`'s `openCrawl`/`crawlToDatabase` take an optional `blobStore`: given one, each page's raw body is uploaded before its render row is written and `bodyKey` carries the result; given none — every caller today, including `@seo/scheduler`'s `runAudit` — `bodyKey` stays null exactly as before. Wiring a configured store into the scheduler, and a retrieval client for reconstructing an archived crawl, are the rest of Phase 6.
6. **A body over its limit is cut, and says so.** `fetchPage` reads every body a chunk at a time and cancels the response at `maxBytes` (5 MB by default), setting `FetchResult.truncated`; `byteLength` of a cut body is how far the read got, not the size. Sitemaps are different: they are streamed through `createSitemapParser` (@seo/crawler `sitemap.ts`), opened first when they are gzip files (`gunzip`, recognised by magic bytes, not by label), and read up to `SITEMAP_MAX_BYTES`, the protocol's own 50 MB ceiling on the *expanded* size — so IGN's 4–7 MB quarterly files and TED's 10 MB one are read whole. A sitemap past that, or a gzip file damaged part way, is still marked on `CrawlResult.sitemaps`; the entry the cut severed is dropped, but what was read is still partial, so any detector reading a large document must check the flag and report `error`, never `fail`.
7. **The crawler does not use the global `fetch`.** `fetchPage` requests through an undici 8 `Agent` of its own. The global `fetch` dispatches through whichever undici installed itself first — in a crawler process, cheerio's undici 7, whose HTTP/1.1 client crashes the process (an uncaught `assert(!this.paused)`) when a TLS server closes a gzip-encoded response behind a paused body. Under vitest Node's own dispatcher wins instead, which hides that crash from tests; `fetch.test.ts` restores cheerio's dispatcher for the HTTPS suite for that reason.

## What to pick up next

`ROADMAP.md` Phase 4 is the current phase. The job queue (`@seo/queue`), the audit scheduler (`@seo/scheduler`), the grader (`@seo/grader`) and durable queue storage (`@seo/job-store`) are in; lease expiry (@seo/job-store, @seo/queue) is in, so a second worker can share a queue namespace, and lanes hold across workers, so two of them never crawl one host together; what remains is detector coverage, the single thing most limiting what an audit can say (`npm run probes:matrix` prints the current figure); `ROADMAP.md` lists one checkbox per remaining detector, with the evidence each needs (a supplied input, a mobile render, a previous audit) scheduled ahead of it — Releases and review runs are stored and READY FOR CUTOVER is frozen onto an audit that names a release; until the audit API exists they are entered from a file with `npm run release`. Phases 5-8 cover rendered crawl, external body storage, the audit API, and the dashboard.
