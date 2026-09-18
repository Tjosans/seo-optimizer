/**
 * compare.js holds the dashboard's cross-audit diffing — no DOM, pure
 * functions over the same jsonb shapes the API already returns — so it is
 * tested directly here rather than through a browser harness the dashboard
 * has none of.
 */

import { describe, expect, it } from 'vitest';
import { diffChecks, diffReadiness, overallPercent } from '../public/compare.js';

function progress(entries: Array<[phase: number, percentComplete: number, active: number]>) {
  return entries.map(([phase, percentComplete, active]) => ({
    phase,
    active,
    notStarted: 0,
    inProgress: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    percentComplete,
    scopeReview: 0,
  }));
}

function frozen(corpusVersion: string, decision: 'GO' | 'HOLD', gatesOutstanding: number, gatesFailed: number, prog: ReturnType<typeof progress>) {
  return {
    corpusVersion,
    gradedAt: '2026-01-01T00:00:00.000Z',
    readiness: { decision, gatesOutstanding, gatesFailed, applicabilityDecisionsOutstanding: 0, attestationsLapsed: 0, violations: [] },
    progress: prog,
  };
}

describe('overallPercent', () => {
  it('returns null with no active checks', () => {
    expect(overallPercent([])).toBeNull();
    expect(overallPercent(progress([[0, 50, 0]]))).toBeNull();
  });

  it('weights each phase by its active check count', () => {
    const p = progress([[0, 100, 2], [1, 0, 2]]);
    expect(overallPercent(p)).toBe(50);
  });
});

describe('diffReadiness', () => {
  it('reports null summaries and no phase deltas when either side is ungraded', () => {
    const result = diffReadiness(null, null);
    expect(result.baseline).toBeNull();
    expect(result.current).toBeNull();
    expect(result.phaseDeltas).toEqual([]);
    expect(result.corpusVersionMismatch).toBe(false);
    expect(result.decisionChanged).toBe(false);
  });

  it('flags a corpus version mismatch and a decision change', () => {
    const baseline = frozen('4.4', 'HOLD', 5, 2, progress([[0, 40, 10]]));
    const current = frozen('5.0', 'GO', 0, 0, progress([[0, 100, 10]]));
    const result = diffReadiness(baseline, current);
    expect(result.corpusVersionMismatch).toBe(true);
    expect(result.decisionChanged).toBe(true);
    expect(result.baseline).toMatchObject({ corpusVersion: '4.4', decision: 'HOLD', overallPercent: 40 });
    expect(result.current).toMatchObject({ corpusVersion: '5.0', decision: 'GO', overallPercent: 100 });
  });

  it('computes a per-phase delta only where both sides have the phase', () => {
    const baseline = frozen('5.0', 'HOLD', 3, 1, progress([[0, 40, 10], [1, 20, 5]]));
    const current = frozen('5.0', 'HOLD', 2, 1, progress([[0, 60, 10], [2, 10, 5]]));
    const result = diffReadiness(baseline, current);
    expect(result.phaseDeltas).toEqual([
      { phase: 0, baselinePercent: 40, currentPercent: 60, delta: 20 },
      { phase: 1, baselinePercent: 20, currentPercent: null, delta: null },
      { phase: 2, baselinePercent: null, currentPercent: 10, delta: null },
    ]);
  });
});

describe('diffChecks', () => {
  it('finds no moves when nothing changed', () => {
    const checks = [{ checkId: '1.3', status: 'passed', applicability: 'yes' }];
    expect(diffChecks(checks, checks)).toEqual([]);
  });

  it('reports a status or applicability change as a move', () => {
    const baseline = [
      { checkId: '1.3', status: 'passed', applicability: 'yes' },
      { checkId: '2.1', status: 'failed', applicability: 'yes' },
    ];
    const current = [
      { checkId: '1.3', status: 'failed', applicability: 'yes' },
      { checkId: '2.1', status: 'failed', applicability: 'no' },
    ];
    expect(diffChecks(baseline, current)).toEqual([
      { checkId: '1.3', before: { status: 'passed', applicability: 'yes' }, after: { status: 'failed', applicability: 'yes' } },
      { checkId: '2.1', before: { status: 'failed', applicability: 'yes' }, after: { status: 'failed', applicability: 'no' } },
    ]);
  });

  it('reports a check with no baseline counterpart as new, sorted by check id', () => {
    const baseline = [{ checkId: '2.1', status: 'passed', applicability: 'yes' }];
    const current = [
      { checkId: '2.1', status: 'passed', applicability: 'yes' },
      { checkId: '1.3', status: 'failed', applicability: 'yes' },
    ];
    const result = diffChecks(baseline, current);
    expect(result).toEqual([{ checkId: '1.3', before: null, after: { status: 'failed', applicability: 'yes' } }]);
  });
});
