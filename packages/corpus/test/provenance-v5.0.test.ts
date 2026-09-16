/**
 * Does v5.0 still say what the workbook said?
 *
 * The same question `provenance.test.ts` asks of v4.4, asked of the workbook
 * v5.0 was bootstrapped from: SEO-Launch-Checklist-v5.0.xlsx, verified
 * 2026-09-11, SHA-256
 * 1165d18b9edd4241cd1952028cfb5ab1e01ee5727b23eaaaa4c3c6f56260612a. Its
 * Checklist, Sources, Progress and How to use sheets are exported under
 * corpus/source/v5.0*.tsv, and the numbers below are that Progress sheet's.
 *
 * Frozen like its v4.4 counterpart. Editing corpus/v5.0 does not edit these
 * numbers; a later methodology is a later version with a file of its own.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  computeCutoverReadiness,
  computeLaunchReadiness,
  computeProgress,
  evidenceClassOf,
} from '@seo/core';
import type { CheckState } from '@seo/core';
import { loadCorpus } from '@seo/corpus';

const DIR = fileURLToPath(new URL('../../../corpus/v5.0', import.meta.url));
const corpus = loadCorpus(DIR);

/** Taken from the workbook Progress sheet, verified 2026-09-11. Do not update. */
const WORKBOOK = {
  version: '5.0',
  checks: 98,
  sources: 108,
  active: 54,
  scopeReview: 44,
  launchGates: 54,
  gatesOutstanding: 29,
  applicabilityDecisionsOutstanding: 25,
  decision: 'HOLD' as const,
  activeByPhase: [5, 12, 4, 9, 7, 5, 4, 8],
  scopeReviewByPhase: [4, 7, 14, 4, 5, 3, 4, 3],
  checksByPhase: [9, 19, 18, 13, 12, 8, 8, 11],
  priority: { P0: 54, P1: 35, P2: 9 },
  profile: { core: 68, extended: 30 },
  checksCitingSources: 93,
  evidenceClasses: { planning: 5, preflight: 43, live: 6 },
  cutover: {
    assessment: 'HOLD' as const,
    inputErrors: 0,
    preCutoverGatesOutstanding: 25,
    liveGatesOutstanding: 4,
    preCutoverEvidenceIncomplete: 25,
    liveEvidenceIncomplete: 4,
    cutoverRecordValid: false,
    scopeErrors: 8,
    final: 'HOLD' as const,
  },
};

function defaultStates(): Map<string, CheckState> {
  return new Map(
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
}

describe('v5.0 still reproduces its source workbook', () => {
  it('carries the version, check count and source count the workbook declared', () => {
    expect(corpus.version).toBe(WORKBOOK.version);
    expect(corpus.checks).toHaveLength(WORKBOOK.checks);
    const sources = parse(readFileSync(`${DIR}/sources.yaml`, 'utf8')) as unknown[];
    expect(sources).toHaveLength(WORKBOOK.sources);
  });

  it('preserves the phase distribution', () => {
    for (let phase = 0; phase < 8; phase += 1) {
      const count = corpus.checks.filter((c) => c.phase === phase).length;
      expect(count, `phase ${phase}`).toBe(WORKBOOK.checksByPhase[phase]);
    }
  });

  it('keeps a moved check under its original id', () => {
    // 6.8 moved to Ongoing in v5.0 and kept its id, as the workbook requires.
    expect(corpus.checks.find((c) => c.id === '6.8')?.phase).toBe(7);
  });

  it('preserves priority and profile distributions', () => {
    for (const [priority, expected] of Object.entries(WORKBOOK.priority)) {
      const count = corpus.checks.filter((c) => c.priority === priority).length;
      expect(count, priority).toBe(expected);
    }
    for (const [profile, expected] of Object.entries(WORKBOOK.profile)) {
      const count = corpus.checks.filter((c) => c.profile === profile).length;
      expect(count, profile).toBe(expected);
    }
  });

  it('resolves every citation the workbook made by source id', () => {
    const citing = corpus.checks.filter((c) => /Source IDs?:/.test(c.notes));
    expect(citing).toHaveLength(WORKBOOK.checksCitingSources);
    for (const check of citing) {
      const ids = check.sources.map((s) => s.id);
      for (const [, list] of check.notes.matchAll(/Source IDs?:\s*([^.]+)/g)) {
        for (const id of (list ?? '').split(/[;,]/).map((s) => s.trim()).filter(Boolean)) {
          expect(ids, `${check.id} cites ${id}`).toContain(id);
        }
      }
    }
  });
});

describe('v5.0 reproduces the workbook launch-readiness block', () => {
  const states = defaultStates();

  it('matches the final launch assessment exactly', () => {
    const readiness = computeLaunchReadiness(corpus.checks, states);
    expect(readiness.gatesOutstanding).toBe(WORKBOOK.gatesOutstanding);
    expect(readiness.gatesFailed).toBe(0);
    expect(readiness.applicabilityDecisionsOutstanding).toBe(
      WORKBOOK.applicabilityDecisionsOutstanding,
    );
    expect(readiness.decision).toBe(WORKBOOK.decision);
    expect(readiness.violations).toHaveLength(0);
  });

  it('accounts for every launch gate as either outstanding or undecided', () => {
    expect(corpus.checks.filter((c) => c.launchGate)).toHaveLength(WORKBOOK.launchGates);
    expect(
      WORKBOOK.gatesOutstanding + WORKBOOK.applicabilityDecisionsOutstanding,
    ).toBe(WORKBOOK.launchGates);
  });

  it('matches the per-phase progress rows', () => {
    const progress = computeProgress(corpus.checks, states);
    expect(progress.reduce((n, p) => n + p.active, 0)).toBe(WORKBOOK.active);
    expect(progress.reduce((n, p) => n + p.scopeReview, 0)).toBe(WORKBOOK.scopeReview);
    for (const row of progress) {
      expect(row.active, `phase ${row.phase} active`).toBe(WORKBOOK.activeByPhase[row.phase]);
      expect(row.scopeReview, `phase ${row.phase} review`).toBe(
        WORKBOOK.scopeReviewByPhase[row.phase],
      );
    }
  });

});

describe('v5.0 reproduces the workbook cutover-readiness block', () => {
  it('classes its gates as the release scope register does', () => {
    const gates = corpus.checks.filter((c) => c.launchGate);
    const counts = { planning: 0, preflight: 0, live: 0 };
    for (const gate of gates) counts[evidenceClassOf(gate)] += 1;
    expect(counts).toEqual(WORKBOOK.evidenceClasses);
  });

  it('matches the calculated cutover and final assessments of the empty template', () => {
    // The template ships with no release record, so every one of its eight
    // fields is a scope error and no gate has evidence.
    const result = computeCutoverReadiness(corpus, defaultStates());
    expect({
      assessment: result.cutover,
      inputErrors: result.inputErrors,
      preCutoverGatesOutstanding: result.preCutoverGatesOutstanding,
      liveGatesOutstanding: result.liveGatesOutstanding,
      preCutoverEvidenceIncomplete: result.preCutoverEvidenceIncomplete,
      liveEvidenceIncomplete: result.liveEvidenceIncomplete,
      cutoverRecordValid: result.cutoverRecordValid,
      scopeErrors: result.scopeErrors,
      final: result.final,
    }).toEqual(WORKBOOK.cutover);
    expect(result.launch.decision).toBe(WORKBOOK.decision);
  });
});
