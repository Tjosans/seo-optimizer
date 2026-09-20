/** `field-cwv-monitor` (6.2): field p75 graded by Google thresholds, Poor needs an action, a gap is never Good. */

import { describe, expect, it } from 'vitest';
import type { CrawlResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const at = '2026-09-10T00:00:00.000Z';
const action = (metric: string) => ({ metric, owner: 'Jane', retestAt: '2026-10-01T00:00:00.000Z' });
const population = (over: Record<string, unknown> = {}) => ({
  source: 'crux-origin',
  target: 'https://www.example.com',
  formFactor: 'mobile',
  lcpMs: 2000,
  inpMs: 150,
  cls: 0.05,
  actions: [],
  ...over,
});
const record = (populations: unknown[], over: Record<string, unknown> = {}) => ({ owner: 'Jane', recordedAt: at, populations, ...over });

const check = (crux?: unknown): Observation =>
  (probeById('field-cwv-monitor') as SiteProbe).run({
    origin: 'https://www.example.com',
    flags: [],
    crawl: { crawledAt: '2026-09-19T12:00:00.000Z', pages: [] } as unknown as CrawlResult,
    ...(crux === undefined ? {} : { inputs: { crux } as never }),
  });

describe('field-cwv-monitor', () => {
  it('is not applicable without field data', () => {
    expect(check().outcome).toBe('not-applicable');
  });

  it('grades Good values without claiming the site is Good', () => {
    const result = check(record([population()]));
    expect(result.outcome).toBe('pass');
    expect(result.summary).toMatch(/does not claim/);
  });

  it('fails a Poor metric with no action record, at each boundary', () => {
    expect(check(record([population({ lcpMs: 4001 })])).outcome).toBe('fail');
    expect(check(record([population({ inpMs: 501 })])).outcome).toBe('fail');
    expect(check(record([population({ cls: 0.26 })])).outcome).toBe('fail');
  });

  it('does not fail Needs Improvement, and accepts an owned action on Poor', () => {
    expect(check(record([population({ lcpMs: 4000, inpMs: 500, cls: 0.25 })])).outcome).toBe('pass');
    expect(check(record([population({ lcpMs: 5000, actions: [action('lcp')] })])).outcome).toBe('pass');
    expect(check(record([population({ lcpMs: 5000, actions: [action('inp')] })])).outcome).toBe('fail');
  });

  it('holds a missing metric as unavailable, never Good', () => {
    const result = check(record([population({ inpMs: undefined })]));
    expect(result.outcome).toBe('warn');
    expect(result.summary).toMatch(/unavailable/);
  });

  it('lets a failure outrank a gap, and holds an unowned or empty record', () => {
    expect(check(record([population({ inpMs: undefined, lcpMs: 9000 })])).outcome).toBe('fail');
    expect(check(record([population()], { owner: '' })).outcome).toBe('warn');
    expect(check(record([])).outcome).toBe('warn');
  });
});
