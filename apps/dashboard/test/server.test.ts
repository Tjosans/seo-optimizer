/**
 * The dashboard server has two jobs, proved here with no real @seo/api or
 * database: serve `public/` as static files, and proxy `/api/*` onto the
 * configured upstream unmodified. A fake upstream stands in for @seo/api,
 * since server.ts only forwards — it has no opinion of its own about what
 * the API answers.
 */

import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));

describe('dashboard server', () => {
  let upstream: Server;
  let upstreamBase: string;
  let lastUpstreamRequest: { method: string; url: string; body: string } | undefined;

  let server: ReturnType<typeof createServer>;
  let base: string;

  beforeAll(async () => {
    upstream = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        lastUpstreamRequest = { method: req.method ?? '', url: req.url ?? '', body: Buffer.concat(chunks).toString() };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ sites: [] }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, resolve));
    upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

    server = createServer({ apiUrl: upstreamBase, publicDir });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it('serves index.html at /', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('seo-optimizer dashboard');
  });

  it('serves a static asset with the right content type', async () => {
    const res = await fetch(`${base}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
  });

  it('404s an unknown path', async () => {
    const res = await fetch(`${base}/nope.html`);
    expect(res.status).toBe(404);
  });

  it('refuses to escape the public directory', async () => {
    // `fetch`/`URL` collapse a leading `..` against the root before the
    // request is even sent, so the traversal attempt has to be crafted at
    // the raw HTTP layer to reach the server's own guard at all.
    const { port } = server.address() as AddressInfo;
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/../package.json' }, (res: IncomingMessage) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect([400, 404]).toContain(status);
  });

  it('proxies GET /api/* to the upstream, passing the response through', async () => {
    const res = await fetch(`${base}/api/sites`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sites: [] });
    expect(lastUpstreamRequest).toMatchObject({ method: 'GET', url: '/sites' });
  });

  it('proxies POST /api/* with the body and content type intact', async () => {
    const res = await fetch(`${base}/api/audits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ siteId: 'x' }),
    });
    expect(res.status).toBe(200);
    expect(lastUpstreamRequest).toMatchObject({ method: 'POST', url: '/audits', body: JSON.stringify({ siteId: 'x' }) });
  });

  it('502s when the upstream is unreachable', async () => {
    const downServer = createServer({ apiUrl: 'http://127.0.0.1:1', publicDir });
    await new Promise<void>((resolve) => downServer.listen(0, resolve));
    const downBase = `http://127.0.0.1:${(downServer.address() as AddressInfo).port}`;
    const res = await fetch(`${downBase}/api/sites`);
    expect(res.status).toBe(502);
    await new Promise<void>((resolve) => downServer.close(() => resolve()));
  });
});
