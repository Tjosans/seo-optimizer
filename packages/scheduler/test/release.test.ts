/**
 * Submitting an audit of a named release.
 *
 * Skipped unless DATABASE_URL is set: `npm run stack:up`, then copy
 * .env.example to .env.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { loadCorpus } from '@seo/corpus';
import { audits, createDatabase, sites } from '@seo/db';
import { UnknownReleaseError, saveRelease } from '@seo/grader';
import { AuditScheduler, PermanentAuditError } from '@seo/scheduler';
import type { CrawlBudget } from '@seo/scheduler';
import { startFixtureSite } from '@seo/testkit';
import type { FixtureSite } from '@seo/testkit';

const BUDGET: CrawlBudget = {
  userAgent: 'seo-optimizer/0.1 (+test)',
  maxPages: 5,
  maxDepth: 1,
};

const CORPUS = loadCorpus(fileURLToPath(new URL('../../../corpus/v5.0', import.meta.url)));

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

describe.skipIf(!url)('an audit of a named release', () => {
  const handle = createDatabase(url ?? '', { max: 4 });
  const { db } = handle;
  let siteId: string;

  beforeAll(async () => {
    await db.delete(sites).where(eq(sites.origin, site.origin));
    const [row] = await db
      .insert(sites)
      .values({ name: 'fixture-release', origin: site.origin })
      .returning({ id: sites.id });
    siteId = row!.id;
  });

  afterAll(async () => {
    await db.delete(sites).where(eq(sites.origin, site.origin));
    await handle.close();
  });

  it('links the audit to the release and freezes its cutover assessment', async () => {
    const releaseId = await saveRelease(db, siteId, { releaseId: '2026.09' });

    const scheduler = new AuditScheduler({ db, corpus, crawl: BUDGET });
    const submitted = await scheduler.submit({
      siteId,
      corpusVersion: '5.0',
      release: '2026.09',
    });
    await submitted.done;
    await scheduler.close();

    const [audit] = await db.select().from(audits).where(eq(audits.id, submitted.auditId));
    expect(audit?.releaseId).toBe(releaseId);
    // A release with nothing filled in holds on every blank field.
    expect(audit?.readiness).toMatchObject({
      cutover: { cutover: 'HOLD', final: 'HOLD', inputErrors: 0 },
    });
  }, 60_000);

  it('refuses a release the site does not have, before writing an audit', async () => {
    const before = await db.select().from(audits).where(eq(audits.siteId, siteId));

    const scheduler = new AuditScheduler({ db, corpus, crawl: BUDGET });
    await expect(
      scheduler.submit({ siteId, corpusVersion: '5.0', release: 'nope' }),
    ).rejects.toBeInstanceOf(UnknownReleaseError);
    await scheduler.close();

    const after = await db.select().from(audits).where(eq(audits.siteId, siteId));
    expect(after).toHaveLength(before.length);
  });
});
