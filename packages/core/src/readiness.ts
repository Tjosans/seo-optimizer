import type { Check, CheckState, LifecyclePhase } from './index.js';

/**
 * An integrity violation in how a check's state was recorded. These are
 * defects in the audit itself, not findings about the site, and they must be
 * surfaced rather than silently absorbed into a score.
 */
export interface IntegrityViolation {
  readonly checkId: string;
  readonly kind: 'skipped-applicable-gate' | 'excluded-without-rationale';
  readonly message: string;
}

export interface LaunchReadiness {
  readonly decision: 'GO' | 'HOLD';
  /** Applicable launch gates not yet passed. */
  readonly gatesOutstanding: number;
  /** Applicable launch gates explicitly failed. */
  readonly gatesFailed: number;
  /** Launch gates whose applicability is still unresolved (`review`). */
  readonly applicabilityDecisionsOutstanding: number;
  /**
   * Passed gates whose attestation had lapsed at the assessment time. Already
   * counted in `gatesOutstanding`; reported apart so a report can say why.
   */
  readonly attestationsLapsed: number;
  readonly violations: readonly IntegrityViolation[];
}

export interface AssessmentOptions {
  /**
   * The moment the assessment is taken at, ISO. An attested pass whose
   * `attestationExpiresAt` is not after it no longer counts. Omitted, no
   * attestation lapses — the wall clock is never read implicitly, so the same
   * states always assess the same way.
   */
  readonly assessedAt?: string | undefined;
}

export interface PhaseProgress {
  readonly phase: LifecyclePhase;
  readonly active: number;
  readonly notStarted: number;
  readonly inProgress: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly percentComplete: number;
  readonly scopeReview: number;
}

export const stateOf = (
  states: ReadonlyMap<string, CheckState>,
  check: Check,
): CheckState => states.get(check.id) ?? {
  checkId: check.id,
  applicability: check.applicability.universal ? 'yes' : 'review',
  status: 'not-started',
  coverage: 'unknown',
};

/** Whether an attested state's attestation had run out by `assessedAt`. */
export function attestationLapsed(state: CheckState, assessedAt: string | undefined): boolean {
  if (assessedAt === undefined || state.coverage !== 'attested') return false;
  const at = Date.parse(assessedAt);
  if (!Number.isFinite(at)) return false;
  // An attestation with no expiry cannot be relied on; the schema refuses one.
  if (state.attestationExpiresAt === undefined) return true;
  const expires = Date.parse(state.attestationExpiresAt);
  return !Number.isFinite(expires) || expires <= at;
}

/**
 * The state as an assessment at `assessedAt` reads it. A lapsed attestation
 * stays on the record, and its check goes back to needing one: in progress,
 * with coverage `unknown`.
 */
export function effectiveState(state: CheckState, assessedAt: string | undefined): CheckState {
  if (!attestationLapsed(state, assessedAt)) return state;
  return {
    ...state,
    status: state.status === 'passed' ? 'in-progress' : state.status,
    coverage: 'unknown',
  };
}

/**
 * Launch decision, per the methodology's stated rule: GO requires every
 * applicable launch gate to be passed, zero failed gates, and zero unresolved
 * applicability decisions on conditional launch gates.
 *
 * Note that `skipped` never clears an applicable gate. The methodology
 * requires narrowing scope to `no` with a rationale instead, so a skipped
 * applicable gate is reported as an integrity violation and still counts as
 * outstanding.
 */
export function computeLaunchReadiness(
  checks: readonly Check[],
  states: ReadonlyMap<string, CheckState>,
  options: AssessmentOptions = {},
): LaunchReadiness {
  let gatesOutstanding = 0;
  let gatesFailed = 0;
  let applicabilityDecisionsOutstanding = 0;
  let attestationsLapsed = 0;
  const violations: IntegrityViolation[] = [];

  for (const check of checks) {
    const recorded = stateOf(states, check);
    const state = effectiveState(recorded, options.assessedAt);

    if (state.applicability === 'no' && !state.applicabilityRationale) {
      violations.push({
        checkId: check.id,
        kind: 'excluded-without-rationale',
        message: `Check ${check.id} was excluded from scope without a recorded rationale.`,
      });
    }

    if (!check.launchGate) continue;

    if (state.applicability === 'review') {
      applicabilityDecisionsOutstanding += 1;
      continue;
    }
    if (state.applicability === 'no') continue;

    if (state.status === 'failed') gatesFailed += 1;
    if (state.status === 'skipped') {
      violations.push({
        checkId: check.id,
        kind: 'skipped-applicable-gate',
        message:
          `Check ${check.id} is an applicable launch gate and cannot be cleared ` +
          `with "skipped". Set applicability to "no" with a rationale instead.`,
      });
    }
    if (state.status !== 'passed') gatesOutstanding += 1;
    if (recorded.status === 'passed' && state.status !== 'passed') attestationsLapsed += 1;
  }

  const decision =
    gatesOutstanding === 0 &&
    gatesFailed === 0 &&
    applicabilityDecisionsOutstanding === 0
      ? 'GO'
      : 'HOLD';

  return {
    decision,
    gatesOutstanding,
    gatesFailed,
    applicabilityDecisionsOutstanding,
    attestationsLapsed,
    violations,
  };
}

/** Per-phase progress. Only in-scope (`yes`) checks count toward completion. */
export function computeProgress(
  checks: readonly Check[],
  states: ReadonlyMap<string, CheckState>,
  options: AssessmentOptions = {},
): PhaseProgress[] {
  const phases = [...new Set(checks.map((c) => c.phase))].sort((a, b) => a - b);

  return phases.map((phase) => {
    const inPhase = checks.filter((c) => c.phase === phase);
    let active = 0, notStarted = 0, inProgress = 0;
    let passed = 0, failed = 0, skipped = 0, scopeReview = 0;

    for (const check of inPhase) {
      const state = effectiveState(stateOf(states, check), options.assessedAt);
      if (state.applicability === 'review') scopeReview += 1;
      if (state.applicability !== 'yes') continue;
      active += 1;
      switch (state.status) {
        case 'not-started': notStarted += 1; break;
        case 'in-progress': inProgress += 1; break;
        case 'passed': passed += 1; break;
        case 'failed': failed += 1; break;
        case 'skipped': skipped += 1; break;
      }
    }

    return {
      phase, active, notStarted, inProgress, passed, failed, skipped,
      percentComplete: active === 0 ? 0 : Math.round((passed / active) * 100),
      scopeReview,
    };
  });
}
