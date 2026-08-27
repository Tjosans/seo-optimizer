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

export interface ExtractedHeading {
  readonly level: number;
  readonly text: string;
}

export interface Hreflang {
  readonly hreflang: string;
  readonly url: string;
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
  /** Landmark elements present, for the semantic-html detector. */
  readonly landmarks: readonly string[];
  readonly text: string;
  readonly wordCount: number;
}

const attr = (value: string | undefined): string | null => (value === undefined ? null : value);
const clean = (value: string): string => value.replace(/\s+/g, ' ').trim();

const LANDMARKS = ['header', 'nav', 'main', 'article', 'aside', 'footer', 'section'];

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

  const headings: ExtractedHeading[] = [];
  $('h1, h2, h3, h4, h5, h6').each((_, element) => {
    const tag = (element as { tagName?: string }).tagName ?? 'h6';
    headings.push({ level: Number(tag.slice(1)), text: clean($(element).text()) });
  });

  const hreflang: Hreflang[] = [];
  $('link[rel="alternate"][hreflang]').each((_, element) => {
    const href = $(element).attr('href');
    const url = href === undefined ? null : resolveUrl(href, base);
    if (url === null) return;
    hreflang.push({ hreflang: $(element).attr('hreflang') ?? '', url });
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
    landmarks: LANDMARKS.filter((tag) => $(tag).length > 0),
    text,
    wordCount: text === '' ? 0 : text.split(' ').length,
  };
}

/** Parse a sitemap or sitemap index. Returns the URLs it points at. */
export function extractSitemapUrls(xml: string): { urls: string[]; sitemaps: string[] } {
  const $ = cheerio.load(xml, { xml: true });
  const urls = $('urlset > url > loc').map((_, e) => clean($(e).text())).get();
  const sitemaps = $('sitemapindex > sitemap > loc').map((_, e) => clean($(e).text())).get();
  return { urls, sitemaps };
}
