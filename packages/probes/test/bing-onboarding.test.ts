/** `bing-onboarding` (5.8): is the property verified and did the sitemaps reach Bing. */

import { describe, expect, it } from 'vitest';
import type { CrawlResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const at = '2026-09-01T00:00:00.000Z';
const sitemap = 'https://www.example.com/sitemap.xml';
const record = (over: Record<string, unknown> = {}) => ({
  owner: 'Jane',
  recordedAt: at,
  property: { url: 'https://www.example.com/', verified: true, verifiedAt: at },
  sitemaps: [{ url: sitemap, submittedAt: at, status: 'Success' }],
  ...over,
});

const check = (rec?: unknown, sitemaps: string[] = [sitemap]): Observation =>
  (probeById('bing-onboarding') as SiteProbe).run({
    origin: 'https://www.example.com',
    flags: [],
    crawl: {
      crawledAt: '2026-09-19T12:00:00.000Z',
      pages: [],
      blockedByRobots: [],
      sitemaps: sitemaps.map((url) => ({ url, status: 200 })),
    } as unknown as CrawlResult,
    inputs: (rec === undefined ? {} : { bingWebmaster: rec }) as never,
  });

describe('bing-onboarding', () => {
  it('is not applicable without a section', () => {
    expect(check().outcome).toBe('not-applicable');
  });

  it('passes a verified property with the sitemap received', () => {
    expect(check(record()).outcome).toBe('pass');
  });

  it('fails an unverified property', () => {
    expect(check(record({ property: { url: 'https://www.example.com/', verified: false } })).outcome).toBe('fail');
  });

  it('fails a sitemap Bing reports as failed', () => {
    expect(check(record({ sitemaps: [{ url: sitemap, submittedAt: at, status: 'Error' }] })).outcome).toBe('fail');
  });

  it('warns a found sitemap Bing has not received', () => {
    expect(check(record({ sitemaps: [] })).outcome).toBe('warn');
  });

  it('warns on a record with no owner', () => {
    expect(check(record({ owner: '' })).outcome).toBe('warn');
  });
});
