/**
 * The v5.0 workbook's second assessment: READY FOR CUTOVER, and the final
 * GO that follows it.
 *
 * `computeLaunchReadiness` answers the first question the workbook asks — are
 * the applicable gates passed and every conditional gate decided. v5.0 adds a
 * release around that answer. Gates are passed *for* a named release, scope
 * revision and origin, each with a current review in the right environment;
 * cutover readiness needs that of every planning and preflight gate, and the
 * final GO needs it of the live gates too, tested after an actual cutover that
 * a named person authorized against a READY FOR CUTOVER result.
 *
 * Neither result is a human decision. The owner records one in 5.7, and a GO
 * recorded there while the calculation says HOLD is a conflict to reconcile,
 * never an override.
 *
 * Mirrors the Progress sheet's B15 and B21:B28 and the Release review sheet of
 * SEO-Launch-Checklist-v5.0.xlsx.
 */

import type { Check, Corpus } from './check.js';
import type { CheckState } from './state.js';
import { computeLaunchReadiness, effectiveState, stateOf } from './readiness.js';
import type { LaunchReadiness } from './readiness.js';
import {
  evidenceClassOf,
  filled,
  instant,
  readReview,
  reviewRunProblem,
} from './review.js';
import type { EvidenceClass, ReviewContext, ReviewRun, ReviewState } from './review.js';

/**
 * The release being assessed. Every field is optional because an unfilled
 * record is a normal state — each blank is counted as a scope or cutover
 * error, exactly as a blank cell is in the workbook.
 */
export interface ReleaseRecord {
  readonly releaseId?: string;
  readonly scopeRevision?: string;
  /** `https://host`, with no path. */
  readonly origin?: string;
  readonly scopeApprover?: string;
  readonly scopeApprovedAt?: string;
  readonly scopeApprovalEvidence?: string;
  readonly decisionOwner?: string;
  /** When the assessment is taken. Freshness is judged here and nowhere else. */
  readonly assessedAt?: string;
  /**
   * Criterion revision per check id. A gate missing here is tested against
   * the corpus version itself.
   */
  readonly criteria?: Readonly<Record<string, string>>;
  readonly cutover?: CutoverAuthorization;
  /** The launch owner's 5.7 record, if one has been made. */
  readonly launchDecision?: LaunchDecision;
  /** Every review run logged for this site, any release. */
  readonly reviews?: readonly ReviewRun[];
}

export interface CutoverAuthorization {
  readonly authorizer?: string;
  readonly authorizedAt?: string;
  readonly decisionReference?: string;
  /** When cutover actually happened. Live tests must come after it. */
  readonly cutoverAt?: string;
  /** What the authorizer was shown, copied at the moment of authorizing. */
  readonly binding?: {
    readonly releaseId?: string;
    readonly scopeRevision?: string;
    readonly origin?: string;
    readonly assessment?: string;
  };
}

export interface LaunchDecision {
  readonly decision: 'GO' | 'HOLD' | 'rollback';
  readonly decidedBy: string;
  readonly decidedAt: string;
}

export const READY_FOR_CUTOVER = 'READY FOR CUTOVER';

/** Why one applicable gate does not yet count toward its stage. */
export interface GateBlocker {
  readonly checkId: string;
  readonly evidenceClass: EvidenceClass;
  readonly outstanding: boolean;
  readonly reviewState: ReviewState;
  /** Empty when the gate's evidence is complete. */
  readonly evidenceProblem: string;
}

export interface CutoverReadiness {
  readonly cutover: typeof READY_FOR_CUTOVER | 'HOLD';
  readonly final: 'GO' | 'HOLD';
  /** Review runs that fail the log's data checks. */
  readonly inputErrors: number;
  readonly preCutoverGatesOutstanding: number;
  readonly liveGatesOutstanding: number;
  readonly preCutoverEvidenceIncomplete: number;
  readonly liveEvidenceIncomplete: number;
  readonly cutoverRecordValid: boolean;
  /** Blank or invalid release fields, plus gates excluded without a reason. */
  readonly scopeErrors: number;
  /** Which release fields are missing, by name. */
  readonly scopeProblems: readonly string[];
  /** The first assessment, taken at the same moment. */
  readonly launch: LaunchReadiness;
  /** Applicable gates with anything outstanding, in corpus order. */
  readonly blockers: readonly GateBlocker[];
  /**
   * The 5.7 record set against the calculation. `conflict` is a recorded GO
   * while the final assessment is HOLD: reconcile it, never act on it.
   */
  readonly launchDecision: 'none' | 'agrees' | 'conflict' | 'recorded';
}

/** `https://host[:port]`, nothing after it. */
function isOrigin(value: string | undefined): boolean {
  return filled(value) && /^https:\/\/[^\s/]+$/.test(value);
}

function releaseProblems(release: ReleaseRecord): string[] {
  const assessed = instant(release.assessedAt);
  const approved = instant(release.scopeApprovedAt);
  const problems: string[] = [];
  if (!filled(release.releaseId)) problems.push('release id');
  if (!filled(release.scopeRevision)) problems.push('scope revision');
  if (!isOrigin(release.origin)) problems.push('target production origin');
  if (!filled(release.scopeApprover)) problems.push('scope approver');
  if (approved === null || assessed === null || approved > assessed) {
    problems.push('scope approval time');
  }
  if (!filled(release.scopeApprovalEvidence)) problems.push('scope approval evidence');
  if (!filled(release.decisionOwner)) problems.push('decision owner');
  if (assessed === null) problems.push('assessment time');
  return problems;
}

