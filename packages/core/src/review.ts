/**
 * Review history, and whether it is current.
 *
 * v5.0 separates what a check's Status says from what was last observed. A
 * status is a workflow value a person sets; a review run is a dated record of
 * someone testing the check against a stated release, scope and criterion,
 * in a stated environment, and of someone else reviewing that test. Runs are
 * appended, never replaced: a regression is logged as a `reopened` run, and a
 * retest is another run after it.
 *
 * A gate is only satisfied by its *current* review — the latest run taken in
 * the current release context — and only while that run passed, is not past
 * its next review date, and agrees with the status and evidence on the check.
 * Everything here mirrors the workbook's Checklist R:U columns and its
 * ReviewRuns data checks (SEO-Launch-Checklist-v5.0.xlsx, Release review).
 */

import type { Check, CheckStatus } from './check.js';
import type { CheckState } from './state.js';

/**
 * What kind of test can evidence a gate. Derived from the phase, as the
 * workbook's scope check derives it: discovery work is planned, launch-day
 * work is observed in production after cutover, and everything between is
 * preflight, testable before cutover.
 */
export type EvidenceClass = 'planning' | 'preflight' | 'live';

export function evidenceClassOf(check: Pick<Check, 'phase'>): EvidenceClass {
  if (check.phase === 0) return 'planning';
  if (check.phase === 5) return 'live';
  return 'preflight';
}

export type ReviewEnvironment = 'planning' | 'pre-production' | 'production';

/** The environments a run may be taken in and still evidence its class. */
export function environmentFits(
  evidenceClass: EvidenceClass,
  environment: ReviewEnvironment,
): boolean {
  switch (evidenceClass) {
    case 'planning': return environment === 'planning';
    case 'live': return environment === 'production';
    case 'preflight': return environment === 'pre-production' || environment === 'production';
  }
}

/** A run's outcome: a status, or `reopened` for a change or incident logged against a result. */
export type ReviewResult = CheckStatus | 'reopened';

/** One review run. Append-only; history is never rewritten to improve readiness. */
export interface ReviewRun {
  readonly runId: string;
  readonly checkId: string;
  readonly releaseId: string;
  readonly scopeRevision: string;
  /** The wording of the requirement the run was tested against. */
  readonly criteriaRevision: string;
  readonly origin: string;
  readonly environment: ReviewEnvironment;
  /** ISO timestamps, UTC. */
  readonly testedAt: string;
  readonly tester: string;
  readonly result: ReviewResult;
  /**
   * Must match `CheckState.evidence`, or its `evidenceRef`, for the run to be
   * current.
   */
  readonly evidence: string;
  readonly reviewedBy: string;
  readonly reviewedAt: string;
  /** When the result lapses. A passed run needs this or an event trigger. */
  readonly nextReviewAt?: string;
  /** What reopens the result — a release, a migration. Required on `reopened`. */
  readonly eventTrigger?: string;
}

/**
 * Freshness of a check's review history, in the workbook's order of
 * precedence. Only `current` satisfies a gate.
 */
export type ReviewState =
  /** No run in the current context, and the status does not claim a pass. */
  | 'not-reviewed'
  /** The status says passed with no current run behind it. */
  | 'review-required'
  /** Two runs tie for latest; nobody can say which is the result. */
  | 'ambiguous'
  /** Some run for this check fails the data checks. */
  | 'invalid'
  | 'reopened'
  | 'failed'
  /** Past its next review date at the assessment time. */
  | 'overdue'
  /** The status or evidence on the check disagrees with the latest run. */
  | 'reconcile'
  /** The latest run is neither passed nor a blocker (not started, in progress, skipped). */
  | 'unfinished'
  | 'current';

/**
 * The stable citation for the verdict an audit holds on a check. A review run
 * of a machine-verified pass cites this rather than the grader's summary
 * line, which is report wording and changes between engine versions — a
 * re-grade of the same audit would otherwise read as `reconcile`. A different
 * audit is different evidence, and gets a different reference.
 */
export function evidenceReference(auditId: string, checkId: string): string {
  return `audit:${auditId}#${checkId}`;
}

/** Whether a run cites the evidence a state holds, by its text or its reference. */
export function citesEvidence(
  run: Pick<ReviewRun, 'evidence'>,
  state: Pick<CheckState, 'evidence' | 'evidenceRef'>,
): boolean {
  return (
    run.evidence === state.evidence ||
    (filled(state.evidenceRef) && run.evidence === state.evidenceRef)
  );
}

/** The context a run has to have been taken in to count. */
export interface ReviewContext {
  readonly releaseId: string | undefined;
  readonly scopeRevision: string | undefined;
  readonly origin: string | undefined;
  /** The moment freshness is judged at. Never the wall clock implicitly. */
  readonly assessedAt: string | undefined;
  /** Criterion revision a run for `check` must name. */
  readonly criteriaRevision: (check: Check) => string;
}

const RESULTS: ReadonlySet<string> = new Set<ReviewResult>([
  'not-started', 'in-progress', 'passed', 'failed', 'skipped', 'reopened',
]);
const ENVIRONMENTS: ReadonlySet<string> = new Set<ReviewEnvironment>([
  'planning', 'pre-production', 'production',
]);

