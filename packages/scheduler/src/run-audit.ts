/**
 * One audit, start to finish.
 *
 * Crawl, observe, record, grade — in that order, because each step needs what
 * the one before it wrote. This is the only place that knows the whole
 * sequence, which is what lets the scheduler above it care about nothing but
 * when to start one and how many to run at once.
 *
 * Grading is last and it is deliberately the only step that writes a verdict.
 * Everything before it states what was seen; `@seo/grader` states what that
 * means against the pinned corpus and freezes the answer onto the audit row, so
 * an audit that reads `complete` now means the decision is made and will not
 * move when the engine's scoring later does. What the verdict is allowed to say
 * is the grader's business, not this file's — including that most of the corpus
 * comes back ungraded, because most detectors are not implemented yet.
 */

import { eq } from 'drizzle-orm';
import { audits } from '@seo/db';
import type { Database } from '@seo/db';
import { CorpusVersionMismatchError, gradeAudit, recordGrade, toEvidence } from '@seo/grader';
import { crawlToDatabase, persistProbeRuns } from '@seo/persistence';
import { runProbes } from '@seo/probes';
import type { SiteContext } from '@seo/probes';
import { JobCancelledError } from '@seo/queue';
import type { AuditJob, AuditOutcome, CorpusSource } from './types.js';

/**
 * Run the pipeline for one already-created audit row.
 *
 * The row is expected to exist and to be `pending`: the scheduler writes it at
 * submit time so a caller has an id to poll before any request goes out, and
 * puts it back to `pending` before a retry.
 *
 * This function reports on the attempt it makes and nothing else. If the run
 * fails it writes `failed` and the message, because that is true of the run it
 * just made; whether another attempt follows is the scheduler's decision and
 * the scheduler reopens the row when it makes it. A retried audit therefore
 * writes a second crawl under the same audit id — the failed one stays, with
 * whatever it managed to persist before it died.
 *
 * `signal` is checked between steps rather than inside them. The crawl loop has
 * no cancellation of its own yet (ROADMAP Phase 4), so the finest granularity
 * available is "not after this step" — honest about stopping the audit, honest
 * that the crawl it started still runs to its budget.
 */
export async function runAudit(
  db: Database,
  job: AuditJob,
  corpusSource: CorpusSource,
  signal?: AbortSignal,
): Promise<AuditOutcome> {
  const stopIfCancelled = (): void => {
    if (signal?.aborted === true) throw new JobCancelledError(job.auditId);
  };

  stopIfCancelled();
  // `error` is cleared as well as set: on a retry the column still holds the
  // previous attempt's message, and a row that reads `running` next to a
  // failure is a row nobody can act on.
  await db
    .update(audits)
    .set({ status: 'running', startedAt: new Date(), error: null })
    .where(eq(audits.id, job.auditId));

  try {
    // Resolved before anything is fetched. An audit pinned to a corpus this
    // process cannot produce is unreportable however well the crawl goes, and
    // finding that out after twenty minutes of someone else's bandwidth would
    // be nobody's idea of a good failure.
    const corpus = await corpusSource(job.corpusVersion);
    if (corpus.version !== job.corpusVersion) {
      throw new CorpusVersionMismatchError(job.corpusVersion, corpus.version);
    }
    stopIfCancelled();

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

    const resultIds = await persistProbeRuns(db, {
      auditId: job.auditId,
      crawlId: crawled.crawlId,
      runs,
      pageIds: crawled.pageIds,
    });
    stopIfCancelled();

    const grade = gradeAudit({
      corpus,
      flags: job.flags,
      evidence: toEvidence(runs, resultIds),
    });
    const recorded = await recordGrade(db, {
      auditId: job.auditId,
      corpus,
      grade,
    });

    await db
      .update(audits)
      .set({ status: 'complete', finishedAt: new Date() })
      .where(eq(audits.id, job.auditId));

    return {
      auditId: job.auditId,
      crawlId: crawled.crawlId,
      pagesCrawled: crawled.result.pages.length,
      probeRuns: runs.length,
      checksGraded: recorded.written,
      readiness: recorded.frozen,
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
