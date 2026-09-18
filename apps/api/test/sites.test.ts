/**
 * Site management: `POST /sites`, `GET /sites`, `PATCH /sites/:id`,
 * `DELETE /sites/:id`. Validation is proved once through `parseSiteInput`
 * (`sites.ts`) and reproved here only for what changes at the HTTP boundary —
 * status codes, the unique-origin conflict, and 404 on an unknown id.
 *
 * Skips unless DATABASE_URL is set (`npm run stack:up`).
 */

import type { AddressInfo } from 'node:net';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Corpus } from '@seo/core';
import { createDatabase, sites } from '@seo/db';
import { createServer } from '../src/server.js';

const ORIGIN = 'https://api-sites-test.example';
const OTHER_ORIGIN = 'https://api-sites-test-2.example';

const CORPUS: Corpus = { version: 'test', reviewed: '2026-09-17', checks: [] };

const url = process.env['DATABASE_URL'];

describe.skipIf(!url)('site management', () => {
  const handle = createDatabase(url ?? '', { max: 4 });
  const { db } = handle;
  const server = createServer({ db, loadCorpus: () => CORPUS });
  let base: string;

  const req = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init.headers },
    });
  const post = (body: unknown) => req('/sites', { method: 'POST', body: JSON.stringify(body) });
  const patch = (id: string, body: unknown) => req(`/sites/${id}`, { method: 'PATCH', body: JSON.stringify(body) });

  beforeEach(async () => {
    if (!server.listening) {
      await new Promise<void>((resolve) => server.listen(0, resolve));
    }
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;

    await db.delete(sites).where(sql`${sites.origin} IN (${ORIGIN}, ${OTHER_ORIGIN})`);
  });

  afterAll(async () => {
    await db.delete(sites).where(sql`${sites.origin} IN (${ORIGIN}, ${OTHER_ORIGIN})`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await handle.close();
  });

  it('creates a site, 201 with the row', async () => {
    const res = await post({ name: 'API fixture', origin: ORIGIN, flags: ['ecommerce'] });
    expect(res.status).toBe(201);
    const row = await res.json();
    expect(row).toMatchObject({ name: 'API fixture', origin: ORIGIN, flags: ['ecommerce'], profile: 'core' });
    expect(row.id).toEqual(expect.any(String));
  });

  it('trims a trailing slash off origin, matching parseReleaseFile', async () => {
    const res = await post({ name: 'API fixture', origin: `${ORIGIN}/` });
    expect(res.status).toBe(201);
    expect((await res.json()).origin).toBe(ORIGIN);
  });

  it('refuses a missing name or origin, 400 naming both', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'invalid site',
      problems: ['name: required', 'origin: required'],
    });
  });

  it('refuses an unknown field, 400', async () => {
    const res = await post({ name: 'x', origin: ORIGIN, nickname: 'x' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ problems: ['nickname: unknown field'] });
  });

  it('refuses a malformed aiPolicy, 400', async () => {
    const res = await post({ name: 'x', origin: ORIGIN, aiPolicy: { agents: {} } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      problems: ['aiPolicy: ai policy needs an approvedAt date of the form YYYY-MM-DD'],
    });
  });

  it('refuses a second site claiming the same origin, 409', async () => {
    await post({ name: 'first', origin: ORIGIN });
    const res = await post({ name: 'second', origin: ORIGIN });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining(ORIGIN) });
  });

  it('lists sites, including one just created', async () => {
    await post({ name: 'API fixture', origin: ORIGIN });
    const res = await req('/sites');
    expect(res.status).toBe(200);
    const { sites: rows } = await res.json();
    expect(rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ origin: ORIGIN })]),
    );
  });

  it('updates only the fields given, 200 with the row', async () => {
    const created = await (await post({ name: 'before', origin: ORIGIN, flags: ['ecommerce'] })).json();
    const res = await patch(created.id, { name: 'after' });
    expect(res.status).toBe(200);
    const row = await res.json();
    expect(row).toMatchObject({ id: created.id, name: 'after', origin: ORIGIN, flags: ['ecommerce'] });
  });

  it('clears aiPolicy with an explicit null', async () => {
    const created = await (
      await post({
        name: 'x',
        origin: ORIGIN,
        aiPolicy: { agents: { GPTBot: 'disallow' }, approvedAt: '2026-01-01', approvedBy: 'Rex' },
      })
    ).json();
    const res = await patch(created.id, { aiPolicy: null });
    expect(res.status).toBe(200);
    expect((await res.json()).aiPolicy).toBeNull();
  });

  it('404s updating an unknown id', async () => {
    const res = await patch('00000000-0000-0000-0000-000000000000', { name: 'x' });
    expect(res.status).toBe(404);
  });

  it('400s an update with no fields', async () => {
    const created = await (await post({ name: 'x', origin: ORIGIN })).json();
    const res = await patch(created.id, {});
    expect(res.status).toBe(400);
  });

  it('deletes a site, 204, then 404s on it', async () => {
    const created = await (await post({ name: 'x', origin: ORIGIN })).json();
    const del = await req(`/sites/${created.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    const again = await req(`/sites/${created.id}`, { method: 'DELETE' });
    expect(again.status).toBe(404);
  });
});
