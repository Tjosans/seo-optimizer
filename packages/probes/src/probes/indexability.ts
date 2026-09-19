/**
 * Indexability directives: which URLs are allowed into an index, and whether
 * the site says so explicitly.
 */

import { isSameSite, normalizeUrl } from '@seo/crawler';
import type { CrawledPage, Extracted } from '@seo/crawler';
import type { PageProbe, SiteProbe } from '../types.js';
import { errored, fail, notApplicable, pass, warn } from '../types.js';

/** Query keys and path segments that mean "these are search results". */
export const SEARCH_PARAMS = ['q', 's', 'query', 'search', 'keyword', 'keywords'];
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

/**
 * Whether two hreflang values name one language in different regions.
 *
 * Compared on the primary language subtag. `x-default` names no language, so it
 * never matches: a canonical onto the fallback is a cross-language collapse
 * until someone shows otherwise.
 */
const sameLanguage = (a: string, b: string): boolean => {
  const language = (value: string): string | null => {
    const primary = value.trim().toLowerCase().split(/[-_]/)[0] ?? '';
    return primary === '' || primary === 'x' ? null : primary;
  };
  const left = language(a);
  return left !== null && left === language(b) && a.trim().toLowerCase() !== b.trim().toLowerCase();
};

/**
 * Whether a locale variant is allowed to be indexed as itself.
 *
 * The defect this exists for is quiet and common: a template ships with the
 * canonical hard-coded to the default locale, so `/fr/` declares `/en/` as its
 * address. Every hreflang annotation on the site can be perfect and the French
 * page still never appears, because canonical outranks hreflang — the site
 * asked for one page and got it.
 *
 * Corpus v5.0 draws the line this detector follows: distinct translations must
 * stay independently indexable, so a canonical onto another language fails,
 * while "same-language regional consolidation" is allowed when the locale plan
 * (0.7) documents it, so a canonical onto another region of the same language
 * holds the check for the person who owns that plan.
 *
 * "Is this a locale variant?" is answered from the cluster rather than from the
 * page, on purpose. A page that carries no annotation of its own but is named
 * by another locale is exactly the case worth catching: the annotation says it
 * is a variant, and the canonical says it is a duplicate.
 */
