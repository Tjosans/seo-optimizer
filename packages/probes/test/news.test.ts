/**
 * `news-sitemap` (corpus v5.0 2.18), against hand-built crawl results.
 *
 * The detector reads only what the sitemap loader recorded — entries, per-file
 * counts and the moment each file was served — so a crawl result is the whole
 * of its input, and building one directly is the clearest way to state each
 * rule. The parser that fills these fields is tested in @seo/crawler.
 */

import { describe, expect, it } from 'vitest';
import type { CrawlResult, SitemapFetch, SitemapNewsEntry } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, SiteProbe } from '@seo/probes';

const ORIGIN = 'https://news.example';
const SITEMAP = `${ORIGIN}/news-sitemap.xml`;
const SERVED = '2026-09-14T12:00:00.000Z';
const HOUR = 3_600_000;

const hoursBefore = (hours: number): string =>
  new Date(Date.parse(SERVED) - hours * HOUR).toISOString();

const entry = (path: string, over: Partial<SitemapNewsEntry> = {}): SitemapNewsEntry => ({
  sitemap: SITEMAP,
  loc: `${ORIGIN}${path}`,
  publicationName: 'The Example Times',
  language: 'en',
  publicationDate: hoursBefore(3),
  title: 'A story',
  ...over,
});

const document = (over: Partial<SitemapFetch> = {}): SitemapFetch => ({
  url: SITEMAP,
  status: 200,
  urlCount: 1,
  videoCount: 0,
  newsCount: 1,
  truncated: false,
  fetchedAt: SERVED,
  ...over,
});

const run = (
  sitemapNews: readonly SitemapNewsEntry[],
  sitemaps: readonly SitemapFetch[] = [document({ urlCount: sitemapNews.length, newsCount: sitemapNews.length })],
): Observation =>
  (probeById('news-sitemap') as SiteProbe).run({
    origin: ORIGIN,
    flags: ['news'],
    crawl: {
      seeds: [`${ORIGIN}/`],
      pages: [],
      robots: { groups: [], sitemaps: [], absent: true },
      robotsTxt: null,
      sitemapUrls: sitemapNews.map((item) => item.loc),
      sitemaps,
      sitemapVideos: [],
      sitemapNews,
      blockedByRobots: [],
      notReached: [],
      auxiliary: [],
    } satisfies CrawlResult,
  });

