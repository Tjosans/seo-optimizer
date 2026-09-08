/**
 * Video: the three questions corpus check 2.14 asks of a site whose videos are
 * meant to be found.
 *
 * The check reads as one instruction — "give important videos stable crawlable
 * watch pages, accurate VideoObject, and a video sitemap where it helps" — but
 * it is three subjects that fail independently, which is why it declares three
 * detectors.
 *
 * `video-watch-page` asks whether the page a video sits on can be found and
 * understood: indexable, with the player and its thumbnail crawlable, and with
 * enough words around the player to say what the video is. This is the one that
 * fails on a site whose videos are all embedded on a single `/media` page, or
 * whose CDN path is disallowed in robots.txt.
 *
 * `videoobject-schema` asks whether the video is described to a machine, and
 * whether the description names the video the page actually plays. A page can
 * be a flawless watch page and carry no markup at all; markup can be complete
 * and describe a video that was replaced last year.
 *
 * `video-sitemap` asks about the one file that states, in the site's own words,
 * which URLs are watch pages. The corpus asks for it only "when it materially
 * improves discovery", so its absence is not a finding here — what is a finding
 * is a video sitemap that 404s, lists somebody else's URLs, or declares entries
 * missing the fields that make them usable.
 *
 * The overlap with 2.7's `schema-eligibility-matrix` is deliberate and narrow.
 * That detector judges markup that exists, for a site claiming structured-data
 * templates; this one starts from the video and speaks for a site that claims
 * only `video`, where 2.7 is not applicable and nobody else would say a word.
 */

import { isAllowed, isSameSite } from '@seo/crawler';
import type { CrawledPage, Robots } from '@seo/crawler';
import type { PageProbe, SiteProbe } from '../types.js';
import { fail, notApplicable, pass, warn } from '../types.js';

const NO_HTML = 'No HTML was parsed for this response.';

/**
 * Hosts whose frames are a video player.
 *
 * A list rather than a heuristic, because an `<iframe>` is how nearly all web
 * video is embedded and almost none of it is video: maps, forms, adverts and
 * consent widgets all arrive the same way. Naming the players is the only way
 * to be sure the thing being judged is a video, and a player missing from this
 * list makes the detector quiet rather than wrong.
 */
const PLAYER_HOSTS = [
  'youtube.com',
  'youtube-nocookie.com',
  'youtu.be',
  'vimeo.com',
  'dailymotion.com',
  'wistia.net',
  'wistia.com',
  'brightcove.net',
  'jwplayer.com',
  'jwpcdn.com',
  'loom.com',
  'vidyard.com',
  'mediadelivery.net',
  'streamable.com',
  'twitch.tv',
  'ted.com',
];

/**
 * The agents Google fetches media with.
 *
 * A thumbnail is fetched by Googlebot-Image and a video file by Googlebot-Video,
 * so those are the names robots.txt is asked about. Both fall back to the `*`
 * group when a site names neither, which is what almost every site does.
 */
const IMAGE_AGENT = 'Googlebot-Image';
const VIDEO_AGENT = 'Googlebot-Video';

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

const isPlayerFrame = (src: string): boolean => {
  const host = hostOf(src);
  if (host === null) return false;
  return PLAYER_HOSTS.some((player) => host === player || host.endsWith(`.${player}`));
};

/** Every schema.org VideoObject a page declares, `@graph` members included. */
function videoObjects(page: CrawledPage): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;
    const types = [record['@type']].flat();
    if (types.some((type) => typeof type === 'string' && /^VideoObject$/i.test(type))) {
      found.push(record);
    }
    if (Array.isArray(record['@graph'])) visit(record['@graph']);
  };
  (page.extracted?.jsonLd ?? []).forEach(visit);
  return found;
}

/**
 * What plays on a page, and what describes it.
 *
 * `players` is what a visitor would see — a `<video>` element or a known
 * player's frame. `nodes` is what a machine is told. The two are counted apart
 * because every finding in this file is about them disagreeing.
 */
interface PageVideo {
  readonly players: readonly string[];
  readonly posters: readonly string[];
  readonly nodes: readonly Record<string, unknown>[];
}

function videosOn(page: CrawledPage): PageVideo {
  const extracted = page.extracted;
  if (extracted === null) return { players: [], posters: [], nodes: [] };

  const elements = extracted.media.filter((item) => item.kind === 'video');
  const frames = extracted.frames.filter((frame) => isPlayerFrame(frame.src));

  return {
    players: [
      ...elements.map((element) => element.src).filter((src): src is string => src !== null),
      ...frames.map((frame) => frame.src),
    ],
    posters: elements
      .map((element) => element.poster)
      .filter((poster): poster is string => poster !== null),
    nodes: videoObjects(page),
  };
}

