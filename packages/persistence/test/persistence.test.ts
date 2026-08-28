import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { crawl, extract, parseRobots } from '@seo/crawler';
import type { CrawlOptions, CrawlResult, CrawledPage, FetchResult } from '@seo/crawler';
import {
  audits,
  crawls,
  createDatabase,
  pageLinks,
  pages,
  probeResults,
  renders,
  sites,
} from '@seo/db';
import { runProbes } from '@seo/probes';
import type { ProbeRun, SiteContext } from '@seo/probes';
import {
  crawlToDatabase,
  persistProbeRuns,
  toCrawlCompletion,
  toPageLinkRows,
  toPageRow,
  toRenderRow,
} from '@seo/persistence';
import { startFixtureSite } from '@seo/testkit';
import type { FixtureSite } from '@seo/testkit';

let site: FixtureSite;
let options: CrawlOptions;
let result: CrawlResult;

beforeAll(async () => {
  site = await startFixtureSite();
  options = {
    seeds: [`${site.origin}/`, `${site.origin}/old`],
    userAgent: 'seo-optimizer/0.1 (+test)',
    maxPages: 50,
    maxDepth: 3,
  };
  result = await crawl(options);
}, 30_000);

afterAll(async () => {
  await site.close();
});

const crawled = (path: string): CrawledPage => {
  const page = result.pages.find((c) => c.normalizedUrl === `${site.origin}${path}`);
  if (page === undefined) throw new Error(`${path} was not crawled`);
  return page;
};

/** A page assembled by hand, for markup the fixture site does not serve. */
const synthetic = (html: string, url = 'https://example.test/a'): CrawledPage => {
  const fetch: FetchResult = {
    requestedUrl: url,
    finalUrl: url,
    status: 200,
    headers: { 'content-type': 'text/html' },
    redirectChain: [],
    body: html,
    byteLength: Buffer.byteLength(html),
    contentType: 'text/html',
    ttfbMs: 1,
    totalMs: 2,
    error: null,
  };
  return {
    url,
    normalizedUrl: url,
    depth: 0,
    discoveredFrom: null,
    fetch,
    extracted: extract(html, url),
  };
};

describe('mapping a crawled page to rows', () => {
  it('records the status the chain ended on, and the chain that got there', () => {
    const row = toPageRow({
      id: 'p1',
      crawlId: 'c1',
      page: crawled('/old'),
      discoveredFromId: null,
    });
    expect(row.status).toBe(200);
    expect(row.url).toBe(`${site.origin}/old`);
    expect(row.redirectChain).toHaveLength(2);
  });

  it('leaves size and headers null when nothing was received', () => {
    const page = crawled('/');
    const dead: CrawledPage = {
      ...page,
      fetch: {
        ...page.fetch,
        status: null,
        error: 'timeout after 15000ms',
        headers: {},
        byteLength: 0,
      },
      extracted: null,
    };
    const row = toPageRow({ id: 'p1', crawlId: 'c1', page: dead, discoveredFromId: null });
    expect(row.contentLength).toBeNull();
    expect(row.headers).toBeNull();
    expect(row.fetchError).toContain('timeout');
    // Nothing was captured, so there is no representation to store.
    expect(toRenderRow({ id: 'r1', pageId: 'p1', page: dead })).toBeNull();
  });

  it('keeps the extracted signals but not the page text', () => {
    const row = toRenderRow({ id: 'r1', pageId: 'p1', page: crawled('/') });
    const extracted = row?.extracted as Record<string, unknown>;
    expect(row?.mode).toBe('raw');
    expect(extracted['title']).toBe('Home | Fixture');
    expect(extracted).not.toHaveProperty('text');
    // The fingerprint survives, which is what a parity check compares.
    expect(row?.textHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.bodyHash).not.toBe(row?.textHash);
  });

  it('emits one redirect edge per chain rather than one per hop', () => {
    const rows = toPageLinkRows({ crawlId: 'c1', fromPageId: 'p1', page: crawled('/old') });
    const redirects = rows.filter((row) => row.kind === 'redirect');
    expect(redirects).toHaveLength(1);
    expect(redirects[0]?.toNormalizedUrl).toBe(`${site.origin}/new`);
  });

  it('classifies the edges a page declares, and skips what is not a page', () => {
    const page = synthetic(`<!doctype html><html><head>
      <link rel="canonical" href="https://example.test/a">
      <link rel="alternate" hreflang="de-DE" href="https://example.test/de/a">
      </head><body>
      <a href="/b">B</a>
      <a href="/page/2" rel="next">Next</a>
      <a href="/c" rel="nofollow">C</a>
      <a href="mailto:hi@example.test">Mail</a>
      </body></html>`);
    const rows = toPageLinkRows({ crawlId: 'c1', fromPageId: 'p1', page });
    const kinds = rows.map((row) => row.kind);

    expect(kinds).toContain('canonical');
    expect(kinds).toContain('pagination');
    expect(kinds).toContain('hreflang');
    // A mailto: is a link but not an edge in a page graph.
    expect(rows.some((row) => row.toUrl.startsWith('mailto:'))).toBe(false);
    expect(rows.find((row) => row.kind === 'hreflang')?.anchorText).toBe('de-DE');
    expect(rows.find((row) => row.toNormalizedUrl.endsWith('/c'))?.nofollow).toBe(true);
  });

  it('records the politeness delay actually applied, not the one configured', () => {
    const slow: CrawlResult = {
      ...result,
      robots: parseRobots('User-agent: *\nCrawl-delay: 2\n'),
    };
    expect(toCrawlCompletion(slow, options).requestDelayMs).toBe(2000);
    expect(toCrawlCompletion(result, options).requestDelayMs).toBe(0);
  });
});

