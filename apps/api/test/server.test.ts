/**
 * The `POST /releases` endpoint, proved against the same rules
 * `packages/grader/test/release-file.test.ts` proves for the file importer —
 * this is the other door onto `importReleaseFile`, not a second rulebook.
 *
 * Skips unless DATABASE_URL is set (`npm run stack:up`).
 */

import type { AddressInfo } from 'node:net';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { Check, Corpus } from '@seo/core';
import { createDatabase, reviewRuns, sites } from '@seo/db';
import { createServer } from '../src/server.js';

const ORIGIN = 'https://api-test.example';

const run = (over: Record<string, unknown> = {}) => ({
  runId: 'run-1',
  checkId: '1.1',
  releaseId: 'r1',
  scopeRevision: 's1',
  criteriaRevision: 'test',
  origin: ORIGIN,
  environment: 'pre-production',
  testedAt: '2026-09-02T00:00:00Z',
  tester: 'Tess',
  result: 'passed',
  evidence: 'EV-1',
  reviewedBy: 'Rex',
  reviewedAt: '2026-09-02T01:00:00Z',
  nextReviewAt: '2027-01-01T00:00:00Z',
  ...over,
});

const CORPUS: Corpus = {
  version: 'test',
  reviewed: '2026-09-17',
  checks: [{ id: '1.1' } as Check],
};

const url = process.env['DATABASE_URL'];

describe.skipIf(!url)('POST /releases', () => {
  const handle = createDatabase(url ?? '', { max: 4 });
  const { db } = handle;
  const server = createServer({ db, loadCorpus: () => CORPUS });
  let base: string;
  let siteId: string;

  const logged = () => db.select().from(reviewRuns).where(eq(reviewRuns.siteId, siteId));

  const post = (body: unknown, query = '') =>
    fetch(`${base}/releases${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    if (!server.listening) {
      await new Promise<void>((resolve) => server.listen(0, resolve));
    }
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;

    await db.delete(sites).where(sql`${sites.origin} = ${ORIGIN}`);
    const [site] = await db
      .insert(sites)
      .values({ name: 'api fixture', origin: ORIGIN })
      .returning({ id: sites.id });
    siteId = site!.id;
  });

  afterAll(async () => {
    await db.delete(sites).where(sql`${sites.origin} = ${ORIGIN}`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await handle.close();
  });

  it('saves the release and appends the runs, 201 with the import result', async () => {
    const res = await post({ site: ORIGIN, release: { releaseId: 'r1' }, reviews: [run()] });
    expect(res.status).toBe(201);
    const result = await res.json();
    expect(result).toMatchObject({ siteId, recorded: ['run-1'], unchanged: [], dryRun: false });
    expect(await logged()).toHaveLength(1);
  });

  it('refuses what parseReleaseFile refuses, 400 naming every problem', async () => {
    const res = await post({ release: {} });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'invalid release file',
      problems: [
        'file.site: required: the site’s origin',
        'release.releaseId: required: the name the release is saved under',
      ],
    });
  });

  it('refuses a run the assessment would count as an input error, 400', async () => {
    const res = await post({ site: ORIGIN, reviews: [run({ checkId: '9.9' })] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'invalid release file',
      problems: ['reviews[0] (run-1): unknown check 9.9'],
    });
    expect(await logged()).toHaveLength(0);
  });

  it('refuses a site that is not on record, 404', async () => {
    const res = await post({ site: 'https://nobody-here.example', reviews: [run()] });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('nobody-here.example') });
  });

  it('refuses a run logged differently, 409, and writes nothing else', async () => {
    await post({ site: ORIGIN, reviews: [run()] });
    const res = await post({ site: ORIGIN, release: { releaseId: 'r1' }, reviews: [run({ result: 'failed' })] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ runIds: ['run-1'] });
    expect(await logged()).toHaveLength(1);
  });

  it('writes nothing on a dry run and says so with 200', async () => {
    const res = await post({ site: ORIGIN, release: { releaseId: 'r1' }, reviews: [run()] }, '?dryRun=true');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dryRun: true, recorded: ['run-1'] });
    expect(await logged()).toHaveLength(0);
  });

  it('404s on an unknown route', async () => {
    const res = await fetch(`${base}/nope`, { method: 'GET' });
    expect(res.status).toBe(404);
  });

  it('400s on a body that is not JSON', async () => {
    const res = await fetch(`${base}/releases`, { method: 'POST', body: 'not json' });
    expect(res.status).toBe(400);
  });
});
