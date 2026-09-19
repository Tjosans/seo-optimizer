/**
 * Release guard for a site's own CI.
 *
 *     npm run guard -- https://staging.example.com --build $GITHUB_SHA
 *
 * Crawls the URL, runs the noindex, canonical, robots and critical-link
 * detectors, prints each failure and exits 1 on any `fail`. Exit 2 means the
 * guard could not run (bad arguments, crawl threw), never a verdict.
 */

import { crawl } from '@seo/crawler';
import { evaluateGuard, guardProbes, runProbes } from '@seo/probes';

const USER_AGENT = 'seo-optimizer-guard/0.1 (+https://github.com/Tjosans/seo-optimizer)';
const USAGE =
  'usage: npm run guard -- <url> [--build id] [--pages N] [--depth N] [--delay ms] [--timeout ms]';

function parseArgs(argv: readonly string[]) {
  let url: string | null = null;
  let build: string | null = null;
  let maxPages = 50;
  let maxDepth = 3;
  let requestDelayMs = 200;
  let timeoutMs = 15_000;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value\n${USAGE}`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--build': build = next(); break;
      case '--pages': maxPages = Number(next()); break;
      case '--depth': maxDepth = Number(next()); break;
      case '--delay': requestDelayMs = Number(next()); break;
      case '--timeout': timeoutMs = Number(next()); break;
      default:
        if (arg.startsWith('--') || url !== null) throw new Error(`unexpected ${arg}\n${USAGE}`);
        url = arg;
    }
  }
  if (url === null) throw new Error(USAGE);
  return { url: new URL(url).href, build, maxPages, maxDepth, requestDelayMs, timeoutMs };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const origin = new URL(args.url).origin;
  const result = await crawl({
    seeds: [args.url],
    userAgent: USER_AGENT,
    maxPages: args.maxPages,
    maxDepth: args.maxDepth,
    requestDelayMs: args.requestDelayMs,
    timeoutMs: args.timeoutMs,
  });
  const runs = runProbes({ origin, crawl: result, flags: [], previous: null, inputs: {} }, guardProbes());
  const report = evaluateGuard(runs, args.build);

  console.log(`guard ${args.url} · build ${report.build ?? '(unnamed)'} · ${result.pages.length} pages crawled`);
  for (const failure of report.failures) {
    console.log(`FAIL ${failure.concern.padEnd(13)} ${failure.probeId}${failure.pageUrl === null ? '' : ` ${failure.pageUrl}`}`);
    console.log(`     ${failure.summary}`);
  }
  if (report.warnings > 0) console.log(`${report.warnings} warning(s): held for a person, not blocking`);
  console.log(report.passed ? 'guard passed' : `guard FAILED: ${report.failures.length} failure(s)`);
  process.exitCode = report.passed ? 0 : 1;
}

main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 2;
});
