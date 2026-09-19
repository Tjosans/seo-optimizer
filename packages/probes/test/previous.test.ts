/**
 * The snapshot a later audit compares itself against: taken from a crawl,
 * carried through JSON, and read back strictly.
 */

import { describe, expect, it } from 'vitest';
import { extract } from '@seo/crawler';
import type { CrawledPage, CrawlResult } from '@seo/crawler';
import { parsePrevious, previousPage, snapshotAudit } from '@seo/probes';
import type { ProbeRun } from '@seo/probes';

const ORIGIN = 'https://www.example.com';

const html =
  '<html><head><title>Home</title><meta name="robots" content="noindex">' +
  `<link rel="canonical" href="${ORIGIN}/"><link rel="alternate" hreflang="sv" href="${ORIGIN}/sv/">` +
  '<script type="application/ld+json">{"@type":["WebSite","Thing"]}</script>' +
  '</head><body><h1>Hi</h1></body></html>';

const home = {
  url: `${ORIGIN}/`,
  normalizedUrl: `${ORIGIN}/`,
  depth: 0,
  discoveredFrom: null,
  fetch: {
    requestedUrl: `${ORIGIN}/`,
    finalUrl: `${ORIGIN}/`,
    status: 200,
    headers: { 'x-robots-tag': 'nofollow' },
    redirectChain: [],
    body: html,
    byteLength: html.length,
    truncated: false,
    contentType: 'text/html',
    ttfbMs: 1,
    totalMs: 2,
    error: null,
  },
  extracted: extract(html, `${ORIGIN}/`),
} as unknown as CrawledPage;

const crawl = { pages: [home], blockedByRobots: [`${ORIGIN}/private`] } as unknown as CrawlResult;

const runs: ProbeRun[] = [
  { probeId: 'canonicalization', scope: 'page', pageUrl: `${ORIGIN}/`, observation: { outcome: 'pass', summary: 'ok' } },
  { probeId: 'robots-txt', scope: 'site', observation: { outcome: 'warn', summary: 'meh' } },
];

const taken = () => snapshotAudit({ origin: ORIGIN, crawl, runs, takenAt: new Date('2026-09-19T10:00:00Z') });

describe('snapshotAudit', () => {
  it('records what a comparison reads, per URL', () => {
    const [entry] = taken().pages;
    expect(entry).toMatchObject({
      url: `${ORIGIN}/`,
      status: 200,
      metaRobots: 'noindex',
      xRobotsTag: 'nofollow',
      canonical: `${ORIGIN}/`,
      title: 'Home',
      jsonLdTypes: ['Thing', 'WebSite'],
      hreflang: [{ hreflang: 'sv', url: `${ORIGIN}/sv/` }],
    });
  });

  it('keeps probe outcomes with the page they were about', () => {
    expect(taken().probes).toEqual([
      { probeId: 'canonicalization', pageUrl: `${ORIGIN}/`, outcome: 'pass' },
      { probeId: 'robots-txt', pageUrl: null, outcome: 'warn' },
    ]);
  });

  it('survives JSON and is found by URL', () => {
    const previous = parsePrevious(JSON.parse(JSON.stringify(taken())));
    expect(previous).toEqual(taken());
    expect(previousPage(previous, `${ORIGIN}/`)?.title).toBe('Home');
    expect(previousPage(previous, `${ORIGIN}/missing`)).toBeUndefined();
  });
});

describe('parsePrevious', () => {
  it('refuses another schema, a missing list and an unknown outcome', () => {
    expect(() => parsePrevious({ ...taken(), schema: 2 })).toThrow(/schema/);
    expect(() => parsePrevious({ ...taken(), pages: undefined })).toThrow(/pages/);
    expect(() =>
      parsePrevious({ ...taken(), probes: [{ probeId: 'x', pageUrl: null, outcome: 'great' }] }),
    ).toThrow(/outcome/);
    expect(() => parsePrevious(null)).toThrow(/expected an object/);
  });

  it('accepts a snapshot rebuilt from stored rows, which has no robots list', () => {
    const { blockedByRobots: _dropped, ...stored } = taken();
    expect(parsePrevious(stored).blockedByRobots).toBeUndefined();
  });
});
