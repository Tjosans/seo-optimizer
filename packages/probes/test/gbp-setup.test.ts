/** `gbp-setup` (2.12): location pages' LocalBusiness markup against the business profile. */

import { describe, expect, it } from 'vitest';
import { parseInputs } from '@seo/core';
import type { CrawlResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const PAGE = 'https://example.com/stockholm';

const profile = (over: Record<string, unknown> = {}) => ({
  eligible: true,
  verification: 'verified',
  locations: [{ name: 'Example Café', address: 'Storgatan 1, 111 23 Stockholm', phone: '+46 8 123 45 67', url: PAGE }],
  owner: 'Jane Doe',
  recordedAt: '2026-09-10T09:00:00Z',
  ...over,
});

const markup = (over: Record<string, unknown> = {}) => ({
  '@type': 'LocalBusiness',
  name: 'Example Café',
  address: { '@type': 'PostalAddress', streetAddress: 'Storgatan 1' },
  telephone: '+4681234567',
  ...over,
});

const check = (businessProfile: unknown, jsonLd: unknown[] = [markup()]): Observation =>
  (probeById('gbp-setup') as SiteProbe).run({
    origin: 'https://example.com',
    flags: [],
    crawl: {
      crawledAt: '2026-09-19T12:00:00.000Z',
      pages: [{ normalizedUrl: PAGE, fetch: { finalUrl: PAGE }, extracted: { jsonLd } }],
    } as unknown as CrawlResult,
    inputs: (businessProfile === undefined ? {} : parseInputs({ businessProfile })) as never,
  });

describe('gbp-setup', () => {
  it('is not applicable without a record, or when not eligible', () => {
    expect(check(undefined).outcome).toBe('not-applicable');
    expect(check(profile({ eligible: false, verification: 'unverified', locations: [] })).outcome).toBe('not-applicable');
  });

  it('passes agreeing markup on a verified profile', () => {
    expect(check(profile()).outcome).toBe('pass');
  });

  it('fails a name, address or phone that disagrees', () => {
    expect(check(profile(), [markup({ name: 'Other Café' })]).outcome).toBe('fail');
    expect(check(profile(), [markup({ telephone: '+46 8 999 99 99' })]).outcome).toBe('fail');
    expect(check(profile(), [markup({ address: { streetAddress: 'Kungsgatan 9' } })]).outcome).toBe('fail');
  });

  it('warns pending verification', () => {
    expect(check(profile({ verification: 'pending' })).outcome).toBe('warn');
  });

  it('warns a page with no LocalBusiness markup and a location the crawl missed', () => {
    expect(check(profile(), []).outcome).toBe('warn');
    const other = profile({ locations: [{ name: 'A', address: 'B', phone: '1', url: 'https://example.com/gothenburg' }] });
    expect(check(other).outcome).toBe('warn');
  });

  it('holds an unowned record', () => {
    expect(check(profile({ owner: '' })).outcome).toBe('warn');
  });

  it('is parsed strictly', () => {
    expect(() => parseInputs({ businessProfile: profile({ extra: 1 }) })).toThrow(/extra/);
    expect(() => parseInputs({ businessProfile: profile({ verification: 'maybe' }) })).toThrow(/verification/);
    expect(() => parseInputs({ businessProfile: profile({ eligible: 'yes' }) })).toThrow(/eligible/);
    expect(() => parseInputs({ businessProfile: profile({ locations: [{ name: 'A', address: 'B', phone: 1, url: PAGE }] }) })).toThrow(/phone/);
  });
});
