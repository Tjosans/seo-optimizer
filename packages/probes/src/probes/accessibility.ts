/**
 * Content accessibility: corpus check 3.11, read from markup.
 *
 * 3.11 asks that content stay understandable "with images, sound or styling
 * unavailable" — which is what a screen reader, a text browser, a slow
 * connection and a search engine all have in common. Markup settles whether
 * the alternatives exist: a link has a name, an image has alt, a table has
 * headers, the language is declared. Whether they are *accurate* — alt text
 * that says what the image shows, captions that match the speech, language
 * plain enough for its readers — is a person reading the page, and 3.11 is
 * triaged `assisted` for exactly that reason (see ROADMAP, 2026-09-11). This
 * detector fails what it can see is missing and proposes the rest.
 *
 * It is the only detector behind 3.11, so every barrier the check names that
 * markup can show is reported here — including ones other checks read for
 * their own reasons: image alt for image search (2.2, `image-alt-quality`),
 * the language for international targeting (1.14, `lang-attribute`), captions
 * for media (1.9, `media-alternatives`). One fact, two checks, two reasons.
 *
 * Failures are what WCAG level A calls failures outright. Warnings are what
 * needs a person to settle: generic link text is allowed when the surrounding
 * sentence gives the purpose, a table without headers may be layout, and a
 * video without a caption track may have its captions burned into the picture.
 */

import type { PageProbe } from '../types.js';
import { errored, fail, notApplicable, pass, warn } from '../types.js';

/**
 * Link text that names an action and not a destination, in the languages the
 * engine is most often pointed at. Matched whole, after trimming punctuation
 * and arrows, so "Read more about returns" is descriptive and "Read more »"
 * is not.
 */
const GENERIC_LINK_TEXT = new Set([
  // English
  'click here', 'click', 'here', 'read more', 'more', 'learn more', 'more info',
  'more information', 'details', 'link', 'this link', 'this', 'go', 'continue',
  'see more', 'view more', 'find out more',
  // Swedish
  'klicka här', 'här', 'läs mer', 'mer', 'se mer', 'visa mer', 'mer info', 'länk',
  // German
  'hier', 'hier klicken', 'mehr', 'weiterlesen', 'mehr erfahren', 'mehr lesen',
  // French
  'ici', 'cliquez ici', 'en savoir plus', 'lire la suite', 'plus', 'suite',
  // Spanish
  'aquí', 'haga clic aquí', 'haz clic aquí', 'leer más', 'más', 'ver más', 'saber más',
  // Dutch
  'klik hier', 'lees meer', 'meer',
]);

