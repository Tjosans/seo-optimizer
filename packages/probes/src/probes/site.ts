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

interface IconSize {
  readonly width: number;
  readonly height: number;
}

/**
 * An icon's dimensions, read from the bytes the crawl kept.
 *
 * Three formats cover essentially every real favicon, and each states its size
 * in a fixed place near the front, so no image library is needed. Anything else
 * returns null and is reported as unmeasured rather than guessed at.
 */
function iconSize(fetched: { bytes?: Uint8Array; contentType: string | null }): IconSize | null {
  const bytes = fetched.bytes;
  if (bytes === undefined) return null;

  // PNG: 8-byte signature, then an IHDR whose width and height are big-endian
  // 32-bit integers at offsets 16 and 20.
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  // ICO: a 6-byte header, then directory entries whose first two bytes are
  // width and height, with 0 meaning 256 — the one size too big for a byte.
  if (bytes.length >= 8 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01) {
    const width = bytes[6] ?? 0;
    const height = bytes[7] ?? 0;
    return { width: width === 0 ? 256 : width, height: height === 0 ? 256 : height };
  }

  // SVG: text, so read the viewBox it scales from, or its declared size.
  if ((fetched.contentType ?? '').includes('svg')) {
    const text = new TextDecoder().decode(bytes);
    const viewBox = /viewBox\s*=\s*["']\s*[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(text);
    if (viewBox) return { width: Number(viewBox[1]), height: Number(viewBox[2]) };
    const width = /\bwidth\s*=\s*["']([\d.]+)/i.exec(text);
    const height = /\bheight\s*=\s*["']([\d.]+)/i.exec(text);
    if (width && height) return { width: Number(width[1]), height: Number(height[1]) };
  }
  return null;
}

/** The name a page claims for its site, from og:site_name or schema.org. */
function siteNameOf(page: CrawledPage): string | null {
  const extracted = page.extracted;
  if (extracted === null) return null;

  const og = extracted.openGraph['og:site_name'];
  if (og !== undefined && og !== '') return og;

  for (const block of extracted.jsonLd) {
    const nodes = Array.isArray(block) ? block : [block];
    for (const node of nodes) {
      if (typeof node !== 'object' || node === null) continue;
      const record = node as Record<string, unknown>;
      const graph = Array.isArray(record['@graph']) ? (record['@graph'] as unknown[]) : [];
      for (const candidate of [record, ...graph]) {
        if (typeof candidate !== 'object' || candidate === null) continue;
        const entry = candidate as Record<string, unknown>;
        const types = [entry['@type']].flat();
        if (!types.some((type) => type === 'WebSite' || type === 'Organization')) continue;
        const name = entry['name'];
        if (typeof name === 'string' && name !== '') return name;
      }
    }
  }
  return null;
}

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

/**
 * Every way of spelling the site's address ends up in the same place, once.
 *
 * Four URLs exist before anyone reaches a page: http and https, apex and www.
 * A site that serves content on more than one of them is two sites to a search
 * engine, splitting its own signals; a site that reaches the right one through
 * two redirects spends a round trip on every cold visit and, over http, spends
 * the first one in cleartext. The corpus asks for one HTTPS URL in one hop, and
 * that is only answerable by asking all four — which the crawl does, because a
 * probe may not make requests of its own.
 *
 * Silent on a host that has no variants. An IP address or a `localhost` seed
 * has no www spelling, and reporting the absence as a defect would fail every
 * audit of a staging environment for being a staging environment.
 */
export const hostRedirect: SiteProbe = {
  id: 'host-redirect',
  scope: 'site',
  title: 'Every host and protocol variant reaches one HTTPS URL in one hop',
  run({ crawl }) {
    const variants = crawl.auxiliary.filter((entry) => entry.reason === 'host-variant');
    if (variants.length === 0) {
      return notApplicable('The seed host has no scheme or www variants to test.');
    }

    const unreachable = variants.filter(
      (entry) => entry.fetch.error !== null || entry.fetch.status === null,
    );
    if (unreachable.length === variants.length) {
      return notApplicable('No host variant answered; the host may not resolve publicly.');
    }
    const answered = variants.filter((entry) => !unreachable.includes(entry));

    const broken = answered.filter((entry) => (entry.fetch.status ?? 0) >= 400);
    if (broken.length > 0) {
      return fail(`${broken.length} host variant(s) answered 4xx or 5xx.`, {
        samples: broken.map((entry) => ({ url: entry.url, status: entry.fetch.status })),
      });
    }

    const insecure = answered.filter((entry) => !entry.fetch.finalUrl.startsWith('https://'));
    if (insecure.length > 0) {
      return fail(`${insecure.length} host variant(s) end on http rather than https.`, {
        samples: insecure.map((entry) => ({ url: entry.url, landsOn: entry.fetch.finalUrl })),
      });
    }

    const destinations = new Set(answered.map((entry) => normalizeUrl(entry.fetch.finalUrl)));
    if (destinations.size > 1) {
      return fail(`Host variants land on ${destinations.size} different URLs, not one.`, {
        landings: answered.map((entry) => ({ url: entry.url, landsOn: entry.fetch.finalUrl })),
      });
    }

    // One hop is the budget: the variant itself, then the canonical URL.
    const long = answered.filter((entry) => entry.fetch.redirectChain.length > 1);
    if (long.length > 0) {
      return fail(`${long.length} host variant(s) take more than one hop to arrive.`, {
        samples: long.map((entry) => ({
          url: entry.url,
          hops: entry.fetch.redirectChain.map((hop) => hop.status),
        })),
      });
    }

    const detail = {
      tested: answered.length,
      landsOn: [...destinations][0],
      ...(unreachable.length > 0
        ? { notResolved: unreachable.map((entry) => entry.url) }
        : {}),
    };
    return unreachable.length > 0
      ? warn(
          `${answered.length} host variant(s) reach one HTTPS URL in one hop; ` +
            `${unreachable.length} did not resolve.`,
          detail,
        )
      : pass(`All ${answered.length} host variants reach one HTTPS URL in one hop.`, detail);
  },
};

/**
 * The site says who it is, and the icon it says it with actually exists.
 *
 * These travel together because they are one thing to a searcher: the row in a
 * result page carries a name and a small square image, and a site that leaves
 * either to be guessed gets whatever the search engine infers. The icon has to
 * be square because it will be displayed square — a wide one is cropped, which
 * is how a logo becomes an unreadable smear at 16px.
 *
 * What "consistent with the approved brand baseline" means is a person's call,
 * and the triage table read that wording as naming an input rather than an
 * artifact. So what is settled here is the observable half: a name is declared,
 * every page that declares one agrees, and the icon resolves to a square image.
 */
export const faviconSiteName: SiteProbe = {
  id: 'favicon-site-name',
  scope: 'site',
  title: 'The site declares a stable name and a square, crawlable icon',
  run({ crawl }) {
    const pages = htmlPages(crawl.pages);
    if (pages.length === 0) return notApplicable('No HTML pages were crawled.');

    const root = [...pages].sort((a, b) => a.depth - b.depth)[0];
    const declared = root?.extracted?.icons ?? [];
    if (declared.length === 0) {
      return fail('The root document declares no favicon or touch icon.');
    }

    const names = new Set<string>();
    for (const page of pages) {
      const name = siteNameOf(page);
      if (name !== null) names.add(name);
    }
    if (names.size === 0) {
      return fail('No page declares a site name via og:site_name or WebSite/Organization schema.');
    }
    if (names.size > 1) {
      return fail(`Pages disagree about the site name: ${[...names].join(' / ')}.`, {
        names: [...names],
      });
    }

    const fetched = crawl.auxiliary.filter((entry) => entry.reason === 'icon');
    if (fetched.length === 0) {
      return warn(`Site name "${[...names][0]}" is declared, but no icon was fetched.`, {
        declared: declared.map((icon) => icon.url),
      });
    }

    const missing = fetched.filter(
      (entry) => entry.fetch.error !== null || (entry.fetch.status ?? 0) !== 200,
    );
    if (missing.length > 0) {
      return fail(`${missing.length} declared icon(s) do not resolve.`, {
        samples: missing.map((entry) => ({
          url: entry.url,
          status: entry.fetch.status,
          error: entry.fetch.error,
        })),
      });
    }

    const notImages = fetched.filter(
      (entry) => !(entry.fetch.contentType ?? '').toLowerCase().startsWith('image/'),
    );
    if (notImages.length > 0) {
      return fail(`${notImages.length} declared icon(s) are not served as an image.`, {
        samples: notImages.map((entry) => ({
          url: entry.url,
          contentType: entry.fetch.contentType,
        })),
      });
    }

    const measured = fetched
      .map((entry) => ({ url: entry.url, size: iconSize(entry.fetch) }))
      .filter((item): item is { url: string; size: IconSize } => item.size !== null);
    const oblong = measured.filter((item) => item.size.width !== item.size.height);
    if (oblong.length > 0) {
      return fail(`${oblong.length} icon(s) are not square and will be cropped.`, {
        samples: oblong,
      });
    }

    const name = [...names][0];
    if (measured.length === 0) {
      return warn(
        `Site name "${name}" and ${fetched.length} icon(s) resolve, but no icon's ` +
          'dimensions could be read.',
        { formats: fetched.map((entry) => entry.fetch.contentType) },
      );
    }
    return pass(
      `Site name "${name}" is consistent across ${pages.length} page(s), and ` +
        `${measured.length} icon(s) resolve as square images.`,
      { name, icons: measured },
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
  hostRedirect,
  faviconSiteName,
];
