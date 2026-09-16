import { describe, expect, it } from 'vitest';
import {
  READY_FOR_CUTOVER,
  computeCutoverReadiness,
  computeLaunchReadiness,
} from '../src/index.js';
import type {
  Check,
  CheckState,
  Corpus,
  LifecyclePhase,
  ReleaseRecord,
  ReviewRun,
} from '../src/index.js';

function gate(id: string, phase: LifecyclePhase, universal = true): Check {
  return {
    id, phase, phaseLabel: `${phase}`, priority: 'P0', profile: 'core', launchGate: true,
    applicability: { universal, any: universal ? [] : ['ecommerce'], source: '' },
    task: id, whatToDo: '', doneWhen: '', owners: [], ownerSource: '', tools: '',
    cadence: { triggers: [], source: '' }, notes: '',
    automation: 'attested', remediationClass: 'config', detectors: [], sources: [],
  };
}

const corpus: Corpus = {
  version: '5.0',
  reviewed: '2026-09-11',
  checks: [gate('0.3', 0), gate('1.1', 1), gate('5.1', 5)],
};

const ORIGIN = 'https://www.example.com';
const APPROVED = '2026-09-01T00:00:00Z';
const TESTED = '2026-09-02T00:00:00Z';
const CUTOVER = '2026-09-05T00:00:00Z';
const LIVE_TESTED = '2026-09-05T02:00:00Z';
const ASSESSED = '2026-09-06T00:00:00Z';

function run(checkId: string, over: Partial<ReviewRun> = {}): ReviewRun {
  return {
    runId: `run-${checkId}`,
    checkId,
    releaseId: 'r1',
    scopeRevision: 's1',
    criteriaRevision: '5.0',
    origin: ORIGIN,
    environment: checkId.startsWith('0.') ? 'planning'
      : checkId.startsWith('5.') ? 'production' : 'pre-production',
    testedAt: checkId.startsWith('5.') ? LIVE_TESTED : TESTED,
    tester: 'Tess',
    result: 'passed',
    evidence: `ev-${checkId}`,
    reviewedBy: 'Rex',
    reviewedAt: checkId.startsWith('5.') ? LIVE_TESTED : TESTED,
    nextReviewAt: '2026-12-01T00:00:00Z',
    ...over,
  };
}

function passed(checkId: string): CheckState {
  return {
    checkId, applicability: 'yes', status: 'passed', coverage: 'verified',
    evidence: `ev-${checkId}`,
  };
}

const allPassed = () =>
  new Map(corpus.checks.map((check) => [check.id, passed(check.id)]));

function release(over: Partial<ReleaseRecord> = {}): ReleaseRecord {
  return {
    releaseId: 'r1',
    scopeRevision: 's1',
    origin: ORIGIN,
    scopeApprover: 'Ann',
    scopeApprovedAt: APPROVED,
    scopeApprovalEvidence: 'DOC-1',
    decisionOwner: 'Owen',
    assessedAt: ASSESSED,
    cutover: {
      authorizer: 'Ava',
      authorizedAt: '2026-09-04T00:00:00Z',
      decisionReference: 'CAB-7',
      cutoverAt: CUTOVER,
      binding: { releaseId: 'r1', scopeRevision: 's1', origin: ORIGIN, assessment: READY_FOR_CUTOVER },
    },
    reviews: corpus.checks.map((check) => run(check.id)),
    ...over,
  };
}

