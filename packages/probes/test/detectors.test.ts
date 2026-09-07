/**
 * The detectors added for corpus checks 1.9, 1.13, 2.17 and 4.9.
 *
 * These run against hand-built pages rather than the fixture site, because each
 * one answers a question about a *shape* — a reciprocal hreflang cluster, a
 * paginated series, a breadcrumb whose ancestor 404s — and a fixture carrying
 * every shape at once would be a site nobody has ever built. The markup still
 * goes through the real `extract`, so what the probe reads is what a crawl
 * would have given it.
 *
 * `probes.test.ts` remains the test that the whole registry behaves against one
 * coherent site; this is the test that each of these four is right.
 */

import { describe, expect, it } from 'vitest';
import { extract } from '@seo/crawler';
import type { CrawledPage, CrawlResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, PageProbe, SiteContext, SiteProbe } from '@seo/probes';

const ORIGIN = 'https://example.com';

interface PageSpec {
  readonly path: string;
  readonly html?: string;
  readonly status?: number;
  readonly depth?: number;
}

const page = ({ path, html = '<html><body><p>page</p></body></html>', status = 200, depth = 1 }: PageSpec): CrawledPage => {
  const url = `${ORIGIN}${path}`;
  return {
    url,
    normalizedUrl: url,
    depth,
    discoveredFrom: null,
    fetch: {
      requestedUrl: url,
      finalUrl: url,
      status,
      headers: { 'content-type': 'text/html' },
      redirectChain: [],
      body: html,
      byteLength: html.length,
      contentType: 'text/html',
      ttfbMs: 1,
      totalMs: 2,
    },
    extracted: status === 200 ? extract(html, url) : null,
  };
};

const siteOf = (pages: readonly CrawledPage[], flags: readonly string[] = []): SiteContext => ({
  origin: ORIGIN,
  flags,
  crawl: {
    seeds: [`${ORIGIN}/`],
    pages,
    robots: { groups: [], sitemaps: [], absent: true },
    robotsTxt: null,
    sitemapUrls: [],
    blockedByRobots: [],
    notReached: [],
  } satisfies CrawlResult,
});

const siteProbe = (id: string): SiteProbe => probeById(id) as SiteProbe;
const pageProbe = (id: string): PageProbe => probeById(id) as PageProbe;

const runSite = (id: string, pages: readonly CrawledPage[], flags?: readonly string[]): Observation =>
  siteProbe(id).run(siteOf(pages, flags));

const runPage = (
  id: string,
  target: CrawledPage,
  pages: readonly CrawledPage[],
  flags: readonly string[] = [],
): Observation => pageProbe(id).run({ page: target, site: siteOf(pages, flags) });

// --- 4.9 hreflang-cluster-qa ------------------------------------------------

const withHreflang = (path: string, entries: readonly [string, string][], extra = ''): CrawledPage =>
  page({
    path,
    html:
      '<html><head>' +
      entries
        .map(([lang, href]) => `<link rel="alternate" hreflang="${lang}" href="${ORIGIN}${href}">`)
        .join('') +
      `${extra}</head><body><p>hello</p></body></html>`,
  });

