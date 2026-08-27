/**
 * Document structure: the parts of the HTML a crawler has to be able to read
 * before anything else in an audit means much.
 *
 * Each of these declares `htmlOnly`, so the runner skips non-HTML responses;
 * the null check inside is the type-level restatement of that, not a second
 * policy.
 */

import { isSameSite } from '@seo/crawler';
import type { PageProbe } from '../types.js';
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

export const markupProbes = [
  semanticHtml,
  headingOutline,
  primaryHeading,
  crawlableLinks,
  langAttribute,
  soft404,
];
