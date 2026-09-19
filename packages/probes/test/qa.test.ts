/**
 * The two raw-crawl detectors behind corpus check 4.1: `broken-links` and
 * `metadata-completeness`.
 *
 * Hand-built pages, as in `facets.test.ts`: each case is a shape of site — a
 * dead URL linked from two templates, a noindex the sitemap still lists — and
 * the markup goes through the real `extract`.
 */

import { describe, expect, it } from 'vitest';
import { extract } from '@seo/crawler';
import type { AuxiliaryFetch, CrawledPage, CrawlResult, FetchResult, RedirectHop } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const ORIGIN = 'https://www.example.com';

interface Spec {
  /** Null for no title element. */
  readonly title?: string | null;
  readonly description?: string | null;
  readonly h1?: boolean;
  /** A path, `self`, or null for none. Defaults to `self`. */
  readonly canonical?: string | null;
  readonly metaRobots?: string;
  readonly xRobots?: string;
  readonly status?: number;
  readonly error?: string;
  readonly links?: readonly string[];
  readonly redirectedTo?: string;
  readonly truncated?: boolean;
}

const page = (path: string, spec: Spec = {}): CrawledPage => {
  const {
    title = `Page ${path}`,
    description = 'A description long enough to say what this page is about.',
    h1 = true,
    canonical = 'self',
    status = 200,
    links = [],
  } = spec;
  const url = `${ORIGIN}${path}`;
  const finalUrl = spec.redirectedTo === undefined ? url : `${ORIGIN}${spec.redirectedTo}`;
  const html =
    '<html><head>' +
    (title === null ? '' : `<title>${title}</title>`) +
    (description === null ? '' : `<meta name="description" content="${description}">`) +
    (canonical === null
      ? ''
      : `<link rel="canonical" href="${canonical === 'self' ? finalUrl : `${ORIGIN}${canonical}`}">`) +
    (spec.metaRobots === undefined ? '' : `<meta name="robots" content="${spec.metaRobots}">`) +
    '</head><body>' +
    (h1 ? '<h1>Heading</h1>' : '') +
    links.map((href) => `<a href="${href}">link</a>`).join('') +
    '</body></html>';
  const redirectChain: RedirectHop[] = spec.redirectedTo === undefined
    ? []
    : [{ url, status: 301, location: finalUrl }];
  const failed = spec.error !== undefined;
  return {
    url,
    normalizedUrl: url,
    depth: 1,
    discoveredFrom: null,
    fetch: {
      requestedUrl: url,
      finalUrl,
      status: failed ? null : status,
      headers: {
        'content-type': 'text/html',
        ...(spec.xRobots === undefined ? {} : { 'x-robots-tag': spec.xRobots }),
      },
      redirectChain,
      body: failed ? '' : html,
      byteLength: html.length,
      truncated: spec.truncated === true,
      contentType: failed ? null : 'text/html',
      ttfbMs: 1,
      totalMs: 2,
      error: spec.error ?? null,
    },
    extracted: failed || status >= 400 ? null : extract(html, finalUrl),
  };
};

interface Crawl {
  readonly seeds?: readonly string[];
  readonly notReached?: readonly string[];
  readonly blockedByRobots?: readonly string[];
  readonly sitemapUrls?: readonly string[];
  readonly auxiliary?: readonly AuxiliaryFetch[];
}

const run = (id: string, pages: readonly CrawledPage[], rest: Crawl = {}): Observation =>
  (probeById(id) as SiteProbe).run({
    origin: ORIGIN,
    flags: [],
    crawl: {
      seeds: rest.seeds ?? [`${ORIGIN}/`],
      pages,
      robots: { groups: [], sitemaps: [], absent: true },
      robotsTxt: null,
      sitemapUrls: (rest.sitemapUrls ?? []).map((path) => `${ORIGIN}${path}`),
      sitemaps: [],
      sitemapVideos: [],
      sitemapNews: [],
      blockedByRobots: (rest.blockedByRobots ?? []).map((path) => `${ORIGIN}${path}`),
      notReached: (rest.notReached ?? []).map((path) => `${ORIGIN}${path}`),
      auxiliary: rest.auxiliary ?? [],
    } satisfies CrawlResult,
  });