describe('hreflang-cluster-qa', () => {
  it('says nothing about a site that makes no hreflang claim', () => {
    expect(runSite('hreflang-cluster-qa', [page({ path: '/' })]).outcome).toBe('not-applicable');
  });

  it('passes a cluster where every page names every other, itself included', () => {
    const observation = runSite('hreflang-cluster-qa', [
      withHreflang('/en/', [['en', '/en/'], ['de', '/de/'], ['x-default', '/en/']]),
      withHreflang('/de/', [['en', '/en/'], ['de', '/de/'], ['x-default', '/en/']]),
    ]);
    expect(observation.outcome).toBe('pass');
  });

  it('fails the one-sided annotation search engines discard', () => {
    const observation = runSite('hreflang-cluster-qa', [
      withHreflang('/en/', [['en', '/en/'], ['de', '/de/']]),
      // /de/ does not name /en/ back, so the cluster does not exist.
      withHreflang('/de/', [['de', '/de/']]),
    ]);
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/not reciprocated/);
  });

  it('fails a page that omits its own self-reference', () => {
    const observation = runSite('hreflang-cluster-qa', [
      withHreflang('/en/', [['de', '/de/'], ['en', '/en/']]),
      withHreflang('/de/', [['en', '/en/']]),
    ]);
    expect(observation.outcome).toBe('fail');
  });

  it('fails a cluster whose members are noindex', () => {
    const noindex = '<meta name="robots" content="noindex">';
    const observation = runSite('hreflang-cluster-qa', [
      withHreflang('/en/', [['en', '/en/'], ['de', '/de/']], noindex),
      withHreflang('/de/', [['en', '/en/'], ['de', '/de/']], noindex),
    ]);
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/noindex/);
  });

  it('fails an annotation pointing at a URL the crawl never reached', () => {
    const observation = runSite('hreflang-cluster-qa', [
      withHreflang('/en/', [['en', '/en/'], ['fr', '/fr/']]),
    ]);
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/never reached/);
  });

  it('warns rather than fails when only x-default is absent', () => {
    const observation = runSite('hreflang-cluster-qa', [
      withHreflang('/en/', [['en', '/en/'], ['de', '/de/']]),
      withHreflang('/de/', [['en', '/en/'], ['de', '/de/']]),
    ]);
    expect(observation.outcome).toBe('warn');
    expect(observation.summary).toMatch(/x-default/);
  });

  it('does not treat a cross-domain locale as a broken cluster', () => {
    const html =
      '<html><head>' +
      `<link rel="alternate" hreflang="en" href="${ORIGIN}/en/">` +
      '<link rel="alternate" hreflang="de" href="https://example.de/">' +
      '<link rel="alternate" hreflang="x-default" href="https://example.com/en/">' +
      '</head><body><p>hi</p></body></html>';
    const observation = runSite('hreflang-cluster-qa', [page({ path: '/en/', html })]);
    expect(observation.outcome).toBe('pass');
    expect(observation.data?.['offSiteTargetsNotVerified']).toBeDefined();
  });
});

// --- 1.13 pagination-crawl-path ---------------------------------------------

const listing = (path: string, nextHref: string | null): CrawledPage =>
  page({
    path,
    html:
      '<html><head>' +
      (nextHref === null ? '' : `<link rel="next" href="${ORIGIN}${nextHref}">`) +
      '</head><body>' +
      (nextHref === null
        ? '<button>Load more</button>'
        : `<a href="${ORIGIN}${nextHref}" rel="next">Next</a>`) +
      '</body></html>',
  });

describe('pagination-crawl-path', () => {
  it('says nothing about a site with no paginated series', () => {
    expect(runSite('pagination-crawl-path', [listing('/blog', null)]).outcome).toBe(
      'not-applicable',
    );
  });

  it('passes when page two was linked in raw HTML and answered 200', () => {
    const observation = runSite('pagination-crawl-path', [
      listing('/blog', '/blog?page=2'),
      page({ path: '/blog?page=2' }),
    ]);
    expect(observation.outcome).toBe('pass');
  });

  it('recognises a path-style series as well as a query-string one', () => {
    const observation = runSite('pagination-crawl-path', [
      page({ path: '/blog', html: `<html><body><a href="${ORIGIN}/blog/page/2">2</a></body></html>` }),
      page({ path: '/blog/page/2' }),
    ]);
    expect(observation.outcome).toBe('pass');
  });

  it('fails a paginated URL that 404s', () => {
    const observation = runSite('pagination-crawl-path', [
      listing('/blog', '/blog?page=2'),
      page({ path: '/blog?page=2', status: 404 }),
    ]);
    expect(observation.outcome).toBe('fail');
  });

  it('fails a paginated page that hides its items behind noindex', () => {
    const observation = runSite('pagination-crawl-path', [
      listing('/blog', '/blog?page=2'),
      page({
        path: '/blog?page=2',
        html: '<html><head><meta name="robots" content="noindex"></head><body>2</body></html>',
      }),
    ]);
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/noindex/);
  });
});

// --- 1.9 media-alternatives -------------------------------------------------

const media = (body: string): CrawledPage =>
  page({ path: '/watch', html: `<html><body>${body}</body></html>` });

