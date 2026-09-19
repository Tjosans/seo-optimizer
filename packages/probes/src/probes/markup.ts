/**
 * Document structure: the parts of the HTML a crawler has to be able to read
 * before anything else in an audit means much.
 *
 * Each of these declares `htmlOnly`, so the runner skips non-HTML responses;
 * the null check inside is the type-level restatement of that, not a second
 * policy.
 */

import { isSameSite } from '@seo/crawler';
import type { CrawledPage } from '@seo/crawler';
import type { PageProbe, SiteProbe } from '../types.js';
import { errored, fail, notApplicable, pass, warn } from '../types.js';
import { bareType } from './content.js';
import { jsonLdNodes, typesOf } from './metadata.js';

const NO_HTML = 'No HTML was parsed for this response.';

export const semanticHtml: PageProbe = {
  id: 'semantic-html',
  scope: 'page',
  htmlOnly: true,
  title: 'Content uses semantic landmarks',
  run({ page }) {
    const extracted = page.extracted;
    if (extracted === null) return notApplicable(NO_HTML);

    const { landmarks } = extracted;
    if (!landmarks.includes('main')) {
      return fail('No <main> landmark; primary content is not distinguishable from chrome.', {
        landmarks,
      });
    }
    const missing = ['header', 'nav', 'footer'].filter((tag) => !landmarks.includes(tag));
    return missing.length === 0
      ? pass('Uses main, header, nav and footer landmarks.', { landmarks })
      : warn(`Has <main>, but no ${missing.join(', ')}.`, { landmarks, missing });
  },
};

export const headingOutline: PageProbe = {
  id: 'heading-outline',
  scope: 'page',
  htmlOnly: true,
  title: 'Heading levels form a single ordered outline',
  run({ page }) {
    const extracted = page.extracted;
    if (extracted === null) return notApplicable(NO_HTML);

    const { headings } = extracted;
    const h1s = headings.filter((h) => h.level === 1);
    if (h1s.length === 0) return fail('No <h1> on the page.', { headingCount: headings.length });
    if (h1s.length > 1) {
      return warn(`${h1s.length} <h1> elements; the page has no single subject.`, {
        h1s: h1s.map((h) => h.text),
      });
    }

    const skips: string[] = [];
    let previous = 1;
    for (const heading of headings) {
      if (heading.level > previous + 1) {
        skips.push(`h${previous} to h${heading.level} at "${heading.text.slice(0, 40)}"`);
      }
      previous = heading.level;
    }
    return skips.length === 0
      ? pass('One <h1>, and no skipped heading levels.')
      : warn(`${skips.length} skipped heading level(s).`, { skips });
  },
};

export const primaryHeading: PageProbe = {
  id: 'primary-heading',
  scope: 'page',
  htmlOnly: true,
  title: 'The primary heading states the page subject',
  run({ page }) {
    const extracted = page.extracted;
    if (extracted === null) return notApplicable(NO_HTML);

    const h1 = extracted.headings.find((h) => h.level === 1);
    if (h1 === undefined) return fail('No <h1> to carry the page subject.');
    if (h1.text.length < 3) return fail('The <h1> is empty or near-empty.', { h1: h1.text });
    return pass('A single descriptive <h1> is present.', { h1: h1.text, title: extracted.title });
  },
};

export const crawlableLinks: PageProbe = {
  id: 'crawlable-links',
  scope: 'page',
  htmlOnly: true,
  title: 'Navigation is crawlable <a href> markup',
  run({ page, site }) {
    const extracted = page.extracted;
    if (extracted === null) return notApplicable(NO_HTML);

    const { links } = extracted;
    const internal = links.filter((link) => isSameSite(link.url, site.origin));
    const scripted = links.filter((link) => /^javascript:/i.test(link.href) || link.href === '#');

    if (internal.length === 0) {
      return fail('No crawlable internal links in the raw HTML.', { totalLinks: links.length });
    }
    if (scripted.length > 0) {
      return warn(`${scripted.length} link(s) go nowhere without JavaScript.`, {
        samples: scripted.slice(0, 5).map((link) => link.href),
        internalLinks: internal.length,
      });
    }
    return pass(`${internal.length} crawlable internal link(s).`, {
      internalLinks: internal.length,
      externalLinks: links.length - internal.length,
    });
  },
};

