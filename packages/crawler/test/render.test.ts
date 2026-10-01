/**
 * `renderPage` against a real (headless) browser, because the thing under
 * test is whether client-side script actually ran — a double would only
 * repeat whatever the test told it, the same reasoning `protocol.test.ts`
 * gives for testing its handshake against a real TLS server.
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crc32, deflateSync } from 'node:zlib';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { extract } from '@seo/crawler';
import { MOBILE_VIEWPORT, closeBrowser, renderPage } from '@seo/crawler';

let server: Server | null = null;

/**
 * A 64x64 PNG of noise. Chromium leaves an image of under 0.05 bits a pixel
 * out of largest-contentful-paint as a placeholder, so a flat colour stretched
 * across the page would never be a candidate.
 */
function noisePng(): Buffer {
  const size = 64;
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc(size * (1 + size * 3));
  let seed = 1;
  for (let i = 0; i < rows.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    rows[i] = i % (1 + size * 3) === 0 ? 0 : seed >> 16 & 0xff;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

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
    if (path === '/device') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><head><title>Device</title><meta name="viewport" content="width=device-width"></head><body><script>document.body.textContent = [innerWidth, navigator.userAgent, matchMedia("(pointer: coarse)").matches].join("|");</script></body></html>');
      return;
    }
    if (path === '/lazy') {
      // A footer mounted only once it scrolls into view, as kjell.com's is.
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><head><title>Lazy</title></head><body>' +
        '<div style="height:3000px">Top</div><footer id="f"></footer><script>' +
        'new IntersectionObserver((entries, observer) => { if (entries.some((e) => e.isIntersecting)) {' +
        ' document.getElementById("f").innerHTML = `<a href="/customer-service">Customer service</a>`; observer.disconnect(); } })' +
        '.observe(document.getElementById("f"));</script></body></html>');
      return;
    }
    if (path === '/noise.png') {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(noisePng());
      return;
    }
    if (path === '/lcp') {
      // kjell.com's shape: a small icon first in the source, the banner after it.
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><head><title>LCP</title></head><body>' +
        '<img src="/noise.png?icon" width="24" height="24" alt="">' +
        '<img src="/noise.png?banner" width="600" height="400" loading="lazy" alt="Banner">' +
        '</body></html>');
      return;
    }
    if (path === '/lcp-text') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><head><title>LCP</title></head><body>' +
        '<img src="/noise.png?icon" width="24" height="24" loading="lazy" alt="">' +
        '<h1 style="font-size:80px">A headline far larger than the icon above it</h1></body></html>');
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

  it('renders as a phone when asked, and as a desktop otherwise', async () => {
    const origin = await startServer();
    const ua = 'seo-optimizer/0.1 (+test)';
    const phone = await renderPage(`${origin}/device`, { userAgent: ua, mobile: true });
    const [width, agent, coarse] = extract(phone.html, phone.finalUrl).text.split('|');
    expect(Number(width)).toBe(MOBILE_VIEWPORT.width);
    expect(agent).toContain('Mobile Safari');
    expect(agent).toContain(ua);
    expect(coarse).toBe('true');

    const desktop = await renderPage(`${origin}/device`, { userAgent: ua });
    const [deskWidth, deskAgent] = extract(desktop.html, desktop.finalUrl).text.split('|');
    expect(Number(deskWidth)).toBeGreaterThan(MOBILE_VIEWPORT.width);
    expect(deskAgent).not.toContain('Mobile');
  }, 30_000);

  it('renders what a page mounts once it is in view, as a crawler with a page-tall viewport does', async () => {
    const origin = await startServer();
    const result = await renderPage(`${origin}/lazy`, { userAgent: 'seo-optimizer/0.1 (+test)' });
    expect(result.error).toBeNull();
    // Read as links, not as text: the script that mounts it spells it out too.
    expect(extract(result.html, result.finalUrl).links.map((link) => link.href)).toContain('/customer-service');
  }, 30_000);

  it('names the largest paint the browser saw, not the first image in the source', async () => {
    const origin = await startServer();
    const result = await renderPage(`${origin}/lcp`, { userAgent: 'seo-optimizer/0.1 (+test)' });
    expect(result.error).toBeNull();
    expect(result.largestPaint).toEqual({ element: 'img', url: `${origin}/noise.png?banner`, loading: 'lazy' });
  }, 30_000);

  it('names a text element as the largest paint when no image is larger', async () => {
    const origin = await startServer();
    const result = await renderPage(`${origin}/lcp-text`, { userAgent: 'seo-optimizer/0.1 (+test)' });
    expect(result.largestPaint).toEqual({ element: 'h1', url: null, loading: null });
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

  // iana.org's /domains/idn-tables held a crawl for over half an hour inside
  // axe. A run past its bound is given up on, and the render keeps its HTML.
  it('gives up on an axe-core run past its bound, keeping the render', async () => {
    const origin = await startServer();
    const started = Date.now();
    const result = await renderPage(`${origin}/axe`, {
      userAgent: 'seo-optimizer/0.1 (+test)',
      accessibility: true,
      axeTimeoutMs: 1,
    });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(result.error).toBeNull();
    expect(result.html).toContain('<img');
    expect(result.accessibility).toEqual({ violations: [], error: 'axe-core did not finish within 0s' });
  }, 60_000);
});