/** A page that plays a video, or says it has one. */
const carriesVideo = (page: CrawledPage): boolean => {
  const video = videosOn(page);
  return video.players.length > 0 || video.nodes.length > 0;
};

const isNoindex = (page: CrawledPage): boolean =>
  /\bnoindex\b/i.test(
    `${page.extracted?.metaRobots ?? ''} ${page.fetch.headers['x-robots-tag'] ?? ''}`,
  );

/** The first string a node holds under `key`, or null. */
const stringProperty = (node: Record<string, unknown>, key: string): string | null => {
  const value = node[key];
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === 'string' && item.trim() !== '');
    if (typeof first === 'string') return first.trim();
    // thumbnailUrl is often an ImageObject rather than a URL string.
    const object = value.find((item) => typeof item === 'object' && item !== null);
    if (object !== undefined) {
      const url = (object as Record<string, unknown>)['url'];
      if (typeof url === 'string' && url.trim() !== '') return url.trim();
    }
    return null;
  }
  if (typeof value === 'object' && value !== null) {
    const url = (value as Record<string, unknown>)['url'];
    if (typeof url === 'string' && url.trim() !== '') return url.trim();
  }
  return null;
};

/**
 * The part of a media URL that identifies the video.
 *
 * A YouTube video is `watch?v=ID`, `embed/ID` and `youtu.be/ID` depending on
 * who is writing the URL down, so comparing whole URLs would report every
 * correctly marked-up embed as a mismatch. The last meaningful path segment,
 * or the `v` parameter, is the piece all three spellings share.
 */
function mediaId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const v = parsed.searchParams.get('v');
    if (v !== null && v !== '') return v.toLowerCase();
    const segments = parsed.pathname.split('/').filter((segment) => segment !== '');
    const last = segments.at(-1);
    return last === undefined ? null : last.toLowerCase();
  } catch {
    return null;
  }
}

/** Whether a same-site URL is one robots.txt lets `agent` fetch. */
const blockedForAgent = (
  crawl: { readonly robots: Robots },
  origin: string,
  agent: string,
  url: string,
): boolean => isSameSite(url, origin) && !isAllowed(crawl.robots, agent, url);

/**
 * A watch page: a URL where one video can be found, understood and indexed.
 *
 * Every page carrying a video is judged as a candidate. Which videos are
 * "important" is the corpus's word and a person's decision — a crawl cannot
 * rank a site's own library — so the detector answers the part that does not
 * need ranking: whatever this page's video is, is its page fit to be found.
 */
export const videoWatchPage: PageProbe = {
  id: 'video-watch-page',
  scope: 'page',
  htmlOnly: true,
  title: 'Video sits on a crawlable, indexable page with context and a thumbnail',
  run({ page, site }) {
    const extracted = page.extracted;
    if (extracted === null) return notApplicable(NO_HTML);

    const video = videosOn(page);
    if (video.players.length === 0 && video.nodes.length === 0) {
      return notApplicable('The page plays no video and declares none.');
    }

    const data = {
      players: video.players.length,
      videoObjects: video.nodes.length,
      wordCount: extracted.wordCount,
    };

    if (isNoindex(page)) {
      return fail('The page carrying this video is noindex, so the video has no watch page.', {
        ...data,
        robots: extracted.metaRobots,
      });
    }

    // A player or thumbnail robots.txt refuses is a video Google cannot see,
    // however good the page around it is. Only same-site URLs are judged: this
    // crawl read one robots.txt and knows nothing about a third party's.
    const thumbnails = [
      ...video.posters,
      ...video.nodes
        .map((node) => stringProperty(node, 'thumbnailUrl'))
        .filter((url): url is string => url !== null),
      ...(extracted.openGraph['og:image'] === undefined ? [] : [extracted.openGraph['og:image']]),
    ];
    const blockedPlayers = video.players.filter((url) =>
      blockedForAgent(site.crawl, site.origin, VIDEO_AGENT, url),
    );
    const blockedThumbnails = thumbnails.filter((url) =>
      blockedForAgent(site.crawl, site.origin, IMAGE_AGENT, url),
    );
    if (blockedPlayers.length > 0 || blockedThumbnails.length > 0) {
      return fail('robots.txt blocks the video or thumbnail resources this page depends on.', {
        ...data,
        blocked: [...blockedPlayers, ...blockedThumbnails].slice(0, 5),
      });
    }

    const notes: string[] = [];
    const canonical = extracted.canonical;
    if (canonical !== null && canonical !== page.normalizedUrl && canonical !== page.url) {
      notes.push(`its canonical points at ${canonical}, so this is not the video's own URL`);
    }
    if (thumbnails.length === 0) {
      notes.push('no thumbnail is declared, by poster, og:image or VideoObject');
    }
    if (extracted.headings.find((heading) => heading.level === 1) === undefined) {
      notes.push('the page has no <h1> naming what the video is');
    }
    if (extracted.wordCount < 50) {
      notes.push(`the player sits in ${extracted.wordCount} words of context`);
    }

    return notes.length === 0
      ? pass(
          `A watch page for ${video.players.length || video.nodes.length} video(s): indexable, ` +
            'with a declared thumbnail and surrounding context.',
          data,
        )
      : warn(`Carries video, but ${notes.join('; ')}.`, { ...data, notes });
  },
};

