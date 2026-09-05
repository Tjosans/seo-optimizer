/**
 * Verdicts to `check_states`, the trail to `check_evidence`, and the frozen
 * readiness onto `audits`.
 *
 * Two things make this more than an insert.
 *
 * A human sign-off outranks a machine verdict. A row whose coverage is
 * `attested` was written by a person taking responsibility for a check no
 * crawler can verify, and a re-grade that overwrote it would delete the only
 * part of the audit a machine cannot reproduce. Those rows are read, left
 * alone, and counted in the readiness that gets frozen — so the verdict on the
 * audit is the merge of what the engine found and what a person signed, not
 * whichever of the two ran last.
 *
 * And the write is a replace, not an upsert. Regrading the same audit against
 * more evidence has to be able to retract an evidence link, which an upsert
 * cannot do; deleting the check's state row first takes its `check_evidence`
 * rows with it through the foreign key and leaves no stale trail behind.
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { CheckState, Corpus } from '@seo/core';
import { audits, checkEvidence, checkStates } from '@seo/db';
import type { Database } from '@seo/db';
import { readinessOf } from './grade.js';
import { CorpusVersionMismatchError, toCheckState } from './types.js';
import type { FrozenReadiness, GradeResult } from './types.js';

/** Rows per insert. Well under the driver's parameter ceiling. */
const INSERT_CHUNK = 500;

export interface RecordGradeArgs {
  readonly auditId: string;
  /** Must be the corpus the grade was reached against. */
  readonly corpus: Corpus;
  readonly grade: GradeResult;
  /**
   * Write `audits.readiness`. A delivered report must not move when the
   * engine's scoring later does, so freezing is what makes the audit final.
   */
  readonly freeze?: boolean;
}

export interface RecordGradeResult {
  readonly frozen: FrozenReadiness;
  /** Checks whose state this grade wrote. */
  readonly written: number;
  /** Checks left alone because a person had already attested them. */
  readonly preserved: readonly string[];
  readonly evidenceLinks: number;
}

export async function recordGrade(
  db: Database,
  args: RecordGradeArgs,
): Promise<RecordGradeResult> {
  if (args.corpus.version !== args.grade.corpusVersion) {
    throw new CorpusVersionMismatchError(args.corpus.version, args.grade.corpusVersion);
  }

  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(checkStates)
      .where(eq(checkStates.auditId, args.auditId));

    const attested = existing.filter((row) => row.coverage === 'attested');
    const preserved = new Set(attested.map((row) => row.checkId));

    const writable = args.grade.checks.filter((graded) => !preserved.has(graded.checkId));

    if (writable.length > 0) {
      await tx.delete(checkStates).where(
        and(
          eq(checkStates.auditId, args.auditId),
          inArray(
            checkStates.checkId,
            writable.map((graded) => graded.checkId),
          ),
        ),
      );

      const stateRows = writable.map((graded) => ({
        auditId: args.auditId,
        checkId: graded.checkId,
        applicability: graded.applicability,
        applicabilityRationale: graded.applicabilityRationale,
        status: graded.status,
        coverage: graded.coverage,
        evidence: graded.summary,
      }));
      for (const batch of chunk(stateRows, INSERT_CHUNK)) {
        await tx.insert(checkStates).values(batch);
      }
    }

    const evidenceRows = writable.flatMap((graded) =>
      graded.evidenceIds.map((probeResultId) => ({
        auditId: args.auditId,
        checkId: graded.checkId,
        probeResultId,
      })),
    );
    for (const batch of chunk(evidenceRows, INSERT_CHUNK)) {
      await tx.insert(checkEvidence).values(batch);
    }

    // Readiness over the merge: this grade's verdicts, plus the attestations it
    // was not entitled to touch.
    const states = new Map<string, CheckState>(
      writable.map((graded) => [graded.checkId, toCheckState(graded)]),
    );
    for (const row of attested) states.set(row.checkId, toState(row));

    const frozen: FrozenReadiness = {
      corpusVersion: args.grade.corpusVersion,
      gradedAt: args.grade.gradedAt,
      ...readinessOf(args.corpus, states),
    };

    if (args.freeze !== false) {
      await tx.update(audits).set({ readiness: frozen }).where(eq(audits.id, args.auditId));
    }

    return {
      frozen,
      written: writable.length,
      preserved: attested.map((row) => row.checkId),
      evidenceLinks: evidenceRows.length,
    };
  });
}

/** A stored row as @seo/core's scoring functions want it. */
function toState(row: typeof checkStates.$inferSelect): CheckState {
  return {
    checkId: row.checkId,
    applicability: row.applicability,
    ...(row.applicabilityRationale === null
      ? {}
      : { applicabilityRationale: row.applicabilityRationale }),
    status: row.status,
    coverage: row.coverage,
    ...(row.evidence === null ? {} : { evidence: row.evidence }),
    ...(row.attestationExpiresAt === null
      ? {}
      : { attestationExpiresAt: row.attestationExpiresAt.toISOString() }),
  };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}
