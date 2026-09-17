/**
 * Releases and review runs against a live database.
 *
 * Skipped unless DATABASE_URL is set: `npm run stack:up`, then copy
 * .env.example to .env. What is under test is what @seo/core cannot check on
 * its own: that a release and its log survive the round trip, that the log is
 * append-only in the database and not only by convention, and that an audit
 * naming a release freezes READY FOR CUTOVER beside launch readiness.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { READY_FOR_CUTOVER, evidenceReference } from '@seo/core';
import type { Check, Corpus, ReviewRun } from '@seo/core';
import { audits, createDatabase, probeResults, reviewRuns, sites } from '@seo/db';
import {
  InvalidReviewRunError,
  ReleaseSiteMismatchError,
  gradeAudit,
  loadRelease,
  recordGrade,
  recordReviewRun,
  saveRelease,
} from '@seo/grader';
import type { ReleaseInput } from '@seo/grader';

const ORIGIN = 'https://release-test.example';
const OTHER = 'https://release-test-other.example';

const gate = (id: string): Check => ({
  id,
  phase: 1,
  phaseLabel: '1 — Day 1 architecture',
  priority: 'P0',
  profile: 'core',
  launchGate: true,
  applicability: { universal: true, any: [], source: 'All sites' },
  task: 'a task',
  whatToDo: '',
  doneWhen: '',
  owners: ['developer'],
  ownerSource: 'Developer',
  tools: '',
  cadence: { triggers: [], source: '' },
  notes: '',
  automation: 'automated',
  remediationClass: 'code',
  detectors: ['alpha'],
  sources: [],
});

const CORPUS: Corpus = { version: 'test', reviewed: '2026-09-17', checks: [gate('1.1')] };

const RELEASE: ReleaseInput = {
  releaseId: 'r1',
  scopeRevision: 's1',
  origin: ORIGIN,
  scopeApprover: 'Ann',
  scopeApprovedAt: '2026-09-01T00:00:00.000Z',
  scopeApprovalEvidence: 'DOC-1',
  decisionOwner: 'Owen',
  cutover: {
    authorizer: 'Ava',
    authorizedAt: '2026-09-04T00:00:00.000Z',
    decisionReference: 'CAB-7',
    cutoverAt: '2026-09-05T00:00:00.000Z',
    binding: { releaseId: 'r1', scopeRevision: 's1', origin: ORIGIN, assessment: READY_FOR_CUTOVER },
  },
};

const run = (over: Partial<ReviewRun> = {}): ReviewRun => ({
  runId: 'run-1',
  checkId: '1.1',
  releaseId: 'r1',
  scopeRevision: 's1',
  criteriaRevision: 'test',
  origin: ORIGIN,
  environment: 'pre-production',
  testedAt: '2026-09-02T00:00:00.000Z',
  tester: 'Tess',
  result: 'passed',
  evidence: 'EV-1',
  reviewedBy: 'Rex',
  reviewedAt: '2026-09-02T01:00:00.000Z',
  nextReviewAt: '2027-01-01T00:00:00.000Z',
  ...over,
});

const url = process.env['DATABASE_URL'];

describe.skipIf(!url)('releases and the review log', () => {
  const handle = createDatabase(url ?? '', { max: 4 });
  const { db } = handle;
  let siteId: string;

  afterAll(async () => {
    await db.delete(sites).where(sql`${sites.origin} in (${ORIGIN}, ${OTHER})`);
    await handle.close();
  });

  beforeEach(async () => {
    await db.delete(sites).where(sql`${sites.origin} in (${ORIGIN}, ${OTHER})`);
    const [site] = await db
      .insert(sites)
      .values({ name: 'release fixture', origin: ORIGIN })
      .returning({ id: sites.id });
    siteId = site!.id;
  });

  it('round-trips a release and its site’s review log', async () => {
    const id = await saveRelease(db, siteId, { ...RELEASE, criteria: { '1.1': 'test' } });
    await recordReviewRun(db, { siteId, corpus: CORPUS, run: run() });

    const { siteId: owner, ...loaded } = await loadRelease(db, id);
    expect(owner).toBe(siteId);
    expect(loaded).toEqual({
      ...RELEASE,
      criteria: { '1.1': 'test' },
      reviews: [run()],
    });
  });

  it('replaces a release saved again under the same name', async () => {
    const first = await saveRelease(db, siteId, { releaseId: 'r1' });
    const second = await saveRelease(db, siteId, RELEASE);
    expect(second).toBe(first);
    expect((await loadRelease(db, first)).decisionOwner).toBe('Owen');
  });

  it('refuses a run the assessment would count as an input error', async () => {
    await expect(
      recordReviewRun(db, { siteId, corpus: CORPUS, run: run({ checkId: '9.9' }) }),
    ).rejects.toBeInstanceOf(InvalidReviewRunError);
    await expect(
      recordReviewRun(db, {
        siteId,
        corpus: CORPUS,
        run: run(),
        now: new Date('2026-09-02T00:30:00Z'),
      }),
    ).rejects.toThrow(/after the assessment/);
    expect(await db.select().from(reviewRuns).where(eq(reviewRuns.siteId, siteId))).toHaveLength(0);
  });

  it('refuses a run id the log already holds', async () => {
    await recordReviewRun(db, { siteId, corpus: CORPUS, run: run() });
    await expect(
      recordReviewRun(db, { siteId, corpus: CORPUS, run: run({ result: 'failed' }) }),
    ).rejects.toThrow();
  });

  it('refuses to edit or delete a run, and lets a site’s deletion remove its log', async () => {
    await recordReviewRun(db, { siteId, corpus: CORPUS, run: run() });

    await expect(
      db.update(reviewRuns).set({ result: 'failed' }).where(eq(reviewRuns.siteId, siteId)),
    ).rejects.toThrow();
    await expect(
      db.delete(reviewRuns).where(eq(reviewRuns.siteId, siteId)),
    ).rejects.toThrow();
    expect(await db.select().from(reviewRuns).where(eq(reviewRuns.siteId, siteId))).toHaveLength(1);

    await db.delete(sites).where(eq(sites.id, siteId));
    expect(await db.select().from(reviewRuns).where(eq(reviewRuns.siteId, siteId))).toHaveLength(0);
  });

  describe('grading an audit that names a release', () => {
    const auditFor = async (releaseId: string | null) => {
      const [audit] = await db
        .insert(audits)
        .values({ siteId, corpusVersion: 'test', releaseId })
        .returning({ id: audits.id });
      const [result] = await db
        .insert(probeResults)
        .values({
          auditId: audit!.id,
          probeId: 'alpha',
          scope: 'site',
          outcome: 'pass',
          summary: 'alpha saw nothing wrong',
        })
        .returning({ id: probeResults.id });
      const grade = gradeAudit({
        corpus: CORPUS,
        flags: [],
        implementedDetectors: new Set(['alpha']),
        gradedAt: new Date('2026-09-06T00:00:00Z'),
        evidence: [{
          run: { probeId: 'alpha', scope: 'site', observation: { outcome: 'pass', summary: 'ok' } },
          resultId: result!.id,
        }],
      });
      return { auditId: audit!.id, grade };
    };

    it('freezes READY FOR CUTOVER and GO when the gate has current evidence', async () => {
      const releaseId = await saveRelease(db, siteId, RELEASE);
      const { auditId, grade } = await auditFor(releaseId);
      // A machine-verified pass is current only against a run that cites the
      // verdict it passed on — the grader's summary is the state's evidence.
      const evidence = grade.checks[0]!.summary;
      await recordReviewRun(db, { siteId, corpus: CORPUS, run: run({ evidence }) });

      const recorded = await recordGrade(db, { auditId, corpus: CORPUS, grade });
      expect(recorded.frozen.cutover).toMatchObject({
        cutover: READY_FOR_CUTOVER,
        final: 'GO',
        blockers: [],
      });

      const [audit] = await db.select().from(audits).where(eq(audits.id, auditId));
      expect(audit?.readiness).toMatchObject({ cutover: { final: 'GO' } });
    });

    it('keeps a run citing the evidence reference current through a re-grade that rewords the summary', async () => {
      const releaseId = await saveRelease(db, siteId, RELEASE);
      const { auditId, grade } = await auditFor(releaseId);
      await recordReviewRun(db, {
        siteId,
        corpus: CORPUS,
        run: run({ evidence: evidenceReference(auditId, '1.1') }),
      });

      // A newer engine re-grading the stored audit words its verdict differently.
      const regrade = {
        ...grade,
        checks: grade.checks.map((graded) => ({ ...graded, summary: 'worded by a newer engine' })),
      };
      const recorded = await recordGrade(db, { auditId, corpus: CORPUS, grade: regrade });
      expect(recorded.frozen.cutover).toMatchObject({ final: 'GO', blockers: [] });
    });

    it('holds when the gate’s latest review was reopened', async () => {
      const releaseId = await saveRelease(db, siteId, RELEASE);
      const { auditId, grade } = await auditFor(releaseId);
      const evidence = grade.checks[0]!.summary;
      await recordReviewRun(db, { siteId, corpus: CORPUS, run: run({ evidence }) });
      await recordReviewRun(db, {
        siteId,
        corpus: CORPUS,
        run: run({
          runId: 'run-2',
          evidence,
          result: 'reopened',
          eventTrigger: 'CDN change',
          testedAt: '2026-09-03T00:00:00.000Z',
          reviewedAt: '2026-09-03T00:00:00.000Z',
        }),
      });

      const recorded = await recordGrade(db, { auditId, corpus: CORPUS, grade });
      expect(recorded.frozen.readiness.decision).toBe('GO');
      expect(recorded.frozen.cutover).toMatchObject({
        cutover: 'HOLD',
        blockers: [{ checkId: '1.1', reviewState: 'reopened' }],
      });
    });

    it('freezes no cutover block for an audit without a release', async () => {
      const { auditId, grade } = await auditFor(null);
      const recorded = await recordGrade(db, { auditId, corpus: CORPUS, grade });
      expect(recorded.frozen.cutover).toBeUndefined();
    });

    it('refuses a release that belongs to another site', async () => {
      const [other] = await db
        .insert(sites)
        .values({ name: 'other', origin: OTHER })
        .returning({ id: sites.id });
      const foreign = await saveRelease(db, other!.id, RELEASE);
      const { auditId, grade } = await auditFor(foreign);
      await expect(
        recordGrade(db, { auditId, corpus: CORPUS, grade }),
      ).rejects.toBeInstanceOf(ReleaseSiteMismatchError);
    });
  });
});