describe('computeCutoverReadiness', () => {
  it('reaches GO when every gate is passed with current evidence and cutover is recorded', () => {
    const result = computeCutoverReadiness(corpus, allPassed(), release());
    expect(result.blockers).toEqual([]);
    expect(result.scopeProblems).toEqual([]);
    expect(result.cutover).toBe(READY_FOR_CUTOVER);
    expect(result.cutoverRecordValid).toBe(true);
    expect(result.final).toBe('GO');
  });

  it('is ready for cutover before cutover happens, and holds the final GO for the live gate', () => {
    const states = allPassed();
    states.set('5.1', { ...passed('5.1'), status: 'not-started' });
    const result = computeCutoverReadiness(corpus, states, release({
      cutover: undefined,
      reviews: [run('0.3'), run('1.1')],
    }));
    expect(result.cutover).toBe(READY_FOR_CUTOVER);
    expect(result.liveGatesOutstanding).toBe(1);
    expect(result.liveEvidenceIncomplete).toBe(1);
    expect(result.preCutoverEvidenceIncomplete).toBe(0);
    expect(result.final).toBe('HOLD');
  });

  it('does not accept a live test taken before the actual cutover', () => {
    const result = computeCutoverReadiness(corpus, allPassed(), release({
      reviews: [run('0.3'), run('1.1'), run('5.1', { testedAt: TESTED, reviewedAt: TESTED })],
    }));
    expect(result.cutover).toBe(READY_FOR_CUTOVER);
    expect(result.blockers).toEqual([expect.objectContaining({
      checkId: '5.1',
      outstanding: false,
      reviewState: 'current',
      evidenceProblem: 'live test predates or lacks actual cutover',
    })]);
    expect(result.final).toBe('HOLD');
  });

  it('does not accept a preflight gate tested in a planning environment', () => {
    const result = computeCutoverReadiness(corpus, allPassed(), release({
      reviews: [run('0.3'), run('1.1', { environment: 'planning' }), run('5.1')],
    }));
    expect(result.blockers.map((b) => [b.checkId, b.reviewState])).toEqual([
      ['1.1', 'review-required'],
    ]);
    expect(result.cutover).toBe('HOLD');
  });

  it('holds a passed status whose evidence was reviewed for another release', () => {
    const result = computeCutoverReadiness(corpus, allPassed(), release({
      reviews: [run('0.3', { releaseId: 'r0' }), run('1.1'), run('5.1')],
    }));
    expect(result.preCutoverEvidenceIncomplete).toBe(1);
    expect(result.preCutoverGatesOutstanding).toBe(0);
    expect(result.cutover).toBe('HOLD');
  });

  it('holds on a criterion revision the review was not taken against', () => {
    const result = computeCutoverReadiness(corpus, allPassed(), release({
      criteria: { '1.1': 'v5/order02/1.1' },
    }));
    expect(result.blockers.map((b) => b.checkId)).toEqual(['1.1']);
  });

  it('counts each missing release field as a scope error', () => {
    const result = computeCutoverReadiness(corpus, allPassed(), release({
      scopeApprover: 'TBD',
      origin: 'https://www.example.com/shop',
    }));
    expect(result.scopeProblems).toEqual(['target production origin', 'scope approver']);
    expect(result.scopeErrors).toBe(2);
    expect(result.cutover).toBe('HOLD');
  });

  it('counts a gate excluded without a reason as a scope error', () => {
    const states = allPassed();
    states.set('1.1', { checkId: '1.1', applicability: 'no', status: 'not-started', coverage: 'not-applicable' });
    const result = computeCutoverReadiness(corpus, states, release());
    expect(result.scopeErrors).toBe(1);
    expect(result.cutover).toBe('HOLD');
  });

  it('holds while a conditional gate is undecided', () => {
    const conditional: Corpus = { ...corpus, checks: [...corpus.checks, gate('2.2', 2, false)] };
    const result = computeCutoverReadiness(conditional, allPassed(), release());
    expect(result.launch.applicabilityDecisionsOutstanding).toBe(1);
    expect(result.cutover).toBe('HOLD');
  });

  it('refuses a cutover record bound to a result other than READY FOR CUTOVER', () => {
    const base = release();
    const result = computeCutoverReadiness(corpus, allPassed(), release({
      cutover: { ...base.cutover, binding: { ...base.cutover!.binding, assessment: 'HOLD' } },
    }));
    expect(result.cutoverRecordValid).toBe(false);
    expect(result.final).toBe('HOLD');
  });

  it('refuses a cutover authorized before the scope was approved', () => {
    const base = release();
    const result = computeCutoverReadiness(corpus, allPassed(), release({
      cutover: { ...base.cutover, authorizedAt: '2026-08-01T00:00:00Z' },
    }));
    expect(result.cutoverRecordValid).toBe(false);
  });

  it('holds on any review run that fails the data checks, and counts it as an input error', () => {
    const result = computeCutoverReadiness(corpus, allPassed(), release({
      reviews: [
        ...release().reviews!,
        run('1.1', { runId: 'old-1.1', testedAt: '2026-08-20T00:00:00Z', reviewedAt: '2026-08-19T00:00:00Z' }),
      ],
    }));
    expect(result.inputErrors).toBe(1);
    expect(result.blockers.map((b) => [b.checkId, b.reviewState])).toEqual([['1.1', 'invalid']]);
    expect(result.cutover).toBe('HOLD');
  });

  it('flags a recorded GO the calculation does not support', () => {
    const decision = { decision: 'GO' as const, decidedBy: 'Owen', decidedAt: ASSESSED };
    const holding = computeCutoverReadiness(corpus, allPassed(), release({
      cutover: undefined, launchDecision: decision,
    }));
    expect(holding.launchDecision).toBe('conflict');
    const going = computeCutoverReadiness(corpus, allPassed(), release({ launchDecision: decision }));
    expect(going.launchDecision).toBe('agrees');
    const hold = computeCutoverReadiness(corpus, allPassed(), release({
      cutover: undefined, launchDecision: { ...decision, decision: 'HOLD' },
    }));
    expect(hold.launchDecision).toBe('recorded');
  });
});

