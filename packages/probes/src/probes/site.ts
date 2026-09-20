/**
 * Site-scoped probes: the questions that can only be answered by looking at
 * the crawl as a whole — what is discoverable, what agrees with what, and how
 * the URL space is shaped.
 */

import { extract, isAllowed, isSameSite, normalizeUrl, pathDepth } from '@seo/crawler';
import type { CrawledPage } from '@seo/crawler';
import { DOMAIN_HISTORY_REQUIRED_CHECKS, REPORTING_MEASURED_ENGINES, indexNowKeyUrl, inputRecordProblem,isProductToken, isUserDirectedAgent } from '@seo/core';
import type { SiteProbe } from '../types.js';
import { errored, fail, notApplicable, pass, warn } from '../types.js';
import { checkLanguageTag } from './language-tags.js';

/** Push `value` into the set kept under `key`, creating it on first use. */
const add = (index: Map<string, Set<string>>, key: string, value: string): void => {
  const existing = index.get(key);
  if (existing === undefined) index.set(key, new Set([value]));
  else existing.add(value);
};

export const NOINDEX_DIRECTIVE = /\bnoindex\b|\bnone\b/i;

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

/** Google parses the first 500 KiB of robots.txt and ignores the rest. */
const ROBOTS_PARSE_LIMIT = 500 * 1024;

/**
 * robots.txt, judged as corpus v5.0 2.1 asks: its behaviour recorded,
 * "including intentional absence and cache/error cases".
 *
 * Absence is a decision, not a defect. A 404 tells every crawler the whole
 * site is open, which is what many sites intend, so it holds the check for a
 * person to record rather than failing it. What does fail is a robots.txt
 * crawlers read as "stay out": everything disallowed, or a file that answers
 * with a server error, a 429 or nothing at all, which Google treats the same
 * way. A Sitemap line is no longer asked for, since v5.0 makes the sitemap
 * itself optional.
 */
export const robotsTxt: SiteProbe = {
  id: 'robots-txt',
  scope: 'site',
  title: 'robots.txt states crawl policy crawlers can read',
  run({ crawl }) {
    const status = crawl.robotsStatus;
    if (status === null) {
      return fail('robots.txt did not answer; crawlers treat an unreachable robots.txt as "stay out".');
    }
    if (status !== undefined && (status >= 500 || status === 429)) {
      return fail(`robots.txt answers ${status}; crawlers stop crawling while it does.`, { status });
    }
    if (crawl.robots.absent || crawl.robotsTxt === null) {
      return warn(
        'No robots.txt is served, so crawlers treat every URL as allowed. ' +
          'Record whether that is the intended policy.',
        status === undefined ? {} : { status },
      );
    }
    const blocksEverything = crawl.robots.groups.some(
      (group) =>
        group.agents.includes('*') &&
        group.rules.some((rule) => !rule.allow && rule.path === '/'),
    );
    if (blocksEverything) {
      return fail('robots.txt disallows everything for the default user agent.');
    }
    const bytes = Buffer.byteLength(crawl.robotsTxt, 'utf8');
    if (bytes > ROBOTS_PARSE_LIMIT) {
      return warn(
        `robots.txt is ${Math.round(bytes / 1024)} KiB; rules past the first 500 KiB are ignored.`,
        { bytes },
      );
    }
    return pass(
      `robots.txt is served and readable, declaring ${crawl.robots.sitemaps.length} sitemap(s).`,
      { sitemaps: crawl.robots.sitemaps, blockedUrls: crawl.blockedByRobots.length },
    );
  },
};

/** The sitemap protocol's per-file entry limit. */
const SITEMAP_URL_LIMIT = 50_000;

