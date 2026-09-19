/** `indexation-review` (6.1): does the Page indexing report contradict the crawl. */

import { describe, expect, it } from 'vitest';
import type { CrawlResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const at = '2026-09-01T00:00:00.000Z';
const home = 'https://www.example.com/';
const page = (url: string, over: Record<string, unknown> = {}) => ({
  normalizedUrl: url,
  fetch: { status: 200, redirectChain: [], headers: {} },
  extracted: { metaRobots: null, canonical: null },
  ...over,
});
const record = (pageIndexing?: unknown[]) => ({ owner: 'Jane', recordedAt: at, ...(pageIndexing === undefined ? {} : { pageIndexing }) });

const check = (searchConsole?: unknown, pages: unknown[] = [page(home)]): Observation =>
  (probeById('indexation-review') as SiteProbe).run({
    origin: 'https://www.example.com',
    flags: [],
    crawl: { crawledAt: '2026-09-19T12:00:00.000Z', pages, blockedByRobots: [] } as unknown as CrawlResult,
    ...(searchConsole === undefined ? {} : { inputs: { searchConsole } as never }),
  });

describe('indexation-review', () => {
  it('is not applicable without a page indexing report', () => {
    expect(check().outcome).toBe('not-applicable');
    expect(check(record()).outcome).toBe('not-applicable');
  });

  it('fails an indexable page listed as noindexed or blocked by robots', () => {
    expect(check(record([{ url: home, reason: "Excluded by 'noindex' tag" }])).outcome).toBe('fail');
    expect(check(record([{ url: home, reason: 'Blocked by robots.txt' }])).outcome).toBe('fail');
  });

  it('warns on "Crawled - currently not indexed"', () => {
    expect(check(record([{ url: home, reason: 'Crawled - currently not indexed' }])).outcome).toBe('warn');
  });

  it('does not judge a page the crawl calls noindex or canonicalised elsewhere', () => {
    const noindex = page(home, { extracted: { metaRobots: 'noindex', canonical: null } });
    const elsewhere = page(home, { extracted: { metaRobots: null, canonical: 'https://www.example.com/main' } });
    const rows = [{ url: home, reason: "Excluded by 'noindex' tag" }];
    expect(check(record(rows), [noindex]).outcome).toBe('pass');
    expect(check(record(rows), [elsewhere]).outcome).toBe('pass');
  });

  it('ignores other reasons and URLs the crawl did not fetch', () => {
    const rows = [
      { url: home, reason: 'Duplicate without user-selected canonical' },
      { url: 'https://www.example.com/missing', reason: 'Blocked by robots.txt' },
    ];
    expect(check(record(rows)).outcome).toBe('pass');
  });
});
