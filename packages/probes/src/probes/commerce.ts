/**
 * Catalogue architecture: the two questions corpus check 1.15 asks of a shop's
 * product URLs.
 *
 * `product-variant-canonical` looks at a product reachable at more than one
 * address and asks whether one rule governs which of them is the product's. A
 * catalogue generates URLs faster than anything else on a site: every size,
 * colour, sort order and facet is a query string away, and each one is a real
 * URL serving a real product page. The corpus asks for a *rule* — one stable
 * canonical decision per product — not for a particular rule, because both of
 * the usual ones are defensible: consolidate every spelling onto the product,
 * or let each variant be its own indexable page with its own title. What is
 * never defensible is the third state, where the template decides case by case
 * and one product accumulates addresses nobody chose. So that detector reports
 * on consistency, which a machine can see, and stays silent about which rule
 * was right, which it cannot.
 *
 * `product-lifecycle-state` asks what becomes of that URL once the product
 * stops being for sale. The two share a subject without sharing a question, and
 * they come apart in both directions: a catalogue can hold a flawless canonical
 * rule and still quietly delete every out-of-stock page, and it can keep every
 * retired product alive at three addresses nobody chose.
 */

import { normalizeUrl } from '@seo/crawler';
import type { CrawledPage } from '@seo/crawler';
import { inputRecordProblem } from '@seo/core';
import type { SiteProbe } from '../types.js';
import { fail, notApplicable, pass, warn } from '../types.js';

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
export const isProductPage = (page: CrawledPage): boolean =>
  productNode(page) !== null ||
  /^(og:)?product\b/i.test(page.extracted?.openGraph['og:type'] ?? '');

