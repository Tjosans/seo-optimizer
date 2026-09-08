import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crawl, extract, extractSitemapUrls, fetchPage } from '@seo/crawler';
import type { CrawlResult } from '@seo/crawler';
import { startFixtureSite } from '@seo/testkit';
import type { FixtureSite } from '@seo/testkit';

let site: FixtureSite;
let result: CrawlResult;

beforeAll(async () => {
  site = await startFixtureSite();
  result = await crawl({
    seeds: [`${site.origin}/`, `${site.origin}/old`, `${site.origin}/soft-404`],
    userAgent: 'seo-optimizer/0.1 (+test)',
    maxPages: 50,
    maxDepth: 3,
  });
}, 30_000);

afterAll(async () => {
  await site.close();
});

const page = (path: string) =>
  result.pages.find((candidate) => candidate.normalizedUrl === `${site.origin}${path}`);

describe('crawl', () => {
  it('reaches the pages linked from the seeds', () => {
    for (const path of ['/', '/about', '/about-us', '/deep/one', '/new']) {
      expect(page(path), path).toBeDefined();
    }
  });

  it('adds sitemap URLs that nothing links to', () => {
    expect(result.sitemapUrls).toContain(`${site.origin}/orphan`);
    expect(page('/orphan')).toBeDefined();
  });

  it('records each sitemap document it read, and what was in it', () => {
    const document = result.sitemaps.find((entry) => entry.url === `${site.origin}/sitemap.xml`);
    expect(document?.status).toBe(200);
    expect(document?.urlCount).toBeGreaterThan(0);
    expect(document?.videoCount).toBe(0);
  });

  it('records the whole redirect chain rather than only the destination', () => {
    const redirected = page('/old');
    expect(redirected?.fetch.status).toBe(200);
    expect(redirected?.fetch.finalUrl).toBe(`${site.origin}/new`);
    expect(redirected?.fetch.redirectChain.map((hop) => hop.status)).toEqual([301, 301]);
  });

  it('refuses to fetch what robots.txt disallows, even when it is linked', () => {
    expect(result.blockedByRobots).toContain(`${site.origin}/private/secret`);
    expect(site.requests).not.toContain('/private/secret');
    expect(result.robots.sitemaps).toEqual([`${site.origin}/sitemap.xml`]);
  });

  it('fetches the same disallowed URL once robots is switched off', async () => {
    const ignoring = await crawl({
      seeds: [`${site.origin}/private/secret`],
      userAgent: 'seo-optimizer/0.1 (+test)',
      maxPages: 1,
      maxDepth: 0,
      respectRobots: false,
      followSitemaps: false,
    });
    expect(ignoring.pages[0]?.fetch.status).toBe(200);
  });

  it('tracks depth from the seed', () => {
    expect(page('/')?.depth).toBe(0);
    expect(page('/deep/one')?.depth).toBe(1);
  });

  it('stops at the page budget', async () => {
    const limited = await crawl({
      seeds: [`${site.origin}/`],
      userAgent: 'seo-optimizer/0.1 (+test)',
      maxPages: 2,
      maxDepth: 3,
    });
    expect(limited.pages).toHaveLength(2);
    expect(limited.notReached.length).toBeGreaterThan(0);
  });

  it('reports a fetch failure as data instead of throwing', async () => {
    const dead = await crawl({
      // Port 1 is reserved and refuses connections on every platform.
      seeds: ['http://127.0.0.1:1/'],
      userAgent: 'seo-optimizer/0.1 (+test)',
      maxPages: 1,
      maxDepth: 0,
      followSitemaps: false,
      respectRobots: false,
      timeoutMs: 2_000,
    });
    expect(dead.pages[0]?.fetch.error).not.toBeNull();
    expect(dead.pages[0]?.fetch.status).toBeNull();
  });
});

