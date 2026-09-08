/**
 * The detectors added for corpus checks 1.6, 1.9, 1.13, 1.14, 1.15, 2.7, 2.13,
 * 2.14, 2.17 and 4.9.
 *
 * These run against hand-built pages rather than the fixture site, because each
 * one answers a question about a *shape* — a reciprocal hreflang cluster, a
 * paginated series, a breadcrumb whose ancestor 404s, four host spellings that
 * must agree — and a fixture carrying every shape at once would be a site
 * nobody has ever built. Several are shapes the fixture cannot have at all: it
 * serves on an IP address, so it has no www spelling to test. The markup still
 * goes through the real `extract`, so what the probe reads is what a crawl
 * would have given it.
 *
 * `probes.test.ts` remains the test that the whole registry behaves against one
 * coherent site; this is the test that each of these is right.
 */

import { describe, expect, it } from 'vitest';
import { extract, parseRobots } from '@seo/crawler';
import type { AuxiliaryFetch, CrawledPage, CrawlResult, FetchResult } from '@seo/crawler';
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
      truncated: false,
      contentType: 'text/html',
      ttfbMs: 1,
      totalMs: 2,
    },
    extracted: status === 200 ? extract(html, url) : null,
  };
};

const siteOf = (
  pages: readonly CrawledPage[],
  flags: readonly string[] = [],
  auxiliary: readonly AuxiliaryFetch[] = [],
  sitemapUrls: readonly string[] = [],
): SiteContext => ({
  origin: ORIGIN,
  flags,
  crawl: {
    seeds: [`${ORIGIN}/`],
    pages,
    robots: { groups: [], sitemaps: [], absent: true },
    robotsTxt: null,
    sitemapUrls,
    sitemaps: [],
    sitemapVideos: [],
    blockedByRobots: [],
    notReached: [],
    auxiliary,
  } satisfies CrawlResult,
});

const siteProbe = (id: string): SiteProbe => probeById(id) as SiteProbe;
const pageProbe = (id: string): PageProbe => probeById(id) as PageProbe;

const runSite = (
  id: string,
  pages: readonly CrawledPage[],
  flags?: readonly string[],
  auxiliary?: readonly AuxiliaryFetch[],
): Observation => siteProbe(id).run(siteOf(pages, flags, auxiliary));

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

// --- 1.14 hreflang-implementation and locale-canonical ----------------------

/** A page whose hreflang hrefs are written out verbatim, relative ones included. */
const withRawHreflang = (path: string, entries: readonly [string, string][]): CrawledPage =>
  page({
    path,
    html:
      '<html><head>' +
      entries
        .map(([lang, href]) => `<link rel="alternate" hreflang="${lang}" href="${href}">`)
        .join('') +
      '</head><body><p>hello</p></body></html>',
  });

/** A locale variant that also states an address, which is what 1.14 is about. */
const localePage = (
  path: string,
  entries: readonly [string, string][],
  canonical: string | null,
): CrawledPage =>
  page({
    path,
    html:
      '<html><head>' +
      entries
        .map(([lang, href]) => `<link rel="alternate" hreflang="${lang}" href="${ORIGIN}${href}">`)
        .join('') +
      (canonical === null ? '' : `<link rel="canonical" href="${ORIGIN}${canonical}">`) +
      '</head><body><p>hello</p></body></html>',
  });

describe('hreflang-implementation', () => {
  it('says nothing about a site that never claimed to be multilingual', () => {
    expect(runSite('hreflang-implementation', [page({ path: '/' })]).outcome).toBe('not-applicable');
  });

  it('fails a site whose profile says multilingual and whose pages say nothing', () => {
    const observation = runSite('hreflang-implementation', [page({ path: '/' })], ['multilingual']);
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/no crawled page carries an hreflang annotation/i);
  });

  it('passes locales that exist, on distinct URLs', () => {
    const observation = runSite('hreflang-implementation', [
      withHreflang('/en/', [['en', '/en/'], ['de-AT', '/de/'], ['x-default', '/en/']]),
      withHreflang('/de/', [['en', '/en/'], ['de-AT', '/de/'], ['x-default', '/en/']]),
    ]);
    expect(observation.outcome).toBe('pass');
    expect(observation.data?.['locales']).toEqual(['de-at', 'en']);
  });

  // The failure the cluster check cannot see: perfectly reciprocal, entirely
  // ignored, because no country is called UK.
  it('fails a well-formed tag whose region is not a country, and names the one that is', () => {
    const observation = runSite('hreflang-implementation', [
      withHreflang('/en/', [['en', '/en/'], ['en-UK', '/uk/']]),
      withHreflang('/uk/', [['en', '/en/'], ['en-UK', '/uk/']]),
    ]);
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toContain('"GB"');
  });

  it('fails a country code used where a language belongs', () => {
    const observation = runSite('hreflang-implementation', [
      withHreflang('/en/', [['en', '/en/'], ['gb', '/gb/']]),
    ]);
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/not an ISO 639-1 code/);
  });

  it('fails the withdrawn code by naming its replacement', () => {
    const observation = runSite('hreflang-implementation', [
      withHreflang('/en/', [['en', '/en/'], ['iw', '/he/']]),
    ]);
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toContain('"he"');
  });

  it('fails a relative href, which is dropped rather than resolved', () => {
    const observation = runSite('hreflang-implementation', [
      withRawHreflang('/en/', [['en', '/en/'], ['de', '/de/']]),
    ]);
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/relative href/);
  });

  it('fails one locale declared twice at two addresses', () => {
    const observation = runSite('hreflang-implementation', [
      withHreflang('/en/', [['en', '/en/'], ['en', '/en-gb/']]),
    ]);
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/declared twice/);
  });

  it('fails two locales served from one URL', () => {
    const observation = runSite('hreflang-implementation', [
      withHreflang('/en/', [['en', '/en/'], ['en-IE', '/en/']]),
    ]);
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/not on distinct URLs/);
  });

  it('fails two x-defaults, because a fallback has to be one place', () => {
    const observation = runSite('hreflang-implementation', [
      withHreflang('/en/', [
        ['en', '/en/'],
        ['de', '/de/'],
        ['x-default', '/en/'],
        ['x-default', '/de/'],
      ]),
    ]);
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/x-default more than once/);
  });

  it('warns about a region search engines do not document support for', () => {
    const observation = runSite('hreflang-implementation', [
      withHreflang('/en/', [['en', '/en/'], ['es-419', '/es/']]),
      withHreflang('/es/', [['en', '/en/'], ['es-419', '/es/']]),
    ]);
    expect(observation.outcome).toBe('warn');
    expect(observation.summary).toMatch(/do not document support for/);
  });

  it('warns about x-default beside a single locale', () => {
    const observation = runSite('hreflang-implementation', [
      withHreflang('/en/', [['en', '/en/'], ['x-default', '/en/']]),
    ]);
    expect(observation.outcome).toBe('warn');
    expect(observation.summary).toMatch(/nothing to fall back from/);
  });
});