export const langAttribute: PageProbe = {
  id: 'lang-attribute',
  scope: 'page',
  htmlOnly: true,
  title: 'The document declares its language',
  run({ page }) {
    const extracted = page.extracted;
    if (extracted === null) return notApplicable(NO_HTML);

    const lang = extracted.lang;
    if (lang === null || lang.trim() === '') return fail('<html> carries no lang attribute.');
    // BCP 47 in the shape sites actually use: "en", "en-GB", "zh-Hant-TW".
    if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/i.test(lang)) {
      return fail(`lang="${lang}" is not a well-formed language tag.`, { lang });
    }
    return pass(`Declares lang="${lang}".`, { lang });
  },
};

export const soft404: PageProbe = {
  id: 'soft-404',
  scope: 'page',
  htmlOnly: true,
  title: 'Missing pages return 404 rather than a 200 apology',
  run({ page }) {
    const extracted = page.extracted;
    if (extracted === null) return notApplicable(NO_HTML);
    if (page.fetch.status !== 200) return notApplicable('Response was not a 200.');

    const haystack = `${extracted.title ?? ''} ${extracted.headings.map((h) => h.text).join(' ')}`;
    if (/\b(404|page not found|not found|no longer exists)\b/i.test(haystack)) {
      return fail('Returns 200 while telling the reader the page does not exist.', {
        title: extracted.title,
        status: 200,
      });
    }
    if (extracted.wordCount < 50) {
      return warn(`Returns 200 with only ${extracted.wordCount} words of content.`, {
        wordCount: extracted.wordCount,
      });
    }
    return pass('A 200 response with real content.');
  },
};

// --- 2.5 analytics-implementation ---------------------------------------

/** A static `<script src>` loading gtag.js (`/gtag/js?id=`) or gtm.js (`/gtm.js?id=`). */
const GTAG_OR_GTM_SRC = /\/gtag\/js\?|\/gtm\.js\?/i;

/** A GA4 measurement id or GTM container id, exactly as Google mints them. */
const LITERAL_ID = /\b(?:G|GT|GTM)-[A-Za-z0-9]+\b/g;

const idFromScriptSrc = (src: string): string | null => {
  try {
    return new URL(src).searchParams.get('id');
  } catch {
    return null;
  }
};

interface PageAnalyticsIds {
  readonly url: string;
  /** Every id this page's markup names, from either signal. */
  readonly ids: ReadonlySet<string>;
  /** An id whose own `gtag/js`/`gtm.js` script tag appears more than once. */
  readonly duplicated: readonly string[];
}

/**
 * What a page's markup says it loads, from two signals: a static
 * `gtag/js?id=`/`gtm.js?id=` script tag, and a `G-`/`GT-`/`GTM-` literal
 * inside an inline script (the classic GTM snippet builds its own script tag
 * in JavaScript, so its container id never appears in a static `src`).
 *
 * Only a repeated *tag* counts as loading an id twice: the standard GA4
 * install cites its id once in the script `src` and once more in an inline
 * `gtag('config', …)` call, and counting that ordinary pair as a duplicate
 * would fail every properly configured site. Two script tags for the same id
 * is the actual mistake this catches — the tag pasted in twice, most often by
 * a plugin and a template both installing it.
 */
const readPageAnalyticsIds = (page: CrawledPage): PageAnalyticsIds => {
  const extracted = page.extracted;
  const tagCounts = new Map<string, number>();
  if (extracted !== null) {
    for (const src of extracted.scripts) {
      if (!GTAG_OR_GTM_SRC.test(src)) continue;
      const id = idFromScriptSrc(src);
      if (id === null) continue;
      tagCounts.set(id, (tagCounts.get(id) ?? 0) + 1);
    }
  }

  const ids = new Set(tagCounts.keys());
  if (extracted !== null) {
    for (const script of extracted.inlineScripts) {
      for (const match of script.matchAll(LITERAL_ID)) ids.add(match[0]);
    }
  }

  return {
    url: page.normalizedUrl,
    ids,
    duplicated: [...tagCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id),
  };
};

const idSetKey = (ids: ReadonlySet<string>): string => [...ids].sort().join(',');

