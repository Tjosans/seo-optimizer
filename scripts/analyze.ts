/**
 * Prototype URL analyzer — the scruffy end-to-end harness.
 *
 * Crawls one or more live URLs, runs every probe, grades the result against the
 * pinned corpus, prints a report and writes a JSON snapshot. No database, no
 * queue, no scheduler: this exists to answer "what does the engine actually say
 * about a real site today", and to leave a comparable record so the next change
 * can be judged against it (see compare.ts).
 *
 *     npm run analyze -- https://example.com
 *     npm run analyze -- --file benchmarks/urls.txt --pages 25 --label baseline
 *
 * The snapshot is the deliverable. The console report is for reading now.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Corpus } from '@seo/core';
import { loadCorpus } from '@seo/corpus';
import { crawl } from '@seo/crawler';
import type { CrawlResult } from '@seo/crawler';
import { PROBES, runProbes } from '@seo/probes';
import type { ProbeRun } from '@seo/probes';
import { gradeAudit } from '@seo/grader';
import type { GradeResult } from '@seo/grader';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const USER_AGENT = 'seo-optimizer-prototype/0.1 (+https://github.com/Tjosans/seo-optimizer)';

/** Snapshot format version. Bump when a field's meaning changes. */
export const SCHEMA = 1;

export interface Settings {
  readonly maxPages: number;
  readonly maxDepth: number;
  readonly requestDelayMs: number;
  readonly timeoutMs: number;
  readonly flags: readonly string[];
}

export interface CrawlSummary {
  readonly pages: number;
  readonly htmlPages: number;
  readonly nonOkPages: number;
  readonly transportFailures: number;
  readonly blockedByRobots: number;
  readonly notReached: number;
  readonly sitemapUrls: number;
  readonly robotsTxt: boolean;
  readonly medianTtfbMs: number | null;
  readonly durationMs: number;
}

export interface ObservationSummary {
  readonly total: number;
  readonly pass: number;
  readonly fail: number;
  readonly warn: number;
  readonly notApplicable: number;
  readonly error: number;
  /** Detector ids that produced at least one observation. */
  readonly detectorsFiring: number;
}

export interface CheckSummary {
  readonly total: number;
  readonly inScope: number;
  readonly graded: number;
  readonly passed: number;
  readonly failed: number;
  readonly inProgress: number;
  readonly notStarted: number;
  readonly byBasis: Readonly<Record<string, number>>;
}

export interface Verdict {
  readonly checkId: string;
  readonly status: string;
  readonly coverage: string;
  readonly basis: string;
  readonly launchGate: boolean;
  readonly summary: string;
}

export interface ProbeFailure {
  readonly probeId: string;
  readonly pageUrl: string | null;
  readonly summary: string;
  /**
   * Which of the two this was. An `error` is the engine saying it could not
   * look — a body it had to cut, a detector that threw — and printing it
   * beside the site's defects is how a limit of ours gets read as a fault of
   * theirs.
   */
  readonly outcome: 'fail' | 'error';
}

export interface SiteReport {
  readonly url: string;
  readonly origin: string;
  readonly ok: boolean;
  readonly error: string | null;
  readonly crawl: CrawlSummary | null;
  readonly observations: ObservationSummary | null;
  readonly checks: CheckSummary | null;
  readonly readiness: GradeResult['readiness'] | null;
  readonly verdicts: readonly Verdict[];
  readonly probeFailures: readonly ProbeFailure[];
}

export interface Snapshot {
  readonly schema: number;
  readonly label: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly corpusVersion: string;
  readonly detectorsImplemented: number;
  readonly settings: Settings;
  readonly sites: readonly SiteReport[];
}

