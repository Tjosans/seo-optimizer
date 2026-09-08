/**
 * Cancelling an audit that has already started crawling.
 *
 * Skipped unless DATABASE_URL is set: `npm run stack:up`, then copy
 * .env.example to .env.
 *
 * `scheduler.test.ts` covers cancelling one that never started, which never
 * touched the site at all. This is the harder half, and the claim is about
 * someone else's server: a cancelled audit stops asking for pages within one
 * request, rather than running out its page budget first. The crawl is paced
 * slowly on purpose, so "it stopped" and "it finished anyway" cannot be
 * confused for each other.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { loadCorpus } from '@seo/corpus';
import { audits, createDatabase, crawls, pages, sites } from '@seo/db';
import { AuditScheduler, PermanentAuditError } from '@seo/scheduler';
import type { CrawlBudget } from '@seo/scheduler';
import { startFixtureSite } from '@seo/testkit';
import type { FixtureSite } from '@seo/testkit';

const BUDGET: CrawlBudget = {
  userAgent: 'seo-optimizer/0.1 (+test)',
  maxPages: 20,
  maxDepth: 3,
};

const CORPUS = loadCorpus(fileURLToPath(new URL('../../../corpus/v4.4', import.meta.url)));

const corpus = (version: string) => {
  if (version !== CORPUS.version) throw new PermanentAuditError(`no corpus ${version} on disk`);
  return CORPUS;
};

let site: FixtureSite;

beforeAll(async () => {
  site = await startFixtureSite();
}, 30_000);

afterAll(async () => {
  await site.close();
});

const url = process.env['DATABASE_URL'];

describe.skipIf(!url)('cancelling an audit mid-crawl', () => {
  const handle = createDatabase(url ?? '', { max: 4 });
  const { db } = handle;

  let siteId: string;

  beforeAll(async () => {
    const [row] = await db
      .insert(sites)
      .values({ name: 'fixture-cancel', origin: site.origin, flags: ['hierarchical'] })
      .returning({ id: sites.id });
    siteId = row!.id;
  });

  afterAll(async () => {
    await db.delete(sites).where(eq(sites.origin, site.origin));
    await handle.close();
  });

  it('stops the crawl where it stands and keeps what it had already gathered', async () => {
    const scheduler = new AuditScheduler({ db, corpus, crawl: BUDGET });
    // Half a second between requests, so twenty pages would take ten seconds
    // and a crawl that ignored the signal could not possibly finish first.
    const submitted = await scheduler.submit({
      siteId,
      corpusVersion: '4.4',
      crawl: { requestDelayMs: 500 },
    });

    const crawled = async (): Promise<number> => {
      const [crawl] = await db.select().from(crawls).where(eq(crawls.auditId, submitted.auditId));
      if (crawl === undefined) return 0;
      return (await db.select().from(pages).where(eq(pages.crawlId, crawl.id))).length;
    };

    // Wait until it is demonstrably crawling, then stop it.
    const started = Date.now();
    while ((await crawled()) < 2) {
      if (Date.now() - started > 20_000) throw new Error('the crawl never got going');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(await scheduler.cancel(submitted.auditId)).toBe(true);
    await expect(submitted.done).rejects.toThrow(/cancelled/);

    const audit = await db.select().from(audits).where(eq(audits.id, submitted.auditId));
    expect(audit[0]?.status).toBe('cancelled');
    // Cancelled is not failed: nobody should be sent looking for a fault.
    expect(audit[0]?.error).toBeNull();

    const [crawl] = await db.select().from(crawls).where(eq(crawls.auditId, submitted.auditId));
    expect(crawl?.status).toBe('cancelled');
    expect(crawl?.error).toBeNull();

    // It stopped early, and the pages it had already fetched are still there.
    const fetched = await crawled();
    expect(fetched).toBeGreaterThan(0);
    expect(fetched).toBeLessThan(BUDGET.maxPages);

    await scheduler.close();
  }, 60_000);

  it('is not retried: someone stopping an audit is not a failure to repeat', async () => {
    const scheduler = new AuditScheduler({ db, corpus, crawl: BUDGET });
    const submitted = await scheduler.submit({
      siteId,
      corpusVersion: '4.4',
      crawl: { requestDelayMs: 500 },
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    await scheduler.cancel(submitted.auditId);
    await expect(submitted.done).rejects.toThrow(/cancelled/);
    await scheduler.drain();

    expect(scheduler.status(submitted.auditId)?.state).toBe('cancelled');
    expect(scheduler.queued).toBe(0);
    expect(scheduler.running).toBe(0);

    await scheduler.close();
  }, 60_000);
});
