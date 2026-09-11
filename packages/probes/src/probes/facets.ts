/**
 * Faceted navigation: the two questions corpus check 1.12 asks of a listing
 * whose filters and sorts are addresses.
 *
 * A filter is a query string away from being a URL, and a URL a crawler can
 * reach is a URL a crawler will fetch. Three colours, five sizes and four sort
 * orders are sixty addresses for one listing before a second filter is
 * combined with the first; a site that lets them stack has written an
 * unbounded number of pages without writing any. The corpus separates what
 * that costs into two questions, and so do the detectors.
 *
 * `parameter-crawl-space` asks whether the parameter space is bounded — the
 * crawl side. It never asks whether a filtered page should be indexed; it asks
 * whether a crawler following the site's own links keeps finding new addresses
 * for pages it has already seen. Session identifiers in URLs, one filter state
 * spelled in several parameter orders, and a crawl budget spent on permutations
 * of routes it had already fetched are the shapes that answer yes.
 *
 * `faceted-nav-control` asks whether each filtered page the crawl did reach has
 * a decision behind it — the index side. The corpus leaves the decision open:
 * "define which filter combinations deserve indexable landing pages", and
 * control the rest. So the detector does not judge which filters were worth
 * a page, which only the site can know; it asks that each one is either a page
 * that says so (self-canonical, and distinct from the listing it filters) or is
 * kept out of the index (noindex, or a canonical elsewhere), and that nothing
 * kept out is also being submitted in the sitemap.
 *
 * The two come apart in both directions. A site can noindex every filtered
 * page flawlessly and still hand a crawler ten thousand of them to fetch, and a
 * site can link exactly twelve filtered pages, a bounded space, every one of
 * which is an indexable duplicate of its listing.
 *
 * Neighbours keep their own subjects. Pagination is `pagination-crawl-path`'s
 * (1.13), internal search is `internal-search-indexability`'s (1.4), and a
 * product reachable at several variant URLs is `product-variant-canonical`'s
 * (1.15), so a query on a product page is not a facet here.
 */

import { isSameSite, isTrackingParam, normalizeUrl } from '@seo/crawler';
import type { CrawledPage } from '@seo/crawler';
import type { SiteProbe } from '../types.js';
import { fail, notApplicable, pass, warn } from '../types.js';
import { isNoindex, isProductPage, routeOf } from './commerce.js';
import { SEARCH_PARAMS } from './indexability.js';

/**
 * What a query parameter does.
 *
 * `state` is everything left once the parameters with a known job are set
 * aside: filters, sorts, view modes, whatever the template reads. Which of
 * those deserve a page is the site's decision; that they change the page's
 * address is the subject.
 */
type Role = 'pagination' | 'search' | 'tracking' | 'session' | 'state';

const PAGINATION_KEYS = new Set(['page', 'p', 'pg', 'paged']);
const SEARCH_KEYS = new Set(SEARCH_PARAMS);

/**
 * Names that mean a session and nothing else.
 *
 * Deliberately short. `sid` and `session` are session ids on some platforms and
 * a section or a conference session on others, and a detector that failed a
 * site for its `?session=keynote` would be wrong in a way that teaches people
 * to ignore it. The names below have no other meaning anyone uses.
 */
const SESSION_KEY =
  /^(jsessionid|phpsessid|aspsessionid\w*|sessionid|session_id|sessid|cfid|cftoken|zenid|oscsid)$/i;

/** Java and some CMSes put the session in a path parameter rather than the query. */
const SESSION_IN_PATH = /;(jsessionid|phpsessid|sessionid)=/i;

function roleOf(key: string, value: string): Role {
  const lower = key.toLowerCase();
  if (SESSION_KEY.test(lower)) return 'session';
  if (isTrackingParam(lower)) return 'tracking';
  if (SEARCH_KEYS.has(lower)) return 'search';
  if (PAGINATION_KEYS.has(lower) && /^\d+$/.test(value)) return 'pagination';
  return 'state';
}

/** The query of a URL as key/value pairs, in the order written. Empty when it has none. */
function queryOf(url: string): [string, string][] {
  try {
    return [...new URL(url).searchParams.entries()];
  } catch {
    return [];
  }
}

const hasQuery = (url: string): boolean => queryOf(url).length > 0;

const stateKeys = (url: string): string[] => [
  ...new Set(queryOf(url).filter(([key, value]) => roleOf(key, value) === 'state').map(([key]) => key)),
];

const isPaginated = (url: string): boolean =>
  queryOf(url).some(([key, value]) => roleOf(key, value) === 'pagination');

