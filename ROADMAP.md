# Roadmap — seo-optimizer

## Status
Current phase: Phase 4 — Orchestration & Scaling
Last updated: 2026-09-05

## Phase 0 — Foundation
- [x] Create monorepo structure with TypeScript workspace packages
- [x] Implement @seo/core types (Check, CheckState, Readiness)
- [x] Build @seo/crawler with fetch, extract, robots.txt parser, URL normalizer
- [x] Load and validate versioned corpus (@seo/corpus from YAML)
- [x] Create @seo/testkit with in-memory fixture website server
- [x] Configure TypeScript project references and vitest testing framework
- [x] Compile v4.4 corpus YAML from TSV source (phases 0-7, 97 checks)

## Phase 1 — Probes & Persistence
- [x] Implement @seo/probes detector registry (6 categories: delivery, indexability, markup, media, metadata, site)
- [x] Build probe matrix tool (npm run probes:matrix) to verify detector coverage
- [x] Design Postgres schema with Drizzle (sites, audits, crawls, pages, links, probes, renders, checks)
- [x] Implement @seo/persistence crawl sink for streaming pages to database
- [x] Map crawl/probe results to database rows with integrity constraints
- [x] Create initial Drizzle migrations (0000-0003) with enum types and indexes
- [x] Write integration tests for persistence and probe runs against live Postgres

## Phase 2 — CI/CD & Deployment
- [x] Write README with setup, build, test, and database management instructions
- [x] Add GitHub Actions CI workflow with Postgres service and full test suite
- [x] Implement .githooks/pre-push for local typecheck and test gate on master
- [x] Create docker-compose.yml with Postgres and Redis for local development
- [x] Configure .env.example with DATABASE_URL and REDIS_URL defaults
- [x] Enable corpus compilation and matrix tools as npm run scripts
- [x] Harden the master ruleset: require pull requests and both the test and roadmap status checks

## Phase 3 — Pre-Release Validation
- [x] Audit triage sign-off: confirm automation tier and remediation class for all 97 checks (scripts/triage.ts requires sign-off before release)
- [x] Settle the corpus source of record: the TSV bootstraps a version, the YAML owns it thereafter, and `corpus:compile` refuses to overwrite an existing version
- [x] Split corpus tests into frozen provenance (v4.4 against its workbook) and structural invariants that run against every version on disk
- [x] Validate site-profile flags against the pinned corpus before an audit runs, so a typo cannot silently excuse launch gates
- [x] Prove two corpus versions load and grade side by side (packages/corpus/test/versions.test.ts, fixtures v9.0/v9.1)
- [ ] Triage sign-off for corpus v4.5 once its rows exist — `scripts/triage.ts` is keyed by check id and signed off against v4.4 only

## Phase 4 — Orchestration & Scaling
- [x] Implement job queue for managing concurrent crawls (@seo/queue: bounded concurrency, lane exclusion per origin, cancellation)
- [x] Add audit scheduler to trigger crawls on demand or via API (@seo/scheduler: submit returns an audit id before the crawl runs; one audit at a time per origin)
- [x] Build retry logic and error recovery for failed audits (@seo/queue: held jobs, backoff, retry-aware cancellation; @seo/scheduler: which failures repeat, and the audit row across attempts)
- [ ] Handle multiple concurrent site audits without resource contention
- [x] Back the job queue with durable storage so a restart does not lose queued audits (@seo/queue: a `JobStore` seam; @seo/job-store: the `jobs` table behind it; @seo/scheduler: `recover()` on the way up)
- [ ] Expire and renew job leases so a second worker can share one queue namespace (the `owner` and `leased_at` columns exist and are stamped; nothing reads them yet)
- [x] Reconcile audits left `pending` with no job behind them (@seo/scheduler: `reconcile()` closes out rows nothing is going to run, bounded by the database clock at recovery)
- [x] Give crawl() cooperative cancellation so a cancelled job stops mid-crawl rather than at the end (@seo/crawler: a `signal` checked between requests and inside the politeness delay; a cancelled crawl reads `cancelled`, not `failed`)
- [x] Grade probe evidence into checkStates and freeze readiness on the audit (@seo/grader: verdicts, evidence trail, frozen readiness)
- [ ] Implement more of the corpus's 128 detectors — 40 today (was 33), covering 17 of 43 automated checks and 12 launch gates. The remainder need evidence this engine does not yet gather: Search Console, Lighthouse/CrUX, RDAP, a rendered DOM (Phase 5), or a previous audit to compare against