export const isNoindex = (page: CrawledPage): boolean =>
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
export const routeOf = (url: string): string | null => {
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


/**
 * The states declared on a product's offers, lower-cased and stripped of the
 * schema.org prefix, so `https://schema.org/OutOfStock`, `OutOfStock` and
 * `http://schema.org/OutOfStock` all read the same.
 *
 * Collected from anywhere under the product node, because `offers` is a single
 * object on some templates, an array on others, and a `ProductGroup`'s variants
 * carry one each. What matters is the set of states the page declares, not
 * where in its graph the template happened to put them.
 */
function availabilityStates(node: unknown): string[] {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key.toLowerCase() !== 'availability') {
        visit(entry);
        continue;
      }
      for (const term of [entry].flat()) {
        if (typeof term !== 'string') continue;
        const word = (term.split(/[/#]/).pop() ?? '').trim().toLowerCase();
        if (word !== '') found.push(word);
      }
    }
  };
  visit(node);
  return found;
}

/** Orderable now, or orderable soon. Either way the product is still for sale. */
const PURCHASABLE = new Set([
  'instock',
  'instoreonly',
  'onlineonly',
  'limitedavailability',
  'preorder',
  'presale',
  'backorder',
]);

/** Gone for now. The product is expected back, so its URL has a future. */
const WITHDRAWN = new Set(['outofstock', 'soldout']);

/** Gone for good. */
const RETIRED = new Set(['discontinued']);

type Lifecycle = 'available' | 'withdrawn' | 'retired';

/**
 * One lifecycle state for a page, or null when it declares none this detector
 * recognises.
 *
 * Anything still purchasable wins outright — a `ProductGroup` with one variant
 * discontinued and another in stock is a product you can buy. `withdrawn` then
 * beats `retired` for the same reason in miniature: while one variant is merely
 * out of stock, the product is not gone, and treating the URL as gone would be
 * the mistake.
 */
function lifecycleOf(page: CrawledPage): Lifecycle | null {
  const states = availabilityStates(productNode(page));
  if (states.some((state) => PURCHASABLE.has(state))) return 'available';
  if (states.some((state) => WITHDRAWN.has(state))) return 'withdrawn';
  if (states.some((state) => RETIRED.has(state))) return 'retired';
  return null;
}

/**
 * What the site did with a URL.
 *
 * `consolidated` is a canonical naming a *different route* — the product
 * pointing at its successor or its category. A canonical to another query on
 * the same route is variant consolidation, which is `product-variant-canonical`'s
 * question, and counting it here would have the two detectors report one fact
 * twice under different names.
 */
type Treatment = 'kept' | 'excluded' | 'consolidated';

function treatmentOf(page: CrawledPage): Treatment {
  if (isNoindex(page)) return 'excluded';
  const canonical = normalizeUrl(page.extracted?.canonical ?? '');
  if (canonical === null) return 'kept';
  const here = routeOf(page.normalizedUrl);
  const there = routeOf(canonical);
  return here !== null && there !== null && here !== there ? 'consolidated' : 'kept';
}

const TREATMENT_WORDING: Readonly<Record<Treatment, string>> = {
  kept: 'kept indexable at its own URL',
  excluded: 'marked noindex',
  consolidated: 'canonicalized onto another route',
};

interface LifecycleProblem {
  readonly issue: string;
  readonly urls: readonly string[];
}

/**
 * Product lifecycle: what a shop does with a URL once the thing it sells stops
 * being for sale.
 *
 * The corpus asks two different things of the two ends of a product's life, and
 * this detector keeps them apart because the site's freedom differs.
 *
 * Out of stock is not gone. "Keep useful out-of-stock URLs available" is the
 * methodology's own wording, and it is a rule rather than a preference: the
 * product is coming back, the URL has links and history behind it, and the page
 * is where a shopper finds out when. Excluding it buys nothing and spends
 * everything the URL had earned. So an out-of-stock product treated as gone is
 * a failure here, whichever mechanism did it.
 *
 * Discontinued is a real decision with more than one defensible answer — keep
 * the page as a record, retire it from the index, or send it to its successor —
 * and the corpus asks for a defined handling, not a particular one. So the
 * detector asks only that the catalogue apply one rule to them, and that the
 * rule not contradict itself.
 */
export const productLifecycleState: SiteProbe = {
  id: 'product-lifecycle-state',
  scope: 'site',
  title: 'Products no longer for sale have an intentional, consistent state',
  run({ crawl, flags }) {
    if (!flags.includes('ecommerce')) {
      return notApplicable('Site profile does not claim a product catalogue.');
    }

    const products = crawl.pages
      .filter((page) => page.extracted !== null && page.fetch.status === 200)
      .filter(isProductPage);
    if (products.length === 0) {
      return notApplicable(
        'No crawled page declares itself a product, so no product lifecycle state could be read.',
      );
    }

    const declared = products
      .map((page) => ({ page, lifecycle: lifecycleOf(page) }))
      .filter(
        (entry): entry is { page: CrawledPage; lifecycle: Lifecycle } => entry.lifecycle !== null,
      );
    if (declared.length === 0) {
      // Availability is how a product page states its lifecycle to a machine.
      // Without it there is nothing here to be right or wrong about, and
      // reporting a catalogue as well handled because it declares no states
      // would be the worst answer available.
      return notApplicable(
        `None of the ${products.length} product page(s) crawled declare an availability state, so lifecycle handling is not observable.`,
      );
    }

    const notForSale = declared.filter((entry) => entry.lifecycle !== 'available');
    if (notForSale.length === 0) {
      // Every product crawled was still for sale. That is a catalogue with
      // nothing retired in it, or a crawl that reached none of what is —
      // indistinguishable from here, and neither is evidence of a rule.
      return notApplicable(
        `All ${declared.length} product page(s) declaring an availability state are still for sale, so no lifecycle handling was observable in this crawl.`,
      );
    }

    const listed = new Set(crawl.sitemapUrls);
    const problems: LifecycleProblem[] = [];
    const treatments: Record<Treatment, number> = { kept: 0, excluded: 0, consolidated: 0 };
    const retiredBy = new Map<Treatment, string[]>();

    for (const { page, lifecycle } of notForSale) {
      const treatment = treatmentOf(page);
      treatments[treatment] += 1;
      const url = page.normalizedUrl;

      if (lifecycle === 'withdrawn' && treatment !== 'kept') {
        problems.push({
          issue: `${url} declares it is out of stock and is ${TREATMENT_WORDING[treatment]}; a product that is coming back should keep its own indexable URL.`,
          urls: [url],
        });
        continue;
      }

      if (lifecycle === 'retired') {
        retiredBy.set(treatment, [...(retiredBy.get(treatment) ?? []), url]);
      }

      // A sitemap entry asks a search engine to index the URL; noindex refuses.
      // Whichever was meant, the site is issuing both.
      if (treatment === 'excluded' && listed.has(url)) {
        problems.push({
          issue: `${url} is marked noindex and still listed in the sitemap, so the two instructions disagree about it.`,
          urls: [url],
        });
      }
    }

    if (retiredBy.size > 1) {
      const spread = [...retiredBy.entries()]
        .map(([treatment, urls]) => `${urls.length} ${TREATMENT_WORDING[treatment]}`)
        .join(', ');
      problems.push({
        issue: `Discontinued products are handled ${retiredBy.size} different ways (${spread}), so no one rule governs a retired product.`,
        urls: [...retiredBy.values()].flat(),
      });
    }

    const counts = {
      productsWithAvailability: declared.length,
      withdrawn: notForSale.filter((entry) => entry.lifecycle === 'withdrawn').length,
      retired: notForSale.filter((entry) => entry.lifecycle === 'retired').length,
      treatments,
    };

    if (problems.length > 0) {
      return fail(
        `${problems.length} lifecycle problem(s) across ${notForSale.length} product(s) that are not for sale.`,
        { ...counts, samples: problems.slice(0, 10) },
      );
    }
    return pass(
      `All ${notForSale.length} product(s) not for sale are handled deliberately: out-of-stock URLs kept indexable, discontinued ones under one rule.`,
      counts,
    );
  },
};

/**
 * Every `Offer`/`AggregateOffer` node reachable under a product node, wherever
 * the template put it — a single `offers` object, an array of them, or one per
 * variant under `ProductGroup.hasVariant`. What matters is the set of offers
 * the page declares, not the shape it declared them in.
 */
function offerNodes(node: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const record = value as Record<string, unknown>;
    const types = [record['@type']].flat();
    if (types.some((type) => typeof type === 'string' && /^(Offer|AggregateOffer)$/i.test(type))) {
      found.push(record);
    }
    for (const entry of Object.values(record)) visit(entry);
  };
  visit(node);
  return found;
}