describe('locale-canonical', () => {
  it('says nothing about a page no locale cluster names', () => {
    const plain = page({ path: '/' });
    expect(runPage('locale-canonical', plain, [plain]).outcome).toBe('not-applicable');
  });

  it('passes a locale variant that states its own address', () => {
    const en = localePage('/en/', [['en', '/en/'], ['fr', '/fr/']], '/en/');
    const fr = localePage('/fr/', [['en', '/en/'], ['fr', '/fr/']], '/fr/');
    expect(runPage('locale-canonical', fr, [en, fr]).outcome).toBe('pass');
  });

  // The template that ships with the default locale's canonical hard-coded.
  it('fails a variant that canonicalizes to another locale, and names it', () => {
    const en = localePage('/en/', [['en', '/en/'], ['fr', '/fr/']], '/en/');
    const fr = localePage('/fr/', [['en', '/en/'], ['fr', '/fr/']], '/en/');
    const observation = runPage('locale-canonical', fr, [en, fr]);
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toContain('"en"');
    expect(observation.data?.['locale']).toBe('en');
  });

  // The cluster is what makes this page a variant; the page itself is silent.
  it('fails a page that carries no annotation but is named as a locale', () => {
    const en = localePage('/en/', [['en', '/en/'], ['fr', '/fr/']], '/en/');
    const fr = localePage('/fr/', [], '/en/');
    expect(runPage('locale-canonical', fr, [en, fr]).outcome).toBe('fail');
  });

  it('fails a locale variant that declares no canonical at all', () => {
    const en = localePage('/en/', [['en', '/en/'], ['fr', '/fr/']], '/en/');
    const fr = localePage('/fr/', [['en', '/en/'], ['fr', '/fr/']], null);
    const observation = runPage('locale-canonical', fr, [en, fr]);
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/no rel=canonical/);
  });

  it('fails a canonical that leaves the cluster entirely', () => {
    const en = localePage('/en/', [['en', '/en/'], ['fr', '/fr/']], '/en/');
    const fr = localePage('/fr/', [['en', '/en/'], ['fr', '/fr/']], '/home');
    const observation = runPage('locale-canonical', fr, [en, fr]);
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/canonical and hreflang disagree/);
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


// --- 1.6 host-redirect ------------------------------------------------------

/** One auxiliary result, as the crawl records it. */
const variant = (
  url: string,
  over: Partial<FetchResult> = {},
  reason: AuxiliaryFetch['reason'] = 'host-variant',
): AuxiliaryFetch => ({
  reason,
  url,
  fetch: {
    requestedUrl: url,
    finalUrl: over.finalUrl ?? url,
    status: 200,
    headers: {},
    redirectChain: [],
    body: '',
    byteLength: 0,
    truncated: false,
    contentType: 'text/html',
    ttfbMs: 1,
    totalMs: 2,
    error: null,
    ...over,
  },
});

/** All four spellings, each arriving at the canonical URL in one hop. */
const goodVariants = (): AuxiliaryFetch[] => {
  const canonical = `${ORIGIN}/`;
  const hop = (from: string) => ({
    finalUrl: canonical,
    redirectChain: from === canonical ? [] : [{ url: from, status: 301, location: canonical }],
  });
  return [
    'http://example.com/',
    'http://www.example.com/',
    'https://www.example.com/',
    canonical,
  ].map((url) => variant(url, hop(url)));
};

describe('host-redirect', () => {
  it('says nothing when the seed host has no variants to test', () => {
    expect(runSite('host-redirect', [page({ path: '/' })]).outcome).toBe('not-applicable');
  });

  it('passes when every variant reaches one HTTPS URL in one hop', () => {
    const observation = runSite('host-redirect', [page({ path: '/' })], [], goodVariants());
    expect(observation.outcome).toBe('pass');
    expect(observation.data?.['landsOn']).toBe(`${ORIGIN}/`);
  });

  it('fails a variant that never leaves http', () => {
    const variants = goodVariants();
    variants[0] = variant('http://example.com/', { finalUrl: 'http://example.com/' });
    const observation = runSite('host-redirect', [page({ path: '/' })], [], variants);
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/end on http/);
  });

  it('fails when www and apex both serve, splitting the site in two', () => {
    const variants = goodVariants();
    variants[2] = variant('https://www.example.com/', {
      finalUrl: 'https://www.example.com/',
    });
    const observation = runSite('host-redirect', [page({ path: '/' })], [], variants);
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/different URLs/);
  });

  it('fails a variant that takes two hops to arrive', () => {
    const variants = goodVariants();
    variants[0] = variant('http://example.com/', {
      finalUrl: `${ORIGIN}/`,
      redirectChain: [
        { url: 'http://example.com/', status: 301, location: 'https://www.example.com/' },
        { url: 'https://www.example.com/', status: 301, location: `${ORIGIN}/` },
      ],
    });
    const observation = runSite('host-redirect', [page({ path: '/' })], [], variants);
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/more than one hop/);
  });

  it('fails a variant that answers 5xx', () => {
    const variants = goodVariants();
    variants[1] = variant('http://www.example.com/', { status: 503 });
    expect(runSite('host-redirect', [page({ path: '/' })], [], variants).outcome).toBe('fail');
  });

  it('warns rather than fails when one spelling simply does not resolve', () => {
    const variants = goodVariants();
    variants[1] = variant('http://www.example.com/', { status: null, error: 'ENOTFOUND' });
    const observation = runSite('host-redirect', [page({ path: '/' })], [], variants);
    expect(observation.outcome).toBe('warn');
    expect(observation.data?.['notResolved']).toEqual(['http://www.example.com/']);
  });

  it('says nothing when no variant answered at all', () => {
    const dead = goodVariants().map((entry) =>
      variant(entry.url, { status: null, error: 'ENOTFOUND' }),
    );
    expect(runSite('host-redirect', [page({ path: '/' })], [], dead).outcome).toBe(
      'not-applicable',
    );
  });
});

// --- 2.13 favicon-site-name -------------------------------------------------

const pngBytes = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
};

const icoBytes = (width: number, height: number): Uint8Array =>
  new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, width, height]);

const icon = (over: Partial<FetchResult> = {}): AuxiliaryFetch =>
  variant(
    `${ORIGIN}/favicon.png`,
    { contentType: 'image/png', bytes: pngBytes(48, 48), ...over },
    'icon',
  );

