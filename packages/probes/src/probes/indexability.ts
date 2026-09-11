/**
 * Indexability directives: which URLs are allowed into an index, and whether
 * the site says so explicitly.
 */

import { normalizeUrl } from '@seo/crawler';
import type { CrawledPage } from '@seo/crawler';
import type { PageProbe, SiteProbe } from '../types.js';
import { fail, notApplicable, pass, warn } from '../types.js';

/** Query keys and path segments that mean "these are search results". */
export const SEARCH_PARAMS = ['q', 's', 'query', 'search', 'keyword', 'keywords'];
const SEARCH_PATH = /\/(search|suche|recherche|busca|resultater)\b/i;

const looksLikeSearch = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return (
      SEARCH_PATH.test(parsed.pathname) ||
      SEARCH_PARAMS.some((key) => parsed.searchParams.has(key))
    );
  } catch {
    return false;
  }
};

/**
 * Site-scoped on purpose: a search URL that robots.txt already blocks is never
 * fetched, so a page probe would never see it and the check would look
 * unevidenced. Blocking is the desired end state, and the crawl records it.
 */
export const internalSearchIndexability: SiteProbe = {
  id: 'internal-search-indexability',
  scope: 'site',
  title: 'Internal search results stay out of the index',
  run({ crawl }) {
    const blocked = crawl.blockedByRobots.filter(looksLikeSearch);
    const crawled = crawl.pages.filter((page) => looksLikeSearch(page.normalizedUrl));

    const indexable = crawled.filter((page) => {
      const directives = `${page.extracted?.metaRobots ?? ''} ${page.fetch.headers['x-robots-tag'] ?? ''}`;
      return !/\bnoindex\b/i.test(directives);
    });

    if (crawled.length === 0 && blocked.length === 0) {
      return notApplicable('No internal search URLs were discovered.');
    }
    if (indexable.length > 0) {
      return fail(`${indexable.length} internal search URL(s) are indexable.`, {
        samples: indexable.slice(0, 10).map((page) => page.normalizedUrl),
        blockedByRobots: blocked.length,
      });
    }
    return pass('Every internal search URL found is blocked or marked noindex.', {
      blockedByRobots: blocked.length,
      noindexed: crawled.length,
    });
  },
};

/**
 * Whether a locale variant is allowed to be indexed as itself.
 *
 * The defect this exists for is quiet and common: a template ships with the
 * canonical hard-coded to the default locale, so `/fr/` declares `/en/` as its
 * address. Every hreflang annotation on the site can be perfect and the French
 * page still never appears, because canonical outranks hreflang — the site
 * asked for one page and got it.
 *
 * "Is this a locale variant?" is answered from the cluster rather than from the
 * page, on purpose. A page that carries no annotation of its own but is named
 * by another locale is exactly the case worth catching: the annotation says it
 * is a variant, and the canonical says it is a duplicate.
 */
export const localeCanonical: PageProbe = {
  id: 'locale-canonical',
  scope: 'page',
  htmlOnly: true,
  title: 'Each locale variant canonicalizes to itself',
  run({ page, site }) {
    const extracted = page.extracted;
    if (extracted === null) return notApplicable('Response is not HTML.');
    if (page.fetch.status !== 200) return notApplicable('Response was not a 200.');

    const selves = new Set(
      [page.normalizedUrl, normalizeUrl(page.fetch.finalUrl)].filter(
        (url): url is string => url !== null,
      ),
    );

    /** Every locale in this page's cluster: URL -> the value naming it. */
    const cluster = new Map<string, string>();
    const record = (source: CrawledPage): void => {
      for (const entry of source.extracted?.hreflang ?? []) {
        const target = normalizeUrl(entry.url);
        if (target !== null && !cluster.has(target)) cluster.set(target, entry.hreflang);
      }
    };

    record(page);
    for (const other of site.crawl.pages) {
      if (selves.has(other.normalizedUrl)) continue;
      const names = (other.extracted?.hreflang ?? []).some((entry) => {
        const target = normalizeUrl(entry.url);
        return target !== null && selves.has(target);
      });
      if (names) record(other);
    }

    const alternates = [...cluster.keys()].filter((url) => !selves.has(url));
    if (cluster.size === 0) {
      return notApplicable('No hreflang annotation names this page, so it is not a locale variant.');
    }
    if (alternates.length === 0) {
      // Annotated, but the only locale named is this one. Nothing about the
      // canonical can be wrong across locales when there is one locale.
      return notApplicable('The only locale this page is clustered with is itself.');
    }

    const canonical = extracted.canonical;
    if (canonical === null) {
      return fail('A locale variant with no rel=canonical leaves a search engine to pick which locale to keep.', {
        alternates: alternates.slice(0, 10),
      });
    }
    const declared = normalizeUrl(canonical);
    if (declared === null) return fail(`rel=canonical is not a usable URL: "${canonical}".`);
    if (selves.has(declared)) {
      return pass(`Self-canonical, alongside ${alternates.length} other locale(s).`, {
        canonical: declared,
        alternates: alternates.slice(0, 10),
      });
    }

    const locale = cluster.get(declared);
    if (locale !== undefined) {
      return fail(
        `Canonicalizes to the "${locale}" locale at ${declared}, so this locale cannot be indexed separately.`,
        { canonical: declared, locale, pageUrl: page.normalizedUrl },
      );
    }
    return fail(
      `Canonical points at ${declared}, which no hreflang annotation names; canonical and hreflang disagree about this page's address.`,
      { canonical: declared, pageUrl: page.normalizedUrl, alternates: alternates.slice(0, 10) },
    );
  },
};

export const xRobotsTagNonHtml: PageProbe = {
  id: 'x-robots-tag-non-html',
  scope: 'page',
  title: 'Non-HTML files declare their indexing policy in a header',
  run({ page, site }) {
    const contentType = page.fetch.contentType ?? '';
    if (page.fetch.status !== 200) return notApplicable('Response was not a 200.');
    if (contentType === '' || /^(text\/html|application\/xhtml\+xml)/i.test(contentType)) {
      // HTML can carry a robots meta tag; a file cannot, which is the point.
      return notApplicable('Response is HTML, which can use a robots meta tag.');
    }
    if (!site.flags.includes('non-html-files')) {
      return notApplicable('Site profile does not claim indexable non-HTML files.');
    }

    const header = page.fetch.headers['x-robots-tag'];
    return header === undefined
      ? warn(`${contentType} is served with no X-Robots-Tag; its indexing policy is undeclared.`, {
          contentType,
        })
      : pass(`X-Robots-Tag: ${header}`, { contentType, directive: header });
  },
};

export const indexabilityProbes = [internalSearchIndexability, localeCanonical, xRobotsTagNonHtml];
