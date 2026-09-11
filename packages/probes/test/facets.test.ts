/**
 * The two detectors behind corpus check 1.12: `parameter-crawl-space` and
 * `faceted-nav-control`.
 *
 * Hand-built pages again, for the reason `detectors.test.ts` gives: each case is
 * a shape — a filter state at two spellings, a crawl budget spent on sort
 * orders, a noindexed filter still in the sitemap — and the markup goes through
 * the real `extract`. Kept in a file of its own because both detectors read
 * parts of the crawl the other suite's context never sets: what was left
 * unfetched, and what robots.txt kept out.
 */

import { describe, expect, it } from 'vitest';
import { extract } from '@seo/crawler';
import type { CrawledPage, CrawlResult, RedirectHop } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const ORIGIN = 'https://shop.example';

interface Spec {
  readonly title?: string;
  /** A path, or null for none. Defaults to none. */
  readonly canonical?: string | null;
  readonly noindex?: boolean;
  readonly status?: number;
  readonly links?: readonly string[];
  readonly product?: boolean;
  readonly redirectedTo?: string;
}

const page = (path: string, spec: Spec = {}): CrawledPage => {
  const { title = 'Shoes', canonical = null, noindex = false, status = 200, links = [] } = spec;
  const url = `${ORIGIN}${path}`;
  const html =
    '<html><head>' +
    `<title>${title}</title>` +
    (canonical === null ? '' : `<link rel="canonical" href="${ORIGIN}${canonical}">`) +
    (noindex ? '<meta name="robots" content="noindex">' : '') +
    (spec.product === true
      ? '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Shoe"}</script>'
      : '') +
    '</head><body><p>listing</p>' +
    links.map((href) => `<a href="${href}">link</a>`).join('') +
    '</body></html>';
  const redirectChain: RedirectHop[] = spec.redirectedTo === undefined
    ? []
    : [{ url, status: 301, location: `${ORIGIN}${spec.redirectedTo}` }];
  const finalUrl = spec.redirectedTo === undefined ? url : `${ORIGIN}${spec.redirectedTo}`;
  return {
    url,
    normalizedUrl: url,
    depth: 1,
    discoveredFrom: null,
    fetch: {
      requestedUrl: url,
      finalUrl,
      status,
      headers: { 'content-type': 'text/html' },
      redirectChain,
      body: html,
      byteLength: html.length,
      truncated: false,
      contentType: 'text/html',
      ttfbMs: 1,
      totalMs: 2,
      error: null,
    },
    extracted: status === 200 ? extract(html, finalUrl) : null,
  };
};

interface Crawl {
  readonly notReached?: readonly string[];
  readonly blockedByRobots?: readonly string[];
  readonly sitemapUrls?: readonly string[];
}

const run = (id: string, pages: readonly CrawledPage[], rest: Crawl = {}): Observation =>
  (probeById(id) as SiteProbe).run({
    origin: ORIGIN,
    flags: ['faceted-nav'],
    crawl: {
      seeds: [`${ORIGIN}/`],
      pages,
      robots: { groups: [], sitemaps: [], absent: true },
      robotsTxt: null,
      sitemapUrls: (rest.sitemapUrls ?? []).map((path) => `${ORIGIN}${path}`),
      sitemaps: [],
      sitemapVideos: [],
      blockedByRobots: (rest.blockedByRobots ?? []).map((path) => `${ORIGIN}${path}`),
      notReached: (rest.notReached ?? []).map((path) => `${ORIGIN}${path}`),
      auxiliary: [],
    } satisfies CrawlResult,
  });

const issues = (observation: Observation): string =>
  JSON.stringify(observation.data?.['samples'] ?? []);

// --- parameter-crawl-space ---------------------------------------------------

const space = (pages: readonly CrawledPage[], rest?: Crawl): Observation =>
  run('parameter-crawl-space', pages, rest);