describe('review freshness', () => {
  const states = allPassed();
  const stateOf = (reviews: readonly ReviewRun[], at = ASSESSED) =>
    computeCutoverReadiness(corpus, states, release({ assessedAt: at, reviews }))
      .blockers.find((b) => b.checkId === '1.1')?.reviewState ?? 'current';

  it('holds a gate once its next review date passes', () => {
    expect(stateOf([run('1.1', { nextReviewAt: '2026-09-03T00:00:00Z' })])).toBe('overdue');
    expect(stateOf([run('1.1', { nextReviewAt: '2026-09-30T00:00:00Z' })])).toBe('current');
  });

  it('accepts a passed run with an event trigger instead of a date', () => {
    expect(stateOf([run('1.1', { nextReviewAt: undefined, eventTrigger: 'next release' })]))
      .toBe('current');
    expect(stateOf([run('1.1', { nextReviewAt: undefined })])).toBe('invalid');
  });

  it('holds a gate reopened after it passed, until it is retested', () => {
    const reopened = run('1.1', {
      runId: 'reopen', result: 'reopened', eventTrigger: 'CDN change',
      testedAt: '2026-09-03T00:00:00Z', reviewedAt: '2026-09-03T00:00:00Z', nextReviewAt: undefined,
    });
    expect(stateOf([run('1.1'), reopened])).toBe('reopened');
    const retest = run('1.1', {
      runId: 'retest', testedAt: '2026-09-04T00:00:00Z', reviewedAt: '2026-09-04T00:00:00Z',
    });
    expect(stateOf([run('1.1'), reopened, retest])).toBe('current');
  });

  it('holds on a failed latest run, and on two runs tied for latest', () => {
    expect(stateOf([run('1.1', { result: 'failed' })])).toBe('failed');
    expect(stateOf([run('1.1'), run('1.1', { runId: 'twin' })])).toBe('ambiguous');
  });

  it('asks for reconciliation when the status or evidence disagrees with the run', () => {
    expect(stateOf([run('1.1', { evidence: 'ev-other' })])).toBe('reconcile');
  });

  it('does not read a review recorded after the assessment', () => {
    expect(stateOf([run('1.1')], '2026-09-01T12:00:00Z')).toBe('invalid');
  });
});

describe('attestation expiry', () => {
  const attested: CheckState = {
    checkId: '1.1', applicability: 'yes', status: 'passed', coverage: 'attested',
    attestationExpiresAt: '2026-09-10T00:00:00Z',
  };
  const states = new Map([['1.1', attested]]);
  const checks = [gate('1.1', 1)];

  it('counts an attested pass until it lapses', () => {
    const before = computeLaunchReadiness(checks, states, { assessedAt: '2026-09-09T00:00:00Z' });
    expect(before.decision).toBe('GO');
    expect(before.attestationsLapsed).toBe(0);
    const after = computeLaunchReadiness(checks, states, { assessedAt: '2026-09-10T00:00:00Z' });
    expect(after.decision).toBe('HOLD');
    expect(after.gatesOutstanding).toBe(1);
    expect(after.attestationsLapsed).toBe(1);
  });

  it('never lapses anything without an assessment time', () => {
    expect(computeLaunchReadiness(checks, states).decision).toBe('GO');
  });
});