/**
 * 2.5 asks for the approved 0.4 instrumentation, correctly configured and
 * free of duplicate triggers — a live-payload and ownership review this
 * engine has no input for, which is why the check stays `assisted`. What raw
 * HTML does show is which GA4/GTM ids a page's markup actually cites: a tag
 * pasted in twice on one page, or pages naming different ids for what should
 * be one property, are both defects visible without reading a single event.
 * Retention, redaction, cross-domain wiring and deduplicated transaction ids
 * are the person's half.
 */
export const analyticsImplementation: SiteProbe = {
  id: 'analytics-implementation',
  scope: 'site',
  title: 'Pages agree on which GA4/GTM ids they load, and load each once',
  run({ crawl }) {
    const pages = crawl.pages
      .filter((page) => page.extracted !== null && page.fetch.status === 200)
      .map(readPageAnalyticsIds);

    const withDuplicates = pages.filter((page) => page.duplicated.length > 0);
    if (withDuplicates.length > 0) {
      return fail(
        `${withDuplicates.length} page(s) load the same analytics id more than once via a duplicate script tag.`,
        {
          pages: withDuplicates.map((page) => ({ url: page.url, ids: page.duplicated })),
        },
      );
    }

    const tagged = pages.filter((page) => page.ids.size > 0);
    if (tagged.length === 0) {
      return warn('No GA4 or GTM id was found on any page.', { pagesRead: pages.length });
    }

    const distinct = new Map<string, string>();
    for (const page of tagged) distinct.set(idSetKey(page.ids), page.url);
    if (distinct.size > 1) {
      return fail(
        `Pages disagree on which analytics id(s) they load: ${distinct.size} different combinations across ${tagged.length} page(s).`,
        {
          samples: [...distinct.entries()].slice(0, 5).map(([key, url]) => ({ url, ids: key.split(',') })),
        },
      );
    }

    const ids = [...(tagged[0]?.ids ?? [])];
    return pass(`${tagged.length} page(s) agree on the same analytics id(s): ${ids.join(', ')}.`, {
      pagesRead: tagged.length,
      ids,
    });
  },
};

// --- 2.6 consent-mode-config ---------------------------------------------

/** A `<script>` served from a known consent management platform. */
const CMP_HOSTS = [
  'cookiebot.com',
  'cdn.cookielaw.org',
  'cookielaw.org',
  'consent.trustarc.com',
  'trustarc.com',
  'cmp.quantcast.com',
  'quantcast.mgr.consensu.org',
  'fundingchoicesmessages.google.com',
  'consent.didomi.io',
  'sdk.privacy-center.org',
  'usercentrics.eu',
  'cmp.osano.com',
  'cdn.iubenda.com',
  'cdn-cookieyes.com',
  'app.termly.io',
  'sourcepoint.mgr.consensu.org',
  'sp-prod.net',
  'cc.cdn.civiccomputing.com',
];

const isCmpScript = (src: string): boolean => CMP_HOSTS.some((host) => src.includes(host));

