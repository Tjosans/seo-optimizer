/**
 * Check attestation: `POST /audits/:id/attestations`.
 *
 * Validation is proved once through `parseAttestationInput` (`attestations.ts`)
 * and `recordAttestation` (@seo/grader); reproved here only for what changes
 * at the HTTP boundary — status codes, and that the corpus checked against is
 * the one the audit itself is pinned to.
 *
 * Skips unless DATABASE_URL is set (`npm run stack:up`).
 */

import type { AddressInfo } from 'node:net';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { Check, Corpus } from '@seo/core';
import { audits, checkStates, createDatabase, sites } from '@seo/db';
import { createServer } from '../src/server.js';

const ORIGIN = 'https://api-attestations-test.example';

function check(id: string): Check {
  return {
    id,
    phase: 1,
    phaseLabel: '1 — Day 1 architecture',
    priority: 'P0',
    profile: 'core',
    launchGate: false,
    applicability: { universal: true, any: [], source: 'All sites' },
    task: 'a task',
    whatToDo: 'do the thing',
    doneWhen: 'a person says so',
    owners: ['developer'],
    ownerSource: 'Developer',
    tools: '',
    cadence: { triggers: [], source: '' },
    notes: '',
    automation: 'attested',
    remediationClass: 'code',
    detectors: [],
    sources: [],
  };
}

const CORPUS: Corpus = { version: 'test', reviewed: '2026-09-17', checks: [check('9.1')] };

const url = process.env['DATABASE_URL'];

describe.skipIf(!url)('check attestation', () => {
  const handle = createDatabase(url ?? '', { max: 4 });
  const { db } = handle;
  const server = createServer({ db, loadCorpus: () => CORPUS });
  let base: string;
  let auditId: string;

  const req = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
  const attest = (id: string, body: unknown) =>
    req(`/audits/${id}/attestations`, { method: 'POST', body: JSON.stringify(body) });

  const future = new Date(Date.now() + 86_400_000).toISOString();

  beforeEach(async () => {
    if (!server.listening) await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await db.delete(sites).where(sql`${sites.origin} = ${ORIGIN}`);
    const [site] = await db.insert(sites).values({ name: 'attestation fixture', origin: ORIGIN }).returning({ id: sites.id });
    const [audit] = await db
      .insert(audits)
      .values({ siteId: site!.id, corpusVersion: 'test' })
      .returning({ id: audits.id });
    auditId = audit!.id;
  });

  afterAll(async () => {
    await db.delete(sites).where(sql`${sites.origin} = ${ORIGIN}`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await handle.close();
  });

  it('records an attestation, 201, and writes the check state', async () => {
    const res = await attest(auditId, {
      checkId: '9.1',
      attestedBy: 'a.reviewer@example.com',
      statement: 'confirmed by hand against the staging environment',
      expiresAt: future,
      status: 'passed',
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.attestation).toMatchObject({ auditId, checkId: '9.1', attestedBy: 'a.reviewer@example.com' });
    expect(body.checkState).toMatchObject({
      auditId,
      checkId: '9.1',
      applicability: 'yes',
      status: 'passed',
      coverage: 'attested',
      evidence: 'confirmed by hand against the staging environment',
    });

    const [row] = await db.select().from(checkStates).where(eq(checkStates.auditId, auditId));
    expect(row?.coverage).toBe('attested');
    expect(row?.evidenceRef ?? null).toBeNull();
  });

  it('replaces a prior attestation on the same check', async () => {
    await attest(auditId, {
      checkId: '9.1',
      attestedBy: 'first.reviewer@example.com',
      statement: 'first pass',
      expiresAt: future,
      status: 'passed',
    });
    const res = await attest(auditId, {
      checkId: '9.1',
      attestedBy: 'second.reviewer@example.com',
      statement: 'corrected after a second look',
      expiresAt: future,
      status: 'failed',
    });
    expect(res.status).toBe(201);

    const rows = await db.select().from(checkStates).where(eq(checkStates.auditId, auditId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'failed', evidence: 'corrected after a second look' });
  });

  it('narrows applicability to no with a rationale', async () => {
    const res = await attest(auditId, {
      checkId: '9.1',
      attestedBy: 'a.reviewer@example.com',
      statement: 'out of scope for this launch',
      expiresAt: future,
      status: 'skipped',
      applicability: 'no',
      applicabilityRationale: 'no gated content on this site',
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.checkState).toMatchObject({
      applicability: 'no',
      applicabilityRationale: 'no gated content on this site',
    });
  });

  it('refuses applicability no with no rationale, 400', async () => {
    const res = await attest(auditId, {
      checkId: '9.1',
      attestedBy: 'a.reviewer@example.com',
      statement: 'out of scope',
      expiresAt: future,
      status: 'skipped',
      applicability: 'no',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      problems: ['applicabilityRationale: required when applicability is "no"'],
    });
  });

  it('refuses an expiry in the past, 400', async () => {
    const res = await attest(auditId, {
      checkId: '9.1',
      attestedBy: 'a.reviewer@example.com',
      statement: 'stale',
      expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
      status: 'passed',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ problems: ['expiresAt: must be in the future'] });
  });

  it('refuses a check id the pinned corpus does not hold, 400', async () => {
    const res = await attest(auditId, {
      checkId: '99.9',
      attestedBy: 'a.reviewer@example.com',
      statement: 'no such check',
      expiresAt: future,
      status: 'passed',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no check 99\.9/);
  });

  it('refuses missing required fields, 400 naming all', async () => {
    const res = await attest(auditId, {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'invalid attestation',
      problems: [
        'checkId: required',
        'attestedBy: required',
        'statement: required',
        'expiresAt: required',
        'status: required',
      ],
    });
  });

  it('refuses an unknown field, 400', async () => {
    const res = await attest(auditId, {
      checkId: '9.1',
      attestedBy: 'a.reviewer@example.com',
      statement: 'ok',
      expiresAt: future,
      status: 'passed',
      nope: true,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ problems: ['nope: unknown field'] });
  });

  it('404s on an unknown audit id', async () => {
    const res = await attest('00000000-0000-0000-0000-000000000000', {
      checkId: '9.1',
      attestedBy: 'a.reviewer@example.com',
      statement: 'ok',
      expiresAt: future,
      status: 'passed',
    });
    expect(res.status).toBe(404);
  });

  it('400s on an invalid audit id', async () => {
    const res = await attest('not-a-uuid', {
      checkId: '9.1',
      attestedBy: 'a.reviewer@example.com',
      statement: 'ok',
      expiresAt: future,
      status: 'passed',
    });
    expect(res.status).toBe(400);
  });

  it('400s on a body that is not JSON', async () => {
    const res = await req(`/audits/${auditId}/attestations`, { method: 'POST', body: 'not json' });
    expect(res.status).toBe(400);
  });
});
