/**
 * The audit a new audit compares itself against.
 *
 * A site's latest completed audit, other than the one being run, rebuilt from
 * the rows it left: the pages of its last completed crawl, each page's raw
 * extraction, and every probe outcome. Nothing is re-fetched and nothing new is
 * stored — this reads what `crawlToDatabase` and `persistProbeRuns` already wrote.
 */

import { and, desc, eq, ne } from 'drizzle-orm';
import { audits, crawls, pages, probeResults, renders } from '@seo/db';
import type { Database } from '@seo/db';
import { PREVIOUS_AUDIT_SCHEMA, snapshotPage, snapshotProbes } from '@seo/probes';
import type { PageFacts, PreviousAudit } from '@seo/probes';

/** What the renders table's `extracted` column holds, as far as a snapshot reads it. */
type StoredExtracted = NonNullable<PageFacts['extracted']>;

const asHeaders = (value: unknown): Record<string, string> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, string>)
    : null;

const finalUrlOf = (chain: unknown, url: string): string => {
  if (!Array.isArray(chain) || chain.length === 0) return url;
  const last: unknown = chain[chain.length - 1];
  const hop = typeof last === 'object' && last !== null ? (last as Record<string, unknown>) : {};
  if (typeof hop['location'] !== 'string') return url;
  try {
    return new URL(hop['location'], typeof hop['url'] === 'string' ? hop['url'] : url).href;
  } catch {
    return url;
  }
};

/**
 * Null when the site has no earlier completed audit, or that audit has no
 * completed crawl — the caller runs its probes without a comparison, and the
 * detectors that need one say `not-applicable`.
 */
export async function loadPreviousAudit(
  db: Database,
  input: { readonly siteId: string; readonly origin: string; readonly excludeAuditId: string },
): Promise<PreviousAudit | null> {
  const [audit] = await db
    .select({ id: audits.id, finishedAt: audits.finishedAt })
    .from(audits)
    .where(
      and(
        eq(audits.siteId, input.siteId),
        eq(audits.status, 'complete'),
        ne(audits.id, input.excludeAuditId),
      ),
    )
    .orderBy(desc(audits.finishedAt))
    .limit(1);
  if (audit === undefined) return null;

  // A retried audit holds several crawls; only the one that finished counts.
  const [crawl] = await db
    .select({ id: crawls.id, finishedAt: crawls.finishedAt })
    .from(crawls)
    .where(and(eq(crawls.auditId, audit.id), eq(crawls.status, 'complete')))
    .orderBy(desc(crawls.createdAt))
    .limit(1);
  if (crawl === undefined) return null;

  const pageRows = await db
    .select({
      id: pages.id,
      url: pages.normalizedUrl,
      status: pages.status,
      headers: pages.headers,
      redirectChain: pages.redirectChain,
      extracted: renders.extracted,
    })
    .from(pages)
    .leftJoin(renders, and(eq(renders.pageId, pages.id), eq(renders.mode, 'raw')))
    .where(eq(pages.crawlId, crawl.id));

  const probeRows = await db
    .select({
      probeId: probeResults.probeId,
      outcome: probeResults.outcome,
      pageId: probeResults.pageId,
    })
    .from(probeResults)
    .where(and(eq(probeResults.auditId, audit.id), eq(probeResults.crawlId, crawl.id)));

  const urlOfPage = new Map(pageRows.map((row) => [row.id, row.url]));
  const finishedAt = crawl.finishedAt ?? audit.finishedAt ?? new Date();

  return {
    schema: PREVIOUS_AUDIT_SCHEMA,
    origin: input.origin,
    takenAt: finishedAt.toISOString(),
    pages: pageRows.map((row) =>
      snapshotPage({
        url: row.url,
        finalUrl: finalUrlOf(row.redirectChain, row.url),
        status: row.status,
        headers: asHeaders(row.headers),
        extracted: (row.extracted ?? null) as StoredExtracted | null,
      }),
    ),
    probes: snapshotProbes(
      probeRows.map((row) => ({
        probeId: row.probeId,
        scope: row.pageId === null ? ('site' as const) : ('page' as const),
        ...(row.pageId === null ? {} : { pageUrl: urlOfPage.get(row.pageId) ?? '' }),
        observation: { outcome: row.outcome, summary: '' },
      })),
    ),
  };
}