const carriesSession = (url: string): boolean => {
  if (SESSION_IN_PATH.test(url)) return true;
  return queryOf(url).some(([key, value]) => roleOf(key, value) === 'session');
};

/**
 * One filter state, however it is spelled: the route plus the sorted pairs.
 *
 * `?color=red&size=9` and `?size=9&color=red` are one state at two addresses.
 * The crawler keeps them apart on purpose — a site treating parameter order as
 * meaningful is exactly the finding — and this is where the finding is made.
 */
function stateOf(url: string): string | null {
  const route = routeOf(url);
  if (route === null) return null;
  const pairs = queryOf(url)
    .map(([key, value]) => `${key}=${value}`)
    .sort();
  return `${route}?${pairs.join('&')}`;
}

interface Problem {
  readonly issue: string;
  readonly urls: readonly string[];
}

/**
 * Below this many, a budget running out on parameter URLs is a crawl that
 * happened to end beside a sort link. A floor against accident, not a
 * threshold of harm: the data carries the real numbers either way.
 */
const EXHAUSTION_FLOOR = 10;

export const parameterCrawlSpace: SiteProbe = {
  id: 'parameter-crawl-space',
  scope: 'site',
  title: 'Parameter URLs do not create an uncontrolled crawl space',
  run({ crawl, origin }) {
    const fetched = crawl.pages.map((page) => page.normalizedUrl);
    const crawlable = [...new Set([...fetched, ...crawl.notReached])];
    const parameterised = crawlable.filter(hasQuery);
    const blocked = crawl.blockedByRobots.filter(hasQuery);

    // Normalization drops campaign parameters, so the crawl never saw these as
    // separate URLs. Every other crawler does, which is why the raw href is
    // read here rather than the URL the walk followed.
    const tracked: { from: string; href: string }[] = [];
    for (const page of crawl.pages) {
      for (const link of page.extracted?.links ?? []) {
        if (link.nofollow || !isSameSite(link.url, origin)) continue;
        if (queryOf(link.url).some(([key]) => isTrackingParam(key))) {
          tracked.push({ from: page.normalizedUrl, href: link.href });
        }
      }
    }

    if (parameterised.length === 0 && blocked.length === 0 && tracked.length === 0) {
      return notApplicable('The crawl discovered no parameter URLs, so there is no parameter space to bound.');
    }

    const problems: Problem[] = [];

    const sessions = crawlable.filter(carriesSession);
    if (sessions.length > 0) {
      problems.push({
        issue: `${sessions.length} crawlable URL(s) carry a session identifier, so every visit mints new addresses for the same pages.`,
        urls: sessions,
      });
    }

    const spellings = new Map<string, string[]>();
    for (const url of parameterised) {
      const state = stateOf(url);
      if (state !== null) spellings.set(state, [...(spellings.get(state) ?? []), url]);
    }
    const permuted = [...spellings.values()].filter((urls) => urls.length > 1);
    if (permuted.length > 0) {
      problems.push({
        issue: `${permuted.length} filter state(s) are reachable at more than one spelling of the same parameters, so the space grows with every order a link happens to write them in.`,
        urls: permuted.flatMap((urls) => urls),
      });
    }

    // The crawl stopped with work left, and most of that work was another
    // spelling of a page already fetched. That is the crawl space observed
    // directly rather than inferred: a crawler following this site's links
    // spends its budget on URL state, not on documents.
    const crawledRoutes = new Set(fetched.map(routeOf));
    const variantsLeft = crawl.notReached.filter(
      (url) => hasQuery(url) && crawledRoutes.has(routeOf(url)),
    );
    if (
      variantsLeft.length >= EXHAUSTION_FLOOR &&
      variantsLeft.length * 2 >= crawl.notReached.length
    ) {
      const routes = new Set(variantsLeft.map(routeOf));
      problems.push({
        issue: `The crawl's page or depth budget ran out with ${variantsLeft.length} of ${crawl.notReached.length} unfetched URLs being parameter variants of ${routes.size} route(s) it had already fetched.`,
        urls: variantsLeft,
      });
    }

    // Whether a space is bounded is only observed by walking it. A filter URL
    // the crawl found and never fetched might lead nowhere or to a thousand
    // more, and nothing here can say which.
    const stateLeft = crawl.notReached.filter((url) => stateKeys(url).length > 0);

    const counts = {
      parameterUrls: parameterised.length,
      routes: new Set(parameterised.map(routeOf)).size,
      blockedByRobots: blocked.length,
      unfetched: crawl.notReached.length,
      unfetchedFilterUrls: stateLeft.length,
    };

    if (problems.length > 0) {
      return fail(`${problems.length} sign(s) of an uncontrolled parameter crawl space.`, {
        ...counts,
        samples: problems.map((problem) => ({ ...problem, urls: problem.urls.slice(0, 10) })),
      });
    }

    const held: string[] = [];
    if (stateLeft.length > 0) {
      held.push(
        `${stateLeft.length} filter or sort URL(s) were linked and left unfetched when the crawl's budget ran out, so whether they lead to still more is not observable.`,
      );
    }
    if (tracked.length > 0) {
      // Bounded — there are as many as there are links — but each one is a
      // duplicate address that every crawler but this one will fetch.
      held.push(
        `${tracked.length} internal link(s) carry campaign parameters, giving pages extra addresses that analytics, not the site, chose.`,
      );
    }
    if (held.length > 0) {
      return warn(held.join(' '), {
        ...counts,
        samples: [...stateLeft.slice(0, 10), ...tracked.slice(0, 10).map((entry) => entry.href)],
      });
    }

    if (parameterised.length === 0) {
      return pass(`All ${blocked.length} parameter URL(s) found are closed to crawling by robots.txt.`, counts);
    }
    return pass(
      `The crawl followed every filter URL it found (${parameterised.length} parameter URL(s) across ${counts.routes} route(s)) and they led to no more: no session ids, no permuted spellings.`,
      counts,
    );
  },
};

