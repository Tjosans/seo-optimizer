/**
 * The grader: evidence in, verdicts out.
 *
 * Everything up to this point in the pipeline is observation. This is the step
 * that reads the corpus's "Done when" against what the probes saw and writes
 * down an answer, which is a different kind of claim and is why it lives in its
 * own package.
 *
 * One rule decides most of the table below: a machine may FAIL a check, but
 * only an `automated` check may be PASSED by one. A failure is a defect a probe
 * directly observed, and there is no reading of the methodology under which
 * observing it makes the launch safer. A pass is a clearance, and the corpus
 * says exactly which checks are machine-verifiable end to end — `assisted`
 * means the engine proposes and a person confirms, so the engine filing its own
 * confirmation would empty the word of meaning.
 *
 * The other rule is that missing evidence is never good news. A detector the
 * engine has not implemented, one that errored, and one that observed nothing
 * all leave the check ungraded at `not-started` with `unknown` coverage — never
 * passed, and never failed either, because "we did not look" is not a finding
 * about the site. Ninety-five of the corpus's 128 detectors are unimplemented
 * today, so this is the common case rather than the corner one, and a report
 * that hid it would be claiming coverage the engine does not have.
 */

import { computeLaunchReadiness, computeProgress } from '@seo/core';
import type { Check, CheckState, Corpus } from '@seo/core';
import { PROBES } from '@seo/probes';
import type { ProbeRun } from '@seo/probes';
import type {
  Evidence,
  FrozenReadiness,
  GradeResult,
  GradedCheck,
  ObservationCounts,
} from './types.js';
import { toCheckState } from './types.js';
import { resolveScope } from './scope.js';

export interface GradeInput {
  readonly corpus: Corpus;
  /** Site-profile flags from the `sites` row. Resolves conditional scope. */
  readonly flags: readonly string[];
  /** Every observation made for this audit, persisted or not. */
  readonly evidence: readonly Evidence[];
  /**
   * Detector ids the engine can actually run. Defaults to the probe registry;
   * passed explicitly only by tests, which need to grade against a stated
   * capability rather than whatever happens to be registered today.
   */
  readonly implementedDetectors?: ReadonlySet<string>;
  readonly gradedAt?: Date;
}

const NO_COUNTS: ObservationCounts = {
  pass: 0,
  fail: 0,
  warn: 0,
  notApplicable: 0,
  error: 0,
};

/** Grade every check in the corpus. Pure: no database, no clock beyond `gradedAt`. */
export function gradeAudit(input: GradeInput): GradeResult {
  const implemented =
    input.implementedDetectors ?? new Set(PROBES.map((probe) => probe.id));

  const byDetector = new Map<string, Evidence[]>();
  for (const item of input.evidence) {
    const found = byDetector.get(item.run.probeId);
    if (found === undefined) byDetector.set(item.run.probeId, [item]);
    else found.push(item);
  }

  const checks = input.corpus.checks.map((check) =>
    gradeCheck(check, input.flags, byDetector, implemented),
  );

  return {
    corpusVersion: input.corpus.version,
    gradedAt: (input.gradedAt ?? new Date()).toISOString(),
    checks,
    ...readinessOf(
      input.corpus,
      new Map(checks.map((graded) => [graded.checkId, toCheckState(graded)])),
    ),
  };
}

/**
 * Launch readiness and per-phase progress for a set of states.
 *
 * Shared by grading, which reads its own verdicts, and by recording, which
 * reads those verdicts merged with whatever a person has already signed off.
 */
export function readinessOf(
  corpus: Corpus,
  states: ReadonlyMap<string, CheckState>,
): Pick<FrozenReadiness, 'readiness' | 'progress'> {
  return {
    readiness: computeLaunchReadiness(corpus.checks, states),
    progress: computeProgress(corpus.checks, states),
  };
}

