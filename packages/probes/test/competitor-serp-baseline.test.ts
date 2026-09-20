/** `competitor-serp-baseline` (0.1): the supplied competitor baseline against the site. */

import { describe, expect, it } from 'vitest';
import { parseInputs } from '@seo/core';
import type { CrawlResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const record = (over: Record<string, unknown> = {}) => ({
  audience: 'Small-business owners',
  market: 'Sweden',
  language: 'sv',
  competitors: ['https://rival.example', 'other.example/shop'],
  baselineAt: '2026-09-01T09:00:00Z',
  owner: 'Jane Doe',
  recordedAt: '2026-09-10T09:00:00Z',
  ...over,
});

const check = (competitorBaseline: unknown): Observation =>
  (probeById('competitor-serp-baseline') as SiteProbe).run({
    origin: 'https://www.example.com',
    flags: [],
    crawl: { crawledAt: '2026-09-19T12:00:00.000Z', pages: [] } as unknown as CrawlResult,
    inputs: (competitorBaseline === undefined ? {} : parseInputs({ competitorBaseline })) as never,
  });

describe('competitor-serp-baseline', () => {
  it('is not applicable without a baseline', () => {
    expect(check(undefined).outcome).toBe('not-applicable');
  });

  it('passes a complete baseline of other sites', () => {
    expect(check(record()).outcome).toBe('pass');
  });

  it('fails a missing field', () => {
    expect(check(record({ market: '' })).outcome).toBe('fail');
    expect(check(record({ competitors: [] })).outcome).toBe('fail');
    expect(check(record({ baselineAt: undefined })).outcome).toBe('fail');
  });

  it('fails a competitor on the site’s own host', () => {
    expect(check(record({ competitors: ['https://example.com/blog', 'rival.example'] })).outcome).toBe('fail');
  });

  it('holds an unowned record', () => {
    expect(check(record({ owner: '' })).outcome).toBe('warn');
  });

  it('is parsed strictly', () => {
    expect(() => parseInputs({ competitorBaseline: record({ extra: 1 }) })).toThrow(/extra/);
    expect(() => parseInputs({ competitorBaseline: record({ baselineAt: 'soon' }) })).toThrow(/baselineAt/);
    expect(() => parseInputs({ competitorBaseline: record({ competitors: 'rival.example' }) })).toThrow(/competitors/);
  });
});
