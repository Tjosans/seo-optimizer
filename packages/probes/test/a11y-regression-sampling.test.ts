/** `a11y-regression-sampling` (7.7): axe results against the previous audit's. */

import { describe, expect, it } from 'vitest';
import type { CrawlResult } from '@seo/crawler';
import { parsePrevious, probeById } from '@seo/probes';
import type { Observation, PreviousAudit, SiteProbe } from '@seo/probes';

const URL_ = 'https://www.example.com/checkout';
type V = { id: string; impact: string; nodes: number };
const v = (id: string, impact: string): V => ({ id, impact, nodes: 1 });

const now = (violations?: V[], error: string | null = null) => ({
  normalizedUrl: URL_,
  fetch: { status: 200, headers: {} },
  extracted: null,
  ...(violations === undefined ? {} : { rendered: { render: { accessibility: { error, violations } } } }),
});

const before = (axe?: V[] | null): PreviousAudit =>
  ({
    schema: 1,
    origin: 'https://www.example.com',
    takenAt: '2026-08-01T00:00:00.000Z',
    pages: [{ url: URL_, status: 200, finalUrl: URL_, metaRobots: null, xRobotsTag: null, canonical: null, title: null, jsonLdTypes: [], hreflang: [], ...(axe === undefined ? {} : { axe }) }],
    probes: [],
  }) as PreviousAudit;

const check = (pages: unknown[], previous: PreviousAudit | null): Observation =>
  (probeById('a11y-regression-sampling') as SiteProbe).run({
    origin: 'https://www.example.com',
    flags: [],
    crawl: { crawledAt: '2026-09-19T12:00:00.000Z', pages } as unknown as CrawlResult,
    previous,
  });

describe('a11y-regression-sampling', () => {
  it('is not applicable without a previous audit or axe on both sides', () => {
    expect(check([now([])], null).outcome).toBe('not-applicable');
    expect(check([now([])], before()).outcome).toBe('not-applicable');
    expect(check([now([])], before(null)).outcome).toBe('not-applicable');
    expect(check([now()], before([])).outcome).toBe('not-applicable');
    expect(check([now([], 'boom')], before([])).outcome).toBe('not-applicable');
  });

  it('fails a critical id that is new on a page', () => {
    const observation = check([now([v('label', 'critical')])], before([v('image-alt', 'critical')]));
    expect(observation.outcome).toBe('fail');
  });

  it('does not fail a critical id the page already had', () => {
    expect(check([now([v('label', 'critical')])], before([v('label', 'critical')])).outcome).toBe('pass');
  });

  it('warns when serious violations rise, and passes when they fall', () => {
    expect(check([now([v('a', 'serious'), v('b', 'serious')])], before([v('a', 'serious')])).outcome).toBe('warn');
    expect(check([now([])], before([v('a', 'serious')])).outcome).toBe('pass');
  });

  it('round-trips axe through parsePrevious and refuses a malformed one', () => {
    const snapshot = before([v('a', 'serious')]);
    expect(parsePrevious(JSON.parse(JSON.stringify(snapshot))).pages[0]?.axe).toEqual([v('a', 'serious')]);
    const bad = JSON.parse(JSON.stringify(snapshot));
    bad.pages[0].axe = [{ id: 'a', impact: null }];
    expect(() => parsePrevious(bad)).toThrow(/nodes/);
  });
});