interface Args {
  readonly urls: readonly string[];
  readonly settings: Settings;
  readonly label: string;
  readonly save: boolean;
  readonly out: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const urls: string[] = [];
  let maxPages = 20;
  let maxDepth = 2;
  let requestDelayMs = 400;
  let timeoutMs = 15_000;
  let flags: string[] = [];
  let label = 'run';
  let save = true;
  let out: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--pages': maxPages = Number(next()); break;
      case '--depth': maxDepth = Number(next()); break;
      case '--delay': requestDelayMs = Number(next()); break;
      case '--timeout': timeoutMs = Number(next()); break;
      case '--flags': flags = next().split(',').map((f) => f.trim()).filter((f) => f !== ''); break;
      case '--label': label = next(); break;
      case '--out': out = next(); break;
      case '--no-save': save = false; break;
      case '--file': {
        const text = readFileSync(next(), 'utf8');
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed !== '' && !trimmed.startsWith('#')) urls.push(trimmed);
        }
        break;
      }
      default:
        if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
        urls.push(arg);
    }
  }

  if (urls.length === 0) {
    throw new Error(
      'usage: npm run analyze -- <url...> [--file urls.txt] [--pages N] [--depth N]\n' +
        '       [--delay ms] [--timeout ms] [--flags a,b] [--label name] [--no-save]',
    );
  }
  return {
    urls,
    settings: { maxPages, maxDepth, requestDelayMs, timeoutMs, flags },
    label,
    save,
    out,
  };
}

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const low = sorted[mid - 1] ?? 0;
  const high = sorted[mid] ?? 0;
  return sorted.length % 2 === 0 ? Math.round((low + high) / 2) : Math.round(high);
};

function summarizeCrawl(result: CrawlResult, durationMs: number): CrawlSummary {
  const ttfb = result.pages
    .map((page) => page.fetch.ttfbMs)
    .filter((value): value is number => value !== null);
  return {
    pages: result.pages.length,
    htmlPages: result.pages.filter((page) => page.extracted !== null).length,
    nonOkPages: result.pages.filter(
      (page) => page.fetch.status !== null && (page.fetch.status < 200 || page.fetch.status >= 300),
    ).length,
    transportFailures: result.pages.filter((page) => page.fetch.error !== null).length,
    blockedByRobots: result.blockedByRobots.length,
    notReached: result.notReached.length,
    sitemapUrls: result.sitemapUrls.length,
    robotsTxt: result.robotsTxt !== null,
    medianTtfbMs: median(ttfb),
    durationMs,
  };
}

function summarizeObservations(runs: readonly ProbeRun[]): ObservationSummary {
  let pass = 0;
  let fail = 0;
  let warn = 0;
  let notApplicable = 0;
  let error = 0;
  const firing = new Set<string>();

  for (const run of runs) {
    firing.add(run.probeId);
    switch (run.observation.outcome) {
      case 'pass': pass += 1; break;
      case 'fail': fail += 1; break;
      case 'warn': warn += 1; break;
      case 'not-applicable': notApplicable += 1; break;
      case 'error': error += 1; break;
    }
  }
  return {
    total: runs.length,
    pass, fail, warn, notApplicable, error,
    detectorsFiring: firing.size,
  };
}

function summarizeChecks(graded: GradeResult): CheckSummary {
  const byBasis: Record<string, number> = {};
  let inScope = 0;
  let passed = 0;
  let failed = 0;
  let inProgress = 0;
  let notStarted = 0;

  for (const check of graded.checks) {
    byBasis[check.basis] = (byBasis[check.basis] ?? 0) + 1;
    if (check.applicability === 'yes') inScope += 1;
    switch (check.status) {
      case 'passed': passed += 1; break;
      case 'failed': failed += 1; break;
      case 'in-progress': inProgress += 1; break;
      default: notStarted += 1;
    }
  }

  return {
    total: graded.checks.length,
    inScope,
    // "Graded" means a machine said something about the site, not that the
    // check is done — in-progress counts, because evidence was read.
    graded: passed + failed + inProgress,
    passed,
    failed,
    inProgress,
    notStarted,
    byBasis,
  };
}