const branded = (path: string, extra = ''): CrawledPage =>
  page({
    path,
    html:
      '<html><head><meta property="og:site_name" content="Example Co">' +
      `<link rel="icon" href="${ORIGIN}/favicon.png">${extra}` +
      '</head><body><p>hi</p></body></html>',
    depth: path === '/' ? 0 : 1,
  });

describe('favicon-site-name', () => {
  it('fails a root document that declares no icon at all', () => {
    const root = page({
      path: '/',
      html: '<html><head><meta property="og:site_name" content="Example Co"></head><body>x</body></html>',
      depth: 0,
    });
    const observation = runSite('favicon-site-name', [root], [], [icon()]);
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/declares no favicon/);
  });

  it('fails when no page declares a site name', () => {
    const root = page({
      path: '/',
      html: `<html><head><link rel="icon" href="${ORIGIN}/favicon.png"></head><body>x</body></html>`,
      depth: 0,
    });
    expect(runSite('favicon-site-name', [root], [], [icon()]).outcome).toBe('fail');
  });

  it('reads a site name from WebSite schema as well as og:site_name', () => {
    const root = page({
      path: '/',
      html:
        `<html><head><link rel="icon" href="${ORIGIN}/favicon.png">` +
        '<script type="application/ld+json">' +
        '{"@context":"https://schema.org","@type":"WebSite","name":"Example Co"}' +
        '</script></head><body>x</body></html>',
      depth: 0,
    });
    const observation = runSite('favicon-site-name', [root], [], [icon()]);
    expect(observation.outcome).toBe('pass');
    expect(observation.data?.['name']).toBe('Example Co');
  });

  it('fails when two pages claim different site names', () => {
    const other = page({
      path: '/about',
      html: '<html><head><meta property="og:site_name" content="Example Corp"></head><body>x</body></html>',
    });
    const observation = runSite('favicon-site-name', [branded('/'), other], [], [icon()]);
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/disagree about the site name/);
  });

  it('fails a declared icon that 404s', () => {
    const observation = runSite(
      'favicon-site-name',
      [branded('/')],
      [],
      [icon({ status: 404, bytes: undefined })],
    );
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/do not resolve/);
  });

  it('fails an icon served as something other than an image', () => {
    const observation = runSite(
      'favicon-site-name',
      [branded('/')],
      [],
      [icon({ contentType: 'text/html', bytes: undefined })],
    );
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/not served as an image/);
  });

  it('fails an oblong icon, which a square slot will crop', () => {
    const observation = runSite(
      'favicon-site-name',
      [branded('/')],
      [],
      [icon({ bytes: pngBytes(64, 32) })],
    );
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/not square/);
  });

  it('measures an ICO as well as a PNG', () => {
    const observation = runSite(
      'favicon-site-name',
      [branded('/')],
      [],
      [icon({ contentType: 'image/x-icon', bytes: icoBytes(32, 16) })],
    );
    expect(observation.outcome).toBe('fail');
  });

  it('measures an SVG from its viewBox', () => {
    const svg = new TextEncoder().encode('<svg viewBox="0 0 64 64"></svg>');
    const observation = runSite(
      'favicon-site-name',
      [branded('/')],
      [],
      [icon({ contentType: 'image/svg+xml', bytes: svg })],
    );
    expect(observation.outcome).toBe('pass');
  });

  it('warns rather than passing when an icon resolves but cannot be measured', () => {
    const observation = runSite(
      'favicon-site-name',
      [branded('/')],
      [],
      [icon({ contentType: 'image/webp', bytes: new Uint8Array([1, 2, 3, 4]) })],
    );
    expect(observation.outcome).toBe('warn');
    expect(observation.summary).toMatch(/dimensions could be read/);
  });
});


// --- 2.9 ai-crawler-directive-verify ----------------------------------------

const POLICY = {
  agents: { GPTBot: 'disallow', 'Google-Extended': 'allow' },
  approvedAt: '2026-09-01',
  approvedBy: 'legal@example.com',
} as const;

/** The site as this detector sees it: robots.txt, a policy, and UA tests. */
const aiSite = (
  robotsTxt: string | null,
  aiPolicy: unknown = POLICY,
  tests: readonly AuxiliaryFetch[] = [],
): SiteContext => ({
  origin: ORIGIN,
  flags: ['ai-policy'],
  aiPolicy: aiPolicy as SiteContext['aiPolicy'],
  crawl: {
    seeds: [`${ORIGIN}/`],
    pages: [page({ path: '/', depth: 0 })],
    robots:
      robotsTxt === null
        ? { groups: [], sitemaps: [], absent: true }
        : parseRobots(robotsTxt),
    robotsTxt,
    sitemapUrls: [],
    sitemaps: [],
    sitemapVideos: [],
    blockedByRobots: [],
    notReached: [],
    auxiliary: tests,
  } satisfies CrawlResult,
});

const uaTest = (agent: string, status: number): AuxiliaryFetch => ({
  ...variant(`${ORIGIN}/`, { status }, 'user-agent-test'),
  userAgent: agent,
});

/** robots.txt that matches POLICY: GPTBot out, everyone else in. */
const MATCHING_ROBOTS = 'User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n';

const runAi = (context: SiteContext): Observation =>
  siteProbe('ai-crawler-directive-verify').run(context);

describe('ai-crawler-directive-verify', () => {
  it('says nothing when nobody has recorded a policy', () => {
    expect(runAi(aiSite(MATCHING_ROBOTS, null)).outcome).toBe('not-applicable');
  });

  it('says nothing when the policy names no crawlers', () => {
    const empty = { ...POLICY, agents: {} };
    expect(runAi(aiSite(MATCHING_ROBOTS, empty)).outcome).toBe('not-applicable');
  });

  it('fails a site with a policy and no robots.txt to express it', () => {
    expect(runAi(aiSite(null)).outcome).toBe('fail');
  });

  it('fails when robots.txt turns away a crawler the policy welcomes', () => {
    const robots = 'User-agent: *\nDisallow: /\n';
    const observation = runAi(aiSite(robots));
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/contradicts the policy/);
    expect(observation.data?.['disagreements']).toContainEqual({
      agent: 'Google-Extended',
      policy: 'allow',
      robotsTxt: 'disallow',
    });
  });

  it('fails when robots.txt admits a crawler the policy excluded', () => {
    const robots = 'User-agent: *\nAllow: /\n';
    const observation = runAi(aiSite(robots));
    expect(observation.outcome).toBe('fail');
    expect(observation.data?.['disagreements']).toContainEqual({
      agent: 'GPTBot',
      policy: 'disallow',
      robotsTxt: 'allow',
    });
  });

  it('fails when the edge blocks a crawler the policy welcomes', () => {
    const observation = runAi(
      aiSite(MATCHING_ROBOTS, POLICY, [uaTest('Google-Extended', 403)]),
    );
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/turned away at the edge/);
  });

  it('does not mind a disallowed crawler still being served', () => {
    // robots.txt asks; it does not fence. A 200 to GPTBot is the normal shape
    // of robots-only enforcement, not a breach of the policy.
    const observation = runAi(aiSite(MATCHING_ROBOTS, POLICY, [uaTest('GPTBot', 200)]));
    expect(observation.outcome).toBe('pass');
  });

  it('passes when robots.txt and the edge both match the policy', () => {
    const observation = runAi(
      aiSite(MATCHING_ROBOTS, POLICY, [uaTest('GPTBot', 200), uaTest('Google-Extended', 200)]),
    );
    expect(observation.outcome).toBe('pass');
    expect(observation.data?.['approvedAt']).toBe('2026-09-01');
  });

  it('warns when robots.txt agrees but no user-agent test was run', () => {
    const observation = runAi(aiSite(MATCHING_ROBOTS));
    expect(observation.outcome).toBe('warn');
    expect(observation.summary).toMatch(/edge behaviour is unverified/);
  });
});

