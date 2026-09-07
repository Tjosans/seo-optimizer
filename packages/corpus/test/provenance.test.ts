/**
 * Does v4.4 still say what the workbook said?
 *
 * These numbers come from the source workbook's own Progress sheet, and they
 * are the ground truth for one question only: did the compilation preserve the
 * author's methodology? If the engine cannot reproduce the spreadsheet it was
 * derived from, the compilation is wrong somewhere.
 *
 * That makes this file **frozen**. It is pinned to v4.4 and to the workbook
 * reviewed 2026-08-27, and it must keep asserting those exact counts forever.
 * A newer methodology does not edit these numbers — it is a new version
 * directory with a provenance file of its own, and v4.4 stays reproducible
 * because delivered reports pin it.
 *
 * Everything that should hold for *any* corpus version — unique ids, the
 * detector/tier contract, launch-gate semantics — lives in `corpus.test.ts`
 * instead, and runs against every version on disk. Adding a check to a live
 * corpus must not require editing a record of a spreadsheet.
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { computeLaunchReadiness, computeProgress } from '@seo/core';
import type { CheckState } from '@seo/core';
import { loadCorpus } from '@seo/corpus';

const corpus = loadCorpus(fileURLToPath(new URL('../../../corpus/v4.4', import.meta.url)));

/** Taken from the workbook Progress sheet, reviewed 2026-08-27. Do not update. */
const WORKBOOK = {
  version: '4.4',
  checks: 97,
  sources: 34,
  active: 58,
  scopeReview: 39,
  launchGates: 55,
  gatesOutstanding: 34,
  applicabilityDecisionsOutstanding: 21,
  decision: 'HOLD' as const,
  activeByPhase: [6, 12, 5, 10, 7, 5, 5, 8],
  checksByPhase: [9, 19, 17, 13, 12, 8, 9, 10],
  priority: { P0: 55, P1: 35, P2: 7 },
  profile: { core: 68, extended: 29 },
  checksCitingSources: 22,
};

/** The corpus default: universal checks are in scope, conditional ones await a decision. */
function defaultStates(): Map<string, CheckState> {
  return new Map(
    corpus.checks.map((c) => [
      c.id,
      {
        checkId: c.id,
        applicability: c.applicability.universal ? 'yes' : 'review',
        status: 'not-started',
        coverage: 'unknown',
      } satisfies CheckState,
    ]),
  );
}

describe('v4.4 still reproduces its source workbook', () => {
  it('carries the version and the check count the workbook declared', () => {
    expect(corpus.version).toBe(WORKBOOK.version);
    expect(corpus.checks).toHaveLength(WORKBOOK.checks);
  });

  it('preserves the phase distribution', () => {
    for (let phase = 0; phase < 8; phase += 1) {
      const count = corpus.checks.filter((c) => c.phase === phase).length;
      expect(count, `phase ${phase}`).toBe(WORKBOOK.checksByPhase[phase]);
    }
  });

  it('preserves priority and profile distributions', () => {
    for (const [priority, expected] of Object.entries(WORKBOOK.priority)) {
      const count = corpus.checks.filter((c) => c.priority === priority).length;
      expect(count, priority).toBe(expected);
    }
    for (const [profile, expected] of Object.entries(WORKBOOK.profile)) {
      const count = corpus.checks.filter((c) => c.profile === profile).length;
      expect(count, profile).toBe(expected);
    }
  });

  it('counts the checks the workbook cited', () => {
    const citing = corpus.checks.filter((c) => /See Sources:/i.test(c.notes));
    expect(citing).toHaveLength(WORKBOOK.checksCitingSources);
  });
});

describe('v4.4 reproduces the workbook launch-readiness block', () => {
  const states = defaultStates();

  it('matches it exactly', () => {
    const readiness = computeLaunchReadiness(corpus.checks, states);
    expect(readiness.gatesOutstanding).toBe(WORKBOOK.gatesOutstanding);
    expect(readiness.gatesFailed).toBe(0);
    expect(readiness.applicabilityDecisionsOutstanding).toBe(
      WORKBOOK.applicabilityDecisionsOutstanding,
    );
    expect(readiness.decision).toBe(WORKBOOK.decision);
    expect(readiness.violations).toHaveLength(0);
  });

  it('accounts for every launch gate as either outstanding or undecided', () => {
    const gates = corpus.checks.filter((c) => c.launchGate);
    expect(gates).toHaveLength(WORKBOOK.launchGates);
    expect(
      WORKBOOK.gatesOutstanding + WORKBOOK.applicabilityDecisionsOutstanding,
    ).toBe(WORKBOOK.launchGates);
  });

  it('matches the per-phase progress rows', () => {
    const progress = computeProgress(corpus.checks, states);
    expect(progress.reduce((n, p) => n + p.active, 0)).toBe(WORKBOOK.active);
    expect(progress.reduce((n, p) => n + p.scopeReview, 0)).toBe(WORKBOOK.scopeReview);
    for (const row of progress) {
      expect(row.active, `phase ${row.phase} active`).toBe(
        WORKBOOK.activeByPhase[row.phase],
      );
    }
  });

  it('leaves exactly the workbook’s scope decisions undecided once gates pass', () => {
    const states = defaultStates();
    for (const check of corpus.checks) {
      const state = states.get(check.id)!;
      if (state.applicability === 'yes') {
        states.set(check.id, { ...state, status: 'passed', coverage: 'verified' });
      }
    }
    const readiness = computeLaunchReadiness(corpus.checks, states);
    expect(readiness.applicabilityDecisionsOutstanding).toBe(
      WORKBOOK.applicabilityDecisionsOutstanding,
    );
  });
});
