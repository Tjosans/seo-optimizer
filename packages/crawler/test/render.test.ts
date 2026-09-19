/**
 * `renderPage` against a real (headless) browser, because the thing under
 * test is whether client-side script actually ran — a double would only
 * repeat whatever the test told it, the same reasoning `protocol.test.ts`
 * gives for testing its handshake against a real TLS server.
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { extract } from '@seo/crawler';
import { closeBrowser, renderPage } from '@seo/crawler';

let server: Server | null = null;

async function startServer(): Promise<string> {
  server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    if (path === '/redirect') {
      response.writeHead(302, { location: '/' });
      response.end();
      return;
    }
    if (path === '/axe') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Axe</title></head><body><main><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></main></body></html>');
      return;
    }
    if (path === '/subresources') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><head><title>Sub</title><script src="/ok.js"></script><script src="/missing.js"></script></head><body></body></html>');
      return;
    }
    if (path === '/ok.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end('');
      return;
    }
    if (path === '/many') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Many</title></head><body><script>for (let i = 0; i < 520; i++) fetch('/n/' + i).catch(() => {});</script></body></html>`);
      return;
    }
    if (path.startsWith('/n/')) {
      response.writeHead(204);
      response.end();
      return;
    }
    if (path === '/missing.js') {
      response.writeHead(404);
      response.end();
      return;
    }
    if (path === '/slow') {
      // Never responds within renderPage's timeout.
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Static title</title></head>
<body>
<div id="app">loading&hellip;</div>
<script>
  document.getElementById('app').innerHTML = '<h1>Rendered by script</h1><p>Client-side content.</p>';
</script>
</body>
</html>`);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server!.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

// Shutting Chromium down overruns the 10 s default hook timeout when the
// full suite has every core busy, though it takes a moment on its own.
afterAll(async () => {
  await closeBrowser();
}, 60_000);

describe('renderPage', () => {
  it('returns the DOM after client-side script has run, not the server-sent bytes', async () => {
    const origin = await startServer();
    const result = await renderPage(origin, { userAgent: 'seo-optimizer/0.1 (+test)' });
    expect(result.error).toBeNull();
    expect(result.status).toBe(200);
    expect(result.finalUrl).toBe(`${origin}/`);
    expect(result.html).toContain('Rendered by script');
    expect(result.html).not.toContain('loading&hellip;');
  }, 30_000);

  it('extracts from a render exactly like a raw fetch', async () => {
    const origin = await startServer();
    const result = await renderPage(origin, { userAgent: 'seo-optimizer/0.1 (+test)' });
    const extracted = extract(result.html, result.finalUrl);
    expect(extracted.title).toBe('Static title');
    expect(extracted.headings).toEqual([{ level: 1, text: 'Rendered by script' }]);
  }, 30_000);

  it('follows a client-observed redirect and reports where it landed', async () => {
    const origin = await startServer();
    const result = await renderPage(`${origin}/redirect`, { userAgent: 'seo-optimizer/0.1 (+test)' });
    expect(result.error).toBeNull();
    expect(result.finalUrl).toBe(`${origin}/`);
  }, 30_000);

  it('returns a navigation timeout as data, not a thrown error', async () => {
    const origin = await startServer();
    const result = await renderPage(`${origin}/slow`, {
      userAgent: 'seo-optimizer/0.1 (+test)',
      timeoutMs: 500,
    });
    expect(result.error).not.toBeNull();
    expect(result.html).toBe('');
  }, 30_000);

  it('declines to render once its signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await renderPage('http://127.0.0.1:1/', {
      userAgent: 'seo-optimizer/0.1 (+test)',
      signal: controller.signal,
    });
    expect(result.error).toBe('cancelled');
  });

  it('records each request the page made with its status', async () => {
    const origin = await startServer();
    const result = await renderPage(`${origin}/subresources`, { userAgent: 'seo-optimizer/0.1 (+test)' });
    expect(result.requestsTruncated).toBe(false);
    const byPath = new Map((result.requests ?? []).map((r) => [new URL(r.url).pathname, r]));
    expect(byPath.get('/subresources')).toMatchObject({ method: 'GET', resourceType: 'document', status: 200, failed: false });
    expect(byPath.get('/ok.js')).toMatchObject({ resourceType: 'script', status: 200 });
    expect(byPath.get('/missing.js')).toMatchObject({ resourceType: 'script', status: 404 });
  }, 30_000);

  it('caps a page at 500 requests and says it did', async () => {
    const origin = await startServer();
    const result = await renderPage(`${origin}/many`, { userAgent: 'seo-optimizer/0.1 (+test)' });
    expect(result.requests).toHaveLength(500);
    expect(result.requestsTruncated).toBe(true);
  }, 30_000);

  it('records axe-core violations only when asked', async () => {
    const origin = await startServer();
    const plain = await renderPage(`${origin}/axe`, { userAgent: 'seo-optimizer/0.1 (+test)' });
    expect(plain.accessibility).toBeUndefined();

    const audited = await renderPage(`${origin}/axe`, {
      userAgent: 'seo-optimizer/0.1 (+test)',
      accessibility: true,
    });
    expect(audited.error).toBeNull();
    expect(audited.accessibility?.error).toBeNull();
    const imageAlt = audited.accessibility?.violations.find((v) => v.id === 'image-alt');
    expect(imageAlt).toMatchObject({ impact: 'critical', nodes: 1 });
  }, 60_000);
});