/**
 * The round trip. Skipped unless DATABASE_URL is set: `docker compose up -d
 * --wait`, then copy .env.example to .env.
 */
const url = process.env['DATABASE_URL'];

describe.skipIf(!url)('persisting a crawl and its observations', () => {
  const handle = createDatabase(url ?? '', { max: 2 });
  const { db } = handle;

  let auditId: string;
  let crawlId: string;
  let runs: ProbeRun[];

  beforeAll(async () => {
    const [row] = await db
      .insert(sites)
      .values({ name: 'fixture', origin: site.origin })
      .returning();
    const [audit] = await db
      .insert(audits)
      .values({ siteId: row!.id, corpusVersion: '4.4' })
      .returning();
    auditId = audit!.id;

    const persisted = await crawlToDatabase(db, { auditId, options });
    crawlId = persisted.crawlId;

    const context: SiteContext = {
      origin: site.origin,
      crawl: persisted.result,
      flags: ['hierarchical'],
    };
    runs = runProbes(context);
    await persistProbeRuns(db, { auditId, crawlId, runs, pageIds: persisted.pageIds });
  }, 60_000);

  afterAll(async () => {
    await db.delete(sites).where(eq(sites.origin, site.origin));
    await handle.close();
  });

  const pageId = async (path: string): Promise<string> => {
    const [row] = await db
      .select({ id: pages.id })
      .from(pages)
      .where(
        and(eq(pages.crawlId, crawlId), eq(pages.normalizedUrl, `${site.origin}${path}`)),
      );
    if (row === undefined) throw new Error(`${path} has no row`);
    return row.id;
  };

  it('closes the crawl out with the robots.txt it was given', async () => {
    const [row] = await db.select().from(crawls).where(eq(crawls.id, crawlId));
    expect(row?.status).toBe('complete');
    expect(row?.robotsTxt).toContain('Disallow: /private/');
    expect(row?.finishedAt).toBeInstanceOf(Date);
  });

  it('keeps every seed, in the order that decided what is off-site', async () => {
    const [row] = await db.select().from(crawls).where(eq(crawls.id, crawlId));
    expect(row?.seedUrls).toEqual([`${site.origin}/`, `${site.origin}/old`]);
  });

  it('freezes what the sitemap declared at crawl time', async () => {
    const [row] = await db.select().from(crawls).where(eq(crawls.id, crawlId));
    expect(row?.sitemapUrls).toEqual([...result.sitemapUrls]);
    // The orphan probe reads this: a URL only the sitemap knows about.
    expect(row?.sitemapUrls).toContain(`${site.origin}/orphan`);
  });

  it('writes every page the crawl reached, exactly once', async () => {
    const rows = await db.select().from(pages).where(eq(pages.crawlId, crawlId));
    expect(rows).toHaveLength(result.pages.length);
    expect(new Set(rows.map((row) => row.normalizedUrl)).size).toBe(rows.length);
  });

  it('remembers which page a URL was first found on', async () => {
    const row = async (path: string) => {
      const [found] = await db
        .select()
        .from(pages)
        .where(
          and(eq(pages.crawlId, crawlId), eq(pages.normalizedUrl, `${site.origin}${path}`)),
        );
      return found;
    };

    // Only linked from the home page, so that is where it was first seen.
    expect((await row('/deep/one'))?.discoveredFromId).toBe(await pageId('/'));
    // A seed was discovered from nowhere...
    expect((await row('/'))?.discoveredFromId).toBeNull();
    // ...and so is a URL the sitemap declares, even though pages also link to
    // it: the sitemap is queued alongside the seeds, before any page is read.
    expect((await row('/about'))?.discoveredFromId).toBeNull();
  });

  it('resolves an edge to a page that was fetched', async () => {
    const rows = await db
      .select()
      .from(pageLinks)
      .where(
        and(
          eq(pageLinks.fromPageId, await pageId('/about')),
          eq(pageLinks.toNormalizedUrl, `${site.origin}/gone`),
        ),
      );
    expect(rows[0]?.toPageId).toBe(await pageId('/gone'));
  });

  it('leaves an edge unresolved when robots.txt kept the target unfetched', async () => {
    const rows = await db
      .select()
      .from(pageLinks)
      .where(
        and(
          eq(pageLinks.crawlId, crawlId),
          eq(pageLinks.toNormalizedUrl, `${site.origin}/private/secret`),
        ),
      );
    expect(rows.length).toBeGreaterThan(0);
    // The unresolved edge is the finding, not a row to be dropped.
    expect(rows[0]?.toPageId).toBeNull();
    expect(result.blockedByRobots).toContain(`${site.origin}/private/secret`);
  });

  it('captures one representation per HTML page', async () => {
    const rows = await db
      .select({ id: renders.id, mode: renders.mode })
      .from(renders)
      .innerJoin(pages, eq(pages.id, renders.pageId))
      .where(eq(pages.crawlId, crawlId));
    const html = result.pages.filter((page) => page.extracted !== null);
    expect(rows).toHaveLength(html.length);
    expect(new Set(rows.map((row) => row.mode))).toEqual(new Set(['raw']));
  });

  it('files every observation, page-scoped ones against their page', async () => {
    const rows = await db
      .select()
      .from(probeResults)
      .where(eq(probeResults.auditId, auditId));
    expect(rows).toHaveLength(runs.length);

    const paged = rows.filter((row) => row.scope === 'page');
    expect(paged.length).toBeGreaterThan(0);
    expect(paged.every((row) => row.pageId !== null)).toBe(true);
    expect(rows.filter((row) => row.scope === 'site').every((row) => row.pageId === null)).toBe(
      true,
    );

    const [status] = await db
      .select()
      .from(probeResults)
      .where(
        and(
          eq(probeResults.auditId, auditId),
          eq(probeResults.probeId, 'http-status'),
          eq(probeResults.pageId, await pageId('/gone')),
        ),
      );
    expect(status?.outcome).toBe('fail');
  });

  it('refuses an observation about a page this crawl never saw', async () => {
    const stray: ProbeRun = {
      probeId: 'http-status',
      scope: 'page',
      pageUrl: 'https://elsewhere.test/',
      observation: { outcome: 'fail', summary: 'from a different crawl' },
    };
    await expect(
      persistProbeRuns(db, { auditId, crawlId, runs: [stray] }),
    ).rejects.toThrow(/has no row in this crawl/);
  });
});
