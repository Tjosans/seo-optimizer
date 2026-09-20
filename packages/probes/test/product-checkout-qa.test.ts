/** `product-checkout-qa` (4.10): the checkout cases a person tested, against what the crawl saw. */

import { describe, expect, it } from 'vitest';
import type { CrawlResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const CART = 'https://www.example.com/cart';

const page = (url: string, status = 200) => ({ normalizedUrl: url, fetch: { status, headers: {} }, extracted: null });
const testCase = (over: Record<string, unknown> = {}) => ({
  case: 'guest checkout',
  url: CART,
  result: 'pass',
  testedAt: '2026-09-10T09:00:00.000Z',
  ...over,
});
const matrix = (cases: unknown[], over: Record<string, unknown> = {}) => ({
  cases,
  owner: 'Jane',
  recordedAt: '2026-09-10T09:00:00.000Z',
  ...over,
});

const check = (checkoutMatrix: unknown, pages: unknown[]): Observation =>
  (probeById('product-checkout-qa') as SiteProbe).run({
    origin: 'https://www.example.com',
    flags: [],
    crawl: { crawledAt: '2026-09-19T12:00:00.000Z', pages } as unknown as CrawlResult,
    inputs: (checkoutMatrix === undefined ? {} : { checkoutMatrix }) as never,
  });

describe('product-checkout-qa', () => {
  it('is not applicable without a matrix', () => {
    expect(check(undefined, []).outcome).toBe('not-applicable');
  });

  it('passes passed cases whose URLs answer 200', () => {
    expect(check(matrix([testCase()]), [page(CART)]).outcome).toBe('pass');
  });

  it('fails a failed case', () => {
    expect(check(matrix([testCase({ result: 'fail' })]), [page(CART)]).outcome).toBe('fail');
  });

  it('fails a case URL the crawl got a non-200 from', () => {
    expect(check(matrix([testCase()]), [page(CART, 404)]).outcome).toBe('fail');
  });

  it('warns a case URL the crawl did not reach, and a record with no owner', () => {
    expect(check(matrix([testCase()]), []).outcome).toBe('warn');
    expect(check(matrix([testCase()], { owner: ' ' }), [page(CART)]).outcome).toBe('warn');
  });
});
