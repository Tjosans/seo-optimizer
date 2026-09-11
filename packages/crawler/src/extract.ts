/**
 * Turn one HTML document into the signals probes read.
 *
 * Extraction happens once per page and is deliberately dumb: it reports what
 * the markup says, never what it means. `<meta name="robots" content="noindex">`
 * is recorded as the string "noindex"; deciding whether that is a defect is a
 * probe's job, on a page a probe knows should be indexable.
 */

import * as cheerio from 'cheerio';
import type { Cheerio } from 'cheerio';

/** domhandler's node type, reached through cheerio rather than depended on directly. */
type AnyNode = Parameters<typeof cheerio.contains>[0];
import { resolveUrl } from './url.js';

export interface ExtractedLink {
  /** Absolute URL, resolved against the document's base. */
  readonly url: string;
  /** The href exactly as authored, kept for reporting relative-path defects. */
  readonly href: string;
  readonly anchorText: string;
  /**
   * What a screen reader announces for the link, approximated from markup:
   * `aria-label`, else the text of the elements `aria-labelledby` names, else
   * the text inside plus the alt of any image inside, else `title`. Empty when
   * none of those says anything — a link nobody can tell the purpose of.
   */
  readonly name: string;
  readonly rel: string | null;
  readonly nofollow: boolean;
}

/**
 * A `<table>`, reduced to what decides whether a screen reader can read it.
 *
 * A data table is navigated cell by cell, and each cell is announced with the
 * headers of its row and column. Without header cells there is nothing to
 * announce, so a grid of prices becomes a stream of numbers.
 */
export interface ExtractedTable {
  /** Rows belonging to this table, not to one nested inside it. */
  readonly rows: number;
  /** The widest of those rows, in cells. */
  readonly columns: number;
  /** Any `<th>`, a `scope` or `headers` attribute, or a header role. */
  readonly hasHeaders: boolean;
  /** `role="presentation"` or `role="none"`: a table used for layout, and saying so. */
  readonly presentational: boolean;
}

export interface ExtractedImage {
  readonly src: string | null;
  /** Null when the attribute is absent; empty string when it is present and empty. */
  readonly alt: string | null;
  readonly width: string | null;
  readonly height: string | null;
  readonly loading: string | null;
  readonly hasSrcset: boolean;
  /**
   * Whether the image needs no `alt`: it is hidden from assistive technology
   * (`aria-hidden="true"`, `role="presentation"` or `role="none"`), or it is
   * named some other way (`aria-label`, `aria-labelledby`, `title`).
   */
  readonly altExempt: boolean;
}

/**
 * A `<video>` or `<audio>` element, with the alternatives that make it usable
 * when the media itself is not.
 *
 * Only what markup states. Whether a caption track is *accurate* is a human
 * judgement, and whether one exists is not — so the corpus's "accessibility
 * alternatives are present" is answerable here and its "are accurate" is not.
 */
export interface ExtractedMedia {
  readonly kind: 'video' | 'audio';
  readonly src: string | null;
  /** The `poster` image a video shows before it plays; null on audio and on video without one. */
  readonly poster: string | null;
  /** `<track kind="captions">` or `kind="subtitles"`. */
  readonly hasCaptions: boolean;
  /** Any `<track>` at all, including descriptions and chapters. */
  readonly hasTrack: boolean;
  /** Text between the tags, shown by browsers that cannot play the media. */
  readonly hasFallbackText: boolean;
}

/**
 * An `<iframe>`, as declared.
 *
 * Recorded without judgement, like everything else here. Most video on the web
 * arrives this way — a YouTube or Vimeo player in a frame — and which hosts
 * count as players is a probe's question, not the extractor's.
 */
export interface ExtractedFrame {
  /** Absolute URL, resolved against the document's base. */
  readonly src: string;
  readonly title: string | null;
  readonly loading: string | null;
}

/**
 * A visible breadcrumb trail and the ancestors it links to.
 *
 * Detected from the shapes a breadcrumb actually takes in the wild: an
 * `aria-label` naming it, a `class` naming it, or schema.org microdata. A trail
 * nobody can see is not a breadcrumb, however good the JSON-LD is — which is
 * why this is separate from the `breadcrumblist-schema` detector and why 2.17
 * asks for both.
 */
export interface ExtractedBreadcrumb {
  /** Absolute URLs of the linked ancestors, in document order. */
  readonly links: readonly string[];
  /** Every crumb's text, linked or not; the last is usually the current page. */
  readonly labels: readonly string[];
}

