/**
 * News: the part of corpus check 2.18 a crawl can read for itself.
 *
 * 2.18 is two subjects under one gate, which is why it declares two detectors.
 * `news-article-policy` is the publisher's side — accountable bylines, original
 * dates, advertising told apart from editorial — and is not built. This file is
 * the feed's side: `news-sitemap`, which asks whether a news sitemap the site
 * publishes follows the rules Google sets for one.
 *
 * Those rules are few and mechanical, which is what makes them answerable here:
 * news metadata only on articles from the last two days, at most 1,000 news
 * entries in a file, and on every entry a publication name, a language, an
 * original publication date and a title. Whether the site should have a news
 * sitemap at all is not among them. v5.0 says outright that ordinary websites
 * need none and that an intentionally empty feed is acceptable, so neither
 * absence nor emptiness is a finding — what is a finding is a feed that is
 * published and wrong.
 */

import { isSameSite } from '@seo/crawler';
import type { SitemapNewsEntry } from '@seo/crawler';
import type { SiteProbe } from '../types.js';
import { errored, fail, notApplicable, pass, warn } from '../types.js';
import { checkLanguageTag } from './language-tags.js';

/** Google's ceiling on `<news:news>` entries in one sitemap file. */
export const NEWS_ENTRIES_PER_FILE = 1000;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** How long an article may carry news metadata: two days from publication. */
export const NEWS_WINDOW_MS = 2 * DAY;

/**
 * How far past the window an entry is held with a warning rather than failed.
 *
 * A feed regenerated from "published in the last two days" and cached, or
 * pruned once a day, carries entries a few hours or most of a day past the
 * window, and Google tolerates it. A feed still carrying an article three days
 * on is not being pruned at all.
 */
const WINDOW_GRACE_MS = DAY;

/** How far ahead of the fetch a publication date may sit before it is false. */
const CLOCK_SKEW_MS = HOUR;

/**
 * A sitemap whose address says news: `news-sitemap.xml`, `sitemap_news.xml`,
 * `/news/sitemap.xml`. `newsletter` and `newsroom` are not.
 */
const NEWS_NAMED = /(^|[^a-z])news([^a-z]|$)/i;

/**
 * Google's publication-date formats: a W3C complete date, or one with hours and
 * minutes, optional seconds and fraction, and a time zone. A year or a month on
 * its own is W3C but not accepted here, and a time without a zone names no
 * instant at all.
 */
const W3C_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

/**
 * The span of instants a publication date can denote, or null when it is not
 * a date in Google's format.
 *
 * A date with a time and zone is one instant. A date alone is a calendar day
 * somewhere on Earth, which runs from its midnight at UTC+14 to its last
 * moment at UTC−12 — and judging it at either edge would call a feed in the
 * site's own time zone stale or early by up to a day. Using the reading most
 * favourable to the site keeps every verdict one no reading could escape.
 */
function publicationSpan(value: string): { earliest: number; latest: number } | null {
  const match = W3C_DATE.exec(value.trim());
  if (match === null) return null;
  const [, year, month, day, hours, minutes, seconds] = match;
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  // Date.parse rolls 30 February over into March; a date that does not exist
  // is not a date.
  const calendar = new Date(Date.UTC(y, m - 1, d));
  if (calendar.getUTCMonth() !== m - 1 || calendar.getUTCDate() !== d) return null;
  if (hours !== undefined && (Number(hours) > 23 || Number(minutes) > 59 || Number(seconds ?? 0) > 59)) {
    return null;
  }

  if (hours === undefined) {
    return {
      earliest: Date.parse(`${value.trim()}T00:00:00+14:00`),
      latest: Date.parse(`${value.trim()}T23:59:59.999-12:00`),
    };
  }
  const instant = Date.parse(value.trim());
  return Number.isNaN(instant) ? null : { earliest: instant, latest: instant };
}

type LanguageVerdict = { readonly ok: true } | { readonly ok: false; readonly severity: 'fail' | 'warn'; readonly problem: string };

/**
 * Whether `news:language` is a code Google reads.
 *
 * Google asks for an ISO 639 code of two or three letters, with `zh-cn` and
 * `zh-tw` the only regional forms. A two-letter code is checked against ISO
 * 639-1, because `jp` and `iw` are the mistakes typed from memory; a
 * three-letter one is checked for shape only. A well-formed BCP 47 tag with a
 * region (`en-GB`) names a real language and is held with a warning, not
 * failed: it is outside the documented format, and not false.
 */
function checkNewsLanguage(value: string): LanguageVerdict {
  const code = value.trim().toLowerCase();
  if (code === 'zh-cn' || code === 'zh-tw' || /^[a-z]{3}$/.test(code)) return { ok: true };

  const tag = checkLanguageTag(code);
  if (/^[a-z]{2}$/.test(code)) {
    return tag.ok ? { ok: true } : { ok: false, severity: 'fail', problem: `"${value}" ${tag.problem}` };
  }
  if (tag.ok) {
    return {
      ok: false,
      severity: 'warn',
      problem: `"${value}" is a language tag, where Google asks for a bare ISO 639 code (zh-cn and zh-tw excepted)`,
    };
  }
  return { ok: false, severity: 'fail', problem: `"${value}" ${tag.problem}` };
}

interface NewsFinding {
  readonly loc: string;
  readonly issue: string;
}

const REQUIRED: readonly [keyof SitemapNewsEntry, string][] = [
  ['publicationName', 'news:name'],
  ['language', 'news:language'],
  ['publicationDate', 'news:publication_date'],
  ['title', 'news:title'],
];

const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

const formatAge = (ms: number): string => `${Math.floor(ms / HOUR)} hours`;