// --- 1.15 product-variant-canonical -----------------------------------------

interface ProductSpec {
  /** Absent means no rel=canonical at all. */
  readonly canonical?: string | null;
  readonly title?: string;
  readonly noindex?: boolean;
  /** How the page says it is a product: schema.org, og:type, or not at all. */
  readonly declares?: 'json-ld' | 'og' | 'none';
  readonly status?: number;
}

const product = (
  path: string,
  { canonical, title = 'Blue shirt', noindex = false, declares = 'json-ld', status = 200 }: ProductSpec = {},
): CrawledPage =>
  page({
    path,
    status,
    html:
      '<html><head>' +
      `<title>${title}</title>` +
      (canonical === undefined || canonical === null
        ? ''
        : `<link rel="canonical" href="${ORIGIN}${canonical}">`) +
      (noindex ? '<meta name="robots" content="noindex">' : '') +
      (declares === 'json-ld'
        ? '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Shirt"}</script>'
        : '') +
      (declares === 'og' ? '<meta property="og:type" content="product">' : '') +
      '</head><body><p>shirt</p></body></html>',
  });

const runVariants = (pages: readonly CrawledPage[]): Observation =>
  runSite('product-variant-canonical', pages, ['ecommerce']);

describe('product-variant-canonical', () => {
  it('says nothing about a site whose profile claims no catalogue', () => {
    const observation = runSite('product-variant-canonical', [
      product('/p/shirt', { canonical: '/p/shirt' }),
      product('/p/shirt?color=red', { canonical: '/p/shirt' }),
    ]);
    expect(observation.outcome).toBe('not-applicable');
  });

  // Guessing a product from its URL shape would drag category and search pages
  // into families whose duplicates are a different check's business.
  it('says nothing when no page declares itself a product', () => {
    const observation = runVariants([
      page({ path: '/search?q=shirt' }),
      page({ path: '/search?q=shirt&sort=price' }),
    ]);
    expect(observation.outcome).toBe('not-applicable');
    expect(observation.summary).toMatch(/declares itself a product/);
  });

  // A crawl that reached one address per product and a catalogue that only has
  // one address per product look identical from here.
  it('reports nothing observed when no product was crawled twice', () => {
    const observation = runVariants([product('/p/shirt', { canonical: '/p/shirt' })]);
    expect(observation.outcome).toBe('not-applicable');
    expect(observation.summary).toMatch(/not observable in this crawl/);
  });

  it('passes a catalogue that consolidates every variant onto the product', () => {
    const observation = runVariants([
      product('/p/shirt', { canonical: '/p/shirt' }),
      product('/p/shirt?color=red', { canonical: '/p/shirt' }),
      product('/p/shirt?color=blue', { canonical: '/p/shirt' }),
    ]);
    expect(observation.outcome).toBe('pass');
    expect(observation.data?.['familiesWithVariants']).toBe(1);
  });

  // The other defensible rule: each variant is its own page, and says so.
  it('passes self-canonical variants that are told apart', () => {
    const observation = runVariants([
      product('/p/shirt?color=red', { canonical: '/p/shirt?color=red', title: 'Red shirt' }),
      product('/p/shirt?color=blue', { canonical: '/p/shirt?color=blue', title: 'Blue shirt' }),
    ]);
    expect(observation.outcome).toBe('pass');
  });

  it('fails self-canonical variants that share one title', () => {
    const observation = runVariants([
      product('/p/shirt?color=red', { canonical: '/p/shirt?color=red' }),
      product('/p/shirt?color=blue', { canonical: '/p/shirt?color=blue' }),
    ]);
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/1 of 1 product/);
    expect(String((observation.data?.['samples'] as { issue: string }[])[0]?.issue)).toMatch(
      /compete with each other/,
    );
  });

  // The state the check exists to prevent: no rule, decided per template path.
  it('fails a product whose addresses declare different canonicals', () => {
    const observation = runVariants([
      product('/p/shirt', { canonical: '/p/shirt' }),
      product('/p/shirt?color=red', { canonical: '/p/shirt-red' }),
    ]);
    expect(observation.outcome).toBe('fail');
    expect(String((observation.data?.['samples'] as { issue: string }[])[0]?.issue)).toMatch(
      /2 different canonicals/,
    );
  });

  it('fails a variant address that declares no canonical', () => {
    const observation = runVariants([
      product('/p/shirt', { canonical: '/p/shirt' }),
      product('/p/shirt?color=red'),
    ]);
    expect(observation.outcome).toBe('fail');
    expect(String((observation.data?.['samples'] as { issue: string }[])[0]?.issue)).toMatch(
      /no rel=canonical/,
    );
  });

  // noindex is a rule too: the extra spellings are out of the index either way.
  it('accepts variants excluded by noindex rather than by canonical', () => {
    const observation = runVariants([
      product('/p/shirt', { canonical: '/p/shirt' }),
      product('/p/shirt?color=red', { noindex: true }),
      product('/p/shirt?color=blue', { noindex: true }),
    ]);
    expect(observation.outcome).toBe('pass');
  });

  it('fails a family that consolidates onto a page marked noindex', () => {
    const observation = runVariants([
      product('/p/shirt', { canonical: '/p/shirt', noindex: true }),
      product('/p/shirt?color=red', { canonical: '/p/shirt' }),
      product('/p/shirt?color=blue', { canonical: '/p/shirt' }),
    ]);
    expect(observation.outcome).toBe('fail');
    expect(String((observation.data?.['samples'] as { issue: string }[])[0]?.issue)).toMatch(
      /no indexable URL/,
    );
  });

  it('reads og:type as a product declaration where there is no JSON-LD', () => {
    const observation = runVariants([
      product('/p/shirt?color=red', { canonical: '/p/shirt?color=red', declares: 'og' }),
      product('/p/shirt?color=blue', { canonical: '/p/shirt?color=blue', declares: 'og' }),
    ]);
    expect(observation.outcome).toBe('fail');
  });

  // A facet URL on a listing route is a duplicate of a listing, not a product.
  it('leaves routes no product declares out of the families it judges', () => {
    const observation = runVariants([
      product('/p/shirt', { canonical: '/p/shirt' }),
      product('/p/shirt?color=red', { canonical: '/p/shirt' }),
      page({ path: '/c/shirts' }),
      page({ path: '/c/shirts?sort=price' }),
    ]);
    expect(observation.outcome).toBe('pass');
    expect(observation.data?.['familiesWithVariants']).toBe(1);
  });
});

