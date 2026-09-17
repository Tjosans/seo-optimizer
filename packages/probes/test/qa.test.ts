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
import type { CrawledPage, CrawlResult, RedirectHop } from '@seo/crawler';
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
      auxiliary: [],
    } satisfies CrawlResult,
  });

const samples = (observation: Observation): string =>
  JSON.stringify(observation.data?.['samples'] ?? []);

// --- broken-links ------------------------------------------------------------

const links = (pages: readonly CrawledPage[], rest?: Crawl): Observation =>
  run('broken-links', pages, rest);

describe('broken-links', () => {
  it('passes a site whose every internal link answers', () => {
    const observation = links([
      page('/', { links: ['/a', '/b', 'https://other.example/x', 'mailto:hi@example.com'] }),
      page('/a', { links: ['/'] }),
      page('/b'),
    ]);
    expect(observation.outcome).toBe('pass');
    expect(observation.data?.['internalLinks']).toBe(3);
    expect(observation.data?.['externalLinksNotChecked']).toBe(1);
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