/**
 * A `<link rel="icon">` and friends, as declared.
 *
 * Only the declaration. Whether the file is there, and whether it is square,
 * are facts about a response, and answering them means fetching it — which the
 * crawler does, because nothing else in this system is allowed to make a
 * request of its own.
 */
export interface ExtractedIcon {
  /** The `rel` as authored: "icon", "apple-touch-icon", "shortcut icon". */
  readonly rel: string;
  readonly url: string;
  /** The `sizes` attribute, unparsed. Absent on most real icons. */
  readonly sizes: string | null;
  readonly type: string | null;
}

export interface ExtractedHeading {
  readonly level: number;
  readonly text: string;
}

/**
 * One stretch of a page's reading matter, from a heading to the next heading
 * of any level.
 */
export interface ExtractedSection {
  /** The heading that opens the section; null for text before the first heading. */
  readonly heading: ExtractedHeading | null;
  /** Words of text up to the next heading, the heading's own words excluded. */
  readonly words: number;
}

/**
 * What a reader came to the page for, divided at its headings.
 *
 * The reading matter is the main landmark when the page declares one, else a
 * lone `<article>`, else the body — in every case without navigation, asides,
 * forms, and any header or footer that belongs to the page rather than to an
 * article. Headings in the menu are not signposts to anything on this page,
 * which is why `headings` alone cannot say how the text is organised.
 */
export interface ExtractedContent {
  /** Which element was read as the reading matter. */
  readonly root: 'main' | 'article' | 'body';
  /** In document order. Text before the first heading is a section only when there is some. */
  readonly sections: readonly ExtractedSection[];
  /** Absolute URLs of the links inside the reading matter, in document order. */
  readonly links: readonly string[];
}

/**
 * Who a page says wrote it and when, from everywhere except structured data,
 * which is in `jsonLd`.
 *
 * Recorded side by side because each is read by someone different — the meta
 * tag by tools, the Open Graph properties by social cards, the byline by
 * readers — and they disagree more often than they should.
 */
export interface ExtractedAuthorship {
  /** `<meta name="author">`. */
  readonly metaAuthor: string | null;
  /**
   * Visible byline text: the first of `rel="author"`, `itemprop="author"`, or
   * an element whose class names a byline or an author, outside navigation.
   * Cut at 120 characters, since an author box may hold a whole biography.
   */
  readonly byline: string | null;
  /** The `article:author` Open Graph property. */
  readonly articleAuthor: string | null;
  /** The `article:published_time` Open Graph property, as written. */
  readonly publishedTime: string | null;
  /** The `article:modified_time` Open Graph property, as written. */
  readonly modifiedTime: string | null;
  /** Each `<time>` element's `datetime`, else its text, in document order. */
  readonly times: readonly string[];
}

export interface Hreflang {
  readonly hreflang: string;
  /** Absolute URL, resolved against the document's base. */
  readonly url: string;
  /**
   * The href exactly as authored. Kept because hreflang is one of the few
   * places where a relative URL is not merely untidy but ignored outright, so
   * a detector has to be able to see what was written, not what it resolved to.
   */
  readonly href: string;
}

export interface Extracted {
  readonly title: string | null;
  readonly metaDescription: string | null;
  readonly metaRobots: string | null;
  readonly canonical: string | null;
  readonly lang: string | null;
  readonly hasViewportMeta: boolean;
  readonly charset: string | null;
  readonly headings: readonly ExtractedHeading[];
  readonly links: readonly ExtractedLink[];
  readonly images: readonly ExtractedImage[];
  readonly hreflang: readonly Hreflang[];
  /** Parsed JSON-LD blocks. Unparseable blocks are counted, not silently lost. */
  readonly jsonLd: readonly unknown[];
  readonly jsonLdErrors: number;
  readonly openGraph: Readonly<Record<string, string>>;
  readonly twitter: Readonly<Record<string, string>>;
  /** Absolute URLs of external scripts, in document order. */
  readonly scripts: readonly string[];
  /** Declared favicons and touch icons, for the favicon-site-name detector. */
  readonly icons: readonly ExtractedIcon[];
  /** `<video>` and `<audio>` elements, for the media-alternatives detector. */
  readonly media: readonly ExtractedMedia[];
  /** `<iframe>` elements, in document order. Most embedded video is one of these. */
  readonly frames: readonly ExtractedFrame[];
  /** Visible breadcrumb trails, in document order. Empty when none is present. */
  readonly breadcrumbs: readonly ExtractedBreadcrumb[];
  /** `<table>` elements, in document order, nested ones included. */
  readonly tables: readonly ExtractedTable[];
  /** Landmark elements present, for the semantic-html detector. */
  readonly landmarks: readonly string[];
  /** The reading matter, divided at its headings. */
  readonly content: ExtractedContent;
  /** Bylines and dates outside structured data. */
  readonly authorship: ExtractedAuthorship;
  readonly text: string;
  readonly wordCount: number;
}

