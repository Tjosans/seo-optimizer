/**
 * The launch-gate history `release-regression-review` compares.
 *
 * Probes cannot see check states, so whoever runs them supplies the history:
 * which gates the previous audit passed, which fail in this one, and which the
 * release's review log has reopened. The first two are the grader's verdicts;
 * the last is the review log's.
 */

import { and, desc, eq } from 'drizzle-orm';
import { audits, checkStates } from '@seo/db';
import type { Database } from '@seo/db';
import { loadReviewRuns } from '@seo/grader';
import type { GradeResult } from '@seo/grader';
import type { Check } from '@seo/core';
import type { ReleaseGateHistory } from '@seo/probes';

/** Ids of the launch gates in `checks`. */
const gateIds = (checks: readonly Pick<Check, 'id' | 'launchGate'>[]): Set<string> =>
  new Set(checks.filter((check) => check.launchGate).map((check) => check.id));

/** Pure: assemble the history from its three sources. */
export function gateHistory(input: {
  readonly checks: readonly Pick<Check, 'id' | 'launchGate'>[];
  /** Check states (id, status) the previous audit wrote. */
  readonly previousStates: readonly { readonly checkId: string; readonly status: string }[];
  /** This audit's first-pass grade. */
  readonly grade: Pick<GradeResult, 'checks'>;
  /** Check ids with a `reopened` review run in the release. */
  readonly reopened: readonly string[];
}): ReleaseGateHistory {
  const gates = gateIds(input.checks);
  return {
    passedBefore: input.previousStates
      .filter((row) => row.status === 'passed' && gates.has(row.checkId))
      .map((row) => row.checkId)
      .sort(),
    failingNow: input.grade.checks
      .filter((graded) => graded.status === 'failed' && gates.has(graded.checkId))
      .map((graded) => graded.checkId)
      .sort(),
    reopened: [...new Set(input.reopened)].sort(),
  };
}

/** The latest completed audit of the site other than `excludeAuditId`, or null. */
export async function latestCompleteAuditId(
  db: Database,
  siteId: string,
  excludeAuditId: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: audits.id })
    .from(audits)
    .where(and(eq(audits.siteId, siteId), eq(audits.status, 'complete')))
    .orderBy(desc(audits.finishedAt));
  return rows.find((row) => row.id !== excludeAuditId)?.id ?? null;
}

/**
 * Read the previous audit's states and the release's reopened runs, then join
 * them with this audit's first-pass grade.
 */
export async function loadGateHistory(
  db: Database,
  input: {
    readonly siteId: string;
    readonly auditId: string;
    /** The release's name, as `ReviewRun.releaseId` holds it. */
    readonly release: string;
    readonly checks: readonly Pick<Check, 'id' | 'launchGate'>[];
    readonly grade: Pick<GradeResult, 'checks'>;
  },
): Promise<ReleaseGateHistory> {
  const previousId = await latestCompleteAuditId(db, input.siteId, input.auditId);
  const previousStates =
    previousId === null
      ? []
      : await db
          .select({ checkId: checkStates.checkId, status: checkStates.status })
          .from(checkStates)
          .where(eq(checkStates.auditId, previousId));

  const runs = await loadReviewRuns(db, input.siteId);
  const reopened = runs
    .filter((run) => run.releaseId === input.release && run.result === 'reopened')
    .map((run) => run.checkId);

  return gateHistory({
    checks: input.checks,
    previousStates,
    grade: input.grade,
    reopened,
  });
}