// --- 1.15 product-lifecycle-state -------------------------------------------

interface LifecycleSpec {
  /** One or more schema.org availability values; absent means no offer at all. */
  readonly availability?: string | readonly string[];
  readonly canonical?: string;
  readonly noindex?: boolean;
}

const stocked = (
  path: string,
  { availability, canonical, noindex = false }: LifecycleSpec = {},
): CrawledPage => {
  const offers = [availability ?? []]
    .flat()
    .map((value) => `{"@type":"Offer","price":"10","availability":"${value}"}`)
    .join(',');
  return page({
    path,
    html:
      '<html><head><title>Shirt</title>' +
      (canonical === undefined ? '' : `<link rel="canonical" href="${ORIGIN}${canonical}">`) +
      (noindex ? '<meta name="robots" content="noindex">' : '') +
      '<script type="application/ld+json">' +
      `{"@context":"https://schema.org","@type":"Product","name":"Shirt","offers":[${offers}]}` +
      '</script></head><body><p>shirt</p></body></html>',
  });
};

const IN_STOCK = 'https://schema.org/InStock';
const OUT_OF_STOCK = 'https://schema.org/OutOfStock';
const DISCONTINUED = 'https://schema.org/Discontinued';

const runLifecycle = (
  pages: readonly CrawledPage[],
  sitemapUrls: readonly string[] = [],
): Observation =>
  siteProbe('product-lifecycle-state').run(siteOf(pages, ['ecommerce'], [], sitemapUrls));

describe('product-lifecycle-state', () => {
  it('says nothing about a site whose profile claims no catalogue', () => {
    const observation = siteProbe('product-lifecycle-state').run(
      siteOf([stocked('/p/shirt', { availability: OUT_OF_STOCK, noindex: true })]),
    );
    expect(observation.outcome).toBe('not-applicable');
  });

  it('says nothing when no page declares itself a product', () => {
    const observation = runLifecycle([page({ path: '/c/shirts' })]);
    expect(observation.outcome).toBe('not-applicable');
    expect(observation.summary).toMatch(/declares itself a product/);
  });

  // Availability is how a product states its lifecycle to a machine. Without
  // it there is nothing here to be right or wrong about.
  it('reports nothing observed when products declare no availability', () => {
    const observation = runLifecycle([stocked('/p/shirt', { canonical: '/p/shirt' })]);
    expect(observation.outcome).toBe('not-applicable');
    expect(observation.summary).toMatch(/declare an availability state/);
  });

  // A catalogue with nothing retired in it and a crawl that reached none of
  // what is are indistinguishable from here.
  it('reports nothing observed when every product crawled is still for sale', () => {
    const observation = runLifecycle([
      stocked('/p/shirt', { availability: IN_STOCK }),
      stocked('/p/hat', { availability: 'InStock' }),
    ]);
    expect(observation.outcome).toBe('not-applicable');
    expect(observation.summary).toMatch(/still for sale/);
  });

  it('passes an out-of-stock product kept indexable at its own URL', () => {
    const observation = runLifecycle([
      stocked('/p/shirt', { availability: OUT_OF_STOCK, canonical: '/p/shirt' }),
      stocked('/p/hat', { availability: IN_STOCK }),
    ]);
    expect(observation.outcome).toBe('pass');
    expect(observation.data?.['withdrawn']).toBe(1);
    expect(observation.data?.['treatments']).toEqual({ kept: 1, excluded: 0, consolidated: 0 });
  });

  // The mistake the corpus names: out of stock is not gone, and the URL has
  // links and history that excluding it throws away.
  it('fails an out-of-stock product excluded from the index', () => {
    const observation = runLifecycle([
      stocked('/p/shirt', { availability: OUT_OF_STOCK, noindex: true }),
    ]);
    expect(observation.outcome).toBe('fail');
    expect(String((observation.data?.['samples'] as { issue: string }[])[0]?.issue)).toMatch(
      /out of stock and is marked noindex/,
    );
  });

  it('fails an out-of-stock product canonicalized onto its category', () => {
    const observation = runLifecycle([
      stocked('/p/shirt', { availability: 'SoldOut', canonical: '/c/shirts' }),
    ]);
    expect(observation.outcome).toBe('fail');
    expect(String((observation.data?.['samples'] as { issue: string }[])[0]?.issue)).toMatch(
      /canonicalized onto another route/,
    );
  });

  // A canonical to another query on the same route is variant consolidation,
  // which product-variant-canonical judges. Two detectors, one fact, would be
  // the same finding reported twice under different names.
  it('leaves a canonical within the same route to the variant detector', () => {
    const observation = runLifecycle([
      stocked('/p/shirt?color=red', { availability: OUT_OF_STOCK, canonical: '/p/shirt' }),
    ]);
    expect(observation.outcome).toBe('pass');
  });

  it('passes discontinued products retired from the index under one rule', () => {
    const observation = runLifecycle([
      stocked('/p/shirt', { availability: DISCONTINUED, noindex: true }),
      stocked('/p/hat', { availability: DISCONTINUED, noindex: true }),
    ]);
    expect(observation.outcome).toBe('pass');
    expect(observation.data?.['retired']).toBe(2);
  });

  // The corpus asks for a defined handling of a discontinued product, not for
  // a particular one — so what a machine can see is whether there is one.
  it('fails a catalogue that handles discontinued products two ways', () => {
    const observation = runLifecycle([
      stocked('/p/shirt', { availability: DISCONTINUED, noindex: true }),
      stocked('/p/hat', { availability: DISCONTINUED, canonical: '/p/hat' }),
    ]);
    expect(observation.outcome).toBe('fail');
    expect(String((observation.data?.['samples'] as { issue: string }[])[0]?.issue)).toMatch(
      /2 different ways/,
    );
  });

  it('fails a retired product that is noindex and still in the sitemap', () => {
    const observation = runLifecycle(
      [stocked('/p/shirt', { availability: DISCONTINUED, noindex: true })],
      [`${ORIGIN}/p/shirt`],
    );
    expect(observation.outcome).toBe('fail');
    expect(String((observation.data?.['samples'] as { issue: string }[])[0]?.issue)).toMatch(
      /still listed in the sitemap/,
    );
  });

  // A group with one variant gone and another in stock is a product you can
  // still buy, and treating its URL as gone would be the mistake.
  it('reads a product as for sale while any of its offers is', () => {
    const observation = runLifecycle([
      stocked('/p/shirt', { availability: [DISCONTINUED, IN_STOCK], noindex: true }),
    ]);
    expect(observation.outcome).toBe('not-applicable');
    expect(observation.summary).toMatch(/still for sale/);
  });
});

