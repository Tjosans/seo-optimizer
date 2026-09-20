/** `template-lab-perf` (4.5): every priority urlMatrix pattern has a current Lighthouse report inside the policy. */

import { describe, expect, it } from 'vitest';
import type { CrawlResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const at = '2026-09-01T00:00:00.000Z';
const policy = {
  thresholds: { lcpMs: 2500, cls: 0.1, tbtMs: 200 },
  testProfile: 'mobile',
  owner: 'Jane',
  revision: at,
};
const metrics = (over: Record<string, unknown> = {}) => ({ lcpMs: 2000, cls: 0.05, tbtMs: 100, testProfile: 'mobile', fetchedAt: '2026-09-10T00:00:00.000Z', ...over });
const report = (url: string, over: Record<string, unknown> = {}) => ({ url, path: 'r.json', metrics: metrics(over) });
const row = (pattern: string, over: Record<string, unknown> = {}) => ({
  owner: 'Jane', recordedAt: at, pattern, priority: true, status: 200, indexable: true, canonical: 'self', inSitemap: true, access: 'public', ...over,
});
const record = (reports: unknown[], over: Record<string, unknown> = {}) => ({ owner: 'Jane', recordedAt: at, reports, perfPolicy: policy, ...over });

const check = (lighthouse?: unknown, urlMatrix?: unknown): Observation =>
  (probeById('template-lab-perf') as SiteProbe).run({
    origin: 'https://www.example.com',
    flags: [],
    crawl: { crawledAt: '2026-09-19T12:00:00.000Z', pages: [] } as unknown as CrawlResult,
    inputs: {
      ...(lighthouse === undefined ? {} : { lighthouse }),
      ...(urlMatrix === undefined ? {} : { urlMatrix }),
    } as never,
  });

const home = 'https://www.example.com/';
const product = 'https://www.example.com/products/shoe';

describe('template-lab-perf', () => {
  it('is not applicable without a policy or a priority template', () => {
    expect(check(undefined, [row('/')]).outcome).toBe('not-applicable');
    expect(check(record([]), undefined).outcome).toBe('not-applicable');
    expect(check(record([]), [row('/', { priority: false })]).outcome).toBe('not-applicable');
    expect(check(record([]), [row('/staging', { environment: 'staging' })]).outcome).toBe('not-applicable');
  });

  it('passes templates with current reports inside the policy', () => {
    const out = check(record([report(home), report(product)]), [row('/'), row('/products/*')]);
    expect(out.outcome).toBe('pass');
  });

  it('fails a template with no report', () => {
    expect(check(record([report(home)]), [row('/'), row('/products/*')]).outcome).toBe('fail');
  });

  it('fails a template over a threshold or under another profile', () => {
    expect(check(record([report(home, { lcpMs: 4000 })]), [row('/')]).outcome).toBe('fail');
    expect(check(record([report(home, { testProfile: 'desktop' })]), [row('/')]).outcome).toBe('fail');
  });

  it('fails a template whose only report predates the policy revision', () => {
    expect(check(record([report(home, { fetchedAt: '2026-08-01T00:00:00.000Z' })]), [row('/')]).outcome).toBe('fail');
  });

  it('accepts a current report beside a stale one', () => {
    const reports = [report(home, { fetchedAt: '2026-08-01T00:00:00.000Z', lcpMs: 9000 }), report(home)];
    expect(check(record(reports), [row('/')]).outcome).toBe('pass');
  });

  it('holds what it cannot judge', () => {
    expect(check(record([{ url: home, path: 'r.json' }]), [row('/')]).outcome).toBe('warn');
    expect(check(record([report(home, { tbtMs: undefined })]), [row('/')]).outcome).toBe('warn');
    expect(check(record([report(home)], { owner: '' }), [row('/')]).outcome).toBe('warn');
  });
});