const attr = (value: string | undefined): string | null => (value === undefined ? null : value);
const clean = (value: string): string => value.replace(/\s+/g, ' ').trim();
const countWords = (value: string): number => {
  const text = clean(value);
  return text === '' ? 0 : text.split(' ').length;
};

/** A domhandler node, as much of it as the reading-matter walk needs. */
interface WalkNode {
  readonly type: string;
  readonly name?: string;
  readonly data?: string;
  readonly attribs?: Readonly<Record<string, string>>;
  readonly children?: readonly WalkNode[];
}

/** Every text node under a node, in document order. */
const textNodes = (node: WalkNode): string[] =>
  node.type === 'text' ? [node.data ?? ''] : (node.children ?? []).flatMap(textNodes);

/** Inside the reading matter, but not part of it. */
const NOT_READING_MATTER = [
  'nav', 'aside', 'form', 'dialog',
  '[role="navigation"]', '[role="complementary"]', '[role="search"]', '[aria-hidden="true"]',
].join(', ');

/** Where a visible byline is, in rough order of reliability. */
const BYLINE_SELECTORS = ['[rel~="author"]', '[itemprop="author"]', '[class*="byline" i]', '[class*="author" i]'];

const LANDMARKS = ['header', 'nav', 'main', 'article', 'aside', 'footer', 'section'];

/** How a visible breadcrumb announces itself, in rough order of reliability. */
const BREADCRUMB_SELECTOR = [
  'nav[aria-label*="breadcrumb" i]',
  '[itemtype*="BreadcrumbList" i]',
  'ol[class*="breadcrumb" i]',
  'ul[class*="breadcrumb" i]',
  'nav[class*="breadcrumb" i]',
  '[class*="breadcrumb" i][role="navigation"]',
].join(', ');