export const localeCanonical: PageProbe = {
  id: 'locale-canonical',
  scope: 'page',
  htmlOnly: true,
  title: 'Each locale variant canonicalizes to itself',
  run({ page, site }) {
    const extracted = page.extracted;
    if (extracted === null) return notApplicable('Response is not HTML.');
    if (page.fetch.status !== 200) return notApplicable('Response was not a 200.');

    const selves = new Set(
      [page.normalizedUrl, normalizeUrl(page.fetch.finalUrl)].filter(
        (url): url is string => url !== null,
      ),
    );

    /** Every locale in this page's cluster: URL -> the value naming it. */
    const cluster = new Map<string, string>();
    const record = (source: CrawledPage): void => {
      for (const entry of source.extracted?.hreflang ?? []) {
        const target = normalizeUrl(entry.url);
        if (target !== null && !cluster.has(target)) cluster.set(target, entry.hreflang);
      }
    };

    record(page);
    for (const other of site.crawl.pages) {
      if (selves.has(other.normalizedUrl)) continue;
      const names = (other.extracted?.hreflang ?? []).some((entry) => {
        const target = normalizeUrl(entry.url);
        return target !== null && selves.has(target);
      });
      if (names) record(other);
    }

    const alternates = [...cluster.keys()].filter((url) => !selves.has(url));
    if (cluster.size === 0) {
      return notApplicable('No hreflang annotation names this page, so it is not a locale variant.');
    }
    if (alternates.length === 0) {
      // Annotated, but the only locale named is this one. Nothing about the
      // canonical can be wrong across locales when there is one locale.
      return notApplicable('The only locale this page is clustered with is itself.');
    }

    const canonical = extracted.canonical;
    if (canonical === null) {
      // v5.0 asks for self-canonicals "where appropriate" rather than on every
      // page, so a missing one is a gap to close, not a contradiction.
      return warn('A locale variant with no rel=canonical leaves a search engine to pick which locale to keep.', {
        alternates: alternates.slice(0, 10),
      });
    }
    const declared = normalizeUrl(canonical);
    if (declared === null) return fail(`rel=canonical is not a usable URL: "${canonical}".`);
    if (selves.has(declared)) {
      return pass(`Self-canonical, alongside ${alternates.length} other locale(s).`, {
        canonical: declared,
        alternates: alternates.slice(0, 10),
      });
    }

    const locale = cluster.get(declared);
    const own = [...selves].map((url) => cluster.get(url)).find((value) => value !== undefined);
    if (locale !== undefined && own !== undefined && sameLanguage(own, locale)) {
      // v5.0 0.7 and 1.14 allow "same-language regional consolidation" when the
      // locale plan documents it — en-GB onto en-US is a choice a site may make.
      // Only the plan can say it was chosen, so it holds for a person.
      return warn(
        `Canonicalizes the "${own}" page to its same-language "${locale}" variant at ${declared}; ` +
          'confirm the locale plan consolidates these regions deliberately.',
        { canonical: declared, locale, own, pageUrl: page.normalizedUrl },
      );
    }
    if (locale !== undefined) {
      return fail(
        `Canonicalizes to the "${locale}" locale at ${declared}, so this locale cannot be indexed separately.`,
        { canonical: declared, locale, pageUrl: page.normalizedUrl },
      );
    }
    return fail(
      `Canonical points at ${declared}, which no hreflang annotation names; canonical and hreflang disagree about this page's address.`,
      { canonical: declared, pageUrl: page.normalizedUrl, alternates: alternates.slice(0, 10) },
    );
  },
};

const NOINDEX = /\bnoindex\b/i;

/** How far rendered content, links or structured data may outgrow the raw response before it is worth a person's attention. */
const GAP_RATIO = 1.5;
const WORD_GAP_MIN = 50;
const LINK_GAP_MIN = 5;

/**
 * Whether a non-rendering crawler sees the page a browser does.
 *
 * 1.1's "Done when" collapses two different questions into one detector pair;
 * this is the second, `raw-rendered-parity`'s reading being the first. That
 * one is not implemented — its evidence is the whole raw/rendered diff this
 * detector only samples — so 1.1 stays uncoverable end to end until it lands.
 * This detector answers what it can from `CrawledPage.rendered`, the
 * comparison @seo/crawler already computes when a crawl opts into rendering:
 * whether the two responses *disagree* about anything that changes what an
 * indexing decision or a link graph would be built from.
 *
 * A noindex directive or a canonical present on one side and not the other
 * (or naming a different URL) fails outright — corpus check 1.1 asks that
 * "raw/rendered directives and canonicals do not conflict", and either is the
 * one signal a non-rendering crawler and Googlebot could act on differently.
 * A raw response with no reading matter at all, filled in only after
 * scripts run, fails the same way: "prefer server-delivered critical
 * content as a reliability policy" is not a recommendation this detector can
 * treat as optional when the raw body is empty. A smaller gap in words,
 * links or JSON-LD — rendering adding to what raw already carries, not
 * replacing it — is a `warn`: not every crawler renders, so the difference
 * is a reliability question for the person who owns the rendering strategy,
 * not a defect a machine can fail outright.
 *
 * Resource failures, missing-route behaviour and the fetch envelope 1.1
 * defers to 1.5 are covered by other checks (`broken-links`,
 * `crawler-fetch-limit`) and are not read again here.
 *
 * Rendering is opt-in per crawl (`CrawlOptions.renderPages`), unlike the raw
 * fetch every page already has: a page with no render captured at all is
 * `not-applicable`, the same as any other check whose evidence the caller
 * chose not to gather, not `error`, which is reserved for a render that was
 * attempted and failed.
 */
