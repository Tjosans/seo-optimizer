/**
 * News: the parts of corpus check 2.18 a crawl can read for itself.
 *
 * 2.18 is two subjects under one gate, which is why it declares two detectors.
 * `news-sitemap` is the feed's side: whether a news sitemap the site publishes
 * follows the rules Google sets for one. `news-article-policy` is the
 * publisher's side: whether the articles the site offers as news say who wrote
 * them and when, whether the site says who publishes it and how to reach them,
 * and whether a page the site itself marks as advertising tells its reader so.
 *
 * The feed's rules are few and mechanical: news metadata only on articles from
 * the last two days, at most 1,000 news entries in a file, and on every entry a
 * publication name, a language, an original publication date and a title.
 * Whether the site should have a news sitemap at all is not among them. v5.0
 * says outright that ordinary websites need none and that an intentionally
 * empty feed is acceptable, so neither absence nor emptiness is a finding —
 * what is a finding is a feed that is published and wrong.
 *
 * The publisher's side is a policy review, and v5.0 leaves it to a person: the
 * check is `assisted`. What a crawl adds is what is false on its face — a feed
 * and an article disagreeing about when it was published, a page typed as
 * advertiser content that nowhere says so — and where the reviewer should look
 * first.
 */

import { isSameSite } from '@seo/crawler';
import type { CrawledPage, Extracted, SitemapNewsEntry } from '@seo/crawler';
import type { SiteProbe } from '../types.js';
import { errored, fail, notApplicable, pass, warn } from '../types.js';
import { articleNode, authorName, bareType, text } from './content.js';
import { checkLanguageTag } from './language-tags.js';
import { jsonLdNodes, typesOf } from './metadata.js';

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
export function publicationSpan(value: string): { earliest: number; latest: number } | null {
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
      // Google accepts a sitemap listing another host's URLs once the owner has
      // verified both in Search Console, which only the owner can see. The
      // New York Times' feed lists cooking.nytimes.com, and that is not a defect.
      if (!isSameSite(entry.loc, origin)) {
        held.push({
          loc: entry.loc,
          issue: 'lists an article on another host, which Google reads only when both hosts are verified to one owner',
        });
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

// --- news-article-policy ---------------------------------------------------

/** schema.org's NewsArticle and the types beneath it. */
const NEWS_ARTICLE_TYPES = new Set([
  'NewsArticle', 'AnalysisNewsArticle', 'AskPublicNewsArticle', 'BackgroundNewsArticle',
  'OpinionNewsArticle', 'ReportageNewsArticle', 'ReviewNewsArticle',
]);

/** Types that describe who publishes a site. */
const PUBLISHER_TYPES = new Set(['Organization', 'NewsMediaOrganization', 'Corporation', 'NGO']);

/**
 * A path segment that files a page under advertising. Only whole segments
 * count: `/sponsored/` is a section, `/sponsored-by-nobody-story` is a slug.
 */
const SPONSORED_SEGMENT = /^(sponsored|sponsor(ed)?-content|paid-?posts?|paid-?content|partner-?content|advertorials?|brand-?studio)$/i;

/**
 * Words that tell a reader a piece is paid for. English first, with the labels
 * a few other markets' press codes require. A page carrying any of them
 * anywhere — an advertising slot's own "Advertisement" label included — reads
 * as disclosed, so this errs towards the site: it fails only a page that says
 * nothing at all.
 *
 * Unbounded, deliberately. The page's text joins adjacent blocks with no space
 * between them — a headline and a "Paid post" label under it read as "A
 * storyPaid post" — so a word boundary would miss exactly the labels placed
 * where readers see them. The cost is a word that contains one ("Bewerbung"),
 * which again errs towards the site.
 */
const DISCLOSURE = /sponsored|paid (post|content|partnership|for by)|advertisement|advertorial|advertiser content|partner content|in partnership with|presented by|brought to you by|anzeige|annons|publicidad|publicité|pubblicità|werbung|reklame/iu;

/*
 * A link to a way of reaching the publisher, or to who the publisher is, by its
 * whole anchor text or a whole path segment. Whole, because a front page links
 * to "What we know about the storm", and a word match would take every
 * headline for an about page.
 */
const CONTACT_TEXT = /^(contact|contact us|contact the [\p{L} ]+|kontakt|contacto|contato|contatti|nous contacter|impressum)$/iu;
const CONTACT_SEGMENT = /^(contact|contact-us|contactus|kontakt|contacto|contato|contatti|nous-contacter|impressum)(\.\w+)?$/i;
const ABOUT_TEXT = /^(about|about us|about the [\p{L} ]+|masthead|impressum|who we are|our story|om oss|über uns|qui sommes-nous|chi siamo|quiénes somos|editorial (policy|standards|guidelines)|ethics( policy)?)$/iu;
const ABOUT_SEGMENT = /^(about|about-us|about_us|aboutus|masthead|impressum|who-we-are|om-oss|ueber-uns|uber-uns|qui-sommes-nous|chi-siamo|quienes-somos|editorial-(policy|standards|guidelines)|ethics)(\.\w+)?$/i;

const segmentsOf = (url: string): string[] => pathOf(url).split('/').filter((segment) => segment !== '');

/** Whether a link, by what it says or where it goes, is one of these. */
const linksTo = (link: Extracted['links'][number], label: RegExp, segment: RegExp): boolean =>
  label.test(link.anchorText.trim()) || segmentsOf(link.url).some((part) => segment.test(part));

/** The page declares, by type or by the section it is filed in, that it is advertising. */
function declaresSponsored(page: CrawledPage, extracted: Extracted): string | null {
  const typed = jsonLdNodes(extracted.jsonLd).some((node) =>
    typesOf(node).some((type) => bareType(type) === 'AdvertiserContentArticle'),
  );
  if (typed) return 'typed AdvertiserContentArticle';
  const segment = segmentsOf(page.fetch.finalUrl).find((part) => SPONSORED_SEGMENT.test(part));
  return segment === undefined ? null : `filed under /${segment}/`;
}

/** Whether anything a reader sees on the page says it is paid for. */
const discloses = (extracted: Extracted): boolean =>
  DISCLOSURE.test(extracted.text) ||
  DISCLOSURE.test(extracted.authorship.byline ?? '') ||
  extracted.images.some((image) => DISCLOSURE.test(image.alt ?? ''));

/** A time more than a day outside the span the feed's date can denote. */
const disagrees = (pageDate: string, feedDate: string): boolean => {
  const instant = Date.parse(pageDate);
  const span = publicationSpan(feedDate);
  if (Number.isNaN(instant) || span === null) return false;
  return instant < span.earliest - DAY || instant > span.latest + DAY;
};

/**
 * The publisher's side of 2.18, read from the articles the site offers as news.
 *
 * An article is news here when the news sitemap lists it or its structured
 * data types it as a NewsArticle. A blog post is not, whatever the rest of the
 * site publishes: the policy applies to the programme, and the programme is
 * what the site put forward.
 *
 * Two things fail. A page date and a feed date more than a day apart are one
 * statement too many about when a story was first published, and v5.0 asks
 * for "original" dates; re-dating an old story into the two-day window is the
 * abuse the rule exists for. And a page the site itself types or files as
 * advertising, with not one word telling the reader so, is the failure the
 * policy names outright. Everything else — an article with no byline in its
 * markup, a site whose crawl found no contact or about page — is held for the
 * person doing the review, because a byline drawn in script or a contact page
 * past the crawl's budget look exactly the same.
 */
export const newsArticlePolicy: SiteProbe = {
  id: 'news-article-policy',
  scope: 'site',
  title: 'News articles are attributed and dated, the publisher says who it is, and advertising says so',
  run({ crawl }) {
    const feed = new Map(crawl.sitemapNews.map((entry) => [entry.loc, entry]));
    const noAuthor: string[] = [];
    const noDate: string[] = [];
    const redated: { url: string; page: string; feed: string }[] = [];
    const undisclosed: { url: string; declared: string }[] = [];
    const authorFrom: Record<string, number> = {};
    let articles = 0;
    let listed = 0;
    let cut = 0;
    let contact = false;
    let publisher = false;

    for (const page of crawl.pages) {
      const extracted = page.extracted;
      if (extracted === null || page.fetch.status !== 200) continue;

      // The publisher's identity is a property of the site, so every page's
      // links and structured data count, the home page's footer above all.
      for (const link of extracted.links) {
        if (/^(mailto|tel):/i.test(link.url) || linksTo(link, CONTACT_TEXT, CONTACT_SEGMENT)) contact = true;
        if (linksTo(link, ABOUT_TEXT, ABOUT_SEGMENT)) publisher = true;
      }
      for (const node of jsonLdNodes(extracted.jsonLd)) {
        if (!typesOf(node).some((type) => PUBLISHER_TYPES.has(bareType(type)))) continue;
        if (text(node['name']) !== null) publisher = true;
        if (node['email'] !== undefined || node['telephone'] !== undefined || node['contactPoint'] !== undefined) {
          contact = true;
        }
      }

      const entry = feed.get(page.normalizedUrl);
      const node = articleNode(extracted.jsonLd);
      const typed = jsonLdNodes(extracted.jsonLd).some((candidate) =>
        typesOf(candidate).some((type) => NEWS_ARTICLE_TYPES.has(bareType(type))),
      );
      if (entry === undefined && !typed) continue;
      // A byline, a date or a disclosure past the cut was never read.
      if (page.fetch.truncated) {
        cut += 1;
        continue;
      }
      articles += 1;
      if (entry !== undefined) listed += 1;
      const url = page.normalizedUrl;
      const { authorship } = extracted;

      if (node !== null && authorName(node['publisher']) !== null) publisher = true;

      const author = (
        [
          ['structured data', authorName(node?.['author'])],
          ['byline', authorship.byline],
          ['meta author', authorship.metaAuthor],
          ['article:author', text(authorship.articleAuthor)],
        ] as const
      ).find(([, name]) => name !== null);
      if (author === undefined) noAuthor.push(url);
      else authorFrom[author[0]] = (authorFrom[author[0]] ?? 0) + 1;

      const pageDate = text(node?.['datePublished']) ?? text(authorship.publishedTime);
      if (pageDate === null && authorship.times.length === 0) noDate.push(url);
      if (pageDate !== null && entry?.publicationDate != null && disagrees(pageDate, entry.publicationDate)) {
        redated.push({ url, page: pageDate, feed: entry.publicationDate });
      }

      const sponsored = declaresSponsored(page, extracted);
      if (sponsored !== null && !discloses(extracted)) undisclosed.push({ url, declared: sponsored });
    }

    if (articles === 0) {
      if (cut > 0) {
        return errored(`${cut} news article page(s) were cut at the size limit, and no other was read.`);
      }
      if (feed.size > 0) {
        return errored(
          `The news sitemap lists ${feed.size} article(s) and the crawl reached none of them, so none can be reviewed.`,
        );
      }
      return notApplicable(
        'No news sitemap entry was crawled and no crawled page types itself a NewsArticle, so the site offers nothing as news.',
      );
    }

    const data: Record<string, unknown> = {
      articles,
      listedInFeed: listed,
      feedEntries: feed.size,
      authorFrom,
      contactFound: contact,
      publisherFound: publisher,
    };
    if (cut > 0) data['cutAtSizeLimit'] = cut;

    const defects: string[] = [];
    if (redated.length > 0) {
      defects.push(`${redated.length} article(s) give the news sitemap a publication date more than a day from their own`);
      data['redated'] = redated.slice(0, 5);
    }
    if (undisclosed.length > 0) {
      defects.push(`${undisclosed.length} page(s) the site marks as advertising say nothing to the reader about it`);
      data['undisclosed'] = undisclosed.slice(0, 5);
    }

    const doubts: string[] = [];
    if (noAuthor.length > 0) {
      doubts.push(`${noAuthor.length} of ${articles} news article(s) name no author in their markup`);
      data['noAuthor'] = noAuthor.slice(0, 5);
    }
    if (noDate.length > 0) {
      doubts.push(`${noDate.length} of ${articles} news article(s) carry no date`);
      data['noDate'] = noDate.slice(0, 5);
    }
    if (!contact) doubts.push('no crawled page links to a contact page or address, or declares one in structured data');
    if (!publisher) doubts.push('no crawled page links to an about page or names the publishing organisation in structured data');

    if (defects.length > 0) return fail(`${[...defects, ...doubts].join('; ')}.`, data);
    if (doubts.length > 0) return warn(`For the news-policy review: ${doubts.join('; ')}.`, data);
    return pass(
      `${articles} news article(s) name an author and carry a date` +
        (listed === 0 ? '' : `, the ${listed} the news sitemap lists agreeing with it,`) +
        ' and the site says who ' +
        'publishes it and how to reach them. The policy review itself is for a person.',
      data,
    );
  },
};

export const newsProbes = [newsSitemap, newsArticlePolicy];
