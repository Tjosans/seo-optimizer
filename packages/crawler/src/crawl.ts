/**
 * The crawl loop.
 *
 * Breadth-first from the seeds, bounded by page and depth budgets, one request
 * at a time with a politeness delay. Sequential is the deliberate default: an
 * audit crawler runs against someone else's production site, and finishing a
 * few minutes sooner is never worth being the reason their origin wobbles.
 *
 * The result is held in memory and handed to a sink. Nothing here knows about
 * a database, so the same crawl can back a stored audit, a CI check or a test.
 */

import { extract } from './extract.js';
import type { Extracted } from './extract.js';
import { fetchPage } from './fetch.js';
import type { FetchResult } from './fetch.js';
import { ALLOW_ALL, crawlDelayMs, isAllowed, parseRobots } from './robots.js';
import type { Robots } from './robots.js';
import { negotiateProtocol } from './protocol.js';
import type { ProtocolCheck } from './protocol.js';
import { SITEMAP_MAX_BYTES, createSitemapParser } from './sitemap.js';
import type { SitemapVideo } from './sitemap.js';
import { isSameSite, normalizeUrl } from './url.js';

export interface CrawledPage {
  readonly url: string;
  readonly normalizedUrl: string;
  readonly depth: number;
  /** Normalized URL of the page this one was first linked from; null for a seed. */
  readonly discoveredFrom: string | null;
  readonly fetch: FetchResult;
  /** Null when the response was not HTML, or when the fetch failed. */
  readonly extracted: Extracted | null;
}

export interface CrawlOptions {
  readonly seeds: readonly string[];
  readonly userAgent: string;
  readonly maxPages: number;
  readonly maxDepth: number;
  /** Politeness delay between requests, before any robots crawl-delay. */
  readonly requestDelayMs?: number;
  readonly respectRobots?: boolean;
  readonly followSitemaps?: boolean;
  readonly timeoutMs?: number;
  /**
   * Stops the crawl where it stands, throwing `CrawlCancelledError`.
   *
   * Cooperative and checked between requests, not inside one: the request in
   * flight when the signal arrives is allowed to finish, because abandoning it
   * saves the site nothing — the bytes are already on their way — and because a
   * half-read response is not something the extractor should be handed. So the
   * guarantee is "no further requests", which is the one that matters to the
   * site being crawled.
   */
  readonly signal?: AbortSignal;
  /**
   * Test the seed's other scheme and host spellings, and fetch the root
   * document's declared icons. Defaults to true.
   *
   * Host variants are skipped for a seed whose host cannot have them — an IP
   * address, `localhost`, any single-label name — because `www.127.0.0.1` is
   * not a spelling of anything and the only thing testing it produces is a DNS
   * error in the report.
   */
  readonly auxiliary?: boolean;
  /**
   * Other crawlers to fetch the seed as, once each.
   *
   * robots.txt is a request, not a fence. What a site *does* to a named crawler
   * — serve it, or have a CDN turn it away at the edge — is only observable by
   * arriving under that name, which is what corpus check 2.9 means by a
   * user-agent test. The list comes from the site's own AI crawler policy, so
   * this asks about crawlers the site has an opinion on and no others.
   *
   * Sent honestly: the request really does carry that user-agent, and the site
   * really does get to decide what to do about it.
   */
  readonly userAgentTests?: readonly string[];
  /** Injection seam for tests and for replaying a stored crawl. */
  readonly fetchImpl?: typeof fetchPage;
  /** Injection seam for the TLS handshake, like `fetchImpl` for requests. */
  readonly negotiateImpl?: typeof negotiateProtocol;
  /** Called as each page completes, so a long crawl can stream to storage. */
  readonly onPage?: (page: CrawledPage) => void | Promise<void>;
}

/**
 * A request made outside the breadth-first walk.
 *
 * Some questions cannot be answered by pages a crawl happens to reach. "Does
 * http://example.com end up at one canonical HTTPS URL in one hop" is about
 * URLs that are deliberately *not* in the crawl — the whole point is what
 * happens before you arrive. "Is the favicon actually there" is about a file no
 * page links to as a page.
 *
 * Those requests are made here rather than by the probes that need them,
 * because politeness is owed to a host and the crawl loop is the only thing
 * that knows what has been promised: the same delay applies between these and
 * every other request, and they stop for the same cancellation signal. A probe
 * that could fetch on its own would be a second, unmetered visitor to a site
 * that agreed to one.
 */
