/**
 * Head-level declarations: canonical, description, social cards and the
 * structured data a page claims about itself.
 *
 * Most of these are page-scoped. `schema-eligibility-matrix` is not, because
 * the question 2.7 asks is about a site's templates rather than one page's
 * markup, and a single page cannot say whether a site that claims eligible
 * templates has marked any of them up.
 */

import { normalizeUrl } from '@seo/crawler';
import type { CrawledPage } from '@seo/crawler';
import type { PageProbe, SiteProbe } from '../types.js';
import { fail, notApplicable, pass, warn } from '../types.js';

const NO_HTML = 'No HTML was parsed for this response.';

/**
 * Every object node in a page's JSON-LD, `@graph` members included.
 *
 * Only the top level and the graph. A node nested under a property — an
 * `offers` inside a `Product`, an `author` inside an `Article` — is a
 * description of that node's subject, not a second thing the page claims to
 * be, and judging it as one would ask a `PostalAddress` for a headline.
 */
export function jsonLdNodes(blocks: readonly unknown[]): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;
    nodes.push(record);
    if (Array.isArray(record['@graph'])) visit(record['@graph']);
  };
  blocks.forEach(visit);
  return nodes;
}

/** The `@type` values one node declares. A node may declare several. */
export const typesOf = (node: Record<string, unknown>): string[] =>
  [node['@type']].flat().filter((type): type is string => typeof type === 'string');

/** Collect @type values from a JSON-LD block, graph nodes included. */
function jsonLdTypes(blocks: readonly unknown[]): string[] {
  return jsonLdNodes(blocks).flatMap(typesOf);
}

export const canonicalization: PageProbe = {
  id: 'canonicalization',
  scope: 'page',
  htmlOnly: true,
  title: 'Every page declares one canonical URL',
  run({ page }) {
    const extracted = page.extracted;
    if (extracted === null) return notApplicable(NO_HTML);

    const canonical = extracted.canonical;
    if (canonical === null) {
      return fail('No rel=canonical; the page does not state its own address.');
    }
    const declared = normalizeUrl(canonical);
    const actual = normalizeUrl(page.fetch.finalUrl);
    if (declared === null) return fail(`rel=canonical is not a usable URL: "${canonical}".`);

    if (declared === actual) return pass('Self-referencing canonical.', { canonical: declared });
    // Pointing elsewhere is legitimate for a known duplicate, and wrong
    // everywhere else. A machine cannot tell the two apart.
    return warn('Canonical points at a different URL; confirm this page is a known duplicate.', {
      canonical: declared,
      pageUrl: actual,
    });
  },
};

export const metaDescription: PageProbe = {
  id: 'meta-description',
  scope: 'page',
  htmlOnly: true,
  title: 'Indexable pages carry a written meta description',
  run({ page }) {
    const extracted = page.extracted;
    if (extracted === null) return notApplicable(NO_HTML);
    if (/\bnoindex\b/i.test(extracted.metaRobots ?? '')) {
      return notApplicable('Page is marked noindex.');
    }

    const description = extracted.metaDescription;
    if (description === null || description === '') return fail('No meta description.');
    const length = description.length;
    if (length < 50) return warn(`Meta description is only ${length} characters.`, { length });
    if (length > 160) {
      return warn(`Meta description is ${length} characters and will be truncated.`, { length });
    }
    return pass(`Meta description is ${length} characters.`, { length });
  },
};

export const titleTag: PageProbe = {
  id: 'title-uniqueness',
  scope: 'page',
  htmlOnly: true,
  title: 'Every page has a distinct, meaningful title',
  run({ page, site }) {
    const extracted = page.extracted;
    if (extracted === null) return notApplicable(NO_HTML);

    const title = extracted.title;
    if (title === null || title === '') return fail('No <title>.');

    // Uniqueness is only answerable against the rest of the crawl.
    const duplicates = site.crawl.pages.filter(
      (other) =>
        other.normalizedUrl !== page.normalizedUrl &&
        other.extracted?.title != null &&
        other.extracted.title === title,
    );
    if (duplicates.length > 0) {
      return fail(`Title is shared with ${duplicates.length} other crawled page(s).`, {
        title,
        duplicates: duplicates.slice(0, 5).map((other) => other.normalizedUrl),
      });
    }
    if (title.length > 60) {
      return warn(`Title is ${title.length} characters and will be truncated.`, { title });
    }
    return pass('Title is unique across the crawl.', { title, length: title.length });
  },
};

