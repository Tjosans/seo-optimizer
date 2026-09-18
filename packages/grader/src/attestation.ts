/**
 * Recording a human attestation — the one write to `check_states` a grade
 * itself never makes. A person takes responsibility for a check no crawler
 * can verify, or overrides one it could, for the review window only a
 * person can set. `recordGrade`'s own re-grade already knows to leave what
 * this writes alone, except on the four exception-proof gates (record.ts).
 *
 * The trail is append-only in `attestations`; the live state lands on
 * `check_states` with `coverage: 'attested'` and no `evidenceRef` — an
 * attested row cites the person's own words, never the engine's, per
 * `CheckState.evidenceRef`'s own contract (@seo/core).
 */

import { and, eq } from 'drizzle-orm';
import type { Applicability, CheckStatus, Corpus } from '@seo/core';
import { attestations, checkStates } from '@seo/db';
import type { Database } from '@seo/db';

/** An attestation body that cannot be recorded. Every problem is listed. */
export class InvalidAttestationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`invalid attestation:\n  ${problems.join('\n  ')}`);
    this.name = 'InvalidAttestationError';
  }
}

/** `checkId` names no check in the corpus the audit is pinned to. */
export class UnknownCheckError extends Error {
  constructor(readonly checkId: string, readonly corpusVersion: string) {
    super(`corpus ${corpusVersion} names no check ${checkId}`);
    this.name = 'UnknownCheckError';
  }
}

export interface AttestationInput {
  readonly checkId: string;
  /** Who takes responsibility. Free text until identities are modelled. */
  readonly attestedBy: string;
  /** What was attested, in the attester's own words. */
  readonly statement: string;
  /** ISO date-time. Coverage reverts to `unknown` once this passes. */
  readonly expiresAt: string;
  readonly status: CheckStatus;
  /** Defaults to `yes`: attesting a check ordinarily means it is in scope. */
  readonly applicability?: Applicability;
  /** Required when `applicability` is `no`. */
  readonly applicabilityRationale?: string;
}

export interface AttestationResult {
  readonly attestation: typeof attestations.$inferSelect;
  readonly checkState: typeof checkStates.$inferSelect;
}

export async function recordAttestation(
  db: Database,
  args: {
    readonly auditId: string;
    /** The corpus the audit is pinned to — `checkId` is checked against it. */
    readonly corpus: Corpus;
    readonly input: AttestationInput;
    readonly now?: Date;
  },
): Promise<AttestationResult> {
  const { input } = args;
  if (!args.corpus.checks.some((check) => check.id === input.checkId)) {
    throw new UnknownCheckError(input.checkId, args.corpus.version);
  }

  const problems: string[] = [];
  const now = args.now ?? new Date();
  const expiresAt = new Date(input.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) {
    problems.push('expiresAt: not a valid date');
  } else if (expiresAt.getTime() <= now.getTime()) {
    problems.push('expiresAt: must be in the future');
  }

  const applicability = input.applicability ?? 'yes';
  const rationale = input.applicabilityRationale?.trim();
  if (applicability === 'no' && (rationale === undefined || rationale === '')) {
    problems.push('applicabilityRationale: required when applicability is "no"');
  }

  if (problems.length > 0) throw new InvalidAttestationError(problems);

  return db.transaction(async (tx) => {
    const [attestationRow] = await tx
      .insert(attestations)
      .values({
        auditId: args.auditId,
        checkId: input.checkId,
        attestedBy: input.attestedBy,
        statement: input.statement,
        expiresAt,
      })
      .returning();

    // A replace, not an upsert, for the reason `recordGrade` deletes before
    // inserting (record.ts): a superseded machine verdict's `check_evidence`
    // trail must not survive under a row that now says something else.
    await tx
      .delete(checkStates)
      .where(and(eq(checkStates.auditId, args.auditId), eq(checkStates.checkId, input.checkId)));

    const [stateRow] = await tx
      .insert(checkStates)
      .values({
        auditId: args.auditId,
        checkId: input.checkId,
        applicability,
        applicabilityRationale: applicability === 'no' ? rationale! : null,
        status: input.status,
        coverage: 'attested',
        evidence: input.statement,
        attestationExpiresAt: expiresAt,
      })
      .returning();

    return { attestation: attestationRow!, checkState: stateRow! };
  });
}
