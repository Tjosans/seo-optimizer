/**
 * Sitemap parsing, a chunk at a time.
 *
 * A sitemap is the one document an audit asks for that is routinely larger than
 * a page by two orders of magnitude — IGN's quarterly video sitemaps run 4–7 MB,
 * TED's is 10 MB — and the only thing wanted from it is a list. Building a DOM
 * of the whole file to read that list costs many times the file in memory, so
 * the parser here reads events as the bytes arrive and keeps only the entry it
 * is inside. What it holds is proportional to what it returns, not to what it
 * was sent.
 */

import { Parser } from 'htmlparser2';

/**
 * The most a sitemap may be, uncompressed: 50 MB, as sitemaps.org states it.
 *
 * This is the one body limit in the crawler that is not ours to choose. A page
 * limit is a guess about what a tarpit looks like, and raising it only moves the
 * cliff; this one is the protocol's own ceiling, so a sitemap read up to it has
 * been read as far as any consumer is promised. Past it the file is out of
 * spec — still marked truncated, because what lies beyond is still unread.
 */
export const SITEMAP_MAX_BYTES = 52_428_800;

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

export interface ParsedSitemap {
  /** `<loc>` of every `<url>` in a urlset. */
  readonly urls: string[];
  /** `<loc>` of every `<sitemap>` in a sitemap index. */
  readonly sitemaps: string[];
  readonly videos: SitemapVideo[];
}

export interface SitemapParser {
  write(chunk: string): void;
  /**
   * Finish, and return what was read.
   *
   * `complete: false` says the input stopped short of the document's end — the
   * crawler's body limit, not the site's markup. The entry open at that moment
   * is severed, and a severed entry reads exactly like one the site wrote
   * without its last fields (or with half a URL in its `<loc>`), so it is
   * dropped rather than returned. Every entry that closed before the cut is
   * whole and is kept.
   */
  end(complete: boolean): ParsedSitemap;
}

const clean = (value: string): string => value.replace(/\s+/g, ' ').trim();

/**
 * The local name of a namespaced element: `video:title` is `title`.
 *
 * Matching on the local name rather than on `video:` is deliberate. The prefix
 * is chosen by whoever wrote the file and only the namespace URI is fixed, so a
 * sitemap that binds the extension to `vid:` is as valid as one that does not
 * — and a parser keyed to the common spelling would silently read it as having
 * no videos at all.
 */
const localName = (name: string): string => name.toLowerCase().split(':').pop() ?? '';

interface OpenEntry {
  /** Every `<loc>` the entry carried; the first names the page. */
  readonly locs: string[];
  readonly videos: Record<string, string>[];
}

/**
 * A parser that can be fed a sitemap as it arrives.
 *
 * It recognises the same shapes as the DOM reading it replaced — `urlset > url
 * > loc`, `sitemapindex > sitemap > loc`, and a video extension as any child of
 * a `<url>` whose local name is `video` — by tracking the path of open
 * elements. Text is gathered for whichever field is open, across however many
 * chunks and entity boundaries it arrives in.
 */
export function createSitemapParser(): SitemapParser {
  const urls: string[] = [];
  const sitemaps: string[] = [];
  const videos: SitemapVideo[] = [];

  /** Names of the elements currently open, outermost first. */
  const path: string[] = [];
  let entry: OpenEntry | null = null;
  let video: Record<string, string> | null = null;
  /** Text of the field being read, and the depth it closes at. */
  let text: { depth: number; value: string } | null = null;
  let ending = false;

  const parser = new Parser(
    {
      onopentag(name) {
        path.push(name);
        const depth = path.length;
        const [root, parent] = path;

        if (root === 'urlset' && depth === 2 && name === 'url') {
          entry = { locs: [], videos: [] };
        } else if (entry !== null && depth === 3 && name === 'loc') {
          text = { depth, value: '' };
        } else if (entry !== null && depth === 3 && localName(name) === 'video') {
          video = {};
          entry.videos.push(video);
        } else if (video !== null && depth === 4) {
          text = { depth, value: '' };
        } else if (root === 'sitemapindex' && parent === 'sitemap' && depth === 3 && name === 'loc') {
          text = { depth, value: '' };
        }
      },
      ontext(data) {
        if (text !== null) text.value += data;
      },
      onclosetag(name) {
        const depth = path.length;
        path.pop();
        // Closes forced by `end()` on a cut document are the severance, not
        // the site's markup: nothing still open when the bytes ran out is kept.
        if (ending) return;

        if (text !== null && depth === text.depth) {
          const value = clean(text.value);
          text = null;
          if (value === '') return;
          if (path[0] === 'sitemapindex') sitemaps.push(value);
          else if (entry !== null && depth === 3) {
            entry.locs.push(value);
            urls.push(value);
          } else if (video !== null) video[localName(name)] = value;
          return;
        }
        if (video !== null && depth === 3) {
          video = null;
          return;
        }
        if (entry !== null && depth === 2) {
          const loc = entry.locs[0];
          if (loc !== undefined) {
            for (const field of entry.videos) {
              videos.push({
                loc,
                title: field['title'] ?? null,
                description: field['description'] ?? null,
                thumbnailUrl: field['thumbnail_loc'] ?? null,
                contentUrl: field['content_loc'] ?? null,
                playerUrl: field['player_loc'] ?? null,
              });
            }
          }
          entry = null;
        }
      },
    },
    { xmlMode: true },
  );

  return {
    write(chunk) {
      parser.write(chunk);
    },
    end(complete) {
      ending = !complete;
      parser.end();
      return { urls, sitemaps, videos };
    },
  };
}

/** Parse a whole sitemap or sitemap index held as a string. */
export function extractSitemapUrls(xml: string): ParsedSitemap {
  const parser = createSitemapParser();
  parser.write(xml);
  return parser.end(true);
}
