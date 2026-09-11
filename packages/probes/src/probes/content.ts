/**
 * Answer-first formatting and entity clarity: corpus check 3.9, read from markup.
 *
 * 3.9 asks that a machine and a hurried human can take a correct, attributable
 * answer from a page — descriptive subheadings, direct answers near their
 * questions, sources where claims need them — and that articles say who wrote
 * them and when. Its "Done when" closes on a reader's judgement: whether the
 * page *answers* its query, which claims *need* support, where readers would
 * *reasonably expect* a byline. 3.9 is triaged `assisted` for that reason (see
 * ROADMAP, 2026-09-11), so these two detectors fail only what is false on its
 * face and hold the rest for a person.
 *
 * Split by artefact, as 2.14 is: `answer-first-structure` judges one page's
 * reading matter, and `author-date-signals` judges what a site's articles
 * claim about themselves — including the one thing no page can see about
 * itself, a date a template stamped on every article.
 */

import type { Extracted } from '@seo/crawler';
import type { PageProbe, SiteProbe } from '../types.js';
import { errored, fail, notApplicable, pass, warn } from '../types.js';
import { jsonLdNodes, typesOf } from './metadata.js';

const NO_HTML = 'No HTML was parsed for this response.';

/** schema.org's Article and every type beneath it. */
const ARTICLE_TYPES = new Set([
  'Article', 'AdvertiserContentArticle', 'SatiricalArticle', 'Report',
  'NewsArticle', 'AnalysisNewsArticle', 'AskPublicNewsArticle', 'BackgroundNewsArticle',
  'OpinionNewsArticle', 'ReportageNewsArticle', 'ReviewNewsArticle',
  'ScholarlyArticle', 'MedicalScholarlyArticle', 'TechArticle', 'APIReference',
  'SocialMediaPosting', 'BlogPosting', 'LiveBlogPosting', 'DiscussionForumPosting',
]);

