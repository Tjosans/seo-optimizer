/**
 * Catalogue architecture: what a shop's product URLs do when one product is
 * reachable at more than one address.
 *
 * A catalogue generates URLs faster than anything else on a site. Every size,
 * colour, sort order and facet is a query string away, and each one is a real
 * URL serving a real product page. The corpus asks for a *rule* — one stable
 * canonical decision per product — not for a particular rule, because both of
 * the usual ones are defensible: consolidate every spelling onto the product,
 * or let each variant be its own indexable page with its own title. What is
 * never defensible is the third state, where the template decides case by case
 * and one product accumulates addresses nobody chose.
 *
 * So this detector reports on consistency, which a machine can see, and stays
 * silent about which rule was right, which it cannot.
 */

import { normalizeUrl } from '@seo/crawler';
import type { CrawledPage } from '@seo/crawler';
import type { SiteProbe } from '../types.js';
import { fail, notApplicable, pass } from '../types.js';

const PRODUCT_TYPE = /^(Product|ProductGroup|ProductModel)$/i;

/** The first schema.org Product node on a page, or null. Walks `@graph`. */
function productNode(page: CrawledPage): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  const visit = (node: unknown): void => {
    if (found !== null) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;
    const types = [record['@type']].flat();
    if (types.some((type) => typeof type === 'string' && PRODUCT_TYPE.test(type))) {
      found = record;
      return;
    }
    if (Array.isArray(record['@graph'])) visit(record['@graph']);
  };
  (page.extracted?.jsonLd ?? []).forEach(visit);
  return found;
}

/**
 * Whether a page says it is a product page.
 *
 * Only what the page declares — Product structured data, or `og:type`. Guessing
 * from a URL shape would pull category listings and articles into product
 * families, and the finding is about duplicates within one product.
 */
const isProductPage = (page: CrawledPage): boolean =>
  productNode(page) !== null ||
  /^(og:)?product\b/i.test(page.extracted?.openGraph['og:type'] ?? '');

const isNoindex = (page: CrawledPage): boolean =>
  /\bnoindex\b/i.test(
    `${page.extracted?.metaRobots ?? ''} ${page.fetch.headers['x-robots-tag'] ?? ''}`,
  );

/**
 * A URL's route: origin and path, without the query.
 *
 * This is what makes a family. Two URLs sharing a route are one template
 * serving one product under different query state — a variant selector, a
 * facet, a session id; it does not matter which. Whatever the parameter means,
 * the site is serving that product at two addresses, which is the subject.
 */
const routeOf = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
};

interface FamilyProblem {
  readonly route: string;
  readonly issue: string;
  readonly urls: readonly string[];
}

/**
 * What is wrong with one product's set of addresses, or null when its rule
 * holds. At most one problem per family: the first thing to fix.
 */