function cutoverRecordValid(release: ReleaseRecord): boolean {
  const cutover = release.cutover;
  if (cutover === undefined) return false;
  const assessed = instant(release.assessedAt);
  const approved = instant(release.scopeApprovedAt);
  const authorized = instant(cutover.authorizedAt);
  const actual = instant(cutover.cutoverAt);
  if (assessed === null || approved === null || authorized === null || actual === null) {
    return false;
  }
  return (
    filled(cutover.authorizer) &&
    filled(cutover.decisionReference) &&
    approved <= authorized && authorized <= actual && actual <= assessed &&
    cutover.binding?.releaseId === release.releaseId &&
    cutover.binding?.scopeRevision === release.scopeRevision &&
    cutover.binding?.origin === release.origin &&
    cutover.binding?.assessment === READY_FOR_CUTOVER
  );
}

/**
 * Both v5.0 assessments for one release.
 *
 * Called with no release at all, it reports what the workbook reports for an
 * empty template: every release field missing, every applicable gate
 * outstanding and unevidenced, HOLD on both.
 */
export function computeCutoverReadiness(
  corpus: Corpus,
  states: ReadonlyMap<string, CheckState>,
  release: ReleaseRecord = {},
): CutoverReadiness {
  const { checks } = corpus;
  const assessedAt = release.assessedAt;
  const launch = computeLaunchReadiness(checks, states, { assessedAt });
  const known = new Set(checks.map((check) => check.id));
  const runs = release.reviews ?? [];

  const runIds = new Map<string, number>();
  for (const run of runs) runIds.set(run.runId, (runIds.get(run.runId) ?? 0) + 1);
  const inputErrors = runs.filter(
    (run) =>
      (runIds.get(run.runId) ?? 0) > 1 ||
      reviewRunProblem(run, known, assessedAt) !== null,
  ).length;

  const context: ReviewContext = {
    releaseId: release.releaseId,
    scopeRevision: release.scopeRevision,
    origin: release.origin,
    assessedAt,
    criteriaRevision: (check: Check) => release.criteria?.[check.id] ?? corpus.version,
  };
  const cutoverAt = instant(release.cutover?.cutoverAt);

  const scopeProblems = releaseProblems(release);
  let scopeErrors = scopeProblems.length;
  let preOutstanding = 0, liveOutstanding = 0;
  let preIncomplete = 0, liveIncomplete = 0;
  const blockers: GateBlocker[] = [];

  for (const check of checks) {
    if (!check.launchGate) continue;
    const state = effectiveState(stateOf(states, check), assessedAt);
    if (state.applicability === 'no') {
      if (!filled(state.applicabilityRationale)) scopeErrors += 1;
      continue;
    }
    if (state.applicability !== 'yes') continue;

    const evidenceClass = evidenceClassOf(check);
    const live = evidenceClass === 'live';
    const outstanding = state.status !== 'passed';
    const reading = readReview(check, state, runs, context, known);

    let evidenceProblem = '';
    if (reading.state !== 'current') {
      evidenceProblem = `current review required: ${reading.state}`;
    } else if (live && (cutoverAt === null || (instant(reading.latest?.testedAt) ?? 0) < cutoverAt)) {
      evidenceProblem = 'live test predates or lacks actual cutover';
    }

    if (outstanding) {
      if (live) liveOutstanding += 1;
      else preOutstanding += 1;
    }
    if (evidenceProblem !== '') {
      if (live) liveIncomplete += 1;
      else preIncomplete += 1;
    }
    if (outstanding || evidenceProblem !== '') {
      blockers.push({
        checkId: check.id,
        evidenceClass,
        outstanding,
        reviewState: reading.state,
        evidenceProblem,
      });
    }
  }

  const unresolved = launch.applicabilityDecisionsOutstanding;
  const cutover =
    inputErrors === 0 && scopeErrors === 0 && unresolved === 0 &&
    preOutstanding === 0 && preIncomplete === 0
      ? READY_FOR_CUTOVER
      : 'HOLD';
  const recordValid = cutoverRecordValid(release);
  const final =
    cutover === READY_FOR_CUTOVER &&
    launch.gatesOutstanding === 0 &&
    liveIncomplete === 0 &&
    recordValid
      ? 'GO'
      : 'HOLD';

  const decision = release.launchDecision;
  const launchDecision =
    decision === undefined ? 'none'
    : decision.decision !== 'GO' ? 'recorded'
    : final === 'GO' ? 'agrees'
    : 'conflict';

  return {
    cutover,
    final,
    inputErrors,
    preCutoverGatesOutstanding: preOutstanding,
    liveGatesOutstanding: liveOutstanding,
    preCutoverEvidenceIncomplete: preIncomplete,
    liveEvidenceIncomplete: liveIncomplete,
    cutoverRecordValid: recordValid,
    scopeErrors,
    scopeProblems,
    launch,
    blockers,
    launchDecision,
  };
}