function gradeCheck(
  check: Check,
  flags: readonly string[],
  byDetector: ReadonlyMap<string, readonly Evidence[]>,
  implemented: ReadonlySet<string>,
): GradedCheck {
  const scope = resolveScope(check, flags);

  if (scope.applicability === 'no') {
    return ungraded(check, 'no', scope.rationale, 'out-of-scope', {
      coverage: 'not-applicable',
      summary: `out of scope: ${scope.rationale ?? ''}`,
    });
  }
  if (scope.applicability === 'review') {
    return ungraded(check, 'review', null, 'scope-undecided', {
      summary:
        'scope undecided: the check applies to sites flagged ' +
        `${check.applicability.any.join(', ')}, and this site's profile is empty`,
    });
  }

  if (check.automation === 'attested') {
    return ungraded(check, 'yes', null, 'attested-only', {
      summary: 'no machine can verify this check; it needs a human attestation',
    });
  }

  const missing = check.detectors.filter((detector) => !implemented.has(detector));
  if (missing.length > 0) {
    // Partial detector coverage is not partial verification: the corpus binds
    // the check's "Done when" to the whole set it declares.
    return ungraded(check, 'yes', null, 'detectors-missing', {
      summary:
        `not graded: ${missing.length} of ${check.detectors.length} detectors are ` +
        `not implemented (${missing.join(', ')})`,
    });
  }

  const observations = check.detectors.flatMap(
    (detector) => byDetector.get(detector) ?? [],
  );
  const evidenceIds = observations
    .map((item) => item.resultId)
    .filter((id): id is string => id !== null);
  const counts = countOf(observations);

  const silent = check.detectors.filter(
    (detector) => (byDetector.get(detector) ?? []).length === 0,
  );
  if (silent.length > 0) {
    return ungraded(check, 'yes', null, 'no-observation', {
      summary: `not graded: no observation from ${silent.join(', ')} on this crawl`,
      evidenceIds,
      counts,
    });
  }

  // A probe that could not run is a hole in the evidence, not a finding. It is
  // reported as such so the hole stays visible instead of being absorbed into
  // a verdict about the site.
  if (counts.error > 0) {
    return ungraded(check, 'yes', null, 'probe-error', {
      summary:
        `not graded: ${counts.error} of ${observations.length} observations could ` +
        'not be made because a probe failed to run',
      evidenceIds,
      counts,
    });
  }

  const total = observations.length;

  if (counts.fail > 0) {
    return {
      checkId: check.id,
      applicability: 'yes',
      applicabilityRationale: null,
      status: 'failed',
      coverage: 'verified',
      basis: 'verified-fail',
      summary:
        `failed: ${counts.fail} of ${total} observations failed ` +
        `(${failingDetectors(observations).join(', ')})`,
      evidenceIds,
      counts,
    };
  }

  if (check.automation === 'assisted') {
    return {
      checkId: check.id,
      applicability: 'yes',
      applicabilityRationale: null,
      // The engine has done its half. Until a person does theirs the check is
      // under way rather than done, and nobody has verified its coverage.
      status: 'in-progress',
      coverage: 'unknown',
      basis: 'awaiting-confirmation',
      summary:
        `proposed: ${total} observations, none failed; this check needs a human ` +
        'to confirm',
      evidenceIds,
      counts,
    };
  }

  if (counts.warn > 0) {
    return {
      checkId: check.id,
      applicability: 'yes',
      applicabilityRationale: null,
      status: 'in-progress',
      coverage: 'unknown',
      basis: 'held-by-warning',
      summary:
        `held: ${counts.warn} of ${total} observations warned — short of a defect, ` +
        'but not something a machine will clear',
      evidenceIds,
      counts,
    };
  }

  if (counts.pass === 0) {
    // Every observation said the subject was not there: no images to have alt
    // text, no facets to have rules. The check cannot fail, so it does not hold
    // the launch, and `not-applicable` coverage is what keeps the report honest
    // about the difference between "verified" and "nothing to verify".
    return {
      checkId: check.id,
      applicability: 'yes',
      applicabilityRationale: null,
      status: 'passed',
      coverage: 'not-applicable',
      basis: 'nothing-to-verify',
      summary: `nothing to verify: all ${total} observations found no subject here`,
      evidenceIds,
      counts,
    };
  }

  return {
    checkId: check.id,
    applicability: 'yes',
    applicabilityRationale: null,
    status: 'passed',
    coverage: 'verified',
    basis: 'verified-pass',
    summary:
      `verified: ${counts.pass} of ${total} observations passed` +
      (counts.notApplicable > 0 ? `, ${counts.notApplicable} found no subject` : ''),
    evidenceIds,
    counts,
  };
}

/** A check nothing graded. Never passed, and never failed either. */
function ungraded(
  check: Check,
  applicability: GradedCheck['applicability'],
  rationale: string | null,
  basis: GradedCheck['basis'],
  rest: {
    readonly summary: string;
    readonly coverage?: GradedCheck['coverage'];
    readonly evidenceIds?: readonly string[];
    readonly counts?: ObservationCounts;
  },
): GradedCheck {
  return {
    checkId: check.id,
    applicability,
    applicabilityRationale: rationale,
    status: 'not-started',
    coverage: rest.coverage ?? 'unknown',
    basis,
    summary: rest.summary,
    evidenceIds: rest.evidenceIds ?? [],
    counts: rest.counts ?? NO_COUNTS,
  };
}

function countOf(observations: readonly Evidence[]): ObservationCounts {
  let pass = 0;
  let fail = 0;
  let warn = 0;
  let notApplicable = 0;
  let error = 0;
  for (const item of observations) {
    switch (item.run.observation.outcome) {
      case 'pass': pass += 1; break;
      case 'fail': fail += 1; break;
      case 'warn': warn += 1; break;
      case 'not-applicable': notApplicable += 1; break;
      case 'error': error += 1; break;
    }
  }
  return { pass, fail, warn, notApplicable, error };
}

function failingDetectors(observations: readonly Evidence[]): string[] {
  return [
    ...new Set(
      observations
        .filter((item) => item.run.observation.outcome === 'fail')
        .map((item) => item.run.probeId),
    ),
  ].sort();
}

/**
 * Pair probe runs with the rows they were written to.
 *
 * `persistProbeRuns` returns ids in the order it was handed runs, and that
 * order is the only thing tying an observation to its row, so the pairing is
 * done here once rather than left to every caller to get right.
 */
export function toEvidence(
  runs: readonly ProbeRun[],
  resultIds: readonly string[],
): Evidence[] {
  if (runs.length !== resultIds.length) {
    throw new Error(
      `cannot pair ${runs.length} probe runs with ${resultIds.length} row ids`,
    );
  }
  return runs.map((run, index) => ({ run, resultId: resultIds[index] ?? null }));
}
