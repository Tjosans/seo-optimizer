/**
 * `GET /audits/:id/checks/:checkId/evidence` — the drill-down from a graded
 * check's `checkStates` row down to the `probe_results` rows behind it,
 * through `check_evidence`.
 *
 * Needs a real graded audit, so this runs the fixture site through a real
 * scheduler the way `audits.test.ts`'s last test does, then picks whichever
 * check the grader actually attached evidence to.
 *
 * Skips unless DATABASE_URL is set (`npm run stack:up`).
 */

import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Corpus } from '@seo/core';
import { checkEvidence, createDatabase, sites } from '@seo/db';
import { loadCorpus } from '@seo/corpus';
import { AuditScheduler, PermanentAuditError } from '@seo/scheduler';
import type { CrawlBudget } from '@seo/scheduler';
import { startFixtureSite } from '@seo/testkit';
import type { FixtureSite } from '@seo/testkit';
import { createServer } from '../src/server.js';

const ORIGIN = 'https://api-check-evidence-test.example';

const CORPUS: Corpus = { version: 'test', reviewed: '2026-09-17', checks: [] };
const REAL_CORPUS = loadCorpus(fileURLToPath(new URL('../../../corpus/v4.4', import.meta.url)));
const realCorpusSource = (version: string) => {
  if (version !== REAL_CORPUS.version) throw new PermanentAuditError(`no corpus ${version} on disk`);
  return REAL_CORPUS;
};

const BUDGET: CrawlBudget = {
  userAgent: 'seo-optimizer/0.1 (+test)',
  maxPages: 10,
  maxDepth: 2,
};

const url = process.env['DATABASE_URL'];

describe.skipIf(!url)('check evidence drill-down', () => {
  const handle = createDatabase(url ?? '', { max: 4 });
  const { db } = handle;
  const scheduler = new AuditScheduler({ db, corpus: realCorpusSource, crawl: BUDGET, paused: true });
  const server = createServer({ db, loadCorpus: () => CORPUS, scheduler });
  let base: string;
  let fixture: FixtureSite;
  let siteId: string;
  let auditId: string;
  let gradedCheckId: string;

  const req = (path: string) => fetch(`${base}${path}`);

  beforeAll(async () => {
    fixture = await startFixtureSite();

    await db.delete(sites).where(sql`${sites.origin} IN (${ORIGIN}, ${fixture.origin})`);
    const [site] = await db
      .insert(sites)
      .values({ name: 'api evidence fixture', origin: fixture.origin, flags: ['hierarchical'], profileCorpusVersion: '4.4' })
      .returning({ id: sites.id });
    siteId = site!.id;

    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const res = await fetch(`${base}/audits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId, corpusVersion: '4.4', crawl: { maxPages: 5, maxDepth: 1 } }),
    });
    expect(res.status).toBe(202);
    ({ auditId } = await res.json());

    scheduler.resume();
    await scheduler.drain();
    scheduler.pause();

    const [row] = await db
      .select({ checkId: checkEvidence.checkId })
      .from(checkEvidence)
      .where(sql`${checkEvidence.auditId} = ${auditId}`)
      .limit(1);
    if (row === undefined) throw new Error('fixture audit produced no check evidence to test against');
    gradedCheckId = row.checkId;
  }, 60_000);

  afterAll(async () => {
    await fixture.close();
    await scheduler.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.delete(sites).where(sql`${sites.origin} IN (${ORIGIN}, ${fixture.origin})`);
    await handle.close();
  });

  it('lists the probe evidence behind a graded check', async () => {
    const res = await req(`/audits/${auditId}/checks/${encodeURIComponent(gradedCheckId)}/evidence`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.auditId).toBe(auditId);
    expect(body.checkId).toBe(gradedCheckId);
    expect(body.evidence.length).toBeGreaterThan(0);
    for (const item of body.evidence) {
      expect(item).toMatchObject({
        probeResultId: expect.any(String),
        probeId: expect.any(String),
        scope: expect.stringMatching(/^(site|page|template)$/),
        outcome: expect.stringMatching(/^(pass|fail|warn|not-applicable|error)$/),
        summary: expect.any(String),
      });
      if (item.page !== null) {
        expect(item.page).toMatchObject({ id: expect.any(String), url: expect.any(String) });
      }
    }
  });

  it('404s a check that was never graded for this audit', async () => {
    const res = await req(`/audits/${auditId}/checks/not-a-real-check/evidence`);
    expect(res.status).toBe(404);
  });

  it('404s an unknown audit id', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';
    const res = await req(`/audits/${missing}/checks/${encodeURIComponent(gradedCheckId)}/evidence`);
    expect(res.status).toBe(404);
  });
});
