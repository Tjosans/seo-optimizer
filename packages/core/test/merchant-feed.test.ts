import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { parseInputs } from '../src/inputs.js';
import { loadMerchantFeed } from '../src/merchant-feed.js';

const RSS = `<?xml version="1.0"?><rss xmlns:g="http://base.google.com/ns/1.0"><channel><link>https://x.test</link>
<item><g:id>A1</g:id><link>https://x.test/a?x=1&amp;y=2</link><g:price>12.50 USD</g:price><g:availability>in_stock</g:availability><g:gtin>123</g:gtin><g:brand><![CDATA[Acme & Co]]></g:brand></item>
<item><g:id>A2</g:id><link>https://x.test/b</link><g:price>3 EUR</g:price><g:availability>out of stock</g:availability></item>
</channel></rss>`;

const TSV = 'id\tlink\tprice\tavailability\tgtin\tbrand\nB1\thttps://x.test/c\t9.99 GBP\tPreorder\t\tZed\n';

describe('merchantFeed', () => {
  const full = { path: 'feed.xml', owner: 'Jane', recordedAt: '2026-09-10T09:00:00Z' };
  const load = (name: string, body: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'feed-'));
    writeFileSync(join(dir, name), body);
    return loadMerchantFeed(parseInputs({ merchantFeed: { ...full, path: name } }), dir).merchantFeed?.items;
  };

  it('is strict about the section', () => {
    expect(parseInputs({ merchantFeed: full }).merchantFeed?.path).toBe('feed.xml');
    expect(() => parseInputs({ merchantFeed: { ...full, path: 3 } })).toThrow(/merchantFeed\.path: expected text/);
    expect(() => parseInputs({ merchantFeed: { ...full, path: undefined } })).toThrow(/merchantFeed\.path: required/);
    expect(() => parseInputs({ merchantFeed: { ...full, extra: 1 } })).toThrow(/merchantFeed\.extra: unknown field/);
  });

  it('reads an RSS feed with the g: namespace', () => {
    expect(load('feed.xml', RSS)).toEqual([
      { id: 'A1', link: 'https://x.test/a?x=1&y=2', price: 12.5, currency: 'USD', availability: 'in stock', gtin: '123', brand: 'Acme & Co' },
      { id: 'A2', link: 'https://x.test/b', price: 3, currency: 'EUR', availability: 'out of stock' },
    ]);
  });

  it('reads a TSV feed', () => {
    expect(load('feed.tsv', TSV)).toEqual([
      { id: 'B1', link: 'https://x.test/c', price: 9.99, currency: 'GBP', availability: 'preorder', brand: 'Zed' },
    ]);
  });

  it('refuses a malformed feed, listing each problem', () => {
    const bad = RSS.replace('12.50 USD', '12.50').replace('<g:id>A2</g:id>', '<g:id>A1</g:id>');
    expect(() => load('feed.xml', bad)).toThrow(/merchant feed .*item 1 \(A1\): price "12.50".*item 2 \(A1\): id is repeated/);
    expect(() => load('feed.tsv', 'id\tlink\n1\thttps://x.test\n')).toThrow(/header is missing price, availability/);
    expect(() => load('feed.xml', RSS.replace('https://x.test/b', '/b'))).toThrow(/not an absolute http\(s\) URL/);
    expect(() => loadMerchantFeed(parseInputs({ merchantFeed: { ...full, path: 'nope.xml' } }), tmpdir())).toThrow(/merchant feed/);
  });

  it('is in scripts/inputs.example.yaml and its feed loads', () => {
    const file = fileURLToPath(new URL('../../../scripts/inputs.example.yaml', import.meta.url));
    const inputs = parseInputs(parse(readFileSync(file, 'utf8')));
    expect(inputs.merchantFeed?.path).toBe('feeds/merchant.xml');
    expect(loadMerchantFeed(inputs, dirname(file)).merchantFeed?.items?.[0]?.id).toBe('SKU-1');
  });
});
