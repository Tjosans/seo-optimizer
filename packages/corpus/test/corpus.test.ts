/**
 * What must be true of any corpus version, now and in ten years.
 *
 * Every version directory under `corpus/` is discovered and run through the
 * same suite, so a new one is covered the moment it lands rather than when
 * someone remembers to add it here. Nothing in this file names a version or a
 * count: those belong to `provenance.test.ts`, which is frozen against the
 * workbook v4.4 came from.
 *
 * The split is the point. Checks change because search changes, and a suite
 * that made "add a check" mean "edit six numbers recording a 2026 spreadsheet"
 * would be taxing the thing the product exists to do.
 */

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeLaunchReadiness } from '@seo/core';
import type { CheckState, Corpus } from '@seo/core';
import { loadCorpus } from '@seo/corpus';

const CORPUS_ROOT = fileURLToPath(new URL('../../../corpus', import.meta.url));

/** Every compiled version on disk, by directory name. */
const versions = readdirSync(CORPUS_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^v\d+\.\d+$/.test(entry.name))
  .map((entry) => entry.name)
  .sort();

// A repository with no compiled corpus is a broken checkout, not an empty case.
if (versions.length === 0) throw new Error(`no corpus versions found under ${CORPUS_ROOT}`);

const defaultStates = (corpus: Corpus): Map<string, CheckState> =>
  new Map(
    corpus.checks.map((c) => [
      c.id,
      {
        checkId: c.id,
        applicability: c.applicability.universal ? 'yes' : 'review',
        status: 'not-started',
        coverage: 'unknown',
      } satisfies CheckState,
    ]),
  );

const allStates = (corpus: Corpus, of: (gate: boolean) => CheckState['status']) =>
  new Map(
    corpus.checks.map((c) => [
      c.id,
      {
        checkId: c.id,
        applicability: 'yes',
        status: of(c.launchGate),
        coverage: 'verified',
      } satisfies CheckState,
    ]),
  );

describe.each(versions)('corpus %s', (dir) => {
  const corpus = loadCorpus(`${CORPUS_ROOT}/${dir}`);

  describe('integrity', () => {
    it('declares the version its directory is named for', () => {
      expect(`v${corpus.version}`).toBe(dir);
    });

    it('gives every check a unique id', () => {
      expect(new Set(corpus.checks.map((c) => c.id)).size).toBe(corpus.checks.length);
    });

    it('places every check in a lifecycle phase', () => {
      for (const check of corpus.checks) {
        expect(check.phase, check.id).toBeGreaterThanOrEqual(0);
        expect(check.phase, check.id).toBeLessThanOrEqual(7);
        expect(check.phaseLabel.length, check.id).toBeGreaterThan(0);
      }
    });

    it('binds detectors to exactly the checks that can be mechanically verified', () => {
      for (const check of corpus.checks) {
        if (check.automation === 'attested') {
          expect(check.detectors, check.id).toHaveLength(0);
        } else {
          expect(check.detectors.length, check.id).toBeGreaterThan(0);
        }
      }
    });

    it('gives every conditional check a way to come into scope', () => {
      for (const check of corpus.checks) {
        if (check.applicability.universal) continue;
        expect(check.applicability.any.length, check.id).toBeGreaterThan(0);
        expect(check.applicability.any, check.id).not.toContain('UNMAPPED');
      }
    });

    it('carries the acceptance criteria detectors are specified against', () => {
      for (const check of corpus.checks) {
        expect(check.doneWhen.length, check.id).toBeGreaterThan(20);
        expect(check.whatToDo.length, check.id).toBeGreaterThan(20);
      }
    });

    it('dates every citation so staleness is trackable', () => {
      for (const check of corpus.checks) {
        for (const source of check.sources) {
          expect(source.url, check.id).toMatch(/^https:\/\//);
          expect(source.verified, check.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
      }
    });

    it('resolves sources for every check whose notes cite them', () => {
      for (const check of corpus.checks.filter((c) => /See Sources:/i.test(c.notes))) {
        expect(check.sources.length, `${check.id} notes cite sources`).toBeGreaterThan(0);
      }
    });
  });

  describe('launch gate semantics', () => {
    it('holds launch while any gate’s applicability is undecided', () => {
      const states = defaultStates(corpus);
      // Pass every gate already in scope; the undecided ones must still HOLD.
      for (const check of corpus.checks) {
        const state = states.get(check.id)!;
        if (state.applicability === 'yes') {
          states.set(check.id, { ...state, status: 'passed', coverage: 'verified' });
        }
      }

      const undecidedGates = corpus.checks.filter(
        (c) => c.launchGate && !c.applicability.universal,
      ).length;
      expect(undecidedGates, 'a corpus with no conditional gate cannot test this').toBeGreaterThan(0);

      const readiness = computeLaunchReadiness(corpus.checks, states);
      expect(readiness.gatesOutstanding).toBe(0);
      expect(readiness.applicabilityDecisionsOutstanding).toBe(undecidedGates);
      expect(readiness.decision).toBe('HOLD');
    });

    it('reaches GO only once gates pass and every scope decision is resolved', () => {
      const readiness = computeLaunchReadiness(corpus.checks, allStates(corpus, () => 'passed'));
      expect(readiness.decision).toBe('GO');
    });

    it('refuses to let "skipped" clear an applicable launch gate', () => {
      const gates = corpus.checks.filter((c) => c.launchGate).length;
      expect(gates).toBeGreaterThan(0);

      const readiness = computeLaunchReadiness(
        corpus.checks,
        allStates(corpus, (gate) => (gate ? 'skipped' : 'passed')),
      );
      expect(readiness.decision).toBe('HOLD');
      expect(readiness.gatesOutstanding).toBe(gates);
      expect(readiness.violations).toHaveLength(gates);
      expect(readiness.violations[0]?.kind).toBe('skipped-applicable-gate');
    });

    it('requires a rationale when a check is taken out of scope', () => {
      const excluded = corpus.checks[0]!;
      const states = defaultStates(corpus);
      states.set(excluded.id, {
        checkId: excluded.id,
        applicability: 'no',
        status: 'not-started',
        coverage: 'not-applicable',
      });

      const readiness = computeLaunchReadiness(corpus.checks, states);
      expect(
        readiness.violations.some(
          (v) => v.checkId === excluded.id && v.kind === 'excluded-without-rationale',
        ),
      ).toBe(true);
    });

    it('treats profile as advisory and never as a launch filter', () => {
      // Extended-profile launch gates exist; filtering to core would hide them.
      const extendedGates = corpus.checks.filter(
        (c) => c.launchGate && c.profile === 'extended',
      );
      expect(extendedGates.length).toBeGreaterThan(0);
    });
  });
});
