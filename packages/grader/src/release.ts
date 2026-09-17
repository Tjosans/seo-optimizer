/**
 * Releases and their review log, in and out of Postgres.
 *
 * The release record and the review runs are what a person supplies for
 * v5.0's second assessment; the engine only reads them. Two rules shape the
 * writes:
 *
 * A review run is appended, never edited. The table's trigger enforces it,
 * and `recordReviewRun` refuses a run the assessment would count as an input
 * error, so the log holds nothing that would hold every gate it touches.
 *
 * A release's cutover binding is written when authorization is recorded and
 * never recomputed from the release's own columns — it is the record of what
 * the authorizer was shown.
 */

import { and, eq } from 'drizzle-orm';
import { reviewRunProblem } from '@seo/core';
import type {
  Corpus,
  CutoverAuthorization,
  LaunchDecision,
  ReleaseRecord,
  ReviewRun,
} from '@seo/core';
import { releases, reviewRuns } from '@seo/db';
import type { Database } from '@seo/db';

/** A review run the log would read as an input error. */
export class InvalidReviewRunError extends Error {
  constructor(readonly runId: string, readonly problem: string) {
    super(`review run ${runId} was not recorded: ${problem}`);
    this.name = 'InvalidReviewRunError';
  }
}

export class UnknownReleaseError extends Error {
  constructor(readonly id: string) {
    super(`no release ${id}`);
    this.name = 'UnknownReleaseError';
  }
}

/**
 * The database or a transaction on it. Both writers below take either, so an
 * import can put a release and its runs down together or not at all.
 */
export type Writer = Pick<Database, 'insert' | 'select'>;

/** A release as written. `releaseId` names it; everything else may be blank. */
export type ReleaseInput = Omit<ReleaseRecord, 'assessedAt' | 'reviews'> & {
  readonly releaseId: string;
};

const at = (value: string | undefined): Date | null =>
  value === undefined || value === '' ? null : new Date(value);
const iso = (value: Date | null): string | undefined => value?.toISOString();
const text = (value: string | null): string | undefined => value ?? undefined;

/**
 * Create or replace a site's release by its name. Returns the row id, which
 * is what `audits.release_id` points at.
 */
