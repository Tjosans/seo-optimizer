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
  readonly violations: readonly IntegrityViolation[];
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

const stateOf = (
  states: ReadonlyMap<string, CheckState>,
  check: Check,
): CheckState => states.get(check.id) ?? {
  checkId: check.id,
  applicability: check.applicability.universal ? 'yes' : 'review',
  status: 'not-started',
  coverage: 'unknown',
};

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
): LaunchReadiness {
  let gatesOutstanding = 0;
  let gatesFailed = 0;
  let applicabilityDecisionsOutstanding = 0;
  const violations: IntegrityViolation[] = [];

  for (const check of checks) {
    const state = stateOf(states, check);

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
    violations,
  };
}

/** Per-phase progress. Only in-scope (`yes`) checks count toward completion. */
export function computeProgress(
  checks: readonly Check[],
  states: ReadonlyMap<string, CheckState>,
): PhaseProgress[] {
  const phases = [...new Set(checks.map((c) => c.phase))].sort((a, b) => a - b);

  return phases.map((phase) => {
    const inPhase = checks.filter((c) => c.phase === phase);
    let active = 0, notStarted = 0, inProgress = 0;
    let passed = 0, failed = 0, skipped = 0, scopeReview = 0;

    for (const check of inPhase) {
      const state = stateOf(states, check);
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