export const sitemapValidity: SiteProbe = {
  id: 'sitemap-validity',
  scope: 'site',
  title: 'The XML sitemap resolves to live, on-site URLs',
  run({ crawl, origin }) {
    if (crawl.sitemapUrls.length === 0) {
      // v5.0 2.1: sitemaps are "not a universal indexing prerequisite", so an
      // omission is a decision to record. A sitemap robots.txt names that does
      // not answer is not an omission — the site believes it publishes one.
      const declared = new Set(crawl.robots.sitemaps);
      const broken = crawl.sitemaps.filter(
        (doc) => declared.has(doc.url) && (doc.status === null || doc.status >= 400),
      );
      if (broken.length > 0) {
        return fail(`robots.txt declares ${broken.length} sitemap(s) that do not answer.`, {
          samples: broken.slice(0, 10).map((doc) => ({ url: doc.url, status: doc.status })),
        });
      }
      return warn(
        'No sitemap is published. v5.0 makes one optional: record the omission and ' +
          'check that internal links reach every page that should be found.',
      );
    }
    const oversized = crawl.sitemaps.filter((doc) => doc.urlCount > SITEMAP_URL_LIMIT);
    if (oversized.length > 0) {
      return fail(
        `${oversized.length} sitemap file(s) list more than 50,000 URLs; split them.`,
        { samples: oversized.slice(0, 10).map((doc) => ({ url: doc.url, urls: doc.urlCount })) },
      );
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

    // "Absent from the sitemap" is only a finding when the whole sitemap was
    // read. A document cut at the crawler's body limit is missing URLs this
    // probe would then report as missing from the site's own index.
    const cut = crawl.sitemaps.filter((document) => document.truncated);
    if (cut.length > 0) {
      return errored(
        `${cut.length} sitemap(s) could not be read in full, so what is listed is unknown.`,
        { samples: cut.slice(0, 5).map((document) => document.url) },
      );
    }

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
 * Hreflang as written, rather than hreflang as a cluster.
 *
 * `hreflang-cluster-qa` (4.9) asks whether the pages agree with each other.
 * This asks the earlier question 1.14 puts as "supported language-region
 * codes" and "distinct URLs per locale": whether one page's annotation block
 * says anything a search engine can act on at all. The two fail apart —
 * a cluster can be flawlessly reciprocal and entirely inert, because every
 * page in it reciprocates `en-UK`, which names no country.
 *
 * The site profile matters here in a way it does not for the cluster check. A
 * site that declares itself multilingual and carries no annotation anywhere has
 * not implemented this; a site that never claimed to be multilingual and
 * carries none has nothing to implement, and saying so would be noise.
 */
export const hreflangImplementation: SiteProbe = {
  id: 'hreflang-implementation',
  scope: 'site',
  title: 'Hreflang annotations name locales search engines support',
  run({ crawl, flags }) {
    const pages = htmlPages(crawl.pages);
    const annotated = pages.filter((page) => (page.extracted?.hreflang.length ?? 0) > 0);

    if (annotated.length === 0) {
      return flags.includes('multilingual')
        ? fail('The site profile says this site is multilingual, but no crawled page carries an hreflang annotation.', {
            crawledPages: pages.length,
          })
        : notApplicable('No crawled page carries an hreflang annotation.');
    }

    const invalid: { page: string; hreflang: string; problem: string }[] = [];
    const unsupported: { page: string; hreflang: string; problem: string }[] = [];
    const relative: { page: string; hreflang: string; href: string }[] = [];
    const conflicting: { page: string; hreflang: string; urls: string[] }[] = [];
    const shared: { page: string; url: string; hreflangs: string[] }[] = [];
    const repeatedDefault: string[] = [];
    const lonelyDefault: string[] = [];
    const locales = new Set<string>();

    for (const page of annotated) {
      const entries = page.extracted?.hreflang ?? [];
      /** What each value points at on this page, and what points at each URL. */
      const byTag = new Map<string, Set<string>>();
      const byUrl = new Map<string, Set<string>>();
      let defaults = 0;

      for (const entry of entries) {
        const value = entry.hreflang.trim();
        const key = value.toLowerCase();
        const target = normalizeUrl(entry.url) ?? entry.url;
        add(byTag, key, target);
        add(byUrl, target, key);

        if (key === 'x-default') {
          defaults += 1;
        } else {
          const verdict = checkLanguageTag(value);
          if (!verdict.ok) {
            invalid.push({ page: page.normalizedUrl, hreflang: value, problem: verdict.problem });
          } else {
            locales.add(key);
            if (verdict.warning !== undefined) {
              unsupported.push({ page: page.normalizedUrl, hreflang: value, problem: verdict.warning });
            }
          }
        }
        // A relative hreflang href is not a small untidiness: the annotation is
        // discarded, so the locale it names is simply absent.
        if (!/^https?:\/\//i.test(entry.href.trim())) {
          relative.push({ page: page.normalizedUrl, hreflang: value, href: entry.href });
        }
      }

      for (const [hreflang, urls] of byTag) {
        // A repeated x-default is an ambiguous fallback, reported as itself
        // below rather than as one more locale that cannot make its mind up.
        if (hreflang === 'x-default') continue;
        if (urls.size > 1) {
          conflicting.push({ page: page.normalizedUrl, hreflang, urls: [...urls] });
        }
      }
      for (const [url, tags] of byUrl) {
        // x-default is meant to double up on a real locale's URL; two *locales*
        // on one URL is the thing 1.14 asks against.
        const named = [...tags].filter((tag) => tag !== 'x-default');
        if (named.length > 1) shared.push({ page: page.normalizedUrl, url, hreflangs: named });
      }
      if (defaults > 1) repeatedDefault.push(page.normalizedUrl);
      if (defaults === 1 && byTag.size <= 2) lonelyDefault.push(page.normalizedUrl);
    }

    // Ordered by how completely each defect stops the annotation working.
    if (invalid.length > 0) {
      const first = invalid[0]!;
      return fail(
        `${invalid.length} hreflang value(s) name a locale that does not exist: "${first.hreflang}" ${first.problem}.`,
        { samples: invalid.slice(0, 10) },
      );
    }
    if (relative.length > 0) {
      return fail(`${relative.length} hreflang annotation(s) use a relative href and are ignored.`, {
        samples: relative.slice(0, 10),
      });
    }
    if (conflicting.length > 0) {
      return fail(`${conflicting.length} hreflang value(s) are declared twice pointing at different URLs.`, {
        samples: conflicting.slice(0, 10),
      });
    }
    if (shared.length > 0) {
      return fail(`${shared.length} URL(s) are claimed by more than one locale, so the locales are not on distinct URLs.`, {
        samples: shared.slice(0, 10),
      });
    }
    if (repeatedDefault.length > 0) {
      return fail(`${repeatedDefault.length} page(s) declare x-default more than once.`, {
        samples: repeatedDefault.slice(0, 10),
      });
    }

    const detail = { annotatedPages: annotated.length, locales: [...locales].sort() };
    if (unsupported.length > 0) {
      return warn(`${unsupported.length} hreflang value(s) use a region search engines do not document support for.`, {
        ...detail,
        samples: unsupported.slice(0, 10),
      });
    }
    if (lonelyDefault.length > 0) {
      return warn(`${lonelyDefault.length} page(s) declare x-default beside a single locale, so there is nothing to fall back from.`, {
        ...detail,
        samples: lonelyDefault.slice(0, 10),
      });
    }
    return pass(
      `${annotated.length} annotated page(s) name ${locales.size} supported locale(s) on distinct URLs.`,
      detail,
    );
  },
};

/**
 * `locale-content-parity` (3.12): whether the pages an hreflang cluster names
 * as different languages actually say different things.
 *
 * 3.12's own "done when" asks that a qualified human review intent,
 * terminology, currency and legal scope for each locale — nothing a crawl can
 * do. But a page publishing the same heading text word for word as a page
 * claiming a different language has not been localized at all, whatever a
 * human review would find; that is a defect a crawl can name outright, the
 * same way `author-date-signals` names a date stamped identically across an
 * archive without asking whether any one date is correct.
 *
 * Scoped to reciprocal hreflang pairs whose *self-declared* locale codes
 * differ in primary subtag — `en-GB` and `en-US` are one language and are
 * `locale-canonical`'s question, not this one's — and only where each side
 * carries enough heading text to compare at all. A pair with too little text,
 * or that the crawl never reached, says nothing either way and is left for
 * the person 3.12 already asks for.
 */
export const localeContentParity: SiteProbe = {
  id: 'locale-content-parity',
  scope: 'site',
  title: 'Locale pages carry distinct, localized content',
  run({ crawl, flags }) {
    const pages = htmlPages(crawl.pages);
    const annotated = pages.filter((page) => (page.extracted?.hreflang.length ?? 0) > 0);

    if (annotated.length === 0) {
      return flags.includes('multilingual')
        ? warn('The site profile says this site is multilingual, but no crawled page carries an hreflang annotation.')
        : notApplicable('No crawled page carries an hreflang annotation.');
    }

    const byUrl = new Map(pages.map((page) => [page.normalizedUrl, page]));
    const primarySubtag = (tag: string | null | undefined): string | null => {
      const trimmed = tag?.trim() ?? '';
      return trimmed === '' ? null : trimmed.split(/[-_]/)[0]!.toLowerCase();
    };
    const ownLocaleOf = (page: CrawledPage): string | null => {
      const entries = page.extracted?.hreflang ?? [];
      const self = entries.find(
        (entry) => entry.hreflang.toLowerCase() !== 'x-default' && normalizeUrl(entry.url) === page.normalizedUrl,
      );
      return primarySubtag(self?.hreflang ?? page.extracted?.lang ?? null);
    };
    const headingsOf = (page: CrawledPage): string[] =>
      (page.extracted?.headings ?? []).map((heading) => heading.text.trim()).filter((text) => text.length > 0);

    const checked = new Set<string>();
    const identical: { a: string; b: string; headings: number }[] = [];
    let comparable = 0;

    for (const page of annotated) {
      const ownLocale = ownLocaleOf(page);
      for (const entry of page.extracted?.hreflang ?? []) {
        if (entry.hreflang.toLowerCase() === 'x-default') continue;
        const targetLocale = primarySubtag(entry.hreflang);
        if (targetLocale === null || targetLocale === ownLocale) continue;

        const targetUrl = normalizeUrl(entry.url);
        if (targetUrl === null || targetUrl === page.normalizedUrl) continue;
        const target = byUrl.get(targetUrl);
        if (target === undefined) continue;

        const pairKey = [page.normalizedUrl, targetUrl].sort().join(' :: ');
        if (checked.has(pairKey)) continue;
        checked.add(pairKey);

        const ours = headingsOf(page);
        const theirs = headingsOf(target);
        if (ours.length < 2 || theirs.length < 2) continue;

        comparable += 1;
        if (ours.length === theirs.length && ours.every((text, index) => text === theirs[index])) {
          identical.push({ a: page.normalizedUrl, b: targetUrl, headings: ours.length });
        }
      }
    }

    if (identical.length > 0) {
      return fail(
        `${identical.length} locale pair(s) declare different languages but publish word-for-word identical headings.`,
        { samples: identical.slice(0, 10) },
      );
    }
    if (comparable === 0) {
      return warn('No locale pair had enough heading text to compare content.', {
        annotatedPages: annotated.length,
      });
    }
    return pass(`${comparable} locale pair(s) show distinct content per declared language.`, {
      annotatedPages: annotated.length,
    });
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
 *
 * Two further shapes fail the same "reachable without interaction or
 * JavaScript" requirement even where a page 2 exists and answers 200. A page
 * whose "next" link is addressed only by a URL fragment (`#page=2`) names no
 * separate address at all — a fragment is never sent to the server, so a
 * crawler has nothing to request. And a paginated page that canonicalizes
 * onto the unpaginated URL is telling search engines to index page one only,
 * a blanket collapse that drops the rest of the series from the index even
 * though every page answered 200 along the way.
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
    const fragmentOnly: { from: string; href: string }[] = [];

    for (const page of pages) {
      for (const href of page.extracted?.fragmentPageLinks ?? []) {
        fragmentOnly.push({ from: page.normalizedUrl, href });
      }
      for (const link of page.extracted?.links ?? []) {
        if (!isSameSite(link.url, origin)) continue;
        const isPagination =
          (link.rel !== null && /\b(next|prev)\b/i.test(link.rel)) || PAGED_URL.test(link.url);
        if (!isPagination) continue;
        const target = normalizeUrl(link.url);
        if (target === null) continue;
        if (target === page.normalizedUrl) {
          // The path is unchanged; whatever moves the reader is client-side.
          // A page number that appears only in the fragment is the same fact
          // as one dropped entirely — no request a crawler could make differs.
          if (link.url.includes('#')) fragmentOnly.push({ from: page.normalizedUrl, href: link.href });
          continue;
        }
        found.push({ from: page.normalizedUrl, to: target });
      }
    }

    if (found.length === 0 && fragmentOnly.length === 0) {
      return notApplicable('The crawl found no paginated series in the raw HTML.');
    }

    if (fragmentOnly.length > 0) {
      return fail(
        `${fragmentOnly.length} paginated link(s) are addressed only by a URL fragment, so no separate page exists for a crawler to request.`,
        { samples: fragmentOnly.slice(0, 10), realPaginatedLinks: found.length },
      );
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

    const blanketCanonical = reached.filter(({ to }) => {
      const canonical = normalizeUrl(fetched.get(to)?.extracted?.canonical ?? '');
      return canonical !== null && canonical !== to && !PAGED_URL.test(canonical);
    });
    if (blanketCanonical.length > 0) {
      return fail(
        `${blanketCanonical.length} paginated page(s) canonicalize onto an unpaginated URL, collapsing the series onto page one and dropping the rest from the index.`,
        { samples: blanketCanonical.slice(0, 10) },
      );
    }

    return pass(
      `${reached.length} paginated URL(s) were reachable from raw HTML and answered 200.`,
      { samples: reached.slice(0, 10) },
    );
  },
};

/** The normalized rel=canonical a landing page declares, or null. */
const landingCanonical = (body: string, url: string): string | null => {
  if (body === '') return null;
  const canonical = extract(body, url).canonical;
  return canonical === null ? null : normalizeUrl(canonical);
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
  title: 'Every host and protocol variant reaches one HTTPS URL, preferably in one hop',
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
      const landings = answered.map((entry) => ({
        url: entry.url,
        landsOn: entry.fetch.finalUrl,
        canonical: landingCanonical(entry.fetch.body, entry.fetch.finalUrl),
      }));
      // v5.0 1.6 allows "an intentional retained duplicate-host exception" with
      // "consistent canonical behavior": two hosts serving the page, both naming
      // one address. That is a decision for a person to evidence, not a defect.
      // Hosts that disagree about the address, or say nothing, are the defect.
      const canonicals = new Set(landings.map((landing) => landing.canonical));
      if (canonicals.size === 1 && !canonicals.has(null)) {
        return warn(
          `Host variants land on ${destinations.size} different URLs that all declare one ` +
            'canonical; record the retained duplicate as an intentional exception.',
          { landings },
        );
      }
      return fail(`Host variants land on ${destinations.size} different URLs, not one.`, { landings });
    }

    // v5.0 1.6 asks for one hop "preferably", and for reviewed evidence where a
    // variant cannot manage it, so a longer path holds the check for a person
    // rather than failing it. A loop never arrives and is caught above.
    const long = answered.filter((entry) => entry.fetch.redirectChain.length > 1);
    if (long.length > 0) {
      return warn(`${long.length} host variant(s) take more than one hop to arrive.`, {
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

/**
 * Does what the site does to AI crawlers match what its owners decided?
 *
 * The corpus asks for robots.txt and edge behaviour to match the approved
 * policy, and the policy is the part no crawl can supply — a site that wants to
 * be in AI answers and one that wants to be out of them look identical from
 * outside. So this is silent until somebody has written the decision down on
 * the site record, and that is the honest answer rather than a gap: an
 * unrecorded policy is not a policy the site is failing to keep.
 *
 * With a policy, three things are compared:
 *
 *   robots.txt against the stance, in both directions. A crawler the policy
 *   welcomes but robots.txt turns away is as much a defect as the reverse, and
 *   it is the direction people miss — a blanket disallow written years ago
 *   quietly excludes the crawler someone has since decided to court. A site
 *   with no robots.txt allows everything, which agrees with a policy that does.
 *
 *   The edge against the stance, for crawlers the policy allows. robots.txt is
 *   a request; a CDN rule is a wall. A 403 to a welcomed crawler means the
 *   policy is being enforced by infrastructure nobody told about it.
 *
 *   Not the reverse, with one exception. A disallowed crawler that still gets a
 *   200 is the normal shape of robots-only enforcement: robots.txt asks, and
 *   well-behaved crawlers comply. User-directed fetchers are the exception —
 *   their operators say they may not read robots.txt (`USER_DIRECTED_AGENTS`) —
 *   so a 200 to one the policy disallows means nothing enforces the decision.
 *
 * Corpus v5.0 2.9 adds two limits this detector states rather than hides. The
 * requests it makes carry a user-agent string, which makes them simulations:
 * genuine crawler traffic is identified by the provider's IP or DNS method in
 * the site's own logs, which a crawl cannot see. And a product token such as
 * Google-Extended names a use of content, not a fetcher, so it is checked in
 * robots.txt and never simulated.
 */
export const aiCrawlerDirectiveVerify: SiteProbe = {
  id: 'ai-crawler-directive-verify',
  scope: 'site',
  title: 'robots.txt and simulated crawler requests agree with the approved AI crawler policy',
  run({ crawl, aiPolicy, origin }) {
    if (aiPolicy === null || aiPolicy === undefined) {
      return notApplicable('No AI crawler policy is recorded on the site record.');
    }
    const agents = Object.entries(aiPolicy.agents);
    if (agents.length === 0) {
      return notApplicable('The recorded AI crawler policy names no crawlers.');
    }

    const root = new URL('/', origin).toString();
    const disagrees: { agent: string; policy: string; robotsTxt: string }[] = [];
    for (const [agent, stance] of agents) {
      const allowed = isAllowed(crawl.robots, agent, root);
      if (allowed !== (stance === 'allow')) {
        disagrees.push({
          agent,
          policy: stance,
          robotsTxt: crawl.robots.absent ? 'absent (allows all)' : allowed ? 'allow' : 'disallow',
        });
      }
    }
    if (disagrees.length > 0) {
      return fail(`robots.txt contradicts the policy for ${disagrees.length} crawler(s).`, {
        approvedAt: aiPolicy.approvedAt,
        disagreements: disagrees,
      });
    }

    const stanceOf = (agent: string | undefined) =>
      agent === undefined ? undefined : aiPolicy.agents[agent];
    const tests = crawl.auxiliary.filter((entry) => entry.reason === 'user-agent-test');
    const blocked = tests.filter((entry) => {
      if (stanceOf(entry.userAgent) !== 'allow') return false;
      const status = entry.fetch.status;
      return status === 401 || status === 403 || status === 429;
    });
    if (blocked.length > 0) {
      return fail(
        `${blocked.length} crawler(s) the policy allows are turned away at the edge ` +
          'in simulated requests.',
        {
          approvedAt: aiPolicy.approvedAt,
          simulated: true,
          samples: blocked.map((entry) => ({
            agent: entry.userAgent,
            status: entry.fetch.status,
          })),
        },
      );
    }

    const tokens = agents.map(([agent]) => agent).filter(isProductToken);
    const simulatable = agents.map(([agent]) => agent).filter((agent) => !isProductToken(agent));
    const detail = {
      approvedAt: aiPolicy.approvedAt,
      approvedBy: aiPolicy.approvedBy,
      agents: agents.length,
      simulatedRequests: tests.length,
      // Checked in robots.txt only: nothing fetches under these names.
      productTokens: tokens,
      identityVerified: 'not observable from a crawl; use trusted logs',
    };

    const unenforced = tests.filter(
      (entry) =>
        entry.userAgent !== undefined &&
        isUserDirectedAgent(entry.userAgent) &&
        stanceOf(entry.userAgent) === 'disallow' &&
        entry.fetch.status !== null &&
        entry.fetch.status < 400,
    );
    if (unenforced.length > 0) {
      return warn(
        `The policy disallows ${unenforced.map((entry) => entry.userAgent).join(', ')}, ` +
          'user-directed fetcher(s) that may not follow robots.txt, and a simulated request ' +
          'was served; only an edge rule would enforce that decision.',
        {
          ...detail,
          samples: unenforced.map((entry) => ({ agent: entry.userAgent, status: entry.fetch.status })),
        },
      );
    }

    if (simulatable.length > 0 && tests.length === 0) {
      return warn(
        `robots.txt matches the policy for all ${agents.length} crawler(s), but no ` +
          'simulated request was made, so edge behaviour is unverified.',
        detail,
      );
    }
    return pass(
      tests.length === 0
        ? `robots.txt matches the policy for all ${agents.length} product token(s).`
        : `robots.txt and ${tests.length} simulated request(s) agree with the policy for all ` +
            `${agents.length} crawler(s); genuine crawler traffic is not observable from a crawl.`,
      detail,
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

/** A `urlMatrix` pattern as a matcher: an exact URL or a glob (`*` in a segment, `**` across). */
export const matrixMatcher = (pattern: string, origin: string): { test: (url: string) => boolean; exact: boolean } => {
  const trimmed = pattern.trim();
  const absolute = /^https?:\/\//i.test(trimmed) ? trimmed : new URL(trimmed.startsWith('/') ? trimmed : `/${trimmed}`, origin).toString();
  if (!absolute.includes('*')) {
    const target = normalizeUrl(absolute);
    return { exact: true, test: (url) => url === target };
  }
  const source = absolute
    .split(/(\*\*|\*)/)
    .map((part) => (part === '**' ? '.*' : part === '*' ? '[^/?#]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  const regex = new RegExp(`^${source}$`, 'i');
  return {
    exact: false,
    test: (url) => regex.test(url) || (url.endsWith('/') ? regex.test(url.slice(0, -1)) : regex.test(`${url}/`)),
  };
};

const MATRIX_SAMPLES = 10;

/**
 * Whether the crawl agrees with the URL matrix (0.3). The matrix is an input
 * nobody can observe, so this is `not-applicable` without it. Rows naming an
 * `environment` are set aside: the crawl has no declared environment to judge
 * them against. Each crawled URL is judged by the most specific pattern that
 * matches it (an exact URL beats a glob, a longer glob a shorter one).
 *
 * Fails: a priority pattern with no crawled URL, a priority URL answering other
 * than its `status` (the first response, so a 301 the row expects is not lost to
 * the redirect being followed), and a crawled page whose indexability or
 * canonical disagrees with its pattern. Warns: a crawled URL no pattern covers,
 * a non-priority pattern with no crawled example, and a row with no owner or
 * past its review date.
 */
export const urlInventoryBuilder: SiteProbe = {
  id: 'url-inventory-builder',
  scope: 'site',
  title: 'The crawl agrees with the URL matrix',
  run({ crawl, inputs, origin }) {
    const matrix = inputs?.urlMatrix;
    if (matrix === undefined) return notApplicable('No URL matrix was supplied.');
    const rows = matrix.filter((row) => row.environment === undefined);
    if (rows.length === 0) {
      return notApplicable(
        matrix.length === 0 ? 'The URL matrix section is empty.' : 'Every URL matrix row names an environment.',
      );
    }

    const matchers = rows.map((row) => ({ row, ...matrixMatcher(row.pattern, origin) }));
    const specificity = (entry: (typeof matchers)[number]): number =>
      entry.exact ? Number.MAX_SAFE_INTEGER : entry.row.pattern.replace(/\*/g, '').length;

    const examples = new Map<(typeof matchers)[number], CrawledPage[]>(matchers.map((entry) => [entry, []]));
    const unmatched: string[] = [];
    for (const page of crawl.pages) {
      if (page.fetch.status === null || !isSameSite(page.normalizedUrl, origin)) continue;
      const hits = matchers.filter((entry) => entry.test(page.normalizedUrl));
      if (hits.length === 0) {
        unmatched.push(page.normalizedUrl);
        continue;
      }
      const best = hits.reduce((a, b) => (specificity(b) > specificity(a) ? b : a));
      examples.get(best)?.push(page);
    }

    const failures: string[] = [];
    const warnings: string[] = [];
    for (const [entry, pages] of examples) {
      const { row } = entry;
      if (pages.length === 0) {
        const line = `${row.pattern} was not reached by the crawl`;
        (row.priority === true ? failures : warnings).push(
          row.priority === true ? line : `${row.pattern} has no crawled example`,
        );
        continue;
      }
      for (const page of pages) {
        const url = page.normalizedUrl;
        const first = page.fetch.redirectChain[0]?.status ?? page.fetch.status;
        if (row.priority === true && first !== row.status) {
          failures.push(`${url} answered ${first}, the matrix expects ${row.status}`);
        }
        if (page.extracted === null || page.fetch.status !== 200 || page.fetch.redirectChain.length > 0) continue;
        const noindex = NOINDEX_DIRECTIVE.test(page.extracted.metaRobots ?? '') ||
          NOINDEX_DIRECTIVE.test(page.fetch.headers['x-robots-tag'] ?? '');
        if (row.indexable === noindex) {
          failures.push(`${url} is ${noindex ? 'noindex' : 'indexable'}, the matrix expects ${row.indexable ? 'indexable' : 'noindex'}`);
        }
        const canonical = page.extracted.canonical === null ? null : normalizeUrl(page.extracted.canonical);
        const expected = row.canonical === 'self' ? url : row.canonical === 'none' ? null : normalizeUrl(row.canonical);
        if (canonical !== expected) {
          failures.push(`${url} has canonical ${canonical ?? 'none'}, the matrix expects ${expected ?? 'none'}`);
        }
      }
    }

    const at = crawl.crawledAt ?? null;
    const held = rows.flatMap((row) => {
      const problem = row.owner.trim() === '' ? 'no owner' : at === null ? null : inputRecordProblem(row, new Date(at));
      return problem === null ? [] : [`${row.pattern} (${problem})`];
    });

    const data = {
      rows: rows.length,
      setAside: matrix.length - rows.length,
      failures: failures.slice(0, MATRIX_SAMPLES),
      unmatched: unmatched.slice(0, MATRIX_SAMPLES),
      unmatchedCount: unmatched.length,
      warnings: warnings.slice(0, MATRIX_SAMPLES),
      held,
    };
    if (failures.length > 0) {
      return fail(
        `${failures.length} disagreement(s) with the URL matrix: ${failures.slice(0, 3).join('; ')}.`,
        { ...data, failureCount: failures.length },
      );
    }
    const notes = [
      unmatched.length > 0 ? `${unmatched.length} crawled URL(s) match no pattern` : '',
      warnings.length > 0 ? `${warnings.length} pattern(s) have no crawled example` : '',
      held.length > 0 ? `${held.length} row(s) held for review: ${held.slice(0, 3).join(', ')}` : '',
    ].filter((note) => note !== '');
    if (notes.length > 0) return warn(`${notes.join('; ')}.`, data);
    return pass(`Every crawled URL matches a row of the URL matrix, and every row has a crawled example.`, data);
  },
};

/** How many offending URLs `migration-map-builder` lists in its data. */
const MIGRATION_SAMPLES = 10;

/** A URL as the map's own spelling of it: absolute, normalized, or null when it cannot be one. */
function mapKey(value: string, base: string | undefined): string | null {
  try {
    return normalizeUrl(new URL(value, base).toString());
  } catch {
    return null;
  }
}

export const migrationMapBuilder: SiteProbe = {
  id: 'migration-map-builder',
  scope: 'site',
  title: 'Every old URL has a redirect map entry, and none chains or loops',
  run({ crawl, inputs, origin, previous }) {
    const map = inputs?.redirectMap;
    if (map === undefined) return notApplicable('No redirect map was supplied.');

    const oldOrigin = map.oldOrigin;
    const failures: string[] = [];

    if (map.kind === 'move' && oldOrigin === undefined) {
      failures.push('the map is a move but names no oldOrigin');
    }

    // Every entry, keyed by the absolute old URL it is for.
    const base = oldOrigin ?? previous?.origin;
    const mapped = new Map<string, string | null>();
    for (const entry of map.entries) {
      const from = mapKey(entry.from, base);
      if (from === null) {
        failures.push(`${entry.from} is not an address the map can resolve`);
        continue;
      }
      mapped.set(from, entry.to === undefined ? null : mapKey(entry.to, origin));
    }

    // A chain is a target that is itself mapped; a loop is a chain that comes back.
    const chains: string[] = [];
    const loops: string[] = [];
    for (const [from, to] of mapped) {
      if (to === null) continue;
      if (!mapped.has(to)) continue;
      const seen = new Set([from]);
      let at: string | null | undefined = to;
      let looped = false;
      while (at !== null && at !== undefined) {
        if (seen.has(at)) {
          looped = true;
          break;
        }
        seen.add(at);
        at = mapped.get(at);
      }
      (looped ? loops : chains).push(`${from} -> ${to}`);
    }
    if (loops.length > 0) failures.push(`${loops.length} entr${loops.length === 1 ? 'y loops' : 'ies loop'} back: ${loops.slice(0, 3).join('; ')}`);
    if (chains.length > 0) failures.push(`${chains.length} entr${chains.length === 1 ? 'y targets' : 'ies target'} a URL that is itself mapped: ${chains.slice(0, 3).join('; ')}`);

    // Old URLs: what the previous audit reached, and what the old origin's sitemap listed.
    const unmapped: string[] = [];
    if (map.kind === 'move') {
      const old = new Set<string>();
      for (const page of previous?.pages ?? []) if (page.status === 200) old.add(page.url);
      if (oldOrigin !== undefined) {
        for (const url of crawl.sitemapUrls) {
          const key = mapKey(url, undefined);
          if (key !== null && new URL(key).origin === oldOrigin) old.add(key);
        }
      }
      for (const url of old) if (!mapped.has(url)) unmapped.push(url);
      if (unmapped.length > 0) {
        failures.push(`${unmapped.length} old URL(s) have no map entry: ${unmapped.slice(0, 3).join(', ')}`);
      }
    }

    const at = crawl.crawledAt ?? null;
    const problem = map.owner.trim() === '' ? 'no owner' : at === null ? null : inputRecordProblem(map, new Date(at));

    const data = {
      kind: map.kind,
      entries: map.entries.length,
      unmapped: unmapped.slice(0, MIGRATION_SAMPLES),
      unmappedCount: unmapped.length,
      chains: chains.slice(0, MIGRATION_SAMPLES),
      loops: loops.slice(0, MIGRATION_SAMPLES),
    };
    if (failures.length > 0) return fail(`${failures.join('; ')}.`, data);
    if (problem !== null) return warn(`The redirect map is held for review (${problem}).`, data);
    if (map.kind === 'history-only') return pass('The site keeps its history only, so no redirect map entries are needed.', data);
    return pass(`Every old URL known to the audit has a map entry, and none chains or loops (${map.entries.length} entries).`, data);
  },
};

export const inheritedDomainHistory: SiteProbe = {
  id: 'inherited-domain-history',
  scope: 'site',
  title: 'The history of an inherited domain was checked for manual actions and archived content, and nothing blocking is open',
  run({ crawl, inputs }) {
    const history = inputs?.domainHistory;
    if (history === undefined) return notApplicable('No domain history was supplied.');

    const failures: string[] = [];
    const open = history.blockingIssues.filter((item) => !item.resolved).map((item) => item.issue);
    if (open.length > 0) failures.push(`${open.length} blocking issue(s) unresolved: ${open.slice(0, 3).join('; ')}`);

    const missing: string[] = [];
    for (const required of DOMAIN_HISTORY_REQUIRED_CHECKS) {
      const found = history.checks.some((check) => required.words.some((word) => check.name.toLowerCase().includes(word)));
      if (!found) missing.push(required.label);
    }
    if (missing.length > 0) failures.push(`no ${missing.join(' or ')} check is recorded`);

    const at = crawl.crawledAt ?? null;
    const problem = history.owner.trim() === '' ? 'no owner' : at === null ? null : inputRecordProblem(history, new Date(at));

    const data = {
      checks: history.checks.map((check) => check.name),
      blockingIssues: history.blockingIssues.length,
      unresolved: open,
      missingChecks: missing,
    };
    if (failures.length > 0) return fail(`${failures.join('; ')}.`, data);
    if (problem !== null) return warn(`The domain history is held for review (${problem}).`, data);
    return pass(`The domain history has a manual-action and an archive check, and every blocking issue is resolved (${history.blockingIssues.length} recorded).`, data);
  },
};

/** Whether a Search Console property's address covers every page of `origin`; null when it cannot be read. */
function propertyCovers(type: 'domain' | 'url-prefix', url: string, origin: string): boolean | null {
  try {
    const site = new URL(origin);
    if (type === 'domain') {
      const domain = url.trim().replace(/^sc-domain:/i, '').replace(/\.$/, '').toLowerCase();
      if (domain === '' || /[/:\s]/.test(domain)) return null;
      return site.hostname === domain || site.hostname.endsWith(`.${domain}`);
    }
    const prefix = new URL(url);
    return prefix.protocol === site.protocol && prefix.host === site.host && (prefix.pathname === '/' || prefix.pathname === '');
  } catch {
    return null;
  }
}

export const gscPropertyOwnership: SiteProbe = {
  id: 'gsc-property-ownership',
  scope: 'site',
  title: 'A Search Console property covers the site, with more than one verified owner',
  run({ crawl, inputs, origin }) {
    const record = inputs?.searchConsole;
    if (record === undefined) return notApplicable('No Search Console export was supplied.');

    const at = crawl.crawledAt ?? null;
    const problem = record.owner.trim() === '' ? 'no owner' : at === null ? null : inputRecordProblem(record, new Date(at));
    const property = record.property;
    if (property === undefined) {
      return warn('The Search Console export names no property, so setup is pending.', { property: null });
    }

    const failures: string[] = [];
    const covers = propertyCovers(property.type, property.url, origin);
    if (covers === false) failures.push(`the ${property.type} property ${property.url} does not cover ${origin}`);
    if (covers === null) failures.push(`the property address ${property.url} cannot be read as a ${property.type} property`);
    const owners = new Set(property.owners.map((owner) => owner.email.trim().toLowerCase()));
    if (owners.size === 0) failures.push('the property has no verified owner');

    const data = { type: property.type, url: property.url, owners: owners.size, covers };
    if (failures.length > 0) return fail(`${failures.join('; ')}.`, data);
    if (problem !== null) return warn(`The Search Console record is held for review (${problem}).`, data);
    if (owners.size === 1) return warn('The property has a single verified owner; a second keeps access if that person leaves.', data);
    return pass(`The ${property.type} property ${property.url} covers ${origin} with ${owners.size} verified owners.`, data);
  },
};

/** A sitemap address as the crawl and the Sitemaps report would both spell it. */
function sitemapKey(url: string): string {
  return normalizeUrl(url) ?? url;
}

export const sitemapSubmit: SiteProbe = {
  id: 'sitemap-submit',
  scope: 'site',
  title: 'Every sitemap the crawl found is submitted to Search Console without errors',
  run({ crawl, inputs }) {
    const record = inputs?.searchConsole;
    if (record === undefined) return notApplicable('No Search Console export was supplied.');

    // A file that did not answer is sitemap-validity's finding, not a submission question.
    const found = [...new Set(crawl.sitemaps.filter((doc) => doc.status !== null && doc.status < 400).map((doc) => doc.url))];
    if (found.length === 0) return notApplicable('The crawl found no sitemap to submit.');

    // A record with no sitemaps report is account access that was not available: held, never failed.
    if (record.sitemaps === undefined) {
      return warn('The Search Console export holds no Sitemaps report, so submission is unverified.', { found: found.length });
    }

    const reported = new Map(record.sitemaps.map((row) => [sitemapKey(row.url), row]));
    const withErrors: string[] = [];
    const unreadable: string[] = [];
    const pending: string[] = [];
    for (const url of found) {
      const row = reported.get(sitemapKey(url));
      if (row === undefined) pending.push(url);
      else if (row.errors > 0 || /\berrors?\b/i.test(row.status)) withErrors.push(url);
      else if (/couldn.?t fetch|fail/i.test(row.status)) unreadable.push(url);
    }

    const at = crawl.crawledAt ?? null;
    const problem = record.owner.trim() === '' ? 'no owner' : at === null ? null : inputRecordProblem(record, new Date(at));
    const data = {
      found: found.length,
      withErrors: withErrors.slice(0, 10),
      unreadable: unreadable.slice(0, 10),
      pending: pending.slice(0, 10),
    };
    if (withErrors.length > 0) {
      return fail(`Search Console reports errors on ${withErrors.length} of ${found.length} sitemap(s): ${withErrors.slice(0, 3).join(', ')}.`, data);
    }
    if (pending.length > 0) {
      return warn(`${pending.length} of ${found.length} sitemap(s) the crawl found have no submission record, so submission is pending.`, data);
    }
    if (unreadable.length > 0) {
      return warn(`Search Console could not fetch ${unreadable.length} sitemap(s): ${unreadable.slice(0, 3).join(', ')}.`, data);
    }
    if (problem !== null) return warn(`The Search Console record is held for review (${problem}).`, data);
    return pass(`All ${found.length} sitemap(s) the crawl found are submitted to Search Console without errors.`, data);
  },
};

const STALE_EXPORT_DAYS = 30;

export const securityManualActions: SiteProbe = {
  id: 'security-manual-actions',
  scope: 'site',
  title: 'Search Console reports no open manual action or security issue',
  run({ crawl, inputs }) {
    const record = inputs?.searchConsole;
    if (record === undefined) return notApplicable('No Search Console export was supplied.');

    const actions = record.manualActions;
    const issues = record.securityIssues;
    const data = {
      manualActions: (actions ?? []).slice(0, 10).map((action) => `${action.type} (${action.scope})`),
      securityIssues: (issues ?? []).slice(0, 10).map((issue) => issue.type),
    };

    // Any open finding is a failure however old the export is: it can only have been resolved since.
    const open = (actions?.length ?? 0) + (issues?.length ?? 0);
    if (open > 0) {
      const named = [...data.manualActions, ...data.securityIssues].slice(0, 3).join(', ');
      return fail(`Search Console reports ${actions?.length ?? 0} manual action(s) and ${issues?.length ?? 0} security issue(s): ${named}.`, data);
    }
    if (actions === undefined || issues === undefined) {
      const absent = [actions === undefined ? 'Manual actions' : null, issues === undefined ? 'Security issues' : null].filter((x) => x !== null).join(' and ');
      return warn(`The Search Console export holds no ${absent} report, so it is unverified.`, data);
    }

    const at = crawl.crawledAt ?? null;
    if (at !== null) {
      const recorded = Date.parse(record.recordedAt);
      const age = (new Date(at).getTime() - recorded) / 86_400_000;
      if (Number.isFinite(age) && age > STALE_EXPORT_DAYS) {
        return warn(`The Search Console export was recorded ${Math.floor(age)} days before the crawl, so it may not show what is open now.`, { ...data, ageDays: Math.floor(age) });
      }
    }
    const problem = record.owner.trim() === '' ? 'no owner' : at === null ? null : inputRecordProblem(record, new Date(at));
    if (problem !== null) return warn(`The Search Console record is held for review (${problem}).`, data);
    return pass('The Search Console export shows no manual action and no security issue.', data);
  },
};

/**
 * Each metric's total per period, periods in the order the export first names
 * them (oldest first). Fewer than two periods leaves nothing to compare.
 */
function performancePeriods(rows: readonly { clicks: number; impressions: number; period: string; query?: string }[]): Map<string, { clicks: number; impressions: number }> {
  const totals = new Map<string, { clicks: number; impressions: number }>();
  for (const row of rows) {
    const total = totals.get(row.period) ?? { clicks: 0, impressions: 0 };
    total.clicks += row.clicks;
    total.impressions += row.impressions;
    totals.set(row.period, total);
  }
  return totals;
}

export const reportingAnomalyThresholds: SiteProbe = {
  id: 'reporting-anomaly-thresholds',
  scope: 'site',
  title: 'Every alert threshold the performance data crosses has an anomaly entry with a disposition',
  run({ crawl, inputs }) {
    const record = inputs?.reporting;
    if (record === undefined) return notApplicable('No reporting record was supplied.');

    const unanswered = record.anomalies.filter((anomaly) => anomaly.disposition === '').map((anomaly) => anomaly.metric);
    const data: Record<string, unknown> = {
      rhythm: record.rhythm,
      thresholds: record.thresholds.length,
      anomalies: record.anomalies.length,
      unanswered: unanswered.slice(0, 10),
    };

    // Which thresholds the export can speak to: Search Console is Google's, and needs two periods to show a change.
    const unmeasured: string[] = [];
    const crossed: string[] = [];
    const unlogged: string[] = [];
    const periods = performancePeriods(inputs?.searchConsole?.performance ?? []);
    const names = [...periods.keys()];
    const previous = names.length >= 2 ? periods.get(names[names.length - 2] as string) : undefined;
    const current = names.length >= 2 ? periods.get(names[names.length - 1] as string) : undefined;
    for (const threshold of record.thresholds) {
      const label = `${threshold.engine} ${threshold.metric} ${threshold.change > 0 ? '+' : ''}${Math.round(threshold.change * 100)}%`;
      const metric = threshold.metric === 'clicks' || threshold.metric === 'impressions' ? threshold.metric : null;
      if (metric === null || !(REPORTING_MEASURED_ENGINES as readonly string[]).includes(threshold.engine) || previous === undefined || current === undefined) {
        unmeasured.push(label);
        continue;
      }
      if (previous[metric] === 0) {
        unmeasured.push(label);
        continue;
      }
      const moved = (current[metric] - previous[metric]) / previous[metric];
      const beyond = threshold.change < 0 ? moved <= threshold.change : moved >= threshold.change;
      if (!beyond) continue;
      crossed.push(`${label} (${moved > 0 ? '+' : ''}${Math.round(moved * 100)}%)`);
      if (!record.anomalies.some((anomaly) => anomaly.metric === threshold.metric)) unlogged.push(label);
    }
    data['crossed'] = crossed.slice(0, 10);
    data['unmeasured'] = unmeasured.slice(0, 10);

    const failures: string[] = [];
    if (unlogged.length > 0) failures.push(`${unlogged.length} threshold(s) the performance data crosses have no anomaly entry: ${unlogged.slice(0, 3).join(', ')}`);
    if (unanswered.length > 0) failures.push(`${unanswered.length} anomaly entr${unanswered.length === 1 ? 'y has' : 'ies have'} no disposition: ${unanswered.slice(0, 3).join(', ')}`);
    if (failures.length > 0) return fail(`${failures.join('; ')}.`, data);

    if (record.thresholds.length === 0) return warn('The reporting record defines no alert thresholds, so nothing can be crossed.', data);
    if (unmeasured.length > 0) {
      return warn(`${unmeasured.length} of ${record.thresholds.length} threshold(s) could not be measured from the supplied performance data: ${unmeasured.slice(0, 3).join(', ')}.`, data);
    }
    const at = crawl.crawledAt ?? null;
    const problem = record.owner.trim() === '' ? 'no owner' : at === null ? null : inputRecordProblem(record, new Date(at));
    if (problem !== null) return warn(`The reporting record is held for review (${problem}).`, data);
    if (record.rhythm === '') return warn('The reporting record names no rhythm.', data);
    return pass(`${record.thresholds.length} threshold(s) checked against the performance data; none is crossed without an answered anomaly entry.`, data);
  },
};

export const backlinkMonitor: SiteProbe = {
  id: 'backlink-monitor',
  scope: 'site',
  title: 'A disavow submission states its reasons and the removal attempts made first',
  run({ crawl, inputs }) {
    const record = inputs?.disavow;
    if (record === undefined) return notApplicable('No disavow record was supplied.');

    const data = { submitted: record.submitted, reasons: record.reasons.length, removalAttempts: record.removalAttempts.length };
    // With no submission there is nothing to justify.
    if (!record.submitted) return pass('No disavow file was submitted, so no reasons or removal attempts are owed.', data);

    const missing = [record.reasons.length === 0 ? 'reasons' : null, record.removalAttempts.length === 0 ? 'removal attempts' : null].filter((x) => x !== null);
    if (missing.length > 0) return fail(`A disavow file was submitted with no ${missing.join(' and no ')} on record.`, data);

    const at = crawl.crawledAt ?? null;
    const problem = record.owner.trim() === '' ? 'no owner' : at === null ? null : inputRecordProblem(record, new Date(at));
    if (problem !== null) return warn(`The disavow record is held for review (${problem}).`, data);
    return pass(`The disavow submission records ${record.reasons.length} reason(s) and ${record.removalAttempts.length} removal attempt(s).`, data);
  },
};

export const bingOnboarding: SiteProbe = {
  id: 'bing-onboarding',
  scope: 'site',
  title: 'The site is a verified Bing Webmaster property and its sitemaps reached Bing',
  run({ crawl, inputs }) {
    const record = inputs?.bingWebmaster;
    if (record === undefined) return notApplicable('No Bing Webmaster export was supplied.');

    const property = record.property;
    const found = [...new Set(crawl.sitemaps.filter((doc) => doc.status !== null && doc.status < 400).map((doc) => doc.url))];
    const reported = new Map((record.sitemaps ?? []).map((row) => [sitemapKey(row.url), row]));
    const failed: string[] = [];
    const missing: string[] = [];
    for (const url of found) {
      const row = reported.get(sitemapKey(url));
      if (row === undefined) missing.push(url);
    }
    for (const row of record.sitemaps ?? []) {
      if (/\b(error|errors|failed|fail)\b|couldn.?t fetch/i.test(row.status)) failed.push(row.url);
    }
    const data = {
      verified: property?.verified ?? null,
      found: found.length,
      submitted: record.sitemaps?.length ?? null,
      failed: failed.slice(0, 10),
      missing: missing.slice(0, 10),
    };

    if (property !== undefined && !property.verified) {
      return fail(`The Bing Webmaster property ${property.url} is not verified.`, data);
    }
    if (failed.length > 0) {
      return fail(`Bing reports ${failed.length} submitted sitemap(s) as failed: ${failed.slice(0, 3).join(', ')}.`, data);
    }
    // Missing subsections are access that was not available: held, never failed.
    if (property === undefined) return warn('The Bing Webmaster export holds no property, so verification is unconfirmed.', data);
    if (record.sitemaps === undefined && found.length > 0) {
      return warn('The Bing Webmaster export holds no Sitemaps report, so submission is unverified.', data);
    }
    if (missing.length > 0) {
      return warn(`${missing.length} of ${found.length} sitemap(s) the crawl found have not been received by Bing: ${missing.slice(0, 3).join(', ')}.`, data);
    }
    const at = crawl.crawledAt ?? null;
    const problem = record.owner.trim() === '' ? 'no owner' : at === null ? null : inputRecordProblem(record, new Date(at));
    if (problem !== null) return warn(`The Bing Webmaster record is held for review (${problem}).`, data);
    return pass(`The Bing Webmaster property is verified and all ${found.length} sitemap(s) the crawl found reached Bing.`, data);
  },
};

const AI_ENGINE_NAMES = /\b(google|gemini|bing|copilot|chatgpt|openai|perplexity|claude|anthropic|meta ai|grok)\b/gi;
const COMBINED_WORDS = /\b(combined|blended|composite|aggregate[d]?|unified|all engines|all ai|cross-engine|overall|total)\b|\bscore\b/i;
const PERIOD_START = /^\s*(\d{4}-\d{2}-\d{2})\s*(?:\/|to\b|–|--?|$)/;

export const aiVisibilityBaseline: SiteProbe = {
  id: 'ai-visibility-baseline',
  scope: 'site',
  title: 'The AI visibility baseline is per engine and claims no history its tools did not record',
  run({ crawl, inputs }) {
    const record = inputs?.aiBaseline;
    if (record === undefined) return notApplicable('No AI visibility baseline was supplied.');

    const invented: string[] = [];
    const combined: string[] = [];
    const unreadable: string[] = [];
    for (const row of record.reports) {
      const start = PERIOD_START.exec(row.period)?.[1];
      const startMs = start === undefined ? Number.NaN : Date.parse(`${start}T00:00:00Z`);
      if (Number.isNaN(startMs)) unreadable.push(row.report);
      else if (startMs < Date.parse(`${row.availableFrom.slice(0, 10)}T00:00:00Z`)) {
        invented.push(`${row.report} (${row.period} starts before ${row.availableFrom.slice(0, 10)})`);
      }
      const engines = new Set((row.scope.match(AI_ENGINE_NAMES) ?? []).map((name) => name.toLowerCase()));
      if (COMBINED_WORDS.test(row.metric) || COMBINED_WORDS.test(row.scope) || engines.size > 1) combined.push(row.report);
    }
    const data = { reports: record.reports.length, invented: invented.slice(0, 10), combined: combined.slice(0, 10), unreadable: unreadable.slice(0, 10) };

    if (invented.length > 0) return fail(`${invented.length} report(s) claim history before the tool recorded it: ${invented.slice(0, 3).join('; ')}.`, data);
    if (combined.length > 0) return fail(`${combined.length} report(s) combine engines into one score: ${combined.slice(0, 3).join(', ')}.`, data);
    if (record.reports.length === 0) return warn('The AI visibility baseline lists no reports.', data);
    if (unreadable.length > 0) return warn(`The period of ${unreadable.length} report(s) is not a date range, so its history cannot be checked: ${unreadable.slice(0, 3).join(', ')}.`, data);
    const at = crawl.crawledAt ?? null;
    const problem = record.owner.trim() === '' ? 'no owner' : at === null ? null : inputRecordProblem(record, new Date(at));
    if (problem !== null) return warn(`The AI visibility baseline is held for review (${problem}).`, data);
    return pass(`All ${record.reports.length} baseline report(s) are per engine and start no earlier than their tool recorded.`, data);
  },
};

const RECONCILIATION_FAIL_GAP = 0.1;
const RECONCILIATION_WARN_GAP = 0.05;

/** The gap between two figures as a share of the larger one; 0 when both are 0. */
function figureGap(a: number, b: number): number {
  const larger = Math.max(a, b);
  return larger === 0 ? 0 : Math.abs(a - b) / larger;
}

export const analyticsReconciliation: SiteProbe = {
  id: 'analytics-reconciliation',
  scope: 'site',
  title: 'Analytics figures agree with a second source, or the gap is explained',
  run({ crawl, inputs }) {
    const record = inputs?.analytics;
    if (record === undefined || record.reported.length === 0) return notApplicable('No reported analytics figures were supplied to reconcile.');

    const describe = (row: (typeof record.reported)[number], gap: number): string =>
      `${row.metric} ${row.period}: ${row.sourceA.name} ${row.sourceA.value} vs ${row.sourceB.name} ${row.sourceB.value} (${(gap * 100).toFixed(1)}% apart)`;
    const unexplained: string[] = [];
    const drifting: string[] = [];
    for (const row of record.reported) {
      const gap = figureGap(row.sourceA.value, row.sourceB.value);
      if (gap > RECONCILIATION_FAIL_GAP && row.explanation === undefined) unexplained.push(describe(row, gap));
      else if (gap > RECONCILIATION_WARN_GAP) drifting.push(describe(row, gap));
    }
    const data = { pairs: record.reported.length, unexplained: unexplained.slice(0, 10), drifting: drifting.slice(0, 10) };

    if (unexplained.length > 0) {
      return fail(`${unexplained.length} reported pair(s) are more than 10% apart with no explanation: ${unexplained.slice(0, 3).join('; ')}.`, data);
    }
    if (drifting.length > 0) {
      return warn(`${drifting.length} reported pair(s) are more than 5% apart: ${drifting.slice(0, 3).join('; ')}.`, data);
    }
    const at = crawl.crawledAt ?? null;
    const problem = record.owner.trim() === '' ? 'no owner' : at === null ? null : inputRecordProblem(record, new Date(at));
    if (problem !== null) return warn(`The analytics record is held for review (${problem}).`, data);
    return pass(`All ${record.reported.length} reported pair(s) agree within 5%.`, data);
  },
};

const LOG_CRAWLER = /googlebot|bingbot/i;
const LOG_5XX_FAIL_RATE = 0.01;
const LOG_PARAMETER_WARN_SHARE = 0.25;

export const logFileAnalysis: SiteProbe = {
  id: 'log-file-analysis',
  scope: 'site',
  title: 'Search crawlers meet few server errors, stay out of disallowed URLs and are not spent on parameters',
  run({ crawl, origin, inputs }) {
    const record = inputs?.serverLogs;
    if (record === undefined) return notApplicable('No server log was supplied.');
    if (record.hits === undefined) return notApplicable('The server log was named but not read, so it holds no hits.');

    // The user agent is a claim: nothing here verifies the address it came from.
    const hits = record.hits.filter((hit) => LOG_CRAWLER.test(hit.userAgent));
    if (hits.length === 0) return notApplicable('The server log holds no hits whose user agent claims Googlebot or Bingbot.');

    const errors = hits.filter((hit) => hit.status >= 500 && hit.status <= 599);
    const errorRate = errors.length / hits.length;
    const blocked = hits.filter((hit) => {
      const agent = /googlebot/i.test(hit.userAgent) ? 'Googlebot' : 'Bingbot';
      return !isAllowed(crawl.robots, agent, new URL(hit.path, origin).toString());
    });
    const disallowedPaths = [...new Set(blocked.map((hit) => hit.path))].slice(0, 10);
    const parameterised = hits.filter((hit) => hit.parameterised === true);
    const share = parameterised.length / hits.length;
    const data = {
      claimedCrawlerHits: hits.length,
      verified: false,
      skippedLines: record.skippedLines ?? 0,
      errors: errors.length,
      errorRate,
      disallowedHits: blocked.length,
      disallowedPaths,
      parameterHits: parameterised.length,
      parameterShare: share,
    };
    const claim = 'user agents claiming Googlebot or Bingbot, unverified';

    if (errorRate > LOG_5XX_FAIL_RATE) {
      return fail(`${errors.length} of ${hits.length} hits from ${claim}, got a 5xx (${(errorRate * 100).toFixed(1)}%, over 1%).`, data);
    }
    if (blocked.length > 0) {
      return fail(`${blocked.length} hit(s) from ${claim}, reached URLs robots.txt disallows: ${disallowedPaths.slice(0, 3).join(', ')}.`, data);
    }
    if (share > LOG_PARAMETER_WARN_SHARE) {
      return warn(`Parameter URLs take ${(share * 100).toFixed(0)}% of ${hits.length} hits from ${claim}, over a quarter.`, data);
    }
    const at = crawl.crawledAt ?? null;
    const problem = record.owner.trim() === '' ? 'no owner' : at === null ? null : inputRecordProblem(record, new Date(at));
    if (problem !== null) return warn(`The server log record is held for review (${problem}).`, data);
    return pass(`${hits.length} hit(s) from ${claim}: 5xx under 1%, none on disallowed URLs, parameter URLs under a quarter.`, data);
  },
};

/** A competitor entry (a URL or a bare host) reduced to its host, without `www.`. */
const competitorHost = (entry: string): string | null => {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(entry) ? entry : `https://${entry}`).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
};

/**
 * 0.1 asks who the site is measured against. The baseline is supplied
 * (`competitorBaseline`: audience, market, language, competitors, baselineAt);
 * the crawl can only say whether it is whole and whether a "competitor" is the
 * site itself. Fails a blank field, no competitors, and a competitor on the
 * site's own host (`www.` ignored). Otherwise records the rules, holding for
 * review on an unowned or overdue record: whether these are the right
 * competitors is a person's call. Without the section, `not-applicable`.
 */
export const competitorSerpBaseline: SiteProbe = {
  id: 'competitor-serp-baseline',
  scope: 'site',
  title: 'The competitor baseline names an audience, market, language, date and competitors other than the site',
  run({ crawl, inputs, origin }) {
    const record = inputs?.competitorBaseline;
    if (record === undefined) return notApplicable('No competitor baseline was supplied.');

    const missing: string[] = [];
    if (record.audience === '') missing.push('audience');
    if (record.market === '') missing.push('market');
    if (record.language === '') missing.push('language');
    if (record.competitors.length === 0) missing.push('competitors');
    if (record.baselineAt === '') missing.push('baselineAt');

    let own: string;
    try {
      own = new URL(origin).hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
      return errored(`The site origin is not a URL: ${origin}.`);
    }
    const ownHost = record.competitors.filter((entry) => competitorHost(entry) === own);

    const at = crawl.crawledAt ?? null;
    const problem = record.owner.trim() === '' ? 'no owner' : at === null ? null : inputRecordProblem(record, new Date(at));
    const data = {
      audience: record.audience,
      market: record.market,
      language: record.language,
      competitors: record.competitors.length,
      baselineAt: record.baselineAt === '' ? null : record.baselineAt,
      missing,
      ownHost,
    };
    const failures: string[] = [];
    if (missing.length > 0) failures.push(`The competitor baseline is missing ${missing.join(', ')}`);
    if (ownHost.length > 0) failures.push(`${ownHost.length} listed competitor(s) are on the site's own host (${ownHost.slice(0, 3).join(', ')})`);
    if (failures.length > 0) return fail(`${failures.join('; ')}.`, data);
    if (problem !== null) return warn(`The competitor baseline is held for review (${problem}).`, data);
    return pass(`The baseline names ${record.competitors.length} competitor(s) for ${record.audience} in ${record.market} (${record.language}), captured ${record.baselineAt}. A person still confirms they are the right ones.`, data);
  },
};

/** IndexNow's own ceiling: one URL is not worth submitting more often than this in a day. */
const INDEXNOW_MAX_PER_DAY = 5;

const bareHost = (url: string): string | null => {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
};

/**
 * 2.10 asks whether IndexNow is set up and used properly. The key and the
 * submission log are supplied (`indexNow`); the crawl fetched the key file once
 * (`indexnow-key` auxiliary). Fails a key file that is missing or does not hold
 * the key, a logged URL on another host (`www.` ignored), and one URL sent more
 * than five times in a UTC day. A crawl that did not request the file holds the
 * check. Without the section, `not-applicable`.
 */
export const indexnowIntegration: SiteProbe = {
  id: 'indexnow-integration',
  scope: 'site',
  title: 'The IndexNow key file holds the key and submissions stay on the host, at most five a day per URL',
  run({ crawl, inputs, origin }) {
    const record = inputs?.indexNow;
    if (record === undefined) return notApplicable('No IndexNow record was supplied.');

    const own = bareHost(origin);
    if (own === null) return errored(`The site origin is not a URL: ${origin}.`);
    const keyUrl = indexNowKeyUrl(record, origin);
    const aside = crawl.auxiliary.find((entry) => entry.reason === 'indexnow-key');

    const foreign = [...new Set(record.log.filter((entry) => bareHost(entry.url) !== own).map((entry) => entry.url))];
    const perDay = new Map<string, number>();
    for (const entry of record.log) {
      const key = `${entry.sentAt.slice(0, 10)} ${entry.url}`;
      perDay.set(key, (perDay.get(key) ?? 0) + 1);
    }
    const repeated = [...perDay].filter(([, count]) => count > INDEXNOW_MAX_PER_DAY).map(([key, count]) => `${key.slice(11)} on ${key.slice(0, 10)} (${count}x)`);

    let keyFile: 'holds-key' | 'wrong-content' | 'missing' | 'not-requested';
    let seen: string | null = null;
    if (aside === undefined) keyFile = 'not-requested';
    else if (aside.fetch.error !== null || aside.fetch.status === null || aside.fetch.status >= 400) keyFile = 'missing';
    else {
      seen = (aside.fetch.body !== '' ? aside.fetch.body : aside.fetch.bytes === undefined ? '' : new TextDecoder().decode(aside.fetch.bytes)).trim();
      keyFile = seen === record.key ? 'holds-key' : 'wrong-content';
    }

    const data = {
      keyUrl: keyUrl ?? null,
      keyFile,
      status: aside?.fetch.status ?? null,
      logged: record.log.length,
      foreign: foreign.slice(0, 10),
      repeated: repeated.slice(0, 10),
    };
    const failures: string[] = [];
    if (keyFile === 'missing') failures.push(`The IndexNow key file ${keyUrl} did not answer (${aside?.fetch.status ?? aside?.fetch.error})`);
    if (keyFile === 'wrong-content') failures.push(`The IndexNow key file ${keyUrl} does not hold the key`);
    if (foreign.length > 0) failures.push(`${foreign.length} logged URL(s) are on another host (${foreign.slice(0, 3).join(', ')})`);
    if (repeated.length > 0) failures.push(`${repeated.length} URL(s) were sent more than ${INDEXNOW_MAX_PER_DAY} times in a day (${repeated.slice(0, 3).join(', ')})`);
    if (failures.length > 0) return fail(`${failures.join('; ')}.`, data);
    if (keyFile === 'not-requested') return warn('The crawl did not request the IndexNow key file, so it is unverified.', data);

    const at = crawl.crawledAt ?? null;
    const problem = record.owner.trim() === '' ? 'no owner' : at === null ? null : inputRecordProblem(record, new Date(at));
    if (problem !== null) return warn(`The IndexNow record is held for review (${problem}).`, data);
    return pass(`The IndexNow key file holds the key and ${record.log.length} logged submission(s) stay on ${own}, none repeated more than ${INDEXNOW_MAX_PER_DAY} times a day.`, data);
  },
};

const DAY_MS = 86_400_000;

/**
 * 7.1 asks whether incidents have an owner and a fix and whether alerting is
 * still proven to work. The incident log and the test-alert interval are
 * supplied (`incidents`); the last test alert is read from `canary`. Fails an
 * incident with no owner or remediation, and a test alert older than the
 * interval, measured at the crawl's time. No test alert on record holds the
 * check. Without the section, `not-applicable`.
 */
export const monitoringIncidentSla: SiteProbe = {
  id: 'monitoring-incident-sla',
  scope: 'site',
  title: 'Every incident has an owner and a remediation, and the last test alert is within its interval',
  run({ crawl, inputs }) {
    const record = inputs?.incidents;
    if (record === undefined) return notApplicable('No incidents record was supplied.');

    const at = crawl.crawledAt ?? null;
    const unowned = record.entries.filter((entry) => entry.owner === '').map((entry) => entry.openedAt);
    const unremediated = record.entries.filter((entry) => entry.remediation === '').map((entry) => entry.openedAt);
    const lastTest = inputs?.canary?.lastTestAlertAt ?? null;
    const ageDays = lastTest === null || at === null ? null : (Date.parse(at) - Date.parse(lastTest)) / DAY_MS;
    const stale = ageDays !== null && ageDays > record.testAlertIntervalDays;

    const data = {
      incidents: record.entries.length,
      open: record.entries.filter((entry) => entry.closedAt === undefined).length,
      unowned: unowned.slice(0, 10),
      unremediated: unremediated.slice(0, 10),
      testAlertIntervalDays: record.testAlertIntervalDays,
      lastTestAlertAt: lastTest,
      testAlertAgeDays: ageDays === null ? null : Math.floor(ageDays),
    };
    const failures: string[] = [];
    if (unowned.length > 0) failures.push(`${unowned.length} incident(s) have no owner (opened ${unowned.slice(0, 3).join(', ')})`);
    if (unremediated.length > 0) failures.push(`${unremediated.length} incident(s) have no remediation (opened ${unremediated.slice(0, 3).join(', ')})`);
    if (stale) failures.push(`The last test alert (${lastTest}) is ${Math.floor(ageDays)} days old, past the ${record.testAlertIntervalDays}-day interval`);
    if (failures.length > 0) return fail(`${failures.join('; ')}.`, data);
    if (lastTest === null) return warn('No test alert is on record (canary.lastTestAlertAt), so alerting is unproven.', data);

    const problem = record.owner.trim() === '' ? 'no owner' : at === null ? null : inputRecordProblem(record, new Date(at));
    if (problem !== null) return warn(`The incidents record is held for review (${problem}).`, data);
    return pass(`${record.entries.length} incident(s) all have an owner and a remediation, and the last test alert is within ${record.testAlertIntervalDays} days.`, data);
  },
};

/**
 * 7.6 asks whether off-page reputation is governed: each review destination
 * has a policy date, an owner and a recheck date that has not lapsed. The list
 * is supplied (`reviewDestinations`); a destination past `recheckAt`, measured
 * at the crawl's time, fails. A destination with no owner, or no destination
 * listed, holds the check. Self-serving review markup is `review-integrity`'s
 * (3.13) and is not read here. Without the section, `not-applicable`.
 */
export const offpageReputationGovernance: SiteProbe = {
  id: 'offpage-reputation-governance',
  scope: 'site',
  title: 'Every review destination has an owner and a recheck that has not lapsed',
  run({ crawl, inputs }) {
    const record = inputs?.reviewDestinations;
    if (record === undefined) return notApplicable('No reviewDestinations record was supplied.');

    const at = crawl.crawledAt ?? null;
    const overdue = at === null ? [] : record.destinations.filter((entry) => Date.parse(entry.recheckAt) < Date.parse(at));
    const unowned = record.destinations.filter((entry) => entry.owner === '');
    const data = {
      destinations: record.destinations.length,
      overdue: overdue.slice(0, 10).map((entry) => ({ destination: entry.destination, recheckAt: entry.recheckAt })),
      unowned: unowned.slice(0, 10).map((entry) => entry.destination),
    };
    if (overdue.length > 0) {
      const names = overdue.slice(0, 3).map((entry) => `${entry.destination} (due ${entry.recheckAt})`).join(', ');
      return fail(`${overdue.length} review destination(s) are past their recheck date: ${names}.`, data);
    }
    if (record.destinations.length === 0) return warn('The reviewDestinations record lists no destination.', data);
    if (unowned.length > 0) return warn(`${unowned.length} review destination(s) have no owner (${unowned.slice(0, 3).map((entry) => entry.destination).join(', ')}).`, data);

    const problem = record.owner.trim() === '' ? 'no owner' : at === null ? null : inputRecordProblem(record, new Date(at));
    if (problem !== null) return warn(`The reviewDestinations record is held for review (${problem}).`, data);
    return pass(`${record.destinations.length} review destination(s) all have an owner and a recheck date still ahead.`, data);
  },
};

/**
 * 7.5 asks whether digital PR is planned, owned and earns its links. The plan
 * and the wins are supplied (`digitalPr`). Fails a win marked paid (a paid link
 * is a link scheme) and a plan with no owner. No win yet, or an overdue record,
 * holds the check; whether the wins are good coverage is a person's call.
 * Without the section, `not-applicable`.
 */
export const digitalPrTracking: SiteProbe = {
  id: 'digital-pr-tracking',
  scope: 'site',
  title: 'The digital PR plan has an owner and none of its recorded wins is a paid link',
  run({ crawl, inputs }) {
    const record = inputs?.digitalPr;
    if (record === undefined) return notApplicable('No digitalPr record was supplied.');

    const paid = record.wins.filter((win) => win.paid);
    const unowned = record.owner.trim() === '';
    const data = {
      plan: record.plan,
      wins: record.wins.length,
      paid: paid.slice(0, 10).map((win) => win.url),
      owner: unowned ? null : record.owner,
    };
    const failures: string[] = [];
    if (paid.length > 0) failures.push(`${paid.length} win(s) are marked paid, and a paid link is a link scheme (${paid.slice(0, 3).map((win) => win.url).join(', ')})`);
    if (unowned) failures.push('The digital PR plan has no owner');
    if (failures.length > 0) return fail(`${failures.join('; ')}.`, data);
    if (record.wins.length === 0) return warn('The digitalPr record lists no win yet.', data);

    const at = crawl.crawledAt ?? null;
    const problem = at === null ? null : inputRecordProblem(record, new Date(at));
    if (problem !== null) return warn(`The digitalPr record is held for review (${problem}).`, data);
    return pass(`The digital PR plan is owned by ${record.owner} and its ${record.wins.length} recorded win(s) are all earned. A person still judges the coverage.`, data);
  },
};

export const siteProbes = [
  digitalPrTracking,
  offpageReputationGovernance,
  monitoringIncidentSla,
  indexnowIntegration,
  logFileAnalysis,
  analyticsReconciliation,
  aiVisibilityBaseline,
  bingOnboarding,
  backlinkMonitor,
  reportingAnomalyThresholds,
  urlInventoryBuilder,
  gscPropertyOwnership,
  sitemapSubmit,
  securityManualActions,
  inheritedDomainHistory,
  migrationMapBuilder,
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
  hreflangImplementation,
  localeContentParity,
  paginationCrawlPath,
  hostRedirect,
  faviconSiteName,
  aiCrawlerDirectiveVerify,
  competitorSerpBaseline,
];
