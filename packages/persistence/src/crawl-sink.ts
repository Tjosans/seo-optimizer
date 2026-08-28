/**
 * The crawl sink: the thing you hand to `crawl({ onPage })`.
 *
 * The crawler holds its whole result in memory and knows nothing about a
 * database; the schema knows nothing about a crawl loop. This is the one place
 * that knows both, and it is deliberately the only one.
 *
 * Writing per page rather than at the end is what the `onPage` seam exists for.
 * A crawl of a customer's site is paced by a politeness delay and can run for
 * many minutes: a run that dies at page four hundred should leave four hundred
 * pages of evidence behind, not nothing.
 *
 * Two orderings the crawler guarantees are relied on here, and they are worth
 * naming because the sink would be subtly wrong without them:
 *
 *   `onPage` is awaited before the page's own links are enqueued, so a page's
 *   parent is always already written when the child arrives. That is what makes
 *   `discoveredFromId` resolvable from an in-memory map.
 *
 *   A normalized URL is enqueued at most once per crawl, so no page arrives
 *   twice and `pages_crawl_url_uniq` is never approached.
 */

import { crawl } from '@seo/crawler';
import type { CrawlOptions, CrawlResult, CrawledPage } from '@seo/crawler';
import { crawls, pageLinks, pages, renders } from '@seo/db';
import type { Database } from '@seo/db';
import { eq, sql } from 'drizzle-orm';
import {
  chunk,
  toCrawlCompletion,
  toCrawlFailure,
  toCrawlRow,
  toPageLinkRows,
  toPageRow,
  toRenderRow,
} from './map.js';

/** Rows per insert. Well under the driver's parameter ceiling at 9 columns. */
const INSERT_CHUNK = 500;

export interface CrawlSink {
  /** Id of the `crawls` row, written before the first request goes out. */
  readonly crawlId: string;
  /** Pass this as `crawl({ onPage })`. */
  readonly onPage: (page: CrawledPage) => Promise<void>;
  /** Close the crawl out: resolve the link graph, then mark it complete. */
  finish(result: CrawlResult): Promise<void>;
  /** Close it out as failed. The pages already written stay. */
  fail(cause: unknown): Promise<void>;
  /** Normalized URL to page id, for whatever runs next. */
  pageIds(): ReadonlyMap<string, string>;
}

/**
 * Open a crawl row and return a sink that streams pages into it.
 *
 * The audit is the caller's to create: an audit spans several crawls — raw,
 * rendered, a re-crawl after a fix — and deciding when a new one begins is a
 * product question, not a mapping one.
 */
export async function openCrawl(
  db: Database,
  args: { readonly auditId: string; readonly options: CrawlOptions },
): Promise<CrawlSink> {
  const crawlId = crypto.randomUUID();
  await db.insert(crawls).values(toCrawlRow({ id: crawlId, ...args }));

  const pageIdByUrl = new Map<string, string>();

  const onPage = async (page: CrawledPage): Promise<void> => {
    const pageId = crypto.randomUUID();
    const discoveredFromId =
      page.discoveredFrom === null ? null : pageIdByUrl.get(page.discoveredFrom) ?? null;

    // One transaction per page: a page whose links were only half written
    // would be a false report about what that page points at.
    await db.transaction(async (tx) => {
      await tx.insert(pages).values(toPageRow({ id: pageId, crawlId, page, discoveredFromId }));

      const render = toRenderRow({ id: crypto.randomUUID(), pageId, page });
      if (render !== null) await tx.insert(renders).values(render);

      const links = toPageLinkRows({ crawlId, fromPageId: pageId, page });
      for (const batch of chunk(links, INSERT_CHUNK)) await tx.insert(pageLinks).values(batch);
    });

    pageIdByUrl.set(page.normalizedUrl, pageId);
  };

  return {
    crawlId,
    onPage,
    pageIds: () => pageIdByUrl,
    async finish(result: CrawlResult): Promise<void> {
      // Resolve before the status flips, so a crawl that reads as complete
      // always has a whole link graph behind it.
      await resolveLinkTargets(db, crawlId);
      await db
        .update(crawls)
        .set(toCrawlCompletion(result, args.options))
        .where(eq(crawls.id, crawlId));
    },
    async fail(cause: unknown): Promise<void> {
      await resolveLinkTargets(db, crawlId);
      await db.update(crawls).set(toCrawlFailure(cause)).where(eq(crawls.id, crawlId));
    },
  };
}

/**
 * Point every edge at the page it reached, where that page was fetched.
 *
 * This cannot happen at insert time: a crawl discovers forward, so most edges
 * name a URL that has not been fetched yet. Edges left unresolved are the
 * point — an unfetched target is a page that is out of scope, blocked, beyond
 * the budget or simply missing, which is what the orphan and broken-link
 * probes read. Idempotent, so it is safe on a resumed or failed crawl.
 */
export async function resolveLinkTargets(db: Database, crawlId: string): Promise<void> {
  await db.execute(sql`
    UPDATE ${pageLinks} AS l
       SET to_page_id = p.id
      FROM ${pages} AS p
     WHERE p.crawl_id = l.crawl_id
       AND p.normalized_url = l.to_normalized_url
       AND l.crawl_id = ${crawlId}::uuid
       AND l.to_page_id IS NULL
  `);
}

export interface CrawlToDatabaseResult {
  readonly crawlId: string;
  readonly result: CrawlResult;
  /** Normalized URL to page id, ready to hand to `persistProbeRuns`. */
  readonly pageIds: ReadonlyMap<string, string>;
}

/**
 * Run a crawl and persist it. The ergonomic form of the seam, for callers with
 * no reason to hold the sink themselves.
 *
 * A caller's own `onPage` still runs, after the write, so it can rely on the
 * row being there.
 */
export async function crawlToDatabase(
  db: Database,
  args: { readonly auditId: string; readonly options: CrawlOptions },
): Promise<CrawlToDatabaseResult> {
  const sink = await openCrawl(db, args);
  const caller = args.options.onPage;

  try {
    const result = await crawl({
      ...args.options,
      onPage: async (page) => {
        await sink.onPage(page);
        await caller?.(page);
      },
    });
    await sink.finish(result);
    return { crawlId: sink.crawlId, result, pageIds: sink.pageIds() };
  } catch (cause) {
    await sink.fail(cause);
    throw cause;
  }
}
