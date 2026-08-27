/**
 * Indexability directives: which URLs are allowed into an index, and whether
 * the site says so explicitly.
 */

import type { PageProbe, SiteProbe } from '../types.js';
import { fail, notApplicable, pass, warn } from '../types.js';

/** Query keys and path segments that mean "these are search results". */
const SEARCH_PARAMS = ['q', 's', 'query', 'search', 'keyword', 'keywords'];
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

export const indexabilityProbes = [internalSearchIndexability, xRobotsTagNonHtml];
