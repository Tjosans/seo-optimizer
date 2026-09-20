/** `lab-perf-budget` (1.5): do the Lighthouse reports stay inside the supplied performance policy. */

import { describe, expect, it } from 'vitest';
import type { CrawlResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const at = '2026-09-01T00:00:00.000Z';
const policy = (over: Record<string, unknown> = {}) => ({
  thresholds: { lcpMs: 2500, cls: 0.1, tbtMs: 200 },
  testProfile: 'mobile',
  owner: 'Jane',
  revision: at,
  ...over,
});
const metrics = (over: Record<string, unknown> = {}) => ({ lcpMs: 2000, cls: 0.05, tbtMs: 100, testProfile: 'mobile', fetchedAt: '2026-09-10T00:00:00.000Z', ...over });
const report = (over: Record<string, unknown> = {}, url = 'https://www.example.com/') => ({ url, path: 'r.json', metrics: metrics(over) });
const record = (reports: unknown[], perfPolicy: unknown = policy()) => ({ owner: 'Jane', recordedAt: at, reports, ...(perfPolicy === null ? {} : { perfPolicy }) });

const check = (lighthouse?: unknown): Observation =>
  (probeById('lab-perf-budget') as SiteProbe).run({
    origin: 'https://www.example.com',
    flags: [],
    crawl: { crawledAt: '2026-09-19T12:00:00.000Z', pages: [] } as unknown as CrawlResult,
    ...(lighthouse === undefined ? {} : { inputs: { lighthouse } as never }),
  });

describe('lab-perf-budget', () => {
  it('is not applicable without a policy', () => {
    expect(check().outcome).toBe('not-applicable');
    expect(check(record([report()], null)).outcome).toBe('not-applicable');
  });

  it('passes reports inside every threshold', () => {
    expect(check(record([report()])).outcome).toBe('pass');
  });

  it('fails a report over any threshold', () => {
    expect(check(record([report({ lcpMs: 4000 })])).outcome).toBe('fail');
    expect(check(record([report({ cls: 0.3 })])).outcome).toBe('fail');
    expect(check(record([report({ tbtMs: 900 })])).outcome).toBe('fail');
  });

  it('fails a report run under another test profile', () => {
    expect(check(record([report({ testProfile: 'desktop' })])).outcome).toBe('fail');
  });

  it('lets a failure outrank a held record', () => {
    const held = { ...record([report({ lcpMs: 4000 })]), owner: '' };
    expect(check(held).outcome).toBe('fail');
  });

  it('holds what it cannot judge', () => {
    expect(check(record([])).outcome).toBe('warn');
    expect(check(record([{ url: 'https://www.example.com/', path: 'r.json' }])).outcome).toBe('warn');
    expect(check(record([report({ tbtMs: undefined })])).outcome).toBe('warn');
    expect(check(record([report({ fetchedAt: '2026-08-01T00:00:00.000Z' })])).outcome).toBe('warn');
    expect(check({ ...record([report()]), owner: '' }).outcome).toBe('warn');
  });
});
