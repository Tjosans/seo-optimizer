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