export const socialMetadata: PageProbe = {
  id: 'social-metadata',
  scope: 'page',
  htmlOnly: true,
  title: 'Shared links render with a title, description and image',
  run({ page }) {
    const extracted = page.extracted;
    if (extracted === null) return notApplicable(NO_HTML);

    const missing = ['og:title', 'og:description', 'og:image', 'og:url'].filter(
      (property) => extracted.openGraph[property] === undefined,
    );
    if (missing.length === 4) return fail('No Open Graph metadata at all.');
    if (missing.length > 0) return warn(`Missing ${missing.join(', ')}.`, { missing });
    return pass('Open Graph title, description, image and URL are present.');
  },
};

export const breadcrumbListSchema: PageProbe = {
  id: 'breadcrumblist-schema',
  scope: 'page',
  htmlOnly: true,
  title: 'Hierarchy is expressed as BreadcrumbList structured data',
  run({ page, site }) {
    const extracted = page.extracted;
    if (extracted === null) return notApplicable(NO_HTML);
    if (!site.flags.includes('hierarchical')) {
      return notApplicable('Site profile does not claim hierarchical content.');
    }
    if (page.depth === 0) return notApplicable('The home page sits above any breadcrumb trail.');

    if (extracted.jsonLdErrors > 0) {
      return fail(`${extracted.jsonLdErrors} JSON-LD block(s) failed to parse.`);
    }
    const types = jsonLdTypes(extracted.jsonLd);
    return types.includes('BreadcrumbList')
      ? pass('BreadcrumbList structured data is present.')
      : fail('No BreadcrumbList structured data on a page below the root.', { types });
  },
};

/**
 * The breadcrumb a person can actually see, and whether it leads anywhere.
 *
 * `breadcrumblist-schema` reads what the page claims to search engines. This
 * reads what it shows the reader, and 2.17 asks for both because they come
 * apart constantly: a template emits perfect BreadcrumbList JSON-LD next to a
 * trail that was removed in a redesign, or shows a trail whose ancestors 404
 * after a URL change. Google's own guidance is that the markup must match the
 * visible navigation, so a page with only one of the two is not most of the way
 * there — it is misrepresenting itself.
 *
 * The ancestor links are checked against the crawl rather than re-fetched. A
 * link to a page the crawl never reached is not evidence of a broken ancestor —
 * it may simply have been out of budget — so that is reported as unverified,
 * while an ancestor the crawl *did* fetch and got a 4xx from is a real defect.
 */
export const breadcrumbNavigation: PageProbe = {
  id: 'breadcrumb-navigation',
  scope: 'page',
  htmlOnly: true,
  title: 'A visible breadcrumb trail leads to ancestors that resolve',
  run({ page, site }) {
    const extracted = page.extracted;
    if (extracted === null) return notApplicable(NO_HTML);
    if (!site.flags.includes('hierarchical')) {
      return notApplicable('Site profile does not claim hierarchical content.');
    }
    if (page.depth === 0) return notApplicable('The home page sits above any breadcrumb trail.');

    const trails = extracted.breadcrumbs;
    if (trails.length === 0) {
      return fail('No visible breadcrumb trail on a page below the root.');
    }

    const linked = trails.flatMap((trail) => trail.links);
    if (linked.length === 0) {
      return fail('A breadcrumb trail is present but none of its crumbs is a link.', {
        labels: trails.flatMap((trail) => trail.labels).slice(0, 10),
      });
    }

    const byUrl = new Map(site.crawl.pages.map((crawled) => [crawled.normalizedUrl, crawled]));
    const broken: { url: string; status: number }[] = [];
    let verified = 0;
    for (const href of linked) {
      const normalized = normalizeUrl(href);
      if (normalized === null) continue;
      const ancestor = byUrl.get(normalized);
      if (ancestor === undefined) continue;
      const status = ancestor.fetch.status;
      if (status !== null && status >= 400) broken.push({ url: normalized, status });
      else verified += 1;
    }

    if (broken.length > 0) {
      return fail(`${broken.length} breadcrumb ancestor(s) do not resolve.`, {
        samples: broken.slice(0, 5),
      });
    }
    if (verified === 0) {
      return warn(
        `A breadcrumb trail links ${linked.length} ancestor(s), none of which the crawl reached.`,
        { samples: linked.slice(0, 5) },
      );
    }
    return pass(`A visible breadcrumb trail links ${verified} ancestor(s), all resolving.`, {
      labels: trails.flatMap((trail) => trail.labels).slice(0, 10),
    });
  },
};

