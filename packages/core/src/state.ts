import type { Applicability, CheckStatus, Coverage } from './check.js';

/**
 * Per-site mutable state for one check. The corpus is immutable; this is
 * where a given site's resolution of that check lives.
 */
export interface CheckState {
  readonly checkId: string;
  /**
   * Resolved scope. Starts as the corpus default; a `review` value means the
   * human decision is still outstanding and will hold a launch decision.
   */
  readonly applicability: Applicability;
  /** Rationale is required when applicability is narrowed to `no`. */
  readonly applicabilityRationale?: string;
  readonly status: CheckStatus;
  readonly coverage: Coverage;
  /**
   * Reproducible proof of "Done when" — crawl export id, snapshot id, ticket,
   * approval or monitoring result. Another reviewer must be able to re-derive it.
   */
  readonly evidence?: string;
  /** When an attestation lapses and coverage reverts to `unknown`. */
  readonly attestationExpiresAt?: string;
}