/** Present means a consumer would find something there, not merely a key. */
const presentValue = (value: unknown): boolean => {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
};

interface ProductIssue {
  readonly url: string;
  readonly issue: string;
}

/**
 * Whether a product's markup names something a shopper, or Google Merchant
 * Center, could use to tell it apart from every other product on the web: a
 * global trade number, a manufacturer part number, or the pairing of a brand
 * with the site's own SKU. Google accepts any one of the three.
 */
function hasIdentifier(node: Record<string, unknown>): boolean {
  const gtinKeys = ['gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14'];
  if (gtinKeys.some((key) => presentValue(node[key]))) return true;
  if (presentValue(node.mpn)) return true;
  return presentValue(node.brand) && presentValue(node.sku);
}

/**
 * 2.11's markup half: whether a product page's structured data is complete
 * enough for the surface it is trying to reach — a Product rich result needs a
 * name and at least one of offers, review or aggregateRating; an offer with no
 * price or currency is not an offer a consumer can act on. `merchant-feed-parity`
 * is the check's other detector: it compares markup against a Merchant Center
 * feed a person supplied.
 *
 * Image, an identifier and a declared availability are recommended rather than
 * required, so their absence holds the check for a person rather than failing
 * it outright — the same split `schema-eligibility-matrix` (2.7) draws between
 * a type's `required` and `oneOf` properties, applied to the one type this
 * check is scoped to.
 */
export const productSchema: SiteProbe = {
  id: 'product-schema',
  scope: 'site',
  title: 'Product pages carry complete, valid Product structured data',
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
        'No crawled page declares itself a product, so product structured data could not be read.',
      );
    }

    const failures: ProductIssue[] = [];
    const warnings: ProductIssue[] = [];
    let markedUp = 0;

    for (const page of products) {
      const node = productNode(page);
      const url = page.normalizedUrl;
      if (node === null) {
        failures.push({
          url,
          issue: 'declares itself a product but carries no Product structured data',
        });
        continue;
      }
      markedUp += 1;

      if (!presentValue(node.name)) {
        failures.push({ url, issue: 'Product markup has no name' });
      }

      const offers = offerNodes(node);
      const hasReview = presentValue(node.review) || presentValue(node.aggregateRating);
      if (offers.length === 0 && !hasReview) {
        failures.push({ url, issue: 'Product markup has none of offers, review or aggregateRating' });
      }

      for (const offer of offers) {
        const missing = ['price', 'priceCurrency'].filter((key) => !presentValue(offer[key]));
        if (missing.length > 0) {
          failures.push({ url, issue: `an offer is missing ${missing.join(', ')}` });
        }
        if (!presentValue(offer.availability)) {
          warnings.push({ url, issue: 'an offer declares no availability' });
        }
      }

      if (!presentValue(node.image)) warnings.push({ url, issue: 'Product markup has no image' });
      if (!hasIdentifier(node)) {
        warnings.push({
          url,
          issue: 'Product markup names no global identifier (gtin/mpn) or brand+sku',
        });
      }
    }

    const counts = { products: products.length, markedUp };

    if (failures.length > 0) {
      return fail(
        `${failures.length} required-field defect(s) across ${products.length} product page(s).`,
        { ...counts, samples: failures.slice(0, 10) },
      );
    }
    if (warnings.length > 0) {
      return warn(
        `${warnings.length} recommended-field gap(s) across ${products.length} product page(s); ` +
          'required fields are complete.',
        { ...counts, samples: warnings.slice(0, 10) },
      );
    }
    return pass(
      `All ${products.length} product page(s) carry complete Product structured data.`,
      counts,
    );
  },
};

