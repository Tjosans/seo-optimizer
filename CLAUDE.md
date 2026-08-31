# seo-optimizer — Project Handoff

## Start here

Read [`ROADMAP.md`](./ROADMAP.md) first — it holds the phase list, what is done, what is next, and the decisions already made with their reasons. Update it in the same commit as the code change when you complete something.

## What is this?

seo-optimizer is an SEO launch-readiness auditor. It crawls a site, runs it against a versioned corpus of 97 checks across 8 corpus phases, and grades what launched. The system is a pipeline of independent packages:

- **@seo/core** — types for checks, check state, readiness scoring
- **@seo/corpus** — loader for the v4.4 check corpus (YAML phases 0-7, source TSV)
- **@seo/crawler** — site crawler respecting robots.txt, redirect chains, sitemaps
- **@seo/probes** — 6 detector categories (delivery, indexability, markup, media, metadata, site)
- **@seo/persistence** — sink that streams crawls and probe runs into Postgres
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
- `npm run corpus:compile` — regenerate v4.4 YAML from source TSV
- `npm run corpus:validate` — corpus integrity
- `npm run probes:matrix` — detector coverage vs corpus checks
- `npm run db:generate` — diff schema and write a new migration
- `npm run db:studio` — Drizzle Studio against the live database
- `npm run stack:down` — stop containers

## How it works

1. **Crawl** (`@seo/crawler`) — breadth-first from seeds, respects robots.txt, extracts links and metadata, paced politeness delay, bounded by page/depth budget.
2. **Extract** — parse each page's HTML; record head tags, links, hierarchy, structure.
3. **Probe** (`@seo/probes`) — detectors observe the crawl result and emit evidence.
4. **Persist** (`@seo/persistence`) — stream pages and probes into Postgres.
5. **Score** (`@seo/core`) — compute launch readiness from check states.

### Guarantees the sink relies on

- Pages are processed breadth-first from seeds.
- `onPage` is awaited before a page's links are enqueued, so a parent always persists before its children.
- A normalized URL is enqueued at most once, so there are no duplicates.

Together these let the sink resolve `discoveredFromId` from an in-memory map. Breaking any of them breaks persistence in a way the crawler tests will not catch.

### Probe scope

- `site` — runs once across all pages (e.g. redirect-chain-at-root)
- `page` — runs once per page (e.g. canonicalization)
- `template` — once per unique rendered template (not yet used)

## Testing

Unit tests (no database needed): `packages/corpus/test/corpus.test.ts`, `packages/crawler/test/{crawl,robots,url}.test.ts`, `packages/probes/test/{probes,matrix}.test.ts`.

Integration tests (need `npm run stack:up`): `packages/db/test/schema.test.ts`, `packages/persistence/test/persistence.test.ts`.

All tests skip gracefully if `DATABASE_URL` is unset — which means a green local run does not prove the database layer works. `vitest.config.ts` aliases packages to source, so no build step is needed during test.

Corpus tests assert 97 checks with unique ids, the phase distribution (9, 19, 17, 13, 12, 8, 9, 10), priority distribution (P0:55, P1:35, P2:7), profile distribution (core:68, extended:29), and that detectors bind only to automated/assisted checks.

## CI

`.github/workflows/ci.yml` runs on push to main/master and all PRs: spins up Postgres 17 as a service, then `npm ci`, `db:migrate`, `build`, `typecheck`, `test`. Integration tests do execute in CI because `DATABASE_URL` is set there.

`.githooks/pre-push` gates pushes to `master` (not feature branches) on typecheck and test. It is opt-in per clone:

```bash
git config core.hooksPath .githooks
```

It is bypassable with `--no-verify` — a local safety net standing in for server-side protection, not a real gate.

## Layout

```
packages/
  core/src/{check,state,readiness}.ts
  corpus/src/load.ts
  crawler/src/{crawl,extract,fetch,robots,url}.ts
  db/src/{schema,enums,client}.ts  +  migrations/0000-0003
  persistence/src/{crawl-sink,map,probe-results}.ts
  probes/src/{registry,types,matrix}.ts  +  src/probes/*.ts
  testkit/src/fixture-site.ts
corpus/
  source/v4.4.tsv                  # immutable workbook export
  v4.4/phase-0.yaml … phase-7.yaml # compiled checks (97)
  v4.4/{manifest,sources}.yaml
scripts/{compile-corpus,probe-matrix,triage}.ts
```

## Known gotchas

1. **drizzle-kit is strict.** Changing `schema.ts` without `npm run db:generate` makes migrations fail. Always diff first.
2. **`npm run corpus:compile` is destructive.** It overwrites the v4.4 YAML from the source TSV, discarding manual edits.
3. **Integration tests skip silently** when `DATABASE_URL` is unset. Run `npm run stack:up` before trusting a green test run.
4. **The pre-push hook is opt-in** and must be enabled in each clone.
5. **Response bodies are external by design.** The schema stores hashes and keys only; the content-addressing store does not exist yet (see Phase 6).

## What to pick up next

`ROADMAP.md` Phase 3 is the current phase: the triage sign-off in `scripts/triage.ts` gates release. After that, Phases 4-8 cover orchestration, rendered crawl, external body storage, the audit API, and the dashboard.
