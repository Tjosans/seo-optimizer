/** `security-manual-actions` (6.5): does the Search Console export show anything open. */

import { describe, expect, it } from 'vitest';
import type { CrawlResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const record = (over: Record<string, unknown> = {}) => ({
  owner: 'Jane',
  recordedAt: '2026-09-10T00:00:00.000Z',
  manualActions: [],
  securityIssues: [],
  ...over,
});

const check = (searchConsole?: unknown): Observation =>
  (probeById('security-manual-actions') as SiteProbe).run({
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

describe('security-manual-actions', () => {
  it('is not applicable without the section', () => {
    expect(check().outcome).toBe('not-applicable');
  });

  it('passes an empty report of each kind', () => {
    expect(check(record()).outcome).toBe('pass');
  });

  it('fails an open manual action or security issue', () => {
    expect(check(record({ manualActions: [{ type: 'Pure spam', scope: 'partial' }] })).outcome).toBe('fail');
    expect(check(record({ securityIssues: [{ type: 'Malware' }] })).outcome).toBe('fail');
  });

  it('fails an open finding even in a stale export', () => {
    expect(check(record({ recordedAt: '2026-01-01T00:00:00.000Z', securityIssues: [{ type: 'Malware' }] })).outcome).toBe('fail');
  });

  it('warns when a report is missing', () => {
    expect(check(record({ securityIssues: undefined })).outcome).toBe('warn');
    expect(check(record({ manualActions: undefined })).outcome).toBe('warn');
  });

  it('warns on an export more than 30 days older than the crawl', () => {
    expect(check(record({ recordedAt: '2026-08-19T00:00:00.000Z' })).outcome).toBe('warn');
    expect(check(record({ recordedAt: '2026-08-25T00:00:00.000Z' })).outcome).toBe('pass');
  });

  it('warns on a record nobody owns or that is overdue', () => {
    expect(check(record({ owner: ' ' })).outcome).toBe('warn');
    expect(check(record({ nextReviewAt: '2026-09-15T00:00:00.000Z' })).outcome).toBe('warn');
  });
});