export function extract(html: string, pageUrl: string): Extracted {
  const $ = cheerio.load(html);

  // A <base href> changes what every relative link resolves to; missing it is
  // a classic source of phantom 404s in crawl reports.
  const baseHref = $('base[href]').first().attr('href');
  const base = (baseHref && resolveUrl(baseHref, pageUrl)) || pageUrl;

  const meta = (selector: string): string | null => {
    const value = $(selector).first().attr('content');
    return value === undefined ? null : clean(value);
  };

  /** An element's accessible name, in the order the accessible-name algorithm tries. */
  const nameOf = (node: Cheerio<AnyNode>): string => {
    const label = clean(node.attr('aria-label') ?? '');
    if (label !== '') return label;
    const labelledBy = (node.attr('aria-labelledby') ?? '').split(/\s+/).filter((id) => id !== '');
    const referenced = clean(
      labelledBy
        .map((id) => $(`[id="${id.replace(/["\\]/g, '\\$&')}"]`).first().text())
        .join(' '),
    );
    if (referenced !== '') return referenced;
    const inner = clean(
      [
        node.text(),
        ...node
          .find('img[alt], [role="img"][aria-label]')
          .map((_i, image) => $(image).attr('alt') ?? $(image).attr('aria-label') ?? '')
          .get(),
      ].join(' '),
    );
    if (inner !== '') return inner;
    return clean(node.attr('title') ?? '');
  };

  const links: ExtractedLink[] = [];
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href') ?? '';
    const url = resolveUrl(href, base);
    if (url === null) return;
    const rel = attr($(element).attr('rel'));
    links.push({
      url,
      href,
      anchorText: clean($(element).text()),
      name: nameOf($(element)),
      rel,
      nofollow: rel !== null && /\bnofollow\b/i.test(rel),
    });
  });

  const images: ExtractedImage[] = [];
  $('img').each((_, element) => {
    const node = $(element);
    const src = node.attr('src');
    const role = (node.attr('role') ?? '').trim().toLowerCase();
    const altExempt =
      node.closest('[aria-hidden="true"]').length > 0 ||
      role === 'presentation' ||
      role === 'none' ||
      ['aria-label', 'aria-labelledby', 'title'].some((name) => clean(node.attr(name) ?? '') !== '');
    images.push({
      altExempt,
      src: src === undefined ? null : resolveUrl(src, base),
      alt: attr($(element).attr('alt')),
      width: attr($(element).attr('width')),
      height: attr($(element).attr('height')),
      loading: attr($(element).attr('loading')),
      hasSrcset: $(element).attr('srcset') !== undefined,
    });
  });

  const icons: ExtractedIcon[] = [];
  $('link[rel]').each((_, element) => {
    const rel = $(element).attr('rel') ?? '';
    if (!/(^|\s)(shortcut\s+)?icon(\s|$)|apple-touch-icon|mask-icon/i.test(rel)) return;
    const url = resolveUrl($(element).attr('href') ?? '', base);
    if (url === null) return;
    icons.push({
      rel: clean(rel),
      url,
      sizes: attr($(element).attr('sizes')),
      type: attr($(element).attr('type')),
    });
  });

  const media: ExtractedMedia[] = [];
  $('video, audio').each((_, element) => {
    const node = $(element);
    const tag = (element as { tagName?: string }).tagName ?? 'video';
    const src = node.attr('src') ?? node.find('source[src]').first().attr('src');
    const poster = node.attr('poster');
    const tracks = node.find('track');
    media.push({
      kind: tag.toLowerCase() === 'audio' ? 'audio' : 'video',
      src: src === undefined ? null : resolveUrl(src, base),
      poster: poster === undefined ? null : resolveUrl(poster, base),
      hasCaptions: tracks.filter((_i, t) => /^(captions|subtitles)$/i.test($(t).attr('kind') ?? ''))
        .length > 0,
      hasTrack: tracks.length > 0,
      // `clone().children().remove()` would drop <source> and <track> too, so
      // the fallback is the element's own text minus its track labels.
      hasFallbackText: clean(node.clone().find('track, source').remove().end().text()) !== '',
    });
  });

  const frames: ExtractedFrame[] = [];
  $('iframe[src]').each((_, element) => {
    const src = resolveUrl($(element).attr('src') ?? '', base);
    if (src === null) return;
    frames.push({
      src,
      title: attr($(element).attr('title')),
      loading: attr($(element).attr('loading')),
    });
  });

  const breadcrumbs: ExtractedBreadcrumb[] = [];
  $(BREADCRUMB_SELECTOR).each((_, element) => {
    const node = $(element);
    // A breadcrumb nested inside another match is the same trail seen twice.
    if (node.parents(BREADCRUMB_SELECTOR).length > 0) return;
    const links: string[] = [];
    node.find('a[href]').each((_i, anchor) => {
      const url = resolveUrl($(anchor).attr('href') ?? '', base);
      if (url !== null) links.push(url);
    });
    const labels = node
      .find('li, a, span')
      .map((_i, crumb) => clean($(crumb).text()))
      .get()
      .filter((text) => text !== '');
    if (links.length === 0 && labels.length === 0) return;
    breadcrumbs.push({ links, labels: [...new Set(labels)] });
  });

  const tables: ExtractedTable[] = [];
  $('table').each((_, element) => {
    const table = $(element);
    const rows = table.find('tr').filter((_i, row) => $(row).closest('table').get(0) === element);
    const widths = rows.map((_i, row) => $(row).children('td, th').length).get() as number[];
    const role = (table.attr('role') ?? '').trim().toLowerCase();
    tables.push({
      rows: rows.length,
      columns: Math.max(0, ...widths),
      hasHeaders:
        table.find('th, [scope], [headers], [role="columnheader"], [role="rowheader"]').length > 0,
      presentational: role === 'presentation' || role === 'none',
    });
  });

  const headings: ExtractedHeading[] = [];
  $('h1, h2, h3, h4, h5, h6').each((_, element) => {
    const tag = (element as { tagName?: string }).tagName ?? 'h6';
    headings.push({ level: Number(tag.slice(1)), text: clean($(element).text()) });
  });

  const hreflang: Hreflang[] = [];
  $('link[rel="alternate"][hreflang]').each((_, element) => {
    const href = $(element).attr('href') ?? '';
    const url = resolveUrl(href, base);
    if (url === null) return;
    hreflang.push({ hreflang: $(element).attr('hreflang') ?? '', url, href });
  });

  const jsonLd: unknown[] = [];
  let jsonLdErrors = 0;
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      jsonLd.push(JSON.parse($(element).text()));
    } catch {
      jsonLdErrors += 1;
    }
  });

  const openGraph: Record<string, string> = {};
  $('meta[property^="og:"]').each((_, element) => {
    const property = $(element).attr('property');
    const content = $(element).attr('content');
    if (property && content !== undefined) openGraph[property] = clean(content);
  });

  const twitter: Record<string, string> = {};
  $('meta[name^="twitter:"]').each((_, element) => {
    const name = $(element).attr('name');
    const content = $(element).attr('content');
    if (name && content !== undefined) twitter[name] = clean(content);
  });

  const scripts: string[] = [];
  $('script[src]').each((_, element) => {
    const url = resolveUrl($(element).attr('src') ?? '', base);
    if (url !== null) scripts.push(url);
  });

  const canonicalHref = $('link[rel="canonical"]').first().attr('href');
  const titleText = $('title').first().text();

  // Script and style content is markup, not reading matter.
  $('script, style, noscript, template').remove();
  const text = clean($('body').text());

  const main = $('main, [role="main"]').first();
  const articles = $('article');
  const [rootKind, rootNode]: [ExtractedContent['root'], Cheerio<AnyNode>] =
    main.length > 0 ? ['main', main] : articles.length === 1 ? ['article', articles] : ['body', $('body')];
  const reading = rootNode.clone();
  reading.find(NOT_READING_MATTER).remove();
  // An article's own header holds its headline and byline; the page's holds the logo.
  reading.find('header, footer').filter((_i, element) => $(element).closest('article').length === 0).remove();

  const sections: { heading: ExtractedHeading | null; words: number }[] = [{ heading: null, words: 0 }];
  const contentLinks: string[] = [];
  const walk = (nodes: readonly WalkNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'text') {
        const current = sections[sections.length - 1];
        if (current !== undefined) current.words += countWords(node.data ?? '');
        continue;
      }
      if (node.type !== 'tag') continue;
      const name = (node.name ?? '').toLowerCase();
      if (/^h[1-6]$/.test(name)) {
        const heading = { level: Number(name.slice(1)), text: clean($(node as unknown as AnyNode).text()) };
        sections.push({ heading, words: 0 });
        continue;
      }
      if (name === 'a' && node.attribs?.['href'] !== undefined) {
        const url = resolveUrl(node.attribs['href'], base);
        if (url !== null) contentLinks.push(url);
      }
      walk(node.children ?? []);
    }
  };
  walk(((reading.get(0) as unknown as WalkNode | undefined)?.children) ?? []);
  if (sections[0]?.words === 0) sections.shift();

  let byline: string | null = null;
  for (const selector of BYLINE_SELECTORS) {
    $('body')
      .find(selector)
      .each((_i, element) => {
        if (byline !== null || $(element).closest('nav').length > 0) return;
        // Joined with spaces: a byline is usually a name, a date and a share
        // button in adjacent elements, and `.text()` would run them together.
        const said = clean(textNodes(element as unknown as WalkNode).join(' '));
        if (said !== '') byline = said.slice(0, 120);
      });
    if (byline !== null) break;
  }
  const times = $('time')
    .map((_i, element) => clean($(element).attr('datetime') ?? $(element).text()))
    .get()
    .filter((value: string) => value !== '');

  return {
    title: titleText === '' ? null : clean(titleText),
    metaDescription: meta('meta[name="description"]'),
    metaRobots: meta('meta[name="robots"]'),
    canonical: canonicalHref === undefined ? null : resolveUrl(canonicalHref, base),
    lang: attr($('html').attr('lang')),
    hasViewportMeta: $('meta[name="viewport"]').length > 0,
    charset: attr($('meta[charset]').attr('charset')),
    headings,
    links,
    images,
    hreflang,
    jsonLd,
    jsonLdErrors,
    openGraph,
    twitter,
    scripts,
    icons,
    media,
    frames,
    breadcrumbs,
    tables,
    landmarks: LANDMARKS.filter((tag) => $(tag).length > 0),
    content: { root: rootKind, sections, links: contentLinks },
    authorship: {
      metaAuthor: meta('meta[name="author"]'),
      byline,
      articleAuthor: meta('meta[property="article:author"]'),
      publishedTime: meta('meta[property="article:published_time"]'),
      modifiedTime: meta('meta[property="article:modified_time"]'),
      times,
    },
    text,
    wordCount: text === '' ? 0 : text.split(' ').length,
  };
}
