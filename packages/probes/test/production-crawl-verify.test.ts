/** `production-crawl-verify` (5.3): the production crawl against the preflight audit. */

import { describe, expect, it } from 'vitest';
import { extract } from '@seo/crawler';
import type { CrawledPage, CrawlResult } from '@seo/crawler';
import { PREVIOUS_AUDIT_SCHEMA, probeById } from '@seo/probes';
import type { Observation, PreviousAudit, PreviousPage, SiteProbe } from '@seo/probes';

const ORIGIN = 'https://www.example.com';
const STAGING = 'https://staging.example.com';

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

const before = (path: string, over: Partial<PreviousPage> = {}, origin = ORIGIN): PreviousPage => ({
  url: `${origin}${path}`,
  status: 200,
  finalUrl: `${origin}${path}`,
  metaRobots: null,
  xRobotsTag: null,
  canonical: `${origin}${path}`,
  title: 'T',
  jsonLdTypes: [],
  hreflang: [],
  ...over,
});

const audit = (pages: PreviousPage[], over: Partial<PreviousAudit> = {}): PreviousAudit => ({
  schema: PREVIOUS_AUDIT_SCHEMA,
  origin: ORIGIN,
  takenAt: '2026-09-10T00:00:00.000Z',
  pages,
  probes: [],
  ...over,
});

const check = (
  pages: CrawledPage[],
  previous?: PreviousAudit | null,
  extra: { blocked?: string[]; urlMatrix?: unknown[] } = {},
): Observation =>
  (probeById('production-crawl-verify') as SiteProbe).run({
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
      blockedByRobots: extra.blocked ?? [],
      notReached: [],
      auxiliary: [],
    } satisfies CrawlResult,
    ...(previous === undefined ? {} : { previous }),
    ...(extra.urlMatrix === undefined ? {} : { inputs: { urlMatrix: extra.urlMatrix } as never }),
  });

describe('production-crawl-verify', () => {
  it('is not applicable without a previous audit', () => {
    expect(check([page('/a')]).outcome).toBe('not-applicable');
    expect(check([page('/a')], null).outcome).toBe('not-applicable');
  });

  it('passes when everything indexable before still is', () => {
    const result = check([page('/a'), page('/b')], audit([before('/a'), before('/b')]));
    expect(result.outcome).toBe('pass');
    expect(result.data?.['compared']).toBe(2);
  });

  it('fails a URL now noindex, blocked, 404 or 500', () => {
    const previous = audit([before('/a'), before('/b'), before('/c'), before('/d')]);
    const result = check(
      [page('/a', { metaRobots: 'noindex' }), page('/c', { status: 404 }), page('/d', { status: 500 })],
      previous,
      { blocked: [`${ORIGIN}/b`] },
    );
    expect(result.outcome).toBe('fail');
    expect(result.data?.['failureCount']).toBe(4);
  });

  it('ignores a URL that was not indexable before', () => {
    const previous = audit([before('/a', { metaRobots: 'noindex' }), before('/b', { status: 404 })]);
    expect(check([page('/a', { metaRobots: 'noindex' }), page('/b', { status: 404 })], previous).outcome).toBe('pass');
  });

  it('fails a changed canonical', () => {
    const result = check([page('/a', { canonical: `${ORIGIN}/other` })], audit([before('/a')]));
    expect(result.outcome).toBe('fail');
    expect(result.summary).toContain('canonical changed');
  });

  it('compares a staging audit against the same paths on production', () => {
    const previous = audit([before('/a', {}, STAGING)], { origin: STAGING });
    expect(check([page('/a')], previous).outcome).toBe('pass');
    expect(check([page('/a', { canonical: `${ORIGIN}/other` })], previous).outcome).toBe('fail');
  });

  it('holds a previously indexable URL the crawl did not reach', () => {
    const result = check([page('/a')], audit([before('/a'), before('/b')]));
    expect(result.outcome).toBe('warn');
  });

  it('fails a priority URL in the matrix that was not reached', () => {
    const matrix = [
      { pattern: '/a', owner: 'Jane', recordedAt: '2026-09-01T00:00:00.000Z', priority: true },
      { pattern: '/missing', owner: 'Jane', recordedAt: '2026-09-01T00:00:00.000Z', priority: true },
    ];
    const result = check([page('/a')], audit([before('/a')]), { urlMatrix: matrix });
    expect(result.outcome).toBe('fail');
    expect(result.data?.['missedPriority']).toEqual(['/missing']);
  });
});
