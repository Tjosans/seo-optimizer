/**
 * ProbeRun[] to `probe_results`.
 *
 * Probes speak in normalized URLs; the evidence table speaks in page ids. That
 * translation is the whole job here, and it is why this runs after a crawl
 * rather than beside it: a page must exist before an observation about it can
 * be filed against it.
 *
 * Row ids are returned in the order the runs were given, because the next layer
 * up — grading a check and recording what it was graded on — has to name the
 * rows it used when it writes `check_evidence`.
 */

import { eq } from 'drizzle-orm';
import { pages, probeResults } from '@seo/db';
import type { Database } from '@seo/db';
import type { ProbeRun } from '@seo/probes';
import { chunk, toProbeResultRow } from './map.js';

/** Rows per insert. Well under the driver's parameter ceiling at 9 columns. */
const INSERT_CHUNK = 500;

/** Normalized URL to page id for one crawl, read back from the database. */
export async function loadPageIds(
  db: Database,
  crawlId: string,
): Promise<ReadonlyMap<string, string>> {
  const rows = await db
    .select({ id: pages.id, normalizedUrl: pages.normalizedUrl })
    .from(pages)
    .where(eq(pages.crawlId, crawlId));
  return new Map(rows.map((row) => [row.normalizedUrl, row.id]));
}

/**
 * Write every observation from one probe run.
 *
 * `pageIds` is an optimisation, not a requirement: pass the map the crawl sink
 * already built, or leave it out and have the crawl's pages read back — which
 * is what lets probes be re-run against a stored crawl in another process.
 */
export async function persistProbeRuns(
  db: Database,
  args: {
    readonly auditId: string;
    /** Null only for an observation made outside any crawl. */
    readonly crawlId: string | null;
    readonly runs: readonly ProbeRun[];
    readonly pageIds?: ReadonlyMap<string, string>;
  },
): Promise<readonly string[]> {
  if (args.runs.length === 0) return [];

  const pageIds =
    args.pageIds ??
    (args.crawlId === null ? new Map<string, string>() : await loadPageIds(db, args.crawlId));

  // Mapped in full before anything is written: an unresolvable page URL means
  // the caller paired these probes with the wrong crawl, and that should
  // surface as such rather than as a half-written evidence trail.
  const prepared = args.runs.map((run) => {
    const id = crypto.randomUUID();
    return {
      id,
      row: toProbeResultRow({
        id,
        auditId: args.auditId,
        crawlId: args.crawlId,
        run,
        pageId: run.pageUrl === undefined ? null : pageIds.get(run.pageUrl) ?? null,
      }),
    };
  });

  for (const batch of chunk(prepared.map((entry) => entry.row), INSERT_CHUNK)) {
    await db.insert(probeResults).values(batch);
  }
  return prepared.map((entry) => entry.id);
}