const normalizeLinkText = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[\s.,:;!?…»«›‹→←>|"'()[\]-]+$/u, '')
    .replace(/^[\s.,:;!?…»«›‹→←>|"'()[\]-]+/u, '')
    .replace(/\s+/g, ' ');

const sample = <T>(items: readonly T[]): T[] => items.slice(0, 5);

export const contentAccessibility: PageProbe = {
  id: 'content-accessibility',
  scope: 'page',
  htmlOnly: true,
  title: 'Content stays understandable with images, sound or styling unavailable',
  run({ page }) {
    const extracted = page.extracted;
    if (extracted === null) return notApplicable('No HTML was parsed for this response.');
    if (page.fetch.status !== 200) return notApplicable('Response was not a 200.');

    const barriers: string[] = [];
    const doubts: string[] = [];
    const data: Record<string, unknown> = {};

    const nameless = extracted.links.filter((link) => link.name === '');
    if (nameless.length > 0) {
      barriers.push(`${nameless.length} link(s) have no accessible name`);
      data['namelessLinks'] = sample(nameless.map((link) => link.href));
    }

    const unlabelled = extracted.images.filter((image) => image.alt === null && !image.altExempt);
    if (unlabelled.length > 0) {
      barriers.push(`${unlabelled.length} image(s) have no alt attribute`);
      data['imagesWithoutAlt'] = sample(unlabelled.map((image) => image.src));
    }

    if (extracted.lang === null || extracted.lang.trim() === '') {
      barriers.push('the page declares no language, so a screen reader guesses its pronunciation');
    }

    const generic = extracted.links.filter((link) => GENERIC_LINK_TEXT.has(normalizeLinkText(link.name)));
    if (generic.length > 0) {
      doubts.push(`${generic.length} link(s) are named only "${normalizeLinkText(generic[0]?.name ?? '')}" or similar`);
      data['genericLinks'] = sample(generic.map((link) => ({ name: link.name, href: link.href })));
    }

    const headerless = extracted.tables.filter(
      (table) => !table.presentational && !table.hasHeaders && table.rows >= 2 && table.columns >= 2,
    );
    if (headerless.length > 0) {
      doubts.push(`${headerless.length} table(s) of two or more rows and columns have no header cells`);
      data['tablesWithoutHeaders'] = sample(headerless);
    }

    const uncaptioned = extracted.media.filter((media) => media.kind === 'video' && !media.hasCaptions);
    if (uncaptioned.length > 0) {
      doubts.push(`${uncaptioned.length} video(s) carry no caption track`);
      data['videosWithoutCaptions'] = sample(uncaptioned.map((media) => media.src));
    }

    if (barriers.length > 0) {
      return fail(
        `Barriers to reading this page without images, sound or styling: ${[...barriers, ...doubts].join('; ')}.`,
        data,
      );
    }
    if (doubts.length > 0) {
      return warn(`For a person to settle: ${doubts.join('; ')}.`, data);
    }
    return pass(
      'Markup shows no barrier: links and images have text alternatives, tables have headers, and the language is declared. Whether the alternatives are accurate is for a person.',
      {
        links: extracted.links.length,
        images: extracted.images.length,
        tables: extracted.tables.length,
        videos: extracted.media.filter((media) => media.kind === 'video').length,
      },
    );
  },
};

/**
 * axe-core against the settled DOM: corpus check 4.4.
 *
 * axe reads what a browser built, scripts included, so it sees contrast, ARIA
 * and focus problems markup alone cannot. It also covers only a fraction of
 * WCAG; 4.4 says "a tool score alone is insufficient" and is triaged
 * `assisted`. So this fails what axe grades `critical` or `serious`, warns on
 * the rest, and never reports a clean run as a conformance claim.
 */
const BLOCKING_IMPACTS = new Set(['critical', 'serious']);

export const axeAccessibility: PageProbe = {
  id: 'axe-accessibility',
  scope: 'page',
  htmlOnly: true,
  title: 'Rendered pages carry no critical or serious axe-core violations',
  run({ page }) {
    const result = page.rendered?.render.accessibility;
    if (result === undefined) {
      return notApplicable('axe-core was not run on this page; accessibility rendering was not requested.');
    }
    if (result.error !== null) return errored(`axe-core could not run: ${result.error}.`);

    const blocking = result.violations.filter((v) => v.impact !== null && BLOCKING_IMPACTS.has(v.impact));
    const others = result.violations.filter((v) => v.impact === null || !BLOCKING_IMPACTS.has(v.impact));
    const data = { violations: result.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes })) };

    if (blocking.length > 0) {
      return fail(
        `axe-core found ${blocking.length} critical or serious violation(s): ${blocking.map((v) => v.id).join(', ')}.` +
          (others.length > 0 ? ` A further ${others.length} lesser one(s) need a person.` : ''),
        data,
      );
    }
    if (others.length > 0) {
      return warn(
        `axe-core found ${others.length} moderate or minor violation(s): ${others.map((v) => v.id).join(', ')}. For a person to settle.`,
        data,
      );
    }
    return pass(
      'axe-core found no violations on the rendered page. That is not a conformance claim: axe covers only part of WCAG, and a person evaluates the rest.',
      data,
    );
  },
};

export const accessibilityProbes = [contentAccessibility, axeAccessibility];
