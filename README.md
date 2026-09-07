# seo-optimizer

An SEO launch-readiness auditor: crawl a site, run it against a corpus of
checks, and grade what launched.

The system is a pipeline of packages under `packages/`, each with one job:

| Package            | Job                                                               |
| ------------------ | ----------------------------------------------------------------- |
| `@seo/core`        | The check/state/readiness types every other package speaks in.    |
| `@seo/corpus`      | Loads and validates the versioned check corpus (`corpus/v4.4`).   |
| `@seo/crawler`     | Fetches a site, respecting robots.txt, and extracts page signals. |
| `@seo/probes`      | Runs detectors over a crawl and produces observations.            |
| `@seo/persistence` | Writes a crawl and its probe runs into Postgres.                  |
| `@seo/grader`      | Reads evidence against the corpus and freezes launch readiness.   |
| `@seo/queue`       | Runs audits at a bounded concurrency, one at a time per origin.   |
| `@seo/job-store`   | Keeps queued work in Postgres, so a restart resumes it.           |
| `@seo/scheduler`   | The front door: submit an audit, get an id back, poll the row.    |
| `@seo/db`          | The Postgres schema and migrations (Drizzle).                     |
| `@seo/testkit`     | A fixture website, served from memory, for tests to crawl.        |

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
nothing running. The rest — `packages/db/test`, `packages/persistence/test`,
`packages/job-store/test`, `packages/grader/test/record.test.ts` and
`packages/scheduler/test/{scheduler,recovery,cancel}.test.ts` — are
integration tests against a live Postgres and skip themselves automatically
when `DATABASE_URL` is unset, so `stack:up` + `.env` unlocks them rather than
being required for the rest of the suite. A green run without a database
therefore does not prove the database layer works.

```bash
npm run typecheck   # tsc --build --force, project-referenced
npm run test:watch  # vitest in watch mode
```

## How `master` is protected

The gate is server-side, in the repository ruleset "Require CI on master".
Reaching `master` requires a pull request whose `test` and `roadmap` checks
have passed, on a branch that is up to date with the base. Force-pushes and
deletion of the branch are refused. Approvals are set to zero, because GitHub
will not let you approve your own pull request and any higher count would
deadlock a single-maintainer repository — the checks are what actually gate
the merge.

The two required checks come from `.github/workflows/`: `test` runs `db:migrate`,
`build`, `typecheck` and the full suite against a real Postgres service, and
`roadmap` asserts that `ROADMAP.md` exists and still holds checkbox items,
warning when it has not changed in thirty days.

### The optional local hook

`.githooks/pre-push` runs `typecheck` and `test` before a push to `master`, so
a failure shows up in seconds locally instead of minutes later in CI. It is
opt-in per clone:

```bash
git config core.hooksPath .githooks
```

It is a convenience, not the gate. Being client-side it is bypassable with
`git push --no-verify` and applies only to clones that ran the command above;
the ruleset is what cannot be bypassed. Only pushes to `master` are gated, so
feature-branch pushes stay fast.

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

`corpus:compile` is destructive: it overwrites `corpus/v4.4/*.yaml` from the
TSV, discarding hand edits. The TSV is the source of record.

## Measuring the engine against real sites

```bash
npm run analyze -- https://example.com          # crawl, probe and grade a live URL
npm run compare -- <older.json> <newer.json>    # diff two snapshots
```

`analyze` runs the whole pipeline in memory with no database, prints a report
and saves a snapshot under `benchmarks/runs/`. `compare` diffs two snapshots
and says whether coverage and verdicts moved, and which way — which is how an
engine change is shown to have improved what an audit can say, rather than
merely having passed its tests.

## Shutting down

```bash
npm run stack:down
```
