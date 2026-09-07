/**
 * Site-scoped probes: the questions that can only be answered by looking at
 * the crawl as a whole — what is discoverable, what agrees with what, and how
 * the URL space is shaped.
 */

import { isSameSite, normalizeUrl, pathDepth } from '@seo/crawler';
import type { CrawledPage } from '@seo/crawler';
import type { SiteProbe } from '../types.js';
import { fail, notApplicable, pass, warn } from '../types.js';

const htmlPages = (pages: readonly CrawledPage[]): CrawledPage[] =>
  pages.filter((page) => page.extracted !== null && page.fetch.status === 200);

/** BCP 47 as hreflang uses it: language, optional script, optional region. */
const LANG_TAG = /^[a-z]{2,3}(-[A-Za-z]{4})?(-([A-Za-z]{2}|\d{3}))?$/i;

/** URL shapes a paginated series takes: ?page=2, /page/2, /p/2, ?p=2. */
const PAGED_URL = /([?&](page|p)=\d+|\/(page|p)\/\d+)/i;

export const robotsTxt: SiteProbe = {
  id: 'robots-txt',
  scope: 'site',
  title: 'robots.txt states crawl policy and points at the sitemap',
  run({ crawl }) {
    if (crawl.robots.absent || crawl.robotsTxt === null) {
      return fail('No robots.txt is served; crawl policy is undeclared.');
    }
    const blocksEverything = crawl.robots.groups.some(
      (group) =>
        group.agents.includes('*') &&
        group.rules.some((rule) => !rule.allow && rule.path === '/'),
    );
    if (blocksEverything) {
      return fail('robots.txt disallows everything for the default user agent.');
    }
    if (crawl.robots.sitemaps.length === 0) {
      return warn('robots.txt is served but declares no Sitemap line.', {
        blockedUrls: crawl.blockedByRobots.length,
      });
    }
    return pass(`robots.txt declares ${crawl.robots.sitemaps.length} sitemap(s).`, {
      sitemaps: crawl.robots.sitemaps,
      blockedUrls: crawl.blockedByRobots.length,
    });
  },
};

export const sitemapValidity: SiteProbe = {
  id: 'sitemap-validity',
  scope: 'site',
  title: 'The XML sitemap resolves to live, on-site URLs',
  run({ crawl, origin }) {
    if (crawl.sitemapUrls.length === 0) {
      return fail('No sitemap URLs were found via robots.txt or /sitemap.xml.');
    }
    const offSite = crawl.sitemapUrls.filter((url) => !isSameSite(url, origin));
    const fetched = new Map(crawl.pages.map((page) => [page.normalizedUrl, page]));
    const broken = crawl.sitemapUrls.filter((url) => {
      const page = fetched.get(url);
      return page !== undefined && (page.fetch.status === null || page.fetch.status >= 400);
    });

    if (offSite.length > 0 || broken.length > 0) {
      return fail(
        `Sitemap lists ${offSite.length} off-site and ${broken.length} non-200 URL(s).`,
        { offSite: offSite.slice(0, 10), broken: broken.slice(0, 10) },
      );
    }
    return pass(`Sitemap lists ${crawl.sitemapUrls.length} on-site URL(s).`, {
      urlCount: crawl.sitemapUrls.length,
    });
  },
};

export const sitemapCanonicalAgreement: SiteProbe = {
  id: 'sitemap-canonical-agreement',
  scope: 'site',
  title: 'Sitemap entries agree with the canonical each page declares',
  run({ crawl }) {
    if (crawl.sitemapUrls.length === 0) return notApplicable('No sitemap was found.');
    const listed = new Set(crawl.sitemapUrls);

    const disagreements: Array<{ url: string; canonical: string }> = [];
    for (const page of htmlPages(crawl.pages)) {
      if (!listed.has(page.normalizedUrl)) continue;
      const canonical = page.extracted?.canonical;
      if (canonical == null) continue;
      const normalized = normalizeUrl(canonical);
      if (normalized !== null && normalized !== page.normalizedUrl) {
        disagreements.push({ url: page.normalizedUrl, canonical: normalized });
      }
    }

    return disagreements.length === 0
      ? pass('Every sitemap entry canonicalizes to itself.')
      : fail(`${disagreements.length} sitemap entr(ies) canonicalize elsewhere.`, {
          samples: disagreements.slice(0, 10),
        });
  },
};

