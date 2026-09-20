/** `merchant-feed-parity` (2.11): a supplied Merchant Center feed against the Product markup the crawl read. */

import { describe, expect, it } from 'vitest';
import type { CrawlResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const URL_A = 'https://www.example.com/p/a';

const page = (url: string, product: Record<string, unknown> | null) => ({
  normalizedUrl: url,
  fetch: { status: 200, headers: {} },
  extracted: { jsonLd: product === null ? [] : [{ '@type': 'Product', name: 'A', ...product }], openGraph: {} },
});
const offer = (over: Record<string, unknown> = {}) => ({
  offers: { '@type': 'Offer', price: '19.90', priceCurrency: 'EUR', availability: 'https://schema.org/InStock', ...over },
});
const item = (over: Record<string, unknown> = {}) => ({
  id: 'SKU-1',
  link: URL_A,
  price: 19.9,
  currency: 'EUR',
  availability: 'in stock',
  ...over,
});
const feed = (items: unknown[], over: Record<string, unknown> = {}) => ({
  path: 'feed.xml',
  owner: 'Jane',
  recordedAt: '2026-09-11T00:00:00.000Z',
  items,
  ...over,
});

const check = (merchantFeed: unknown, pages: unknown[]): Observation =>
  (probeById('merchant-feed-parity') as SiteProbe).run({
    origin: 'https://www.example.com',
    flags: [],
    crawl: { crawledAt: '2026-09-19T12:00:00.000Z', pages } as unknown as CrawlResult,
    inputs: (merchantFeed === undefined ? {} : { merchantFeed }) as never,
  });

describe('merchant-feed-parity', () => {
  it('is not applicable without a feed or read items', () => {
    expect(check(undefined, []).outcome).toBe('not-applicable');
    expect(check(feed([], { items: undefined }), []).outcome).toBe('not-applicable');
    expect(check(feed([]), []).outcome).toBe('not-applicable');
  });

  it('passes a feed that agrees, including gtin padding', () => {
    const p = page(URL_A, { ...offer(), gtin13: '0012345678905' });
    expect(check(feed([item({ gtin: '12345678905' })]), [p]).outcome).toBe('pass');
  });

  it('fails a price, currency, availability or gtin that disagrees', () => {
    const p = page(URL_A, { ...offer(), gtin13: '4006381333931' });
    expect(check(feed([item({ price: 24.9 })]), [p]).outcome).toBe('fail');
    expect(check(feed([item({ currency: 'USD' })]), [p]).outcome).toBe('fail');
    expect(check(feed([item({ availability: 'out of stock' })]), [p]).outcome).toBe('fail');
    expect(check(feed([item({ gtin: '4006381333900' })]), [p]).outcome).toBe('fail');
  });

  it('accepts any of several offers', () => {
    const p = page(URL_A, { offers: [{ '@type': 'Offer', price: 5, priceCurrency: 'EUR', availability: 'OutOfStock' }, offer().offers] });
    expect(check(feed([item()]), [p]).outcome).toBe('pass');
  });

  it('warns items the crawl did not reach, and values the page leaves out', () => {
    const result = check(feed([item(), item({ id: 'SKU-2', link: 'https://www.example.com/p/b' })]), [page(URL_A, offer())]);
    expect(result.outcome).toBe('warn');
    expect(check(feed([item()]), [page(URL_A, offer({ price: undefined }))]).outcome).toBe('warn');
    expect(check(feed([item()]), [page(URL_A, null)]).outcome).toBe('warn');
  });

  it('fails over a warning when both exist', () => {
    const result = check(feed([item({ price: 1 }), item({ id: 'SKU-2', link: 'https://www.example.com/x' })]), [page(URL_A, offer())]);
    expect(result.outcome).toBe('fail');
  });

  it('holds a record with no owner', () => {
    expect(check(feed([item()], { owner: ' ' }), [page(URL_A, offer())]).outcome).toBe('warn');
  });
});