async function analyze(url: string, settings: Settings, corpus: Corpus): Promise<SiteReport> {
  const origin = new URL(url).origin;
  const started = Date.now();

  let result: CrawlResult;
  try {
    result = await crawl({
      seeds: [url],
      userAgent: USER_AGENT,
      maxPages: settings.maxPages,
      maxDepth: settings.maxDepth,
      requestDelayMs: settings.requestDelayMs,
      timeoutMs: settings.timeoutMs,
    });
  } catch (cause) {
    return {
      url,
      origin,
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
      crawl: null,
      observations: null,
      checks: null,
      readiness: null,
      verdicts: [],
      probeFailures: [],
    };
  }

  const runs = runProbes({ origin, crawl: result, flags: settings.flags });
  const graded = gradeAudit({
    corpus,
    flags: settings.flags,
    evidence: runs.map((run) => ({ run, resultId: null })),
  });
  const gateOf = new Map(corpus.checks.map((check) => [check.id, check.launchGate]));

  return {
    url,
    origin,
    ok: true,
    error: null,
    crawl: summarizeCrawl(result, Date.now() - started),
    observations: summarizeObservations(runs),
    checks: summarizeChecks(graded),
    readiness: graded.readiness,
    verdicts: graded.checks.map((check) => ({
      checkId: check.checkId,
      status: check.status,
      coverage: check.coverage,
      basis: check.basis,
      launchGate: gateOf.get(check.checkId) === true,
      summary: check.summary,
    })),
    probeFailures: runs
      .filter((run) => run.observation.outcome === 'fail' || run.observation.outcome === 'error')
      .map((run) => ({
        probeId: run.probeId,
        pageUrl: run.pageUrl ?? null,
        summary: run.observation.summary,
        outcome: run.observation.outcome === 'error' ? ('error' as const) : ('fail' as const),
      })),
  };
}

const pct = (part: number, whole: number): string =>
  whole === 0 ? '0%' : `${Math.round((part / whole) * 100)}%`;

function printSite(site: SiteReport): void {
  console.log(`\n=== ${site.url}`);
  const c = site.crawl;
  const o = site.observations;
  const k = site.checks;
  if (c === null || o === null || k === null) {
    console.log(`crawl failed: ${site.error ?? 'unknown error'}`);
    return;
  }

  console.log(
    `crawl       ${c.pages} pages (${c.htmlPages} html, ${c.nonOkPages} non-2xx, ` +
      `${c.transportFailures} unreachable) in ${(c.durationMs / 1000).toFixed(1)}s, ` +
      `ttfb ~${c.medianTtfbMs ?? '?'}ms`,
  );
  console.log(
    `discovery   ${c.sitemapUrls} sitemap urls, ${c.blockedByRobots} robots-blocked, ` +
      `${c.notReached} left unfetched, robots.txt ${c.robotsTxt ? 'found' : 'absent'}`,
  );
  console.log(
    `probes      ${o.total} observations from ${o.detectorsFiring} detectors: ` +
      `${o.pass} pass, ${o.fail} fail, ${o.warn} warn, ${o.notApplicable} n/a, ${o.error} error`,
  );
  console.log(
    `checks      ${k.graded}/${k.total} graded (${pct(k.graded, k.total)}) — ` +
      `${k.passed} passed, ${k.failed} failed, ${k.inProgress} held, ${k.notStarted} not started`,
  );

  const bases = Object.entries(k.byBasis)
    .filter(([basis]) => basis !== 'verified-pass' && basis !== 'verified-fail')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([basis, count]) => `${basis} ${count}`)
    .join(', ');
  if (bases !== '') console.log(`ungraded    ${bases}`);

  const r = site.readiness;
  if (r !== null) {
    console.log(
      `readiness   ${r.decision} — ${r.gatesOutstanding} gates outstanding, ` +
        `${r.gatesFailed} failed, ${r.applicabilityDecisionsOutstanding} scope undecided`,
    );
  }

  const failedChecks = site.verdicts.filter((verdict) => verdict.status === 'failed');
  if (failedChecks.length > 0) {
    console.log('failed checks');
    for (const verdict of failedChecks.slice(0, 10)) {
      const gate = verdict.launchGate ? 'GATE ' : '     ';
      console.log(`  ${verdict.checkId.padEnd(5)}${gate}${verdict.summary}`);
    }
  }

  // Defects and non-observations are counted apart. An older snapshot has no
  // `outcome`, and everything in it was printed as a failure, so that is what
  // it keeps meaning here.
  const tally = (outcome: 'fail' | 'error'): string => {
    const byProbe = new Map<string, number>();
    for (const failure of site.probeFailures) {
      if ((failure.outcome ?? 'fail') !== outcome) continue;
      byProbe.set(failure.probeId, (byProbe.get(failure.probeId) ?? 0) + 1);
    }
    return [...byProbe.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([id, count]) => `${id} x${count}`)
      .join(', ');
  };

  const fails = tally('fail');
  if (fails !== '') console.log(`probe fails ${fails}`);
  const errors = tally('error');
  if (errors !== '') console.log(`probe errors ${errors} (could not observe, never a defect)`);
}

