/** `manual-a11y-evaluation` (4.4): a person's accessibility evaluation, against what axe saw. */

import { describe, expect, it } from 'vitest';
import { parseInputs } from '@seo/core';
import type { CrawlResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const URL_ = 'https://www.example.com/checkout';

const page = (impact?: string) => ({
  normalizedUrl: URL_,
  fetch: { status: 200, headers: {} },
  extracted: null,
  ...(impact === undefined
    ? {}
    : { rendered: { render: { accessibility: { error: null, violations: [{ id: 'color-contrast', impact, nodes: 1 }] } } } }),
});
const blocker = (over: Record<string, unknown> = {}) => ({ criterion: '2.1.1 Keyboard', url: URL_, resolved: true, ...over });
const evaluation = (over: Record<string, unknown> = {}) => ({
  scope: 'checkout',
  methods: ['keyboard walk-through'],
  limitations: [],
  blockers: [blocker()],
  conformanceClaim: '',
  owner: 'Jane',
  recordedAt: '2026-09-10T09:00:00.000Z',
  ...over,
});

const check = (a11yEvaluation: unknown, pages: unknown[]): Observation =>
  (probeById('manual-a11y-evaluation') as SiteProbe).run({
    origin: 'https://www.example.com',
    flags: [],
    crawl: { crawledAt: '2026-09-19T12:00:00.000Z', pages } as unknown as CrawlResult,
    inputs: (a11yEvaluation === undefined ? {} : { a11yEvaluation }) as never,
  });

describe('manual-a11y-evaluation', () => {
  it('is not applicable without a record', () => {
    expect(check(undefined, [page()]).outcome).toBe('not-applicable');
  });

  it('passes resolved blockers and no claim', () => {
    expect(check(evaluation(), [page('critical')]).outcome).toBe('pass');
  });

  it('fails an open blocker', () => {
    expect(check(evaluation({ blockers: [blocker({ resolved: false })] }), [page()]).outcome).toBe('fail');
  });

  it('fails a conformance claim beside a critical axe violation', () => {
    expect(check(evaluation({ conformanceClaim: 'WCAG 2.2 AA' }), [page('critical')]).outcome).toBe('fail');
  });

  it('does not fail a claim beside a serious violation, and warns when axe never ran', () => {
    expect(check(evaluation({ conformanceClaim: 'WCAG 2.2 AA' }), [page('serious')]).outcome).toBe('pass');
    expect(check(evaluation({ conformanceClaim: 'WCAG 2.2 AA' }), [page()]).outcome).toBe('warn');
  });

  it('warns a record with no owner or past its review', () => {
    expect(check(evaluation({ owner: ' ' }), [page()]).outcome).toBe('warn');
    expect(check(evaluation({ nextReviewAt: '2026-09-15T00:00:00.000Z' }), [page()]).outcome).toBe('warn');
  });
});

describe('parseInputs a11yEvaluation', () => {
  const raw = (over: Record<string, unknown> = {}) => ({ ...evaluation(), ...over });

  it('reads a record, blank claim when none is made', () => {
    const record = parseInputs({ a11yEvaluation: raw() }).a11yEvaluation;
    expect(record?.conformanceClaim).toBe('');
    expect(record?.blockers[0]).toMatchObject({ criterion: '2.1.1 Keyboard', resolved: true });
  });

  it('refuses bad fields, listing each by path', () => {
    expect(() => parseInputs({ a11yEvaluation: raw({ methods: [], blockers: [blocker({ resolved: 'no', url: '/x' })] }) })).toThrow(
      /methods[\s\S]*http\(s\) URL[\s\S]*resolved/,
    );
    expect(() => parseInputs({ a11yEvaluation: raw({ scope: undefined }) })).toThrow(/a11yEvaluation\.scope/);
  });
});
