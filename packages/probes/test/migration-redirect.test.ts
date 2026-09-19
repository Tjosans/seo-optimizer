/** `migration-redirect-test` (4.8): what the redirect-map pass saw against what the map promised. */

import { describe, expect, it } from 'vitest';
import type { AuxiliaryFetch, CrawlResult, FetchResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const ORIGIN = 'https://www.example.com';
const OLD = 'https://old.example.com';

const record = (entries: unknown[]) => ({
  owner: 'Jane',
  recordedAt: '2026-09-01T00:00:00.000Z',
  kind: 'move',
  oldOrigin: OLD,
  entries,
});

const hop = (url: string, status: number, location: string) => ({ url, status, location });

const seen = (
  path: string,
  over: { chain?: ReturnType<typeof hop>[]; status?: number | null; finalUrl?: string; error?: string | null },
): AuxiliaryFetch => {
  const url = `${OLD}${path}`;
  return {
    reason: 'redirect-map',
    url,
    fetch: {
      requestedUrl: url,
      finalUrl: over.finalUrl ?? url,
      status: over.status === undefined ? 200 : over.status,
      headers: {},
      redirectChain: over.chain ?? [],
      body: '',
      byteLength: 0,
      truncated: false,
      contentType: null,
      ttfbMs: null,
      totalMs: null,
      error: over.error ?? null,
    } as unknown as FetchResult,
  };
};

const moved = (path: string, to: string, status = 301): AuxiliaryFetch =>
  seen(path, { chain: [hop(`${OLD}${path}`, status, to)], finalUrl: `${ORIGIN}${to}` });

const check = (map: unknown, auxiliary: AuxiliaryFetch[]): Observation =>
  (probeById('migration-redirect-test') as SiteProbe).run({
    origin: ORIGIN,
    flags: [],
    crawl: {
      crawledAt: '2026-09-19T12:00:00.000Z',
      seeds: [`${ORIGIN}/`],
      pages: [],
      robots: { groups: [], sitemaps: [], absent: true },
      robotsTxt: null,
      sitemapUrls: [],
      sitemaps: [],
      sitemapVideos: [],
      sitemapNews: [],
      blockedByRobots: [],
      notReached: [],
      auxiliary,
    } satisfies CrawlResult,
    ...(map === undefined ? {} : { inputs: { redirectMap: map } as never }),
  });

const entry = (from: string, to: string, expect = 301) => ({ from, expect, to });

describe('migration-redirect-test', () => {
  it('is not applicable without a map or entries', () => {
    expect(check(undefined, []).outcome).toBe('not-applicable');
    expect(check(record([]), []).outcome).toBe('not-applicable');
  });

  it('passes a one-hop redirect to the mapped target and a retired 404', () => {
    const map = record([entry('/a', '/b'), { from: '/gone', expect: 404 }]);
    expect(check(map, [moved('/a', '/b'), seen('/gone', { status: 404 })]).outcome).toBe('pass');
  });

  it('fails the wrong status, wrong target, extra hops and a loop', () => {
    const map = record([entry('/a', '/b')]);
    expect(check(map, [moved('/a', '/b', 302)]).outcome).toBe('fail');
    expect(check(map, [moved('/a', '/other')]).outcome).toBe('fail');
    expect(check(map, [seen('/a', { status: 200 })]).outcome).toBe('fail');
    expect(
      check(map, [
        seen('/a', {
          chain: [hop(`${OLD}/a`, 301, '/x'), hop(`${OLD}/x`, 301, '/b')],
          finalUrl: `${ORIGIN}/b`,
        }),
      ]).outcome,
    ).toBe('fail');
    expect(check(map, [seen('/a', { status: null, error: 'redirect loop: target is the current URL' })]).outcome).toBe('fail');
    expect(check(record([{ from: '/gone', expect: 410 }]), [seen('/gone', { status: 404 })]).outcome).toBe('fail');
  });

  it('warns on an entry the crawl never requested', () => {
    const map = record([entry('/a', '/b'), entry('/c', '/d')]);
    expect(check(map, [moved('/a', '/b')]).outcome).toBe('warn');
  });
});
