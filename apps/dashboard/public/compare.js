// Pure comparison helpers for two audits' frozen readiness + graded checks.
// No DOM access, so these are unit-testable directly in Node (see test/compare.test.ts)
// and reusable from app.js as an ordinary ES module.

/** Weighted mean of every phase's percentComplete, weighted by its active check count. */
export function overallPercent(progress) {
  if (!progress || progress.length === 0) return null;
  const totalActive = progress.reduce((sum, p) => sum + p.active, 0);
  if (totalActive === 0) return null;
  const weighted = progress.reduce((sum, p) => sum + p.percentComplete * p.active, 0);
  return Math.round(weighted / totalActive);
}

/**
 * Diffs two audits' frozen readiness blocks (as stored on `audits.readiness`,
 * i.e. the `{ corpusVersion, readiness, progress, cutover? }` shape). Either
 * side may be null, for an audit that has not graded yet.
 */
export function diffReadiness(baseline, current) {
  const baseProgress = baseline?.progress ?? [];
  const curProgress = current?.progress ?? [];
  const phases = new Set([...baseProgress.map((p) => p.phase), ...curProgress.map((p) => p.phase)]);

  const phaseDeltas = [...phases].sort((a, b) => a - b).map((phase) => {
    const b = baseProgress.find((p) => p.phase === phase) ?? null;
    const c = curProgress.find((p) => p.phase === phase) ?? null;
    return {
      phase,
      baselinePercent: b ? b.percentComplete : null,
      currentPercent: c ? c.percentComplete : null,
      delta: b && c ? c.percentComplete - b.percentComplete : null,
    };
  });

  const summarize = (frozen) => frozen && {
    corpusVersion: frozen.corpusVersion,
    decision: frozen.readiness.decision,
    gatesOutstanding: frozen.readiness.gatesOutstanding,
    gatesFailed: frozen.readiness.gatesFailed,
    overallPercent: overallPercent(frozen.progress),
  };

  return {
    corpusVersionMismatch: Boolean(baseline && current && baseline.corpusVersion !== current.corpusVersion),
    decisionChanged: Boolean(baseline && current && baseline.readiness.decision !== current.readiness.decision),
    baseline: summarize(baseline),
    current: summarize(current),
    phaseDeltas,
  };
}

/**
 * Diffs two audits' graded checks (the `checks` array from GET /audits/:id/result)
 * down to the ones whose verdict actually moved — a different `status` or
 * `applicability`, or one with no counterpart in the baseline at all. Sorted
 * by check id for a stable read.
 */
export function diffChecks(baselineChecks, currentChecks) {
  const byId = new Map((baselineChecks ?? []).map((c) => [c.checkId, c]));
  const moves = [];

  for (const after of currentChecks ?? []) {
    const before = byId.get(after.checkId) ?? null;
    const moved = before === null || before.status !== after.status || before.applicability !== after.applicability;
    if (!moved) continue;
    moves.push({
      checkId: after.checkId,
      before: before && { status: before.status, applicability: before.applicability },
      after: { status: after.status, applicability: after.applicability },
    });
  }

  return moves.sort((a, b) => a.checkId.localeCompare(b.checkId));
}