// --- 2.7 schema-eligibility-matrix ------------------------------------------

/** A page whose visible content is `body` and whose JSON-LD is `blocks`. */
const marked = (path: string, blocks: readonly unknown[], body = 'Hello'): CrawledPage =>
  page({
    path,
    html:
      '<html><head>' +
      blocks
        .map((block) => `<script type="application/ld+json">${JSON.stringify(block)}</script>`)
        .join('') +
      `</head><body><h1>${body}</h1></body></html>`,
  });

const SCHEMA = 'https://schema.org';

interface SchemaSample {
  readonly url: string;
  readonly type: string;
  readonly issue: string;
}

const runMatrix = (pages: readonly CrawledPage[]): Observation =>
  runSite('schema-eligibility-matrix', pages, ['structured-data']);

describe('schema-eligibility-matrix', () => {
  it('says nothing about a site whose profile claims no eligible templates', () => {
    const observation = runSite('schema-eligibility-matrix', [
      marked('/', [{ '@context': SCHEMA, '@type': 'Organization', name: 'Acme' }]),
    ]);
    expect(observation.outcome).toBe('not-applicable');
  });

  // The flag is the site saying it has templates worth marking up. Silence
  // after that statement is the finding, and no single page can see it.
  it('fails a site that claims eligible templates and marks none of them up', () => {
    const observation = runMatrix([page({ path: '/' }), page({ path: '/about' })]);
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/none of 2 crawled page\(s\) carries any/);
  });

  it('passes markup that is complete and backed by what the page shows', () => {
    const observation = runMatrix([
      marked(
        '/p/shirt',
        [
          {
            '@context': SCHEMA,
            '@type': 'Product',
            name: 'Blue Shirt',
            offers: { '@type': 'Offer', price: '10.00' },
          },
        ],
        'Blue Shirt',
      ),
    ]);
    expect(observation.outcome).toBe('pass');
    expect(observation.data?.['types']).toEqual(['Product']);
  });

  it('fails a type that is missing a property its consumers require', () => {
    const observation = runMatrix([
      marked('/e/launch', [{ '@context': SCHEMA, '@type': 'Event', name: 'Launch' }], 'Launch'),
    ]);
    expect(observation.outcome).toBe('fail');
    expect(String((observation.data?.['samples'] as SchemaSample[])[0]?.issue)).toMatch(
      /missing required startDate, location/,
    );
  });

  it('fails a Product with nothing to offer, review or rate', () => {
    const observation = runMatrix([
      marked('/p/shirt', [{ '@context': SCHEMA, '@type': 'Product', name: 'Shirt' }], 'Shirt'),
    ]);
    expect(observation.outcome).toBe('fail');
    expect(String((observation.data?.['samples'] as SchemaSample[])[0]?.issue)).toMatch(
      /has none of offers, review, aggregateRating/,
    );
  });

  // The whole point of the matrix column headed "visible-content source".
  it('fails markup describing a subject the page never shows', () => {
    const observation = runMatrix([
      marked(
        '/blog/post',
        [{ '@context': SCHEMA, '@type': 'Article', headline: 'Ten Ways To Rank' }],
        'A completely different heading',
      ),
    ]);
    expect(observation.outcome).toBe('fail');
    expect(String((observation.data?.['samples'] as SchemaSample[])[0]?.issue)).toMatch(
      /appears nowhere in the visible content/,
    );
  });

  it('fails a block declared outside the schema.org vocabulary', () => {
    const observation = runMatrix([
      marked('/', [{ '@type': 'Organization', name: 'Acme' }], 'Acme'),
    ]);
    expect(observation.outcome).toBe('fail');
    expect(String((observation.data?.['samples'] as SchemaSample[])[0]?.issue)).toMatch(
      /outside the schema\.org @context/,
    );
  });

  it('fails markup a parser cannot read at all', () => {
    const observation = runMatrix([
      page({
        path: '/',
        html:
          '<html><head><script type="application/ld+json">{ not json }</script>' +
          '</head><body><h1>Acme</h1></body></html>',
      }),
    ]);
    expect(observation.outcome).toBe('fail');
    expect(String((observation.data?.['samples'] as SchemaSample[])[0]?.issue)).toMatch(
      /failed to parse/,
    );
  });

  // The corpus is explicit that accurate FAQPage markup may stay, so this is
  // guidance about what to build next rather than a defect in what was built.
  it('warns about a type that no longer earns a rich result, without failing it', () => {
    const observation = runMatrix([
      marked(
        '/faq',
        [
          {
            '@context': SCHEMA,
            '@type': 'FAQPage',
            mainEntity: [{ '@type': 'Question', name: 'Do you ship?' }],
          },
        ],
        'Do you ship?',
      ),
    ]);
    expect(observation.outcome).toBe('warn');
    expect(observation.summary).toMatch(/FAQPage/);
  });

  // schema.org is vast and Google is not its only consumer. Holding no
  // requirements for a type is a fact about this engine, not about the site.
  it('leaves a type it has no requirements for alone', () => {
    const observation = runMatrix([
      marked('/data', [{ '@context': SCHEMA, '@type': 'Dataset', name: 'Nowhere in the body' }]),
    ]);
    expect(observation.outcome).toBe('pass');
    expect(observation.data?.['types']).toEqual(['Dataset']);
  });
});

// --- 2.14 video-watch-page, videoobject-schema, video-sitemap ---------------

/** Enough words that a thin-context warning is not the thing under test. */
const PROSE = 'A short film about the making of the thing this page is about. '.repeat(6);

const VIDEO_SCHEMA = {
  '@context': SCHEMA,
  '@type': 'VideoObject',
  name: 'How we make it',
  description: 'Ten minutes in the workshop.',
  thumbnailUrl: `${ORIGIN}/thumbs/workshop.jpg`,
  uploadDate: '2026-03-01',
  contentUrl: 'https://www.youtube.com/watch?v=abc123',
};

interface WatchPageSpec {
  readonly path?: string;
  /** Markup for the player itself; omit for a page with no video. */
  readonly player?: string;
  readonly schema?: Record<string, unknown> | null;
  readonly head?: string;
  readonly body?: string;
}

