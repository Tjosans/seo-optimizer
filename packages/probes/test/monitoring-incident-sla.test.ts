/** `monitoring-incident-sla` (7.1): the incident log against `canary.lastTestAlertAt` and the interval the record names. */

import { describe, expect, it } from 'vitest';
import { parseInputs } from '@seo/core';
import type { CrawlResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const entry = (over: Record<string, unknown> = {}) => ({
  openedAt: '2026-09-01T09:00:00Z',
  owner: 'Sam',
  remediation: 'Rolled back the release',
  closedAt: '2026-09-01T11:00:00Z',
  ...over,
});

const incidents = (over: Record<string, unknown> = {}) => ({
  testAlertIntervalDays: 30,
  entries: [entry()],
  owner: 'Jane Doe',
  recordedAt: '2026-09-10T09:00:00Z',
  ...over,
});

const canary = (lastTestAlertAt?: string) => ({
  urls: ['https://example.com/'],
  targetMinutes: 5,
  recipient: 'oncall@example.com',
  ...(lastTestAlertAt === undefined ? {} : { lastTestAlertAt }),
  owner: 'Jane Doe',
  recordedAt: '2026-09-10T09:00:00Z',
});

const check = (section: unknown, lastTestAlertAt: string | null = '2026-09-10T09:00:00Z'): Observation =>
  (probeById('monitoring-incident-sla') as SiteProbe).run({
    origin: 'https://example.com',
    flags: [],
    crawl: { crawledAt: '2026-09-19T12:00:00.000Z', pages: [], auxiliary: [] } as unknown as CrawlResult,
    inputs: (section === undefined ? {} : parseInputs({ incidents: section, canary: canary(lastTestAlertAt ?? undefined) })) as never,
  });

describe('monitoring-incident-sla', () => {
  it('is not applicable without a record', () => {
    expect(check(undefined).outcome).toBe('not-applicable');
  });

  it('passes owned, remediated incidents and a recent test alert', () => {
    expect(check(incidents()).outcome).toBe('pass');
    expect(check(incidents({ entries: [] })).outcome).toBe('pass');
  });

  it('fails an incident with no owner or no remediation', () => {
    expect(check(incidents({ entries: [entry({ owner: '' })] })).outcome).toBe('fail');
    expect(check(incidents({ entries: [entry({ remediation: undefined })] })).outcome).toBe('fail');
  });

  it('fails a test alert older than the interval, and passes one inside it', () => {
    expect(check(incidents({ testAlertIntervalDays: 7 })).outcome).toBe('fail');
    expect(check(incidents({ testAlertIntervalDays: 10 })).outcome).toBe('pass');
  });

  it('holds when no test alert is on record, or the record is unowned', () => {
    expect(check(incidents(), null).outcome).toBe('warn');
    expect(check(incidents({ owner: '' })).outcome).toBe('warn');
  });

  it('is parsed strictly', () => {
    expect(() => parseInputs({ incidents: incidents({ extra: 1 }) })).toThrow(/extra/);
    expect(() => parseInputs({ incidents: incidents({ testAlertIntervalDays: 0 }) })).toThrow(/testAlertIntervalDays/);
    expect(() => parseInputs({ incidents: incidents({ entries: [entry({ openedAt: 'soon' })] }) })).toThrow(/openedAt/);
    expect(() => parseInputs({ incidents: incidents({ entries: [entry({ closedAt: '2026-08-01T00:00:00Z' })] }) })).toThrow(/closedAt/);
  });
});
