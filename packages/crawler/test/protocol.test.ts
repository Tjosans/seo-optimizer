/**
 * The handshake that learns a host's HTTP version.
 *
 * Against real TLS servers on localhost, because the thing under test is what
 * a server picks from what a client offers, and a double would only repeat
 * whatever the test told it. The crawl-level cases use doubles instead: there
 * the question is which host gets asked, and when.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { crawl, negotiateProtocol } from '@seo/crawler';
import type { FetchResult, ProtocolCheck, fetchPage } from '@seo/crawler';
import { startTlsServer } from '@seo/testkit';
import type { TlsServer } from '@seo/testkit';

let server: TlsServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe('negotiateProtocol', () => {
  it('reports HTTP/2 from a server that offers it', async () => {
    server = await startTlsServer(['h2', 'http/1.1']);
    const check = await negotiateProtocol(`${server.origin}/`);
    expect(check).toMatchObject({ origin: server.origin, alpn: 'h2', error: null });
    expect(check.tlsVersion).toMatch(/^TLSv1\.[23]$/);
  });

  it('reports HTTP/1.1 from a server that offers only that', async () => {
    server = await startTlsServer(['http/1.1']);
    expect((await negotiateProtocol(`${server.origin}/`)).alpn).toBe('http/1.1');
  });

  it('reports no choice, and no error, from a server without ALPN', async () => {
    server = await startTlsServer([]);
    const check = await negotiateProtocol(`${server.origin}/`);
    expect(check.alpn).toBeNull();
    expect(check.error).toBeNull();
  });

  it('returns a failed handshake as data', async () => {
    // Port 1 is reserved and refuses connections on every platform.
    const check = await negotiateProtocol('https://127.0.0.1:1/', { timeoutMs: 2_000 });
    expect(check.alpn).toBeNull();
    expect(check.error).not.toBeNull();
  });

  it('declines a URL that is not https without connecting', async () => {
    expect((await negotiateProtocol('http://example.com/')).error).toBe('not an https URL');
  });
});

describe('the handshake inside a crawl', () => {
  const response = (url: string, finalUrl = url): FetchResult => ({
    requestedUrl: url,
    finalUrl,
    status: url.endsWith('/robots.txt') || url.endsWith('.xml') ? 404 : 200,
    headers: {},
    redirectChain: finalUrl === url ? [] : [{ url, status: 301, location: finalUrl }],
    body: '<html><body><p>home</p></body></html>',
    byteLength: 38,
    truncated: false,
    contentType: 'text/html',
    ttfbMs: 1,
    totalMs: 1,
    error: null,
  });

  const run = async (seed: string, landsOn: string, auxiliary = true) => {
    const asked: string[] = [];
    const result = await crawl({
      seeds: [seed],
      userAgent: 'seo-optimizer/0.1 (+test)',
      maxPages: 1,
      maxDepth: 0,
      auxiliary,
      fetchImpl: (async (url: string) =>
        response(url, url === seed ? landsOn : url)) as unknown as typeof fetchPage,
      negotiateImpl: async (url: string): Promise<ProtocolCheck> => {
        asked.push(url);
        return { origin: new URL(url).origin, alpn: 'h2', tlsVersion: 'TLSv1.3', error: null };
      },
    });
    return { result, asked };
  };

  it('asks the host the root document landed on, after its redirects', async () => {
    const { result, asked } = await run('https://shop.example/', 'https://www.shop.example/');
    expect(asked).toEqual(['https://www.shop.example/']);
    expect(result.protocol?.alpn).toBe('h2');
  });

  it('makes no handshake when the root document was served over plain HTTP', async () => {
    const { result, asked } = await run('http://shop.example/', 'http://shop.example/');
    expect(asked).toEqual([]);
    expect(result.protocol).toBeUndefined();
  });

  it('makes no handshake when auxiliary requests are off', async () => {
    const { result, asked } = await run('https://shop.example/', 'https://shop.example/', false);
    expect(asked).toEqual([]);
    expect(result.protocol).toBeUndefined();
  });
});