export const indexBloat: SiteProbe = {
  id: 'index-bloat',
  scope: 'site',
  title: 'What is crawlable matches what is meant to be indexed',
  run({ crawl }) {
    const indexable = htmlPages(crawl.pages).filter(
      (page) => !/\bnoindex\b/i.test(page.extracted?.metaRobots ?? ''),
    );
    if (indexable.length === 0) return notApplicable('No indexable HTML pages were crawled.');
    if (crawl.sitemapUrls.length === 0) return notApplicable('No sitemap to compare against.');

    const listed = new Set(crawl.sitemapUrls);
    const unlisted = indexable.filter((page) => !listed.has(page.normalizedUrl));
    const ratio = unlisted.length / indexable.length;

    if (ratio > 0.25) {
      return fail(
        `${unlisted.length} of ${indexable.length} indexable pages are absent from the sitemap.`,
        { samples: unlisted.slice(0, 10).map((page) => page.normalizedUrl), ratio },
      );
    }
    if (unlisted.length > 0) {
      return warn(`${unlisted.length} indexable page(s) are absent from the sitemap.`, {
        samples: unlisted.slice(0, 10).map((page) => page.normalizedUrl),
      });
    }
    return pass('Every indexable page crawled is listed in the sitemap.');
  },
};

export const orphanPages: SiteProbe = {
  id: 'orphan-pages',
  scope: 'site',
  title: 'Every page is reachable by an internal link',
  run({ crawl, origin }) {
    const linked = new Set<string>();
    for (const page of crawl.pages) {
      for (const link of page.extracted?.links ?? []) {
        if (!isSameSite(link.url, origin)) continue;
        const normalized = normalizeUrl(link.url);
        if (normalized !== null) linked.add(normalized);
      }
    }
    const seeds = new Set(crawl.seeds.map((seed) => normalizeUrl(seed)));
    const orphans = htmlPages(crawl.pages).filter(
      (page) => !linked.has(page.normalizedUrl) && !seeds.has(page.normalizedUrl),
    );

    return orphans.length === 0
      ? pass('Every crawled page has at least one internal link pointing at it.')
      : fail(`${orphans.length} page(s) are reachable only from the sitemap.`, {
          samples: orphans.slice(0, 10).map((page) => page.normalizedUrl),
        });
  },
};

export const clickDepth: SiteProbe = {
  id: 'click-depth',
  scope: 'site',
  title: 'Important pages sit within a few clicks of the entry point',
  run({ crawl }) {
    const pages = htmlPages(crawl.pages);
    if (pages.length === 0) return notApplicable('No HTML pages were crawled.');

    const deep = pages.filter((page) => page.depth > 3);
    const maxDepth = Math.max(...pages.map((page) => page.depth));
    const histogram: Record<string, number> = {};
    for (const page of pages) {
      const key = String(page.depth);
      histogram[key] = (histogram[key] ?? 0) + 1;
    }

    return deep.length === 0
      ? pass(`Deepest crawled page is ${maxDepth} click(s) from a seed.`, { histogram })
      : warn(`${deep.length} page(s) sit more than 3 clicks from a seed.`, {
          histogram,
          samples: deep.slice(0, 10).map((page) => page.normalizedUrl),
        });
  },
};

