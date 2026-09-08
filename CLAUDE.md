# seo-optimizer — Project Handoff

## Start here

Read [`ROADMAP.md`](./ROADMAP.md) first — it holds the phase list, what is done, what is next, and the decisions already made with their reasons. Update it in the same commit as the code change when you complete something.

## What is this?

seo-optimizer is an SEO launch-readiness auditor. It crawls a site, runs it against a versioned corpus of 97 checks across 8 corpus phases, and grades what launched. The system is a pipeline of independent packages:

- **@seo/core** — types for checks, check state, readiness scoring, and the site inputs a person supplies (AI crawler policy)
- **@seo/corpus** — loader for the v4.4 check corpus (YAML phases 0-7, source TSV)
- **@seo/crawler** — site crawler respecting robots.txt, redirect chains, sitemaps; stops between requests on a caller's signal; makes the auxiliary requests probes are not allowed to make themselves
- **@seo/probes** — 6 detector categories (delivery, indexability, markup, media, metadata, site)
- **@seo/persistence** — sink that streams crawls and probe runs into Postgres
- **@seo/queue** — in-process job queue: bounded concurrency, one crawl at a time per origin, retries on a caller's policy, outstanding work written to an optional durable store and held on a lease it renews
- **@seo/job-store** — the Postgres `JobStore` behind that queue, so a restart resumes what was queued
- **@seo/scheduler** — the front door: submit an audit, get an id back, crawl and probes run on the queue, failures a repeat could fix are retried, and `recover()` resumes what a previous process left queued
- **@seo/grader** — reads probe evidence against the corpus, writes checkStates, freezes readiness
- **@seo/db** — Drizzle schema, migrations, client factory
- **@seo/testkit** — in-memory fixture website for tests

Note: the corpus's "phases 0-7" are a property of the SEO check taxonomy. They are unrelated to the delivery phases in `ROADMAP.md`.

## Stack

- Node.js >= 24 (ES modules)
- TypeScript 5.7 with project references
- Vitest (tests run against source; no build needed for most)
- Postgres 17 + Drizzle ORM + drizzle-kit migrations
- Redis 7 (in docker-compose, not yet integrated in code)
- No UI and no `apps/` directory yet — this is a library

## Getting started

Prerequisites: Node.js 24+, Docker.

```bash
npm install
cp .env.example .env
npm run stack:up          # Postgres on localhost:5433, Redis on localhost:6380
npm run db:migrate
npm run build
npm test                  # integration tests auto-skip if DATABASE_URL is unset
```

Key scripts:

- `npm run typecheck` — full TypeScript validation (`tsc --build --force`)
- `npm run test:watch` — Vitest in watch mode
- `npm run corpus:compile -- <version>` — bootstrap a new corpus version from its TSV export; refuses to overwrite one that exists
- `npm run corpus:validate` — corpus integrity
- `npm run probes:matrix` — detector coverage vs corpus checks
- `npm run analyze -- <url>` — prototype: crawl, probe and grade a live URL, print a report, save a snapshot to `benchmarks/runs/`
- `npm run compare -- <older.json> <newer.json>` — diff two snapshots to see whether a change improved coverage or verdicts
- `npm run db:generate` — diff schema and write a new migration
- `npm run db:studio` — Drizzle Studio against the live database
- `npm run stack:down` — stop containers

## How it works

1. **Crawl** (`@seo/crawler`) — breadth-first from seeds, respects robots.txt, extracts links and metadata, paced politeness delay, bounded by page/depth budget. It also makes the *auxiliary* requests that sit outside the walk — the four scheme/host spellings of the seed, and the root document's declared icons — and records them on `CrawlResult.auxiliary`. Probes never fetch: politeness is owed to a host, and the crawl loop is the only thing that knows what was promised. Host variants are skipped for a seed that cannot have them (an IP, `localhost`, any single-label host), which is why they never fire against the fixture site.
2. **Extract** — parse each page's HTML; record head tags, links, hierarchy, structure.
3. **Probe** (`@seo/probes`) — detectors observe the crawl result and emit evidence.
4. **Persist** (`@seo/persistence`) — stream pages and probes into Postgres.
5. **Grade** (`@seo/grader`) — read the evidence against the pinned corpus, write `checkStates`, link each verdict to the observations behind it, and freeze launch readiness (`@seo/core`) onto `audits.readiness`.

