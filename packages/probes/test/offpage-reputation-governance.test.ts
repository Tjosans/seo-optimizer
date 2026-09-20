/** `offpage-reputation-governance` (7.6): review destinations against their recheck dates. */

import { describe, expect, it } from 'vitest';
import { parseInputs } from '@seo/core';
import type { CrawlResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const dest = (over: Record<string, unknown> = {}) => ({
  destination: 'Trustpilot',
  policyDate: '2026-08-01T09:00:00Z',
  owner: 'Sam',
  recheckAt: '2027-02-01T09:00:00Z',
  ...over,
});

const record = (over: Record<string, unknown> = {}) => ({
  destinations: [dest()],
  owner: 'Jane Doe',
  recordedAt: '2026-09-10T09:00:00Z',
  ...over,
});

const check = (section: unknown): Observation =>
  (probeById('offpage-reputation-governance') as SiteProbe).run({
    origin: 'https://example.com',
    flags: [],
    crawl: { crawledAt: '2026-09-19T12:00:00.000Z', pages: [], auxiliary: [] } as unknown as CrawlResult,
    inputs: (section === undefined ? {} : parseInputs({ reviewDestinations: section })) as never,
  });

describe('offpage-reputation-governance', () => {
  it('is not applicable without a record', () => {
    expect(check(undefined).outcome).toBe('not-applicable');
  });

  it('passes destinations whose recheck is ahead', () => {
    expect(check(record()).outcome).toBe('pass');
  });

  it('fails a destination past recheckAt', () => {
    expect(check(record({ destinations: [dest(), dest({ destination: 'G2', recheckAt: '2026-09-01T00:00:00Z' })] })).outcome).toBe('fail');
  });

  it('holds an unowned destination, an empty list, or an unowned record', () => {
    expect(check(record({ destinations: [dest({ owner: '' })] })).outcome).toBe('warn');
    expect(check(record({ destinations: [] })).outcome).toBe('warn');
    expect(check(record({ owner: '' })).outcome).toBe('warn');
  });

  it('is parsed strictly', () => {
    expect(() => parseInputs({ reviewDestinations: record({ extra: 1 }) })).toThrow(/extra/);
    expect(() => parseInputs({ reviewDestinations: record({ destinations: [dest({ recheckAt: 'soon' })] }) })).toThrow(/recheckAt/);
    expect(() => parseInputs({ reviewDestinations: record({ destinations: [dest({ destination: '' })] }) })).toThrow(/destination/);
  });
});
