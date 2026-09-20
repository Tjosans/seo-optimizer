/** `ai-visibility-baseline` (6.4): no invented history, no engines blended into one score. */

import { describe, expect, it } from 'vitest';
import type { CrawlResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const row = (over: Record<string, unknown> = {}) => ({
  report: 'Search Console AI performance',
  metric: 'impressions',
  scope: 'Google',
  period: '2026-09-01/2026-09-30',
  availableFrom: '2026-08-31T00:00:00.000Z',
  ...over,
});
const record = (reports: unknown[] = [row()], over: Record<string, unknown> = {}) => ({
  owner: 'Jane',
  recordedAt: '2026-09-01T00:00:00.000Z',
  reports,
  ...over,
});

const check = (rec?: unknown): Observation =>
  (probeById('ai-visibility-baseline') as SiteProbe).run({
    origin: 'https://www.example.com',
    flags: [],
    crawl: { crawledAt: '2026-09-19T12:00:00.000Z', pages: [], sitemaps: [] } as unknown as CrawlResult,
    inputs: (rec === undefined ? {} : { aiBaseline: rec }) as never,
  });

describe('ai-visibility-baseline', () => {
  it('is not applicable without a section', () => {
    expect(check().outcome).toBe('not-applicable');
  });

  it('passes a per-engine report inside its history', () => {
    expect(check(record()).outcome).toBe('pass');
  });

  it('fails a period that starts before the report was available', () => {
    expect(check(record([row({ period: '2026-06-01/2026-09-30' })])).outcome).toBe('fail');
  });

  it('fails a metric that combines engines', () => {
    expect(check(record([row({ metric: 'AI visibility score' })])).outcome).toBe('fail');
    expect(check(record([row({ scope: 'Google + Bing' })])).outcome).toBe('fail');
    expect(check(record([row({ scope: 'All engines' })])).outcome).toBe('fail');
  });

  it('holds a period it cannot read and a record with no owner', () => {
    expect(check(record([row({ period: 'Last 3 months' })])).outcome).toBe('warn');
    expect(check(record([row()], { owner: '' })).outcome).toBe('warn');
  });
});