export const internalLinking: SiteProbe = {
  id: 'internal-linking',
  scope: 'site',
  title: 'Internal links distribute authority rather than dead-end',
  run({ crawl, origin }) {
    const pages = htmlPages(crawl.pages);
    if (pages.length < 2) return notApplicable('Too few pages crawled to judge link structure.');

    const inbound = new Map<string, number>();
    for (const page of pages) {
      for (const link of page.extracted?.links ?? []) {
        if (!isSameSite(link.url, origin)) continue;
        const normalized = normalizeUrl(link.url);
        if (normalized === null || normalized === page.normalizedUrl) continue;
        inbound.set(normalized, (inbound.get(normalized) ?? 0) + 1);
      }
    }
    const thin = pages.filter((page) => (inbound.get(page.normalizedUrl) ?? 0) < 2);

    return thin.length === 0
      ? pass('Every crawled page has at least two inbound internal links.')
      : warn(`${thin.length} of ${pages.length} page(s) have fewer than two inbound links.`, {
          samples: thin.slice(0, 10).map((page) => page.normalizedUrl),
        });
  },
};

/**
 * Hreflang, read across the whole crawl rather than one page at a time.
 *
 * A single page's hreflang block is almost never wrong on its own terms — it
 * lists locales and points at URLs, and nothing about it looks broken. The
 * defect lives between pages: A names B, B does not name A, and the cluster
 * silently stops working. Google discards a non-reciprocal annotation, so a
 * one-sided cluster is not a partial win, it is nothing.
 *
 * What this can see is what the crawl fetched. A target on another host is out
 * of scope for the crawl and cannot be checked for reciprocity here, so it is
 * reported as unverified rather than counted as a defect — a multi-domain
 * international setup is a normal shape, not a mistake.
 */
export const hreflangClusterQa: SiteProbe = {
  id: 'hreflang-cluster-qa',
  scope: 'site',
  title: 'Hreflang clusters are complete, reciprocal and indexable',
  run({ crawl, origin }) {
    const pages = htmlPages(crawl.pages);
    const annotated = pages.filter((page) => (page.extracted?.hreflang.length ?? 0) > 0);
    if (annotated.length === 0) {
      return notApplicable('No crawled page carries an hreflang annotation.');
    }

    const byUrl = new Map(pages.map((page) => [page.normalizedUrl, page]));
    /** What each page claims, normalized: page -> the URLs it names. */
    const claims = new Map<string, Set<string>>();
    const selfMissing: string[] = [];
    const badCodes: { page: string; hreflang: string }[] = [];
    const offSite = new Set<string>();

    for (const page of annotated) {
      const named = new Set<string>();
      let namesSelf = false;
      for (const entry of page.extracted?.hreflang ?? []) {
        if (!LANG_TAG.test(entry.hreflang) && entry.hreflang.toLowerCase() !== 'x-default') {
          badCodes.push({ page: page.normalizedUrl, hreflang: entry.hreflang });
        }
        const target = normalizeUrl(entry.url);
        if (target === null) continue;
        if (target === page.normalizedUrl) namesSelf = true;
        if (!isSameSite(target, origin)) {
          offSite.add(target);
          continue;
        }
        named.add(target);
      }
      claims.set(page.normalizedUrl, named);
      // Every page in a cluster must name itself, or the set each page
      // declares is a different set and none of them agree.
      if (!namesSelf) selfMissing.push(page.normalizedUrl);
    }

    const oneWay: { from: string; to: string }[] = [];
    const unreachable: { from: string; to: string }[] = [];
    for (const [from, targets] of claims) {
      for (const to of targets) {
        if (to === from) continue;
        const target = byUrl.get(to);
        if (target === undefined) {
          // Named but never fetched: blocked, out of budget, or simply gone.
          unreachable.push({ from, to });
          continue;
        }
        if (!(claims.get(to)?.has(from) ?? false)) oneWay.push({ from, to });
      }
    }

    const noindex = annotated.filter((page) => /\bnoindex\b/i.test(page.extracted?.metaRobots ?? ''));

    // Ordered worst first: a broken cluster beats a cosmetic complaint.
    if (oneWay.length > 0) {
      return fail(`${oneWay.length} hreflang annotation(s) are not reciprocated.`, {
        samples: oneWay.slice(0, 10),
      });
    }
    if (selfMissing.length > 0) {
      return fail(`${selfMissing.length} page(s) omit their own self-referential hreflang.`, {
        samples: selfMissing.slice(0, 10),
      });
    }
    if (noindex.length > 0) {
      return fail(`${noindex.length} page(s) in an hreflang cluster are noindex.`, {
        samples: noindex.slice(0, 10).map((page) => page.normalizedUrl),
      });
    }
    if (unreachable.length > 0) {
      return fail(`${unreachable.length} hreflang target(s) were never reached by the crawl.`, {
        samples: unreachable.slice(0, 10),
      });
    }
    if (badCodes.length > 0) {
      return fail(`${badCodes.length} hreflang value(s) are not a valid language tag.`, {
        samples: badCodes.slice(0, 10),
      });
    }

    const xDefault = annotated.some((page) =>
      (page.extracted?.hreflang ?? []).some((entry) => entry.hreflang.toLowerCase() === 'x-default'),
    );
    const detail = {
      annotatedPages: annotated.length,
      ...(offSite.size > 0 ? { offSiteTargetsNotVerified: [...offSite].slice(0, 10) } : {}),
    };
    if (!xDefault) {
      return warn(
        `${annotated.length} page(s) form reciprocal clusters, but none declares x-default.`,
        detail,
      );
    }
    return pass(
      `${annotated.length} annotated page(s) form complete, reciprocal clusters.`,
      detail,
    );
  },
};

