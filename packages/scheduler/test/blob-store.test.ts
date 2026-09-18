/**
 * The scheduler with a configured `BlobStore`, against a live database, a
 * live MinIO and a live fixture site.
 *
 * Skipped unless both DATABASE_URL and STORAGE_ENDPOINT are set: `npm run
 * stack:up`, then copy .env.example to .env. Proves the seam from
 * `AuditSchedulerOptions.blobStore` down to `renders.bodyKey` end to end —
 * `scheduler.test.ts`'s own audit runs with no store, so `bodyKey` there
 * stays null by design.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { eq, inArray } from 'drizzle-orm';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { loadCorpus } from '@seo/corpus';
import { createDatabase, pages, renders, sites } from '@seo/db';
import { AuditScheduler, PermanentAuditError } from '@seo/scheduler';
import type { CrawlBudget } from '@seo/scheduler';
import { createBlobStore, storageConfigFromEnv } from '@seo/storage';
import type { BlobStore, S3StorageConfig } from '@seo/storage';
import { startFixtureSite } from '@seo/testkit';
import type { FixtureSite } from '@seo/testkit';

const BUDGET: CrawlBudget = {
  userAgent: 'seo-optimizer/0.1 (+test)',
  maxPages: 5,
  maxDepth: 1,
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

const dbUrl = process.env['DATABASE_URL'];
const storageEndpoint = process.env['STORAGE_ENDPOINT'];

describe.skipIf(!dbUrl || !storageEndpoint)('the audit scheduler with a blob store', () => {
  const handle = createDatabase(dbUrl ?? '', { max: 4 });
  const { db } = handle;

  let siteId: string;
  let blobStore: BlobStore;

  beforeAll(async () => {
    const config: S3StorageConfig = storageConfigFromEnv();
    const client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
    try {
      await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
    } catch (cause) {
      const name = typeof cause === 'object' && cause !== null ? (cause as { name?: string }).name : undefined;
      if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw cause;
    }
    blobStore = createBlobStore(config);

    const [row] = await db
      .insert(sites)
      .values({ name: 'fixture-blob', origin: site.origin, flags: [], profileCorpusVersion: '4.4' })
      .returning({ id: sites.id });
    siteId = row!.id;
  });

  afterAll(async () => {
    await db.delete(sites).where(eq(sites.origin, site.origin));
    await handle.close();
  });

  it('uploads each page body and records the key on renders.bodyKey', async () => {
    const scheduler = new AuditScheduler({ db, corpus, crawl: BUDGET, blobStore });
    const submitted = await scheduler.submit({ siteId, corpusVersion: '4.4' });
    const outcome = await submitted.done;

    expect(outcome.pagesCrawled).toBeGreaterThan(0);

    const pageRows = await db.select({ id: pages.id }).from(pages).where(eq(pages.crawlId, outcome.crawlId));
    expect(pageRows.length).toBe(outcome.pagesCrawled);

    const renderRows = await db
      .select()
      .from(renders)
      .where(inArray(renders.pageId, pageRows.map((p) => p.id)));
    expect(renderRows.length).toBeGreaterThan(0);
    for (const render of renderRows) {
      expect(render.bodyKey).not.toBeNull();
      const bytes = await blobStore.get(render.bodyKey!);
      expect(bytes).not.toBeNull();
    }

    await scheduler.close();
  }, 60_000);
});
