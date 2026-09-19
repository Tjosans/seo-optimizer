/**
 * The release guard: the four defects 1.10 says must block a release — an
 * unintended noindex, a conflicting canonical, a crawler blocked, a broken
 * critical link — read off the detectors that already judge them.
 *
 * Only a `fail` blocks. A `warn` or `error` is the engine saying it could not
 * be sure, which is a reason to look, not a reason to stop a deploy.
 */

import { PROBES } from './registry.js';
import type { Probe, ProbeRun } from './types.js';

export type GuardConcern = 'noindex' | 'canonical' | 'robots' | 'critical-link';

/** Detector id to the defect it stands guard for. */
export const GUARD_PROBES: Readonly<Record<string, GuardConcern>> = {
  'metadata-completeness': 'noindex',
  canonicalization: 'canonical',
  'sitemap-canonical-agreement': 'canonical',
  'robots-txt': 'robots',
  'broken-links': 'critical-link',
};

export const guardProbes = (): readonly Probe[] =>
  PROBES.filter((probe) => probe.id in GUARD_PROBES);

export interface GuardFailure {
  readonly concern: GuardConcern;
  readonly probeId: string;
  readonly pageUrl: string | null;
  readonly summary: string;
}

export interface GuardReport {
  readonly build: string | null;
  readonly failures: readonly GuardFailure[];
  readonly warnings: number;
  readonly passed: boolean;
}

export function evaluateGuard(runs: readonly ProbeRun[], build: string | null): GuardReport {
  const failures: GuardFailure[] = [];
  let warnings = 0;
  for (const run of runs) {
    const concern = GUARD_PROBES[run.probeId];
    if (concern === undefined) continue;
    if (run.observation.outcome === 'warn') warnings += 1;
    if (run.observation.outcome !== 'fail') continue;
    failures.push({
      concern,
      probeId: run.probeId,
      pageUrl: run.pageUrl ?? null,
      summary: run.observation.summary,
    });
  }
  return { build, failures, warnings, passed: failures.length === 0 };
}