/**
 * Structured data, judged against what the page can actually support.
 *
 * 2.7 asks for a matrix: per template, which schema types are supported, which
 * properties they need, and what visible content backs them. Two thirds of that
 * is paperwork — an owner, a source column — and the third a crawl can answer
 * is the one the paperwork exists to protect: whether the markup a site ships
 * names types it is allowed to name, carries what those types require, and
 * describes something the page actually shows.
 *
 * Site-scoped, because the failure the check most wants caught is a site that
 * declares eligible templates and marks none of them up, and no page can see
 * that about itself. Per-page defects travel in `samples`.
 *
 * The type table is deliberately short. An unrecognised `@type` is left alone
 * rather than called ineligible: schema.org is vast, consumers other than
 * Google read it, and "this engine holds no requirements for Dataset" is not a
 * finding about the site.
 */

/** What a type needs before a consumer can do anything with it. */
interface TypeRule {
  /** Properties that must all be present. */
  readonly required: readonly string[];
  /** Properties of which at least one must be present, when the type has such a set. */
  readonly oneOf?: readonly string[];
  /**
   * The property naming the page's own subject, when the type describes one.
   * Only these are held to the visible-content test: an `Organization` name
   * belongs to the site rather than the page, and often appears only in a logo.
   */
  readonly subject?: string;
}

const TYPE_RULES: Readonly<Record<string, TypeRule>> = {
  Article: { required: ['headline'], subject: 'headline' },
  NewsArticle: { required: ['headline'], subject: 'headline' },
  BlogPosting: { required: ['headline'], subject: 'headline' },
  Product: {
    required: ['name'],
    oneOf: ['offers', 'review', 'aggregateRating'],
    subject: 'name',
  },
  ProductGroup: { required: ['name'], subject: 'name' },
  Event: { required: ['name', 'startDate', 'location'], subject: 'name' },
  Recipe: { required: ['name', 'image'], subject: 'name' },
  Course: { required: ['name', 'description'], subject: 'name' },
  VideoObject: { required: ['name', 'thumbnailUrl', 'uploadDate'], subject: 'name' },
  JobPosting: {
    required: ['title', 'description', 'datePosted', 'hiringOrganization'],
    subject: 'title',
  },
  BreadcrumbList: { required: ['itemListElement'] },
  Organization: { required: ['name'] },
  LocalBusiness: { required: ['name', 'address'] },
  WebSite: { required: ['name'] },
  FAQPage: { required: ['mainEntity'] },
  HowTo: { required: ['name', 'step'] },
};

/**
 * Types that are valid schema.org and no longer earn a rich result: FAQ ended
 * on 7 May 2026, HowTo before it. The corpus is explicit that accurate markup
 * of these may stay, so this is a warning about what to build next, never a
 * defect in what was built.
 */
const NO_RICH_RESULT = new Set(['FAQPage', 'HowTo']);

/** Present means a consumer would find something there, not merely a key. */
const present = (value: unknown): boolean => {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
};

/** Whether a block puts its types in the vocabulary consumers read. */
function hasSchemaContext(block: unknown): boolean {
  if (typeof block !== 'object' || block === null) return false;
  const context = (block as Record<string, unknown>)['@context'];
  return context !== undefined && /schema\.org/i.test(JSON.stringify(context));
}

const normalizeText = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();

/** The words a reader of this page would see, title included. */
const visibleTextOf = (page: CrawledPage): string =>
  normalizeText(`${page.extracted?.title ?? ''} ${page.extracted?.text ?? ''}`);

interface SchemaDefect {
  readonly url: string;
  readonly type: string;
  readonly issue: string;
}