export const renderingStrategyClassifier: PageProbe = {
  id: 'rendering-strategy-classifier',
  scope: 'page',
  htmlOnly: true,
  title: 'Raw and rendered responses agree on what a crawler should do',
  run({ page }) {
    const rendered = page.rendered;
    if (rendered === undefined || rendered === null) {
      return notApplicable('No render was captured for this crawl; rendering was not requested.');
    }
    if (rendered.render.error !== null) {
      return errored(`Rendering failed: ${rendered.render.error}.`);
    }
    const renderedExtracted = rendered.extracted;
    const comparison = rendered.comparison;
    if (renderedExtracted === null || comparison === null) {
      return errored('The rendered response was empty or not HTML, so there is nothing to compare it against.');
    }

    const raw = page.extracted;
    if (raw === null) return notApplicable('Response is not HTML.');

    const rawNoindex = NOINDEX.test(raw.metaRobots ?? '');
    const renderedNoindex = NOINDEX.test(renderedExtracted.metaRobots ?? '');
    if (rawNoindex !== renderedNoindex) {
      return fail(
        rawNoindex
          ? 'The raw response carries noindex, but the rendered page does not: a non-rendering crawler excludes this page and a rendering one indexes it.'
          : 'The rendered page carries noindex, but the raw response does not: a non-rendering crawler indexes this page and a rendering one excludes it.',
        { rawMetaRobots: raw.metaRobots, renderedMetaRobots: renderedExtracted.metaRobots },
      );
    }

    if (!comparison.canonicalMatches) {
      return fail(
        `The declared canonical differs between raw and rendered: raw names ${raw.canonical ?? 'none'}, rendered names ${renderedExtracted.canonical ?? 'none'}.`,
        { rawCanonical: raw.canonical, renderedCanonical: renderedExtracted.canonical },
      );
    }

    if (comparison.wordCountRaw === 0 && comparison.wordCountRendered > 0) {
      return fail(
        `The raw response has no reading matter at all (${comparison.wordCountRendered} word(s) appear only after rendering); a crawler that does not render this page sees an empty one.`,
        { wordCountRaw: comparison.wordCountRaw, wordCountRendered: comparison.wordCountRendered },
      );
    }

    const gap = (rawCount: number, renderedCount: number, min: number): boolean =>
      renderedCount > rawCount * GAP_RATIO && renderedCount - rawCount >= min;

    const findings: string[] = [];
    if (gap(comparison.wordCountRaw, comparison.wordCountRendered, WORD_GAP_MIN)) {
      findings.push(`${comparison.wordCountRaw} word(s) raw vs ${comparison.wordCountRendered} rendered`);
    }
    if (gap(comparison.linkCountRaw, comparison.linkCountRendered, LINK_GAP_MIN)) {
      findings.push(`${comparison.linkCountRaw} link(s) raw vs ${comparison.linkCountRendered} rendered`);
    }
    if (comparison.jsonLdCountRendered > comparison.jsonLdCountRaw) {
      findings.push(`${comparison.jsonLdCountRaw} JSON-LD node(s) raw vs ${comparison.jsonLdCountRendered} rendered`);
    }

    if (findings.length > 0) {
      return warn(
        `Rendering adds meaningfully to the raw response (${findings.join('; ')}); confirm a non-rendering crawler still gets what it needs.`,
        { ...comparison },
      );
    }

    return pass('Raw and rendered responses agree on indexing directives, canonical and substance.', { ...comparison });
  },
};

const firstH1 = (extracted: Extracted): string | null =>
  extracted.headings.find((heading) => heading.level === 1)?.text ?? null;

