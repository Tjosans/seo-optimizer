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
];