export const schemaEligibilityMatrix: SiteProbe = {
  id: 'schema-eligibility-matrix',
  scope: 'site',
  title: 'Structured data names supported types and reflects visible content',
  run({ crawl, flags }) {
    if (!flags.includes('structured-data')) {
      return notApplicable('Site profile does not claim templates eligible for structured data.');
    }

    const defects: SchemaDefect[] = [];
    const ineligible: SchemaDefect[] = [];
    const typesSeen = new Set<string>();
    let htmlPages = 0;
    let marked = 0;

    for (const page of crawl.pages) {
      const extracted = page.extracted;
      if (extracted === null) continue;
      htmlPages += 1;
      const url = page.normalizedUrl;

      if (extracted.jsonLdErrors > 0) {
        defects.push({
          url,
          type: '-',
          issue: `${extracted.jsonLdErrors} JSON-LD block(s) failed to parse`,
        });
      }

      // An array at the top level is several blocks written as one, and each
      // carries its own context.
      const blocks = extracted.jsonLd.flatMap((block) =>
        Array.isArray(block) ? (block as unknown[]) : [block],
      );
      for (const block of blocks) {
        const types = jsonLdTypes([block]);
        if (types.length > 0 && !hasSchemaContext(block)) {
          defects.push({
            url,
            type: types.join(', '),
            issue: 'declared outside the schema.org @context, so nothing will read it',
          });
        }
      }

      const nodes = jsonLdNodes(extracted.jsonLd);
      if (nodes.length > 0) marked += 1;
      const visible = visibleTextOf(page);

      for (const node of nodes) {
        for (const type of typesOf(node)) {
          typesSeen.add(type);
          const rule = TYPE_RULES[type];
          if (rule === undefined) continue;

          if (NO_RICH_RESULT.has(type)) {
            ineligible.push({ url, type, issue: 'no longer produces a rich result' });
          }

          const missing = rule.required.filter((property) => !present(node[property]));
          if (missing.length > 0) {
            defects.push({ url, type, issue: `missing required ${missing.join(', ')}` });
          }
          if (rule.oneOf !== undefined && !rule.oneOf.some((property) => present(node[property]))) {
            defects.push({ url, type, issue: `has none of ${rule.oneOf.join(', ')}` });
          }

          const claimed = rule.subject === undefined ? undefined : node[rule.subject];
          // Short names are skipped: a two-character subject matches by
          // accident, and the finding has to be worth acting on.
          if (
            typeof claimed === 'string' &&
            claimed.trim().length >= 3 &&
            !visible.includes(normalizeText(claimed))
          ) {
            defects.push({
              url,
              type,
              issue: `${rule.subject} "${claimed.slice(0, 60)}" appears nowhere in the visible content`,
            });
          }
        }
      }
    }

    if (htmlPages === 0) return notApplicable('The crawl reached no HTML pages.');

    const data = {
      htmlPages,
      pagesWithMarkup: marked,
      types: [...typesSeen].sort(),
    };

    // Defects are reported before absence, because a page whose only block
    // fails to parse has no nodes and would otherwise be described as carrying
    // no markup — true of what a consumer sees, and not what to go and fix.
    if (defects.length > 0) {
      return fail(`${defects.length} structured-data defect(s) across ${htmlPages} page(s).`, {
        ...data,
        defects: defects.length,
        samples: defects.slice(0, 5),
      });
    }
    if (marked === 0) {
      return fail(
        'The site profile claims templates eligible for structured data, and none of ' +
          `${htmlPages} crawled page(s) carries any.`,
        data,
      );
    }
    if (ineligible.length > 0) {
      return warn(
        `${ineligible.length} node(s) use a type that no longer produces a rich result ` +
          `(${[...new Set(ineligible.map((node) => node.type))].join(', ')}); accurate markup ` +
          'may stay, but do not build more of it.',
        { ...data, samples: ineligible.slice(0, 5) },
      );
    }
    return pass(
      `${marked} of ${htmlPages} page(s) carry structured data; every judged type is ` +
        'complete and backed by visible content.',
      data,
    );
  },
};

export const metadataProbes = [
  canonicalization,
  metaDescription,
  titleTag,
  socialMetadata,
  breadcrumbListSchema,
  breadcrumbNavigation,
  schemaEligibilityMatrix,
];
