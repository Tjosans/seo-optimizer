/** `url-inspection` (5.4): does Google's view of an inspected URL agree with the crawl. */

import { describe, expect, it } from 'vitest';
import type { CrawlResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const at = '2026-09-01T00:00:00.000Z';
const page = (url: string, over: Record<string, unknown> = {}) => ({
  normalizedUrl: url,
  fetch: { status: 200, redirectChain: [], headers: {} },
  extracted: { metaRobots: null, canonical: null },
  ...over,
});
const row = (url: string, over: Record<string, unknown> = {}) => ({
  url,
  verdict: 'Pass',
  coverage: 'Submitted and indexed',
  robots: 'Allowed',
  indexing: 'Indexing allowed',
  ...over,
});
const record = (urlInspection?: unknown[]) => ({ owner: 'Jane', recordedAt: at, ...(urlInspection === undefined ? {} : { urlInspection }) });
const home = 'https://www.example.com/';

const check = (searchConsole?: unknown, pages: unknown[] = [page(home)], blockedByRobots: string[] = []): Observation =>
  (probeById('url-inspection') as SiteProbe).run({
    origin: 'https://www.example.com',
    flags: [],
    crawl: { crawledAt: '2026-09-19T12:00:00.000Z', pages, blockedByRobots } as unknown as CrawlResult,
    ...(searchConsole === undefined ? {} : { inputs: { searchConsole } as never }),
  });

describe('url-inspection', () => {
  it('is not applicable without inspection results', () => {
    expect(check().outcome).toBe('not-applicable');
    expect(check(record()).outcome).toBe('not-applicable');
  });

  it('passes an inspection that agrees with the crawl', () => {
    expect(check(record([row(home, { googleCanonical: home })])).outcome).toBe('pass');
  });

  it('fails robots, noindex and a different Google canonical on an indexable page', () => {
    expect(check(record([row(home, { robots: 'Blocked by robots.txt' })])).outcome).toBe('fail');
    expect(check(record([row(home, { indexing: "Blocked by 'noindex' tag" })])).outcome).toBe('fail');
    expect(check(record([row(home, { googleCanonical: 'https://www.example.com/other' })])).outcome).toBe('fail');
  });

  it('compares against the declared canonical', () => {
    const declared = page(home, { extracted: { metaRobots: null, canonical: 'https://www.example.com/main' } });
    expect(check(record([row(home, { googleCanonical: 'https://www.example.com/main' })]), [declared]).outcome).toBe('pass');
  });

  it('does not fail a page the crawl itself calls noindex', () => {
    const noindex = page(home, { extracted: { metaRobots: 'noindex', canonical: null } });
    expect(check(record([row(home, { indexing: "Blocked by 'noindex' tag" })]), [noindex]).outcome).toBe('pass');
  });

  it('treats a URL unknown to Google as unavailable, never a fail', () => {
    const unknown = row(home, { verdict: 'Neutral', coverage: 'URL is unknown to Google', robots: 'Blocked', googleCanonical: 'https://x.test/' });
    expect(check(record([unknown])).outcome).toBe('not-applicable');
    expect(check(record([unknown, row(home + 'a')]), [page(home), page(home + 'a')]).outcome).toBe('pass');
  });

  it('warns on an inspected URL the crawl did not reach', () => {
    expect(check(record([row('https://www.example.com/missing')])).outcome).toBe('warn');
  });
});
