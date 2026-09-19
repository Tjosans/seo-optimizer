/** `content-decay` (7.2): does every URL that lost search clicks have a decision. */

import { describe, expect, it } from 'vitest';
import type { CrawlResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const at = '2026-09-01T00:00:00.000Z';
const early = '2026-03-01/2026-05-31';
const late = '2026-06-01/2026-08-31';
const a = 'https://www.example.com/a';
const b = 'https://www.example.com/b';
const row = (page: string, clicks: number, period: string, query?: string) => ({
  page,
  clicks,
  impressions: clicks * 10,
  period,
  ...(query === undefined ? {} : { query }),
});
const decision = (url: string, over: Record<string, unknown> = {}) => ({
  url,
  decision: 'refresh',
  decidedAt: at,
  owner: 'Jane',
  recordedAt: at,
  ...over,
});

const check = (performance?: unknown[], contentDecisions?: unknown[]): Observation =>
  (probeById('content-decay') as SiteProbe).run({
    origin: 'https://www.example.com',
    flags: [],
    crawl: { crawledAt: '2026-09-19T12:00:00.000Z', pages: [], blockedByRobots: [] } as unknown as CrawlResult,
    inputs: {
      ...(performance === undefined ? {} : { searchConsole: { owner: 'Jane', recordedAt: at, performance } }),
      ...(contentDecisions === undefined ? {} : { contentDecisions }),
    } as never,
  });

describe('content-decay', () => {
  it('is not applicable without two periods of performance', () => {
    expect(check().outcome).toBe('not-applicable');
    expect(check([row(a, 500, early)]).outcome).toBe('not-applicable');
  });

  it('fails a declining URL with no decision', () => {
    expect(check([row(a, 500, early), row(a, 300, late)]).outcome).toBe('fail');
    expect(check([row(a, 500, early), row(b, 10, late)]).outcome).toBe('fail');
  });

  it('passes when every declining URL has a decision', () => {
    expect(check([row(a, 500, early), row(a, 300, late)], [decision(a)]).outcome).toBe('pass');
  });

  it('does not count small, stable or per-query rows', () => {
    expect(check([row(a, 99, early), row(a, 0, late), row(b, 500, early), row(b, 350, late)]).outcome).toBe('pass');
    expect(check([row(a, 500, early, 'shoes'), row(a, 1, late, 'shoes'), row(b, 5, early), row(b, 5, late)]).outcome).toBe('pass');
  });

  it('warns on a decision record with no owner and on periods it cannot order', () => {
    expect(check([row(a, 500, early), row(a, 300, late)], [decision(a, { owner: '' })]).outcome).toBe('warn');
    expect(check([row(a, 500, 'Last 3 months'), row(a, 300, late)]).outcome).toBe('warn');
  });
});