export interface AuxiliaryFetch {
  /**
   * `host-variant` — a scheme/host spelling of the seed, tested once.
   * `icon` — an icon the root document declared.
   * `user-agent-test` — the seed fetched as somebody else, to see whether the
   *   site treats that crawler differently from this one.
   */
  readonly reason: 'host-variant' | 'icon' | 'user-agent-test';
  readonly url: string;
  /** The `user-agent` sent, when it was not the crawl's own. */
  readonly userAgent?: string;
  readonly fetch: FetchResult;
}

/**
 * One sitemap document the crawl asked for, and what came back.
 *
 * Kept because "the site declares a sitemap that 404s" and "the site declares
 * no sitemap" are different findings and the URL list cannot tell them apart:
 * both produce nothing. A video sitemap named in robots.txt and missing from
 * the server is precisely what corpus check 2.14 means by "fetchable".
 */
export interface SitemapFetch {
  readonly url: string;
  /** Null when the request itself failed — DNS, timeout, connection refused. */
  readonly status: number | null;
  /** `<url>` entries the document declared. */
  readonly urlCount: number;
  /**
   * Whether the document ran past what the crawl would read of it.
   *
   * Sitemaps are read up to the protocol's own 50 MB ceiling, so this is now
   * a file out of spec rather than one merely larger than a page. The entry
   * the cut severed is dropped, but the counts above still describe only the
   * part that was read: "absent from the sitemap" is not a claim anything may
   * make about a truncated one, and every detector reading these entries has
   * to know.
   */
  readonly truncated: boolean;
  /** Of those, how many carried a `<video:video>` extension. */
  readonly videoCount: number;
}

/** A `<video:video>` entry, with the sitemap that declared it. */
export interface SitemapVideoEntry extends SitemapVideo {
  readonly sitemap: string;
}

export interface CrawlResult {
  readonly seeds: readonly string[];
  readonly pages: readonly CrawledPage[];
  readonly robots: Robots;
  readonly robotsTxt: string | null;
  /** Every URL the site's own sitemaps declare, normalized. */
  readonly sitemapUrls: readonly string[];
  /** Every sitemap document the crawl asked for, in the order it asked. */
  readonly sitemaps: readonly SitemapFetch[];
  /** Video extension entries, across every sitemap that carried any. */
  readonly sitemapVideos: readonly SitemapVideoEntry[];
  /** In-scope URLs left unfetched because robots.txt disallowed them. */
  readonly blockedByRobots: readonly string[];
  /**
   * In-scope URLs discovered but not fetched, because a budget ran out —
   * the page budget, or the depth budget.
   *
   * Both, because both are limits of ours rather than facts about the site.
   * A URL linked one click past `maxDepth` used to vanish without trace, which
   * is exactly where filter URLs that stack onto each other go: a crawl that
   * reported nothing left over there was describing its own horizon as the
   * site's edge. Robots-disallowed URLs are in `blockedByRobots` instead.
   */
  readonly notReached: readonly string[];
  /** Requests made outside the walk, for questions the walk cannot answer. */
  readonly auxiliary: readonly AuxiliaryFetch[];
  /**
   * The HTTP version the root document's host negotiates, from one TLS
   * handshake after the walk.
   *
   * Absent when no handshake was made: auxiliary requests were off, the root
   * document was not served over HTTPS, or the crawl was recorded before this
   * existed. Absent is not HTTP/1.1 — it is not knowing.
   */
  readonly protocol?: ProtocolCheck;
}

interface QueueEntry {
  readonly url: string;
  readonly normalizedUrl: string;
  readonly depth: number;
  readonly discoveredFrom: string | null;
}

const HTML = /^(text\/html|application\/xhtml\+xml)/i;

/**
 * Thrown when a crawl is stopped by its caller's signal.
 *
 * A crawl that was cancelled is not a crawl that failed, and the two must stay
 * distinguishable all the way to the report: one is something a person did, the
 * other is something to look into. Whatever the crawl had already streamed
 * through `onPage` stays written — the pages fetched before the stop are
 * evidence, not debris.
 */
