import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crawl, createSitemapParser, extractSitemapUrls, fetchPage } from '@seo/crawler';

const VIDEO_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
  <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
          xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">
    <url>
      <loc>https://example.com/watch/one</loc>
      <video:video>
        <video:thumbnail_loc>https://example.com/t/one.jpg</video:thumbnail_loc>
        <video:title>One &amp; only</video:title>
        <video:description><![CDATA[The <first> one.]]></video:description>
        <video:content_loc>https://example.com/m/one.mp4</video:content_loc>
      </video:video>
    </url>
    <url>
      <loc>https://example.com/watch/two</loc>
      <video:video>
        <video:thumbnail_loc>https://example.com/t/two.jpg</video:thumbnail_loc>
        <video:title>Two</video:title>
        <video:description>The second one.</video:description>
        <video:player_loc>https://example.com/p/two</video:player_loc>
      </video:video>
    </url>
    <url><loc>https://example.com/about</loc></url>
  </urlset>`;

describe('the sitemap parser, fed as the bytes arrive', () => {
  // Chunk boundaries fall wherever the network put them: mid-tag, mid-entity,
  // mid-CDATA. The list that comes out must not depend on where they fell.
  it('reads the same entries however the document is split', () => {
    const whole = extractSitemapUrls(VIDEO_SITEMAP);
    for (const size of [1, 3, 7, 64]) {
      const parser = createSitemapParser();
      for (let i = 0; i < VIDEO_SITEMAP.length; i += size) parser.write(VIDEO_SITEMAP.slice(i, i + size));
      expect(parser.end(true), `chunks of ${size}`).toEqual(whole);
    }
    expect(whole.urls).toHaveLength(3);
    expect(whole.videos.map((video) => video.title)).toEqual(['One & only', 'Two']);
    expect(whole.videos[0]?.description).toBe('The <first> one.');
    expect(whole.videos[1]).toMatchObject({ contentUrl: null, playerUrl: 'https://example.com/p/two' });
  });

  it('reads a sitemap index as a list of sitemaps, not of pages', () => {
    const parsed = extractSitemapUrls(
      '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
        '<sitemap><loc> https://example.com/a.xml </loc></sitemap>' +
        '<sitemap><loc>https://example.com/b.xml</loc><lastmod>2026-09-01</lastmod></sitemap>' +
        '</sitemapindex>',
    );
    expect(parsed.sitemaps).toEqual(['https://example.com/a.xml', 'https://example.com/b.xml']);
    expect(parsed.urls).toEqual([]);
  });

  // A severed entry reads exactly like one the site wrote without its last
  // fields, or with half a URL in its <loc>. Only the cut can tell them apart,
  // so a document that stopped short keeps what closed and drops what did not.
  it('drops the entry a cut severed, and keeps every entry before it', () => {
    const cutAt = VIDEO_SITEMAP.indexOf('<video:description>The second');
    const parser = createSitemapParser();
    parser.write(VIDEO_SITEMAP.slice(0, cutAt));
    const parsed = parser.end(false);

    expect(parsed.videos.map((video) => video.loc)).toEqual(['https://example.com/watch/one']);
    expect(parsed.videos[0]?.description).toBe('The <first> one.');
  });

  it('does not add half a URL to the crawl frontier', () => {
    const cutAt = VIDEO_SITEMAP.indexOf('/about') + 3;
    const parser = createSitemapParser();
    parser.write(VIDEO_SITEMAP.slice(0, cutAt));
    const parsed = parser.end(false);

    expect(parsed.urls).toEqual(['https://example.com/watch/one', 'https://example.com/watch/two']);
  });

  it('keeps an entry closed by the markup itself when the document is whole', () => {
    // Unclosed <url> at the end of a complete document: the site's defect, and
    // the entry is as the site wrote it.
    const parsed = extractSitemapUrls(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/</loc>',
    );
    expect(parsed.urls).toEqual(['https://example.com/']);
  });
});

// --- a sitemap larger than a page is allowed to be ---------------------------

/**
 * The shape IGN has: a quarterly video sitemap of several megabytes, every
 * entry complete. Past the 5 MB page limit, it was cut, read as unobservable,
 * and left 2.14 and 2.1 ungraded.
 */
const ENTRIES = 16_000;

const entry = (i: number): string =>
  '<url>' +
  `<loc>https://videos.test/watch/${i}</loc>` +
  '<video:video>' +
  `<video:thumbnail_loc>https://videos.test/thumbs/${i}.jpg</video:thumbnail_loc>` +
  `<video:title>Episode ${i}: a title of an ordinary length for a video</video:title>` +
  `<video:description>A description of episode ${i}, long enough to look like the ones sites actually write.</video:description>` +
  `<video:content_loc>https://videos.test/media/${i}.mp4</video:content_loc>` +
  '<video:duration>600</video:duration>' +
  '</video:video>' +
  '</url>\n';

