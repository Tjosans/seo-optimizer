import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { computeLaunchReadiness, computeProgress } from '@seo/core';
import type { CheckState } from '@seo/core';
import { loadCorpus } from '@seo/corpus';

const CORPUS_DIR = fileURLToPath(new URL('../../../corpus/v4.4', import.meta.url));
const corpus = loadCorpus(CORPUS_DIR);

/**
 * Counts taken from the source workbook's own Progress sheet. They are the
 * ground truth for whether our compilation preserved the author's methodology:
 * if the engine cannot reproduce the spreadsheet it was derived from, the
 * compilation is wrong somewhere.
 */
const WORKBOOK = {
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

describe('corpus integrity', () => {
  it('loads every check with a unique id', () => {
    expect(corpus.checks).toHaveLength(WORKBOOK.checks);
    expect(new Set(corpus.checks.map((c) => c.id)).size).toBe(WORKBOOK.checks);
    expect(corpus.version).toBe('4.4');
  });

  it('preserves the phase distribution of the source workbook', () => {
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

  it('binds detectors to exactly the checks that can be mechanically verified', () => {
    for (const check of corpus.checks) {
      if (check.automation === 'attested') {
        expect(check.detectors, check.id).toHaveLength(0);
      } else {
        expect(check.detectors.length, check.id).toBeGreaterThan(0);
      }
    }
  });

  it('gives every conditional check a way to come into scope', () => {
    for (const check of corpus.checks) {
      if (!check.applicability.universal) {
        expect(check.applicability.any.length, check.id).toBeGreaterThan(0);
        expect(check.applicability.any, check.id).not.toContain('UNMAPPED');
      }
    }
  });

  it('carries the full acceptance criteria that detectors are specified against', () => {
    for (const check of corpus.checks) {
      expect(check.doneWhen.length, check.id).toBeGreaterThan(20);
      expect(check.whatToDo.length, check.id).toBeGreaterThan(20);
    }
  });
});

describe('launch readiness reproduces the source workbook', () => {
  const states = defaultStates();

  it('matches the workbook launch-readiness block exactly', () => {
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

  it('matches the workbook per-phase progress rows', () => {
    const progress = computeProgress(corpus.checks, states);
    expect(progress.reduce((n, p) => n + p.active, 0)).toBe(WORKBOOK.active);
    expect(progress.reduce((n, p) => n + p.scopeReview, 0)).toBe(WORKBOOK.scopeReview);
    for (const row of progress) {
      expect(row.active, `phase ${row.phase} active`).toBe(
        WORKBOOK.activeByPhase[row.phase],
      );
    }
  });
});

describe('launch gate semantics', () => {
  it('holds launch while any gate applicability is undecided', () => {
    const states = defaultStates();
    // Pass every gate that is already in scope; the undecided ones must still HOLD.
    for (const check of corpus.checks) {
      const state = states.get(check.id)!;
      if (state.applicability === 'yes') {
        states.set(check.id, { ...state, status: 'passed', coverage: 'verified' });
      }
    }
    const readiness = computeLaunchReadiness(corpus.checks, states);
    expect(readiness.gatesOutstanding).toBe(0);
    expect(readiness.applicabilityDecisionsOutstanding).toBe(21);
    expect(readiness.decision).toBe('HOLD');
  });

  it('reaches GO only once gates pass and every scope decision is resolved', () => {
    const states = new Map(
      corpus.checks.map((c) => [
        c.id,
        {
          checkId: c.id,
          applicability: 'yes',
          status: 'passed',
          coverage: 'verified',
        } satisfies CheckState,
      ]),
    );
    expect(computeLaunchReadiness(corpus.checks, states).decision).toBe('GO');
  });

  it('refuses to let "skipped" clear an applicable launch gate', () => {
    const states = new Map(
      corpus.checks.map((c) => [
        c.id,
        {
          checkId: c.id,
          applicability: 'yes',
          status: c.launchGate ? 'skipped' : 'passed',
          coverage: 'verified',
        } satisfies CheckState,
      ]),
    );
    const readiness = computeLaunchReadiness(corpus.checks, states);
    expect(readiness.decision).toBe('HOLD');
    expect(readiness.gatesOutstanding).toBe(WORKBOOK.launchGates);
    expect(readiness.violations).toHaveLength(WORKBOOK.launchGates);
    expect(readiness.violations[0]?.kind).toBe('skipped-applicable-gate');
  });

  it('requires a rationale when a check is taken out of scope', () => {
    const states = defaultStates();
    states.set('1.14', {
      checkId: '1.14',
      applicability: 'no',
      status: 'not-started',
      coverage: 'not-applicable',
    });
    const readiness = computeLaunchReadiness(corpus.checks, states);
    expect(
      readiness.violations.some(
        (v) => v.checkId === '1.14' && v.kind === 'excluded-without-rationale',
      ),
    ).toBe(true);
  });

  it('treats profile as advisory and never as a launch filter', () => {
    // Extended-profile launch gates exist; filtering to core would hide them.
    const extendedGates = corpus.checks.filter(
      (c) => c.launchGate && c.profile === 'extended',
    );
    expect(extendedGates.length).toBeGreaterThan(0);
  });
});

describe('citations', () => {
  it('resolves sources for every check whose notes reference them', () => {
    const citing = corpus.checks.filter((c) => /See Sources:/i.test(c.notes));
    expect(citing.length).toBe(22);
    for (const check of citing) {
      expect(check.sources.length, `${check.id} notes cite sources`).toBeGreaterThan(0);
    }
  });

  it('dates every citation so staleness is trackable', () => {
    for (const check of corpus.checks) {
      for (const source of check.sources) {
        expect(source.url, check.id).toMatch(/^https:\/\//);
        expect(source.verified, check.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });
});