describe('media-alternatives', () => {
  it('says nothing about a page with no media', () => {
    const target = page({ path: '/' });
    expect(runPage('media-alternatives', target, [target]).outcome).toBe('not-applicable');
  });

  it('passes a video with a caption track', () => {
    const target = media('<video src="/v.mp4"><track kind="captions" src="/v.vtt"></video>');
    expect(runPage('media-alternatives', target, [target]).outcome).toBe('pass');
  });

  it('accepts subtitles as well as captions', () => {
    const target = media('<video src="/v.mp4"><track kind="subtitles" src="/v.vtt"></video>');
    expect(runPage('media-alternatives', target, [target]).outcome).toBe('pass');
  });

  it('fails a video with no track and no text at all', () => {
    const target = media('<video src="/v.mp4"></video>');
    const observation = runPage('media-alternatives', target, [target]);
    expect(observation.outcome).toBe('fail');
  });

  it('warns when there is fallback text but no captions', () => {
    const target = media('<video src="/v.mp4">Your browser cannot play this recording.</video>');
    expect(runPage('media-alternatives', target, [target]).outcome).toBe('warn');
  });

  it('reads audio the same way as video', () => {
    const target = media('<audio src="/a.mp3"></audio>');
    expect(runPage('media-alternatives', target, [target]).outcome).toBe('fail');
  });
});

// --- 2.17 breadcrumb-navigation ---------------------------------------------

const HIERARCHICAL = ['hierarchical'];

const crumbed = (path: string, inner: string): CrawledPage =>
  page({ path, html: `<html><body><nav aria-label="Breadcrumb">${inner}</nav></body></html>` });

describe('breadcrumb-navigation', () => {
  it('says nothing when the site profile does not claim hierarchy', () => {
    const target = crumbed('/a/b', `<a href="${ORIGIN}/a">A</a>`);
    expect(runPage('breadcrumb-navigation', target, [target]).outcome).toBe('not-applicable');
  });

  it('says nothing about the home page, which has no ancestors', () => {
    const target = page({ path: '/', depth: 0 });
    expect(runPage('breadcrumb-navigation', target, [target], HIERARCHICAL).outcome).toBe(
      'not-applicable',
    );
  });

  it('passes a visible trail whose ancestor the crawl fetched successfully', () => {
    const ancestor = page({ path: '/a' });
    const target = crumbed('/a/b', `<a href="${ORIGIN}/a">A</a><span>B</span>`);
    expect(
      runPage('breadcrumb-navigation', target, [ancestor, target], HIERARCHICAL).outcome,
    ).toBe('pass');
  });

  it('finds a trail marked up with a class rather than aria-label', () => {
    const ancestor = page({ path: '/a' });
    const target = page({
      path: '/a/b',
      html: `<html><body><ol class="breadcrumbs"><li><a href="${ORIGIN}/a">A</a></li></ol></body></html>`,
    });
    expect(
      runPage('breadcrumb-navigation', target, [ancestor, target], HIERARCHICAL).outcome,
    ).toBe('pass');
  });

  it('fails a page below the root that shows no trail', () => {
    const target = page({ path: '/a/b' });
    expect(runPage('breadcrumb-navigation', target, [target], HIERARCHICAL).outcome).toBe('fail');
  });

  it('fails a trail whose crumbs are all plain text', () => {
    const target = crumbed('/a/b', '<span>A</span><span>B</span>');
    const observation = runPage('breadcrumb-navigation', target, [target], HIERARCHICAL);
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/none of its crumbs is a link/);
  });

  it('fails an ancestor the crawl fetched and got a 404 from', () => {
    const ancestor = page({ path: '/a', status: 404 });
    const target = crumbed('/a/b', `<a href="${ORIGIN}/a">A</a>`);
    const observation = runPage('breadcrumb-navigation', target, [ancestor, target], HIERARCHICAL);
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/do not resolve/);
  });

  it('warns rather than fails when no ancestor was reached at all', () => {
    const target = crumbed('/a/b', `<a href="${ORIGIN}/a">A</a>`);
    const observation = runPage('breadcrumb-navigation', target, [target], HIERARCHICAL);
    expect(observation.outcome).toBe('warn');
  });
});
