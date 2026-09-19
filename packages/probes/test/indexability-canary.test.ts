/** `indexability-canary` (5.5): canary URLs against the URL matrix. */

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
      redirectChain: [],
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

const A = `${ORIGIN}/products/a`;

const check = (pages: CrawledPage[], urls: string[], urlMatrix?: unknown[], blocked: string[] = []): Observation =>
  (probeById('indexability-canary') as SiteProbe).run({
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
      blockedByRobots: blocked,
      notReached: [],
      auxiliary: [],
    } satisfies CrawlResult,
    inputs: {
      canary: { owner: 'Jane', recordedAt: '2026-09-01T00:00:00.000Z', urls, targetMinutes: 5, recipient: 'ops' },
      ...(urlMatrix === undefined ? {} : { urlMatrix }),
    } as never,
  });

describe('indexability-canary', () => {
  it('is not applicable without a canary or a matrix', () => {
    const bare = (probeById('indexability-canary') as SiteProbe).run({
      origin: ORIGIN,
      flags: [],
      crawl: { pages: [], seeds: [], auxiliary: [], blockedByRobots: [] } as never,
    });
    expect(bare.outcome).toBe('not-applicable');
    expect(check([page('/products/a')], [A]).outcome).toBe('not-applicable');
  });

  it('passes a canary matching its row', () => {
    expect(check([page('/products/a')], [A], [row()]).outcome).toBe('pass');
  });

  it('fails status, noindex, canonical and robots disagreement', () => {
    expect(check([page('/products/a', { status: 301 })], [A], [row()]).outcome).toBe('fail');
    expect(check([page('/products/a', { metaRobots: 'noindex' })], [A], [row()]).outcome).toBe('fail');
    expect(check([page('/products/a', { canonical: `${ORIGIN}/other` })], [A], [row()]).outcome).toBe('fail');
    expect(check([], [A], [row()], [A]).outcome).toBe('fail');
    expect(check([], [A], [row({ indexable: false })], [A]).outcome).toBe('pass');
  });

  it('warns a URL matching no pattern or not reached', () => {
    expect(check([page('/other')], [`${ORIGIN}/other`], [row()]).outcome).toBe('warn');
    expect(check([], [A], [row()]).outcome).toBe('warn');
  });
});