function judge(
  route: string,
  members: readonly CrawledPage[],
  byUrl: ReadonlyMap<string, CrawledPage>,
): FamilyProblem | null {
  const urls = members.map((member) => member.normalizedUrl);
  const indexable = members.filter((member) => !isNoindex(member));

  // Every extra spelling excluded, or only one of them indexable: a rule was
  // applied and it worked. Whether the surviving URL is the right one is the
  // general canonicalization detector's question, not this one's.
  if (indexable.length < 2) return null;

  const missing = indexable.filter((member) => (member.extracted?.canonical ?? null) === null);
  if (missing.length > 0) {
    return {
      route,
      issue: `${indexable.length} indexable addresses, ${missing.length} of them with no rel=canonical, so nothing states which is the product's URL.`,
      urls: missing.map((member) => member.normalizedUrl),
    };
  }

  const declared = indexable.map((member) => ({
    url: member.normalizedUrl,
    target: normalizeUrl(member.extracted?.canonical ?? ''),
  }));
  const unusable = declared.filter((entry) => entry.target === null);
  if (unusable.length > 0) {
    return {
      route,
      issue: `${unusable.length} address(es) declare a rel=canonical that is not a usable URL.`,
      urls: unusable.map((entry) => entry.url),
    };
  }

  const targets = new Set(declared.map((entry) => entry.target as string));

  // Rule one: every address is its own page. Legitimate, and only legitimate
  // while the pages differ — identical titles under it are exactly the
  // uncontrolled duplicates the check exists to prevent.
  if (declared.every((entry) => entry.target === entry.url)) {
    const byTitle = new Map<string, string[]>();
    for (const member of indexable) {
      const title = member.extracted?.title ?? '';
      if (title === '') continue; // A missing title is title-uniqueness's finding.
      byTitle.set(title, [...(byTitle.get(title) ?? []), member.normalizedUrl]);
    }
    const repeated = [...byTitle.entries()].filter(([, at]) => at.length > 1);
    const worst = repeated[0];
    if (worst !== undefined) {
      return {
        route,
        issue: `${worst[1].length} addresses are self-canonical and share the title "${worst[0]}", so the variants compete with each other.`,
        urls: worst[1],
      };
    }
    return null;
  }

  // Rule two: every address consolidates onto one URL. The target has to be a
  // page that can actually hold the product.
  if (targets.size === 1) {
    const target = [...targets][0] as string;
    const targetPage = byUrl.get(target);
    if (targetPage !== undefined && targetPage.fetch.status !== 200) {
      return {
        route,
        issue: `Every address canonicalizes to ${target}, which answered ${targetPage.fetch.status}.`,
        urls,
      };
    }
    if (targetPage !== undefined && isNoindex(targetPage)) {
      return {
        route,
        issue: `Every address canonicalizes to ${target}, which is marked noindex, so the product has no indexable URL.`,
        urls,
      };
    }
    return null;
  }

  return {
    route,
    issue: `${indexable.length} addresses declare ${targets.size} different canonicals, so no one rule governs this product.`,
    urls,
  };
}

export const productVariantCanonical: SiteProbe = {
  id: 'product-variant-canonical',
  scope: 'site',
  title: 'One canonical rule governs each product and its variant URLs',
  run({ crawl, flags }) {
    if (!flags.includes('ecommerce')) {
      return notApplicable('Site profile does not claim a product catalogue.');
    }

    const pages = crawl.pages.filter(
      (page) => page.extracted !== null && page.fetch.status === 200,
    );
    const products = pages.filter(isProductPage);
    if (products.length === 0) {
      return notApplicable(
        'No crawled page declares itself a product, so no product URL family could be identified.',
      );
    }

    const productRoutes = new Set(
      products
        .map((page) => routeOf(page.normalizedUrl))
        .filter((route): route is string => route !== null),
    );
    const families = new Map<string, CrawledPage[]>();
    const byUrl = new Map<string, CrawledPage>();
    for (const page of crawl.pages) byUrl.set(page.normalizedUrl, page);
    for (const page of pages) {
      const route = routeOf(page.normalizedUrl);
      if (route === null || !productRoutes.has(route)) continue;
      families.set(route, [...(families.get(route) ?? []), page]);
    }

    const multiple = [...families.entries()].filter(([, members]) => members.length > 1);
    if (multiple.length === 0) {
      // Every product was crawled at exactly one address. That is what a
      // controlled catalogue looks like — and also what a crawl that never
      // reached a variant URL looks like. Nothing here tells the two apart, so
      // this is unevidenced rather than good news.
      return notApplicable(
        `No product was crawled at more than one address, so variant duplication is not observable in this crawl (${products.length} product page(s) seen).`,
      );
    }

    const problems = multiple
      .map(([route, members]) => judge(route, members, byUrl))
      .filter((problem): problem is FamilyProblem => problem !== null);

    if (problems.length > 0) {
      return fail(
        `${problems.length} of ${multiple.length} product(s) served at more than one address do not follow one canonical rule.`,
        { familiesWithVariants: multiple.length, samples: problems.slice(0, 10) },
      );
    }
    return pass(
      `Each of the ${multiple.length} product(s) served at more than one address follows one canonical rule.`,
      { familiesWithVariants: multiple.length },
    );
  },
};

export const commerceProbes = [productVariantCanonical];