/** An inline `gtag('consent', 'default', …)` call, however it is quoted or spaced. */
const CONSENT_DEFAULT_RE = /gtag\s*\(\s*['"]consent['"]\s*,\s*['"]default['"]/i;

/**
 * 2.6 asks that Consent Mode defaults apply in every state a visitor can
 * reach — first visit, accept, reject, partial, withdrawal, return — which is
 * runtime behaviour a raw crawl cannot exercise; that is why the check stays
 * `assisted`. What the markup does show, in document order, is the one thing
 * Google's own timing guidance calls out as a prerequisite for everything
 * else: a `gtag('consent', 'default', …)` call has to run before the gtag.js
 * or gtm.js script tag, or every event that script fires before the call
 * lands with no consent state attached to it at all. `Extracted.scriptTags`
 * exists for exactly this: `scripts`/`inlineScripts` split external from
 * inline and so lose which came first.
 */
export const consentModeConfig: PageProbe = {
  id: 'consent-mode-config',
  scope: 'page',
  htmlOnly: true,
  title: 'Consent defaults are set before a Google tag loads',
  run({ page }) {
    const extracted = page.extracted;
    if (extracted === null) return notApplicable(NO_HTML);

    const tagIndex = extracted.scriptTags.findIndex(
      (tag) => tag.src !== null && GTAG_OR_GTM_SRC.test(tag.src),
    );
    if (tagIndex === -1) {
      return notApplicable('No gtag.js/gtm.js script tag loads on this page.');
    }

    const before = extracted.scriptTags.slice(0, tagIndex);
    const after = extracted.scriptTags.slice(tagIndex);

    if (before.some((tag) => CONSENT_DEFAULT_RE.test(tag.text))) {
      return pass('Sets a consent default before the Google tag loads.');
    }
    if (after.some((tag) => CONSENT_DEFAULT_RE.test(tag.text))) {
      return fail('Sets a consent default only after the Google tag has already loaded.');
    }

    const cmp = extracted.scriptTags.find((tag) => tag.src !== null && isCmpScript(tag.src));
    if (cmp !== undefined) {
      return fail('Loads a consent banner but sets no gtag consent default anywhere on the page.', {
        cmpScript: cmp.src,
      });
    }

    return warn(
      'Loads a Google tag with no consent default and no known consent-banner script; confirm consent is out of scope for this page.',
    );
  },
};

// --- 3.13 review-integrity -------------------------------------------------

const ORGANIZATION_TYPES = new Set([
  'Organization',
  'LocalBusiness',
  'Corporation',
  'NGO',
  'NewsMediaOrganization',
]);

const cleanText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

const foldName = (value: string): string => value.trim().toLowerCase();

/** A `name`-bearing property, however JSON-LD ships it: a bare string or an embedded node. */
const namedProperty = (
  node: Record<string, unknown>,
  property: string,
): { readonly name: string | null } | null => {
  const value = node[property];
  if (typeof value === 'string') return { name: cleanText(value) };
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return { name: cleanText((value as Record<string, unknown>)['name']) };
  }
  return null;
};

interface ReviewDefect {
  readonly url: string;
  readonly issue: string;
}

/**
 * 3.13 asks for genuine provenance and moderation on reviews before they
 * ship — evidence of who requested them and how they are moderated, which
 * lives outside any one page and stays the person's to attest. What the
 * markup shows without that context is three defects visible on their face:
 * a `Review` whose `itemReviewed` names the site's own publisher rather than
 * a product or service (self-serving), a `Review` with no `author` at all,
 * and an `AggregateRating` that pairs a rating value with a `ratingCount` or
 * `reviewCount` of zero. A `Review` with no `datePublished` is not on this
 * list of face-value defects — Google's guidance does not require one — so
 * it only warns.
 */
export const reviewIntegrity: SiteProbe = {
  id: 'review-integrity',
  scope: 'site',
  title: 'Review and rating markup is attributed and not self-reviewed',
  run({ crawl }) {
    const selfNames = new Set<string>();
    for (const page of crawl.pages) {
      const extracted = page.extracted;
      if (extracted === null) continue;
      const siteName = extracted.openGraph['og:site_name'];
      if (siteName !== undefined && siteName.trim() !== '') selfNames.add(foldName(siteName));
      for (const node of jsonLdNodes(extracted.jsonLd)) {
        if (!typesOf(node).map(bareType).some((type) => ORGANIZATION_TYPES.has(type))) continue;
        const name = cleanText(node['name']);
        if (name !== null) selfNames.add(foldName(name));
      }
    }

    const selfServing: ReviewDefect[] = [];
    const noAuthor: ReviewDefect[] = [];
    const zeroCount: ReviewDefect[] = [];
    const noDate: ReviewDefect[] = [];
    let reviewNodes = 0;
    let htmlPages = 0;

    for (const page of crawl.pages) {
      const extracted = page.extracted;
      if (extracted === null) continue;
      htmlPages += 1;
      const url = page.normalizedUrl;

      for (const node of jsonLdNodes(extracted.jsonLd)) {
        const types = typesOf(node).map(bareType);
        const isReview = types.includes('Review');
        const isAggregate = types.includes('AggregateRating');
        if (!isReview && !isAggregate) continue;
        reviewNodes += 1;

        if (isReview) {
          const subject = namedProperty(node, 'itemReviewed');
          if (subject !== null && subject.name !== null && selfNames.has(foldName(subject.name))) {
            selfServing.push({ url, issue: `itemReviewed "${subject.name}" is the publishing organisation` });
          }
          const author = namedProperty(node, 'author');
          if (author === null || author.name === null) {
            noAuthor.push({ url, issue: 'no author' });
          }
          if (cleanText(node['datePublished']) === null) {
            noDate.push({ url, issue: 'no datePublished' });
          }
        }

        if (isAggregate) {
          const rating = node['ratingValue'];
          const count = node['ratingCount'] ?? node['reviewCount'];
          const countNumber = typeof count === 'string' ? Number(count) : count;
          const hasRating = rating !== undefined && rating !== null && cleanText(String(rating)) !== null;
          if (hasRating && typeof countNumber === 'number' && countNumber === 0) {
            zeroCount.push({ url, issue: 'ratingCount/reviewCount is 0 beside a rating value' });
          }
        }
      }
    }

    if (htmlPages === 0) return notApplicable('The crawl reached no HTML pages.');
    if (reviewNodes === 0) {
      return notApplicable('No Review or AggregateRating markup found on the crawl.');
    }

    const failures = [...selfServing, ...noAuthor, ...zeroCount];
    if (failures.length > 0) {
      return fail(
        `${failures.length} review/rating defect(s): ${selfServing.length} self-serving, ${noAuthor.length} with no author, ${zeroCount.length} with a zero count beside a rating.`,
        { selfServing, noAuthor, zeroCount },
      );
    }

    if (noDate.length > 0) {
      return warn(`${noDate.length} Review node(s) carry no datePublished.`, { noDate });
    }

    return pass(`${reviewNodes} Review/AggregateRating node(s) across ${htmlPages} page(s) show no integrity defects.`, {
      reviewNodes,
    });
  },
};

// --- 3.13 ugc-governance ----------------------------------------------------

const sample = <T>(items: readonly T[]): T[] => items.slice(0, 5);

/** The `rel` values Google reads as not passing an editorial endorsement on to a visitor's own link. */
const QUALIFIED_UGC_REL = /\b(ugc|nofollow)\b/i;

/**
 * 3.13 asks for moderation, publication thresholds and an escalation owner
 * behind public content — evidence that lives in a moderation queue and a
 * person's sign-off, which is why the check stays `assisted`. What raw
 * markup shows is the one qualification defect visible on its face: a page
 * carrying a comment or forum reply form, or a schema.org `Comment` node,
 * is a page carrying user-generated content, and an outbound link inside
 * that comment thread with no `ugc` or `nofollow` relationship passes a
 * visitor's own link on as if the site endorsed it. `not-applicable` where
 * the crawl found no UGC markup at all, on either signal.
 */
export const ugcGovernance: SiteProbe = {
  id: 'ugc-governance',
  scope: 'site',
  title: 'Outbound links inside comment/forum content are marked ugc or nofollow',
  run({ crawl, origin }) {
    const html = crawl.pages.filter((page) => page.extracted !== null && page.fetch.status === 200);
    if (html.length === 0) return notApplicable('No HTML pages were crawled.');

    let ugcPages = 0;
    const unqualified: { page: string; target: string }[] = [];

    for (const page of html) {
      const extracted = page.extracted;
      if (extracted === null) continue;

      const hasCommentSchema = jsonLdNodes(extracted.jsonLd).some((node) =>
        typesOf(node).map(bareType).includes('Comment'),
      );
      const hasCommentForm = extracted.commentRegions.some((region) => region.hasForm);
      if (!hasCommentForm && !hasCommentSchema) continue;
      ugcPages += 1;

      for (const region of extracted.commentRegions) {
        for (const link of region.links) {
          if (/^(mailto|tel):/i.test(link.url)) continue;
          if (isSameSite(link.url, origin)) continue;
          if (QUALIFIED_UGC_REL.test(link.rel ?? '')) continue;
          unqualified.push({ page: page.normalizedUrl, target: link.url });
        }
      }
    }

    if (ugcPages === 0) {
      return notApplicable('No comment/reply form and no Comment schema node found anywhere in the crawl.');
    }

    const data = { ugcPages, unqualifiedLinks: unqualified.length };
    if (unqualified.length > 0) {
      return fail(
        `${unqualified.length} outbound link(s) inside comment/forum content carry no ugc or nofollow relationship.`,
        { ...data, samples: sample(unqualified) },
      );
    }
    return pass(
      'Every outbound link inside comment/forum content is marked ugc or nofollow. Moderation and escalation are for a person.',
      data,
    );
  },
};

/** Each `@type` a page's JSON-LD declares (namespace stripped), with the `@id`s it appears under. */
const typeIds = (blocks: readonly unknown[]): Map<string, Set<string>> => {
  const found = new Map<string, Set<string>>();
  for (const node of jsonLdNodes(blocks)) {
    const id = typeof node['@id'] === 'string' ? node['@id'] : null;
    for (const type of typesOf(node)) {
      const key = bareType(type);
      const ids = found.get(key) ?? new Set<string>();
      if (id !== null) ids.add(id);
      found.set(key, ids);
    }
  }
  return found;
};

/**
 * Whether the structured data a page ships is the same before and after
 * scripts run, and whether it parses at all (4.6).
 *
 * A block that does not parse is invalid on either side, so `jsonLdErrors`
 * fails with or without a render: a crawl that never rendered still
 * observed the raw markup. With a render, a `@type` the raw JSON-LD
 * declares that is gone afterwards, or that comes back under a different
 * `@id`, fails: consumers that read the raw response and consumers that
 * render would disagree about what the page is. A `@type` only rendering
 * adds is a `warn`, since not every consumer renders. Which features the
 * markup makes a page eligible for, and the policy review, are a person's.
 */
export const schemaValidationParity: PageProbe = {
  id: 'schema-validation-parity',
  scope: 'page',
  htmlOnly: true,
  title: 'Structured data parses, and raw and rendered responses declare the same types',
  run({ page }) {
    const raw = page.extracted;
    if (raw === null) return notApplicable(NO_HTML);
    const rendered = page.rendered;
    const renderedExtracted = rendered?.render.error === null ? (rendered.extracted ?? null) : null;

    const failures: string[] = [];
    const data: Record<string, unknown> = {};

    if (raw.jsonLdErrors > 0) {
      failures.push(`${raw.jsonLdErrors} raw JSON-LD block(s) failed to parse`);
      data['rawJsonLdErrors'] = raw.jsonLdErrors;
    }
    if (renderedExtracted !== null && renderedExtracted.jsonLdErrors > 0) {
      failures.push(`${renderedExtracted.jsonLdErrors} rendered JSON-LD block(s) failed to parse`);
      data['renderedJsonLdErrors'] = renderedExtracted.jsonLdErrors;
    }

    const added: string[] = [];
    if (renderedExtracted !== null) {
      const rawTypes = typeIds(raw.jsonLd);
      const renderedTypes = typeIds(renderedExtracted.jsonLd);
      const gone = [...rawTypes.keys()].filter((type) => !renderedTypes.has(type));
      const changed = [...rawTypes.entries()]
        .filter(([type, ids]) => {
          const after = renderedTypes.get(type);
          return after !== undefined && [...ids].some((id) => !after.has(id));
        })
        .map(([type]) => type);
      if (gone.length > 0) {
        failures.push(`@type ${gone.join(', ')} in the raw JSON-LD is gone after rendering`);
        data['goneTypes'] = gone;
      }
      if (changed.length > 0) {
        failures.push(`@type ${changed.join(', ')} appears with a different @id after rendering`);
        data['changedIdTypes'] = changed;
      }
      added.push(...[...renderedTypes.keys()].filter((type) => !rawTypes.has(type)));
    }

    if (failures.length > 0) return fail(`Structured data is invalid or unstable: ${failures.join('; ')}.`, data);
    if (rendered !== undefined && rendered !== null && renderedExtracted === null) {
      return errored(
        rendered.render.error !== null
          ? `Rendering failed: ${rendered.render.error}; the raw JSON-LD parses, but parity was not checked.`
          : 'The rendered response was empty or not HTML, so its structured data was not compared.',
      );
    }
    if (added.length > 0) {
      return warn(
        `@type ${added.join(', ')} exists only after rendering; a consumer that does not render never sees it.`,
        { addedTypes: added },
      );
    }
    return pass(
      renderedExtracted === null
        ? 'Every raw JSON-LD block parses. No render was captured, so parity was not checked.'
        : 'Every JSON-LD block parses, and raw and rendered declare the same types.',
    );
  },
};

export const markupProbes = [
  schemaValidationParity,
  semanticHtml,
  headingOutline,
  primaryHeading,
  crawlableLinks,
  langAttribute,
  soft404,
  analyticsImplementation,
  consentModeConfig,
  reviewIntegrity,
  ugcGovernance,
];
