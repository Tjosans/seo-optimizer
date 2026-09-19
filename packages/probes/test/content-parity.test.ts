/** `content-parity-diff` (4.8): a migrated URL lands on what the old one was. */

import { describe, expect, it } from 'vitest';
import { extract } from '@seo/crawler';
import type { CrawledPage, CrawlResult, FetchResult } from '@seo/crawler';
import { probeById, snapshotPage } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const ORIGIN = 'https://www.example.com';
const OLD = 'https://old.example.com';

const words = (n: number): string => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

interface Spec {
  readonly title?: string;
  readonly h1?: string;
  readonly body?: number;
  readonly canonical?: string;
}

const html = ({ title = 'Blue widgets', h1 = 'Blue widgets', body = 100, canonical }: Spec): string =>
  `<html><head><title>${title}</title>${canonical === undefined ? '' : `<link rel="canonical" href="${canonical}">`}` +
  `</head><body><main><h1>${h1}</h1><p>${words(body)}</p></main></body></html>`;

const current = (path: string, spec: Spec): CrawledPage => {
  const url = `${ORIGIN}${path}`;
  const body = html(spec);
  return {
    url,
    normalizedUrl: url,
    depth: 1,
    discoveredFrom: null,
    fetch: {
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      headers: {},
      redirectChain: [],
      body,
      byteLength: body.length,
      truncated: false,
      contentType: 'text/html',
      ttfbMs: 1,
      totalMs: 2,
      error: null,
    } as unknown as FetchResult,
    extracted: extract(body, url),
  };
};

const before = (path: string, spec: Spec = {}) =>
  snapshotPage({
    url: `${OLD}${path}`,
    finalUrl: `${OLD}${path}`,
    status: 200,
    headers: {},
    extracted: extract(html(spec), `${OLD}${path}`),
  });

const record = (entries: unknown[], over: Record<string, unknown> = {}) => ({
  owner: 'Jane',
  recordedAt: '2026-09-01T00:00:00.000Z',
  kind: 'move',
  oldOrigin: OLD,
  entries,
  ...over,
});

const entry = (from: string, to: string) => ({ from, expect: 301, to });

const check = (
  map: unknown,
  pages: CrawledPage[],
  old: ReturnType<typeof before>[] | null,
): Observation =>
  (probeById('content-parity-diff') as SiteProbe).run({
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
    previous:
      old === null ? null : { schema: 1, origin: OLD, takenAt: '2026-08-01T00:00:00.000Z', pages: old, probes: [] },
    ...(map === undefined ? {} : { inputs: { redirectMap: map } as never }),
  });

describe('content-parity-diff', () => {
  it('is not applicable without a map or a previous audit', () => {
    expect(check(undefined, [], [before('/a')]).outcome).toBe('not-applicable');
    expect(check(record([entry('/a', '/b')]), [], null).outcome).toBe('not-applicable');
  });

  it('is not applicable when no old URL was in the previous audit', () => {
    expect(check(record([entry('/a', '/b')]), [current('/b', {})], [before('/other')]).outcome).toBe('not-applicable');
  });

  it('passes a destination that matches the old page', () => {
    expect(check(record([entry('/a', '/b')]), [current('/b', { canonical: `${ORIGIN}/b` })], [before('/a')]).outcome).toBe('pass');
  });

  it('fails an h1 that shares nothing with the old title and h1', () => {
    const observation = check(record([entry('/a', '/b')]), [current('/b', { h1: 'Contact us', title: 'Blue widgets' })], [before('/a')]);
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toContain('shares nothing');
  });

  it('fails a destination with under half the old word count', () => {
    const observation = check(record([entry('/a', '/b')]), [current('/b', { body: 20 })], [before('/a')]);
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toContain('word');
  });

  it('fails a destination that canonicalizes elsewhere', () => {
    const observation = check(record([entry('/a', '/b')]), [current('/b', { canonical: `${ORIGIN}/c` })], [before('/a')]);
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toContain('canonicalizes');
  });

  it('warns a changed title and a destination the crawl did not reach', () => {
    expect(check(record([entry('/a', '/b')]), [current('/b', { title: 'Widgets in blue' })], [before('/a')]).outcome).toBe('warn');
    expect(check(record([entry('/a', '/b')]), [], [before('/a')]).outcome).toBe('warn');
  });

  it('holds a map with no owner', () => {
    expect(check(record([entry('/a', '/b')], { owner: '' }), [current('/b', {})], [before('/a')]).outcome).toBe('warn');
  });
});