describe('parameter-crawl-space', () => {
  it('says nothing about a site whose crawl found no parameter URLs', () => {
    expect(space([page('/'), page('/shoes')]).outcome).toBe('not-applicable');
  });

  it('passes a bounded set of parameter URLs', () => {
    const observation = space([
      page('/shoes'),
      page('/shoes?color=red'),
      page('/shoes?color=blue'),
      page('/shoes?sort=price'),
    ]);
    expect(observation.outcome).toBe('pass');
    expect(observation.data).toMatchObject({ parameterUrls: 3, routes: 1 });
  });

  it('counts a URL robots.txt kept out as part of the space, not a defect of it', () => {
    const observation = space([page('/shoes')], { blockedByRobots: ['/shoes?color=red'] });
    expect(observation.outcome).toBe('pass');
    expect(observation.summary).toContain('closed to crawling by robots.txt');
    expect(observation.data).toMatchObject({ blockedByRobots: 1 });
  });

  it('fails a session identifier in the query, where every visit mints new URLs', () => {
    const observation = space([page('/shoes'), page('/shoes?jsessionid=A1B2C3')]);
    expect(observation.outcome).toBe('fail');
    expect(issues(observation)).toContain('session identifier');
  });

  it('fails a session identifier written as a path parameter', () => {
    const observation = space([page('/shoes'), page('/shoes;jsessionid=A1B2C3?color=red')]);
    expect(observation.outcome).toBe('fail');
    expect(issues(observation)).toContain('jsessionid');
  });

  it('leaves a parameter that is only sometimes a session alone', () => {
    // `?session=keynote` is a conference session on this site, and a detector
    // that failed it would teach people to ignore the real finding.
    expect(space([page('/talks'), page('/talks?session=keynote')]).outcome).toBe('pass');
  });

  it('fails one filter state reachable in two parameter orders', () => {
    const observation = space([
      page('/shoes'),
      page('/shoes?color=red&size=9'),
      page('/shoes?size=9&color=red'),
    ]);
    expect(observation.outcome).toBe('fail');
    expect(issues(observation)).toContain('more than one spelling');
  });

  it('fails a crawl whose budget ran out on variants of routes it had already fetched', () => {
    const left = Array.from({ length: 12 }, (_, i) => `/shoes?color=c${i}&sort=price`);
    const observation = space([page('/shoes'), page('/shoes?color=red')], {
      notReached: [...left, '/boots', '/sandals'],
    });
    expect(observation.outcome).toBe('fail');
    expect(issues(observation)).toContain('budget ran out with 12 of 14');
  });

  it('holds rather than passes when filter URLs were found and never followed', () => {
    // Bounded is only observed by walking the space; an unopened filter URL
    // might lead nowhere or to a thousand more.
    const observation = space([page('/shoes'), page('/shoes?color=red')], {
      notReached: ['/shoes?color=blue', '/shoes?color=green', '/boots'],
    });
    expect(observation.outcome).toBe('warn');
    expect(observation.summary).toContain('2 filter or sort URL(s) were linked and left unfetched');
  });

  it('does not read unfetched variants of routes the crawl never reached as an exhausted budget', () => {
    // Twelve filters on a listing nobody fetched is a crawl that ran out of
    // documents, not one spent on permutations.
    const left = Array.from({ length: 12 }, (_, i) => `/boots?color=c${i}`);
    const observation = space([page('/shoes'), page('/shoes?color=red')], { notReached: left });
    expect(observation.outcome).toBe('warn');
    expect(observation.summary).not.toContain('budget ran out with');
  });

  it('passes when what was left unfetched is pagination, not filters', () => {
    const observation = space([page('/shoes'), page('/shoes?color=red')], {
      notReached: ['/shoes?page=7', '/boots'],
    });
    expect(observation.outcome).toBe('pass');
    expect(observation.summary).toContain('followed every filter URL it found');
  });

  it('warns about campaign parameters on internal links, which normalization hides', () => {
    const observation = space([
      page('/', { links: ['/shoes?utm_source=homepage&utm_medium=banner'] }),
      page('/shoes'),
    ]);
    expect(observation.outcome).toBe('warn');
    expect(issues(observation)).toContain('utm_source=homepage');
  });

  it('ignores campaign parameters on links to other sites', () => {
    expect(space([page('/', { links: ['https://partner.example/?utm_source=shop'] })]).outcome)
      .toBe('not-applicable');
  });
});

// --- faceted-nav-control ------------------------------------------------------

const control = (pages: readonly CrawledPage[], rest?: Crawl): Observation =>
  run('faceted-nav-control', pages, rest);

