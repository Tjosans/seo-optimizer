import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadCorpus } from '@seo/corpus';
import { PROBES, buildProbeMatrix, formatProbeMatrix } from '@seo/probes';

const corpus = loadCorpus(fileURLToPath(new URL('../../../corpus/v4.4', import.meta.url)));
const matrix = buildProbeMatrix(corpus);

describe('probe matrix', () => {
  it('registers no probe the corpus never asked for', () => {
    // An orphan probe is dead weight at best: nothing in the methodology can
    // consume its observation, so no report will ever show it.
    expect(matrix.orphanProbes).toEqual([]);
  });

  it('gives every probe a unique id', () => {
    const ids = PROBES.map((probe) => probe.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('accounts for every detector the corpus declares', () => {
    const declared = new Set(corpus.checks.flatMap((check) => check.detectors));
    expect(matrix.summary.detectorsDeclared).toBe(declared.size);
    expect(matrix.detectors.filter((row) => row.implemented)).toHaveLength(PROBES.length);
  });

  it('never claims an attested check is coverable by a machine', () => {
    for (const row of matrix.checks) {
      if (row.automation === 'attested') expect(row.coverable, row.checkId).toBe(false);
    }
  });

  it('treats partial detector coverage as no coverage', () => {
    for (const row of matrix.checks) {
      if (row.missingDetectors.length > 0) expect(row.coverable, row.checkId).toBe(false);
    }
  });

  it('reports the coverage gap rather than hiding it', () => {
    const { detectorsImplemented, detectorsDeclared, automatedChecksCoverable } = matrix.summary;
    expect(detectorsImplemented).toBeGreaterThan(0);
    expect(detectorsImplemented).toBeLessThan(detectorsDeclared);
    expect(automatedChecksCoverable).toBeGreaterThan(0);

    const rendered = formatProbeMatrix(matrix);
    expect(rendered).toContain(`detectors implemented: ${detectorsImplemented}/${detectorsDeclared}`);
  });

  it('fully covers the checks whose detectors are all implemented', () => {
    // These are the checks an audit can currently answer end to end. The list
    // is asserted so that losing one is a test failure, not a quiet regression.
    const coverable = matrix.checks.filter((row) => row.coverable).map((row) => row.checkId);
    expect(coverable).toContain('1.4');
    expect(coverable).toContain('3.2');
  });
});