/** Same-site link targets, normalized so a fragment or a trailing-slash spelling is not a difference. */
const sameSiteTargets = (extracted: Extracted, origin: string): Set<string> => {
  const targets = new Set<string>();
  for (const link of extracted.links) {
    if (!isSameSite(link.url, origin)) continue;
    try {
      const normalized = normalizeUrl(link.url);
      if (normalized !== null) targets.add(normalized);
    } catch {
      // An unparseable target has no identity to compare.
    }
  }
  return targets;
};

/**
 * Whether raw and rendered carry the same things, not the same amount of them.
 *
 * `rendering-strategy-classifier` judges directives, canonical and volume; a
 * page can pass all of that and still swap its title, its h1 or half its
 * navigation once scripts run. A `<title>` or first h1 that differs, and a
 * same-site link target that only the raw response carries, fail: a crawler
 * that renders would index something other than what one that does not
 * sees, and the links rendering removed are edges a non-rendering crawl
 * followed. A same-site target that appears only after rendering is a `warn`:
 * a non-rendering crawler cannot discover it, which is a reliability question
 * for whoever owns the rendering strategy.
 *
 * A title or h1 present on one side only counts as a difference. Rendering
 * is opt-in per crawl: no render is `not-applicable`, a failed one `error`.
 */
export const rawRenderedParity: PageProbe = {
  id: 'raw-rendered-parity',
  scope: 'page',
  htmlOnly: true,
  title: 'Raw and rendered responses carry the same title, heading and links',
  run({ page, site }) {
    const rendered = page.rendered;
    if (rendered === undefined || rendered === null) {
      return notApplicable('No render was captured for this crawl; rendering was not requested.');
    }
    if (rendered.render.error !== null) {
      return errored(`Rendering failed: ${rendered.render.error}.`);
    }
    const renderedExtracted = rendered.extracted;
    if (renderedExtracted === null) {
      return errored('The rendered response was empty or not HTML, so there is nothing to compare it against.');
    }
    const raw = page.extracted;
    if (raw === null) return notApplicable('Response is not HTML.');

    const failures: string[] = [];
    const data: Record<string, unknown> = {};

    if (raw.title !== renderedExtracted.title) {
      failures.push(`the title is "${raw.title ?? ''}" raw and "${renderedExtracted.title ?? ''}" rendered`);
      data['rawTitle'] = raw.title;
      data['renderedTitle'] = renderedExtracted.title;
    }
    const rawH1 = firstH1(raw);
    const renderedH1 = firstH1(renderedExtracted);
    if (rawH1 !== renderedH1) {
      failures.push(`the first h1 is "${rawH1 ?? ''}" raw and "${renderedH1 ?? ''}" rendered`);
      data['rawH1'] = rawH1;
      data['renderedH1'] = renderedH1;
    }

    const rawTargets = sameSiteTargets(raw, site.origin);
    const renderedTargets = sameSiteTargets(renderedExtracted, site.origin);
    const removed = [...rawTargets].filter((target) => !renderedTargets.has(target));
    const added = [...renderedTargets].filter((target) => !rawTargets.has(target));
    if (removed.length > 0) {
      failures.push(`${removed.length} same-site link target(s) in the raw response are gone after rendering`);
      data['removedLinks'] = removed.slice(0, 10);
    }

    if (failures.length > 0) {
      return fail(`Raw and rendered disagree: ${failures.join('; ')}.`, {
        ...data,
        removedLinkCount: removed.length,
        addedLinkCount: added.length,
      });
    }
    if (added.length > 0) {
      return warn(
        `${added.length} same-site link target(s) exist only after rendering; a crawler that does not render cannot discover them.`,
        { addedLinks: added.slice(0, 10), addedLinkCount: added.length },
      );
    }
    return pass('Raw and rendered responses carry the same title, first h1 and same-site link targets.', {
      linkTargets: rawTargets.size,
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

export const indexabilityProbes = [
  internalSearchIndexability,
  localeCanonical,
  rawRenderedParity,
  renderingStrategyClassifier,
  xRobotsTagNonHtml,
];
