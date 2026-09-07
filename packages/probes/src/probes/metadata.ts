/**
 * Head-level declarations: canonical, description, social cards and the
 * structured data a page claims about itself.
 */

import { normalizeUrl } from '@seo/crawler';
import type { PageProbe } from '../types.js';
import { fail, notApplicable, pass, warn } from '../types.js';

const NO_HTML = 'No HTML was parsed for this response.';

/** Collect @type values from a JSON-LD block, graph nodes included. */
function jsonLdTypes(blocks: readonly unknown[]): string[] {
  const types: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;
    const type = record['@type'];
    if (typeof type === 'string') types.push(type);
    if (Array.isArray(type)) for (const t of type) if (typeof t === 'string') types.push(t);
    if (Array.isArray(record['@graph'])) visit(record['@graph']);
  };
  blocks.forEach(visit);
  return types;
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

export const metadataProbes = [
  canonicalization,
  metaDescription,
  titleTag,
  socialMetadata,
  breadcrumbListSchema,
  breadcrumbNavigation,
];