/** What Google needs before a VideoObject can produce a video result. */
const REQUIRED = ['name', 'description', 'thumbnailUrl', 'uploadDate'] as const;
const PLAYABLE = ['contentUrl', 'embedUrl'] as const;

interface SchemaDefect {
  readonly issue: string;
  readonly name?: string;
}

export const videoObjectSchema: PageProbe = {
  id: 'videoobject-schema',
  scope: 'page',
  htmlOnly: true,
  title: 'Videos are described by complete VideoObject markup',
  run({ page }) {
    const extracted = page.extracted;
    if (extracted === null) return notApplicable(NO_HTML);

    const video = videosOn(page);
    if (video.players.length === 0 && video.nodes.length === 0) {
      return notApplicable('The page plays no video and declares none.');
    }

    if (video.nodes.length === 0) {
      return fail(
        `${video.players.length} video(s) play on this page and none is described by ` +
          'VideoObject structured data.',
        { players: video.players.slice(0, 5) },
      );
    }

    const defects: SchemaDefect[] = [];
    for (const node of video.nodes) {
      const name = stringProperty(node, 'name');
      const missing = REQUIRED.filter((property) => stringProperty(node, property) === null);
      if (missing.length > 0) {
        defects.push({ issue: `missing required ${missing.join(', ')}`, ...(name === null ? {} : { name }) });
      }
      if (PLAYABLE.every((property) => stringProperty(node, property) === null)) {
        defects.push({ issue: `has neither ${PLAYABLE.join(' nor ')}, so nothing can play it`, ...(name === null ? {} : { name }) });
      }
      const uploadDate = stringProperty(node, 'uploadDate');
      // ISO 8601, which is what every consumer parses. "March 2026" is a date
      // to a reader and nothing at all to a machine.
      if (uploadDate !== null && !/^\d{4}-\d{2}-\d{2}/.test(uploadDate)) {
        defects.push({ issue: `uploadDate "${uploadDate}" is not an ISO 8601 date`, ...(name === null ? {} : { name }) });
      }
      const duration = stringProperty(node, 'duration');
      if (duration !== null && !/^P/i.test(duration)) {
        defects.push({ issue: `duration "${duration}" is not an ISO 8601 duration`, ...(name === null ? {} : { name }) });
      }
    }

    const data = { videoObjects: video.nodes.length, players: video.players.length };

    if (defects.length > 0) {
      return fail(
        `${defects.length} defect(s) in ${video.nodes.length} VideoObject node(s).`,
        { ...data, samples: defects.slice(0, 5) },
      );
    }

    // Complete markup describing a video this page does not play is markup
    // about something else. Only tested when there is a player to compare
    // against: a video injected by script leaves nothing in the HTML, and the
    // markup is then the only evidence there is.
    if (video.players.length > 0) {
      const played = new Set(
        video.players.map(mediaId).filter((id): id is string => id !== null),
      );
      const declared = video.nodes
        .flatMap((node) => PLAYABLE.map((property) => stringProperty(node, property)))
        .filter((url): url is string => url !== null)
        .map(mediaId)
        .filter((id): id is string => id !== null);

      if (declared.length > 0 && !declared.some((id) => played.has(id))) {
        return warn(
          'The VideoObject names a video the page does not play; the markup and the ' +
            'player disagree about what is on this page.',
          { ...data, declared: declared.slice(0, 5), played: [...played].slice(0, 5) },
        );
      }
      if (video.players.length > video.nodes.length) {
        return warn(
          `${video.players.length} video(s) play here and ${video.nodes.length} are described.`,
          data,
        );
      }
    }

    return pass(
      `${video.nodes.length} VideoObject node(s), each complete and playable.`,
      data,
    );
  },
};

