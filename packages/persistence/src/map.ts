/**
 * Pure mappers: crawler and probe values in, insert rows out.
 *
 * Nothing here touches a connection. Keeping the translation separate from the
 * writing is what lets the interesting decisions — which URL is the identity,
 * what counts as an edge, what a failed fetch means for a size column — be
 * asserted in a test with no database at all, and reviewed as data rather than
 * as a sequence of statements.
 *
 * Every mapper takes the row's id from its caller instead of leaning on the
 * column default. The sink needs a page's id before the insert returns, so the
 * next page can resolve its `discoveredFromId` against it.
 */

import { createHash } from 'node:crypto';
import { crawlDelayMs, normalizeUrl } from '@seo/crawler';
import type { CrawlOptions, CrawlResult, CrawledPage } from '@seo/crawler';
import type { crawls, pageLinks, pages, probeResults, renders } from '@seo/db';
import type { ProbeRun } from '@seo/probes';

export type NewCrawl = typeof crawls.$inferInsert;
export type NewPage = typeof pages.$inferInsert;
export type NewRender = typeof renders.$inferInsert;
export type NewPageLink = typeof pageLinks.$inferInsert;
export type NewProbeResult = typeof probeResults.$inferInsert;

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

/** `rel` values that make an anchor part of a paginated series. */
const PAGINATION = /\b(?:next|prev|previous)\b/i;

/**
 * The crawl row as it looks the moment the loop starts.
 *
 * `requestDelayMs` is the configured floor only; the delay actually applied is
 * not known until robots.txt has been read, so it is corrected in
 * `toCrawlCompletion`. Recording the floor meanwhile keeps a crashed crawl's
 * row honest about what it was told to do.
 */
export function toCrawlRow(args: {
  readonly id: string;
  readonly auditId: string;
  readonly options: CrawlOptions;
  readonly startedAt?: Date;
}): NewCrawl {
  if (args.options.seeds.length === 0) {
    throw new Error('a crawl needs at least one seed URL');
  }
  return {
    id: args.id,
    auditId: args.auditId,
    // Order is preserved because it is meaningful: the crawler scopes the whole
    // crawl against seeds[0], so which seed came first decides what counts as
    // off-site.
    seedUrls: [...args.options.seeds],
    status: 'running',
    userAgent: args.options.userAgent,
    respectRobots: args.options.respectRobots !== false,
    maxPages: args.options.maxPages,
    maxDepth: args.options.maxDepth,
    requestDelayMs: args.options.requestDelayMs ?? 0,
    startedAt: args.startedAt ?? new Date(),
  };
}

/** The columns only a finished crawl can fill in. */
export function toCrawlCompletion(
  result: CrawlResult,
  options: CrawlOptions,
  finishedAt: Date = new Date(),
): Pick<
  NewCrawl,
  'status' | 'finishedAt' | 'robotsTxt' | 'requestDelayMs' | 'sitemapUrls'
> {
  return {
    status: 'complete',
    finishedAt,
    robotsTxt: result.robotsTxt,
    // What the site said it wanted indexed, frozen at crawl time. A sitemap is
    // a file the site can change between the crawl and the report, so a probe
    // re-run against this row must not re-fetch it.
    sitemapUrls: [...result.sitemapUrls],
    // The politeness delay the loop really used: the configured floor, raised
    // by any robots crawl-delay. The crawler computes this internally and does
    // not report it, so it is recomputed here from the same two inputs.
    requestDelayMs: Math.max(
      options.requestDelayMs ?? 0,
      crawlDelayMs(result.robots, options.userAgent),
    ),
  };
}

/** Marker so a failed crawl says why, without inventing a verdict about the site. */
export function toCrawlFailure(
  cause: unknown,
  finishedAt: Date = new Date(),
): Pick<NewCrawl, 'status' | 'finishedAt' | 'error'> {
  return {
    status: 'failed',
    finishedAt,
    error: cause instanceof Error ? cause.message : String(cause),
  };
}

export function toPageRow(args: {
  readonly id: string;
  readonly crawlId: string;
  readonly page: CrawledPage;
  /** Row id of the page this URL was first linked from; null for a seed. */
  readonly discoveredFromId: string | null;
  readonly fetchedAt?: Date;
}): NewPage {
  const { fetch } = args.page;
  // A transport failure produced no response at all. Writing zero bytes and an
  // empty header map would read as "an empty response arrived", which is a
  // different — and much less alarming — finding than "nothing arrived".
  const responded = fetch.error === null;
  return {
    id: args.id,
    crawlId: args.crawlId,
    url: args.page.url,
    normalizedUrl: args.page.normalizedUrl,
    depth: args.page.depth,
    discoveredFromId: args.discoveredFromId,
    // The status the chain ended on. The hops are in `redirectChain`, so a
    // 301 -> 301 -> 200 stores 200 here without losing the two redirects.
    status: fetch.status,
    fetchError: fetch.error,
    contentType: fetch.contentType,
    // Bytes measured off the wire rather than the declared Content-Length. A
    // non-HTML response gets no render row, so this is the only size kept for
    // it, and a measurement beats a claim.
    contentLength: responded ? fetch.byteLength : null,
    redirectChain: fetch.redirectChain,
    ttfbMs: fetch.ttfbMs,
    totalMs: fetch.totalMs,
    headers: responded ? fetch.headers : null,
    fetchedAt: args.fetchedAt ?? new Date(),
  };
}

