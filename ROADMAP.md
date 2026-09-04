# Roadmap — seo-optimizer

## Status
Current phase: Phase 4 — Orchestration & Scaling
Last updated: 2026-09-04

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
- [ ] Implement job queue for managing concurrent crawls
- [ ] Add audit scheduler to trigger crawls on demand or via API
- [ ] Build retry logic and error recovery for failed audits
- [ ] Handle multiple concurrent site audits without resource contention

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