export class CrawlCancelledError extends Error {
  constructor() {
    super('the crawl was cancelled');
    this.name = 'CrawlCancelledError';
  }
}

const stopIfCancelled = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) throw new CrawlCancelledError();
};

/**
 * The politeness delay, interruptible.
 *
 * A plain `setTimeout` would make the delay the floor on how long cancelling
 * takes, and the delay is the one part of a crawl deliberately measured in
 * seconds. Waiting it out before noticing would also be the wrong shape of
 * politeness: nobody is owed the pause before a request that is not going to
 * be made.
 */
const sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
  stopIfCancelled(signal);
  if (ms <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new CrawlCancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

async function loadRobots(
  origin: string,
  options: CrawlOptions,
  request: typeof fetchPage,
): Promise<{ robots: Robots; text: string | null }> {
  if (options.respectRobots === false) return { robots: ALLOW_ALL, text: null };
  const result = await request(new URL('/robots.txt', origin).toString(), {
    userAgent: options.userAgent,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  // A 4xx means no rules exist. A 5xx means the site could not tell us, and
  // the conservative reading — the one Google applies — is to stay out.
  if (result.status !== null && result.status >= 500) {
    return { robots: { groups: [{ agents: ['*'], rules: [{ allow: false, path: '/' }] }], sitemaps: [], absent: false }, text: result.body };
  }
  if (result.status === null || result.status >= 400) return { robots: ALLOW_ALL, text: null };
  return { robots: parseRobots(result.body), text: result.body };
}

interface LoadedSitemaps {
  readonly urls: string[];
  readonly documents: SitemapFetch[];
  readonly videos: SitemapVideoEntry[];
}

/**
 * Fetch the sitemaps a site declares, a document budget at a time.
 *
 * Each sitemap named in robots.txt gets a lane of its own, and the budget is
 * spent round-robin across the lanes: one document from the first, one from
 * the second, and so on, with an index's children going back into the lane
 * they came from. A site that declares one sitemap is unaffected.
 *
 * The alternative — one queue, first in first out — spends the whole budget on
 * whatever was declared first. IGN declares eight sitemaps, of which
 * `sitemap-videos.xml` is fourth, and its article index alone has more
 * children than the budget: 510,000 URLs were read and not one of the 440
 * video entries in a single quarterly file, because the crawl never got that
 * far down the list. What a site declares first is not what an audit needs
 * most.
 */
async function loadSitemaps(
  robots: Robots,
  origin: string,
  options: CrawlOptions,
  request: typeof fetchPage,
): Promise<LoadedSitemaps> {
  const roots = robots.sitemaps.length > 0
    ? [...robots.sitemaps]
    : [new URL('/sitemap.xml', origin).toString()];
  const lanes: string[][] = roots.map((root) => [root]);
  const seen = new Set<string>();
  const urls = new Set<string>();
  const documents: SitemapFetch[] = [];
  const videos: SitemapVideoEntry[] = [];

  let turn = 0;
  while (seen.size < MAX_SITEMAP_DOCUMENTS && lanes.some((lane) => lane.length > 0)) {
    stopIfCancelled(options.signal);
    const lane = lanes[turn % lanes.length];
    turn += 1;
    const next = lane?.shift();
    if (next === undefined || seen.has(next)) continue;
    seen.add(next);

    // Parsed as it arrives, up to the protocol's own ceiling, and opened first
    // when it is a `.xml.gz` — the ceiling is on the uncompressed size. A fetch
    // that returns its body instead of streaming it — a test double, a
    // replayed crawl — is parsed the same way afterwards.
    const parser = createSitemapParser();
    const result = await request(next, {
      userAgent: options.userAgent,
      maxBytes: SITEMAP_MAX_BYTES,
      gunzip: true,
      onText: (chunk) => parser.write(chunk),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    if (result.body !== '') parser.write(result.body);
    const parsed = parser.end(!result.truncated);

    if (result.status !== 200) {
      documents.push({
        url: next,
        status: result.status,
        urlCount: 0,
        videoCount: 0,
        truncated: result.truncated,
      });
      continue;
    }

    for (const url of parsed.urls) {
      const normalized = normalizeUrl(url);
      if (normalized !== null) urls.add(normalized);
    }
    for (const video of parsed.videos) {
      const normalized = normalizeUrl(video.loc);
      videos.push({ ...video, loc: normalized ?? video.loc, sitemap: next });
    }
    documents.push({
      url: next,
      status: result.status,
      urlCount: parsed.urls.length,
      videoCount: parsed.videos.length,
      truncated: result.truncated,
    });
    // Back into the lane it came from, so one index's children cannot crowd
    // out another root's.
    for (const sitemap of parsed.sitemaps) lane?.push(sitemap);
  }
  return { urls: [...urls], documents, videos };
}

export async function crawl(options: CrawlOptions): Promise<CrawlResult> {
  const request = options.fetchImpl ?? fetchPage;
  const firstSeed = options.seeds[0];
  if (firstSeed === undefined) throw new Error('a crawl needs at least one seed URL');

  stopIfCancelled(options.signal);
  const { robots, text: robotsTxt } = await loadRobots(firstSeed, options, request);
  const delayMs = Math.max(options.requestDelayMs ?? 0, crawlDelayMs(robots, options.userAgent));

  const sitemaps: LoadedSitemaps = options.followSitemaps === false
    ? { urls: [], documents: [], videos: [] }
    : await loadSitemaps(robots, firstSeed, options, request);
  const sitemapUrls = sitemaps.urls;

  const queue: QueueEntry[] = [];
  const queued = new Set<string>();
  const blockedByRobots: string[] = [];
  // Kept apart from `queued` so a URL first seen too deep can still be walked
  // if a shallower path to it turns up later.
  const beyondDepth = new Set<string>();

  const enqueue = (url: string, depth: number, from: string | null): void => {
    const normalized = normalizeUrl(url);
    if (normalized === null) return;
    if (!isSameSite(normalized, firstSeed)) return;
    if (queued.has(normalized)) return;
    if (depth > options.maxDepth) {
      beyondDepth.add(normalized);
      return;
    }
    if (options.respectRobots !== false && !isAllowed(robots, options.userAgent, normalized)) {
      queued.add(normalized);
      blockedByRobots.push(normalized);
      return;
    }
    queued.add(normalized);
    queue.push({ url, normalizedUrl: normalized, depth, discoveredFrom: from });
  };

  for (const seed of options.seeds) enqueue(seed, 0, null);
  for (const url of sitemapUrls) enqueue(url, 0, null);

  const auxiliary: AuxiliaryFetch[] = [];
  const pages: CrawledPage[] = [];
  let first = true;

  /** One extra request, paced and cancellable like every other. */
  const aside = async (
    reason: AuxiliaryFetch['reason'],
    target: string,
    extra: { readonly keepBytes?: boolean; readonly userAgent?: string } = {},
  ): Promise<void> => {
    if (!first) await sleep(delayMs, options.signal);
    first = false;
    const userAgent = extra.userAgent ?? options.userAgent;
    auxiliary.push({
      reason,
      url: target,
      ...(extra.userAgent === undefined ? {} : { userAgent: extra.userAgent }),
      fetch: await request(target, {
        userAgent,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(extra.keepBytes === undefined ? {} : { keepBytes: extra.keepBytes }),
      }),
    });
  };

  if (options.auxiliary !== false) {
    for (const variant of hostVariants(firstSeed)) {
      stopIfCancelled(options.signal);
      await aside('host-variant', variant);
    }
    for (const agent of [...new Set(options.userAgentTests ?? [])].slice(0, MAX_UA_TESTS)) {
      stopIfCancelled(options.signal);
      await aside('user-agent-test', firstSeed, { userAgent: agent });
    }
  }

  while (queue.length > 0 && pages.length < options.maxPages) {
    // Checked here and again inside the delay, so the longest a cancelled
    // crawl keeps going is the single request already in flight.
    stopIfCancelled(options.signal);
    const entry = queue.shift();
    if (entry === undefined) break;
    if (!first) await sleep(delayMs, options.signal);
    first = false;

    const result = await request(entry.url, {
      userAgent: options.userAgent,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });

    const isHtml = result.contentType !== null && HTML.test(result.contentType);
    const extracted = isHtml && result.body !== ''
      ? extract(result.body, result.finalUrl)
      : null;

    const page: CrawledPage = {
      url: entry.url,
      normalizedUrl: entry.normalizedUrl,
      depth: entry.depth,
      discoveredFrom: entry.discoveredFrom,
      fetch: result,
      extracted,
    };
    pages.push(page);
    await options.onPage?.(page);

    // A redirect target is a page in its own right and must be visited, or a
    // chain ending in a 404 would never be seen.
    const last = result.redirectChain.at(-1);
    if (last !== undefined) enqueue(result.finalUrl, entry.depth, entry.normalizedUrl);

    for (const link of extracted?.links ?? []) {
      if (link.nofollow) continue;
      enqueue(link.url, entry.depth + 1, entry.normalizedUrl);
    }
  }

  let protocol: ProtocolCheck | undefined;

  // After the walk, because the icons a site declares are found by reading its
  // root document, and reading it is what the walk just did.
  if (options.auxiliary !== false) {
    const root = [...pages].sort((a, b) => a.depth - b.depth)[0];
    const icons = [...new Set((root?.extracted?.icons ?? []).map((icon) => icon.url))];
    for (const icon of icons.slice(0, MAX_ICON_FETCHES)) {
      stopIfCancelled(options.signal);
      await aside('icon', icon, { keepBytes: true });
    }

    // With the host the root document actually came from, after redirects: the
    // version a visitor gets is the canonical host's, not the seed spelling's.
    const landed = root?.fetch.error === null ? root.fetch.finalUrl : null;
    if (landed !== null && landed.startsWith('https://')) {
      stopIfCancelled(options.signal);
      if (!first) await sleep(delayMs, options.signal);
      first = false;
      protocol = await (options.negotiateImpl ?? negotiateProtocol)(landed, {
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
    }
  }

  return {
    seeds: options.seeds,
    pages,
    robots,
    robotsTxt,
    sitemapUrls,
    sitemaps: sitemaps.documents,
    sitemapVideos: sitemaps.videos,
    blockedByRobots,
    notReached: [
      ...queue.map((entry) => entry.normalizedUrl),
      ...[...beyondDepth].filter(
        (url) =>
          !queued.has(url) &&
          (options.respectRobots === false || isAllowed(robots, options.userAgent, url)),
      ),
    ],
    auxiliary,
    ...(protocol === undefined ? {} : { protocol }),
  };
}

/**
 * How many sitemap documents one crawl will read.
 *
 * A bound on work, not a judgement about the site: large sites paginate their
 * sitemaps into hundreds of files and reading them all would cost more
 * requests than the crawl itself. Which documents the budget buys is the
 * question `loadSitemaps` answers by lane.
 */
const MAX_SITEMAP_DOCUMENTS = 50;

/** At most three: a favicon, a touch icon, and one more. Beyond that is noise. */
const MAX_ICON_FETCHES = 3;

/**
 * A ceiling on user-agent tests, because each is a real request to someone's
 * origin and a policy naming forty crawlers should not cost forty visits.
 */
const MAX_UA_TESTS = 12;

/**
 * The scheme and host spellings that must all end up in the same place.
 *
 * Four URLs for a real domain: http and https, apex and www. Empty for a host
 * that cannot have them — an IP literal, `localhost`, any name without a dot —
 * because those variants do not exist and testing them reports DNS failures as
 * if they were the site's fault.
 */
export function hostVariants(seed: string): string[] {
  let url: URL;
  try {
    url = new URL(seed);
  } catch {
    return [];
  }

  const host = url.hostname;
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  if (isIpv4 || host.startsWith('[') || !host.includes('.')) return [];

  const apex = host.replace(/^www\./i, '');
  const variants = new Set<string>();
  for (const hostname of [apex, `www.${apex}`]) {
    for (const protocol of ['http:', 'https:']) {
      const variant = new URL(url.toString());
      variant.protocol = protocol;
      variant.hostname = hostname;
      variant.pathname = '/';
      variant.search = '';
      variant.hash = '';
      variants.add(variant.toString());
    }
  }
  return [...variants];
}
