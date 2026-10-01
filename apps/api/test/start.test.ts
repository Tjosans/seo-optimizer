/**
 * `startApi` is what both `npm run serve` and the desktop app run, so it is
 * proved here as a whole: migrations applied from the directory it is given,
 * bound to the host it is given on a port it picked, answering, and closed.
 *
 * Skips unless DATABASE_URL is set (`npm run stack:up`).
 */

import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { audits, crawls, createDatabase, pages, renders, sites } from '@seo/db';
import { CURRENT_CORPUS_VERSION, loadCorpus } from '@seo/corpus';
import { PostgresJobStore } from '@seo/job-store';
import { AuditScheduler, ORPHANED_AUDIT_ERROR } from '@seo/scheduler';
import type { AuditJob } from '@seo/scheduler';
import type { BlobStore } from '@seo/storage';
import { startFixtureSite } from '@seo/testkit';
import { CRAWL_BUDGET, probeDatabase, startApi } from '../src/start.js';

const url = process.env['DATABASE_URL'];
const corpusDir = fileURLToPath(new URL('../../../corpus', import.meta.url));
const migrationsDir = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));

describe.skipIf(!url)('startApi', () => {
  it('migrates, listens on the loopback port it picked, answers, and closes', async () => {
    const api = await startApi({ databaseUrl: url!, corpusDir, migrationsDir, host: '127.0.0.1', port: 0 });
    try {
      expect(api.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(new URL(api.url).port).not.toBe('0');
      const res = await fetch(`${api.url}/sites`);
      expect(res.status).toBe(200);
      expect(await res.json()).toHaveProperty('sites');
    } finally {
      await api.close();
    }
    expect(api.server.listening).toBe(false);
  });

  it('uploads every HTML body an audit crawls to the blob store it is given', async () => {
    const stored = new Map<string, Uint8Array>();
    const blobStore = {
      put: async (bytes: Uint8Array) => {
        const key = `test/${createHash('sha256').update(bytes).digest('hex')}`;
        stored.set(key, bytes);
        return key;
      },
      get: async (key: string) => stored.get(key) ?? null,
    } as BlobStore;

    const site = await startFixtureSite();
    const api = await startApi({ databaseUrl: url!, corpusDir, host: '127.0.0.1', port: 0, blobStore });
    const handle = createDatabase(url!, { max: 1, onnotice: () => {} });
    const post = (path: string, body: unknown) =>
      fetch(`${api.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    let siteId: string | undefined;
    try {
      const created = await post('/sites', { name: 'blob store fixture', origin: site.origin });
      expect(created.status).toBe(201);
      siteId = ((await created.json()) as { id: string }).id;

      const submitted = await post('/audits', {
        siteId,
        corpusVersion: CURRENT_CORPUS_VERSION,
        crawl: { requestDelayMs: 0, maxPages: 10 },
      });
      expect(submitted.status).toBe(202);
      const auditId = ((await submitted.json()) as { auditId: string }).auditId;

      await expect
        .poll(async () => (await handle.db.select().from(audits).where(eq(audits.id, auditId)))[0]?.status, {
          timeout: 60_000,
          interval: 250,
        })
        .toBe('complete');

      const rows = await handle.db
        .select({ bodyKey: renders.bodyKey, bodyHash: renders.bodyHash })
        .from(renders)
        .innerJoin(pages, eq(renders.pageId, pages.id))
        .innerJoin(crawls, eq(pages.crawlId, crawls.id))
        .where(eq(crawls.auditId, auditId));
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.bodyKey).not.toBeNull();
        expect(stored.has(row.bodyKey!)).toBe(true);
      }
    } finally {
      if (siteId !== undefined) await fetch(`${api.url}/sites/${siteId}`, { method: 'DELETE' });
      await handle.close();
      await api.close();
      await site.close();
    }
  }, 90_000);

  it('closes out audits an earlier process left open when asked to, and leaves one another queue holds', async () => {
    const handle = createDatabase(url!, { max: 2, onnotice: () => {} });
    const { db } = handle;
    const [site] = await db
      .insert(sites)
      .values({ name: 'startup sweep fixture', origin: `https://sweep-${randomUUID()}.test` })
      .returning({ id: sites.id });
    const siteId = site!.id;
    // What `npm run serve` leaves when it is killed: a row it never started
    // and one it was half way through, written down nowhere else.
    const [pending] = await db
      .insert(audits)
      .values({ siteId, corpusVersion: CURRENT_CORPUS_VERSION })
      .returning({ id: audits.id });
    const [running] = await db
      .insert(audits)
      .values({ siteId, corpusVersion: CURRENT_CORPUS_VERSION, status: 'running', startedAt: new Date() })
      .returning({ id: audits.id });
    // And what the desktop app holds against the same database: a job in the
    // `jobs` table, which is somebody's promise to run it.
    const holder = new AuditScheduler({
      db,
      crawl: CRAWL_BUDGET,
      corpus: (version) => loadCorpus(join(corpusDir, `v${version}`)),
      store: new PostgresJobStore<AuditJob>({ db, queue: 'audits', owner: 'start-test' }),
      paused: true,
    });
    const statusOf = async (id: string) =>
      (await db.select({ status: audits.status, error: audits.error }).from(audits).where(eq(audits.id, id)))[0];

    let api: Awaited<ReturnType<typeof startApi>> | undefined;
    try {
      const held = await holder.submit({ siteId, corpusVersion: CURRENT_CORPUS_VERSION });

      // Scoped to this test's own site: `audits` is shared with every test
      // file running beside this one.
      api = await startApi({ databaseUrl: url!, corpusDir, host: '127.0.0.1', port: 0, reconcile: { siteIds: [siteId] } });
      await api.recovered;

      expect(await statusOf(pending!.id)).toEqual({ status: 'failed', error: ORPHANED_AUDIT_ERROR });
      expect(await statusOf(running!.id)).toEqual({ status: 'failed', error: ORPHANED_AUDIT_ERROR });
      expect((await statusOf(held.auditId))?.status).toBe('pending');

      // The dashboard reads it through the API, and stops polling on `failed`.
      const res = await fetch(`${api.url}/audits/${running!.id}`);
      expect(((await res.json()) as { status: string }).status).toBe('failed');
    } finally {
      await api?.close();
      await holder.close();
      await db.delete(sites).where(eq(sites.id, siteId));
      await handle.close();
    }
  });

  it('leaves open audits as it found them when not asked to sweep', async () => {
    const handle = createDatabase(url!, { max: 1, onnotice: () => {} });
    const { db } = handle;
    const [site] = await db
      .insert(sites)
      .values({ name: 'no sweep fixture', origin: `https://no-sweep-${randomUUID()}.test` })
      .returning({ id: sites.id });
    const [pending] = await db
      .insert(audits)
      .values({ siteId: site!.id, corpusVersion: CURRENT_CORPUS_VERSION })
      .returning({ id: audits.id });
    const api = await startApi({ databaseUrl: url!, corpusDir, host: '127.0.0.1', port: 0 });
    try {
      await api.recovered;
      const [row] = await db.select({ status: audits.status }).from(audits).where(eq(audits.id, pending!.id));
      expect(row?.status).toBe('pending');
    } finally {
      await api.close();
      await db.delete(sites).where(eq(sites.id, site!.id));
      await handle.close();
    }
  });

  it('rejects when the database cannot be reached', async () => {
    await expect(
      startApi({ databaseUrl: 'postgres://nobody:nothing@127.0.0.1:1/none', corpusDir, migrationsDir, port: 0 }),
    ).rejects.toThrow();
  });
});

describe('probeDatabase', () => {
  it.skipIf(!url)('resolves when the database answers', async () => {
    await expect(probeDatabase(url!)).resolves.toBeUndefined();
  });

  it('rejects, without a database, when nothing listens there', async () => {
    await expect(probeDatabase('postgres://nobody:nothing@127.0.0.1:1/none', 2)).rejects.toThrow();
  });

  it.skipIf(!url)('rejects a wrong password with what the server said', async () => {
    const wrong = new URL(url!);
    wrong.password = 'definitely-not-the-password';
    await expect(probeDatabase(wrong.toString())).rejects.toThrow(/password/i);
  });
});
