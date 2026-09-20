/** `content-helpfulness` (3.5): a person's content review, against what the crawl now sees. */

import { describe, expect, it } from 'vitest';
import { parseInputs } from '@seo/core';
import type { CrawlResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const GUIDE = 'https://www.example.com/guides/start';

const page = (url: string, over: Record<string, unknown> = {}) => ({
  normalizedUrl: url,
  fetch: { status: 200, headers: {} },
  extracted: null,
  ...over,
});
const review = (over: Record<string, unknown> = {}) => ({
  url: GUIDE,
  reviewer: 'Jane',
  reviewedAt: '2026-09-10T09:00:00.000Z',
  verdict: 'helpful',
  ...over,
});
const matrixRow = {
  pattern: '/guides/*',
  priority: true,
  status: 200,
  indexable: true,
  canonical: 'self',
  inSitemap: true,
  access: 'public',
  owner: 'Jane',
  recordedAt: '2026-09-10T09:00:00.000Z',
};

const check = (contentReview: unknown, pages: unknown[], urlMatrix: unknown[] = []): Observation =>
  (probeById('content-helpfulness') as SiteProbe).run({
    origin: 'https://www.example.com',
    flags: [],
    crawl: { crawledAt: '2026-09-19T12:00:00.000Z', pages } as unknown as CrawlResult,
    inputs: { ...(contentReview === undefined ? {} : { contentReview }), urlMatrix } as never,
  });

describe('content-helpfulness', () => {
  it('is not applicable without a review', () => {
    expect(check(undefined, [page(GUIDE)], [matrixRow]).outcome).toBe('not-applicable');
  });

  it('passes a helpful, reachable page that is the only priority page', () => {
    expect(check([review()], [page(GUIDE)], [matrixRow]).outcome).toBe('pass');
  });

  it('fails a fails verdict', () => {
    expect(check([review({ verdict: 'fails' })], [page(GUIDE)]).outcome).toBe('fail');
  });

  it('fails a reviewed URL that is now 4xx or noindex', () => {
    expect(check([review()], [page(GUIDE, { fetch: { status: 404, headers: {} } })]).outcome).toBe('fail');
    expect(check([review()], [page(GUIDE, { fetch: { status: 200, headers: { 'x-robots-tag': 'noindex' } } })]).outcome).toBe('fail');
  });

  it('warns a crawled priority page with no review, and a needs-work verdict', () => {
    const other = page('https://www.example.com/guides/other');
    expect(check([review()], [page(GUIDE), other], [matrixRow]).outcome).toBe('warn');
    expect(check([review({ verdict: 'needs-work' })], [page(GUIDE)]).outcome).toBe('warn');
  });

  it('does not judge a reviewed URL the crawl did not reach', () => {
    expect(check([review()], []).outcome).toBe('pass');
  });
});

describe('parseInputs contentReview', () => {
  it('reads reviews', () => {
    expect(parseInputs({ contentReview: [review()] }).contentReview?.[0]).toMatchObject({ url: GUIDE, verdict: 'helpful' });
  });

  it('refuses bad fields, listing each by path', () => {
    expect(() => parseInputs({ contentReview: [review({ verdict: 'great', url: '/x', reviewedAt: 'soon' })] })).toThrow(
      /verdict[\s\S]*http\(s\) URL|http\(s\) URL[\s\S]*verdict/,
    );
    expect(() => parseInputs({ contentReview: [review(), review()] })).toThrow(/duplicate review/);
    expect(() => parseInputs({ contentReview: [review({ reviewer: undefined })] })).toThrow(/contentReview\[0\]\.reviewer/);
  });
});
