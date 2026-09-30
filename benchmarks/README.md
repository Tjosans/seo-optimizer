# Benchmarks — the prototype measuring stick

A scruffy harness for one question: **does a change to the engine make an audit
say more, or say it better?**

`npm run analyze` crawls live URLs, runs every probe, grades against the pinned
corpus and writes a JSON snapshot here. `npm run compare` diffs two snapshots.
No database, no queue, no scheduler — this is deliberately the shortest path
from a URL to a verdict.

## Workflow

```bash
npm run analyze -- --file benchmarks/urls.txt --pages 15 --label baseline
```

Then change something (implement a detector, fix a probe) and run it again with
a new label:

```bash
npm run analyze -- --file benchmarks/urls.txt --pages 15 --label after-alt-text
npm run compare -- benchmarks/runs/<baseline>.json benchmarks/runs/<after>.json
```

## Reading the numbers

The headline is **checks graded** — how many of the corpus's 97 checks the
engine reached a verdict on. It is around 9% today, and it is the number most
detector work should move. Everything else is context for it:

- `observations` / `detectors` — how much evidence the crawl produced. Rises
  with the page budget, so only comparable between runs with the same budget.
- `passed` / `failed` / `held` — the verdicts. A rise in `failed` is not a
  regression in the engine; it usually means a new detector found something.
- `ungraded` bases — why the other checks were not graded. `detectors-missing`
  is the detector backlog, `scope-undecided` is the empty site profile, and
  `attested-only` is work no crawler will ever do.
- `verdicts moved` in a comparison — the checks whose status or basis changed.
  This is the part to read closely.

## Rendering

Without `--render` the analyzer only makes raw fetches, so every detector that
reads a browser's view of a page — `rendering-strategy-classifier`,
`raw-rendered-parity`, `raw-rendered-crawl-diff`, `mobile-journey-qa`,
`axe-accessibility` — reports `not-applicable`. `--render` runs each HTML page
through headless Chromium twice (desktop with axe-core, then as a phone), each
visit paced like a fetch:

```bash
npm run analyze -- --file benchmarks/urls.txt --pages 15 --render --label rendered
```

It needs `npx playwright install chromium` once, and it is slow: a 4-page crawl
of iana.org took 63 s rendered against 15 s raw. The snapshot records
`settings.render`, and `compare` warns when one run rendered and the other did
not.

## Against an earlier run

Four detectors answer only against an earlier look at the same site —
`quarterly-regression-crawl` (7.3), `conditional-template-monitor` (6.9),
`a11y-regression-sampling` (7.7) and `schema-hreflang-maintenance` (7.9) — and
say `not-applicable` without one. Every snapshot's sites carry a `previous`
block for this, so a second run can name the first:

```bash
npm run analyze -- --file benchmarks/urls.txt --pages 20 --render --baseline benchmarks/runs/<earlier>.json --label vs-baseline
```

Match the earlier run's settings. Pages are compared by URL, so a different
budget compares less; `a11y-regression-sampling` needs `--render` on both
runs, because the axe results come from the render. A rerun a few hours later
mostly shows the plumbing working. News and live pages are where a real
regression turns up: `2026-09-30T19-59-17-shapes-rendered-vs-baseline` against
`…T15-25-27-shapes-rendered-tall` compared 12 to 20 pages per site on each
detector, and found one. A Guardian live blog had added contributor
headshots without width/height since the first run.

## Reading a failure from the snapshot

Each site's `probeFailures` lists every `fail` and `error` observation with its
detector, page and summary, and — where the detector recorded one — its `data`:
which links, URLs, tags or values the summary is about. Triage a suspect fail
from there before crawling the site again. The detail is bounded so a
site-wide list cannot swell the file: arrays keep their first 25 items and
strings their first 500 characters, each cut followed by a marker saying how
much was dropped. Snapshots taken before 2026-09-30 evening have no `data`.

## Caveats, so nobody over-reads a diff

- These are live sites. A moved verdict can be the site changing rather than
  the engine changing. Treat it as a lead, not a proof.
- The crawl budget shapes everything. `compare` warns when two runs used
  different budgets, depths, flags or corpus versions, but it still prints the
  diff — read it knowing the numbers are not directly comparable.
- Passing `--flags` narrows conditional checks into or out of scope. An empty
  profile leaves 39 checks at `scope-undecided`, which is the honest default,
  not a bug.
- Keep `urls.txt` stable. Adding a URL is fine; swapping one out silently
  breaks every comparison against older snapshots.
