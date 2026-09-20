/** `security-dependency-maintenance` (7.10): the vulnerability list and the version banners the crawl saw. */

import { describe, expect, it } from 'vitest';
import { parseInputs } from '@seo/core';
import type { CrawlResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'CVE-2026-0001',
  severity: 'critical',
  owner: 'Sam',
  fixedAt: '2026-09-05T09:00:00Z',
  ...over,
});

const vulnerabilities = (over: Record<string, unknown> = {}) => ({
  entries: [entry()],
  owner: 'Jane Doe',
  recordedAt: '2026-09-10T09:00:00Z',
  ...over,
});

const check = (section: unknown, headers: Record<string, string> = {}): Observation =>
  (probeById('security-dependency-maintenance') as SiteProbe).run({
    origin: 'https://example.com',
    flags: [],
    crawl: {
      crawledAt: '2026-09-19T12:00:00.000Z',
      pages: [{ url: 'https://example.com/', depth: 0, fetch: { headers } }],
      auxiliary: [],
    } as unknown as CrawlResult,
    inputs: (section === undefined ? {} : parseInputs({ vulnerabilities: section })) as never,
  });

describe('security-dependency-maintenance', () => {
  it('is not applicable without a record', () => {
    expect(check(undefined).outcome).toBe('not-applicable');
  });

  it('passes fixed criticals and versionless banners', () => {
    expect(check(vulnerabilities(), { server: 'nginx', 'x-powered-by': 'Express' }).outcome).toBe('pass');
    expect(check(vulnerabilities({ entries: [] })).outcome).toBe('pass');
    expect(check(vulnerabilities({ entries: [entry({ fixedAt: undefined, severity: 'high', owner: '' })] })).outcome).toBe('pass');
  });

  it('fails an unfixed critical with no owner', () => {
    expect(check(vulnerabilities({ entries: [entry({ fixedAt: undefined, owner: '' })] })).outcome).toBe('fail');
  });

  it('holds an owned unfixed critical', () => {
    expect(check(vulnerabilities({ entries: [entry({ fixedAt: undefined })] })).outcome).toBe('warn');
  });

  it('warns a Server or X-Powered-By header that names a version', () => {
    expect(check(vulnerabilities(), { server: 'nginx/1.18.0' }).outcome).toBe('warn');
    expect(check(vulnerabilities(), { 'x-powered-by': 'PHP/8.1.2' }).outcome).toBe('warn');
    expect(check(vulnerabilities(), { server: 'Apache 2.4.41' }).outcome).toBe('warn');
  });

  it('holds an unowned record', () => {
    expect(check(vulnerabilities({ owner: '' })).outcome).toBe('warn');
  });

  it('is parsed strictly', () => {
    expect(() => parseInputs({ vulnerabilities: vulnerabilities({ extra: 1 }) })).toThrow(/extra/);
    expect(() => parseInputs({ vulnerabilities: vulnerabilities({ entries: [entry({ severity: 'severe' })] }) })).toThrow(/severity/);
    expect(() => parseInputs({ vulnerabilities: vulnerabilities({ entries: [entry({ id: '' })] }) })).toThrow(/id/);
    expect(() => parseInputs({ vulnerabilities: vulnerabilities({ entries: [entry({ fixedAt: 'soon' })] }) })).toThrow(/fixedAt/);
  });
});
