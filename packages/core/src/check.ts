/**
 * Corpus vocabulary.
 *
 * These types encode the semantics defined by the source methodology's
 * "How to use" sheet (v4.4, reviewed 2026-08-27). The three gating axes are
 * deliberately independent and must never be collapsed into one another:
 *
 *   Priority     — impact ranking. Explicitly does NOT decide launch blocking.
 *   Applicability— whether the check is in scope for this site.
 *   LaunchGate   — whether the check blocks launch when it is in scope.
 *
 * Profile (core/extended) is advisory scoping only. It never overrides
 * LaunchGate and must never be used to filter a launch decision.
 */

/** Impact ranking. P0 = critical, P1 = important, P2 = later/optional. */
export type Priority = 'P0' | 'P1' | 'P2';

/**
 * Advisory effort scoping. `core` is work a small team commonly still runs;
 * `extended` is depth for a team, agency, specialist or regulated context.
 * Never a severity multiplier and never a launch filter.
 */
export type Profile = 'core' | 'extended';

/**
 * Scope state. `review` is an UNRESOLVED decision, not a synonym for
 * "conditional" — a human must decide whether the condition matches. An
 * unresolved `review` on a launch-gate check holds the launch decision.
 */
export type Applicability = 'yes' | 'no' | 'review';

/**
 * Work state. An applicable launch gate can never be cleared with `skipped`;
 * the scope must instead be set to `no` with a recorded rationale.
 */
export type CheckStatus =
  | 'not-started'
  | 'in-progress'
  | 'passed'
  | 'failed'
  | 'skipped';

/** How far the engine can verify a check without a human. */
export type AutomationTier =
  /** Machine-verifiable end to end. */
  | 'automated'
  /** Engine gathers evidence and proposes; a human confirms. */
  | 'assisted'
  /** Governance no crawler can verify; human attestation only. */
  | 'attested';

/**
 * What a failing check would take to fix. Drives the rebuild-vs-adjust
 * verdict: only `structural` and `platform` debt is unreachable without
 * changing the site's architecture.
 */
export type RemediationClass =
  | 'config'
  | 'content'
  | 'code'
  | 'structural'
  | 'platform';

/** Provenance of a check's current result. Printed in every customer report. */
export type Coverage =
  | 'verified'
  | 'attested'
  | 'unknown'
  | 'not-applicable';

/** Normalized responsible roles, parsed from the free-text Owner column. */
export type Role =
  | 'developer' | 'seo' | 'content' | 'business' | 'designer'
  | 'legal' | 'privacy' | 'accessibility' | 'analytics' | 'localization'
  | 'operations' | 'security' | 'merchandising' | 'product'
  | 'trust-safety' | 'marketing' | 'subject-expert' | 'audience'
  | 'infrastructure';

/** Site lifecycle phase, 0-7, as defined by the corpus. */
export type LifecyclePhase = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** A predicate over a SiteProfile, compiled from the "Applies to" column. */
export interface ApplicabilityRule {
  /** Check is universal when true; `any` is then ignored. */
  readonly universal: boolean;
  /** Site must match at least one of these flags for the check to be in scope. */
  readonly any: readonly string[];
  /** Verbatim source text, retained for audit and report display. */
  readonly source: string;
}

/** Structured re-check schedule, parsed from the "Review cadence" column. */
export interface Cadence {
  readonly triggers: readonly string[];
  readonly interval?: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';
  /** Elevated cadence window after launch, in days (e.g. "weekly for 30 days"). */
  readonly windowDays?: number;
  readonly source: string;
}

/** A citation from the corpus Sources sheet. */
export interface SourceRef {
  readonly topic: string;
  readonly url: string;
  readonly usedFor: string;
  /** ISO date the source was last verified against live documentation. */
  readonly verified: string;
}

/** One compiled check. The atomic unit of scoring, backlog and reporting. */
export interface Check {
  /** Stable dotted id, e.g. "1.3". Survives corpus version bumps. */
  readonly id: string;
  readonly phase: LifecyclePhase;
  readonly phaseLabel: string;
  readonly priority: Priority;
  readonly profile: Profile;
  readonly launchGate: boolean;
  readonly applicability: ApplicabilityRule;
  readonly task: string;
  /** The requirement ("What to do"). */
  readonly whatToDo: string;
  /** The testable assertion ("Done when"). This is the detector spec. */
  readonly doneWhen: string;
  readonly owners: readonly Role[];
  readonly ownerSource: string;
  readonly tools: string;
  readonly cadence: Cadence;
  readonly notes: string;
  readonly automation: AutomationTier;
  readonly remediationClass: RemediationClass;
  /** Detector ids that evidence this check. Empty iff automation is 'attested'. */
  readonly detectors: readonly string[];
  readonly sources: readonly SourceRef[];
}

/** A versioned, immutable corpus. Snapshots pin `version`. */
export interface Corpus {
  readonly version: string;
  /** ISO date the methodology itself was last reviewed. */
  readonly reviewed: string;
  readonly checks: readonly Check[];
}
