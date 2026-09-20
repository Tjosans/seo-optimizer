/** `brand-entity-consistency` (0.5): Organization markup against the supplied brand record. */

import { describe, expect, it } from 'vitest';
import { parseInputs } from '@seo/core';
import type { CrawlResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const LINKEDIN = 'https://www.linkedin.com/company/example';

const record = (over: Record<string, unknown> = {}) => ({
  legalName: 'Example Holdings AB',
  publicName: 'Example',
  sameAs: [LINKEDIN],
  owner: 'Jane',
  recordedAt: '2026-09-10T09:00:00.000Z',
  ...over,
});
const page = (...nodes: unknown[]) => ({
  normalizedUrl: 'https://www.example.com/',
  fetch: { status: 200, headers: {} },
  extracted: { jsonLd: nodes },
});
const org = (over: Record<string, unknown> = {}) => ({
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Example',
  sameAs: [LINKEDIN],
  ...over,
});

const check = (brandEntity: unknown, pages: unknown[]): Observation =>
  (probeById('brand-entity-consistency') as SiteProbe).run({
    origin: 'https://www.example.com',
    flags: [],
    crawl: { crawledAt: '2026-09-19T12:00:00.000Z', pages } as unknown as CrawlResult,
    inputs: (brandEntity === undefined ? {} : { brandEntity }) as never,
  });

describe('brand-entity-consistency', () => {
  it('is not applicable without a record', () => {
    expect(check(undefined, [page(org())]).outcome).toBe('not-applicable');
  });

  it('passes markup that uses a recorded name and profile, however the URL is spelled', () => {
    expect(check(record(), [page(org({ sameAs: 'http://linkedin.com/company/example/' }))]).outcome).toBe('pass');
    expect(check(record(), [page(org({ name: 'example holdings ab' }))]).outcome).toBe('pass');
  });

  it('fails a sameAs the record does not list', () => {
    const result = check(record(), [page(org({ sameAs: [LINKEDIN, 'https://twitter.com/other'] }))]);
    expect(result.outcome).toBe('fail');
  });

  it('fails a name matching neither record name', () => {
    expect(check(record(), [page(org({ name: 'Other Corp' }))]).outcome).toBe('fail');
  });

  it('does not judge a LocalBusiness branch name', () => {
    expect(check(record(), [page(org(), org({ '@type': 'LocalBusiness', name: 'Example Malmö' }))]).outcome).toBe('pass');
  });

  it('warns a recorded profile no markup carries', () => {
    expect(check(record(), [page(org({ sameAs: [] }))]).outcome).toBe('warn');
    expect(check(record(), [page()]).outcome).toBe('warn');
  });

  it('warns a record with no owner', () => {
    expect(check(record({ owner: '' }), [page(org())]).outcome).toBe('warn');
  });

  it('is parsed strictly', () => {
    const yaml = { brandEntity: record() };
    expect(parseInputs(yaml).brandEntity?.sameAs).toEqual([LINKEDIN]);
    expect(() => parseInputs({ brandEntity: record({ sameAs: ['not a url'] }) })).toThrow(/sameAs\[0\]/);
    expect(() => parseInputs({ brandEntity: record({ publicName: 4 }) })).toThrow(/publicName/);
    expect(() => parseInputs({ brandEntity: record({ extra: 1 }) })).toThrow(/extra/);
  });
});