describe('extract', () => {
  it('reads the head signals a report is built from', () => {
    const home = page('/');
    expect(home?.extracted?.title).toBe('Home | Fixture');
    expect(home?.extracted?.canonical).toBe(`${site.origin}/`);
    expect(home?.extracted?.lang).toBe('en');
    expect(home?.extracted?.hasViewportMeta).toBe(true);
    expect(home?.extracted?.openGraph['og:title']).toBe('Home | Fixture');
  });

  it('resolves links and images against the document', () => {
    const home = page('/');
    expect(home?.extracted?.links.map((link) => link.url)).toContain(`${site.origin}/about`);
    expect(home?.extracted?.images[0]?.alt).toBe('A hero image');
    expect(home?.extracted?.images[0]?.width).toBe('800');
  });

  it('honours a <base href> when resolving relative links', () => {
    const extracted = extract(
      '<html><head><base href="https://example.com/docs/"></head><body><a href="a">A</a></body></html>',
      'https://example.com/other/page',
    );
    expect(extracted.links[0]?.url).toBe('https://example.com/docs/a');
  });

  it('counts unparseable JSON-LD instead of dropping it', () => {
    const extracted = extract(
      '<html><body><script type="application/ld+json">{ nope }</script></body></html>',
      'https://example.com/',
    );
    expect(extracted.jsonLd).toHaveLength(0);
    expect(extracted.jsonLdErrors).toBe(1);
  });

  it('excludes script and style content from page text', () => {
    const extracted = extract(
      '<html><body><script>var hidden = 1;</script><p>Visible</p></body></html>',
      'https://example.com/',
    );
    expect(extracted.text).toBe('Visible');
    expect(extracted.wordCount).toBe(1);
  });
});

describe('sitemap video entries', () => {
  const VIDEO_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
            xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">
      <url>
        <loc>https://example.com/watch/one</loc>
        <video:video>
          <video:thumbnail_loc>https://example.com/t/one.jpg</video:thumbnail_loc>
          <video:title>One</video:title>
          <video:description>The first one.</video:description>
          <video:content_loc>https://example.com/m/one.mp4</video:content_loc>
        </video:video>
      </url>
      <url><loc>https://example.com/about</loc></url>
    </urlset>`;

  it('reads a video entry alongside the URL it belongs to', () => {
    const parsed = extractSitemapUrls(VIDEO_SITEMAP);
    expect(parsed.urls).toEqual(['https://example.com/watch/one', 'https://example.com/about']);
    expect(parsed.videos).toHaveLength(1);
    expect(parsed.videos[0]).toMatchObject({
      loc: 'https://example.com/watch/one',
      title: 'One',
      description: 'The first one.',
      thumbnailUrl: 'https://example.com/t/one.jpg',
      contentUrl: 'https://example.com/m/one.mp4',
      playerUrl: null,
    });
  });

  // The namespace URI is fixed and the prefix is whatever the author typed, so
  // a parser keyed to "video:" would read a valid sitemap as having no videos.
  it('reads an entry whatever prefix the sitemap binds the namespace to', () => {
    const parsed = extractSitemapUrls(
      VIDEO_SITEMAP.replaceAll('video:', 'vid:').replaceAll('xmlns:video=', 'xmlns:vid='),
    );
    expect(parsed.videos).toHaveLength(1);
    expect(parsed.videos[0]?.title).toBe('One');
  });

  it('reports a URL entry with no video extension as no video', () => {
    const parsed = extractSitemapUrls(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
        '<url><loc>https://example.com/</loc></url></urlset>',
    );
    expect(parsed.urls).toHaveLength(1);
    expect(parsed.videos).toHaveLength(0);
  });
});

describe('a body larger than the fetch budget', () => {
  // The cut is invisible in the parsed result — a severed element reads as an
  // element missing its last fields — so the flag is the only thing that keeps
  // a detector from reporting the crawler's own limit as the site's defect.
  it('is marked truncated, and reports the size it would have been', async () => {
    const result = await fetchPage(`${site.origin}/`, {
      userAgent: 'seo-optimizer/0.1 (+test)',
      maxBytes: 64,
    });
    expect(result.truncated).toBe(true);
    expect(result.body.length).toBeLessThanOrEqual(64);
    expect(result.byteLength).toBeGreaterThan(64);
  });

  it('is not marked truncated when the whole body fits', async () => {
    const result = await fetchPage(`${site.origin}/`, {
      userAgent: 'seo-optimizer/0.1 (+test)',
    });
    expect(result.truncated).toBe(false);
    expect(result.body.length).toBeGreaterThan(0);
  });
});
