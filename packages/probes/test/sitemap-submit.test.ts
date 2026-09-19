/** `sitemap-submit` (5.4): is every sitemap the crawl found submitted to Search Console, and error-free. */

import { describe, expect, it } from 'vitest';
import type { CrawlResult } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const at = '2026-09-01T00:00:00.000Z';
const doc = (url: string, status: number | null = 200) => ({ url, status, urlCount: 1, truncated: false, videoCount: 0, newsCount: 0 });
const row = (url: string, status = 'Success', errors = 0) => ({ url, submittedAt: at, status, errors });
const record = (sitemaps?: unknown[], over: Record<string, unknown> = {}) => ({
  owner: 'Jane',
  recordedAt: at,
  ...(sitemaps === undefined ? {} : { sitemaps }),
  ...over,
});

const check = (searchConsole?: unknown, docs = [doc('https://www.example.com/sitemap.xml')]): Observation =>
  (probeById('sitemap-submit') as SiteProbe).run({
    origin: 'https://www.example.com',
    flags: [],
    crawl: {
      crawledAt: '2026-09-19T12:00:00.000Z',
      seeds: [],
      pages: [],
      robots: { groups: [], sitemaps: [], absent: true },
      robotsTxt: null,
      sitemapUrls: [],
      sitemaps: docs,
      sitemapVideos: [],
      sitemapNews: [],
      blockedByRobots: [],
      notReached: [],
      auxiliary: [],
    } as unknown as CrawlResult,
    ...(searchConsole === undefined ? {} : { inputs: { searchConsole } as never }),
  });

const url = 'https://www.example.com/sitemap.xml';

describe('sitemap-submit', () => {
  it('is not applicable without the section or a found sitemap', () => {
    expect(check().outcome).toBe('not-applicable');
    expect(check(record([]), []).outcome).toBe('not-applicable');
    expect(check(record([]), [doc(url, 404)]).outcome).toBe('not-applicable');
  });

  it('passes a submitted sitemap without errors', () => {
    expect(check(record([row(url)])).outcome).toBe('pass');
  });

  it('fails a sitemap Search Console reports with errors', () => {
    expect(check(record([row(url, 'Has errors', 2)])).outcome).toBe('fail');
    expect(check(record([row(url, 'Success', 1)])).outcome).toBe('fail');
  });

  it('warns on a sitemap with no submission record', () => {
    expect(check(record([row('https://www.example.com/other.xml')])).outcome).toBe('warn');
    expect(check(record([])).outcome).toBe('warn');
  });

  it('warns, never fails, when the export holds no sitemaps report or could not fetch', () => {
    expect(check(record()).outcome).toBe('warn');
    expect(check(record([row(url, "Couldn't fetch")])).outcome).toBe('warn');
  });

  it('warns on a record nobody owns or that is overdue', () => {
    expect(check(record([row(url)], { owner: ' ' })).outcome).toBe('warn');
    expect(check(record([row(url)], { nextReviewAt: '2026-09-10T00:00:00.000Z' })).outcome).toBe('warn');
  });
});