const samples = (observation: Observation): string =>
  JSON.stringify(observation.data?.['samples'] ?? []);

/** A minimal external-link auxiliary fetch result, status or transport error. */
const auxFetch = (url: string, status: number | null, error: string | null = null): FetchResult => ({
  requestedUrl: url,
  finalUrl: url,
  status,
  headers: {},
  redirectChain: [],
  body: '',
  byteLength: 0,
  truncated: false,
  contentType: null,
  ttfbMs: 1,
  totalMs: 2,
  error,
});

// --- broken-links ------------------------------------------------------------

const links = (pages: readonly CrawledPage[], rest?: Crawl): Observation =>
  run('broken-links', pages, rest);

describe('broken-links', () => {
  it('passes a site whose every internal link, and every checked external link, answers', () => {
    const EXTERNAL = 'https://other.example/x';
    const observation = links(
      [
        page('/', { links: ['/a', '/b', EXTERNAL, 'mailto:hi@example.com'] }),
        page('/a', { links: ['/'] }),
        page('/b'),
      ],
      { auxiliary: [{ reason: 'external-link', url: EXTERNAL, fetch: auxFetch(EXTERNAL, 200) }] },
    );
    expect(observation.outcome).toBe('pass');
    expect(observation.data?.['internalLinks']).toBe(3);
    expect(observation.data?.['externalLinksChecked']).toBe(1);
    expect(observation.data?.['externalLinksNotChecked']).toBe(0);
  });

  it('holds the check on an external link target the crawl did not verify', () => {
    // The auxiliary pass has its own budget; a target outside it is not known
    // to work any more than an internal one the walk never fetched.
    const observation = links([
      page('/', { links: ['/a', 'https://other.example/unchecked'] }),
      page('/a'),
    ]);
    expect(observation.outcome).toBe('warn');
    expect(observation.data?.['externalLinksNotChecked']).toBe(1);
  });

  it('fails an external link target that answers with an error', () => {
    const EXTERNAL = 'https://other.example/gone';
    const observation = links(
      [page('/', { links: ['/a', EXTERNAL] }), page('/a')],
      { auxiliary: [{ reason: 'external-link', url: EXTERNAL, fetch: auxFetch(EXTERNAL, 404) }] },
    );
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toContain('1 of them external');
    const [finding] = observation.data?.['samples'] as { target: string; external: boolean; status: number }[];
    expect(finding).toMatchObject({ target: EXTERNAL, external: true, status: 404 });
  });

  it('holds rather than fails an external target that timed out or asked the crawler to slow down', () => {
    const EXTERNAL = 'https://other.example/slow';
    for (const fetch of [auxFetch(EXTERNAL, null, 'timeout'), auxFetch(EXTERNAL, 429)]) {
      const observation = links(
        [page('/', { links: [EXTERNAL] })],
        { auxiliary: [{ reason: 'external-link', url: EXTERNAL, fetch }] },
      );
      expect(observation.outcome).toBe('warn');
    }
  });

  it('fails a dead URL and names every page that links to it', () => {
    const observation = links([
      page('/', { links: ['/gone', '/a'] }),
      page('/a', { links: ['/gone', '/gone#top'] }),
      page('/gone', { status: 404 }),
    ]);
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toContain('2 link(s)');
    const [finding] = observation.data?.['samples'] as { target: string; status: number; sources: number }[];
    expect(finding).toMatchObject({ target: `${ORIGIN}/gone`, status: 404, sources: 2 });
  });

  it('fails a link whose redirect ends in an error', () => {
    const observation = links([
      page('/', { links: ['/old'] }),
      page('/old', { redirectedTo: '/missing', status: 410 }),
    ]);
    expect(observation.outcome).toBe('fail');
    expect(samples(observation)).toContain('/old');
  });

  it('does not count a link that redirects to a live page as broken', () => {
    const observation = links([
      page('/', { links: ['/old'] }),
      page('/old', { redirectedTo: '/new' }),
      page('/new', { links: ['/'] }),
    ]);
    expect(observation.outcome).toBe('pass');
  });

  it('holds the check when a target was never fetched', () => {
    // The budget is ours; a URL nobody requested is not known to work.
    const observation = links([page('/', { links: ['/a', '/later'] }), page('/a')], {
      notReached: ['/later'],
    });
    expect(observation.outcome).toBe('warn');
    expect(JSON.stringify(observation.data?.['unchecked'])).toContain('/later');
  });

  it('holds rather than fails a target that timed out or asked the crawler to slow down', () => {
    for (const target of [page('/slow', { error: 'timeout' }), page('/slow', { status: 429 })]) {
      expect(links([page('/', { links: ['/slow'] }), target]).outcome).toBe('warn');
    }
  });

  it('does not call a robots-blocked target broken', () => {
    const observation = links([page('/', { links: ['/private'] })], { blockedByRobots: ['/private'] });
    expect(observation.outcome).toBe('pass');
    expect(observation.data?.['robotsBlockedTargets']).toBe(1);
  });

  it('treats a link to the host the seed redirected to as internal', () => {
    // Seeded on the bare host, landed on www: an unfetched www link is the
    // site's own and unchecked, not an external link left alone.
    const observation = links(
      [page('/', { links: ['/a', '/later'] }), page('/a', { status: 404 })],
      { seeds: ['https://example.com/'] },
    );
    expect(observation.outcome).toBe('fail');
    expect(observation.data).toMatchObject({ externalLinksNotChecked: 0, uncheckedTargets: 1 });
  });

  it('ignores a page linking to itself', () => {
    expect(links([page('/', { links: ['/', '#main'] })]).outcome).toBe('not-applicable');
  });

  it('says nothing when no HTML was crawled', () => {
    expect(links([page('/', { error: 'refused' })]).outcome).toBe('not-applicable');
  });
});

