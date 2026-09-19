/**
 * `crawl()`'s `renderPages` option, exercised against a fake `fetchImpl` and
 * `renderImpl` — the thing under test is the wiring (which pages get
 * rendered, how a render is compared against its raw fetch), not whether a
 * real browser renders correctly, which `render.test.ts` already covers
 * against one.
 */

import { describe, expect, it } from 'vitest';
import { crawl } from '@seo/crawler';
import type { CrawlOptions, FetchResult, RenderResult } from '@seo/crawler';

const SEED = 'https://example.test/';

const BASE: CrawlOptions = {
  seeds: [SEED],
  userAgent: 'seo-optimizer/0.1 (+test)',
  maxPages: 1,
  maxDepth: 0,
  followSitemaps: false,
  auxiliary: false,
};

const htmlResponse = (body: string): FetchResult => ({
  requestedUrl: SEED,
  finalUrl: SEED,
  status: 200,
  headers: {},
  redirectChain: [],
  body,
  byteLength: body.length,
  truncated: false,
  contentType: 'text/html',
  ttfbMs: 1,
  totalMs: 1,
  error: null,
});

const RAW_HTML =
  '<!doctype html><html lang="en"><head><title>Raw title</title>' +
  '<link rel="canonical" href="https://example.test/"></head>' +
  '<body><main><h1>Home</h1><p>Server-delivered copy.</p>' +
  '<a href="/about">About</a></main></body></html>';

describe('dual-crawl (renderPages)', () => {
  it('renders nothing by default', async () => {
    const result = await crawl({
      ...BASE,
      fetchImpl: async () => htmlResponse(RAW_HTML),
    });
    expect(result.pages[0]?.rendered).toBeUndefined();
  });

  it('renders each HTML page and compares it against the raw fetch', async () => {
    const rendered: string[] = [];
    const result = await crawl({
      ...BASE,
      fetchImpl: async () => htmlResponse(RAW_HTML),
      renderPages: true,
      renderImpl: async (url): Promise<RenderResult> => {
        rendered.push(url);
        return {
          requestedUrl: url,
          finalUrl: url,
          status: 200,
          html:
            '<!doctype html><html lang="en"><head><title>Rendered title</title>' +
            `<link rel="canonical" href="${url}"></head>` +
            '<body><main><h1>Home</h1><p>Client-side content the raw fetch never saw.</p>' +
            '<a href="/about">About</a><a href="/hydrated">Hydrated link</a></main></body></html>',
          totalMs: 12,
          error: null,
        };
      },
    });

    expect(rendered).toEqual([SEED]);
    const page = result.pages[0];
    expect(page?.rendered?.render.error).toBeNull();
    expect(page?.rendered?.extracted?.title).toBe('Rendered title');
    expect(page?.rendered?.comparison?.titleMatches).toBe(false);
    expect(page?.rendered?.comparison?.canonicalMatches).toBe(true);
    expect(page?.rendered?.comparison?.linkCountRaw).toBe(1);
    expect(page?.rendered?.comparison?.linkCountRendered).toBe(2);
    expect(page?.rendered?.comparison?.textMatches).toBe(false);
  });

  it('leaves a page with nothing to render at null, not undefined', async () => {
    const result = await crawl({
      ...BASE,
      fetchImpl: async (): Promise<FetchResult> => ({
        requestedUrl: SEED,
        finalUrl: SEED,
        status: 200,
        headers: {},
        redirectChain: [],
        body: '{"ok":true}',
        byteLength: 11,
        truncated: false,
        contentType: 'application/json',
        ttfbMs: 1,
        totalMs: 1,
        error: null,
      }),
      renderPages: true,
      renderImpl: async (): Promise<RenderResult> => {
        throw new Error('a non-HTML response has nothing to render, so this must not be called');
      },
    });
    expect(result.pages[0]?.rendered).toBeNull();
  });

  describe('renderMobile', () => {
    const renderFor = (mobileHtml: string) => async (url: string, opts: { mobile?: boolean }): Promise<RenderResult> => ({
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      html: opts.mobile === true
        ? mobileHtml
        : '<!doctype html><html lang="en"><head><title>Home</title></head><body><main><h1>Home</h1><p>Copy.</p><a href="/a">A</a><a href="/b">B</a></main></body></html>',
      totalMs: 1,
      error: null,
    });

    it('renders nothing extra by default', async () => {
      const result = await crawl({
        ...BASE,
        fetchImpl: async () => htmlResponse(RAW_HTML),
        renderPages: true,
        renderImpl: renderFor('<html></html>'),
      });
      expect(result.pages[0]?.renderedMobile).toBeUndefined();
    });

    it('renders as a phone and compares against the desktop render', async () => {
      const calls: (boolean | undefined)[] = [];
      const desktopRender = renderFor('<!doctype html><html><head><title>Home (m)</title></head><body><h1>Home</h1></body></html>');
      const result = await crawl({
        ...BASE,
        fetchImpl: async () => htmlResponse(RAW_HTML),
        renderPages: true,
        renderMobile: true,
        renderImpl: async (url, opts) => {
          calls.push(opts.mobile);
          return desktopRender(url, opts);
        },
      });
      expect(calls).toEqual([undefined, true]);
      const page = result.pages[0];
      expect(page?.renderedMobile?.extracted?.title).toBe('Home (m)');
      expect(page?.renderedMobile?.comparison?.titleMatches).toBe(false);
      expect(page?.renderedMobile?.comparison?.linkCountRaw).toBe(2);
      expect(page?.renderedMobile?.comparison?.linkCountRendered).toBe(0);
    });

    it('has no comparison without a desktop render, and is null for non-HTML', async () => {
      const result = await crawl({
        ...BASE,
        fetchImpl: async () => htmlResponse(RAW_HTML),
        renderMobile: true,
        renderImpl: renderFor('<!doctype html><html><head><title>Home</title></head><body></body></html>'),
      });
      expect(result.pages[0]?.rendered).toBeUndefined();
      expect(result.pages[0]?.renderedMobile?.extracted?.title).toBe('Home');
      expect(result.pages[0]?.renderedMobile?.comparison).toBeNull();

      const json = await crawl({
        ...BASE,
        fetchImpl: async (): Promise<FetchResult> => ({ ...htmlResponse('{}'), contentType: 'application/json' }),
        renderMobile: true,
        renderImpl: async () => {
          throw new Error('must not render');
        },
      });
      expect(json.pages[0]?.renderedMobile).toBeNull();
    });
  });

  it('records a failed render without a comparison, rather than throwing', async () => {
    const result = await crawl({
      ...BASE,
      fetchImpl: async () => htmlResponse(RAW_HTML),
      renderPages: true,
      renderImpl: async (url): Promise<RenderResult> => ({
        requestedUrl: url,
        finalUrl: url,
        status: null,
        html: '',
        totalMs: null,
        error: 'navigation timeout',
      }),
    });

    const page = result.pages[0];
    expect(page?.rendered?.render.error).toBe('navigation timeout');
    expect(page?.rendered?.extracted).toBeNull();
    expect(page?.rendered?.comparison).toBeNull();
  });
});
