import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchPage } from '@seo/crawler';
import { startHttpsServer } from '@seo/testkit';
import type { TlsServer } from '@seo/testkit';

const UA = 'seo-optimizer/0.1 (+test)';
const MB = 1_000_000;

const SITEMAP =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  Array.from({ length: 2_000 }, (_, i) => `<url><loc>https://gz.test/page/${i}</loc></url>\n`).join('') +
  '</urlset>\n';
const GZIPPED = gzipSync(SITEMAP);

/** Twenty megabytes of something, far past the 5 MB a page may be. */
const HUGE = 20 * MB;
const HUGE_HTML = Buffer.from(`<html><body><p>${'a'.repeat(HUGE)}</p></body></html>`);
const HUGE_BINARY = Buffer.alloc(HUGE, 7);

/** Megabytes of whitespace compress to almost nothing and expand to all of it. */
const BOMB = gzipSync(`<urlset>${' '.repeat(HUGE)}</urlset>`);

const send = (response: ServerResponse, headers: Record<string, string>, bytes: Buffer): void => {
  response.writeHead(200, headers);
  // In pieces, as a real server would, so the client reads a stream of chunks.
  for (let i = 0; i < bytes.length; i += 256_000) response.write(bytes.subarray(i, i + 256_000));
  response.end();
};

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    switch (url.pathname) {
      case '/sitemap.xml.gz':
        send(response, { 'content-type': url.searchParams.get('type') ?? 'application/x-gzip' }, GZIPPED);
        return;
      case '/transport.xml':
        // Transport compression: `fetch` undoes it before anything here sees it.
        send(response, { 'content-type': 'application/xml', 'content-encoding': 'gzip' }, GZIPPED);
        return;
      case '/damaged.xml.gz':
        send(response, { 'content-type': 'application/gzip' }, GZIPPED.subarray(0, Math.floor(GZIPPED.length / 2)));
        return;
      case '/bomb.xml.gz':
        send(response, { 'content-type': 'application/gzip' }, BOMB);
        return;
      case '/huge.html':
        send(response, { 'content-type': 'text/html' }, HUGE_HTML);
        return;
      case '/huge.mp4':
        send(response, { 'content-type': 'video/mp4' }, HUGE_BINARY);
        return;
      default:
        response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('a body past the limit', () => {
  // The limit used to be applied after the whole response had been read into
  // memory, which protected the parser and nothing else.
  it('stops a page at the limit rather than downloading it and cutting it', async () => {
    const result = await fetchPage(`${origin}/huge.html`, { userAgent: UA });
    expect(result.truncated).toBe(true);
    expect(result.body.length).toBeLessThanOrEqual(5 * MB);
    expect(result.byteLength).toBeLessThan(6 * MB);
  });

  it('stops a linked binary at the limit too', async () => {
    const result = await fetchPage(`${origin}/huge.mp4`, { userAgent: UA, keepBytes: true });
    expect(result.truncated).toBe(true);
    expect(result.body).toBe('');
    expect(result.bytes).toBeUndefined();
    expect(result.byteLength).toBeLessThan(6 * MB);
  });
});

describe('a sitemap published as a gzip file', () => {
  // The label is whatever the server likes; the first two bytes are not.
  for (const type of ['application/x-gzip', 'application/gzip', 'application/octet-stream', 'text/xml']) {
    it(`is read as the XML inside it when served as ${type}`, async () => {
      let streamed = '';
      const result = await fetchPage(`${origin}/sitemap.xml.gz?type=${encodeURIComponent(type)}`, {
        userAgent: UA,
        gunzip: true,
        onText: (chunk) => { streamed += chunk; },
      });
      expect(result.status).toBe(200);
      expect(result.truncated).toBe(false);
      expect(streamed).toBe(SITEMAP);
      expect(result.byteLength).toBe(Buffer.byteLength(SITEMAP));
    });
  }

  it('is left alone when nobody asked for it to be opened', async () => {
    const result = await fetchPage(`${origin}/sitemap.xml.gz`, { userAgent: UA });
    expect(result.body).toBe('');
    expect(result.byteLength).toBe(GZIPPED.length);
  });

  it('is not opened twice when the server also compressed it in transport', async () => {
    const result = await fetchPage(`${origin}/transport.xml`, { userAgent: UA, gunzip: true });
    expect(result.body).toBe(SITEMAP);
  });

  // The limit is on what the file expands to — the protocol's ceiling is on the
  // uncompressed size — which is also what keeps a small file that inflates
  // without end from being read without end.
  it('is cut at the limit on its expanded size', async () => {
    let streamed = 0;
    const result = await fetchPage(`${origin}/bomb.xml.gz`, {
      userAgent: UA,
      gunzip: true,
      maxBytes: MB,
      onText: (chunk) => { streamed += chunk.length; },
    });
    expect(BOMB.length).toBeLessThan(MB);
    expect(result.truncated).toBe(true);
    expect(streamed).toBeLessThanOrEqual(MB);
  });

  // A damaged file is not a failed fetch: the server answered, and everything
  // before the damage is real. It is a body that could not be read in full,
  // which detectors already know to report as unobservable.
  it('is read as far as it can be when the file is damaged', async () => {
    let streamed = '';
    const result = await fetchPage(`${origin}/damaged.xml.gz`, {
      userAgent: UA,
      gunzip: true,
      onText: (chunk) => { streamed += chunk; },
    });
    expect(result.error).toBeNull();
    expect(result.status).toBe(200);
    expect(result.truncated).toBe(true);
    expect(streamed.length).toBeGreaterThan(0);
    expect(SITEMAP.startsWith(streamed)).toBe(true);
  });
});

describe('an HTTPS response whose server closes the connection behind it', () => {
  // Over TLS the end of the stream arrives with the last record. When that
  // record found the body stream full, undici 7's HTTP/1.1 client paused its
  // parser, the socket's end then reached a paused parser, and an assertion
  // thrown from inside a socket event — out of reach of any try/catch around
  // `fetch` — ended the process. A gzip-encoded body served with
  // `Connection: close`, as nytimes.com serves its sitemaps, is enough.
  const PAGE = `<html><body>${Array.from({ length: 50_000 }, (_, i) =>
    `<p>${i}-${((i * 2_654_435_761) % 4_294_967_296).toString(36)}</p>`).join('')}</body></html>`;
  const ENCODED = gzipSync(PAGE);

  // The global `fetch` dispatches through whichever undici claimed the global
  // dispatcher first. In a plain `node` process that is cheerio's copy, which
  // installs itself on import; under vitest, Node's own copy is already in
  // place, and this suite passed against the crash. So the suite puts
  // cheerio's copy back, which is where the crawler actually runs.
  const DISPATCHER = Symbol.for('undici.globalDispatcher.1');
  const globals = globalThis as Record<symbol, unknown>;
  let previousDispatcher: unknown;

  let https: TlsServer;
  let verify: string | undefined;

  beforeAll(async () => {
    const fromCheerio = createRequire(createRequire(import.meta.url).resolve('cheerio'));
    const undici = fromCheerio('undici') as { Agent: new () => unknown; setGlobalDispatcher(agent: unknown): void };
    previousDispatcher = globals[DISPATCHER];
    undici.setGlobalDispatcher(new undici.Agent());

    // The testkit certificate is self-signed and guards nothing.
    verify = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    https = await startHttpsServer((request, response) => {
      response.writeHead(200, {
        'content-type': 'text/html',
        'content-encoding': 'gzip',
        'content-length': String(ENCODED.length),
        connection: 'close',
      });
      if (request.url === '/cut.html') {
        // Half of what the headers promised, and then the connection is gone.
        response.write(ENCODED.subarray(0, Math.floor(ENCODED.length / 2)), () => response.socket?.end());
        return;
      }
      response.end(ENCODED);
    });
  });

  afterAll(async () => {
    await https.close();
    globals[DISPATCHER] = previousDispatcher;
    globals[Symbol.for('undici.globalDispatcher.2')] = previousDispatcher;
    if (verify === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = verify;
  });

  it('is read to its end', async () => {
    const result = await fetchPage(`${https.origin}/page.html`, { userAgent: UA });
    expect(result.error).toBeNull();
    expect(result.status).toBe(200);
    expect(result.truncated).toBe(false);
    expect(result.body).toBe(PAGE);
  });

  it('is recorded as a failed fetch when the connection closes part way through the body', async () => {
    const result = await fetchPage(`${https.origin}/cut.html`, { userAgent: UA });
    expect(result.status).toBeNull();
    expect(result.error).not.toBeNull();
  });
});