describe('news-sitemap', () => {
  it('passes a feed of recent, complete entries', () => {
    const observation = run([entry('/a'), entry('/b', { publicationDate: '2026-09-13', language: 'zh-tw' })]);
    expect(observation.outcome).toBe('pass');
    expect(observation.data).toMatchObject({ entries: 2, largestFile: 2 });
  });

  // v5.0: "No news sitemap or AMP is required for ordinary websites", and "an
  // intentionally empty feed is acceptable".
  it('has nothing to say about a site with no news sitemap, or an empty one', () => {
    expect(run([], [document({ url: `${ORIGIN}/sitemap.xml`, newsCount: 0 })]).outcome).toBe('not-applicable');
    const empty = run([], [document({ urlCount: 0, newsCount: 0 })]);
    expect(empty.outcome).toBe('not-applicable');
    expect(empty.summary).toMatch(/named for news and empty/);
  });

  it('fails a news sitemap the site declares and the server does not serve', () => {
    const observation = run([], [document({ status: 404, urlCount: 0, newsCount: 0 })]);
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/could not be fetched/);
  });

  it('does not take a newsletter sitemap for a news one', () => {
    const observation = run([], [document({ url: `${ORIGIN}/newsletter-sitemap.xml`, status: 404, newsCount: 0 })]);
    expect(observation.outcome).toBe('not-applicable');
  });

  it('fails a file carrying more than 1,000 news entries', () => {
    const observation = run([entry('/a')], [document({ urlCount: 1001, newsCount: 1001 })]);
    expect(observation.outcome).toBe('fail');
    expect(observation.summary).toMatch(/more than 1000 news entries/);
  });

  // A count read from part of a file is a lower bound; past the limit is past it.
  it('fails an over-full file even when it could not be read to the end', () => {
    expect(run([entry('/a')], [document({ newsCount: 1200, truncated: true })]).outcome).toBe('fail');
  });

  it('cannot judge the entries of a file it had to cut', () => {
    const observation = run([entry('/a'), entry('/b', { title: null })], [document({ newsCount: 2, truncated: true })]);
    expect(observation.outcome).toBe('error');
  });

  it('fails an entry missing a field Google reads', () => {
    const observation = run([entry('/a', { publicationName: null, title: null })]);
    expect(observation.outcome).toBe('fail');
    expect(JSON.stringify(observation.data)).toMatch(/missing news:name, news:title/);
  });

  it('fails an article carrying news metadata days after it was published', () => {
    const observation = run([entry('/old', { publicationDate: hoursBefore(80) })]);
    expect(observation.outcome).toBe('fail');
    expect(JSON.stringify(observation.data)).toMatch(/past the two-day window/);
  });

  // A feed pruned once a day carries entries up to a day past the window.
  it('holds an entry just past two days for a person rather than failing it', () => {
    const observation = run([entry('/a'), entry('/yesterday-ish', { publicationDate: hoursBefore(55) })]);
    expect(observation.outcome).toBe('warn');
    expect(observation.summary).toMatch(/1 of 2/);
  });

  // At noon UTC on the 14th, "2026-09-12" ended 24 hours ago at the latest
  // reading (its last moment in UTC−12) and began 50 hours ago at the earliest
  // (its midnight in UTC+14). Only the reading most favourable to the site is
  // judged, so it passes, and the 11th is the first day past the window.
  it('reads a date without a time as generously as any time zone allows', () => {
    expect(run([entry('/a', { publicationDate: '2026-09-12' })]).outcome).toBe('pass');
    expect(run([entry('/a', { publicationDate: '2026-09-11' })]).outcome).toBe('warn');
    expect(run([entry('/a', { publicationDate: '2026-09-10' })]).outcome).toBe('fail');
  });

  it('fails a publication date after the sitemap was served', () => {
    const observation = run([entry('/a', { publicationDate: '2026-09-14T18:00:00Z' })]);
    expect(observation.outcome).toBe('fail');
    expect(JSON.stringify(observation.data)).toMatch(/after the sitemap was served/);
    expect(run([entry('/a', { publicationDate: '2026-09-15' })]).outcome).toBe('pass');
  });

  it.each([
    ['a month alone', '2026-09'],
    ['a time with no zone', '2026-09-14T08:00:00'],
    ['a date that does not exist', '2026-02-30'],
    ['prose', 'September 14, 2026'],
  ])('fails a publication date that is %s', (_, value) => {
    const observation = run([entry('/a', { publicationDate: value })]);
    expect(observation.outcome).toBe('fail');
    expect(JSON.stringify(observation.data)).toMatch(/not a W3C date/);
  });

  it('fails a language that names no language, and warns on a regional tag', () => {
    const wrong = run([entry('/a', { language: 'jp' })]);
    expect(wrong.outcome).toBe('fail');
    expect(JSON.stringify(wrong.data)).toMatch(/not an ISO 639-1 code/);
    expect(run([entry('/a', { language: 'iw' })]).outcome).toBe('fail');
    expect(run([entry('/a', { language: 'English' })]).outcome).toBe('fail');
    expect(run([entry('/a', { language: 'en-GB' })]).outcome).toBe('warn');
    expect(run([entry('/a', { language: 'fil' })]).outcome).toBe('pass');
  });

  it("fails an entry naming somebody else's article", () => {
    const observation = run([{ ...entry('/a'), loc: 'https://elsewhere.example/story' }]);
    expect(observation.outcome).toBe('fail');
    expect(JSON.stringify(observation.data)).toMatch(/another origin/);
  });

  it('measures each entry against the file that carried it', () => {
    const second = `${ORIGIN}/news-sitemap-2.xml`;
    const observation = run(
      [entry('/a'), entry('/b', { sitemap: second, publicationDate: hoursBefore(80) })],
      [document(), document({ url: second, fetchedAt: hoursBefore(48) })],
    );
    expect(observation.outcome).toBe('pass');
    expect(observation.data).toMatchObject({ sitemaps: [SITEMAP, second] });
  });
});