/**
 * Can a crawler get past page one without running JavaScript?
 *
 * The failure this exists to catch is a listing whose "load more" is a button
 * and nothing else: everything after the first screen is then invisible to a
 * crawler, however many products are behind it. The corpus asks for page 2+ to
 * be reachable "without interaction or JavaScript", so the question is whether
 * a paginated URL appeared in the raw HTML — which is exactly what the crawl
 * saw — and whether following it actually produced a page.
 *
 * A site with no pagination at all is not a defect. Silence here means the
 * crawl found no paginated series, which is the normal shape of a small site.
 */
export const paginationCrawlPath: SiteProbe = {
  id: 'pagination-crawl-path',
  scope: 'site',
  title: 'Paginated series are crawlable without JavaScript',
  run({ crawl, origin }) {
    const pages = htmlPages(crawl.pages);
    if (pages.length === 0) return notApplicable('No HTML pages were crawled.');

    const fetched = new Map(crawl.pages.map((page) => [page.normalizedUrl, page]));
    const found: { from: string; to: string }[] = [];

    for (const page of pages) {
      for (const link of page.extracted?.links ?? []) {
        if (!isSameSite(link.url, origin)) continue;
        const isPagination =
          (link.rel !== null && /\b(next|prev)\b/i.test(link.rel)) || PAGED_URL.test(link.url);
        if (!isPagination) continue;
        const target = normalizeUrl(link.url);
        if (target === null || target === page.normalizedUrl) continue;
        found.push({ from: page.normalizedUrl, to: target });
      }
    }

    if (found.length === 0) {
      return notApplicable('The crawl found no paginated series in the raw HTML.');
    }

    // A link in the markup is the claim; a fetched page is the proof.
    const broken = found.filter(({ to }) => {
      const page = fetched.get(to);
      return page !== undefined && page.fetch.status !== null && page.fetch.status >= 400;
    });
    if (broken.length > 0) {
      return fail(`${broken.length} paginated URL(s) answered 4xx or 5xx.`, {
        samples: broken.slice(0, 10),
      });
    }

    const reached = found.filter(({ to }) => fetched.has(to));
    if (reached.length === 0) {
      return warn(
        `${found.length} paginated URL(s) were linked but none was reached within the crawl budget.`,
        { samples: found.slice(0, 10) },
      );
    }

    const noindex = reached.filter(({ to }) =>
      /\bnoindex\b/i.test(fetched.get(to)?.extracted?.metaRobots ?? ''),
    );
    if (noindex.length > 0) {
      return fail(`${noindex.length} paginated page(s) are noindex, hiding their items.`, {
        samples: noindex.slice(0, 10),
      });
    }

    return pass(
      `${reached.length} paginated URL(s) were reachable from raw HTML and answered 200.`,
      { samples: reached.slice(0, 10) },
    );
  },
};

