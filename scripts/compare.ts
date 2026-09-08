/**
 * Diff two analyze snapshots.
 *
 * The prototype's whole point: did a change to the engine make an audit say
 * more, or say it better? This answers that by comparing two runs over the same
 * URLs — coverage, verdicts, observations — and listing every check whose
 * verdict moved.
 *
 *     npm run compare -- benchmarks/runs/<older>.json benchmarks/runs/<newer>.json
 *
 * Caveat worth keeping in mind: these are live sites. A difference can come
 * from the site changing rather than the engine changing, so treat a moved
 * verdict as a lead, not a proof. Crawl-budget or flag differences between the
 * two runs are called out, because those alone can move every number here.
 */

import { readFileSync } from 'node:fs';
import type { SiteReport, Snapshot, Verdict } from './analyze.ts';

const load = (path: string): Snapshot => {
  const snapshot = JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
  if (snapshot.schema !== 1) {
    throw new Error(`${path}: unsupported snapshot schema ${String(snapshot.schema)}`);
  }
  return snapshot;
};

const delta = (before: number, after: number): string => {
  const change = after - before;
  const sign = change > 0 ? `+${change}` : String(change);
  return `${String(before).padStart(5)} -> ${String(after).padEnd(5)} ${change === 0 ? '' : sign}`;
};

function line(name: string, before: number, after: number): void {
  console.log(`  ${name.padEnd(14)}${delta(before, after)}`);
}

function compareSettings(a: Snapshot, b: Snapshot): void {
  const notes: string[] = [];
  if (a.settings.maxPages !== b.settings.maxPages) {
    notes.push(`page budget ${a.settings.maxPages} -> ${b.settings.maxPages}`);
  }
  if (a.settings.maxDepth !== b.settings.maxDepth) {
    notes.push(`depth ${a.settings.maxDepth} -> ${b.settings.maxDepth}`);
  }
  if (a.settings.flags.join(',') !== b.settings.flags.join(',')) {
    notes.push(`flags [${a.settings.flags.join(',')}] -> [${b.settings.flags.join(',')}]`);
  }
  if (a.corpusVersion !== b.corpusVersion) {
    notes.push(`corpus ${a.corpusVersion} -> ${b.corpusVersion}`);
  }
  if (notes.length > 0) {
    console.log(`\nWARNING: the runs are not directly comparable — ${notes.join('; ')}`);
  }
}

function compareSite(before: SiteReport, after: SiteReport): void {
  console.log(`\n=== ${after.url}`);

  if (before.checks === null || after.checks === null) {
    console.log(
      `  crawl status ${before.ok ? 'ok' : `failed (${before.error ?? '?'})`} -> ` +
        `${after.ok ? 'ok' : `failed (${after.error ?? '?'})`}`,
    );
    return;
  }

  const bc = before.crawl;
  const ac = after.crawl;
  if (bc !== null && ac !== null) {
    line('pages', bc.pages, ac.pages);
    line('crawl secs', Math.round(bc.durationMs / 1000), Math.round(ac.durationMs / 1000));
  }

  const bo = before.observations;
  const ao = after.observations;
  if (bo !== null && ao !== null) {
    line('observations', bo.total, ao.total);
    line('detectors', bo.detectorsFiring, ao.detectorsFiring);
    line('obs failing', bo.fail, ao.fail);
    line('obs erroring', bo.error, ao.error);
  }

  line('checks graded', before.checks.graded, after.checks.graded);
  line('passed', before.checks.passed, after.checks.passed);
  line('failed', before.checks.failed, after.checks.failed);
  line('held', before.checks.inProgress, after.checks.inProgress);

  const br = before.readiness;
  const ar = after.readiness;
  if (br !== null && ar !== null) {
    console.log(
      `  readiness     ${br.decision} -> ${ar.decision}` +
        `  (gates outstanding ${br.gatesOutstanding} -> ${ar.gatesOutstanding}, ` +
        `failed ${br.gatesFailed} -> ${ar.gatesFailed})`,
    );
  }

  const previous = new Map(before.verdicts.map((verdict) => [verdict.checkId, verdict]));
  const moved: Array<{ before: Verdict | undefined; after: Verdict }> = [];
  for (const verdict of after.verdicts) {
    const was = previous.get(verdict.checkId);
    if (was === undefined || was.status !== verdict.status || was.basis !== verdict.basis) {
      moved.push({ before: was, after: verdict });
    }
  }

  if (moved.length === 0) {
    console.log('  verdicts      unchanged');
    return;
  }
  console.log(`  verdicts moved (${moved.length})`);
  for (const change of moved) {
    const was =
      change.before === undefined
        ? 'absent'
        : `${change.before.status}/${change.before.basis}`;
    const gate = change.after.launchGate ? ' GATE' : '';
    console.log(
      `    ${change.after.checkId.padEnd(5)}${gate} ${was} -> ` +
        `${change.after.status}/${change.after.basis}`,
    );
  }
}

function main(): void {
  const [pathA, pathB] = process.argv.slice(2);
  if (pathA === undefined || pathB === undefined) {
    throw new Error('usage: npm run compare -- <older.json> <newer.json>');
  }

  const a = load(pathA);
  const b = load(pathB);

  console.log(
    `A  ${a.startedAt}  label=${a.label}  ${a.detectorsImplemented} detectors  ${a.sites.length} sites`,
  );
  console.log(
    `B  ${b.startedAt}  label=${b.label}  ${b.detectorsImplemented} detectors  ${b.sites.length} sites`,
  );
  compareSettings(a, b);

  const byUrl = new Map(a.sites.map((site) => [site.url, site]));
  for (const site of b.sites) {
    const was = byUrl.get(site.url);
    if (was === undefined) {
      console.log(`\n=== ${site.url}\n  new in B — nothing to compare against`);
      continue;
    }
    compareSite(was, site);
    byUrl.delete(site.url);
  }
  for (const dropped of byUrl.keys()) {
    console.log(`\n=== ${dropped}\n  present in A, absent from B`);
  }
}

try {
  main();
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
}
