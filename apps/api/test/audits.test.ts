/**
 * Audit lifecycle: `POST /audits`, `GET /audits/:id`, `GET /audits/:id/result`.
 *
 * `POST /audits` is the same door `AuditScheduler.submit` already opens
 * (proved in `packages/scheduler/test/scheduler.test.ts`) — this only proves
 * the HTTP boundary: status codes, validation (`audits.ts`), and that a real
 * submission runs the real scheduler underneath.
 *
 * Skips unless DATABASE_URL is set (`npm run stack:up`).
 */

import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Corpus } from '@seo/core';
import { createDatabase, sites } from '@seo/db';
import { loadCorpus } from '@seo/corpus';
import { AuditScheduler, PermanentAuditError } from '@seo/scheduler';
import type { CrawlBudget } from '@seo/scheduler';
import { startFixtureSite } from '@seo/testkit';
import type { FixtureSite } from '@seo/testkit';
import { createServer } from '../src/server.js';

const ORIGIN = 'https://api-audits-test.example';

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

describe.skipIf(!url)('audit lifecycle', () => {
  const handle = createDatabase(url ?? '', { max: 4 });
  const { db } = handle;
  const scheduler = new AuditScheduler({ db, corpus: realCorpusSource, crawl: BUDGET, paused: true });
  const server = createServer({ db, loadCorpus: () => CORPUS, scheduler });
  const noSchedulerServer = createServer({ db, loadCorpus: () => CORPUS });
  let base: string;
  let noSchedulerBase: string;
  let fixture: FixtureSite;
  let siteId: string;

  const req = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
  const post = (body: unknown) => req('/audits', { method: 'POST', body: JSON.stringify(body) });

  beforeAll(async () => {
    fixture = await startFixtureSite();
  }, 30_000);

  afterAll(async () => {
    await fixture.close();
    await scheduler.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => noSchedulerServer.close(() => resolve()));
    await db.delete(sites).where(sql`${sites.origin} IN (${ORIGIN}, ${fixture.origin})`);
    await handle.close();
  });

  beforeEach(async () => {
    if (!server.listening) await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (!noSchedulerServer.listening) {
      await new Promise<void>((resolve) => noSchedulerServer.listen(0, resolve));
    }
    noSchedulerBase = `http://127.0.0.1:${(noSchedulerServer.address() as AddressInfo).port}`;

    await db.delete(sites).where(sql`${sites.origin} IN (${ORIGIN}, ${fixture.origin})`);
    const [site] = await db
      .insert(sites)
      .values({ name: 'api audits fixture', origin: fixture.origin, flags: ['hierarchical'], profileCorpusVersion: '4.4' })
      .returning({ id: sites.id });
    siteId = site!.id;
  });

  it('submits an audit and hands back an id before the crawl runs, 202', async () => {
    const res = await post({ siteId, corpusVersion: '4.4' });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'pending' });
    expect(body.auditId).toMatch(/^[0-9a-f-]{36}$/);

    const statusRes = await req(`/audits/${body.auditId}`);
    expect(statusRes.status).toBe(200);
    const status = await statusRes.json();
    expect(status).toMatchObject({ id: body.auditId, status: 'pending', corpusVersion: '4.4' });
    expect(status.queue).toMatchObject({ state: 'queued', attempt: 0 });

    // The scheduler stays paused for every test but the last; leaving this
    // job queued would have it compete with that one once resumed.
    await scheduler.cancel(body.auditId);
  });

  it('refuses a missing siteId or corpusVersion, 400 naming both', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'invalid audit',
      problems: ['siteId: required', 'corpusVersion: required'],
    });
  });

  it('refuses an unknown field, 400', async () => {
    const res = await post({ siteId, corpusVersion: '4.4', nope: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ problems: ['nope: unknown field'] });
  });

  it('refuses an unknown crawl override field, 400', async () => {
    const res = await post({ siteId, corpusVersion: '4.4', crawl: { turbo: true } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ problems: ['crawl.turbo: unknown field'] });
  });

  it('refuses an unknown site, 404', async () => {
    const res = await post({ siteId: '00000000-0000-0000-0000-000000000000', corpusVersion: '4.4' });
    expect(res.status).toBe(404);
  });

  it('404s status and result for an unknown audit id', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';
    expect((await req(`/audits/${missing}`)).status).toBe(404);
    expect((await req(`/audits/${missing}/result`)).status).toBe(404);
  });

  it('400s on a body that is not JSON', async () => {
    const res = await req('/audits', { method: 'POST', body: 'not json' });
    expect(res.status).toBe(400);
  });

  it('503s when no scheduler is configured', async () => {
    const res = await fetch(`${noSchedulerBase}/audits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId, corpusVersion: '4.4' }),
    });
    expect(res.status).toBe(503);
  });

  it('runs a real audit end to end and serves its graded result', async () => {
    const res = await post({ siteId, corpusVersion: '4.4', crawl: { maxPages: 5, maxDepth: 1 } });
    expect(res.status).toBe(202);
    const { auditId } = await res.json();

    scheduler.resume();
    await scheduler.drain();

    const resultRes = await req(`/audits/${auditId}/result`);
    expect(resultRes.status).toBe(200);
    const result = await resultRes.json();
    expect(result.auditId).toBe(auditId);
    expect(result.status).toBe('complete');
    expect(result.readiness).toMatchObject({ corpusVersion: '4.4' });
    expect(result.checks.length).toBeGreaterThan(0);

    const statusRes = await req(`/audits/${auditId}`);
    const status = await statusRes.json();
    expect(status.status).toBe('complete');
    expect(status.finishedAt).not.toBeNull();

    scheduler.pause();
  });
});
