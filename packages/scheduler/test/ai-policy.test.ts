/**
 * The AI crawler policy, from the site record to the probe that reads it.
 *
 * Skipped unless DATABASE_URL is set: `npm run stack:up`, then copy
 * .env.example to .env.
 *
 * The policy is the only input to check 2.9 that nothing can be derived from,
 * so what matters is that it survives the whole trip intact — column, job
 * payload, crawl options, `SiteContext` — and that a malformed one is refused
 * at the door rather than twenty minutes into someone else's bandwidth.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { loadCorpus } from '@seo/corpus';
import { audits, createDatabase, probeResults, sites } from '@seo/db';
import { AuditScheduler, PermanentAuditError } from '@seo/scheduler';
import type { CrawlBudget } from '@seo/scheduler';
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

const url = process.env['DATABASE_URL'];

describe.skipIf(!url)('an audit of a site with an AI crawler policy', () => {
  const handle = createDatabase(url ?? '', { max: 4 });
  const { db } = handle;

  afterAll(async () => {
    await db.delete(sites).where(eq(sites.origin, site.origin));
    await handle.close();
  });

  const siteWith = async (aiPolicy: unknown): Promise<string> => {
    await db.delete(sites).where(eq(sites.origin, site.origin));
    const [row] = await db
      .insert(sites)
      .values({
        name: 'fixture-ai',
        origin: site.origin,
        flags: ['ai-policy'],
        aiPolicy: aiPolicy as never,
      })
      .returning({ id: sites.id });
    return row!.id;
  };

  it('carries the policy to the probe, which grades against it', async () => {
    // The fixture's robots.txt has no GPTBot group and allows all, so a policy
    // that excludes GPTBot is one robots.txt does not express.
    const siteId = await siteWith({
      agents: { GPTBot: 'disallow' },
      approvedAt: '2026-09-01',
      approvedBy: 'legal@example.com',
    });

    const scheduler = new AuditScheduler({ db, corpus, crawl: BUDGET });
    const submitted = await scheduler.submit({ siteId, corpusVersion: '4.4' });
    await submitted.done;
    await scheduler.close();

    const rows = await db
      .select()
      .from(probeResults)
      .where(eq(probeResults.auditId, submitted.auditId));
    const ai = rows.find((row) => row.probeId === 'ai-crawler-directive-verify');
    expect(ai).toBeDefined();
    // robots.txt admits a crawler the policy excluded: a real disagreement,
    // and one no probe could have found without the policy.
    expect(ai?.outcome).toBe('fail');
    expect(ai?.summary).toMatch(/contradicts the policy/);
  }, 60_000);

  it('says nothing about a site that has recorded no policy', async () => {
    const siteId = await siteWith(null);

    const scheduler = new AuditScheduler({ db, corpus, crawl: BUDGET });
    const submitted = await scheduler.submit({ siteId, corpusVersion: '4.4' });
    await submitted.done;
    await scheduler.close();

    const rows = await db
      .select()
      .from(probeResults)
      .where(eq(probeResults.auditId, submitted.auditId));
    const ai = rows.find((row) => row.probeId === 'ai-crawler-directive-verify');
    // An unrecorded policy is not a policy the site is failing to keep.
    expect(ai?.outcome).toBe('not-applicable');
  }, 60_000);

  it('refuses a malformed policy at submit, before any request goes out', async () => {
    const siteId = await siteWith({ agents: { GPTBot: 'maybe' }, approvedAt: '2026-09-01' });

    const scheduler = new AuditScheduler({ db, corpus, crawl: BUDGET });
    await expect(scheduler.submit({ siteId, corpusVersion: '4.4' })).rejects.toThrow(
      /GPTBot|approvedBy/,
    );
    // No audit row: the request was bad, so there is nothing to report on.
    const rows = await db.select().from(audits).where(eq(audits.siteId, siteId));
    expect(rows).toHaveLength(0);
    await scheduler.close();
  });
});
