/**
 * A site's audit history: `GET /sites/:id/audits`. Rows are inserted directly
 * rather than run through a real crawl — `audits.test.ts` already proves the
 * scheduler wires a row correctly; this only proves the HTTP boundary orders
 * and shapes what a dashboard walks back through for a trend view.
 *
 * Skips unless DATABASE_URL is set (`npm run stack:up`).
 */

import type { AddressInfo } from 'node:net';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Corpus } from '@seo/core';
import { audits, createDatabase, sites } from '@seo/db';
import { createServer } from '../src/server.js';

const ORIGIN = 'https://api-site-audits-test.example';

const CORPUS: Corpus = { version: 'test', reviewed: '2026-09-17', checks: [] };

const url = process.env['DATABASE_URL'];

describe.skipIf(!url)('site audit history', () => {
  const handle = createDatabase(url ?? '', { max: 4 });
  const { db } = handle;
  const server = createServer({ db, loadCorpus: () => CORPUS });
  let base: string;
  let siteId: string;

  const req = (path: string) => fetch(`${base}${path}`);

  beforeEach(async () => {
    if (!server.listening) {
      await new Promise<void>((resolve) => server.listen(0, resolve));
    }
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;

    await db.delete(sites).where(sql`${sites.origin} = ${ORIGIN}`);
    const [site] = await db.insert(sites).values({ name: 'Site audits fixture', origin: ORIGIN }).returning();
    siteId = site!.id;
  });

  afterAll(async () => {
    await db.delete(sites).where(sql`${sites.origin} = ${ORIGIN}`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await handle.close();
  });

  it('lists a site’s audits newest first, with no checks join', async () => {
    const [older] = await db
      .insert(audits)
      .values({ siteId, corpusVersion: '5.0', status: 'complete' })
      .returning();
    const [newer] = await db
      .insert(audits)
      .values({ siteId, corpusVersion: '5.0', status: 'complete', readiness: { launchDecision: 'go' } })
      .returning();

    const res = await req(`/sites/${siteId}/audits`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.audits.map((a: { id: string }) => a.id)).toEqual([newer!.id, older!.id]);
    expect(body.audits[0]).toMatchObject({ status: 'complete', readiness: { launchDecision: 'go' } });
    expect(body.audits[0].checks).toBeUndefined();
  });

  it('returns an empty list for a site with no audits', async () => {
    const res = await req(`/sites/${siteId}/audits`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.audits).toEqual([]);
  });

  it('400s on a malformed site id', async () => {
    const res = await req('/sites/not-a-uuid/audits');
    expect(res.status).toBe(400);
  });
});
