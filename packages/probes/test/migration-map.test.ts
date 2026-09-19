/** `migration-map-builder` (0.8): the redirect map against the old URLs the audit knows. */

import { describe, expect, it } from 'vitest';
import type { CrawlResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const ORIGIN = 'https://www.example.com';
const OLD = 'https://old.example.com';

const oldPage = (path: string, status = 200) => ({
  url: `${OLD}${path}`,
  status,
  finalUrl: `${OLD}${path}`,
  metaRobots: null,
  xRobotsTag: null,
  canonical: null,
  title: null,
  jsonLdTypes: [],
  hreflang: [],
});

const record = (over: Record<string, unknown> = {}) => ({
  owner: 'Jane',
  recordedAt: '2026-09-01T00:00:00.000Z',
  kind: 'move',
  oldOrigin: OLD,
  entries: [],
  ...over,
});

const entry = (from: string, to?: string) => ({ from, expect: 301, ...(to === undefined ? {} : { to }) });

const check = (redirectMap?: unknown, pages: string[] = [], sitemapUrls: string[] = []): Observation =>
  (probeById('migration-map-builder') as SiteProbe).run({
    origin: ORIGIN,
    flags: [],
    crawl: {
      crawledAt: '2026-09-19T12:00:00.000Z',
      seeds: [`${ORIGIN}/`],
      pages: [],
      robots: { groups: [], sitemaps: [], absent: true },
      robotsTxt: null,
      sitemapUrls,
      sitemaps: [],
      sitemapVideos: [],
      sitemapNews: [],
      blockedByRobots: [],
      notReached: [],
      auxiliary: [],
    } satisfies CrawlResult,
    previous: { schema: 1, origin: OLD, takenAt: '2026-08-01T00:00:00.000Z', pages: pages.map((p) => oldPage(p)), probes: [] },
    ...(redirectMap === undefined ? {} : { inputs: { redirectMap } as never }),
  });

describe('migration-map-builder', () => {
  it('is not applicable without the section', () => {
    expect(check().outcome).toBe('not-applicable');
  });

  it('passes a history-only map with no entries', () => {
    expect(check(record({ kind: 'history-only', oldOrigin: undefined }), ['/a']).outcome).toBe('pass');
  });

  it('fails a move with no oldOrigin', () => {
    expect(check(record({ oldOrigin: undefined, entries: [entry('/a', '/b')] })).outcome).toBe('fail');
  });

  it('fails an old URL from the previous audit or the old sitemap with no entry', () => {
    const map = record({ entries: [entry('/a', '/x')] });
    expect(check(map, ['/a']).outcome).toBe('pass');
    expect(check(map, ['/a', '/b']).outcome).toBe('fail');
    expect(check(map, ['/a'], [`${OLD}/c`]).outcome).toBe('fail');
    expect(check(map, ['/a'], [`${ORIGIN}/c`]).outcome).toBe('pass');
  });

  it('fails a chain and a loop', () => {
    const chain = record({ entries: [entry('/a', `${OLD}/b`), entry('/b', '/c')] });
    expect(check(chain).outcome).toBe('fail');
    const loop = record({ entries: [entry('/a', `${OLD}/b`), entry('/b', `${OLD}/a`)] });
    expect(check(loop).outcome).toBe('fail');
    expect(check(record({ entries: [entry('/a', `${OLD}/a`)] })).outcome).toBe('fail');
  });

  it('warns on a map nobody owns', () => {
    expect(check(record({ owner: ' ', entries: [entry('/a', '/x')] }), ['/a']).outcome).toBe('warn');
  });
});
