/** `schema-hreflang-maintenance` (7.9): JSON-LD and hreflang against the previous audit's. */

import { describe, expect, it } from 'vitest';
import type { CrawlResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, PreviousAudit, SiteProbe } from '@seo/probes';

const A = 'https://www.example.com/en';
const B = 'https://www.example.com/de';
type Alt = { hreflang: string; url: string };

const oldPage = (url: string, jsonLdTypes: string[], hreflang: Alt[]) => ({
  url, status: 200, finalUrl: url, metaRobots: null, xRobotsTag: null, canonical: null, title: null, jsonLdTypes, hreflang,
});
const before = (pages: ReturnType<typeof oldPage>[]): PreviousAudit =>
  ({ schema: 1, origin: 'https://www.example.com', takenAt: '2026-08-01T00:00:00.000Z', pages, probes: [] }) as PreviousAudit;
const nowPage = (url: string, types: string[], hreflang: Alt[], jsonLdErrors = 0) => ({
  normalizedUrl: url,
  fetch: { status: 200, headers: {} },
  extracted: { jsonLd: types.map((t) => ({ '@type': t })), jsonLdErrors, hreflang },
});
const check = (pages: unknown[], previous: PreviousAudit | null): Observation =>
  (probeById('schema-hreflang-maintenance') as SiteProbe).run({
    origin: 'https://www.example.com',
    flags: [],
    crawl: { crawledAt: '2026-09-19T12:00:00.000Z', pages } as unknown as CrawlResult,
    previous,
  });

const ab: Alt[] = [{ hreflang: 'de', url: B }];
const ba: Alt[] = [{ hreflang: 'en', url: A }];
const prev = before([oldPage(A, ['Product'], ab), oldPage(B, [], ba)]);

describe('schema-hreflang-maintenance', () => {
  it('is not applicable without a previous audit or overlap', () => {
    expect(check([nowPage(A, [], [])], null).outcome).toBe('not-applicable');
    expect(check([nowPage('https://www.example.com/x', [], [])], prev).outcome).toBe('not-applicable');
  });

  it('passes when nothing regressed', () => {
    expect(check([nowPage(A, ['Product'], ab), nowPage(B, [], ba)], prev).outcome).toBe('pass');
  });

  it('fails JSON-LD that parsed before and does not now', () => {
    expect(check([nowPage(A, [], ab, 1), nowPage(B, [], ba)], prev).outcome).toBe('fail');
  });

  it('warns a schema type removed without a parse error', () => {
    expect(check([nowPage(A, [], ab), nowPage(B, [], ba)], prev).outcome).toBe('warn');
  });

  it('fails a reciprocal hreflang pair that lost a side', () => {
    expect(check([nowPage(A, ['Product'], ab), nowPage(B, [], [])], prev).outcome).toBe('fail');
  });

  it('ignores a pair whose page was not crawled again', () => {
    expect(check([nowPage(A, ['Product'], ab)], prev).outcome).toBe('pass');
  });
});