// --- metadata-completeness ---------------------------------------------------

const meta = (pages: readonly CrawledPage[], rest?: Crawl): Observation =>
  run('metadata-completeness', pages, rest);

describe('metadata-completeness', () => {
  it('passes pages that carry everything and agree with the sitemap', () => {
    const observation = meta([page('/'), page('/a')], { sitemapUrls: ['/', '/a'] });
    expect(observation.outcome).toBe('pass');
    expect(observation.data?.['indexable']).toBe(2);
  });

  it('fails an indexable page with no title', () => {
    for (const title of [null, '  ']) {
      const observation = meta([page('/'), page('/a', { title })]);
      expect(observation.outcome).toBe('fail');
      expect(observation.summary).toContain('no title');
    }
  });

  it('warns on a missing description, h1 or canonical, and counts each', () => {
    const observation = meta([
      page('/', { description: null }),
      page('/a', { h1: false, canonical: null }),
      page('/b'),
    ]);
    expect(observation.outcome).toBe('warn');
    expect(observation.data).toMatchObject({ withoutDescription: 1, withoutH1: 1, withoutCanonical: 1, withGaps: 2 });
  });

  it('does not ask a noindex page for metadata', () => {
    const observation = meta([page('/'), page('/private', { title: null, metaRobots: 'noindex' })]);
    expect(observation.outcome).toBe('pass');
  });

  it('fails a noindex page the sitemap lists, by meta or by header', () => {
    for (const spec of [{ metaRobots: 'noindex, follow' }, { xRobots: 'noindex' }] as const) {
      const observation = meta([page('/'), page('/a', spec)], { sitemapUrls: ['/', '/a'] });
      expect(observation.outcome).toBe('fail');
      expect(samples(observation)).toContain('listed in the sitemap');
    }
  });

  it('fails a sitemap entry robots.txt disallows', () => {
    const observation = meta([page('/')], { sitemapUrls: ['/', '/hidden'], blockedByRobots: ['/hidden'] });
    expect(observation.outcome).toBe('fail');
    expect(samples(observation)).toContain('disallowed by robots.txt');
  });

  it('fails noindex combined with a canonical onto another page', () => {
    const observation = meta([page('/'), page('/copy', { metaRobots: 'noindex', canonical: '/' })]);
    expect(observation.outcome).toBe('fail');
    expect(samples(observation)).toContain('names https://www.example.com/ as its canonical');
  });

  it('fails meta robots and X-Robots-Tag that disagree', () => {
    const observation = meta([page('/', { metaRobots: 'index, follow', xRobots: 'noindex' })]);
    expect(observation.outcome).toBe('fail');
    expect(samples(observation)).toContain('X-Robots-Tag');
  });

  it('fails a canonical onto a page that cannot be indexed as itself', () => {
    const cases: [CrawledPage, string][] = [
      [page('/target', { metaRobots: 'noindex' }), 'is marked noindex'],
      [page('/target', { status: 404 }), 'answers 404'],
      [page('/target', { redirectedTo: '/elsewhere' }), 'redirects to'],
    ];
    for (const [target, why] of cases) {
      const observation = meta([page('/', { canonical: '/target' }), target]);
      expect(observation.outcome, why).toBe('fail');
      expect(samples(observation)).toContain(why);
    }
  });

  it('holds rather than fails a canonical that redirects back to the page', () => {
    // An edition front naming a home page that redirects visitors by location.
    const observation = meta([page('/', { redirectedTo: '/europe' }), page('/europe', { canonical: '/' })]);
    expect(observation.outcome).toBe('warn');
    expect(samples(observation)).toContain('back to this page');
  });

  it('accepts a canonical onto a live, indexable page', () => {
    expect(meta([page('/', { canonical: '/main' }), page('/main')]).outcome).toBe('pass');
  });

  it('judges a redirect once, under the address it landed on', () => {
    const observation = meta([page('/old', { redirectedTo: '/new', description: null }), page('/new', { description: null })]);
    expect(observation.outcome).toBe('warn');
    expect(observation.data).toMatchObject({ indexable: 1, withGaps: 1 });
  });

  it('does not read a cut body as missing metadata', () => {
    expect(meta([page('/', { title: null, truncated: true })]).outcome).toBe('error');
    const observation = meta([page('/'), page('/big', { title: null, truncated: true })]);
    expect(observation.outcome).toBe('warn');
    expect(observation.data?.['notRead']).toBe(1);
  });

  it('says nothing when no HTML page answered 200', () => {
    expect(meta([page('/', { status: 500 })]).outcome).toBe('not-applicable');
  });
});