/**
 * Availability with spacing and case removed: `availabilityStates` has already
 * lower-cased the schema.org term (`instock`), and the feed spells it `in stock`.
 */
const availabilityKey = (term: string): string => term.replace(/[\s_]/g, '').toLowerCase();

const gtinDigits = (value: unknown): string | null =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).replace(/\D/g, '').replace(/^0+/, '') || null
    : null;

const priceOf = (offer: Record<string, unknown>): number | null => {
  const spec = offer['priceSpecification'];
  const raw = offer['price'] ?? (typeof spec === 'object' && spec !== null ? (spec as Record<string, unknown>)['price'] : undefined);
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const value = Number(String(raw).replace(/,/g, '.'));
  return Number.isFinite(value) ? value : null;
};

const currencyOf = (offer: Record<string, unknown>): string | null => {
  const spec = offer['priceSpecification'];
  const raw = offer['priceCurrency'] ?? (typeof spec === 'object' && spec !== null ? (spec as Record<string, unknown>)['priceCurrency'] : undefined);
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim().toUpperCase() : null;
};

/**
 * 2.11's feed half: whether what a Merchant Center feed says about a product is
 * what its page says. Google disapproves items whose feed price or availability
 * differs from the landing page, so a disagreement is a fail; it reads only the
 * feed a person supplied and the pages the crawl already fetched.
 *
 * A field the page does not state at all is not a disagreement, so it holds the
 * check with a warn, as does a feed item whose link the crawl did not reach:
 * parity is only observed by looking. Several offers on a page (variants) agree
 * with the feed when any one of them does.
 */
