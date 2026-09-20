/** `keyword-intent-map` (0.2): the supplied keyword map against the crawl. */

import { describe, expect, it } from 'vitest';
import { parseInputs } from '@seo/core';
import type { CrawlResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const A = 'https://www.example.com/a';
const B = 'https://www.example.com/b';

const page = (url: string, over: Record<string, unknown> = {}) => ({
  normalizedUrl: url,
  fetch: { status: 200, headers: {} },
  extracted: null,
  ...over,
});
const row = (url: string) => ({ url, purpose: 'Explain it', queries: ['how it works'] });

const check = (keywordMap: unknown, pages: unknown[]): Observation =>
  (probeById('keyword-intent-map') as SiteProbe).run({
    origin: 'https://www.example.com',
    flags: [],
    crawl: { crawledAt: '2026-09-19T12:00:00.000Z', pages } as unknown as CrawlResult,
    inputs: (keywordMap === undefined ? {} : { keywordMap }) as never,
  });

describe('keyword-intent-map', () => {
  it('is not applicable without a map', () => {
    expect(check(undefined, [page(A)]).outcome).toBe('not-applicable');
  });

  it('passes when mapped pages are indexable and most pages are mapped', () => {
    expect(check([row(A)], [page(A), page(B)]).outcome).toBe('pass');
  });

  it('fails a mapped URL that was not crawled, or is not a 200', () => {
    expect(check([row(A), row(B)], [page(A)]).outcome).toBe('fail');
    expect(check([row(A)], [page(A, { fetch: { status: 404, headers: {} } })]).outcome).toBe('fail');
  });

  it('warns when more than half the indexable pages have no mapping', () => {
    const c = 'https://www.example.com/c';
    expect(check([row(A)], [page(A), page(B), page(c)]).outcome).toBe('warn');
  });

  it('is parsed strictly', () => {
    expect(parseInputs({ keywordMap: [row(A)] }).keywordMap?.[0]?.queries).toEqual(['how it works']);
    expect(() => parseInputs({ keywordMap: [{ ...row(A), queries: [] }] })).toThrow(/queries/);
    expect(() => parseInputs({ keywordMap: [row(A), row(A)] })).toThrow(/duplicate/);
    expect(() => parseInputs({ keywordMap: [{ ...row(A), extra: 1 }] })).toThrow(/extra/);
  });
});