`@seo/scheduler` drives all five steps for one audit and owns its row's lifecycle; `@seo/queue` decides how many audits run at once and refuses to run two against one origin.

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
- **Every row needs a triage entry.** `scripts/triage.ts` maps check id to `[automation tier, remediation class, detector ids]` and requires sign-off; the compiler exits non-zero and names any untriaged row. The current table is signed off against v4.4 only.
- **Every "Applies to" wording needs a mapping** in the compiler's `APPLICABILITY` table, or the row compiles as `UNMAPPED` and the loader refuses it.
- **`manifest.yaml` carries `checkCount`**, and `loadCorpus` throws when it disagrees with the files. Editing checks by hand means editing that number.
- **Tests follow automatically.** `packages/corpus/test/corpus.test.ts` discovers every `corpus/v*` directory and applies the structural invariants to each; `provenance.test.ts` is frozen to v4.4 and its workbook, and must not be edited when the corpus grows.
- **Adding a detector needs no migration.** Write the probe, add it to its category array in `packages/probes/src/probes/`, and the matrix test will fail if no corpus check declares its id. `probe_results.probeId` is text, and the grader defaults to whatever the registry holds.
- **A site's AI crawler policy is an input, not an observation.** `sites.aiPolicy` (jsonb) holds `{ agents: { GPTBot: 'disallow', … }, approvedAt, approvedBy }` — see `AiCrawlerPolicy` in @seo/core. Nothing observable can stand in for it: a site that wants to be in AI answers and one that wants to be out look identical from outside. `ai-crawler-directive-verify` is `not-applicable` without one, and `submit()` refuses a malformed one before it writes the audit row. Agent names are text keys because new crawlers appear faster than a migration should.

- **A new site-profile flag needs no migration either** — `sites.flags` is `text[]` and the corpus defines the vocabulary. But an audit now fails fast (`UnknownSiteFlagsError`, permanent) when a site declares a flag the pinned corpus does not name, because `resolveScope` would otherwise narrow those checks to `no` with a rationale that reads deliberate.

### What the grader will and will not say

- A machine may **fail** a check; only an `automated` check may be **passed** by one. `assisted` means the engine proposes and a person confirms.
- A detector that is unimplemented, errored, or observed nothing leaves the check `not-started` / `unknown`. Missing evidence is never good news, and never bad news either.
- Scope comes from `sites.flags`: an empty profile leaves conditional checks at `review`; a filled-in one narrows non-matching checks to `no` with a written rationale.
- Only 42 of the corpus's 128 detectors exist, so today 18 of 43 automated checks can be graded end to end and most audits come back mostly ungraded. That is the honest answer, not a bug. `npm run probes:matrix` prints the current figure; do not quote one from memory.
- A row a human attested is never overwritten by a re-grade, and it counts in the frozen readiness.

### Guarantees the sink relies on

- Pages are processed breadth-first from seeds.
- `onPage` is awaited before a page's links are enqueued, so a parent always persists before its children.
- A normalized URL is enqueued at most once, so there are no duplicates.

Together these let the sink resolve `discoveredFromId` from an in-memory map. Breaking any of them breaks persistence in a way the crawler tests will not catch.

### Probe scope

- `site` — runs once across all pages (e.g. redirect-chain-at-root)
- `page` — runs once per page (e.g. canonicalization)
- `template` — once per unique rendered template (not yet used)

### Two detectors can share a subject without sharing a question

International is the worked example, and the pattern generalises. `hreflang-cluster-qa` (4.9) reads the crawl as a whole and asks whether the pages agree with each other — reciprocity, self-references, targets the crawl reached. `hreflang-implementation` (1.14) asks whether what they agree on names anything: ISO 639-1 for the language, ISO 3166-1 alpha-2 for the region, one URL per locale, absolute hrefs. A cluster can be flawlessly reciprocal and completely inert because every page in it reciprocates `en-UK`, so folding the two together would let each hide the other's finding. `locale-canonical` (1.14) is the third: whether a page the cluster names is allowed to be indexed as itself, which is the one instruction that outranks every annotation on the site. It fails a non-self canonical where the general `canonicalization` detector only warns, because pointing elsewhere is legitimate for a known duplicate and never legitimate for a locale.

## Testing

Unit tests (no database needed): `packages/corpus/test/{corpus,provenance,versions}.test.ts`, `packages/crawler/test/{crawl,cancel,robots,url}.test.ts`, `packages/probes/test/{probes,detectors,matrix}.test.ts`, `packages/queue/test/{queue,crawl-queue,retry,store,lease}.test.ts`, `packages/grader/test/grade.test.ts`, `packages/scheduler/test/retry.test.ts`.

