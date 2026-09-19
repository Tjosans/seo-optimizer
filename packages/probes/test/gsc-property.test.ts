/** `gsc-property-ownership` (2.4): does the Search Console property cover the site, and who owns it. */

import { describe, expect, it } from 'vitest';
import type { CrawlResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const at = '2026-09-01T00:00:00.000Z';
const owner = (email: string) => ({ email, verifiedAt: at });

const record = (property?: unknown, over: Record<string, unknown> = {}) => ({
  owner: 'Jane',
  recordedAt: at,
  ...(property === undefined ? {} : { property }),
  ...over,
});

const check = (searchConsole?: unknown): Observation =>
  (probeById('gsc-property-ownership') as SiteProbe).run({
    origin: 'https://www.example.com',
    flags: [],
    crawl: {
      crawledAt: '2026-09-19T12:00:00.000Z',
      seeds: [],
      pages: [],
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
    ...(searchConsole === undefined ? {} : { inputs: { searchConsole } as never }),
  });

const two = [owner('a@example.com'), owner('b@example.com')];

describe('gsc-property-ownership', () => {
  it('is not applicable without the section', () => {
    expect(check().outcome).toBe('not-applicable');
  });

  it('passes a domain or exact url-prefix property with two owners', () => {
    expect(check(record({ type: 'domain', url: 'sc-domain:example.com', owners: two })).outcome).toBe('pass');
    expect(check(record({ type: 'domain', url: 'example.com', owners: two })).outcome).toBe('pass');
    expect(check(record({ type: 'url-prefix', url: 'https://www.example.com/', owners: two })).outcome).toBe('pass');
  });

  it('fails a property on another scheme, host, domain or path', () => {
    expect(check(record({ type: 'url-prefix', url: 'http://www.example.com/', owners: two })).outcome).toBe('fail');
    expect(check(record({ type: 'url-prefix', url: 'https://example.com/', owners: two })).outcome).toBe('fail');
    expect(check(record({ type: 'url-prefix', url: 'https://www.example.com/blog/', owners: two })).outcome).toBe('fail');
    expect(check(record({ type: 'domain', url: 'sc-domain:example.org', owners: two })).outcome).toBe('fail');
    expect(check(record({ type: 'domain', url: 'ample.com', owners: two })).outcome).toBe('fail');
  });

  it('fails a property with no verified owner', () => {
    expect(check(record({ type: 'domain', url: 'example.com', owners: [] })).outcome).toBe('fail');
  });

  it('warns on a single owner, a repeated owner, or a missing property', () => {
    expect(check(record({ type: 'domain', url: 'example.com', owners: [owner('a@example.com')] })).outcome).toBe('warn');
    expect(check(record({ type: 'domain', url: 'example.com', owners: [owner('a@example.com'), owner('A@example.com')] })).outcome).toBe('warn');
    expect(check(record()).outcome).toBe('warn');
  });

  it('warns on a record nobody owns or that is overdue, never fails it', () => {
    const property = { type: 'domain', url: 'example.com', owners: two };
    expect(check(record(property, { owner: ' ' })).outcome).toBe('warn');
    expect(check(record(property, { nextReviewAt: '2026-09-10T00:00:00.000Z' })).outcome).toBe('warn');
  });
});
