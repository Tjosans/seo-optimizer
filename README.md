# seo-optimizer

An SEO launch-readiness auditor: crawl a site, run it against a corpus of
checks, and grade what launched.

The system is a pipeline of packages under `packages/`, each with one job:

| Package             | Job                                                              |
| -------------------- | ----------------------------------------------------------------- |
| `@seo/corpus`         | Loads and validates the versioned check corpus (`corpus/v4.4`).   |
| `@seo/core`           | The check/state/readiness types every other package speaks in.    |
| `@seo/crawler`        | Fetches a site, respecting robots.txt, and extracts page signals. |
| `@seo/probes`         | Runs detectors over a crawl and produces observations.            |
| `@seo/persistence`    | Writes a crawl and its probe runs into Postgres.                  |
| `@seo/db`             | The Postgres schema and migrations (Drizzle).                     |
| `@seo/testkit`        | A fixture website, served from memory, for tests to crawl.        |

## Prerequisites

- Node.js >= 24 (`node --version`)
- Docker, for the local Postgres/Redis stack

## Setup

```bash
npm install
cp .env.example .env
npm run stack:up
npm run db:migrate
npm run build
```

`stack:up` starts Postgres and Redis via `docker-compose.yml` on the ports in
`.env` (5433/6380 by default, one above the standard ports, so this can run
alongside another local stack). `db:migrate` applies everything in
`packages/db/migrations` to that database.

## Running the tests

```bash
npm test
```

Most tests run against source directly (see `vitest.config.ts`) and need
nothing running. A few — `packages/db/test` and `packages/persistence/test` —
are integration tests against a live Postgres and skip themselves
automatically when `DATABASE_URL` is unset, so `stack:up` + `.env` unlocks
them rather than being required for the rest of the suite.

```bash
npm run typecheck   # tsc --build --force, project-referenced
npm run test:watch  # vitest in watch mode
```

## Enabling the pre-push hook

`.githooks/pre-push` runs `typecheck` and `test` before any push to `master`,
refusing the push if either fails. It is opt-in per clone:

```bash
git config core.hooksPath .githooks
```

This is a stand-in for server-side branch protection, not an equivalent: GitHub
Free offers neither protected branches nor rulesets on private repositories, so
the merge gate cannot live on the server. Being client-side, the hook is
bypassable with `git push --no-verify` and only applies to clones that ran the
command above. CI remains the real signal — it runs on every push and PR
regardless.

Only pushes to `master` are gated, so feature-branch pushes stay fast; the
PR's own CI run covers those.

## Working with the database

```bash
npm run db:generate   # diff packages/db/src/schema.ts, write a migration
npm run db:migrate    # apply pending migrations
npm run db:studio     # Drizzle Studio against the local database
```

`db:generate` can prompt interactively when a change is ambiguous (e.g. an
add-and-drop on the same table in one pass); if you're scripting it, split
such a change into two `db:generate` runs instead.

## Working with the corpus

```bash
npm run corpus:compile   # compile corpus/source/*.tsv into corpus/v4.4/*.yaml
npm run corpus:validate  # run the corpus package's own test suite
npm run probes:matrix    # build + report which corpus detectors have a probe behind them
```

## Shutting down

```bash
npm run stack:down
```
