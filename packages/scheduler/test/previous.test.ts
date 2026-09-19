/**
 * A second audit of a site reads the first one back as `SiteContext.previous`.
 *
 * Skipped unless DATABASE_URL is set: `npm run stack:up`, then copy
 * .env.example to .env.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { loadCorpus } from '@seo/corpus';
import { createDatabase, sites } from '@seo/db';
import { AuditScheduler, PermanentAuditError, loadPreviousAudit } from '@seo/scheduler';
import type { CrawlBudget } from '@seo/scheduler';
import { startFixtureSite } from '@seo/testkit';
import type { FixtureSite } from '@seo/testkit';

const BUDGET: CrawlBudget = { userAgent: 'seo-optimizer/0.1 (+test)', maxPages: 5, maxDepth: 1 };
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

describe.skipIf(!url)('loadPreviousAudit', () => {
  const handle = createDatabase(url ?? '', { max: 4 });
  const { db } = handle;

  afterAll(async () => {
    await db.delete(sites).where(eq(sites.origin, site.origin));
    await handle.close();
  });

  it('is null for a site with no earlier completed audit, then rebuilds the first from its rows', async () => {
    await db.delete(sites).where(eq(sites.origin, site.origin));
    const [row] = await db
      .insert(sites)
      .values({ name: 'fixture-previous', origin: site.origin, flags: [] })
      .returning({ id: sites.id });
    const siteId = row!.id;

    const scheduler = new AuditScheduler({ db, corpus, crawl: BUDGET });
    const first = await scheduler.submit({ siteId, corpusVersion: '4.4' });
    await first.done;
    expect(
      await loadPreviousAudit(db, { siteId, origin: site.origin, excludeAuditId: first.auditId }),
    ).toBeNull();

    const second = await scheduler.submit({ siteId, corpusVersion: '4.4' });
    await second.done;
    await scheduler.close();

    const previous = await loadPreviousAudit(db, {
      siteId,
      origin: site.origin,
      excludeAuditId: second.auditId,
    });
    expect(previous?.pages.length).toBeGreaterThan(0);
    expect(previous?.pages.some((page) => page.status === 200 && page.title !== null)).toBe(true);
    expect(previous?.probes.length).toBeGreaterThan(0);
  }, 90_000);
});
