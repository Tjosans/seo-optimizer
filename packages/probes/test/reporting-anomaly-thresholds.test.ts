/** `reporting-anomaly-thresholds` (6.3): does every crossed threshold have an answered anomaly entry. */

import { describe, expect, it } from 'vitest';
import type { CrawlResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const reporting = (over: Record<string, unknown> = {}) => ({
  owner: 'Jane',
  recordedAt: '2026-09-10T00:00:00.000Z',
  rhythm: 'weekly',
  thresholds: [{ metric: 'clicks', engine: 'google', change: -0.2 }],
  anomalies: [],
  ...over,
});

const perf = (before: number, after: number) => ({
  owner: 'Jane',
  recordedAt: '2026-09-10T00:00:00.000Z',
  performance: [
    { page: 'https://www.example.com/', clicks: before, impressions: 1000, period: '2026-06' },
    { page: 'https://www.example.com/', clicks: after, impressions: 1000, period: '2026-07' },
  ],
});

const check = (record?: unknown, searchConsole?: unknown): Observation =>
  (probeById('reporting-anomaly-thresholds') as SiteProbe).run({
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
    inputs: { ...(record === undefined ? {} : { reporting: record }), ...(searchConsole === undefined ? {} : { searchConsole }) } as never,
  });

describe('reporting-anomaly-thresholds', () => {
  it('is not applicable without the section', () => {
    expect(check().outcome).toBe('not-applicable');
  });

  it('passes when no threshold is crossed', () => {
    expect(check(reporting(), perf(100, 90)).outcome).toBe('pass');
  });

  it('fails a crossed threshold with no anomaly entry', () => {
    expect(check(reporting(), perf(100, 70)).outcome).toBe('fail');
  });

  it('passes a crossed threshold that has an answered anomaly entry', () => {
    const anomalies = [{ metric: 'clicks', disposition: 'seasonal; monitoring' }];
    expect(check(reporting({ anomalies }), perf(100, 70)).outcome).toBe('pass');
  });

  it('fails an anomaly with no disposition', () => {
    const anomalies = [{ metric: 'clicks', disposition: '' }];
    expect(check(reporting({ anomalies }), perf(100, 90)).outcome).toBe('fail');
  });

  it('honours rises', () => {
    const thresholds = [{ metric: 'clicks', engine: 'google', change: 0.5 }];
    expect(check(reporting({ thresholds }), perf(100, 160)).outcome).toBe('fail');
    expect(check(reporting({ thresholds }), perf(100, 120)).outcome).toBe('pass');
  });

  it('warns when the data cannot show a change', () => {
    expect(check(reporting()).outcome).toBe('warn');
    const single = { owner: 'Jane', recordedAt: '2026-09-10T00:00:00.000Z', performance: [{ page: 'https://www.example.com/', clicks: 1, impressions: 2, period: '2026-07' }] };
    expect(check(reporting(), single).outcome).toBe('warn');
    const bing = [{ metric: 'clicks', engine: 'bing', change: -0.2 }];
    expect(check(reporting({ thresholds: bing }), perf(100, 10)).outcome).toBe('warn');
  });

  it('warns on no thresholds, no rhythm, no owner or an overdue record', () => {
    expect(check(reporting({ thresholds: [] }), perf(100, 90)).outcome).toBe('warn');
    expect(check(reporting({ rhythm: '' }), perf(100, 90)).outcome).toBe('warn');
    expect(check(reporting({ owner: ' ' }), perf(100, 90)).outcome).toBe('warn');
    expect(check(reporting({ nextReviewAt: '2026-09-15T00:00:00.000Z' }), perf(100, 90)).outcome).toBe('warn');
  });
});
