/**
 * The grading rules, asserted one at a time.
 *
 * These run against a hand-built corpus rather than v4.4, because what is under
 * test is the reading of the methodology — "may a machine pass an assisted
 * check", "what does a missing detector mean" — and pinning those to whichever
 * real checks happen to have that shape today would make the rules unreadable
 * and the test brittle. The last block grades the real corpus, which is what
 * catches a rule that is right in the small and wrong at 97 checks.
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { AutomationTier, Check, Corpus } from '@seo/core';
import { loadCorpus } from '@seo/corpus';
import type { Observation, ProbeRun } from '@seo/probes';
import { gradeAudit, resolveScope, toEvidence } from '@seo/grader';
import type { Evidence, GradeBasis, GradedCheck } from '@seo/grader';

function check(over: Partial<Check> & { readonly id: string }): Check {
  return {
    phase: 1,
    phaseLabel: '1 — Day 1 architecture',
    priority: 'P0',
    profile: 'core',
    launchGate: true,
    applicability: { universal: true, any: [], source: 'All sites' },
    task: 'a task',
    whatToDo: 'do the thing',
    doneWhen: 'the thing is done',
    owners: ['developer'],
    ownerSource: 'Developer',
    tools: '',
    cadence: { triggers: [], source: '' },
    notes: '',
    automation: 'automated' as AutomationTier,
    remediationClass: 'code',
    detectors: ['alpha'],
    sources: [],
    ...over,
  };
}

const corpusOf = (...checks: readonly Check[]): Corpus =>
  ({ version: 'test', reviewed: '2026-09-04', checks });

let seq = 0;
function observed(probeId: string, outcome: Observation['outcome']): Evidence {
  seq += 1;
  const run: ProbeRun = {
    probeId,
    scope: 'page',
    pageUrl: `https://example.com/${seq}`,
    observation: { outcome, summary: `${probeId} ${outcome}` },
  };
  return { run, resultId: `result-${seq}` };
}

const IMPLEMENTED = new Set(['alpha', 'beta']);

function gradeOne(
  subject: Check,
  evidence: readonly Evidence[],
  flags: readonly string[] = [],
): GradedCheck {
  const result = gradeAudit({
    corpus: corpusOf(subject),
    flags,
    evidence,
    implementedDetectors: IMPLEMENTED,
  });
  return result.checks[0]!;
}

const basisOf = (graded: GradedCheck): GradeBasis => graded.basis;

describe('what a machine may say about a check', () => {
  it('passes an automated check every observation passed', () => {
    const graded = gradeOne(check({ id: '1' }), [observed('alpha', 'pass')]);
    expect(graded.status).toBe('passed');
    expect(graded.coverage).toBe('verified');
    expect(basisOf(graded)).toBe('verified-pass');
  });

  it('fails a check any observation failed', () => {
    const graded = gradeOne(check({ id: '1' }), [
      observed('alpha', 'pass'),
      observed('alpha', 'fail'),
    ]);
    expect(graded.status).toBe('failed');
    expect(graded.coverage).toBe('verified');
    expect(graded.counts).toMatchObject({ pass: 1, fail: 1 });
  });

  it('fails an assisted check on observed evidence, without waiting for a human', () => {
    // A defect a probe saw is a defect. Confirmation is for clearing a check,
    // not for admitting one is broken.
    const graded = gradeOne(check({ id: '1', automation: 'assisted' }), [
      observed('alpha', 'fail'),
    ]);
    expect(graded.status).toBe('failed');
    expect(graded.coverage).toBe('verified');
  });

  it('never passes an assisted check, however clean the evidence', () => {
    const graded = gradeOne(check({ id: '1', automation: 'assisted' }), [
      observed('alpha', 'pass'),
      observed('alpha', 'pass'),
    ]);
    expect(graded.status).toBe('in-progress');
    expect(graded.coverage).toBe('unknown');
    expect(basisOf(graded)).toBe('awaiting-confirmation');
  });

  it('never grades an attested check at all', () => {
    const graded = gradeOne(
      check({ id: '1', automation: 'attested', detectors: [] }),
      [],
    );
    expect(graded.status).toBe('not-started');
    expect(graded.coverage).toBe('unknown');
    expect(basisOf(graded)).toBe('attested-only');
  });

  it('will not clear a check something warned about', () => {
    const graded = gradeOne(check({ id: '1' }), [
      observed('alpha', 'pass'),
      observed('alpha', 'warn'),
    ]);
    expect(graded.status).toBe('in-progress');
    expect(basisOf(graded)).toBe('held-by-warning');
  });

  it('clears a check whose subject is not on the site, and says so', () => {
    const graded = gradeOne(check({ id: '1' }), [
      observed('alpha', 'not-applicable'),
      observed('alpha', 'not-applicable'),
    ]);
    expect(graded.status).toBe('passed');
    // Passed, but nobody verified anything — which is the distinction the
    // coverage column exists to keep.
    expect(graded.coverage).toBe('not-applicable');
    expect(basisOf(graded)).toBe('nothing-to-verify');
  });
});

describe('what a machine refuses to say', () => {
  it('leaves a check ungraded when a detector is not implemented', () => {
    const graded = gradeOne(check({ id: '1', detectors: ['alpha', 'gamma'] }), [
      observed('alpha', 'pass'),
    ]);
    expect(graded.status).toBe('not-started');
    expect(graded.coverage).toBe('unknown');
    expect(basisOf(graded)).toBe('detectors-missing');
    expect(graded.summary).toContain('gamma');
    // Partial coverage is not partial verification, so the partial evidence is
    // not filed against a verdict that was never reached.
    expect(graded.evidenceIds).toEqual([]);
  });

  it('leaves a check ungraded when an implemented detector observed nothing', () => {
    const graded = gradeOne(check({ id: '1', detectors: ['alpha', 'beta'] }), [
      observed('alpha', 'pass'),
    ]);
    expect(graded.status).toBe('not-started');
    expect(basisOf(graded)).toBe('no-observation');
    expect(graded.summary).toContain('beta');
  });

  it('treats a probe that could not run as a hole, not as a failure', () => {
    const graded = gradeOne(check({ id: '1' }), [
      observed('alpha', 'pass'),
      observed('alpha', 'error'),
    ]);
    expect(graded.status).toBe('not-started');
    expect(graded.coverage).toBe('unknown');
    expect(basisOf(graded)).toBe('probe-error');
  });
});

describe('scope', () => {
  const conditional = check({
    id: '1',
    applicability: {
      universal: false,
      any: ['ecommerce', 'marketplace'],
      source: 'Ecommerce sites',
    },
  });

  it('puts a check in scope when the site holds one of its flags', () => {
    expect(resolveScope(conditional, ['hierarchical', 'ecommerce']).applicability).toBe('yes');
  });

  it('narrows a check out of scope, with a rationale, on a profile that was filled in', () => {
    const decision = resolveScope(conditional, ['hierarchical']);
    expect(decision.applicability).toBe('no');
    expect(decision.rationale).toContain('ecommerce');
    expect(decision.rationale).toContain('hierarchical');
  });

  it('leaves scope undecided when the site profile says nothing at all', () => {
    // An empty profile is a form nobody filled in, not a declaration that none
    // of these apply. Narrowing on it would clear conditional launch gates for
    // free.
    const decision = resolveScope(conditional, []);
    expect(decision.applicability).toBe('review');
    expect(decision.rationale).toBeNull();
  });

  it('grades an out-of-scope check as not-applicable and never looks at evidence', () => {
    const graded = gradeOne(conditional, [observed('alpha', 'fail')], ['hierarchical']);
    expect(graded.applicability).toBe('no');
    expect(graded.applicabilityRationale).not.toBeNull();
    expect(graded.coverage).toBe('not-applicable');
    expect(graded.status).toBe('not-started');
    expect(graded.evidenceIds).toEqual([]);
  });
});

describe('the evidence trail', () => {
  it('files every observation the verdict was read from', () => {
    const evidence = [
      observed('alpha', 'pass'),
      observed('beta', 'fail'),
    ];
    const graded = gradeOne(check({ id: '1', detectors: ['alpha', 'beta'] }), evidence);
    expect(graded.evidenceIds).toEqual(evidence.map((item) => item.resultId));
  });

  it('pairs probe runs with the rows they were written to', () => {
    const runs = [observed('alpha', 'pass').run, observed('beta', 'pass').run];
    expect(toEvidence(runs, ['a', 'b'])).toEqual([
      { run: runs[0], resultId: 'a' },
      { run: runs[1], resultId: 'b' },
    ]);
    expect(() => toEvidence(runs, ['a'])).toThrow(/cannot pair/);
  });
});

describe('readiness', () => {
  it('holds the launch on an applicable gate nothing graded', () => {
    const result = gradeAudit({
      corpus: corpusOf(check({ id: '1', detectors: ['gamma'] })),
      flags: ['hierarchical'],
      evidence: [],
      implementedDetectors: IMPLEMENTED,
    });
    expect(result.readiness.decision).toBe('HOLD');
    expect(result.readiness.gatesOutstanding).toBe(1);
  });

  it('goes when every applicable gate is passed', () => {
    const result = gradeAudit({
      corpus: corpusOf(check({ id: '1' })),
      flags: ['hierarchical'],
      evidence: [observed('alpha', 'pass')],
      implementedDetectors: IMPLEMENTED,
    });
    expect(result.readiness.decision).toBe('GO');
  });

  it('records no integrity violation for a check it narrowed out of scope', () => {
    // The grader always writes the rationale the methodology requires, so its
    // own output must never trip the excluded-without-rationale rule.
    const result = gradeAudit({
      corpus: corpusOf(
        check({
          id: '1',
          applicability: { universal: false, any: ['ecommerce'], source: 'Shops' },
        }),
      ),
      flags: ['hierarchical'],
      evidence: [],
      implementedDetectors: IMPLEMENTED,
    });
    expect(result.readiness.violations).toEqual([]);
    expect(result.readiness.decision).toBe('GO');
  });
});

describe('against the real v4.4 corpus', () => {
  const corpus = loadCorpus(
    fileURLToPath(new URL('../../../corpus/v4.4', import.meta.url)),
  );

  it('grades every check, with no evidence at all', () => {
    const result = gradeAudit({ corpus, flags: ['hierarchical'], evidence: [] });
    expect(result.checks).toHaveLength(97);
    expect(new Set(result.checks.map((c) => c.checkId)).size).toBe(97);
    // Nothing observed means nothing cleared: an audit with no evidence must
    // never read GO.
    expect(result.readiness.decision).toBe('HOLD');
    expect(result.checks.every((c) => c.status === 'not-started')).toBe(true);
  });

  it('never passes a check whose detectors the engine has not implemented', () => {
    const result = gradeAudit({ corpus, flags: ['hierarchical'], evidence: [] });
    const gradedOnEvidence = result.checks.filter(
      (c) => c.basis === 'verified-pass' || c.basis === 'verified-fail',
    );
    expect(gradedOnEvidence).toEqual([]);
  });

  it('reports the corpus version it graded against', () => {
    const result = gradeAudit({ corpus, flags: [], evidence: [] });
    expect(result.corpusVersion).toBe(corpus.version);
    expect(Date.parse(result.gradedAt)).not.toBeNaN();
  });
});