export const merchantFeedParity: SiteProbe = {
  id: 'merchant-feed-parity',
  scope: 'site',
  title: 'Merchant Center feed items agree with their pages\' Product structured data',
  run({ crawl, inputs }) {
    const record = inputs?.merchantFeed;
    if (record === undefined) return notApplicable('No Merchant Center feed was supplied.');
    if (record.items === undefined) return notApplicable('The feed was named but not read, so it holds no items.');
    if (record.items.length === 0) return notApplicable('The feed holds no items.');

    const at = crawl.crawledAt ?? null;
    const held = record.owner.trim() === '' ? 'no owner' : at === null ? null : inputRecordProblem(record, new Date(at));
    if (held !== null) {
      return warn(`The supplied feed cannot be relied on (${held}); it was not compared.`, { items: record.items.length });
    }

    const byUrl = new Map<string, CrawledPage>();
    for (const page of crawl.pages) {
      if (page.extracted !== null && page.fetch.status === 200) byUrl.set(page.normalizedUrl, page);
    }

    const failures: ProductIssue[] = [];
    const gaps: ProductIssue[] = [];
    const unreached: string[] = [];
    let compared = 0;

    for (const item of record.items) {
      const url = normalizeUrl(item.link) ?? item.link;
      const page = byUrl.get(url);
      if (page === undefined) {
        unreached.push(item.link);
        continue;
      }
      const node = productNode(page);
      if (node === null) {
        gaps.push({ url, issue: `item ${item.id}: the page carries no Product structured data to compare` });
        continue;
      }
      compared += 1;
      const offers = offerNodes(node);
      const label = `item ${item.id}`;

      const prices = offers.map(priceOf).filter((v): v is number => v !== null);
      if (prices.length === 0) gaps.push({ url, issue: `${label}: the page states no price` });
      else if (!prices.some((v) => Math.abs(v - item.price) < 0.005)) {
        failures.push({ url, issue: `${label}: feed price ${item.price} but the page says ${prices.join(', ')}` });
      }

      const currencies = offers.map(currencyOf).filter((v): v is string => v !== null);
      if (currencies.length === 0) gaps.push({ url, issue: `${label}: the page states no currency` });
      else if (!currencies.includes(item.currency.toUpperCase())) {
        failures.push({ url, issue: `${label}: feed currency ${item.currency} but the page says ${[...new Set(currencies)].join(', ')}` });
      }

      const states = availabilityStates(node).map(availabilityKey);
      if (states.length === 0) gaps.push({ url, issue: `${label}: the page states no availability` });
      else if (!states.includes(availabilityKey(item.availability))) {
        failures.push({ url, issue: `${label}: feed availability "${item.availability}" but the page says ${[...new Set(states)].join(', ')}` });
      }

      if (item.gtin !== undefined) {
        const feedGtin = gtinDigits(item.gtin);
        const pageGtins = [node, ...offers]
          .flatMap((n) => ['gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14'].map((key) => gtinDigits(n[key])))
          .filter((v): v is string => v !== null);
        if (pageGtins.length === 0) gaps.push({ url, issue: `${label}: the page states no gtin` });
        else if (feedGtin !== null && !pageGtins.includes(feedGtin)) {
          failures.push({ url, issue: `${label}: feed gtin ${item.gtin} but the page says ${[...new Set(pageGtins)].join(', ')}` });
        }
      }
    }

    const data = {
      items: record.items.length,
      compared,
      unreached: unreached.length,
      samples: failures.slice(0, 10),
      gapSamples: gaps.slice(0, 10),
      unreachedSamples: unreached.slice(0, 10),
    };

    if (failures.length > 0) {
      return fail(`${failures.length} feed value(s) disagree with their product pages across ${compared} compared item(s).`, data);
    }
    if (unreached.length > 0 || gaps.length > 0) {
      return warn(
        `No disagreement found, but ${unreached.length} of ${record.items.length} feed item(s) were not reached by the crawl ` +
          `and ${gaps.length} page value(s) could not be compared.`,
        data,
      );
    }
    return pass(`All ${compared} feed item(s) agree with their product pages on price, currency, availability and gtin.`, data);
  },
};

export const productCheckoutQa: SiteProbe = {
  id: 'product-checkout-qa',
  scope: 'site',
  title: 'The checkout cases a person tested passed, and their URLs answer 200',
  run({ crawl, inputs }) {
    const record = inputs?.checkoutMatrix;
    if (record === undefined) return notApplicable('No checkout matrix was supplied; a catalogue without a checkout has nothing to test.');

    const byUrl = new Map<string, CrawledPage>();
    for (const page of crawl.pages) byUrl.set(page.normalizedUrl, page);

    const failed = record.cases.filter((c) => c.result === 'fail');
    const badStatus: { case: string; url: string; status: number | null }[] = [];
    const unreached: string[] = [];
    for (const c of record.cases) {
      const page = byUrl.get(normalizeUrl(c.url) ?? c.url);
      if (page === undefined) unreached.push(c.case);
      else if (page.fetch.status !== 200) badStatus.push({ case: c.case, url: c.url, status: page.fetch.status ?? null });
    }
    const data = { cases: record.cases.length, failed: failed.map((c) => c.case), badStatus, unreached };

    if (failed.length > 0 || badStatus.length > 0) {
      const parts: string[] = [];
      if (failed.length > 0) parts.push(`${failed.length} case(s) failed when tested (${failed.slice(0, 3).map((c) => c.case).join(', ')})`);
      if (badStatus.length > 0) {
        parts.push(`${badStatus.length} case URL(s) did not answer 200 to the crawl (${badStatus.slice(0, 3).map((c) => `${c.case}: ${c.status}`).join(', ')})`);
      }
      return fail(`${parts.join('; ')}.`, data);
    }

    const at = crawl.crawledAt ?? null;
    const held = record.owner.trim() === '' ? 'no owner' : at === null ? null : inputRecordProblem(record, new Date(at));
    if (held !== null) return warn(`The checkout matrix is held for review (${held}).`, data);
    if (unreached.length > 0) {
      return warn(`Every case passed, but the crawl did not reach the URL of ${unreached.length} of ${record.cases.length} case(s).`, data);
    }
    return pass(`All ${record.cases.length} checkout case(s) passed and their URLs answer 200.`, data);
  },
};

export const commerceProbes = [productVariantCanonical, productLifecycleState, productSchema, merchantFeedParity, productCheckoutQa];
