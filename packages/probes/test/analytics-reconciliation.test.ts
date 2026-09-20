/** `analytics-reconciliation` (6.7): two sources agree, or the gap is explained. */

import { describe, expect, it } from 'vitest';
import type { CrawlResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const pair = (a: number, b: number, over: Record<string, unknown> = {}) => ({
  metric: 'sessions',
  period: '2026-08-01/2026-08-31',
  sourceA: { name: 'ga4', value: a },
  sourceB: { name: 'server-logs', value: b },
  ...over,
});
const record = (reported: unknown[], over: Record<string, unknown> = {}) => ({
  owner: 'Jane',
  recordedAt: '2026-09-01T00:00:00.000Z',
  measurementIds: ['G-ABC123DEF4'],
  consentDefault: 'granted',
  events: [],
  reported,
  ...over,
});

const check = (rec?: unknown): Observation =>
  (probeById('analytics-reconciliation') as SiteProbe).run({
    origin: 'https://www.example.com',
    flags: [],
    crawl: { crawledAt: '2026-09-19T12:00:00.000Z', pages: [], sitemaps: [] } as unknown as CrawlResult,
    inputs: (rec === undefined ? {} : { analytics: rec }) as never,
  });

describe('analytics-reconciliation', () => {
  it('is not applicable without a section or without reported pairs', () => {
    expect(check().outcome).toBe('not-applicable');
    expect(check(record([])).outcome).toBe('not-applicable');
  });

  it('passes pairs within 5%', () => {
    expect(check(record([pair(1000, 960)])).outcome).toBe('pass');
    expect(check(record([pair(0, 0)])).outcome).toBe('pass');
  });

  it('warns on a pair more than 5% apart', () => {
    expect(check(record([pair(1000, 920)])).outcome).toBe('warn');
  });

  it('fails a pair more than 10% apart with no explanation', () => {
    expect(check(record([pair(1000, 800)])).outcome).toBe('fail');
    expect(check(record([pair(0, 50)])).outcome).toBe('fail');
  });

  it('warns rather than fails once the wide gap is explained', () => {
    expect(check(record([pair(1000, 800, { explanation: 'bots filtered by GA4' })])).outcome).toBe('warn');
  });

  it('holds a record with no owner', () => {
    expect(check(record([pair(1000, 990)], { owner: '' })).outcome).toBe('warn');
  });
});
