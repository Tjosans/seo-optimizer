/**
 * The probe matrix: what the corpus asks for, against what the engine can
 * actually observe.
 *
 * This is the honesty layer of the product. The corpus declares 128 detectors;
 * anything not implemented has to be visible as a gap, or an audit will report
 * a check as unverified without anyone knowing why — or worse, a check will be
 * quietly graded on evidence that was never gathered.
 *
 * A check is `coverable` only when EVERY detector it declares is implemented.
 * Partial detector coverage is not partial verification: the corpus binds a
 * check's "Done when" to the whole set.
 */

import type { AutomationTier, Corpus } from '@seo/core';
import { PROBES } from './registry.js';
import type { Probe, ProbeScope } from './types.js';

export interface DetectorRow {
  readonly detectorId: string;
  /** Corpus check ids that declare this detector. */
  readonly checks: readonly string[];
  readonly implemented: boolean;
  readonly scope: ProbeScope | null;
}

export interface CheckRow {
  readonly checkId: string;
  readonly automation: AutomationTier;
  readonly launchGate: boolean;
  readonly detectors: readonly string[];
  readonly missingDetectors: readonly string[];
  /** True when every detector this check declares has a probe behind it. */
  readonly coverable: boolean;
}

export interface ProbeMatrix {
  readonly detectors: readonly DetectorRow[];
  readonly checks: readonly CheckRow[];
  /** Registered probes whose id no corpus check declares. Always a defect. */
  readonly orphanProbes: readonly string[];
  readonly summary: {
    readonly detectorsDeclared: number;
    readonly detectorsImplemented: number;
    /** Checks the corpus claims are machine-verifiable end to end. */
    readonly automatedChecks: number;
    /** Of those, how many the engine can fully evidence today. */
    readonly automatedChecksCoverable: number;
    readonly launchGatesCoverable: number;
  };
}

export function buildProbeMatrix(
  corpus: Corpus,
  probes: readonly Probe[] = PROBES,
): ProbeMatrix {
  const implemented = new Map(probes.map((probe) => [probe.id, probe.scope]));

  const declaredBy = new Map<string, string[]>();
  for (const check of corpus.checks) {
    for (const detector of check.detectors) {
      const checks = declaredBy.get(detector) ?? [];
      checks.push(check.id);
      declaredBy.set(detector, checks);
    }
  }

  const detectors: DetectorRow[] = [...declaredBy.entries()]
    .map(([detectorId, checks]) => ({
      detectorId,
      checks,
      implemented: implemented.has(detectorId),
      scope: implemented.get(detectorId) ?? null,
    }))
    .sort((a, b) => a.detectorId.localeCompare(b.detectorId));

  const checks: CheckRow[] = corpus.checks.map((check) => {
    const missing = check.detectors.filter((detector) => !implemented.has(detector));
    return {
      checkId: check.id,
      automation: check.automation,
      launchGate: check.launchGate,
      detectors: check.detectors,
      missingDetectors: missing,
      // An attested check declares no detectors and is never coverable by a
      // probe; saying otherwise would let a machine sign off on governance.
      coverable: check.automation !== 'attested' && missing.length === 0,
    };
  });

  const orphanProbes = probes
    .map((probe) => probe.id)
    .filter((id) => !declaredBy.has(id))
    .sort();

  const automated = checks.filter((row) => row.automation === 'automated');

  return {
    detectors,
    checks,
    orphanProbes,
    summary: {
      detectorsDeclared: detectors.length,
      detectorsImplemented: detectors.filter((row) => row.implemented).length,
      automatedChecks: automated.length,
      automatedChecksCoverable: automated.filter((row) => row.coverable).length,
      launchGatesCoverable: checks.filter((row) => row.launchGate && row.coverable).length,
    },
  };
}

/** Render the matrix as a fixed-width table, for a CLI or a build log. */
export function formatProbeMatrix(matrix: ProbeMatrix): string {
  const lines = [
    'detector                             impl  scope  checks',
    '------------------------------------------------------------',
  ];
  for (const row of matrix.detectors) {
    lines.push(
      row.detectorId.padEnd(36) +
        (row.implemented ? ' yes ' : ' --  ').padEnd(6) +
        (row.scope ?? '-').padEnd(7) +
        row.checks.join(' '),
    );
  }
  const s = matrix.summary;
  lines.push(
    '',
    `detectors implemented: ${s.detectorsImplemented}/${s.detectorsDeclared}`,
    `automated checks fully coverable: ${s.automatedChecksCoverable}/${s.automatedChecks}`,
    `launch gates fully coverable: ${s.launchGatesCoverable}`,
  );
  return lines.join('\n');
}