describe('faceted-nav-control', () => {
  it('says nothing when the only parameters are pagination and search', () => {
    // Both have detectors of their own (1.13, 1.4); neither is a facet.
    const observation = control([
      page('/shoes', { canonical: '/shoes' }),
      page('/shoes?page=2', { canonical: '/shoes?page=2' }),
      page('/search?q=boots'),
    ]);
    expect(observation.outcome).toBe('not-applicable');
  });

  it('holds when the site links its filters and the crawl opened none of them', () => {
    // Not-applicable would say "no facets here", which the links contradict.
    const observation = control([page('/shoes', { canonical: '/shoes' })], {
      notReached: ['/shoes?color=red', '/shoes?sort=price', '/shoes?page=2'],
    });
    expect(observation.outcome).toBe('warn');
    expect(observation.summary).toContain('2 filtered URL(s) were linked but none was fetched');
  });

  it('passes filters that each carry a decision, whichever decision it is', () => {
    const observation = control([
      page('/shoes', { title: 'Shoes', canonical: '/shoes' }),
      page('/shoes?sort=price', { canonical: '/shoes' }),
      page('/shoes?size=9', { noindex: true }),
      page('/shoes?color=red', { title: 'Red shoes', canonical: '/shoes?color=red' }),
    ]);
    expect(observation.outcome).toBe('pass');
    expect(observation.summary).toContain('1 self-canonical, 1 marked noindex, 1 canonicalized elsewhere');
  });

  it('fails a filtered page that is indexable with no canonical', () => {
    const observation = control([
      page('/shoes', { canonical: '/shoes' }),
      page('/shoes?color=red', { title: 'Red shoes' }),
    ]);
    expect(observation.outcome).toBe('fail');
    expect(issues(observation)).toContain('indexable with no canonical');
  });

  it('fails a noindexed filter that the sitemap still submits', () => {
    const observation = control(
      [page('/shoes', { canonical: '/shoes' }), page('/shoes?size=9', { noindex: true })],
      { sitemapUrls: ['/shoes', '/shoes?size=9'] },
    );
    expect(observation.outcome).toBe('fail');
    expect(issues(observation)).toContain('still submitted in the sitemap');
  });

  it('fails a filter consolidated onto a page that cannot be indexed', () => {
    const noindexed = control([
      page('/shoes', { noindex: true }),
      page('/shoes?sort=price', { canonical: '/shoes' }),
    ]);
    expect(noindexed.outcome).toBe('fail');
    expect(issues(noindexed)).toContain('is marked noindex');

    const missing = control([
      page('/shoes', { status: 404 }),
      page('/shoes?sort=price', { canonical: '/shoes' }),
    ]);
    expect(missing.outcome).toBe('fail');
    expect(issues(missing)).toContain('answered 404');
  });

  it('fails a filter robots.txt closes to crawling while the sitemap submits it', () => {
    const observation = control([page('/shoes', { canonical: '/shoes' })], {
      blockedByRobots: ['/shoes?color=red'],
      sitemapUrls: ['/shoes?color=red'],
    });
    expect(observation.outcome).toBe('fail');
    expect(issues(observation)).toContain('closed to crawling by robots.txt');
  });

  it('passes filters kept out of crawling by robots.txt and out of the sitemap', () => {
    const observation = control([page('/shoes', { canonical: '/shoes' })], {
      blockedByRobots: ['/shoes?color=red', '/shoes?sort=price'],
    });
    expect(observation.outcome).toBe('pass');
    expect(observation.summary).toContain('2 closed to crawling by robots.txt');
  });

  it('fails a self-canonical filter that carries its listing’s title', () => {
    const observation = control([
      page('/shoes', { title: 'Shoes', canonical: '/shoes' }),
      page('/shoes?sort=price', { title: 'Shoes', canonical: '/shoes?sort=price' }),
    ]);
    expect(observation.outcome).toBe('fail');
    expect(issues(observation)).toContain('share a title');
    expect(issues(observation)).toContain('sort=price');
  });

  it('leaves a filtered series’ later pages sharing the first page’s title to pagination', () => {
    const observation = control([
      page('/shoes', { title: 'Shoes', canonical: '/shoes' }),
      page('/shoes?color=red', { title: 'Red shoes', canonical: '/shoes?color=red' }),
      page('/shoes?color=red&page=2', { title: 'Red shoes', canonical: '/shoes?color=red&page=2' }),
    ]);
    expect(observation.outcome).toBe('pass');
  });

  it('leaves a product’s variant parameters to product-variant-canonical', () => {
    const observation = control([
      page('/p/runner', { product: true, canonical: '/p/runner' }),
      page('/p/runner?color=red', { product: true }),
    ]);
    expect(observation.outcome).toBe('not-applicable');
  });

  it('treats a filter that redirects as consolidated by the redirect', () => {
    const observation = control([
      page('/shoes/red', { title: 'Red shoes', canonical: '/shoes/red' }),
      page('/shoes?color=red', { redirectedTo: '/shoes/red' }),
    ]);
    expect(observation.outcome).toBe('not-applicable');
  });
});
