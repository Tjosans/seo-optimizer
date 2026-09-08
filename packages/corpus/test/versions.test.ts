/**
 * Two corpus versions, side by side.
 *
 * Everything in the engine is built for this — `audits.corpusVersion` is text,
 * check ids are text with no foreign key, `CorpusSource` resolves a version to
 * a corpus, and a version this process cannot produce is a permanent failure —
 * but until now nothing had ever loaded two at once. A mechanism that has never
 * run is a plan, and the day you find out it does not work is the day you are
 * mid-migration.
 *
 * The fixtures under `fixtures/` model what a methodology revision really does:
 * 9.1 keeps a check with a stricter "Done when" and an extra detector, drops
 * one, adds one, and re-tiers one from attested to assisted. See their README
 * for why they sit outside `corpus/`.
 */

import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { knownFlags, loadCorpus, unknownFlags } from '@seo/corpus';
import { gradeAudit } from '@seo/grader';
import type { Evidence } from '@seo/grader';

const at = (version: string) =>
  loadCorpus(fileURLToPath(new URL(`./fixtures/${version}`, import.meta.url)));

const v90 = at('v9.0');
const v91 = at('v9.1');

/** One page-scoped observation, as the grader receives it. */
const seen = (probeId: string, outcome: 'pass' | 'fail'): Evidence => ({
  run: {
    probeId,
    scope: 'page',
    pageUrl: 'https://example.com/',
    observation: { outcome, summary: `${probeId} ${outcome}` },
  },
  probeResultId: `${probeId}-1`,
});

describe('loading two versions at once', () => {
  it('keeps them separate, each reporting its own version', () => {
    expect(v90.version).toBe('9.0');
    expect(v91.version).toBe('9.1');
    expect(v90.checks).toHaveLength(2);
    expect(v91.checks).toHaveLength(3);
  });

  it('lets a check id mean different things in different versions', () => {
    const before = v90.checks.find((c) => c.id === '1.1')!;
    const after = v91.checks.find((c) => c.id === '1.1')!;

    // Same id, same check, revised acceptance — which is exactly why an audit
    // pins a version rather than a set of ids.
    expect(before.detectors).toEqual(['http-status']);
    expect(after.detectors).toEqual(['http-status', 'redirect-chain']);
    expect(after.doneWhen).not.toBe(before.doneWhen);
  });

  it('survives a check being dropped and another added', () => {
    expect(v90.checks.map((c) => c.id)).toEqual(['1.1', '1.2']);
    expect(v91.checks.map((c) => c.id)).toEqual(['1.1', '1.3', '1.4']);
  });

  it('lets the flag vocabulary differ between versions', () => {
    expect([...knownFlags(v90)]).toEqual(['ecommerce']);
    expect(unknownFlags(v90, ['ecommerce'])).toEqual([]);
    expect(unknownFlags(v90, ['ecommmerce', 'multilingual'])).toEqual([
      'ecommmerce',
      'multilingual',
    ]);
  });
});

describe('grading the same evidence against each', () => {
  const evidence = [seen('http-status', 'pass'), seen('redirect-chain', 'fail')];
  const implemented = new Set(['http-status', 'redirect-chain', 'https-enforcement']);

  it('answers with the version it was graded against', () => {
    expect(gradeAudit({ corpus: v90, flags: ['ecommerce'], evidence, implementedDetectors: implemented }).corpusVersion).toBe('9.0');
    expect(gradeAudit({ corpus: v91, flags: ['ecommerce'], evidence, implementedDetectors: implemented }).corpusVersion).toBe('9.1');
  });

  it('reaches opposite verdicts on one check, because the versions ask for different things', () => {
    const under = (version: '9.0' | '9.1') =>
      gradeAudit({
        corpus: version === '9.0' ? v90 : v91,
        flags: ['ecommerce'],
        evidence,
        implementedDetectors: implemented,
      }).checks.find((c) => c.checkId === '1.1')!;

    // 9.0 asks only about status, and status passed.
    expect(under('9.0').status).toBe('passed');
    // 9.1 also asks about the redirect chain, and that failed. Same evidence,
    // same check id, different answer — the pinned version is what decides.
    expect(under('9.1').status).toBe('failed');
  });

  it('grades only the checks its own version declares', () => {
    const graded = (version: '9.0' | '9.1') =>
      gradeAudit({
        corpus: version === '9.0' ? v90 : v91,
        flags: ['ecommerce'],
        evidence,
        implementedDetectors: implemented,
      }).checks.map((c) => c.checkId);

    expect(graded('9.0')).toEqual(['1.1', '1.2']);
    expect(graded('9.1')).toEqual(['1.1', '1.3', '1.4']);
  });

  it('freezes a readiness verdict per version', () => {
    const a = gradeAudit({ corpus: v90, flags: ['ecommerce'], evidence, implementedDetectors: implemented });
    const b = gradeAudit({ corpus: v91, flags: ['ecommerce'], evidence, implementedDetectors: implemented });

    expect(a.readiness.decision).toBeDefined();
    expect(b.readiness.decision).toBeDefined();
    // 9.1 has a failing launch gate that 9.0 does not, so the two must not
    // agree — a shared cache or a shared mutable corpus would show up here.
    expect(b.readiness.gatesFailed).toBeGreaterThan(a.readiness.gatesFailed);
  });
});