- [x] Prototype URL analyzer with snapshot comparison (npm run analyze / npm run compare) so engine changes can be measured against live sites

## Phase 5 — Rendered Crawl
- [ ] Implement JavaScript rendering in @seo/crawler (renderMode column exists in schema but not used)
- [ ] Add dual-crawl (raw + rendered) logic to compare HTML vs. rendered content
- [ ] Detect and report rendering strategy mismatches in @seo/probes

## Phase 6 — External Content Storage
- [ ] Implement content-addressing system (S3/GCS integration) for page bodies
- [ ] Map page body hashes to storage keys in database (body_key column prepared in schema)
- [ ] Build blob retrieval client for reconstructing archived crawls
- [ ] Add batch operations for uploading and purging stored content

## Phase 7 — Audit API
- [ ] Create HTTP server entry point (currently library-only, no apps/ yet)
- [ ] Build site management endpoints (create, list, update, delete)
- [ ] Implement audit lifecycle endpoints (create, status, result retrieval)
- [ ] Add check attestation endpoint for recording human decisions
- [ ] Implement readiness calculation and score retrieval

## Phase 8 — Dashboard
- [ ] Build web UI for audit results and historical trend viewing
- [ ] Implement check evidence drill-down (trace verdict to probes to observations)
- [ ] Add audit comparison across sites and time
- [ ] Create attestation interface for confirming checks

## Blocked

