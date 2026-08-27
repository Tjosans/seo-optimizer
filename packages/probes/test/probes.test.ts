import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crawl } from '@seo/crawler';
import { PROBES, runProbes } from '@seo/probes';
import type { ProbeOutcome, ProbeRun, SiteContext } from '@seo/probes';
import { startFixtureSite } from '@seo/testkit';
import type { FixtureSite } from '@seo/testkit';

let site: FixtureSite;
let context: SiteContext;
let runs: ProbeRun[];

beforeAll(async () => {
  site = await startFixtureSite();
  const result = await crawl({
    seeds: [`${site.origin}/`, `${site.origin}/old`, `${site.origin}/soft-404`],
    userAgent: 'seo-optimizer/0.1 (+test)',
    maxPages: 50,
    maxDepth: 3,
  });
  context = { origin: site.origin, crawl: result, flags: ['hierarchical'] };
  runs = runProbes(context);
}, 30_000);

afterAll(async () => {
  await site.close();
});

/** The outcome one probe reached about one page. */
const on = (probeId: string, path: string): ProbeOutcome | undefined =>
  runs.find((run) => run.probeId === probeId && run.pageUrl === `${site.origin}${path}`)
    ?.observation.outcome;

const forSite = (probeId: string): ProbeRun | undefined =>
  runs.find((run) => run.probeId === probeId && run.scope === 'site');

describe('page probes against a site with known defects', () => {
  it('flags a 404 that a crawled page links to', () => {
    expect(on('http-status', '/gone')).toBe('fail');
    expect(on('http-status', '/')).toBe('pass');
  });

  it('fails a redirect chain and only warns about a single hop', () => {
    expect(on('redirect-chain', '/old')).toBe('fail');
    expect(on('redirect-chain', '/')).toBe('pass');
  });

  it('fails a page that declares no canonical', () => {
    expect(on('canonicalization', '/about')).toBe('fail');
    expect(on('canonicalization', '/')).toBe('pass');
  });

  it('fails a page with no h1 and passes one with a single h1', () => {
    expect(on('heading-outline', '/about')).toBe('fail');
    expect(on('primary-heading', '/about')).toBe('fail');
    expect(on('heading-outline', '/')).toBe('pass');
  });

  it('catches a duplicate title only by comparing across the crawl', () => {
    expect(on('title-uniqueness', '/about')).toBe('fail');
    expect(on('title-uniqueness', '/about-us')).toBe('fail');
    expect(on('title-uniqueness', '/')).toBe('pass');
  });

  it('catches a 200 response that says the page does not exist', () => {
    expect(on('soft-404', '/soft-404')).toBe('fail');
    expect(on('soft-404', '/')).toBe('pass');
  });

  it('reads image defects from markup alone', () => {
    expect(on('image-alt-quality', '/about')).toBe('fail');
    expect(on('image-dimensions', '/about')).toBe('fail');
    expect(on('lcp-not-lazy', '/about')).toBe('fail');
    expect(on('image-alt-quality', '/')).toBe('pass');
    expect(on('image-dimensions', '/')).toBe('pass');
    expect(on('lcp-not-lazy', '/')).toBe('pass');
  });

  it('fails plain HTTP and skips mixed content as inapplicable there', () => {
    expect(on('https-enforcement', '/')).toBe('fail');
    expect(on('mixed-content', '/')).toBe('not-applicable');
  });

  it('warns about missing security and caching headers', () => {
    expect(on('security-headers', '/')).toBe('warn');
    expect(on('compression-cache', '/')).toBe('warn');
  });

  it('skips probes whose applicability the site profile does not claim', () => {
    // The profile claims 'hierarchical', so breadcrumbs are in scope below root.
    expect(on('breadcrumblist-schema', '/deep/one')).toBe('fail');
    expect(on('breadcrumblist-schema', '/')).toBe('not-applicable');

    const withoutFlag = runProbes({ ...context, flags: [] });
    const outcome = withoutFlag.find(
      (run) => run.probeId === 'breadcrumblist-schema' && run.pageUrl === `${site.origin}/deep/one`,
    )?.observation.outcome;
    expect(outcome).toBe('not-applicable');
  });
});

describe('site probes', () => {
  it('accepts a robots.txt that declares a sitemap', () => {
    expect(forSite('robots-txt')?.observation.outcome).toBe('pass');
    expect(forSite('sitemap-validity')?.observation.outcome).toBe('pass');
  });

  it('finds the page reachable only from the sitemap', () => {
    const orphans = forSite('orphan-pages');
    expect(orphans?.observation.outcome).toBe('fail');
    expect(JSON.stringify(orphans?.observation.data)).toContain('/orphan');
  });

  it('reports indexable pages the sitemap never lists', () => {
    expect(forSite('index-bloat')?.observation.outcome).toBe('fail');
  });

  it('fails indexable internal search results', () => {
    const search = forSite('internal-search-indexability');
    expect(search?.observation.outcome).toBe('fail');
    expect(JSON.stringify(search?.observation.data)).toContain('/search');
  });

  it('counts third-party script hosts across the crawl', () => {
    const budget = forSite('third-party-budget');
    expect(budget?.observation.outcome).toBe('warn');
    expect(JSON.stringify(budget?.observation.data)).toContain('cdn.example.com');
  });
});

describe('the runner', () => {
  it('runs every probe, page-scoped ones once per page', () => {
    const siteScoped = PROBES.filter((probe) => probe.scope === 'site');
    for (const probe of siteScoped) {
      expect(forSite(probe.id), probe.id).toBeDefined();
    }
    const pageRuns = runs.filter((run) => run.scope === 'page');
    expect(pageRuns.length).toBeGreaterThan(0);
    expect(new Set(pageRuns.map((run) => run.pageUrl)).size).toBeGreaterThan(5);
  });

  it('turns a throwing probe into an error observation instead of losing the run', () => {
    const results = runProbes(context, [
      {
        id: 'canonicalization',
        scope: 'site',
        title: 'a probe that throws',
        run() {
          throw new Error('detector exploded');
        },
      },
    ]);
    expect(results[0]?.observation.outcome).toBe('error');
    expect(results[0]?.observation.summary).toContain('detector exploded');
  });

  it('never reports an error observation for the real probe set', () => {
    const errors = runs.filter((run) => run.observation.outcome === 'error');
    expect(errors.map((run) => `${run.probeId} ${run.pageUrl ?? ''}`)).toEqual([]);
  });
});
