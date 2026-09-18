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
import { fail, notApplicable, pass, warn } from '../types.js';

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

export const markupProbes = [
  semanticHtml,
  headingOutline,
  primaryHeading,
  crawlableLinks,
  langAttribute,
  soft404,
  analyticsImplementation,
  consentModeConfig,
];