interface SitemapDefect {
  readonly loc: string;
  readonly issue: string;
}

/**
 * The video sitemap, judged only where the site has one.
 *
 * Absence is not a finding. The corpus asks for a video sitemap "when it
 * materially improves discovery", which is a judgement about a site's own
 * traffic that no crawl can make — and a watch page missing from the ordinary
 * sitemap is already `index-bloat`'s finding, reported once is enough.
 *
 * Liveness of the listed URLs is `sitemap-validity`'s question, for the same
 * reason: a video sitemap's `<loc>` entries are ordinary `<url>` entries and
 * are already in `sitemapUrls`. What is left, and what is judged here, is
 * whether the video declarations themselves are complete, on this site, and
 * about videos the pages actually carry.
 */
export const videoSitemap: SiteProbe = {
  id: 'video-sitemap',
  scope: 'site',
  title: 'A video sitemap is fetchable and declares complete, owned entries',
  run({ crawl, origin }) {
    const entries = crawl.sitemapVideos;
    const videoPages = crawl.pages.filter(carriesVideo);

    // A sitemap whose name says video and whose server says 404: the site
    // believes it is publishing one, and nothing is.
    const named = crawl.sitemaps.filter((document) => /video/i.test(document.url));
    const unfetchable = named.filter((document) => document.status !== 200);
    if (unfetchable.length > 0) {
      return fail(
        `${unfetchable.length} declared video sitemap(s) could not be fetched.`,
        { samples: unfetchable.slice(0, 5) },
      );
    }

    if (entries.length === 0) {
      return notApplicable(
        `No sitemap the crawl fetched declares video entries (${crawl.sitemaps.length} ` +
          `sitemap(s) read, ${videoPages.length} page(s) carrying video).`,
      );
    }

    const defects: SitemapDefect[] = [];
    const blocked: SitemapDefect[] = [];
    for (const entry of entries) {
      const missing: string[] = [];
      if (entry.title === null) missing.push('video:title');
      if (entry.description === null) missing.push('video:description');
      if (entry.thumbnailUrl === null) missing.push('video:thumbnail_loc');
      if (entry.contentUrl === null && entry.playerUrl === null) {
        missing.push('video:content_loc or video:player_loc');
      }
      if (missing.length > 0) {
        defects.push({ loc: entry.loc, issue: `missing ${missing.join(', ')}` });
      }
      if (!isSameSite(entry.loc, origin)) {
        defects.push({ loc: entry.loc, issue: 'lists a watch page on another origin' });
      }
      if (
        entry.thumbnailUrl !== null &&
        blockedForAgent(crawl, origin, IMAGE_AGENT, entry.thumbnailUrl)
      ) {
        blocked.push({ loc: entry.loc, issue: `robots.txt blocks ${entry.thumbnailUrl}` });
      }
      for (const media of [entry.contentUrl, entry.playerUrl]) {
        if (media !== null && blockedForAgent(crawl, origin, VIDEO_AGENT, media)) {
          blocked.push({ loc: entry.loc, issue: `robots.txt blocks ${media}` });
        }
      }
    }

    const data = {
      entries: entries.length,
      sitemaps: [...new Set(entries.map((entry) => entry.sitemap))],
      videoPages: videoPages.length,
    };

    if (defects.length > 0) {
      return fail(`${defects.length} of ${entries.length} video sitemap entr(ies) are unusable.`, {
        ...data,
        samples: defects.slice(0, 5),
      });
    }
    if (blocked.length > 0) {
      return fail(
        `${blocked.length} video sitemap entr(ies) point at resources robots.txt refuses.`,
        { ...data, samples: blocked.slice(0, 5) },
      );
    }

    // The sitemap says a video is there; the crawl read the page and saw none.
    // A warning rather than a defect, because a player injected by script is
    // invisible to a raw crawl and common enough to be worth the doubt.
    const byUrl = new Map(crawl.pages.map((page) => [page.normalizedUrl, page]));
    const silent = entries.filter((entry) => {
      const page = byUrl.get(entry.loc);
      return page !== undefined && page.extracted !== null && !carriesVideo(page);
    });
    if (silent.length > 0) {
      return warn(
        `${silent.length} video sitemap entr(ies) name a page the crawl found no video on.`,
        { ...data, samples: silent.slice(0, 5).map((entry) => entry.loc) },
      );
    }

    return pass(
      `${entries.length} video(s) declared across ${data.sitemaps.length} sitemap(s), each with ` +
        'a title, description, thumbnail and a way to play it.',
      data,
    );
  },
};

export const videoProbes = [videoWatchPage, videoObjectSchema, videoSitemap];