/** `https://schema.org/BlogPosting` and `schema:BlogPosting` are both `BlogPosting`. */
const bareType = (type: string): string => type.replace(/^.*[/:#]/, '');

/** The first node on a page that declares an Article type, or null. */
const articleNode = (blocks: readonly unknown[]): Record<string, unknown> | null =>
  jsonLdNodes(blocks).find((node) => typesOf(node).some((type) => ARTICLE_TYPES.has(bareType(type)))) ?? null;

/**
 * Whether the page says it is an article: an Article type in structured data,
 * or an Open Graph article with a publication time.
 *
 * `og:type=article` alone is not enough, because WordPress SEO plugins set it
 * on every single page, the contact page included. A publication time is the
 * claim that the page was published as a piece, which a contact page does not
 * make — and it is exactly how sites with no structured data at all declare
 * their articles: Smashing Magazine and WordPress's own news, checked live.
 */
const declaresArticle = (extracted: Extracted): boolean =>
  articleNode(extracted.jsonLd) !== null ||
  (/^article$/i.test(extracted.openGraph['og:type'] ?? '') && text(extracted.authorship.publishedTime) !== null);

const sample = <T>(items: readonly T[]): T[] => items.slice(0, 5);

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
};

// --- answer-first-structure ------------------------------------------------

/** Reading matter shorter than this needs no signposts, unless it says it is an article. */
const SIGNPOSTED_WORDS = 300;

/** Reading matter this long under no subheading is a wall. */
const WALL_WORDS = 600;

/**
 * A heading that asks something. Only a question mark counts: "How to fit a
 * tap" is a task, answered by the steps under it whatever they are called.
 */
const isQuestion = (text: string): boolean => /[?？]\s*$/u.test(text);

export const answerFirstStructure: PageProbe = {
  id: 'answer-first-structure',
  scope: 'page',
  htmlOnly: true,
  title: 'Reading matter is signposted, and every question it asks is answered beneath it',
  run({ page }) {
    const extracted = page.extracted;
    if (extracted === null) return notApplicable(NO_HTML);
    if (page.fetch.status !== 200) return notApplicable('Response was not a 200.');
    if (page.fetch.truncated) {
      return errored('The body was cut at the size limit, so the end of its reading matter was never read.');
    }

    const { sections, links } = extracted.content;
    const words = sections.reduce((sum, section) => sum + section.words, 0);
    const article = declaresArticle(extracted);
    if (!article && words < SIGNPOSTED_WORDS) {
      return notApplicable(`${words} words of reading matter and no article declared: too little to need signposts.`);
    }

    const subheadings = sections.filter((section) => (section.heading?.level ?? 1) >= 2).length;
    const questions = sections.filter((section) => isQuestion(section.heading?.text ?? ''));
    const unanswered = questions.filter((section) => {
      if (section.words > 0 || section.heading === null) return false;
      // "Which size?" answered by subsections called "Small" and "Large" is answered.
      const next = sections[sections.indexOf(section) + 1];
      return next?.heading == null || next.heading.level <= section.heading.level;
    });
    const host = hostOf(page.fetch.finalUrl);
    const outbound = links.filter((url) => {
      const other = hostOf(url);
      return other !== null && other !== host;
    });

    const data: Record<string, unknown> = {
      words,
      subheadings,
      questionHeadings: questions.length,
      outboundLinks: outbound.length,
      article,
    };
    const doubts: string[] = [];
    if (words >= WALL_WORDS && subheadings === 0) {
      doubts.push(
        `${words} words of reading matter under no subheading, so nothing lets a reader or a machine find the part that answers them`,
      );
    }
    if (unanswered.length > 0) {
      doubts.push(
        `${unanswered.length} question heading(s) have no text before the next heading — an answer loaded by script, or none at all`,
      );
      data['unanswered'] = sample(unanswered.map((section) => section.heading?.text));
    }

    if (doubts.length > 0) return warn(`For a person to settle: ${doubts.join('; ')}.`, data);
    const answered = questions.length === 0 ? '' : `, and each of its ${questions.length} question heading(s) has text beneath it`;
    return pass(
      `${words} words under ${subheadings} subheading(s)${answered}. ` +
        'Whether the text answers the query, and whether its claims carry sources, is for a person.',
      data,
    );
  },
};

// --- author-date-signals ---------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** One value shared by this share of the articles declaring one is a template's stamp... */
const STAMP_SHARE = 0.8;

/** ...once there are at least this many, so three stories from one morning are not a pattern. */
const STAMP_MIN = 5;

/** A value carrying a time of day. Only these can be a stamp: a news site publishes many stories on one date. */
const hasTime = (value: string): boolean => /\d{1,2}:\d{2}/.test(value);

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/**
 * Who a schema.org `author` names: a string, a Person or Organization, or a
 * list of them. A bare `@id` counts — Yoast writes the author as a reference
 * to a Person described elsewhere in the graph, and that still names someone.
 */
function authorName(value: unknown): string | null {
  for (const item of [value].flat()) {
    const direct = text(item);
    if (direct !== null) return direct;
    if (typeof item === 'object' && item !== null) {
      const record = item as Record<string, unknown>;
      const named = text(record['name']) ?? text(record['@id']);
      if (named !== null) return named;
    }
  }
  return null;
}

/** A date an article declares about itself, and where. */
interface DeclaredDate {
  readonly field: 'datePublished' | 'dateModified' | 'article:published_time' | 'article:modified_time';
  readonly value: string;
}

/** A modification dated more than a day before the publication, so no timezone explains it. */
const reversed = (published: DeclaredDate | undefined, modified: DeclaredDate | undefined): boolean =>
  published !== undefined &&
  modified !== undefined &&
  Date.parse(modified.value) < Date.parse(published.value) - DAY_MS;

/** The value most articles share, if it is shared widely enough to be a stamp. */
function stampOf(values: readonly string[]): { value: string; count: number } | null {
  const timed = values.filter(hasTime);
  if (timed.length < STAMP_MIN) return null;
  const counts = new Map<string, number>();
  for (const value of timed) counts.set(value, (counts.get(value) ?? 0) + 1);
  const [value, count] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  return count >= STAMP_MIN && count / values.length >= STAMP_SHARE ? { value, count } : null;
}

export const authorDateSignals: SiteProbe = {
  id: 'author-date-signals',
  scope: 'site',
  title: 'Articles say who wrote them and when, truthfully and one by one',
  run({ crawl }) {
    const unreadable: { url: string; field: string; value: string }[] = [];
    const backwards: { url: string; published: string; modified: string }[] = [];
    const future: { url: string; field: string; value: string; served: string }[] = [];
    const noAuthor: string[] = [];
    const noDate: string[] = [];
    const published: string[] = [];
    const modified: string[] = [];
    const authorFrom: Record<string, number> = {};
    let articles = 0;
    let typedArticles = 0;
    let cut = 0;

    for (const page of crawl.pages) {
      const extracted = page.extracted;
      if (extracted === null || page.fetch.status !== 200) continue;
      if (!declaresArticle(extracted)) continue;
      const typed = articleNode(extracted.jsonLd);
      const node = typed ?? {};
      // A byline or a <time> past the cut was never read, and absent is not missing.
      if (page.fetch.truncated) {
        cut += 1;
        continue;
      }
      articles += 1;
      const url = page.normalizedUrl;
      const { authorship } = extracted;

      const author = (
        [
          ['structured data', authorName(node['author'])],
          ['byline', authorship.byline],
          ['meta author', authorship.metaAuthor],
          ['article:author', text(authorship.articleAuthor)],
        ] as const
      ).find(([, name]) => name !== null);
      // An Open Graph article with a date is also what a static-site template
      // writes on every dated page, product pages included (Smashing Magazine's
      // ebook bundles), so only an article typed in structured data is expected
      // to name its author. Its dates are judged either way.
      if (typed !== null) typedArticles += 1;
      if (author !== undefined) authorFrom[author[0]] = (authorFrom[author[0]] ?? 0) + 1;
      else if (typed !== null) noAuthor.push(url);

      const declared = (
        [
          { field: 'datePublished', value: text(node['datePublished']) },
          { field: 'dateModified', value: text(node['dateModified']) },
          { field: 'article:published_time', value: text(authorship.publishedTime) },
          { field: 'article:modified_time', value: text(authorship.modifiedTime) },
        ] as const
      ).filter((date): date is DeclaredDate => date.value !== null);
      if (declared.length === 0 && authorship.times.length === 0) noDate.push(url);

      const readable = declared.filter((date) => {
        if (!Number.isNaN(Date.parse(date.value))) return true;
        unreadable.push({ url, ...date });
        return false;
      });
      const find = (field: DeclaredDate['field']): DeclaredDate | undefined =>
        readable.find((date) => date.field === field);
      for (const [from, to] of [
        [find('datePublished'), find('dateModified')],
        [find('article:published_time'), find('article:modified_time')],
      ] as const) {
        if (reversed(from, to)) backwards.push({ url, published: from?.value ?? '', modified: to?.value ?? '' });
      }

      // The server's own clock, so a replayed crawl reaches the same verdict it did the day it ran.
      const served = page.fetch.headers['date'];
      const now = served === undefined ? Number.NaN : Date.parse(served);
      if (served !== undefined && !Number.isNaN(now)) {
        for (const date of readable) {
          if (Date.parse(date.value) > now + DAY_MS) future.push({ url, ...date, served });
        }
      }

      const firstPublished = find('datePublished') ?? find('article:published_time');
      const lastModified = find('dateModified') ?? find('article:modified_time');
      if (firstPublished !== undefined) published.push(firstPublished.value);
      if (lastModified !== undefined) modified.push(lastModified.value);
    }

    if (articles === 0) {
      if (cut > 0) {
        return errored(`${cut} article page(s) were cut at the size limit, and no other crawled page declares an article.`);
      }
      return notApplicable(
        'No crawled page declares itself an article, in structured data or as an Open Graph article with a publication time, so none claims to be the kind of content readers expect a byline or a date on.',
      );
    }

    const data: Record<string, unknown> = { articles, authorFrom };
    if (cut > 0) data['cutAtSizeLimit'] = cut;

    const defects: string[] = [];
    if (unreadable.length > 0) {
      defects.push(`${unreadable.length} declared date(s) are not dates`);
      data['unreadable'] = sample(unreadable);
    }
    if (backwards.length > 0) {
      defects.push(`${backwards.length} article(s) say they were modified before they were published`);
      data['modifiedBeforePublished'] = sample(backwards);
    }
    if (future.length > 0) {
      defects.push(`${future.length} declared date(s) are later than the server's own clock`);
      data['future'] = sample(future);
    }

    const doubts: string[] = [];
    if (noAuthor.length > 0) {
      doubts.push(`${noAuthor.length} of ${typedArticles} article(s) typed in structured data name no author anywhere`);
      data['noAuthor'] = sample(noAuthor);
    }
    if (noDate.length > 0) {
      doubts.push(`${noDate.length} of ${articles} article(s) carry no date anywhere`);
      data['noDate'] = sample(noDate);
    }
    for (const [label, values] of [['publish', published], ['modified', modified]] as const) {
      const stamp = stampOf(values);
      if (stamp === null) continue;
      doubts.push(
        `${stamp.count} of ${values.length} article(s) declare the same ${label} date, ${stamp.value} — a template's stamp rather than a date anyone ${label === 'publish' ? 'published' : 'revised'} them`,
      );
      data[`${label}Stamp`] = stamp;
    }

    if (defects.length > 0) {
      return fail(`Dates that cannot be true: ${[...defects, ...doubts].join('; ')}.`, data);
    }
    if (doubts.length > 0) return warn(`For a person to settle: ${doubts.join('; ')}.`, data);
    const named = typedArticles === 0 ? '' : `, and the ${typedArticles} typed in structured data each name an author`;
    return pass(
      `${articles} article(s) carry dates, none contradicting itself or recurring as a stamp${named}. ` +
        'Whether the authors are accurate and the dates meaningful is for a person.',
      data,
    );
  },
};

export const contentProbes = [answerFirstStructure, authorDateSignals];