## Decisions
- 2026-09-08: added `sites.aiPolicy` as jsonb rather than a table or an enum, because the shape is a map from crawler name to stance and crawler names change faster than anything needing a migration should; the policy joins `flags` as the second thing on a site record that a person states and no crawl can derive
- 2026-09-08: had `ai-crawler-directive-verify` compare robots.txt against the policy in *both* directions, because the missed case is the welcoming one — a blanket disallow written years ago quietly excludes the crawler someone has since decided to court, and only the policy makes that visible
- 2026-09-08: treated a disallowed crawler still receiving a 200 as normal rather than a defect: robots.txt asks and well-behaved crawlers comply, so robots-only enforcement is the common shape. Only the reverse — a welcomed crawler turned away at the edge — is infrastructure contradicting a decision
- 2026-09-08: sent user-agent tests honestly, as real requests carrying the named crawler's user-agent, and capped them at twelve, because each is a real visit to someone's origin and a policy naming forty crawlers must not cost forty visits
- 2026-09-08: moved the AI-policy parse ahead of the `audits` insert in `submit()` after a test caught the ordering: a policy the engine cannot read is a bad request, and a bad request must leave nothing behind rather than a `pending` row waiting for the reconcile sweep to explain it
- 2026-09-07: put auxiliary requests in `crawl()` rather than letting a probe fetch for itself, because politeness is owed to a host and the crawl loop is the only thing that knows what was promised — the same delay and the same cancellation signal cover them, where a probe making its own requests would be a second, unmetered visitor to a site that agreed to one
- 2026-09-07: skipped host variants for a seed whose host cannot have them — an IP literal, `localhost`, any single-label name — because `www.127.0.0.1` is not a spelling of anything, and reporting its DNS failure would fail every audit of a staging environment for being a staging environment
- 2026-09-07: gave `FetchResult` an optional `bytes` for small non-textual responses behind a `keepBytes` flag, rather than keeping every asset, because exactly one question today needs to look inside a file (is the favicon square) and holding megabytes of images in a crawl that already holds every page would spend a real memory budget on nothing
- 2026-09-07: read icon dimensions from PNG, ICO and SVG headers directly instead of taking an image-decoding dependency — each states its size in a fixed place near the front, and any other format returns null and is reported as unmeasured rather than guessed at
- 2026-09-07: left `ai-crawler-directive-verify` (2.9) unimplemented although it looked like a one-detector win: its "Done when" asks that robots.txt, CDN behaviour and a dated user-agent test agree with *the policy*, and the policy is a document a person approved that this engine has never seen. Checking robots.txt alone and calling it agreement would put a pass on a check nobody verified
- 2026-09-07: picked the first detector batch by what a raw crawl can honestly answer rather than by how many checks it would unblock — 24 automated checks are one detector short, but most of those detectors need Search Console, Lighthouse, RDAP, a rendered DOM or extra HTTP requests the crawler does not make, and shipping a probe that guesses at those would put a `pass` on a check nobody verified
- 2026-09-07: kept `media-alternatives` to whether a caption track or text alternative exists, not whether it is accurate, because the corpus asks for both and only the first is a markup fact; 1.9 still needs its other detectors before the check clears, which is the mechanism that stops a partial answer reading as a whole one
- 2026-09-07: made `hreflang-cluster-qa` treat a cross-domain locale as unverified rather than broken — a crawl scoped to one origin cannot see the other side of the cluster, and multi-domain international setups are a normal shape, so counting them as defects would train people to ignore the detector
- 2026-09-07: had `breadcrumb-navigation` read the visible trail while `breadcrumblist-schema` reads the markup, rather than folding them into one detector, because the two come apart constantly — perfect JSON-LD beside a trail a redesign removed — and 2.17 asks for them to match
- 2026-09-07: tested these four against hand-built pages instead of extending the fixture site, because each answers a question about a shape (a reciprocal cluster, a paginated series, an ancestor that 404s) and one fixture carrying every shape at once would be a site nobody has built; the markup still goes through the real `extract`
- 2026-09-07: dropped the `priority`, `automation_tier` and `remediation_class` Postgres enums, which no column ever used — an enum with no column behind it guards nothing, because the `AssertSame` line compares a union against itself, while still charging a migration for every change to it. They also mirrored corpus vocabulary specifically, and the corpus is file-backed so that a methodology revision needs no migration; keeping the types would have quietly reintroduced the coupling the corpus was kept out of the database to avoid. The rule now stated in `enums.ts`: a vocabulary earns a Postgres type by being written to a row.
- 2026-09-07: settled the corpus source of record — the TSV under corpus/source/ bootstraps exactly one event, the first compile of a version, and corpus/v<version>/*.yaml owns it from then on; the compiler now refuses to overwrite an existing version, because the old header promised hand-editable YAML while the script silently discarded those edits and both halves were true
- 2026-09-07: made a methodology revision a new version directory rather than a re-compile of a live one, since a delivered report pins `audits.corpusVersion` and has to keep explaining itself after the methodology moves on
- 2026-09-07: made the compile version a required argument with no default, because a default is how a compile meant for 4.5 lands on 4.4 and takes a year of corpus edits with it
- 2026-09-07: split the corpus suite into a frozen `provenance.test.ts` pinned to v4.4 and a `corpus.test.ts` that discovers every version directory, because one file was being asked to prove both "we reproduced the 2026 workbook" and "this corpus is well-formed" — goals that diverge the moment search changes, and which together made adding a check mean editing six numbers about a spreadsheet
- 2026-09-07: validated site flags against the pinned corpus in `runAudit`, beside the corpus version check, because `resolveScope` reads a filled-in profile as a statement — so a misspelt flag does not go unmatched, it narrows checks to `no` with a rationale that reads deliberate, and would excuse launch gates while explaining itself confidently
- 2026-09-07: put the flag vocabulary in the corpus rather than a Postgres enum, so a version that introduces a flag needs no migration; a flag no check names today may be named by the next version
- 2026-09-07: kept the two-version fixtures outside `corpus/` and numbered them 9.0/9.1, so the version-discovery loop cannot pick up a test double and a real version directory can never be shadowed by one
- 2026-09-05: made crawl cancellation a check between requests rather than an abort of the request in flight, because abandoning a response already on the wire saves the site nothing and hands the extractor a half-read body; the guarantee worth making is "no further requests", which is the one the site can feel
- 2026-09-05: made the politeness delay interruptible, because it is the one part of a crawl deliberately measured in seconds and waiting it out would have made it the floor on how long cancelling takes — nobody is owed the pause before a request that will not be made
- 2026-09-05: closed a cancelled crawl out as `cancelled` with a null error rather than `failed` with one, so a report never sends someone looking for a fault where a person simply stopped the work; `runAudit` restates `CrawlCancelledError` as `JobCancelledError` so the queue and the retry policy see one identity for it
- 2026-09-05: had `reconcile()` mark orphaned audits `failed` rather than re-enqueue them, because the crawl budget and seeds a caller asked for live only in the job payload that was lost — resubmitting under this process's defaults would quietly run a different audit than the one requested
- 2026-09-05: took reconcile's cutoff from the database clock at recovery rather than `new Date()` in the process, because every timestamp it compares against was written by Postgres and a sweep whose correctness depends on two machines agreeing about the time will eventually be wrong on a laptop that slept
- 2026-09-05: made reconcile refuse to run before `recover()` and refuse entirely without a store, because in either case every pending audit looks abandoned and the sweep would fail the whole backlog instead of the lost rows
- 2026-09-05: backed the queue with a Postgres `jobs` table rather than Redis, superseding the 2026-09-04 expectation that durability would arrive as Redis — the audit's durable record already lives in Postgres, and a second store would be a second source of truth to reconcile after exactly the restart it exists to survive, for an operational component nothing else in the system needs yet
- 2026-09-05: put durability behind a three-method `JobStore` the queue is handed, rather than in the queue itself, so @seo/queue keeps knowing nothing about Postgres and the memory-only path stays the default — a test, and the offline analyzer, must not need a database to run a queue
- 2026-09-05: made only the enqueue write blocking, and every later transition best-effort, because a job that is not written down is work a restart drops, while a `running` update that was lost costs at most one repeated run — failing an audit over a storage blip would be the opposite of what a durable queue is for
- 2026-09-05: deleted jobs from the store the moment they settle instead of archiving them, because `audits` already records what became of an audit with its status, timings and error, and a second history is only something to keep consistent with the first
- 2026-09-05: kept the attempt count across a restart and wrote it before the handler runs, so a payload that takes the process down with it burns an attempt and eventually gives up, rather than being retried by every restart forever
- 2026-09-05: let a recovered job keep whatever is left of its retry backoff instead of running it at once, because the wait exists to give whatever fell over time to get back up, and a restart is not evidence that it has
- 2026-09-05: keyed `jobs` on `(queue, id)` rather than `id`, because a job id belongs to the queue that minted it and a single-column key would have two namespaces silently overwrite each other — the namespace has to reach the constraint, not only the `where` clause
- 2026-09-05: had `load()` claim every outstanding row in its namespace rather than only rows matching its own owner string, because a restart comes back with a new pid and an owner-matched claim would strand precisely the jobs the previous process had started; single ownership is assumed and recorded, not enforced
- 2026-09-05: split retries into mechanism in @seo/queue and policy in @seo/scheduler — the queue knows how to hold a failed job back, wake it and run it again, and consults a caller-supplied policy for whether to; which failures deserve a repeat is a fact about the work, and a queue that decided it would bury that judgement where nobody looks
- 2026-09-05: made a retry policy allowed to be async, so a caller can record the decision durably before the wait starts; the scheduler uses that to put the audit row back to `pending` before the backoff, because a row reading `failed` while another attempt is already scheduled would mislead every status endpoint built on it
- 2026-09-05: enumerated the permanent audit failures (cancellation, an unknown site, a corpus this process cannot produce, a runtime error about the program) and retried everything else, because an unrecognised blip retried costs one more crawl of a site already under audit, while an unrecognised blip written off loses the audit to a cause nobody will ever see
- 2026-09-05: kept the audit id across attempts rather than opening a new audit per retry — a retry is the same audit running again, writing a second crawl under the same row, and a caller who was handed an id at submit time must not have to discover a new one to find out how it went
- 2026-09-05: gave the prototype analyzer its own scripts rather than an apps/cli package, and had it hold the whole audit in memory with no database, because its job is to measure what the engine says today — a scruffy harness that runs anywhere is worth more than a durable one, and the JSON snapshot it leaves behind is the part that has to survive
- 2026-09-05: made each snapshot record every check verdict, not just the failures, because the question the harness answers is whether a change moved coverage, and a check that quietly stopped being graded is exactly the regression a failures-only record would hide
- 2026-09-04: gave grading its own package (@seo/grader) rather than folding it into the scheduler, because reading the corpus against evidence is a judgement with its own rules and has to be re-runnable over a stored audit without re-crawling it
- 2026-09-04: settled the grader's central rule as "a machine may fail a check, but only an `automated` check may be passed by one" — a failure is a defect a probe observed, while a pass is a clearance, and the corpus already says which checks are machine-verifiable end to end
- 2026-09-04: made an unimplemented detector, an errored probe and a detector that observed nothing all leave the check at `not-started` with `unknown` coverage, because "we did not look" is not a finding about the site and 95 of 128 detectors are unimplemented, so the honest answer is the common one
- 2026-09-04: read an empty site profile as an unmade decision and a filled-in one as a statement — conditional checks stay at `review` when a site has no flags, and are narrowed to `no` with a rationale when it has flags but none that match — because treating silence as "none of these apply" would clear conditional launch gates on the strength of a form nobody filled in
- 2026-09-04: let a check whose observations were all `not-applicable` pass with coverage `not-applicable`, because a check whose subject does not exist on the site cannot fail and holding the launch on it forever would be noise; the coverage column is what keeps "verified" and "nothing to verify" distinguishable in the report
- 2026-09-04: made recording a grade a replace rather than an upsert, so a re-grade can retract an evidence link, and made it refuse to overwrite any row whose coverage is `attested`, because a human sign-off is the one part of an audit a machine cannot reproduce
- 2026-09-04: had the scheduler resolve the pinned corpus version before the crawl rather than after it, because an audit pinned to a corpus this process cannot produce is unreportable however well the crawl goes, and finding that out afterwards spends someone else's bandwidth to learn it
- 2026-08-27: split evidence (probeResults) from verdicts (checkStates) because machines observe and humans judge, which keeps every report traceable to what produced it
- 2026-08-27: chose a memory-resident crawl loop with a streaming database sink over batch-at-end because a crawl that dies at page 400 still preserves those 400
- 2026-08-27: chose file-backed immutable YAML under corpus/v4.4 over database-held checks, using text ids not foreign keys, so an audit pinned to a corpus version stays reproducible
- 2026-08-27: kept the corpus source as TSV in corpus/source/ for provenance because the compiled YAML is authoritative but the workbook export is the origin of record
- 2026-08-27: chose to keep response bodies out of Postgres, recording only content hash and object-store key, because scaling to millions of pages requires that split
- 2026-08-28: chose a client-side pre-push hook over server-side branch protection because GitHub Free does not offer protected branches on private repos
- 2026-08-28: chose Drizzle ORM with drizzle-kit generated migrations over hand-written SQL for code-first type safety against the schema
- 2026-08-28: made the triage table in scripts/triage.ts a sign-off gate because misclassifying automation tier or remediation class breaks every downstream decision
- 2026-09-04: moved master to a server-side ruleset requiring a pull request plus the test and roadmap checks, superseding the 2026-08-28 pre-push choice because rulesets are now available on this repo and --no-verify made the client-side hook unenforceable
- 2026-09-04: set required_approving_review_count to 0 on that ruleset because GitHub forbids approving your own pull request, so any higher count would deadlock a single-maintainer repo
- 2026-09-04: signed off the v4.4 triage table on the rule that a check is only `automated` when its "Done when" closes on observation alone, which moved 2.11, 3.10, 4.2, 4.5, 4.6, 5.5, 6.3, 6.8 and 7.10 to `assisted` because each needs a person to record a decision, an owner or an exception
- 2026-09-04: read "agreed budget" and "approved baseline" wording as naming an input to a check rather than an artifact a human must produce, so those rows stayed `automated` — the tier claims what can be automated, not what the probe registry has built
- 2026-09-04: chose an in-process job queue in @seo/queue over Redis or BullMQ because the queue has no consumer outside this process yet; Redis buys durability, which is only worth its operational weight once the API-triggered scheduler can promise a queued audit will run, so it is listed as its own Phase 4 item behind the same interface
- 2026-09-04: put lane exclusion in the queue rather than in the scheduler because the crawl loop's politeness delay is measured between its own requests, so two workers on one origin would each honour it and together still double the agreed load — the guarantee only holds if something upstream refuses to run them at the same time
- 2026-09-04: left retries out of the queue and kept them as their own Phase 4 item, because which failures deserve a repeat is a policy question (a transport timeout, yes; a 403 on the first request, no) and a queue that guessed would hide it
- 2026-09-04: made job cancellation cooperative — the signal is offered, the handler decides — because nothing in Node can interrupt a running handler, and a queue that reported a job as stopped while its crawler was still fetching would be lying about the load on someone's site
- 2026-09-04: had the scheduler write the audits row in submit() and return its id before the crawl starts, because the HTTP layer this is built for has to answer in milliseconds while the audit it triggered runs for minutes — the row is the handle, and polling it is what a status endpoint will do
- 2026-09-04: used the audit id as the queue's job id so cancel() and status() take the one identifier a caller was already given, rather than making callers hold an audit id and a job id and keep them paired
- 2026-09-04: stopped the scheduler short of grading: it gathers and files evidence, leaves audits.readiness null, and an audit reading `complete` means the evidence is in, not that the launch decision is made — turning probe observations into checkStates is a distinct judgement with its own package to come
- 2026-09-04: laned audits on the site origin rather than on the site id, because politeness is owed to a host and two site records could name one origin; the lane has to key on the thing the requests actually reach