// --- raw-rendered-crawl-diff -------------------------------------------------

interface RenderSpec {
  readonly finalPath?: string;
  readonly status?: number;
  readonly links?: readonly string[];
  readonly error?: string;
}

/** A page with a render attached, as `crawl()` records one under `renderPages`. */
const withRender = (base: CrawledPage, spec: RenderSpec = {}): CrawledPage => {
  const finalUrl = spec.finalPath === undefined ? base.fetch.finalUrl : `${ORIGIN}${spec.finalPath}`;
  const failed = spec.error !== undefined;
  const html =
    '<html><head><title>T</title></head><body><h1>H</h1>' +
    (spec.links ?? []).map((href) => `<a href="${href}">link</a>`).join('') +
    '</body></html>';
  return {
    ...base,
    rendered: {
      render: {
        requestedUrl: base.url,
        finalUrl,
        status: failed ? null : (spec.status ?? base.fetch.status),
        html: failed ? '' : html,
        totalMs: 5,
        error: spec.error ?? null,
      },
      extracted: failed ? null : extract(html, finalUrl),
      comparison: null,
    },
  };
};

const diff = (pages: readonly CrawledPage[]): Observation => run('raw-rendered-crawl-diff', pages);

describe('raw-rendered-crawl-diff', () => {
  it('is not applicable when no page was rendered', () => {
    expect(diff([page('/')]).outcome).toBe('not-applicable');
  });

  it('errors when every render failed', () => {
    expect(diff([withRender(page('/'), { error: 'timeout' })]).outcome).toBe('error');
  });

  it('fails a client-side redirect the raw fetch never followed', () => {
    const observation = diff([withRender(page('/old'), { finalPath: '/new' })]);
    expect(observation.outcome).toBe('fail');
    expect(samples(observation)).toContain('/new');
  });

  it('fails a rendered status that differs from the raw one', () => {
    const observation = diff([withRender(page('/'), { status: 404 })]);
    expect(observation.outcome).toBe('fail');
    expect(samples(observation)).toContain('404');
  });

  it('warns on a same-site URL linked only from rendered DOM', () => {
    const observation = diff([withRender(page('/', { links: ['/a'] }), { links: ['/a', '/hidden'] })]);
    expect(observation.outcome).toBe('warn');
    expect(observation.data?.['renderOnlyTargets']).toBe(1);
  });

  it('does not warn when another page carries the link in raw', () => {
    const observation = diff([
      withRender(page('/', { links: ['/a'] }), { links: ['/a', '/b'] }),
      withRender(page('/a', { links: ['/b'] }), { links: ['/b'] }),
    ]);
    expect(observation.outcome).toBe('pass');
  });

  it('ignores external links only the render carries', () => {
    const observation = diff([withRender(page('/'), { links: ['https://other.example/x'] })]);
    expect(observation.outcome).toBe('pass');
  });

  it('passes a render that agrees, ignoring a failed one beside it', () => {
    const observation = diff([withRender(page('/')), withRender(page('/b'), { error: 'boom' })]);
    expect(observation.outcome).toBe('pass');
    expect(observation.data).toMatchObject({ pagesCompared: 1, renderFailures: 1 });
  });
});

