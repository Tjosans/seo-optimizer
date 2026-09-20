/** `digital-pr-tracking` (7.5): paid wins and an unowned plan fail. */

import { describe, expect, it } from 'vitest';
import { parseInputs } from '@seo/core';
import type { CrawlResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const win = (over: Record<string, unknown> = {}) => ({
  url: 'https://news.example.org/report',
  date: '2026-08-20T09:00:00Z',
  paid: false,
  ...over,
});

const record = (over: Record<string, unknown> = {}) => ({
  plan: 'Annual benchmark report',
  wins: [win()],
  owner: 'Jane Doe',
  recordedAt: '2026-09-10T09:00:00Z',
  ...over,
});

const check = (section: unknown): Observation =>
  (probeById('digital-pr-tracking') as SiteProbe).run({
    origin: 'https://example.com',
    flags: [],
    crawl: { crawledAt: '2026-09-19T12:00:00.000Z', pages: [], auxiliary: [] } as unknown as CrawlResult,
    inputs: (section === undefined ? {} : parseInputs({ digitalPr: section })) as never,
  });

describe('digital-pr-tracking', () => {
  it('is not applicable without a record', () => {
    expect(check(undefined).outcome).toBe('not-applicable');
  });

  it('passes an owned plan with earned wins', () => {
    expect(check(record()).outcome).toBe('pass');
  });

  it('fails a paid win', () => {
    expect(check(record({ wins: [win(), win({ paid: true })] })).outcome).toBe('fail');
  });

  it('fails a plan with no owner', () => {
    expect(check(record({ owner: '' })).outcome).toBe('fail');
  });

  it('holds a plan with no wins or an overdue record', () => {
    expect(check(record({ wins: [] })).outcome).toBe('warn');
    expect(check(record({ nextReviewAt: '2026-09-01T00:00:00Z' })).outcome).toBe('warn');
  });

  it('is parsed strictly', () => {
    expect(() => parseInputs({ digitalPr: record({ extra: 1 }) })).toThrow(/extra/);
    expect(() => parseInputs({ digitalPr: record({ wins: [win({ paid: 'no' })] }) })).toThrow(/paid/);
    expect(() => parseInputs({ digitalPr: record({ wins: [win({ url: 'nope' })] }) })).toThrow(/url/);
    expect(() => parseInputs({ digitalPr: record({ plan: '' }) })).toThrow(/plan/);
  });
});