/** Text that says something: not blank, and not a placeholder. */
export function filled(value: string | undefined): value is string {
  if (typeof value !== 'string') return false;
  const text = value.replace(/ /g, ' ').trim().toLowerCase();
  return text !== '' && text !== 'tbd' && text !== 'n/a';
}

/** Milliseconds since the epoch, or null for anything that is not a positive instant. */
export function instant(value: string | undefined): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * Why a run fails the review log's data checks, or null. `assessedAt` bounds
 * the review time: a review recorded after the assessment is not one the
 * assessment could have read.
 */
export function reviewRunProblem(
  run: ReviewRun,
  knownChecks: ReadonlySet<string>,
  assessedAt: string | undefined,
): string | null {
  const required: (keyof ReviewRun)[] = [
    'runId', 'checkId', 'releaseId', 'scopeRevision', 'criteriaRevision',
    'origin', 'tester', 'evidence', 'reviewedBy',
  ];
  for (const field of required) {
    if (!filled(run[field] as string | undefined)) return `missing ${field}`;
  }
  if (/[*?~]/.test(run.runId)) return 'run id holds a wildcard character';
  if (!knownChecks.has(run.checkId)) return `unknown check ${run.checkId}`;
  if (!ENVIRONMENTS.has(run.environment)) return `unknown environment ${String(run.environment)}`;
  if (!RESULTS.has(run.result)) return `unknown result ${String(run.result)}`;

  const tested = instant(run.testedAt);
  const reviewed = instant(run.reviewedAt);
  const assessed = instant(assessedAt);
  if (tested === null) return 'invalid tested time';
  if (reviewed === null || reviewed < tested) return 'review time missing or before the test';
  if (assessed === null || reviewed > assessed) return 'review time after the assessment';

  if (run.nextReviewAt !== undefined && run.nextReviewAt !== '') {
    const next = instant(run.nextReviewAt);
    if (next === null || next <= tested) return 'next review not after the test';
  }
  if (run.result === 'passed' && instant(run.nextReviewAt) === null && !filled(run.eventTrigger)) {
    return 'a passed run needs a next review time or an event trigger';
  }
  if (run.result === 'reopened' && !filled(run.eventTrigger)) {
    return 'a reopened run needs the event that reopened it';
  }
  return null;
}

/** Whether a run was taken in the release context being assessed. */
export function inCurrentContext(
  run: ReviewRun,
  check: Check,
  context: ReviewContext,
): boolean {
  return (
    filled(context.releaseId) && run.releaseId === context.releaseId &&
    filled(context.scopeRevision) && run.scopeRevision === context.scopeRevision &&
    filled(context.origin) && run.origin === context.origin &&
    run.criteriaRevision === context.criteriaRevision(check) &&
    environmentFits(evidenceClassOf(check), run.environment)
  );
}

export interface ReviewReading {
  readonly state: ReviewState;
  /** The current run, when exactly one exists. */
  readonly latest?: ReviewRun;
}

/**
 * The review state of one check.
 *
 * `runs` may hold every check's runs; only this check's are read. A run with a
 * data problem invalidates the check's history even when it is not the
 * latest, as in the workbook: a log that cannot be trusted in part cannot be
 * read for a result.
 */
export function readReview(
  check: Check,
  state: Pick<CheckState, 'status' | 'evidence' | 'evidenceRef'>,
  runs: readonly ReviewRun[],
  context: ReviewContext,
  knownChecks: ReadonlySet<string>,
): ReviewReading {
  const own = runs.filter((run) => run.checkId === check.id);
  const current = own.filter((run) => inCurrentContext(run, check, context));

  let newest = -Infinity;
  for (const run of current) newest = Math.max(newest, instant(run.testedAt) ?? -Infinity);
  const latest = current.filter((run) => instant(run.testedAt) === newest && newest > -Infinity);

  if (latest.length === 0) {
    return { state: state.status === 'passed' ? 'review-required' : 'not-reviewed' };
  }
  if (latest.length > 1) return { state: 'ambiguous' };

  const run = latest[0]!;
  const ids = new Map<string, number>();
  for (const any of runs) ids.set(any.runId, (ids.get(any.runId) ?? 0) + 1);
  const broken = own.some(
    (any) =>
      (ids.get(any.runId) ?? 0) > 1 ||
      reviewRunProblem(any, knownChecks, context.assessedAt) !== null,
  );
  if (broken) return { state: 'invalid', latest: run };
  if (run.result === 'reopened') return { state: 'reopened', latest: run };
  if (run.result === 'failed') return { state: 'failed', latest: run };

  const next = instant(run.nextReviewAt);
  const assessed = instant(context.assessedAt);
  if (next !== null && assessed !== null && next < assessed) {
    return { state: 'overdue', latest: run };
  }
  if (state.status !== run.result || !citesEvidence(run, state)) {
    return { state: 'reconcile', latest: run };
  }
  return { state: run.result === 'passed' ? 'current' : 'unfinished', latest: run };
}
