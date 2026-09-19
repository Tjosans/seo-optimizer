import { describe, expect, it } from 'vitest';
import { GUARD_PROBES, evaluateGuard, guardProbes } from '@seo/probes';
import type { ProbeRun } from '@seo/probes';

const run = (probeId: string, outcome: 'pass' | 'fail' | 'warn', pageUrl?: string): ProbeRun => ({
  probeId,
  scope: pageUrl === undefined ? 'site' : 'page',
  ...(pageUrl === undefined ? {} : { pageUrl }),
  observation: { outcome, summary: `${probeId} ${outcome}` },
});

describe('release guard', () => {
  it('names only detectors that exist', () => {
    expect(guardProbes().map((p) => p.id).sort()).toEqual(Object.keys(GUARD_PROBES).sort());
  });

  it('passes a clean run and counts warnings without blocking', () => {
    const report = evaluateGuard([run('robots-txt', 'pass'), run('broken-links', 'warn')], 'b1');
    expect(report).toMatchObject({ passed: true, warnings: 1, build: 'b1' });
  });

  it('fails on any guarded fail and ignores other detectors', () => {
    const report = evaluateGuard(
      [run('canonicalization', 'fail', 'https://x.test/a'), run('http-status', 'fail', 'https://x.test/b')],
      null,
    );
    expect(report.passed).toBe(false);
    expect(report.failures).toEqual([
      { concern: 'canonical', probeId: 'canonicalization', pageUrl: 'https://x.test/a', summary: 'canonicalization fail' },
    ]);
  });
});
