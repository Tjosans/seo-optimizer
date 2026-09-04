/**
 * One audit, start to finish.
 *
 * Crawl, observe, record — in that order, because each step needs the rows the
 * one before it wrote. This is the only place that knows the whole sequence,
 * which is what lets the scheduler above it care about nothing but when to
 * start one and how many to run at once.
 *
 * What this deliberately does NOT do is grade. Probes produce evidence and it
 * is filed against the audit; turning that evidence into `checkStates` and a
 * readiness verdict is a separate concern with its own package to come, so
 * `audits.readiness` is left null and the report layer is what will fill it.
 * An audit that reads `complete` here means "the evidence is gathered", not
 * "the launch decision is made" — see ROADMAP Phase 4.
 */

import { eq } from 'drizzle-orm';
import { audits } from '@seo/db';
import type { Database } from '@seo/db';
import { crawlToDatabase, persistProbeRuns } from '@seo/persistence';
import { runProbes } from '@seo/probes';
import type { SiteContext } from '@seo/probes';
import { JobCancelledError } from '@seo/queue';
import type { AuditJob, AuditOutcome } from './types.js';

/**
 * Run the pipeline for one already-created audit row.
 *
 * The row is expected to exist and to be `pending`: the scheduler writes it at
 * submit time so a caller has an id to poll before any request goes out.
 *
 * `signal` is checked between steps rather than inside them. The crawl loop has
 * no cancellation of its own yet (ROADMAP Phase 4), so the finest granularity
 * available is "not after this step" — honest about stopping the audit, honest
 * that the crawl it started still runs to its budget.
 */
export async function runAudit(
  db: Database,
  job: AuditJob,
  signal?: AbortSignal,
): Promise<AuditOutcome> {
  const stopIfCancelled = (): void => {
    if (signal?.aborted === true) throw new JobCancelledError(job.auditId);
  };

  stopIfCancelled();
  await db
    .update(audits)
    .set({ status: 'running', startedAt: new Date() })
    .where(eq(audits.id, job.auditId));

  try {
    const crawled = await crawlToDatabase(db, {
      auditId: job.auditId,
      options: job.options,
    });
    stopIfCancelled();

    const context: SiteContext = {
      origin: job.origin,
      crawl: crawled.result,
      flags: job.flags,
    };
    const runs = runProbes(context);

    await persistProbeRuns(db, {
      auditId: job.auditId,
      crawlId: crawled.crawlId,
      runs,
      pageIds: crawled.pageIds,
    });
    stopIfCancelled();

    await db
      .update(audits)
      .set({ status: 'complete', finishedAt: new Date() })
      .where(eq(audits.id, job.auditId));

    return {
      auditId: job.auditId,
      crawlId: crawled.crawlId,
      pagesCrawled: crawled.result.pages.length,
      probeRuns: runs.length,
    };
  } catch (cause) {
    // The crawl's own rows are already closed out by the sink. What is recorded
    // here is the audit's verdict on itself, and a cancelled audit is not a
    // failed one: one is something a person did, the other is something to
    // investigate.
    const cancelled = cause instanceof JobCancelledError;
    await db
      .update(audits)
      .set({
        status: cancelled ? 'cancelled' : 'failed',
        finishedAt: new Date(),
        error: cancelled ? null : messageOf(cause),
      })
      .where(eq(audits.id, job.auditId));
    throw cause;
  }
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
