/** `indexnow-integration` (2.10): the key file the crawl fetched and the submission log against the host. */

import { describe, expect, it } from 'vitest';
import { indexNowKeyUrl, parseInputs } from '@seo/core';
import type { AuxiliaryFetch, CrawlResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const KEY = 'a1b2c3d4e5f6a7b8';
const KEY_URL = `https://example.com/${KEY}.txt`;

const record = (over: Record<string, unknown> = {}) => ({
  key: KEY,
  log: [{ url: 'https://example.com/a', sentAt: '2026-09-18T09:00:00Z', status: 200 }],
  owner: 'Jane Doe',
  recordedAt: '2026-09-10T09:00:00Z',
  ...over,
});

const keyFile = (over: { status?: number | null; body?: string; error?: string | null } = {}): AuxiliaryFetch => ({
  reason: 'indexnow-key',
  url: KEY_URL,
  fetch: {
    requestedUrl: KEY_URL,
    finalUrl: KEY_URL,
    status: over.status === undefined ? 200 : over.status,
    headers: {},
    redirectChain: [],
    body: over.body ?? KEY,
    byteLength: 0,
    truncated: false,
    contentType: 'text/plain',
    ttfbMs: null,
    totalMs: null,
    error: over.error ?? null,
  },
});

const check = (indexNow: unknown, auxiliary: AuxiliaryFetch[] = [keyFile()]): Observation =>
  (probeById('indexnow-integration') as SiteProbe).run({
    origin: 'https://example.com',
    flags: [],
    crawl: { crawledAt: '2026-09-19T12:00:00.000Z', pages: [], auxiliary } as unknown as CrawlResult,
    inputs: (indexNow === undefined ? {} : parseInputs({ indexNow })) as never,
  });

describe('indexnow-integration', () => {
  it('is not applicable without a record', () => {
    expect(check(undefined).outcome).toBe('not-applicable');
  });

  it('passes a key file holding the key and a clean log', () => {
    expect(check(record()).outcome).toBe('pass');
    expect(check(record({ log: [] })).outcome).toBe('pass');
  });

  it('fails a missing key file or one holding something else', () => {
    expect(check(record(), [keyFile({ status: 404, body: '' })]).outcome).toBe('fail');
    expect(check(record(), [keyFile({ status: null, error: 'ECONNREFUSED' })]).outcome).toBe('fail');
    expect(check(record(), [keyFile({ body: 'not-the-key' })]).outcome).toBe('fail');
  });

  it('fails a logged URL on another host, ignoring www', () => {
    const other = { url: 'https://other.example/a', sentAt: '2026-09-18T09:00:00Z', status: 200 };
    expect(check(record({ log: [other] })).outcome).toBe('fail');
    const www = { url: 'https://www.example.com/a', sentAt: '2026-09-18T09:00:00Z', status: 200 };
    expect(check(record({ log: [www] })).outcome).toBe('pass');
  });

  it('fails one URL sent more than five times in a day, not across days', () => {
    const sends = (n: number, day: string) =>
      Array.from({ length: n }, (_, i) => ({ url: 'https://example.com/a', sentAt: `${day}T0${i}:00:00Z`, status: 200 }));
    expect(check(record({ log: sends(6, '2026-09-18') })).outcome).toBe('fail');
    expect(check(record({ log: sends(5, '2026-09-18') })).outcome).toBe('pass');
    expect(check(record({ log: [...sends(5, '2026-09-17'), ...sends(5, '2026-09-18')] })).outcome).toBe('pass');
  });

  it('holds an unrequested key file and an unowned record', () => {
    expect(check(record(), []).outcome).toBe('warn');
    expect(check(record({ owner: '' })).outcome).toBe('warn');
  });

  it('reads the key file at keyLocation when given', () => {
    const location = 'https://example.com/.well-known/key.txt';
    expect(indexNowKeyUrl(parseInputs({ indexNow: record({ keyLocation: location }) }).indexNow, 'https://example.com')).toBe(location);
    expect(indexNowKeyUrl(parseInputs({ indexNow: record() }).indexNow, 'https://example.com')).toBe(KEY_URL);
  });

  it('is parsed strictly', () => {
    expect(() => parseInputs({ indexNow: record({ extra: 1 }) })).toThrow(/extra/);
    expect(() => parseInputs({ indexNow: record({ key: undefined }) })).toThrow(/key/);
    expect(() => parseInputs({ indexNow: record({ log: [{ url: 'https://example.com/a', sentAt: 'soon', status: 200 }] }) })).toThrow(/sentAt/);
    expect(() => parseInputs({ indexNow: record({ log: [{ url: 'https://example.com/a', sentAt: '2026-09-18T09:00:00Z', status: '200' }] }) })).toThrow(/status/);
  });
});
