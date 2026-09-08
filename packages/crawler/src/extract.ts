/**
 * Turn one HTML document into the signals probes read.
 *
 * Extraction happens once per page and is deliberately dumb: it reports what
 * the markup says, never what it means. `<meta name="robots" content="noindex">`
 * is recorded as the string "noindex"; deciding whether that is a defect is a
 * probe's job, on a page a probe knows should be indexable.
 */

import * as cheerio from 'cheerio';
import { resolveUrl } from './url.js';

export interface ExtractedLink {
  /** Absolute URL, resolved against the document's base. */
  readonly url: string;
  /** The href exactly as authored, kept for reporting relative-path defects. */
  readonly href: string;
  readonly anchorText: string;
  readonly rel: string | null;
  readonly nofollow: boolean;
}

export interface ExtractedImage {
  readonly src: string | null;
  /** Null when the attribute is absent; empty string when it is present and empty. */
  readonly alt: string | null;
  readonly width: string | null;
  readonly height: string | null;
  readonly loading: string | null;
  readonly hasSrcset: boolean;
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
  /** Landmark elements present, for the semantic-html detector. */
  readonly landmarks: readonly string[];
  readonly text: string;
  readonly wordCount: number;
}

const attr = (value: string | undefined): string | null => (value === undefined ? null : value);
const clean = (value: string): string => value.replace(/\s+/g, ' ').trim();

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
      rel,
      nofollow: rel !== null && /\bnofollow\b/i.test(rel),
    });
  });

  const images: ExtractedImage[] = [];
  $('img').each((_, element) => {
    const src = $(element).attr('src');
    images.push({
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
    landmarks: LANDMARKS.filter((tag) => $(tag).length > 0),
    text,
    wordCount: text === '' ? 0 : text.split(' ').length,
  };
}

/**
 * One `<video:video>` entry, as a sitemap declares it.
 *
 * The video sitemap extension is the only place a site states, in its own
 * words, which of its URLs are watch pages and what plays on them. Google
 * requires a thumbnail, a title, a description and a way to play the video;
 * each is recorded as written, or null when the entry omits it, because
 * "omitted" is exactly what the detector is looking for.
 */
export interface SitemapVideo {
  /** The `<loc>` of the `<url>` entry carrying it: the watch page. */
  readonly loc: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly thumbnailUrl: string | null;
  /** `video:content_loc` — the media file itself. */
  readonly contentUrl: string | null;
  /** `video:player_loc` — a player page or embed URL. */
  readonly playerUrl: string | null;
}

/**
 * The local name of a namespaced element: `video:title` is `title`.
 *
 * Matching on the local name rather than on `video:` is deliberate. The prefix
 * is chosen by whoever wrote the file and only the namespace URI is fixed, so a
 * sitemap that binds the extension to `vid:` is as valid as one that does not
 * — and a parser keyed to the common spelling would silently read it as having
 * no videos at all.
 */
const localName = (element: { tagName?: string }): string =>
  (element.tagName ?? '').toLowerCase().split(':').pop() ?? '';

/** Parse a sitemap or sitemap index. Returns the URLs it points at. */
export function extractSitemapUrls(xml: string): {
  urls: string[];
  sitemaps: string[];
  videos: SitemapVideo[];
} {
  const $ = cheerio.load(xml, { xml: true });
  const urls = $('urlset > url > loc').map((_, e) => clean($(e).text())).get();
  const sitemaps = $('sitemapindex > sitemap > loc').map((_, e) => clean($(e).text())).get();

  const videos: SitemapVideo[] = [];
  $('urlset > url').each((_, entry) => {
    const loc = clean($(entry).children('loc').first().text());
    if (loc === '') return;
    $(entry)
      .children()
      .filter((_i, child) => localName(child) === 'video')
      .each((_i, node) => {
        const field: Record<string, string> = {};
        $(node)
          .children()
          .each((_j, child) => {
            const value = clean($(child).text());
            if (value !== '') field[localName(child)] = value;
          });
        videos.push({
          loc,
          title: field['title'] ?? null,
          description: field['description'] ?? null,
          thumbnailUrl: field['thumbnail_loc'] ?? null,
          contentUrl: field['content_loc'] ?? null,
          playerUrl: field['player_loc'] ?? null,
        });
      });
  });

  return { urls, sitemaps, videos };
}
