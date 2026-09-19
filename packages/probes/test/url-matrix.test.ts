/** `url-inventory-builder` (0.3): the crawl against the supplied URL matrix. */

import { describe, expect, it } from 'vitest';
import { extract } from '@seo/crawler';
import type { CrawledPage, CrawlResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const ORIGIN = 'https://www.example.com';

interface Spec {
  readonly status?: number;
  readonly canonical?: string | null;
  readonly metaRobots?: string;
  readonly redirectedFirst?: number;
}

const page = (path: string, spec: Spec = {}): CrawledPage => {
  const url = `${ORIGIN}${path}`;
  const { status = 200, canonical = 'self' } = spec;
  const html =
    '<html><head><title>T</title>' +
    (canonical === null ? '' : `<link rel="canonical" href="${canonical === 'self' ? url : canonical}">`) +
    (spec.metaRobots === undefined ? '' : `<meta name="robots" content="${spec.metaRobots}">`) +
    '</head><body><h1>H</h1></body></html>';
  return {
    url,
    normalizedUrl: url,
    depth: 1,
    discoveredFrom: null,
    fetch: {
      requestedUrl: url,
      finalUrl: url,
      status,
      headers: {},
      redirectChain: spec.redirectedFirst === undefined ? [] : [{ url, status: spec.redirectedFirst, location: url }],
      body: html,
      byteLength: html.length,
      truncated: false,
      contentType: 'text/html',
      ttfbMs: 1,
      totalMs: 1,
    } as never,
    extracted: extract(html, url),
  };
};

const row = (over: Record<string, unknown> = {}) => ({
  pattern: '/products/**',
  owner: 'Jane',
  recordedAt: '2026-09-01T00:00:00.000Z',
  status: 200,
  indexable: true,
  canonical: 'self',
  inSitemap: true,
  access: 'public',
  ...over,
});

const check = (pages: CrawledPage[], urlMatrix?: unknown[]): Observation =>
  (probeById('url-inventory-builder') as SiteProbe).run({
    origin: ORIGIN,
    flags: [],
    crawl: {
      crawledAt: '2026-09-19T12:00:00.000Z',
      seeds: [`${ORIGIN}/`],
      pages,
      robots: { groups: [], sitemaps: [], absent: true },
      robotsTxt: null,
      sitemapUrls: [],
      sitemaps: [],
      sitemapVideos: [],
      sitemapNews: [],
      blockedByRobots: [],
      notReached: [],
      auxiliary: [],
    } satisfies CrawlResult,
    ...(urlMatrix === undefined ? {} : { inputs: { urlMatrix } as never }),
  });

describe('url-inventory-builder', () => {
  it('is not applicable without the section, or with only environment rows', () => {
    expect(check([page('/products/a')]).outcome).toBe('not-applicable');
    expect(check([page('/products/a')], [row({ environment: 'staging' })]).outcome).toBe('not-applicable');
  });

  it('passes when every URL and row agree', () => {
    expect(check([page('/products/a'), page('/products/b')], [row()]).outcome).toBe('pass');
  });

  it('fails a priority pattern the crawl did not reach, warns a non-priority one', () => {
    expect(check([page('/x')], [row({ pattern: '/x' }), row({ priority: true })]).outcome).toBe('fail');
    expect(check([page('/x')], [row({ pattern: '/x' }), row()]).outcome).toBe('warn');
  });

  it('fails a priority URL answering other than its status, reading the first response', () => {
    expect(check([page('/products/a', { status: 404 })], [row({ priority: true })]).outcome).toBe('fail');
    const redirected = page('/products/a', { redirectedFirst: 301 });
    expect(check([redirected], [row({ priority: true, status: 301 })]).outcome).toBe('pass');
  });

  it('fails a page disagreeing on indexable or canonical', () => {
    expect(check([page('/products/a', { metaRobots: 'noindex' })], [row()]).outcome).toBe('fail');
    expect(check([page('/products/a', { canonical: `${ORIGIN}/other` })], [row()]).outcome).toBe('fail');
    expect(check([page('/products/a', { canonical: null })], [row({ canonical: 'none' })]).outcome).toBe('pass');
    expect(check([page('/products/a', { metaRobots: 'noindex' })], [row({ indexable: false })]).outcome).toBe('pass');
  });

  it('warns a crawled URL no pattern covers', () => {
    const result = check([page('/products/a'), page('/stray')], [row()]);
    expect(result.outcome).toBe('warn');
  });

  it('judges a URL by the most specific pattern', () => {
    const pages = [page('/products/a', { metaRobots: 'noindex' }), page('/products/b')];
    expect(check(pages, [row(), row({ pattern: '/products/a', indexable: false })]).outcome).toBe('pass');
  });

  it('holds a row with no owner', () => {
    expect(check([page('/products/a')], [row({ owner: '' })]).outcome).toBe('warn');
  });
});