const watchPage = ({
  path = '/watch/workshop',
  player = `<video src="${ORIGIN}/media/workshop.mp4" poster="${ORIGIN}/thumbs/workshop.jpg"></video>`,
  schema = null,
  head = '',
  body = PROSE,
}: WatchPageSpec): CrawledPage =>
  page({
    path,
    html:
      `<html><head><title>How we make it</title>${head}` +
      (schema === null
        ? ''
        : `<script type="application/ld+json">${JSON.stringify(schema)}</script>`) +
      `</head><body><h1>How we make it</h1>${player}<p>${body}</p></body></html>`,
  });

const YOUTUBE_EMBED = '<iframe src="https://www.youtube.com/embed/abc123"></iframe>';

/** A site whose robots.txt, sitemap documents and video entries are the subject. */
const videoSite = (
  pages: readonly CrawledPage[],
  extra: {
    readonly robotsTxt?: string;
    readonly sitemaps?: CrawlResult['sitemaps'];
    readonly sitemapVideos?: CrawlResult['sitemapVideos'];
  } = {},
): SiteContext => ({
  origin: ORIGIN,
  flags: ['video'],
  crawl: {
    seeds: [`${ORIGIN}/`],
    pages,
    robots:
      extra.robotsTxt === undefined
        ? { groups: [], sitemaps: [], absent: true }
        : parseRobots(extra.robotsTxt),
    robotsTxt: extra.robotsTxt ?? null,
    sitemapUrls: (extra.sitemapVideos ?? []).map((entry) => entry.loc),
    sitemaps: extra.sitemaps ?? [],
    sitemapVideos: extra.sitemapVideos ?? [],
    blockedByRobots: [],
    notReached: [],
    auxiliary: [],
  } satisfies CrawlResult,
});

const sitemapVideo = (
  loc: string,
  overrides: Partial<CrawlResult['sitemapVideos'][number]> = {},
): CrawlResult['sitemapVideos'][number] => ({
  sitemap: `${ORIGIN}/video-sitemap.xml`,
  loc,
  title: 'How we make it',
  description: 'Ten minutes in the workshop.',
  thumbnailUrl: `${ORIGIN}/thumbs/workshop.jpg`,
  contentUrl: `${ORIGIN}/media/workshop.mp4`,
  playerUrl: null,
  ...overrides,
});

const runVideoPage = (id: string, target: CrawledPage, site: SiteContext): Observation =>
  pageProbe(id).run({ page: target, site });

describe('video-watch-page', () => {
  it('says nothing about a page with no video on it', () => {
    const plain = page({ path: '/about' });
    expect(runVideoPage('video-watch-page', plain, videoSite([plain])).outcome).toBe(
      'not-applicable',
    );
  });

  it('passes an indexable page with a player, a thumbnail and context', () => {
    const target = watchPage({});
    const observation = runVideoPage('video-watch-page', target, videoSite([target]));
    expect(observation.outcome).toBe('pass');
    expect(observation.data?.['players']).toBe(1);
  });

  // The iframe is how nearly all web video arrives, and a crawl that only knew
  // about <video> would call the average video site videoless.
  it('recognises a third-party player embedded in a frame', () => {
    const target = watchPage({
      player: YOUTUBE_EMBED,
      head: `<meta property="og:image" content="${ORIGIN}/t.jpg">`,
    });
    const observation = runVideoPage('video-watch-page', target, videoSite([target]));
    expect(observation.outcome).toBe('pass');
    expect(observation.data?.['players']).toBe(1);
  });

  it('fails a video whose page is noindex, because the video has no watch page', () => {
    const target = watchPage({ head: '<meta name="robots" content="noindex">' });
    const observation = runVideoPage('video-watch-page', target, videoSite([target]));
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/noindex/);
  });

  // Googlebot-Video fetches the file and Googlebot-Image the thumbnail. A
  // disallowed media directory is the commonest way a site hides its own video
  // from search while believing it has published it.
  it('fails when robots.txt refuses the player or its thumbnail', () => {
    const target = watchPage({});
    const observation = runVideoPage(
      'video-watch-page',
      target,
      videoSite([target], { robotsTxt: 'User-agent: *\nDisallow: /media/\n' }),
    );
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/robots\.txt blocks/);
    expect((observation.data?.['blocked'] as string[])[0]).toMatch(/workshop\.mp4/);
  });

  it('warns about a player with no thumbnail and nothing said around it', () => {
    const target = watchPage({
      player: `<video src="${ORIGIN}/media/workshop.mp4"></video>`,
      body: 'Watch.',
    });
    const observation = runVideoPage('video-watch-page', target, videoSite([target]));
    expect(observation.outcome).toBe('warn');
    expect(observation.summary).toMatch(/no thumbnail is declared/);
    expect(observation.summary).toMatch(/words of context/);
  });
});

describe('videoobject-schema', () => {
  it('says nothing about a page with no video on it', () => {
    const plain = page({ path: '/about' });
    expect(runVideoPage('videoobject-schema', plain, videoSite([plain])).outcome).toBe(
      'not-applicable',
    );
  });

  it('fails a video the page describes to nobody', () => {
    const target = watchPage({ player: YOUTUBE_EMBED });
    const observation = runVideoPage('videoobject-schema', target, videoSite([target]));
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/none is described by VideoObject/);
  });

  it('passes markup that is complete and names the video the page plays', () => {
    const target = watchPage({ player: YOUTUBE_EMBED, schema: VIDEO_SCHEMA });
    const observation = runVideoPage('videoobject-schema', target, videoSite([target]));
    expect(observation.outcome).toBe('pass');
  });

  it('fails a node missing what a video result requires', () => {
    const { description, thumbnailUrl, ...rest } = VIDEO_SCHEMA;
    expect([description, thumbnailUrl]).toBeTruthy();
    const target = watchPage({ player: YOUTUBE_EMBED, schema: rest });
    const observation = runVideoPage('videoobject-schema', target, videoSite([target]));
    expect(observation.outcome).toBe('fail');
    expect(String((observation.data?.['samples'] as { issue: string }[])[0]?.issue)).toMatch(
      /missing required description, thumbnailUrl/,
    );
  });

  it('fails a node with no way to play the video it describes', () => {
    const { contentUrl, ...rest } = VIDEO_SCHEMA;
    expect(contentUrl).toBeTruthy();
    const target = watchPage({ player: YOUTUBE_EMBED, schema: rest });
    const observation = runVideoPage('videoobject-schema', target, videoSite([target]));
    expect(observation.outcome).toBe('fail');
    expect(String((observation.data?.['samples'] as { issue: string }[])[0]?.issue)).toMatch(
      /neither contentUrl nor embedUrl/,
    );
  });

  // A date a reader understands and a parser does not is the same as no date.
  it('fails an uploadDate written for a reader rather than a machine', () => {
    const target = watchPage({
      player: YOUTUBE_EMBED,
      schema: { ...VIDEO_SCHEMA, uploadDate: 'March 2026' },
    });
    const observation = runVideoPage('videoobject-schema', target, videoSite([target]));
    expect(observation.outcome).toBe('fail');
    expect(String((observation.data?.['samples'] as { issue: string }[])[0]?.issue)).toMatch(
      /not an ISO 8601 date/,
    );
  });

  // Complete markup about a video that is not on the page is markup about
  // something else, and only comparing the two shows it.
  it('warns when the markup and the player name different videos', () => {
    const target = watchPage({
      player: YOUTUBE_EMBED,
      schema: { ...VIDEO_SCHEMA, contentUrl: 'https://www.youtube.com/watch?v=zzz999' },
    });
    const observation = runVideoPage('videoobject-schema', target, videoSite([target]));
    expect(observation.outcome).toBe('warn');
    expect(observation.summary).toMatch(/does not play/);
  });

  it('warns when more videos play than are described', () => {
    const target = watchPage({
      player: `${YOUTUBE_EMBED}<iframe src="https://player.vimeo.com/video/999"></iframe>`,
      schema: VIDEO_SCHEMA,
    });
    const observation = runVideoPage('videoobject-schema', target, videoSite([target]));
    expect(observation.outcome).toBe('warn');
    expect(observation.summary).toMatch(/2 video\(s\) play here and 1 are described/);
  });
});

