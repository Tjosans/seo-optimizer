/** `backlink-monitor` (6.8): does a disavow submission say why, and what was tried first. */

import { describe, expect, it } from 'vitest';
import { parseInputs } from '@seo/core';
import type { CrawlResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const at = '2026-09-01T00:00:00.000Z';
const disavow = (over: Record<string, unknown> = {}) => ({
  submitted: true,
  reasons: ['paid links from a network'],
  removalAttempts: ['emailed the site owner 2026-08-01'],
  owner: 'Jane',
  recordedAt: at,
  ...over,
});

const check = (record?: unknown): Observation =>
  (probeById('backlink-monitor') as SiteProbe).run({
    origin: 'https://www.example.com',
    flags: [],
    crawl: { crawledAt: '2026-09-19T12:00:00.000Z', pages: [], blockedByRobots: [] } as unknown as CrawlResult,
    inputs: (record === undefined ? {} : { disavow: record }) as never,
  });

describe('backlink-monitor', () => {
  it('is not applicable without a record', () => {
    expect(check().outcome).toBe('not-applicable');
  });

  it('passes when nothing was submitted', () => {
    expect(check(disavow({ submitted: false, reasons: [], removalAttempts: [] })).outcome).toBe('pass');
  });

  it('fails a submission with no reasons or no removal attempts', () => {
    expect(check(disavow({ reasons: [] })).outcome).toBe('fail');
    expect(check(disavow({ removalAttempts: [] })).outcome).toBe('fail');
  });

  it('passes a fully documented submission', () => {
    expect(check(disavow()).outcome).toBe('pass');
  });

  it('warns on a record with no owner', () => {
    expect(check(disavow({ owner: '' })).outcome).toBe('warn');
  });

  it('parses strictly', () => {
    expect(parseInputs({ disavow: disavow() }).disavow?.submitted).toBe(true);
    expect(() => parseInputs({ disavow: disavow({ submitted: 'yes' }) })).toThrow();
    expect(() => parseInputs({ disavow: disavow({ reasons: 'because' }) })).toThrow();
    expect(() => parseInputs({ disavow: disavow({ extra: 1 }) })).toThrow();
  });
});