/**
 * The news sitemap, judged only where the site publishes one.
 *
 * Liveness of the listed article URLs is `sitemap-validity`'s question, and
 * whether an article's page names its author and date is `author-date-signals`'
 * (3.5): a news entry's `<loc>` is an ordinary `<url>` entry, already in
 * `sitemapUrls`. What is left, and judged here, is the news metadata itself.
 */
export const newsSitemap: SiteProbe = {
  id: 'news-sitemap',
  scope: 'site',
  title: 'A news sitemap carries only recent, complete entries, at most 1,000 to a file',
  run({ crawl, origin }) {
    const entries = crawl.sitemapNews;

    // A sitemap whose name says news and whose server says 404: the site
    // believes it is publishing a feed, and nothing is.
    const named = crawl.sitemaps.filter((document) => NEWS_NAMED.test(pathOf(document.url)));
    const unfetchable = named.filter((document) => document.status !== 200);
    if (unfetchable.length > 0) {
      return fail(`${unfetchable.length} declared news sitemap(s) could not be fetched.`, {
        samples: unfetchable.slice(0, 5).map((document) => ({ url: document.url, status: document.status })),
      });
    }

    // Counted before the truncation check: a count read from part of a file is
    // a lower bound, and a lower bound past the limit is past the limit.
    const crowded = crawl.sitemaps.filter((document) => document.newsCount > NEWS_ENTRIES_PER_FILE);
    if (crowded.length > 0) {
      return fail(
        `${crowded.length} sitemap file(s) carry more than ${NEWS_ENTRIES_PER_FILE} news entries; ` +
          'Google reads at most that many from one file.',
        {
          samples: crowded.slice(0, 5).map((document) => ({
            url: document.url,
            newsEntries: document.newsCount,
            truncated: document.truncated,
          })),
        },
      );
    }

    // A cut file ends in a severed entry that reads like one missing its last
    // fields, so judging it would report the engine's limit as the site's.
    const cut = crawl.sitemaps.filter((document) => document.truncated && document.newsCount > 0);
    if (cut.length > 0) {
      return errored(
        `${cut.length} sitemap(s) carrying news entries could not be read in full, so the ` +
          'entries cannot be judged.',
        { samples: cut.slice(0, 5).map((document) => document.url) },
      );
    }

    if (entries.length === 0) {
      const empty = named.length > 0 ? `, ${named.length} of them named for news and empty, which v5.0 accepts` : '';
      return notApplicable(
        `No sitemap the crawl fetched declares news entries (${crawl.sitemaps.length} sitemap(s) read${empty}).`,
      );
    }

    const fetchedAt = new Map(crawl.sitemaps.map((document) => [document.url, Date.parse(document.fetchedAt)]));
    const defects: NewsFinding[] = [];
    const held: NewsFinding[] = [];

    for (const entry of entries) {
      const missing = REQUIRED.filter(([key]) => entry[key] === null).map(([, element]) => element);
      if (missing.length > 0) {
        defects.push({ loc: entry.loc, issue: `missing ${missing.join(', ')}` });
      }
      if (!isSameSite(entry.loc, origin)) {
        defects.push({ loc: entry.loc, issue: 'lists an article on another origin' });
      }

      if (entry.language !== null) {
        const verdict = checkNewsLanguage(entry.language);
        if (!verdict.ok) {
          (verdict.severity === 'fail' ? defects : held).push({ loc: entry.loc, issue: `news:language ${verdict.problem}` });
        }
      }

      if (entry.publicationDate === null) continue;
      const span = publicationSpan(entry.publicationDate);
      if (span === null) {
        defects.push({
          loc: entry.loc,
          issue: `news:publication_date "${entry.publicationDate}" is not a W3C date or datetime with a time zone`,
        });
        continue;
      }
      const reference = fetchedAt.get(entry.sitemap);
      if (reference === undefined || Number.isNaN(reference)) {
        return errored('A news entry names a sitemap the crawl holds no fetch time for, so its age cannot be judged.', {
          sitemap: entry.sitemap,
        });
      }

      const age = reference - span.latest;
      if (span.earliest - reference > CLOCK_SKEW_MS) {
        defects.push({
          loc: entry.loc,
          issue: `news:publication_date "${entry.publicationDate}" is after the sitemap was served`,
        });
      } else if (age > NEWS_WINDOW_MS + WINDOW_GRACE_MS) {
        defects.push({
          loc: entry.loc,
          issue: `published at least ${formatAge(age)} before the sitemap was served, past the two-day window`,
        });
      } else if (age > NEWS_WINDOW_MS) {
        held.push({
          loc: entry.loc,
          issue: `published at least ${formatAge(age)} before the sitemap was served, just past the two-day window`,
        });
      }
    }

    const files = [...new Set(entries.map((entry) => entry.sitemap))];
    const data = {
      entries: entries.length,
      sitemaps: files,
      largestFile: Math.max(0, ...crawl.sitemaps.map((document) => document.newsCount)),
    };

    if (defects.length > 0) {
      return fail(`${defects.length} defect(s) in ${entries.length} news sitemap entr(ies).`, {
        ...data,
        samples: defects.slice(0, 5),
      });
    }
    if (held.length > 0) {
      return warn(`${held.length} of ${entries.length} news sitemap entr(ies) need a look.`, {
        ...data,
        samples: held.slice(0, 5),
      });
    }
    return pass(
      `${entries.length} news entr(ies) across ${files.length} sitemap(s), each from the last two days ` +
        'with a publication name, language, date and title.',
      data,
    );
  },
};

export const newsProbes = [newsSitemap];