/**
 * The captured representation of a page, or null when there was nothing to
 * capture — a non-HTML response, or a fetch that never completed.
 *
 * The extracted signals are stored minus `text`: bodies never enter Postgres,
 * and page text is body, not signal. Its fingerprint survives as `textHash`,
 * which is what a raw-vs-rendered parity check compares.
 */
export function toRenderRow(args: {
  readonly id: string;
  readonly pageId: string;
  readonly page: CrawledPage;
  readonly capturedAt?: Date;
}): NewRender | null {
  const { extracted, fetch } = args.page;
  if (extracted === null) return null;
  const { text, ...signals } = extracted;
  return {
    id: args.id,
    pageId: args.pageId,
    // Only server-delivered responses exist today. A headless renderer will
    // add a 'rendered' row against the same page, which is what turns parity
    // into a join rather than a special case.
    mode: 'raw',
    bodyHash: sha256(fetch.body),
    bodyKey: null,
    byteLength: fetch.byteLength,
    textHash: sha256(text),
    extracted: signals,
    ...(args.capturedAt === undefined ? {} : { capturedAt: args.capturedAt }),
  };
}

/**
 * Every edge this page declares.
 *
 * Only http(s) targets become rows. `mailto:`, `tel:` and unparseable hrefs are
 * links but not edges in a page graph — there is no page for `toPageId` to
 * resolve to — and they survive verbatim in the render's extracted links, so
 * leaving them out of the graph loses nothing.
 *
 * Duplicate targets are kept rather than collapsed: how many times a page links
 * to another page is exactly what the internal-linking probes measure.
 */
export function toPageLinkRows(args: {
  readonly crawlId: string;
  readonly fromPageId: string;
  readonly page: CrawledPage;
}): NewPageLink[] {
  const rows: NewPageLink[] = [];

  const add = (
    toUrl: string,
    kind: NonNullable<NewPageLink['kind']>,
    extra: Partial<NewPageLink> = {},
  ): void => {
    const toNormalizedUrl = normalizeUrl(toUrl);
    if (toNormalizedUrl === null) return;
    rows.push({
      crawlId: args.crawlId,
      fromPageId: args.fromPageId,
      toUrl,
      toNormalizedUrl,
      kind,
      // Everything this crawler sees is the server's own markup. A rendered
      // capture is what will one day set this false.
      inRawHtml: true,
      ...extra,
    });
  };

  const { fetch, extracted } = args.page;

  // One edge for the whole chain: this URL ends up at that one. The individual
  // hops are already on the page row, and attributing hop two to this page
  // would claim an edge this page never declared.
  if (fetch.redirectChain.length > 0 && fetch.finalUrl !== args.page.url) {
    add(fetch.finalUrl, 'redirect');
  }

  if (extracted === null) return rows;

  for (const link of extracted.links) {
    add(link.url, PAGINATION.test(link.rel ?? '') ? 'pagination' : 'anchor', {
      anchorText: link.anchorText === '' ? null : link.anchorText,
      rel: link.rel,
      nofollow: link.nofollow,
    });
  }

  if (extracted.canonical !== null) add(extracted.canonical, 'canonical');

  for (const alternate of extracted.hreflang) {
    // page_links has no column for a language tag, and the tag is what makes
    // an hreflang edge mean anything, so it rides in anchorText — the edge's
    // label — with `rel` carrying the attribute as authored.
    add(alternate.url, 'hreflang', {
      anchorText: alternate.hreflang === '' ? null : alternate.hreflang,
      rel: 'alternate',
    });
  }

  return rows;
}

/**
 * One observation, ready to insert.
 *
 * A page-scoped run with no page id would be refused by the
 * `page_scope_needs_page` constraint. Failing here instead names the URL that
 * could not be resolved, which is the only thing that makes it fixable.
 */
export function toProbeResultRow(args: {
  readonly id: string;
  readonly auditId: string;
  readonly crawlId: string | null;
  readonly run: ProbeRun;
  readonly pageId: string | null;
}): NewProbeResult {
  const { run } = args;
  if (run.scope === 'page' && args.pageId === null) {
    throw new Error(
      `probe "${run.probeId}" observed page ${run.pageUrl ?? '(no url)'}, ` +
        'which has no row in this crawl',
    );
  }
  return {
    id: args.id,
    auditId: args.auditId,
    crawlId: args.crawlId,
    pageId: args.pageId,
    probeId: run.probeId,
    scope: run.scope,
    outcome: run.observation.outcome,
    summary: run.observation.summary,
    data: run.observation.data ?? null,
  };
}

/** Split a batch into insert-sized pieces, to stay clear of parameter limits. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}