describe('video-sitemap', () => {
  const runVideoSitemap = (site: SiteContext): Observation => siteProbe('video-sitemap').run(site);

  // The corpus asks for a video sitemap only where it materially improves
  // discovery, which is a judgement about a site's traffic, not its markup.
  it('says nothing about a site that publishes no video sitemap', () => {
    const observation = runVideoSitemap(videoSite([watchPage({})]));
    expect(observation.outcome).toBe('not-applicable');
    expect(observation.summary).toMatch(/1 page\(s\) carrying video/);
  });

  it('fails a video sitemap the site declares and the server does not serve', () => {
    const observation = runVideoSitemap(
      videoSite([watchPage({})], {
        sitemaps: [
          {
            url: `${ORIGIN}/video-sitemap.xml`,
            status: 404,
            urlCount: 0,
            videoCount: 0,
            truncated: false,
          },
        ],
      }),
    );
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/could not be fetched/);
  });

  it('passes entries that are complete and on this site', () => {
    const target = watchPage({});
    const observation = runVideoSitemap(
      videoSite([target], { sitemapVideos: [sitemapVideo(target.normalizedUrl)] }),
    );
    expect(observation.outcome).toBe('pass');
    expect(observation.data?.['entries']).toBe(1);
  });

  it('fails an entry missing the fields that make it usable', () => {
    const target = watchPage({});
    const observation = runVideoSitemap(
      videoSite([target], {
        sitemapVideos: [
          sitemapVideo(target.normalizedUrl, { description: null, thumbnailUrl: null }),
        ],
      }),
    );
    expect(observation.outcome).toBe('fail');
    expect(String((observation.data?.['samples'] as { issue: string }[])[0]?.issue)).toMatch(
      /missing video:description, video:thumbnail_loc/,
    );
  });

  it('fails an entry listing a watch page on another origin', () => {
    const target = watchPage({});
    const observation = runVideoSitemap(
      videoSite([target], { sitemapVideos: [sitemapVideo('https://cdn.elsewhere.test/watch/1')] }),
    );
    expect(observation.outcome).toBe('fail');
    expect(String((observation.data?.['samples'] as { issue: string }[])[0]?.issue)).toMatch(
      /another origin/,
    );
  });

  it('fails an entry whose thumbnail robots.txt refuses', () => {
    const target = watchPage({});
    const observation = runVideoSitemap(
      videoSite([target], {
        robotsTxt: 'User-agent: *\nDisallow: /thumbs/\n',
        sitemapVideos: [sitemapVideo(target.normalizedUrl)],
      }),
    );
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/robots\.txt refuses/);
  });

  // A player injected by script leaves nothing in the HTML, so the sitemap
  // gets the benefit of the doubt and the report gets the discrepancy.
  it('warns about an entry naming a page the crawl found no video on', () => {
    const plain = page({ path: '/watch/gone' });
    const observation = runVideoSitemap(
      videoSite([plain], { sitemapVideos: [sitemapVideo(plain.normalizedUrl)] }),
    );
    expect(observation.outcome).toBe('warn');
    expect(observation.summary).toMatch(/found no video on/);
  });
});

// --- a sitemap the crawler had to cut ---------------------------------------

/**
 * The case TED found: a 10 MB video sitemap read to the 5 MB limit, ending in
 * a severed entry that has a title and a thumbnail and no description. Judged
 * naively, the engine's own budget is reported as the site's missing field.
 */
describe('a truncated sitemap', () => {
  const severed = sitemapVideo(`${ORIGIN}/watch/last`, {
    description: null,
    contentUrl: null,
    playerUrl: null,
  });

  const cutSitemap = (videoCount: number): CrawlResult['sitemaps'][number] => ({
    url: `${ORIGIN}/video-sitemap.xml`,
    status: 200,
    urlCount: 3608,
    videoCount,
    truncated: true,
  });

  it('stops video-sitemap judging the entries it managed to read', () => {
    const target = watchPage({});
    const observation = siteProbe('video-sitemap').run(
      videoSite([target], {
        sitemaps: [cutSitemap(3608)],
        sitemapVideos: [sitemapVideo(target.normalizedUrl), severed],
      }),
    );
    expect(observation.outcome).toBe('error');
    expect(observation.summary).toMatch(/too large to read in full/);
  });

  // Without the flag this is a fail: an entry with no description and no way
  // to play it is exactly what the detector exists to catch.
  it('is the difference between an error and a defect', () => {
    const target = watchPage({});
    const observation = siteProbe('video-sitemap').run(
      videoSite([target], {
        sitemaps: [{ ...cutSitemap(2), truncated: false }],
        sitemapVideos: [sitemapVideo(target.normalizedUrl), severed],
      }),
    );
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/unusable/);
  });

  it('stops index-bloat calling a page missing from a list it never finished reading', () => {
    const target = watchPage({ path: '/watch/one' });
    const observation = siteProbe('index-bloat').run(
      videoSite([target], {
        sitemaps: [cutSitemap(0)],
        sitemapVideos: [sitemapVideo(`${ORIGIN}/watch/other`)],
      }),
    );
    expect(observation.outcome).toBe('error');
    expect(observation.summary).toMatch(/too large to read in full/);
  });
});