// --- experiment-cloaking-divergence -------------------------------------------

describe('experiment-cloaking-divergence', () => {
  const crawledAt = '2026-09-19T12:00:00.000Z';
  const experiment = (over: Record<string, unknown> = {}) => ({
    owner: 'Jane',
    recordedAt: '2026-09-01T00:00:00.000Z',
    controlUrl: `${ORIGIN}/pricing`,
    variantUrls: [`${ORIGIN}/pricing-b`],
    method: 'redirect',
    retireBy: '2026-12-01T00:00:00.000Z',
    ...over,
  });
  const check = (pages: readonly CrawledPage[], experiments?: unknown[]): Observation => {
    return (probeById('experiment-cloaking-divergence') as SiteProbe).run({
      origin: ORIGIN,
      flags: [],
      crawl: {
        crawledAt,
        seeds: [`${ORIGIN}/`],
        pages,
        robots: { groups: [], sitemaps: [], absent: true },
        robotsTxt: null,
        sitemapUrls: [],
        sitemaps: [],
        sitemapVideos: [],
        sitemapNews: [],
        blockedByRobots: [],
        notReached: [],
        auxiliary: [],
      } satisfies CrawlResult,
      ...(experiments === undefined ? {} : { inputs: { experiments } as never }),
    });
  };

  it('is not applicable without the section', () => {
    expect(check([]).outcome).toBe('not-applicable');
  });

  it('fails an indexable, self-canonical variant', () => {
    expect(check([page('/pricing-b')], [experiment()]).outcome).toBe('fail');
  });

  it('leaves a noindexed or canonicalized-away variant alone', () => {
    expect(check([page('/pricing-b', { metaRobots: 'noindex' })], [experiment()]).outcome).toBe('pass');
    expect(check([page('/pricing-b', { canonical: '/pricing' })], [experiment()]).outcome).toBe('pass');
    expect(check([page('/pricing-b', { redirectedTo: '/pricing' })], [experiment()]).outcome).toBe('pass');
  });

  it('fails an experiment past retireBy at crawl time', () => {
    const observation = check([page('/pricing-b', { status: 404 })], [experiment({ retireBy: '2026-09-01T00:00:00.000Z' })]);
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/retireBy/);
  });

  it('warns a variant the crawl never reached', () => {
    expect(check([], [experiment()]).outcome).toBe('warn');
  });

  it('holds a record with no owner', () => {
    expect(check([page('/pricing-b', { canonical: '/pricing' })], [experiment({ owner: '' })]).outcome).toBe('warn');
  });
});
