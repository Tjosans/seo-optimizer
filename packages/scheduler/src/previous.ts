/**
 * The audit a new audit compares itself against.
 *
 * A site's latest completed audit, other than the one being run, rebuilt from
 * the rows it left: the pages of its last completed crawl, each page's raw
 * extraction, what axe-core found on its desktop render when there was one, and
 * every probe outcome. Nothing is re-fetched and nothing new is stored — this
 * reads what `crawlToDatabase` and `persistProbeRuns` already wrote.
 */

import { and, desc, eq, ne } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { audits, crawls, pages, probeResults, renders } from '@seo/db';
import type { Database } from '@seo/db';
import { PREVIOUS_AUDIT_SCHEMA, snapshotPage, snapshotProbes } from '@seo/probes';
import type { PageFacts, PreviousAudit, PreviousAxeViolation } from '@seo/probes';

/** What the renders table's `extracted` column holds, as far as a snapshot reads it. */
type StoredExtracted = NonNullable<PageFacts['extracted']>;

const asHeaders = (value: unknown): Record<string, string> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, string>)
    : null;

/**
 * A page's axe violations out of its rendered row's `capture`, or null when
 * there is no such row, axe was not run, or axe failed there. Read defensively:
 * the column is jsonb, and a row written by an older build has none.
 */
const axeOf = (capture: unknown): PreviousAxeViolation[] | null => {
  if (typeof capture !== 'object' || capture === null) return null;
  const result: unknown = (capture as Record<string, unknown>)['accessibility'];
  if (typeof result !== 'object' || result === null) return null;
  const { error, violations } = result as Record<string, unknown>;
  if (error !== null || !Array.isArray(violations)) return null;
  return violations.flatMap((raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) return [];
    const { id, impact, nodes } = raw as Record<string, unknown>;
    if (typeof id !== 'string' || typeof nodes !== 'number') return [];
    return [{ id, impact: typeof impact === 'string' ? impact : null, nodes }];
  });
};

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

  // The same table twice: the server's response, and the desktop browser's
  // capture of it where the crawl rendered.
  const rendered = alias(renders, 'rendered');
  const pageRows = await db
    .select({
      id: pages.id,
      url: pages.normalizedUrl,
      status: pages.status,
      headers: pages.headers,
      redirectChain: pages.redirectChain,
      extracted: renders.extracted,
      capture: rendered.capture,
    })
    .from(pages)
    .leftJoin(renders, and(eq(renders.pageId, pages.id), eq(renders.mode, 'raw')))
    .leftJoin(rendered, and(eq(rendered.pageId, pages.id), eq(rendered.mode, 'rendered')))
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
        axe: axeOf(row.capture),
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
