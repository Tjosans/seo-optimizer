/** `inherited-domain-history` (0.8): what a person learned about an inherited domain's past. */

import { describe, expect, it } from 'vitest';
import type { CrawlResult } from '@seo/crawler';
import { InputsError, parseInputs } from '@seo/core';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const at = '2026-09-01T00:00:00.000Z';

const record = (over: Record<string, unknown> = {}) => ({
  owner: 'Jane',
  recordedAt: at,
  checks: [
    { name: 'Manual actions review', result: 'none found', checkedAt: at },
    { name: 'Wayback archive review', result: 'a blog, no spam', checkedAt: at },
  ],
  blockingIssues: [{ issue: 'Spammy backlinks', resolved: true }],
  ...over,
});

const check = (domainHistory?: unknown): Observation =>
  (probeById('inherited-domain-history') as SiteProbe).run({
    origin: 'https://www.example.com',
    flags: [],
    crawl: {
      crawledAt: '2026-09-19T12:00:00.000Z',
      seeds: [],
      pages: [],
      robots: { groups: [], sitemaps: [], absent: true },
      robotsTxt: null,
      sitemapUrls: [],
      sitemaps: [],
      sitemapVideos: [],
      sitemapNews: [],
      blockedByRobots: [],
      notReached: [],
      auxiliary: [],
    } satisfies CrawlResult,
    ...(domainHistory === undefined ? {} : { inputs: { domainHistory } as never }),
  });

describe('inherited-domain-history', () => {
  it('is not applicable without the section', () => {
    expect(check().outcome).toBe('not-applicable');
  });

  it('passes a complete history with every issue resolved', () => {
    expect(check(record()).outcome).toBe('pass');
  });

  it('fails an unresolved blocking issue', () => {
    expect(check(record({ blockingIssues: [{ issue: 'Manual penalty', resolved: false }] })).outcome).toBe('fail');
  });

  it('fails a missing manual-action or archive check', () => {
    const checks = record().checks;
    expect(check(record({ checks: [checks[1]] })).outcome).toBe('fail');
    expect(check(record({ checks: [checks[0]] })).outcome).toBe('fail');
    expect(check(record({ checks: [] })).outcome).toBe('fail');
  });

  it('warns on a record nobody owns or that is overdue', () => {
    expect(check(record({ owner: ' ' })).outcome).toBe('warn');
    expect(check(record({ nextReviewAt: '2026-09-10T00:00:00.000Z' })).outcome).toBe('warn');
  });
});

describe('parseInputs domainHistory', () => {
  it('parses a record', () => {
    expect(parseInputs({ domainHistory: record() }).domainHistory?.checks).toHaveLength(2);
  });

  it('refuses bad shapes, listing paths', () => {
    const bad = record({ checks: [{ name: 'x', result: 'y', checkedAt: 'nope' }], blockingIssues: [{ issue: 'z', resolved: 'no' }] });
    try {
      parseInputs({ domainHistory: bad });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InputsError);
      const problems = (error as InputsError).problems.join('\n');
      expect(problems).toContain('domainHistory.checks[0].checkedAt');
      expect(problems).toContain('domainHistory.blockingIssues[0].resolved');
    }
  });
});
