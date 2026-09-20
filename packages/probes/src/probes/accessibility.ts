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

import { inputRecordProblem } from '@seo/core';
import type { Extracted } from '@seo/crawler';

import type { PageProbe, SiteProbe } from '../types.js';
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

/**
 * The manual evaluation behind 4.4: what a person found that axe cannot, and
 * what they claim as a result. It is supplied (`a11yEvaluation`), never
 * observed. Fails an open blocker, and a conformance claim standing beside any
 * critical axe violation the crawl recorded, since a claim the tool contradicts
 * is not one to launch on. Absent is `not-applicable`; a record with no owner
 * or past its review holds the check with a warn. The check is `assisted`, so
 * even a pass is a proposal.
 */
export const manualA11yEvaluation: SiteProbe = {
  id: 'manual-a11y-evaluation',
  scope: 'site',
  title: 'The manual accessibility evaluation has no open blocker and no claim axe contradicts',
  run({ crawl, inputs }) {
    const record = inputs?.a11yEvaluation;
    if (record === undefined) return notApplicable('No manual accessibility evaluation was supplied.');

    const open = record.blockers.filter((blocker) => !blocker.resolved);
    const claim = record.conformanceClaim.trim();
    const critical: { url: string; ids: string[] }[] = [];
    let audited = 0;
    for (const page of crawl.pages) {
      const result = page.rendered?.render.accessibility;
      if (result === undefined || result.error !== null) continue;
      audited += 1;
      const ids = result.violations.filter((v) => v.impact === 'critical').map((v) => v.id);
      if (ids.length > 0) critical.push({ url: page.normalizedUrl, ids });
    }
    const data = {
      scope: record.scope,
      methods: record.methods,
      limitations: record.limitations,
      conformanceClaim: claim,
      blockers: record.blockers.length,
      openBlockers: open.map((blocker) => ({ criterion: blocker.criterion, url: blocker.url })),
      pagesAudited: audited,
      criticalViolations: critical.slice(0, 10),
    };

    const failures: string[] = [];
    if (open.length > 0) {
      failures.push(`${open.length} accessibility blocker(s) are still open (${open.slice(0, 3).map((b) => b.criterion).join(', ')})`);
    }
    if (claim !== '' && critical.length > 0) {
      failures.push(`the evaluation claims "${claim}" while axe found critical violations on ${critical.length} page(s)`);
    }
    if (failures.length > 0) return fail(`${failures.join('; ')}.`, data);

    const at = crawl.crawledAt ?? null;
    const held = at === null ? (record.owner.trim() === '' ? 'no owner' : null) : inputRecordProblem(record, new Date(at));
    if (held !== null) return warn(`The manual accessibility evaluation is held for review (${held}).`, data);
    if (claim !== '' && audited === 0) {
      return warn(`The evaluation claims "${claim}", but axe was not run on any page, so the claim could not be set against it.`, data);
    }
    return pass(
      `No open blocker across ${record.blockers.length} recorded${claim === '' ? ', and no conformance claim is made' : `, and axe contradicts no "${claim}" claim`}. A person still confirms the evaluation's scope and limitations.`,
      data,
    );
  },
};

/**
 * The phone render against the desktop one: corpus check 4.3.
 *
 * Google indexes the mobile rendering, so what a phone drops is what search
 * never sees. The baseline is the desktop render when the crawl made one, else
 * the raw extraction. Fails what a phone loses outright: the title, the first
 * h1, the canonical, or an added noindex. Warns on a missing viewport meta and
 * on a phone losing half the words or links, which may be a leaner layout or
 * content hidden behind interaction. 4.3 is `assisted`: forms, focus, error and
 * zoom states are a person on a real phone, so this never passes the check.
 */
const firstH1 = (extracted: Extracted): string | null =>
  extracted.headings.find((heading) => heading.level === 1)?.text.trim() || null;

const hasNoindex = (extracted: Extracted): boolean => /\bnoindex\b/i.test(extracted.metaRobots ?? '');

const lostHalf = (desktop: number, mobile: number): boolean => desktop >= 10 && mobile * 2 < desktop;

export const mobileJourneyQa: PageProbe = {
  id: 'mobile-journey-qa',
  scope: 'page',
  htmlOnly: true,
  title: 'The mobile render keeps the signals and content the desktop one has',
  run({ page }) {
    const mobile = page.renderedMobile;
    if (mobile === undefined || mobile === null) {
      return notApplicable('No mobile render was captured for this page; mobile rendering was not requested.');
    }
    if (mobile.render.error !== null) return errored(`The mobile render failed: ${mobile.render.error}.`);
    const phone = mobile.extracted;
    if (phone === null) return errored('The mobile render returned no HTML to read.');
    const desktopRender = page.rendered?.extracted ?? null;
    const desktop = desktopRender ?? page.extracted;
    if (desktop === null) return notApplicable('No desktop extraction to compare the mobile render against.');
    const baseline = desktopRender === null ? 'raw fetch' : 'desktop render';

    const failures: string[] = [];
    const doubts: string[] = [];
    const data: Record<string, unknown> = {
      baseline,
      words: { desktop: desktop.wordCount, mobile: phone.wordCount },
      links: { desktop: desktop.links.length, mobile: phone.links.length },
    };

    if (desktop.title !== null && desktop.title !== '' && (phone.title === null || phone.title === '')) {
      failures.push('the mobile render drops the title');
    }
    if (firstH1(desktop) !== null && firstH1(phone) === null) failures.push('the mobile render drops the first h1');
    if (desktop.canonical !== null && phone.canonical === null) failures.push('the mobile render drops the canonical');
    if (hasNoindex(phone) && !hasNoindex(desktop)) failures.push('the mobile render adds a noindex');

    if (!phone.hasViewportMeta) doubts.push('the page declares no viewport meta, so a phone shows the desktop layout');
    if (lostHalf(desktop.wordCount, phone.wordCount)) {
      doubts.push(`the mobile render has ${phone.wordCount} words against ${desktop.wordCount}`);
    }
    if (lostHalf(desktop.links.length, phone.links.length)) {
      doubts.push(`the mobile render has ${phone.links.length} links against ${desktop.links.length}`);
    }

    if (failures.length > 0) {
      return fail(
        `Mobile-first indexing reads what a phone gets: ${[...failures, ...doubts].join('; ')} (against the ${baseline}).`,
        data,
      );
    }
    if (doubts.length > 0) {
      return warn(`For a person to settle: ${doubts.join('; ')} (against the ${baseline}).`, data);
    }
    return pass(
      `The mobile render keeps the title, h1, canonical and indexability of the ${baseline}, and most of its words and links. Forms, focus, error and zoom states on a real phone are for a person.`,
      data,
    );
  },
};

export const accessibilityProbes = [contentAccessibility, axeAccessibility, manualA11yEvaluation, mobileJourneyQa];
