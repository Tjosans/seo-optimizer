/**
 * A site profile the pinned corpus cannot read.
 *
 * Skipped unless DATABASE_URL is set: `npm run stack:up`, then copy
 * .env.example to .env.
 *
 * The failure this prevents is a quiet one. `resolveScope` reads a filled-in
 * profile as a statement, so a flag no check recognises does not go unmatched
 * and unnoticed — it narrows every check that flag was meant to bring into
 * scope, each with a written rationale that reads like a decision somebody
 * made. A misspelt flag would therefore excuse launch gates and explain itself
 * confidently while doing it. So it stops the audit instead, before the crawl.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { loadCorpus } from '@seo/corpus';
import { audits, crawls, createDatabase, sites } from '@seo/db';
import { AuditScheduler, PermanentAuditError } from '@seo/scheduler';
import type { CrawlBudget } from '@seo/scheduler';
import { startFixtureSite } from '@seo/testkit';
import type { FixtureSite } from '@seo/testkit';

const BUDGET: CrawlBudget = {
  userAgent: 'seo-optimizer/0.1 (+test)',
  maxPages: 10,
  maxDepth: 2,
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

describe.skipIf(!url)('a site profile the corpus does not recognise', () => {
  const handle = createDatabase(url ?? '', { max: 4 });
  const { db } = handle;

  afterAll(async () => {
    await db.delete(sites).where(eq(sites.origin, site.origin));
    await handle.close();
  });

  const siteWith = async (flags: readonly string[]): Promise<string> => {
    await db.delete(sites).where(eq(sites.origin, site.origin));
    const [row] = await db
      .insert(sites)
      .values({ name: 'fixture-flags', origin: site.origin, flags: [...flags] })
      .returning({ id: sites.id });
    return row!.id;
  };

  it('fails the audit before a single request goes out', async () => {
    const siteId = await siteWith(['ecommmerce']); // one m too many
    const scheduler = new AuditScheduler({ db, corpus, crawl: BUDGET, retry: false });
    const submitted = await scheduler.submit({ siteId, corpusVersion: '4.4' });

    await expect(submitted.done).rejects.toThrow(/does not recognise: ecommmerce/);

    const [audit] = await db.select().from(audits).where(eq(audits.id, submitted.auditId));
    expect(audit?.status).toBe('failed');
    expect(audit?.error).toMatch(/ecommmerce/);

    // Nothing was crawled: the check happens beside the corpus version check,
    // before any of the site's bandwidth is spent.
    expect(await db.select().from(crawls).where(eq(crawls.auditId, submitted.auditId))).toEqual(
      [],
    );

    await scheduler.close();
  }, 30_000);

  it('is not retried, since the profile will read the same next time', async () => {
    const siteId = await siteWith(['not-a-real-flag']);
    // The real default policy, not `retry: false` — the point is that the
    // policy itself declines to repeat this.
    const scheduler = new AuditScheduler({ db, corpus, crawl: BUDGET });
    const submitted = await scheduler.submit({ siteId, corpusVersion: '4.4' });

    await expect(submitted.done).rejects.toThrow(/not-a-real-flag/);
    await scheduler.drain();

    const status = scheduler.status(submitted.auditId);
    expect(status?.state).toBe('failed');
    expect(status?.attempt).toBe(1);

    await scheduler.close();
  }, 30_000);

  it('lets a profile the corpus does recognise straight through', async () => {
    const siteId = await siteWith(['ecommerce', 'hierarchical']);
    const scheduler = new AuditScheduler({ db, corpus, crawl: BUDGET });
    const submitted = await scheduler.submit({ siteId, corpusVersion: '4.4' });

    const outcome = await submitted.done;
    expect(outcome.pagesCrawled).toBeGreaterThan(0);

    await scheduler.close();
  }, 60_000);
});