const BIG_SITEMAP =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" ' +
  'xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">\n' +
  Array.from({ length: ENTRIES }, (_, i) => entry(i)).join('') +
  '</urlset>\n';

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/robots.txt') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap-videos.xml\n`);
      return;
    }
    if (request.url === '/sitemap-videos.xml') {
      response.writeHead(200, { 'content-type': 'application/xml' });
      // Written in pieces, as a real server would, so the client reads it as a
      // stream of chunks rather than one buffer.
      const bytes = Buffer.from(BIG_SITEMAP);
      for (let i = 0; i < bytes.length; i += 256_000) response.write(bytes.subarray(i, i + 256_000));
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html><body><p>home</p></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('a video sitemap larger than the page body limit', () => {
  it('is larger than a page may be', () => {
    expect(Buffer.byteLength(BIG_SITEMAP)).toBeGreaterThan(5_000_000);
  });

  it('is read to the end, every entry whole', async () => {
    const result = await crawl({
      seeds: [`${origin}/`],
      userAgent: 'seo-optimizer/0.1 (+test)',
      maxPages: 1,
      maxDepth: 0,
      auxiliary: false,
    });

    expect(result.sitemaps).toEqual([
      { url: `${origin}/sitemap-videos.xml`, status: 200, urlCount: ENTRIES, videoCount: ENTRIES, truncated: false },
    ]);
    expect(result.sitemapVideos).toHaveLength(ENTRIES);
    expect(result.sitemapVideos.at(-1)?.loc).toBe(`https://videos.test/watch/${ENTRIES - 1}`);
    expect(result.sitemapVideos.every((video) => video.title !== null && video.description !== null)).toBe(true);
  });

  it('streams its body rather than returning it', async () => {
    let streamed = '';
    const result = await fetchPage(`${origin}/sitemap-videos.xml`, {
      userAgent: 'seo-optimizer/0.1 (+test)',
      maxBytes: 52_428_800,
      onText: (chunk) => { streamed += chunk; },
    });
    expect(result.body).toBe('');
    expect(result.truncated).toBe(false);
    expect(streamed).toBe(BIG_SITEMAP);
  });

  // The limit stops the read where it stands: the rest of the response is
  // cancelled, not downloaded to be thrown away.
  it('stops reading at the limit, and says it was cut', async () => {
    const parser = createSitemapParser();
    let streamed = 0;
    const result = await fetchPage(`${origin}/sitemap-videos.xml`, {
      userAgent: 'seo-optimizer/0.1 (+test)',
      maxBytes: 100_000,
      onText: (chunk) => {
        streamed += chunk.length;
        parser.write(chunk);
      },
    });
    const parsed = parser.end(!result.truncated);

    expect(result.truncated).toBe(true);
    expect(streamed).toBeLessThanOrEqual(100_000);
    expect(result.byteLength).toBeLessThan(Buffer.byteLength(BIG_SITEMAP));
    expect(parsed.videos.length).toBeGreaterThan(0);
    expect(parsed.videos.length).toBeLessThan(ENTRIES);
    expect(parsed.videos.every((video) => video.contentUrl !== null)).toBe(true);
  });
});
