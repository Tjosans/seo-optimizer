/** `log-file-analysis` (7.8): what search crawlers met, from an access log a person supplied. */

import { describe, expect, it } from 'vitest';
import type { CrawlResult } from '@seo/crawler';
import { parseRobots } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const GOOGLE = 'Mozilla/5.0 (compatible; Googlebot/2.1)';
const BING = 'Mozilla/5.0 (compatible; bingbot/2.0)';
const hit = (over: Record<string, unknown> = {}) => ({
  at: '2026-09-10T10:00:00.000Z',
  method: 'GET',
  path: '/shop',
  status: 200,
  userAgent: GOOGLE,
  ...over,
});
const many = (n: number, over: Record<string, unknown> = {}) => Array.from({ length: n }, () => hit(over));
const record = (hits: unknown[], over: Record<string, unknown> = {}) => ({
  path: 'access.log',
  owner: 'Jane',
  recordedAt: '2026-09-11T00:00:00.000Z',
  hits,
  skippedLines: 0,
  ...over,
});

const check = (rec?: unknown, robots = ''): Observation =>
  (probeById('log-file-analysis') as SiteProbe).run({
    origin: 'https://www.example.com',
    flags: [],
    crawl: { crawledAt: '2026-09-19T12:00:00.000Z', pages: [], sitemaps: [], robots: parseRobots(robots) } as unknown as CrawlResult,
    inputs: (rec === undefined ? {} : { serverLogs: rec }) as never,
  });

describe('log-file-analysis', () => {
  it('is not applicable without a log, unread hits or crawler hits', () => {
    expect(check().outcome).toBe('not-applicable');
    expect(check(record([], { hits: undefined })).outcome).toBe('not-applicable');
    expect(check(record(many(5, { userAgent: 'Mozilla/5.0 Firefox' }))).outcome).toBe('not-applicable');
  });

  it('passes clean crawler traffic and says the user agent is unverified', () => {
    const result = check(record([...many(50), ...many(5, { userAgent: BING })]));
    expect(result.outcome).toBe('pass');
    expect(result.summary).toMatch(/unverified/);
  });

  it('fails a 5xx rate over 1% and tolerates one at 1%', () => {
    expect(check(record([...many(98), ...many(2, { status: 503 })])).outcome).toBe('fail');
    expect(check(record([...many(99), hit({ status: 500 })])).outcome).toBe('pass');
  });

  it('ignores errors served to other user agents', () => {
    expect(check(record([...many(50), ...many(50, { status: 500, userAgent: 'curl/8' })])).outcome).toBe('pass');
  });

  it('fails hits on URLs robots.txt disallows', () => {
    const robots = 'User-agent: *\nDisallow: /cart';
    expect(check(record([...many(20), hit({ path: '/cart/checkout' })]), robots).outcome).toBe('fail');
    expect(check(record(many(20)), robots).outcome).toBe('pass');
  });

  it('warns when parameter URLs take over a quarter of crawler hits', () => {
    expect(check(record([...many(7), ...many(3, { parameterised: true })])).outcome).toBe('warn');
    expect(check(record([...many(3), ...many(1, { parameterised: true })])).outcome).toBe('pass');
  });

  it('holds a record with no owner', () => {
    expect(check(record(many(5), { owner: '' })).outcome).toBe('warn');
  });
});
