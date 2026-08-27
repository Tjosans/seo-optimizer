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

import { extract, extractSitemapUrls } from './extract.js';
import type { Extracted } from './extract.js';
import { fetchPage } from './fetch.js';
import type { FetchResult } from './fetch.js';
import { ALLOW_ALL, crawlDelayMs, isAllowed, parseRobots } from './robots.js';
import type { Robots } from './robots.js';
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
  /** Injection seam for tests and for replaying a stored crawl. */
  readonly fetchImpl?: typeof fetchPage;
  /** Called as each page completes, so a long crawl can stream to storage. */
  readonly onPage?: (page: CrawledPage) => void | Promise<void>;
}

export interface CrawlResult {
  readonly seeds: readonly string[];
  readonly pages: readonly CrawledPage[];
  readonly robots: Robots;
  readonly robotsTxt: string | null;
  /** Every URL the site's own sitemaps declare, normalized. */
  readonly sitemapUrls: readonly string[];
  /** In-scope URLs left unfetched because robots.txt disallowed them. */
  readonly blockedByRobots: readonly string[];
  /** In-scope URLs discovered but not fetched, because a budget ran out. */
  readonly notReached: readonly string[];
}

interface QueueEntry {
  readonly url: string;
  readonly normalizedUrl: string;
  readonly depth: number;
  readonly discoveredFrom: string | null;
}

const HTML = /^(text\/html|application\/xhtml\+xml)/i;

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

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

/** Fetch every sitemap reachable from robots.txt, following index files once. */
async function loadSitemaps(
  robots: Robots,
  origin: string,
  options: CrawlOptions,
  request: typeof fetchPage,
): Promise<string[]> {
  const queue = robots.sitemaps.length > 0
    ? [...robots.sitemaps]
    : [new URL('/sitemap.xml', origin).toString()];
  const seen = new Set<string>();
  const urls = new Set<string>();

  while (queue.length > 0 && seen.size < 50) {
    const next = queue.shift();
    if (next === undefined || seen.has(next)) continue;
    seen.add(next);

    const result = await request(next, {
      userAgent: options.userAgent,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    if (result.status !== 200 || result.body === '') continue;

    const parsed = extractSitemapUrls(result.body);
    for (const url of parsed.urls) {
      const normalized = normalizeUrl(url);
      if (normalized !== null) urls.add(normalized);
    }
    for (const sitemap of parsed.sitemaps) queue.push(sitemap);
  }
  return [...urls];
}

export async function crawl(options: CrawlOptions): Promise<CrawlResult> {
  const request = options.fetchImpl ?? fetchPage;
  const firstSeed = options.seeds[0];
  if (firstSeed === undefined) throw new Error('a crawl needs at least one seed URL');

  const { robots, text: robotsTxt } = await loadRobots(firstSeed, options, request);
  const delayMs = Math.max(options.requestDelayMs ?? 0, crawlDelayMs(robots, options.userAgent));

  const sitemapUrls = options.followSitemaps === false
    ? []
    : await loadSitemaps(robots, firstSeed, options, request);

  const queue: QueueEntry[] = [];
  const queued = new Set<string>();
  const blockedByRobots: string[] = [];

  const enqueue = (url: string, depth: number, from: string | null): void => {
    const normalized = normalizeUrl(url);
    if (normalized === null) return;
    if (!isSameSite(normalized, firstSeed)) return;
    if (queued.has(normalized)) return;
    if (depth > options.maxDepth) return;
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

  const pages: CrawledPage[] = [];
  let first = true;

  while (queue.length > 0 && pages.length < options.maxPages) {
    const entry = queue.shift();
    if (entry === undefined) break;
    if (!first) await sleep(delayMs);
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

  return {
    seeds: options.seeds,
    pages,
    robots,
    robotsTxt,
    sitemapUrls,
    blockedByRobots,
    notReached: queue.map((entry) => entry.normalizedUrl),
  };
}
