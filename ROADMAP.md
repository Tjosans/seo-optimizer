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

## Phase 4 — Orchestration & Scaling
- [x] Implement job queue for managing concurrent crawls (@seo/queue: bounded concurrency, lane exclusion per origin, cancellation)
- [x] Add audit scheduler to trigger crawls on demand or via API (@seo/scheduler: submit returns an audit id before the crawl runs; one audit at a time per origin)
- [x] Build retry logic and error recovery for failed audits (@seo/queue: held jobs, backoff, retry-aware cancellation; @seo/scheduler: which failures repeat, and the audit row across attempts)
- [ ] Handle multiple concurrent site audits without resource contention
- [ ] Back the job queue with durable storage so a restart does not lose queued audits
- [ ] Give crawl() cooperative cancellation so a cancelled job stops mid-crawl rather than at the end
- [x] Grade probe evidence into checkStates and freeze readiness on the audit (@seo/grader: verdicts, evidence trail, frozen readiness)
- [ ] Implement more of the corpus's 128 detectors — 33 today, which is what limits grading to 10 of 97 checks


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
- 2026-09-05: split retries into mechanism in @seo/queue and policy in @seo/scheduler — the queue knows how to hold a failed job back, wake it and run it again, and consults a caller-supplied policy for whether to; which failures deserve a repeat is a fact about the work, and a queue that decided it would bury that judgement where nobody looks
- 2026-09-05: made a retry policy allowed to be async, so a caller can record the decision durably before the wait starts; the scheduler uses that to put the audit row back to `pending` before the backoff, because a row reading `failed` while another attempt is already scheduled would mislead every status endpoint built on it
- 2026-09-05: enumerated the permanent audit failures (cancellation, an unknown site, a corpus this process cannot produce, a runtime error about the program) and retried everything else, because an unrecognised blip retried costs one more crawl of a site already under audit, while an unrecognised blip written off loses the audit to a cause nobody will ever see
- 2026-09-05: kept the audit id across attempts rather than opening a new audit per retry — a retry is the same audit running again, writing a second crawl under the same row, and a caller who was handed an id at submit time must not have to discover a new one to find out how it went
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