/**
 * What the site decided about one filtered page.
 *
 * `landing` — self-canonical and indexable: the site says this filter is a page.
 * `excluded` — noindex.
 * `consolidated` — a canonical naming another URL, usually the listing.
 * `uncontrolled` — indexable with no usable canonical, so nothing says which.
 */
type Treatment = 'landing' | 'excluded' | 'consolidated' | 'uncontrolled';

function treatmentOf(page: CrawledPage): { treatment: Treatment; target: string | null } {
  if (isNoindex(page)) return { treatment: 'excluded', target: null };
  const target = normalizeUrl(page.extracted?.canonical ?? '');
  if (target === null) return { treatment: 'uncontrolled', target: null };
  const selves = new Set([page.normalizedUrl, normalizeUrl(page.fetch.finalUrl)]);
  return selves.has(target)
    ? { treatment: 'landing', target }
    : { treatment: 'consolidated', target };
}

const TREATMENT_WORDING: Readonly<Record<Treatment, string>> = {
  landing: 'self-canonical',
  excluded: 'marked noindex',
  consolidated: 'canonicalized elsewhere',
  uncontrolled: 'indexable with no canonical',
};

export const facetedNavControl: SiteProbe = {
  id: 'faceted-nav-control',
  scope: 'site',
  title: 'Each filtered URL is a deliberate landing page or kept out of the index',
  run({ crawl }) {
    const html = crawl.pages.filter((page) => page.extracted !== null && page.fetch.status === 200);
    const productRoutes = new Set(html.filter(isProductPage).map((page) => routeOf(page.normalizedUrl)));
    const isFacet = (url: string): boolean =>
      stateKeys(url).length > 0 && !productRoutes.has(routeOf(url));

    // A filtered URL that redirects has been consolidated by the redirect, and
    // its target is crawled as a page of its own.
    const facets = html.filter(
      (page) => page.fetch.redirectChain.length === 0 && isFacet(page.normalizedUrl),
    );
    const blocked = crawl.blockedByRobots.filter(isFacet);
    const unfetched = crawl.notReached.filter(isFacet);

    if (facets.length === 0 && blocked.length === 0 && unfetched.length === 0) {
      return notApplicable(
        'The crawl found no filtered or sorted listing URL, so there is no facet handling to judge.',
      );
    }

    const listed = new Set(crawl.sitemapUrls);
    const byUrl = new Map(crawl.pages.map((page) => [page.normalizedUrl, page]));
    const treatments: Record<Treatment, number> = {
      landing: 0,
      excluded: 0,
      consolidated: 0,
      uncontrolled: 0,
    };
    const uncontrolled: string[] = [];
    const listedButKeptOut: string[] = [];
    const deadEnds: { url: string; canonical: string; why: string }[] = [];
    const landings: CrawledPage[] = [];

    for (const page of facets) {
      const { treatment, target } = treatmentOf(page);
      treatments[treatment] += 1;
      const url = page.normalizedUrl;

      if (treatment === 'uncontrolled') uncontrolled.push(url);
      if (treatment === 'landing') landings.push(page);
      // A sitemap entry asks for indexing; noindex and a canonical elsewhere
      // both decline it. Whichever was meant, the site is saying both.
      if ((treatment === 'excluded' || treatment === 'consolidated') && listed.has(url)) {
        listedButKeptOut.push(url);
      }
      if (treatment === 'consolidated' && target !== null) {
        const onto = byUrl.get(target);
        if (onto !== undefined && onto.fetch.status !== 200) {
          deadEnds.push({ url, canonical: target, why: `answered ${onto.fetch.status ?? 'nothing'}` });
        } else if (onto !== undefined && isNoindex(onto)) {
          deadEnds.push({ url, canonical: target, why: 'is marked noindex' });
        }
      }
    }

    const problems: Problem[] = [];
    if (uncontrolled.length > 0) {
      problems.push({
        issue: `${uncontrolled.length} filtered URL(s) are indexable with no canonical, so nothing says whether each is a landing page or a duplicate of its listing.`,
        urls: uncontrolled,
      });
    }
    if (listedButKeptOut.length > 0) {
      problems.push({
        issue: `${listedButKeptOut.length} filtered URL(s) the site keeps out of the index are still submitted in the sitemap.`,
        urls: listedButKeptOut,
      });
    }
    if (deadEnds.length > 0) {
      problems.push({
        issue: `${deadEnds.length} filtered URL(s) canonicalize onto a page that cannot be indexed, so the filter's content has no indexable address at all.`,
        urls: deadEnds.map((entry) => `${entry.url} -> ${entry.canonical} (${entry.why})`),
      });
    }

    // Robots.txt keeps a URL from being crawled, not from being indexed, and a
    // sitemap entry is a request to index it. The corpus names this pairing:
    // robots.txt standing in for a deindexing decision it cannot carry out.
    const blockedListed = blocked.filter((url) => listed.has(url));
    if (blockedListed.length > 0) {
      problems.push({
        issue: `${blockedListed.length} filtered URL(s) are closed to crawling by robots.txt and submitted for indexing in the sitemap.`,
        urls: blockedListed,
      });
    }

    // A self-canonical filter says "I am a page of my own". That is only true
    // while it differs from the listing it filters; one carrying the listing's
    // title is the unfiltered page at a second address. First pages only — a
    // filtered series' page 2 sharing page 1's title is pagination's business.
    const byRoute = new Map<string, CrawledPage[]>();
    for (const page of landings) {
      if (isPaginated(page.normalizedUrl)) continue;
      const route = routeOf(page.normalizedUrl);
      if (route !== null) byRoute.set(route, [...(byRoute.get(route) ?? []), page]);
    }
    const lookalikes: string[] = [];
    for (const [route, members] of byRoute) {
      const listing = byUrl.get(route);
      const pool = listing?.extracted != null && listing.fetch.status === 200
        ? [listing, ...members]
        : members;
      const byTitle = new Map<string, string[]>();
      for (const member of pool) {
        const title = member.extracted?.title ?? '';
        if (title === '') continue; // A missing title is title-uniqueness's finding.
        byTitle.set(title, [...(byTitle.get(title) ?? []), member.normalizedUrl]);
      }
      for (const urls of byTitle.values()) {
        if (urls.length > 1) lookalikes.push(...urls.filter((url) => url !== route));
      }
    }
    if (lookalikes.length > 0) {
      problems.push({
        issue: `${lookalikes.length} self-canonical filtered URL(s) share a title with their listing or with each other, so they declare themselves landing pages without being distinguishable from one.`,
        urls: lookalikes,
      });
    }

    const counts = {
      filteredPages: facets.length,
      blockedByRobots: blocked.length,
      unfetched: unfetched.length,
      treatments,
    };

    if (problems.length > 0) {
      return fail(
        `${problems.length} facet control problem(s) across ${facets.length} filtered page(s) crawled.`,
        { ...counts, samples: problems.map((problem) => ({ ...problem, urls: problem.urls.slice(0, 10) })) },
      );
    }
    if (facets.length === 0 && unfetched.length > 0) {
      // The subject exists — the site links its filters — and the crawl never
      // opened one. Not-applicable would read as "no facets here", which the
      // links already contradict.
      return warn(
        `${unfetched.length} filtered URL(s) were linked but none was fetched within the crawl budget, so how the site handles them is unobserved.`,
        { ...counts, samples: unfetched.slice(0, 10) },
      );
    }

    const spread = (Object.entries(treatments) as [Treatment, number][])
      .filter(([, count]) => count > 0)
      .map(([treatment, count]) => `${count} ${TREATMENT_WORDING[treatment]}`);
    if (blocked.length > 0) spread.push(`${blocked.length} closed to crawling by robots.txt`);
    return pass(`Every filtered URL found has a decision behind it: ${spread.join(', ')}.`, counts);
  },
};

export const facetProbes = [parameterCrawlSpace, facetedNavControl];