export const urlConvention: SiteProbe = {
  id: 'url-convention',
  scope: 'site',
  title: 'One URL convention is applied consistently',
  run({ crawl }) {
    const pages = htmlPages(crawl.pages);
    if (pages.length === 0) return notApplicable('No HTML pages were crawled.');

    const paths = pages.map((page) => new URL(page.normalizedUrl).pathname);
    const uppercase = paths.filter((path) => /[A-Z]/.test(path));
    const underscores = paths.filter((path) => path.includes('_'));
    const deep = paths.filter((path) => pathDepth(`https://x${path}`) > 4);

    const problems: string[] = [];
    if (uppercase.length > 0) problems.push(`${uppercase.length} with uppercase characters`);
    if (underscores.length > 0) problems.push(`${underscores.length} with underscores`);
    if (deep.length > 0) problems.push(`${deep.length} more than four segments deep`);

    return problems.length === 0
      ? pass('URLs are lowercase, hyphenated and shallow.')
      : warn(`URL conventions are mixed: ${problems.join(', ')}.`, {
          uppercase: uppercase.slice(0, 5),
          underscores: underscores.slice(0, 5),
          deep: deep.slice(0, 5),
        });
  },
};

export const hostSlashPolicy: SiteProbe = {
  id: 'host-slash-policy',
  scope: 'site',
  title: 'One host and one trailing-slash policy serve every page',
  run({ crawl }) {
    const pages = htmlPages(crawl.pages);
    if (pages.length === 0) return notApplicable('No HTML pages were crawled.');

    const hosts = new Set(pages.map((page) => new URL(page.normalizedUrl).host));
    const directories = pages
      .map((page) => new URL(page.normalizedUrl).pathname)
      // A path with a file extension is not subject to a slash policy.
      .filter((path) => path !== '/' && !/\.[a-z0-9]{2,5}$/i.test(path));
    const withSlash = directories.filter((path) => path.endsWith('/')).length;
    const withoutSlash = directories.length - withSlash;

    if (hosts.size > 1) {
      return fail(`Pages are served from ${hosts.size} hosts: ${[...hosts].join(', ')}.`, {
        hosts: [...hosts],
      });
    }
    if (withSlash > 0 && withoutSlash > 0) {
      return fail(
        `Mixed trailing-slash policy: ${withSlash} with, ${withoutSlash} without.`,
        { withSlash, withoutSlash },
      );
    }
    return pass('One host, one consistent trailing-slash policy.', {
      host: [...hosts][0] ?? null,
      trailingSlash: withSlash > 0,
    });
  },
};

export const thirdPartyBudget: SiteProbe = {
  id: 'third-party-budget',
  scope: 'site',
  title: 'Third-party scripts stay within a budget',
  run({ crawl, origin }) {
    const pages = htmlPages(crawl.pages);
    if (pages.length === 0) return notApplicable('No HTML pages were crawled.');

    const hosts = new Map<string, number>();
    for (const page of pages) {
      for (const script of page.extracted?.scripts ?? []) {
        if (isSameSite(script, origin)) continue;
        try {
          const host = new URL(script).host;
          hosts.set(host, (hosts.get(host) ?? 0) + 1);
        } catch {
          // A script src that will not parse is a markup defect, not a budget one.
        }
      }
    }
    const ranked = [...hosts.entries()].sort((a, b) => b[1] - a[1]);

    if (hosts.size === 0) return pass('No third-party scripts were found.');
    if (hosts.size > 10) {
      return fail(`${hosts.size} third-party script hosts across the crawl.`, {
        hosts: ranked.slice(0, 15),
      });
    }
    return warn(`${hosts.size} third-party script host(s); confirm each is justified.`, {
      hosts: ranked,
    });
  },
};

export const siteProbes = [
  robotsTxt,
  sitemapValidity,
  sitemapCanonicalAgreement,
  indexBloat,
  orphanPages,
  clickDepth,
  internalLinking,
  urlConvention,
  hostSlashPolicy,
  thirdPartyBudget,
  hreflangClusterQa,
  paginationCrawlPath,
];
