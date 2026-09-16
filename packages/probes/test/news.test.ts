/**
 * The two 2.18 detectors (corpus v5.0), against hand-built crawl results.
 *
 * `news-sitemap` reads only what the sitemap loader recorded — entries,
 * per-file counts and the moment each file was served — so a crawl result is
 * the whole of its input. `news-article-policy` also reads pages, which go
 * through the real `extract` so the probe sees what a crawl would give it. The
 * parser that fills the sitemap fields is tested in @seo/crawler.
 */

import { describe, expect, it } from 'vitest';
import { extract } from '@seo/crawler';
import type { CrawledPage, CrawlResult, SitemapFetch, SitemapNewsEntry } from '@seo/crawler';
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
): Observation => runProbe('news-sitemap', sitemapNews, sitemaps);

function runProbe(
  id: string,
  sitemapNews: readonly SitemapNewsEntry[],
  sitemaps: readonly SitemapFetch[],
  pages: readonly CrawledPage[] = [],
): Observation {
  return (probeById(id) as SiteProbe).run({
    origin: ORIGIN,
    flags: ['news'],
    crawl: {
      seeds: [`${ORIGIN}/`],
      pages,
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
}

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

  // Cross-host sitemaps are valid once both hosts are verified to one owner in
  // Search Console, which the crawl cannot see. nytimes.com lists cooking.nytimes.com.
  it('holds an entry on another host for a person rather than failing it', () => {
    const observation = run([{ ...entry('/a'), loc: 'https://cooking.news.example/story' }]);
    expect(observation.outcome).toBe('warn');
    expect(JSON.stringify(observation.data)).toMatch(/another host/);
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

// --- news-article-policy ----------------------------------------------------

const FOOTER = '<footer><a href="/about-us">About us</a> <a href="/contact">Contact</a></footer>';
const PUBLISHER = ', "publisher": {"@type": "NewsMediaOrganization", "name": "The Example Times"}';

interface ArticleSpec {
  readonly types?: readonly string[];
  readonly author?: string | null;
  readonly published?: string | null;
  readonly publisher?: boolean;
  readonly body?: string;
  readonly footer?: string;
}

const articleHtml = ({
  types = ['NewsArticle'],
  author = 'Ada Reporter',
  published = hoursBefore(3),
  publisher = true,
  body = '<p>What happened, and why it matters.</p>',
  footer = FOOTER,
}: ArticleSpec = {}): string => {
  const node =
    `{"@context": "https://schema.org", "@type": ${JSON.stringify(types)}, "headline": "A story"` +
    (author === null ? '' : `, "author": {"@type": "Person", "name": "${author}"}`) +
    (published === null ? '' : `, "datePublished": "${published}"`) +
    (publisher ? PUBLISHER : '') +
    '}';
  return (
    `<html lang="en"><head><script type="application/ld+json">${node}</script></head>` +
    `<body><main><h1>A story</h1>${body}</main>${footer}</body></html>`
  );
};

const htmlPage = (path: string, html: string, truncated = false): CrawledPage => {
  const url = `${ORIGIN}${path}`;
  return {
    url,
    normalizedUrl: url,
    depth: 1,
    discoveredFrom: null,
    fetch: {
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      headers: { 'content-type': 'text/html' },
      redirectChain: [],
      body: html,
      byteLength: html.length,
      truncated,
      contentType: 'text/html',
      ttfbMs: 1,
      totalMs: 2,
      error: null,
    },
    extracted: extract(html, url),
  };
};

const policy = (pages: readonly CrawledPage[], feed: readonly SitemapNewsEntry[] = []): Observation =>
  runProbe('news-article-policy', feed, feed.length === 0 ? [] : [document({ newsCount: feed.length })], pages);

describe('news-article-policy', () => {
  it('passes attributed, dated articles on a site that says who it is', () => {
    const observation = policy([htmlPage('/a', articleHtml())], [entry('/a')]);
    expect(observation.outcome).toBe('pass');
    expect(observation.data).toMatchObject({
      articles: 1,
      listedInFeed: 1,
      contactFound: true,
      publisherFound: true,
    });
  });

  it('has nothing to say about a site that offers nothing as news', () => {
    const blog = htmlPage('/post', articleHtml({ types: ['BlogPosting'] }));
    expect(policy([blog]).outcome).toBe('not-applicable');
  });

  it('judges a page the feed lists as news, whatever its markup says', () => {
    const post = htmlPage('/post', articleHtml({ types: ['BlogPosting'], author: null }));
    const observation = policy([post], [entry('/post')]);
    expect(observation.outcome).toBe('warn');
    expect(observation.summary).toMatch(/1 of 1 news article\(s\) name no author/);
  });

  it('judges a page typed NewsArticle that the feed does not list', () => {
    const observation = policy([htmlPage('/a', articleHtml({ author: null }))]);
    expect(observation.outcome).toBe('warn');
    expect(observation.data).toMatchObject({ articles: 1, listedInFeed: 0 });
  });

  it('cannot review a feed whose articles the crawl never reached', () => {
    const observation = policy([], [entry('/a'), entry('/b')]);
    expect(observation.outcome).toBe('error');
    expect(observation.summary).toMatch(/reached none of them/);
  });

  it('cannot review an article cut at the size limit', () => {
    expect(policy([htmlPage('/a', articleHtml(), true)], [entry('/a')]).outcome).toBe('error');
  });

  // v5.0: "dates are original". Re-dating an old story into the two-day
  // window is the abuse the window exists to prevent.
  it('fails an article the feed dates days away from its own date', () => {
    const observation = policy(
      [htmlPage('/a', articleHtml({ published: '2026-08-01T09:00:00Z' }))],
      [entry('/a', { publicationDate: hoursBefore(2) })],
    );
    expect(observation.outcome).toBe('fail');
    expect(observation.data).toMatchObject({
      redated: [{ url: `${ORIGIN}/a`, page: '2026-08-01T09:00:00Z' }],
    });
  });

  it('allows the feed and the page a day between them, and a date-only feed its whole day', () => {
    const page = htmlPage('/a', articleHtml({ published: '2026-09-13T23:30:00-05:00' }));
    expect(policy([page], [entry('/a', { publicationDate: hoursBefore(10) })]).outcome).toBe('pass');
    expect(policy([page], [entry('/a', { publicationDate: '2026-09-14' })]).outcome).toBe('pass');
  });

  it('holds an article with no date for the review', () => {
    const observation = policy([htmlPage('/a', articleHtml({ published: null }))], [entry('/a')]);
    expect(observation.outcome).toBe('warn');
    expect(observation.summary).toMatch(/carry no date/);
  });

  it('holds a site that says nowhere who publishes it or how to reach them', () => {
    const bare = htmlPage('/a', articleHtml({ footer: '', publisher: false }));
    const observation = policy([bare], [entry('/a')]);
    expect(observation.outcome).toBe('warn');
    expect(observation.summary).toMatch(/contact page/);
    expect(observation.summary).toMatch(/about page/);
  });

  it("finds the publisher on any crawled page, the home page's footer included", () => {
    const bare = htmlPage('/a', articleHtml({ footer: '', publisher: false }));
    const home = htmlPage(
      '/',
      '<html><body><a href="mailto:desk@news.example">Tips</a><a href="/masthead.html">Our staff</a></body></html>',
    );
    const observation = policy([home, bare], [entry('/a')]);
    expect(observation.outcome).toBe('pass');
  });

  // A front page is a list of headlines, and "about" in one is not an about page.
  it('does not take a headline for an about page', () => {
    const bare = htmlPage('/a', articleHtml({ footer: '<a href="/contact">Contact</a>', publisher: false }));
    const home = htmlPage(
      '/',
      '<html><body><a href="/2026/09/14/about-time">What we know about the storm</a></body></html>',
    );
    const observation = policy([home, bare], [entry('/a')]);
    expect(observation.outcome).toBe('warn');
    expect(observation.data).toMatchObject({ publisherFound: false, contactFound: true });
  });

  it('fails a page the site types as advertising that tells the reader nothing', () => {
    const paid = htmlPage('/a', articleHtml({ types: ['NewsArticle', 'AdvertiserContentArticle'] }));
    const observation = policy([paid], [entry('/a')]);
    expect(observation.outcome).toBe('fail');
    expect(observation.data).toMatchObject({
      undisclosed: [{ declared: 'typed AdvertiserContentArticle' }],
    });
  });

  it('fails a page filed under a sponsored section, and passes one that says so', () => {
    const path = '/sponsored/cloud-savings';
    expect(policy([htmlPage(path, articleHtml())], [entry(path)]).outcome).toBe('fail');

    const labelled = articleHtml({ body: '<p class="label">Paid post by Acme Cloud</p><p>Savings.</p>' });
    expect(policy([htmlPage(path, labelled)], [entry(path)]).outcome).toBe('pass');

    const french = articleHtml({ body: '<p>Publicité</p><p>Économies.</p>' });
    expect(policy([htmlPage('/partner-content/x', french)], [entry('/partner-content/x')]).outcome).toBe('pass');
  });

  it('does not take a slug for a sponsored section', () => {
    const path = '/2026/sponsored-by-nobody';
    expect(policy([htmlPage(path, articleHtml())], [entry(path)]).outcome).toBe('pass');
  });
});