Integration tests (need `npm run stack:up`): `packages/db/test/schema.test.ts`, `packages/persistence/test/persistence.test.ts`, `packages/scheduler/test/{scheduler,recovery,cancel,flags,ai-policy}.test.ts`, `packages/job-store/test/postgres.test.ts`, `packages/grader/test/record.test.ts`.

All tests skip gracefully if `DATABASE_URL` is unset — which means a green local run does not prove the database layer works. `vitest.config.ts` aliases packages to source, so no build step is needed during test.

`provenance.test.ts` is frozen against the v4.4 workbook: 97 checks, phase distribution (9, 19, 17, 13, 12, 8, 9, 10), priority (P0:55, P1:35, P2:7), profile (core:68, extended:29), and the launch-readiness block. Do not update those numbers — a newer methodology is a new version with a provenance file of its own.

`corpus.test.ts` runs the version-independent invariants against every `corpus/v*` directory it finds: unique ids, phases in range, the detector/tier contract, conditional checks having a way into scope, and launch-gate semantics. A new version is covered the moment it lands.

`versions.test.ts` proves two versions load and grade side by side, using the fixtures under `packages/corpus/test/fixtures/` (deliberately outside `corpus/`, and numbered 9.0/9.1 so no real version is shadowed).

## CI

`.github/workflows/ci.yml` runs on push to main/master and all PRs: spins up Postgres 17 as a service, then `npm ci`, `db:migrate`, `build`, `typecheck`, `test`. Integration tests do execute in CI because `DATABASE_URL` is set there.

`master` is gated server-side by the repository ruleset "Require CI on master": a pull request is required, `test` and `roadmap` must pass, the branch must be up to date, and force-push and deletion are refused. Approvals are zero because GitHub forbids approving your own PR, so the checks are the gate. `roadmap` comes from `.github/workflows/roadmap-check.yml`, which asserts ROADMAP.md exists and still holds checkbox items.

`.githooks/pre-push` runs the same typecheck and test before a push to `master` (not feature branches), so a failure surfaces locally in seconds rather than in CI minutes later. Opt-in per clone:

```bash
git config core.hooksPath .githooks
```

It is bypassable with `--no-verify` and is a convenience, not the gate — the ruleset is.

## Layout

```
packages/
  core/src/{check,state,readiness,site}.ts
  corpus/src/{load,flags}.ts
  crawler/src/{crawl,extract,fetch,robots,url}.ts
  db/src/{schema,enums,client}.ts  +  migrations/0000-0006
  persistence/src/{crawl-sink,map,probe-results}.ts
  probes/src/{registry,types,matrix}.ts  +  src/probes/*.ts
  queue/src/{queue,retry,store,types}.ts
  job-store/src/postgres.ts
  scheduler/src/{scheduler,run-audit,retry,types}.ts
  grader/src/{grade,scope,record,types}.ts
  testkit/src/fixture-site.ts
corpus/
  source/v4.4.tsv                  # immutable workbook export
  v4.4/phase-0.yaml … phase-7.yaml # compiled checks (97)
  v4.4/{manifest,sources}.yaml
scripts/{compile-corpus,probe-matrix,triage}.ts
```

## Known gotchas

1. **drizzle-kit is strict.** Changing `schema.ts` without `npm run db:generate` makes migrations fail. Always diff first.
2. **`npm run corpus:compile` bootstraps a version and then refuses.** It takes a required version argument, reads `corpus/source/v<version>.tsv`, and will not overwrite a version directory that already exists. `--force` does, discarding every hand edit — it is for fixing a botched bootstrap, not for editing the corpus.
3. **Integration tests skip silently** when `DATABASE_URL` is unset. Run `npm run stack:up` before trusting a green test run.
4. **The pre-push hook is opt-in** and must be enabled in each clone. It is a local convenience; the real gate is the server-side ruleset on `master`.
5. **Response bodies are external by design.** The schema stores hashes and keys only; the content-addressing store does not exist yet (see Phase 6).

## What to pick up next

`ROADMAP.md` Phase 4 is the current phase. The job queue (`@seo/queue`), the audit scheduler (`@seo/scheduler`), the grader (`@seo/grader`) and durable queue storage (`@seo/job-store`) are in; lease expiry (@seo/job-store, @seo/queue) is in, so a second worker can share a queue namespace; what remains is detector coverage — 86 of the corpus's 128 detectors are unimplemented, which is the single thing most limiting what an audit can say. Phases 5-8 cover rendered crawl, external body storage, the audit API, and the dashboard.