function printTotals(snapshot: Snapshot): void {
  const ok = snapshot.sites.filter((site) => site.checks !== null);
  if (ok.length < 2) return;
  const sum = (pick: (site: SiteReport) => number): number =>
    ok.reduce((total, site) => total + pick(site), 0);

  console.log('\n=== totals');
  console.log(`sites       ${ok.length} analyzed, ${snapshot.sites.length - ok.length} failed`);
  console.log(`pages       ${sum((s) => s.crawl?.pages ?? 0)}`);
  console.log(
    `graded      ${sum((s) => s.checks?.graded ?? 0)} of ${sum((s) => s.checks?.total ?? 0)} check slots ` +
      `(${pct(sum((s) => s.checks?.graded ?? 0), sum((s) => s.checks?.total ?? 0))})`,
  );
  console.log(
    `verdicts    ${sum((s) => s.checks?.passed ?? 0)} passed, ` +
      `${sum((s) => s.checks?.failed ?? 0)} failed, ${sum((s) => s.checks?.inProgress ?? 0)} held`,
  );
  console.log(
    `decision    ${ok.filter((s) => s.readiness?.decision === 'GO').length} GO, ` +
      `${ok.filter((s) => s.readiness?.decision === 'HOLD').length} HOLD`,
  );
}

const stamp = (date: Date): string => date.toISOString().replace(/[:.]/g, '-').slice(0, 19);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const corpus = loadCorpus(join(ROOT, 'corpus', 'v4.4'));
  const startedAt = new Date();
  const started = Date.now();

  console.log(
    `corpus ${corpus.version} · ${corpus.checks.length} checks · ` +
      `${PROBES.length} detectors implemented · budget ${args.settings.maxPages} pages ` +
      `/ depth ${args.settings.maxDepth}` +
      (args.settings.flags.length === 0 ? ' · no site flags' : ` · flags ${args.settings.flags.join(',')}`),
  );

  const sites: SiteReport[] = [];
  for (const url of args.urls) {
    process.stdout.write(`\ncrawling ${url} ...`);
    const site = await analyze(url, args.settings, corpus);
    sites.push(site);
    printSite(site);
  }

  const snapshot: Snapshot = {
    schema: SCHEMA,
    label: args.label,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - started,
    corpusVersion: corpus.version,
    detectorsImplemented: PROBES.length,
    settings: args.settings,
    sites,
  };
  printTotals(snapshot);

  if (args.save) {
    const path =
      args.out ?? join(ROOT, 'benchmarks', 'runs', `${stamp(startedAt)}-${args.label}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    console.log(`\nsnapshot    ${path}`);
    console.log('compare     npm run compare -- <older.json> <newer.json>');
  }
}

main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
});
