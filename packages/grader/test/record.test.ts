/**
 * Recording a grade against a live database.
 *
 * Skipped unless DATABASE_URL is set: `npm run stack:up`, then copy
 * .env.example to .env. What is under test here is everything the pure grader
 * cannot check — that a re-grade retracts what it replaced, that a human
 * sign-off survives one, and that the frozen readiness is the merge of both.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { AutomationTier, Check, Corpus } from '@seo/core';
import {
  audits,
  checkEvidence,
  checkStates,
  createDatabase,
  probeResults,
  sites,
} from '@seo/db';
import { CorpusVersionMismatchError, gradeAudit, recordGrade } from '@seo/grader';
import type { Evidence } from '@seo/grader';
import type { Observation, ProbeRun } from '@seo/probes';

const ORIGIN = 'https://grader-test.example';

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

const CORPUS: Corpus = {
  version: 'test',
  reviewed: '2026-09-04',
  checks: [check({ id: '1.1' }), check({ id: '1.2', detectors: ['beta'] })],
};

const IMPLEMENTED = new Set(['alpha', 'beta']);

const url = process.env['DATABASE_URL'];

describe.skipIf(!url)('recording a grade', () => {
  const handle = createDatabase(url ?? '', { max: 4 });
  const { db } = handle;

  let auditId: string;
  /** probe_results row ids, by detector. */
  let results: Map<string, string>;

  afterAll(async () => {
    await db.delete(sites).where(eq(sites.origin, ORIGIN));
    await handle.close();
  });

  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.origin, ORIGIN));
    const [site] = await db
      .insert(sites)
      .values({ name: 'grader fixture', origin: ORIGIN })
      .returning({ id: sites.id });
    const [audit] = await db
      .insert(audits)
      .values({ siteId: site!.id, corpusVersion: 'test' })
      .returning({ id: audits.id });
    auditId = audit!.id;

    // Site-scoped observations, so no crawl or page rows are needed to hang
    // evidence off: what is under test is the recording, not the crawl.
    const rows = await db
      .insert(probeResults)
      .values(
        ['alpha', 'beta'].map((probeId) => ({
          auditId,
          probeId,
          scope: 'site' as const,
          outcome: 'pass' as const,
          summary: `${probeId} saw nothing wrong`,
        })),
      )
      .returning({ id: probeResults.id, probeId: probeResults.probeId });
    results = new Map(rows.map((row) => [row.probeId, row.id]));
  });

  const evidenceFor = (detector: string, outcome: Observation['outcome']): Evidence => {
    const run: ProbeRun = {
      probeId: detector,
      scope: 'site',
      observation: { outcome, summary: `${detector} ${outcome}` },
    };
    return { run, resultId: results.get(detector) ?? null };
  };

  const grade = (evidence: readonly Evidence[]) =>
    gradeAudit({
      corpus: CORPUS,
      flags: ['hierarchical'],
      evidence,
      implementedDetectors: IMPLEMENTED,
    });

  const statesOf = async () =>
    db.select().from(checkStates).where(eq(checkStates.auditId, auditId));

  const evidenceOf = async (checkId: string) =>
    db
      .select()
      .from(checkEvidence)
      .where(and(eq(checkEvidence.auditId, auditId), eq(checkEvidence.checkId, checkId)));

  it('writes a state per check, links its evidence, and freezes the verdict', async () => {
    const recorded = await recordGrade(db, {
      auditId,
      corpus: CORPUS,
      grade: grade([evidenceFor('alpha', 'pass'), evidenceFor('beta', 'pass')]),
    });

    expect(recorded.written).toBe(2);
    expect(recorded.preserved).toEqual([]);
    expect(recorded.frozen.readiness.decision).toBe('GO');

    const states = await statesOf();
    expect(states).toHaveLength(2);
    expect(states.every((row) => row.status === 'passed')).toBe(true);
    expect(states.every((row) => row.coverage === 'verified')).toBe(true);
    expect(states.every((row) => row.evidence !== null)).toBe(true);

    expect(await evidenceOf('1.1')).toHaveLength(1);

    const [audit] = await db.select().from(audits).where(eq(audits.id, auditId));
    expect(audit?.readiness).toMatchObject({
      corpusVersion: 'test',
      readiness: { decision: 'GO' },
    });
  });

  it('retracts what a previous grade said, evidence links included', async () => {
    await recordGrade(db, {
      auditId,
      corpus: CORPUS,
      grade: grade([evidenceFor('alpha', 'pass'), evidenceFor('beta', 'pass')]),
    });
    // Second pass: beta observed nothing this time, so 1.2 can no longer be
    // graded and must not keep the pass — or the link — it had.
    const recorded = await recordGrade(db, {
      auditId,
      corpus: CORPUS,
      grade: grade([evidenceFor('alpha', 'fail')]),
    });

    expect(recorded.frozen.readiness.decision).toBe('HOLD');

    const states = await statesOf();
    expect(states).toHaveLength(2);
    expect(states.find((row) => row.checkId === '1.1')?.status).toBe('failed');
    expect(states.find((row) => row.checkId === '1.2')?.status).toBe('not-started');
    expect(await evidenceOf('1.2')).toHaveLength(0);
  });

  it('leaves a human attestation alone and counts it in the frozen readiness', async () => {
    await db.insert(checkStates).values({
      auditId,
      checkId: '1.2',
      applicability: 'yes',
      status: 'passed',
      coverage: 'attested',
      evidence: 'signed off by the release manager',
      attestationExpiresAt: new Date(Date.now() + 86_400_000),
    });

    // The grader would say 1.2 is ungraded: nothing observed beta.
    const recorded = await recordGrade(db, {
      auditId,
      corpus: CORPUS,
      grade: grade([evidenceFor('alpha', 'pass')]),
    });

    expect(recorded.preserved).toEqual(['1.2']);
    expect(recorded.written).toBe(1);

    const states = await statesOf();
    const attested = states.find((row) => row.checkId === '1.2');
    expect(attested?.coverage).toBe('attested');
    expect(attested?.evidence).toBe('signed off by the release manager');
    // Both gates are cleared — one by the engine, one by a person — so the
    // merged verdict has to be GO.
    expect(recorded.frozen.readiness.decision).toBe('GO');
  });

  it('refuses to record a grade reached against another corpus version', async () => {
    await expect(
      recordGrade(db, {
        auditId,
        corpus: { ...CORPUS, version: '4.4' },
        grade: grade([evidenceFor('alpha', 'pass')]),
      }),
    ).rejects.toBeInstanceOf(CorpusVersionMismatchError);

    expect(await statesOf()).toHaveLength(0);
  });
});
