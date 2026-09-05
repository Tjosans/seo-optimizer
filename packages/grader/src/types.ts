/**
 * Grading vocabulary.
 *
 * A probe observes and a grader judges, and the two must stay separable: an
 * observation is a fact about a page that can be re-made, while a verdict is a
 * reading of the methodology that a person may overrule. Everything here is the
 * second kind, and every value carries the basis it was reached on, so a report
 * can always answer "why does this check say that".
 */

import type {
  Applicability,
  CheckState,
  CheckStatus,
  Coverage,
  LaunchReadiness,
  PhaseProgress,
} from '@seo/core';
import type { ProbeRun } from '@seo/probes';

/**
 * One observation, with the `probe_results` row it was written to.
 *
 * `resultId` is null for an observation held only in memory — grading works
 * without a database, it just cannot leave an evidence trail behind.
 */
export interface Evidence {
  readonly run: ProbeRun;
  readonly resultId: string | null;
}

/**
 * Why a check ended up where it did. Ordered from "nothing was in scope" to
 * "the machine reached a verdict", and every value maps to exactly one row of
 * the grading table in `grade.ts`.
 */
export type GradeBasis =
  /** The site profile puts the check out of scope. */
  | 'out-of-scope'
  /** Conditional check, and the site profile declares nothing either way. */
  | 'scope-undecided'
  /** Governance no crawler can verify; a human must attest it. */
  | 'attested-only'
  /** The corpus asks for detectors this engine has not implemented. */
  | 'detectors-missing'
  /** A detector ran and could not observe. An error is never a site defect. */
  | 'probe-error'
  /** A detector is implemented but produced no observation on this crawl. */
  | 'no-observation'
  /** At least one observation failed. */
  | 'verified-fail'
  /** Every observation passed, and the corpus allows a machine to say so. */
  | 'verified-pass'
  /** Nothing on this site was in the check's subject. */
  | 'nothing-to-verify'
  /** Something short of a defect was seen; a machine will not clear it. */
  | 'held-by-warning'
  /** Evidence gathered and proposed; the corpus requires a human to confirm. */
  | 'awaiting-confirmation';

export interface ObservationCounts {
  readonly pass: number;
  readonly fail: number;
  readonly warn: number;
  readonly notApplicable: number;
  readonly error: number;
}

/** One check's verdict, with the trail that produced it. */
export interface GradedCheck {
  readonly checkId: string;
  readonly applicability: Applicability;
  /** Required by the schema whenever applicability is `no`. */
  readonly applicabilityRationale: string | null;
  readonly status: CheckStatus;
  readonly coverage: Coverage;
  readonly basis: GradeBasis;
  /** One report-ready line. Stored on `check_states.evidence`. */
  readonly summary: string;
  /** `probe_results` ids this verdict was read from; empty when none was. */
  readonly evidenceIds: readonly string[];
  readonly counts: ObservationCounts;
}

/** Readiness as frozen onto `audits.readiness`. */
export interface FrozenReadiness {
  /** The corpus the verdicts were reached against. */
  readonly corpusVersion: string;
  readonly gradedAt: string;
  readonly readiness: LaunchReadiness;
  readonly progress: readonly PhaseProgress[];
}

export interface GradeResult extends FrozenReadiness {
  readonly checks: readonly GradedCheck[];
}

/** The corpus version graded does not match the one the audit pinned. */
export class CorpusVersionMismatchError extends Error {
  constructor(readonly expected: string, readonly actual: string) {
    super(
      `this audit is pinned to corpus ${expected} but was handed corpus ${actual}; ` +
        'grading it would produce a report that cannot be re-explained',
    );
    this.name = 'CorpusVersionMismatchError';
  }
}

/** A graded check as @seo/core's scoring functions want it. */
export function toCheckState(graded: GradedCheck): CheckState {
  return {
    checkId: graded.checkId,
    applicability: graded.applicability,
    ...(graded.applicabilityRationale === null
      ? {}
      : { applicabilityRationale: graded.applicabilityRationale }),
    status: graded.status,
    coverage: graded.coverage,
    ...(graded.summary === '' ? {} : { evidence: graded.summary }),
  };
}