export async function saveRelease(
  db: Writer,
  siteId: string,
  release: ReleaseInput,
): Promise<string> {
  const cutover = release.cutover;
  const values = {
    siteId,
    releaseId: release.releaseId,
    scopeRevision: release.scopeRevision ?? null,
    origin: release.origin ?? null,
    scopeApprover: release.scopeApprover ?? null,
    scopeApprovedAt: at(release.scopeApprovedAt),
    scopeApprovalEvidence: release.scopeApprovalEvidence ?? null,
    decisionOwner: release.decisionOwner ?? null,
    criteria: release.criteria ?? null,
    cutoverAuthorizer: cutover?.authorizer ?? null,
    cutoverAuthorizedAt: at(cutover?.authorizedAt),
    cutoverDecisionReference: cutover?.decisionReference ?? null,
    cutoverAt: at(cutover?.cutoverAt),
    cutoverBinding: cutover?.binding ?? null,
    launchDecision: release.launchDecision ?? null,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(releases)
    .values(values)
    .onConflictDoUpdate({
      target: [releases.siteId, releases.releaseId],
      set: values,
    })
    .returning({ id: releases.id });
  return row!.id;
}

/**
 * Append one run to a site's review log.
 *
 * Checked as the assessment would check it, bounded by `now` in place of an
 * assessment time: a run reviewed in the future, naming a check the corpus
 * does not hold, or missing a field is refused rather than stored to hold its
 * gate forever. A run id already in the log is refused by the table.
 */
export async function recordReviewRun(
  db: Writer,
  args: {
    readonly siteId: string;
    readonly corpus: Corpus;
    readonly run: ReviewRun;
    readonly now?: Date;
  },
): Promise<void> {
  const { run } = args;
  const known = new Set(args.corpus.checks.map((check) => check.id));
  const problem = reviewRunProblem(run, known, (args.now ?? new Date()).toISOString());
  if (problem !== null) throw new InvalidReviewRunError(run.runId, problem);

  await db.insert(reviewRuns).values(reviewRunRow(args.siteId, run));
}

/** The `review_runs` row for a run. A blank optional field is stored as null. */
export function reviewRunRow(siteId: string, run: ReviewRun): typeof reviewRuns.$inferInsert {
  return {
    siteId,
    runId: run.runId,
    checkId: run.checkId,
    releaseId: run.releaseId,
    scopeRevision: run.scopeRevision,
    criteriaRevision: run.criteriaRevision,
    origin: run.origin,
    environment: run.environment,
    testedAt: new Date(run.testedAt),
    tester: run.tester,
    result: run.result,
    evidence: run.evidence,
    reviewedBy: run.reviewedBy,
    reviewedAt: new Date(run.reviewedAt),
    nextReviewAt: at(run.nextReviewAt),
    eventTrigger: run.eventTrigger === undefined || run.eventTrigger === '' ? null : run.eventTrigger,
  };
}

/** Every run logged for a site, oldest test first. */
export async function loadReviewRuns(db: Writer, siteId: string): Promise<ReviewRun[]> {
  const rows = await db
    .select()
    .from(reviewRuns)
    .where(eq(reviewRuns.siteId, siteId))
    .orderBy(reviewRuns.testedAt, reviewRuns.runId);
  return rows.map((row) => ({
    runId: row.runId,
    checkId: row.checkId,
    releaseId: row.releaseId,
    scopeRevision: row.scopeRevision,
    criteriaRevision: row.criteriaRevision,
    origin: row.origin,
    environment: row.environment,
    testedAt: row.testedAt.toISOString(),
    tester: row.tester,
    result: row.result,
    evidence: row.evidence,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt.toISOString(),
    ...(row.nextReviewAt === null ? {} : { nextReviewAt: row.nextReviewAt.toISOString() }),
    ...(row.eventTrigger === null ? {} : { eventTrigger: row.eventTrigger }),
  }));
}

/**
 * A release with its site's whole review log, ready for
 * `computeCutoverReadiness`. `assessedAt` is the caller's to add.
 */
export async function loadRelease(
  db: Database,
  id: string,
): Promise<ReleaseRecord & { readonly siteId: string }> {
  const [row] = await db.select().from(releases).where(eq(releases.id, id));
  if (row === undefined) throw new UnknownReleaseError(id);

  const cutover: CutoverAuthorization = {
    ...(row.cutoverAuthorizer === null ? {} : { authorizer: row.cutoverAuthorizer }),
    ...(row.cutoverAuthorizedAt === null ? {} : { authorizedAt: row.cutoverAuthorizedAt.toISOString() }),
    ...(row.cutoverDecisionReference === null ? {} : { decisionReference: row.cutoverDecisionReference }),
    ...(row.cutoverAt === null ? {} : { cutoverAt: row.cutoverAt.toISOString() }),
    ...(row.cutoverBinding === null
      ? {}
      : { binding: row.cutoverBinding as NonNullable<CutoverAuthorization['binding']> }),
  };

  const record: ReleaseRecord & { siteId: string } = {
    siteId: row.siteId,
    releaseId: row.releaseId,
    reviews: await loadReviewRuns(db, row.siteId),
    ...optional('scopeRevision', text(row.scopeRevision)),
    ...optional('origin', text(row.origin)),
    ...optional('scopeApprover', text(row.scopeApprover)),
    ...optional('scopeApprovedAt', iso(row.scopeApprovedAt)),
    ...optional('scopeApprovalEvidence', text(row.scopeApprovalEvidence)),
    ...optional('decisionOwner', text(row.decisionOwner)),
    ...(row.criteria === null ? {} : { criteria: row.criteria as Record<string, string> }),
    ...(Object.keys(cutover).length === 0 ? {} : { cutover }),
    ...(row.launchDecision === null
      ? {}
      : { launchDecision: row.launchDecision as LaunchDecision }),
  };
  return record;
}

/** The row id of a site's release by name, or null. */
export async function findRelease(
  db: Database,
  siteId: string,
  releaseId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: releases.id })
    .from(releases)
    .where(and(eq(releases.siteId, siteId), eq(releases.releaseId, releaseId)));
  return row?.id ?? null;
}

function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: string };
}
