/** `production-smoke-test` (5.1): the production smoke test. */

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
  (probeById('production-smoke-test') as SiteProbe).run({
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

const prod = (over: Record<string, unknown> = {}) => row({ environment: 'production', ...over });

describe('production-smoke-test', () => {
  it('is not applicable without a matrix, a production row, or on staging', () => {
    expect(check([page('/products/a')]).outcome).toBe('not-applicable');
    expect(check([page('/products/a')], [row()]).outcome).toBe('not-applicable');
    const staged = (probeById('production-smoke-test') as SiteProbe).run({
      origin: ORIGIN,
      flags: [],
      crawl: { pages: [], seeds: [], auxiliary: [] } as never,
      inputs: { urlMatrix: [prod()], environments: { staging: ORIGIN } } as never,
    });
    expect(staged.outcome).toBe('not-applicable');
  });

  it('passes and records organic crawling as unavailable', () => {
    const result = check([page('/products/a')], [row({ priority: true }), prod({ pattern: '/x' })]);
    expect(result.outcome).toBe('pass');
    expect(result.data?.['organicCrawling']).toBe('unavailable');
  });

  it('fails a priority URL not answering 200', () => {
    expect(check([page('/products/a', { status: 301 })], [row({ priority: true }), prod({ pattern: '/x' })]).outcome).toBe('fail');
  });

  it('fails an unexpected noindex', () => {
    expect(check([page('/products/a', { metaRobots: 'noindex' })], [row(), prod({ pattern: '/x' })]).outcome).toBe('fail');
    expect(check([page('/products/a', { metaRobots: 'noindex' })], [row({ indexable: false }), prod({ pattern: '/x' })]).outcome).toBe('pass');
  });

  it('fails a private pattern answering 200 without credentials', () => {
    const rows = [prod({ pattern: '/account/**', access: 'private', indexable: false })];
    expect(check([page('/account/me')], rows).outcome).toBe('fail');
    expect(check([page('/account/me', { status: 401 })], rows).outcome).toBe('pass');
  });

  it('holds a priority pattern the crawl did not reach', () => {
    expect(check([page('/x')], [row({ priority: true }), prod({ pattern: '/x' })]).outcome).toBe('warn');
  });
});
