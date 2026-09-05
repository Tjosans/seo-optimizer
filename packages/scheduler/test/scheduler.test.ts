/**
 * The scheduler against a live database and a live fixture site.
 *
 * Skipped unless DATABASE_URL is set: `npm run stack:up`, then copy
 * .env.example to .env. There is nothing meaningful to assert about an audit
 * without the rows it writes, so this layer has no unit half.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { loadCorpus } from '@seo/corpus';
import {
  audits,
  checkStates,
  createDatabase,
  crawls,
  pages,
  probeResults,
  sites,
} from '@seo/db';
import {
  auditRetryPolicy,
  AuditScheduler,
  PermanentAuditError,
  UnknownSiteError,
} from '@seo/scheduler';
import type { CrawlBudget } from '@seo/scheduler';
import { startFixtureSite } from '@seo/testkit';
import type { FixtureSite } from '@seo/testkit';

const BUDGET: CrawlBudget = {
  userAgent: 'seo-optimizer/0.1 (+test)',
  maxPages: 10,
  maxDepth: 2,
};

const CORPUS = loadCorpus(fileURLToPath(new URL('../../../corpus/v4.4', import.meta.url)));

/**
 * The real corpus, resolved the way an API process would resolve it.
 *
 * A version that is not on disk is `PermanentAuditError`, not a plain one: no
 * amount of waiting puts a corpus on a disk, and the scheduler retries
 * anything it is not told is permanent.
 */
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

describe.skipIf(!url)('the audit scheduler', () => {
  const handle = createDatabase(url ?? '', { max: 4 });
  const { db } = handle;

  let siteId: string;

  beforeAll(async () => {
    const [row] = await db
      .insert(sites)
      .values({ name: 'fixture', origin: site.origin, flags: ['hierarchical'] })
      .returning({ id: sites.id });
    siteId = row!.id;
  });

  afterAll(async () => {
    await db.delete(sites).where(eq(sites.origin, site.origin));
    await handle.close();
  });

  const auditRow = async (auditId: string) => {
    const [row] = await db.select().from(audits).where(eq(audits.id, auditId));
    return row;
  };

  it('hands back an audit id before the crawl has run', async () => {
    const scheduler = new AuditScheduler({ db, corpus, crawl: BUDGET, paused: true });
    const submitted = await scheduler.submit({ siteId, corpusVersion: '4.4' });

    expect(submitted.auditId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await auditRow(submitted.auditId))?.status).toBe('pending');
    expect(scheduler.queued).toBe(1);
    expect(scheduler.running).toBe(0);

    await scheduler.close();
    await expect(submitted.done).rejects.toThrow();
  });

  it('crawls, probes, grades, and closes the audit out as complete', async () => {
    const scheduler = new AuditScheduler({ db, corpus, crawl: BUDGET });
    const submitted = await scheduler.submit({ siteId, corpusVersion: '4.4' });
    const outcome = await submitted.done;

    expect(outcome.pagesCrawled).toBeGreaterThan(0);
    expect(outcome.probeRuns).toBeGreaterThan(0);

    const audit = await auditRow(submitted.auditId);
    expect(audit?.status).toBe('complete');
    expect(audit?.corpusVersion).toBe('4.4');
    expect(audit?.startedAt).toBeInstanceOf(Date);
    expect(audit?.finishedAt).toBeInstanceOf(Date);
    expect(audit?.error).toBeNull();

    // A complete audit is a graded one: every check has a state, and the
    // verdict is frozen on the row rather than recomputed by whoever reads it.
    expect(outcome.checksGraded).toBe(97);
    expect(audit?.readiness).toMatchObject({
      corpusVersion: '4.4',
      readiness: { decision: outcome.readiness.readiness.decision },
    });

    const graded = await db
      .select()
      .from(checkStates)
      .where(eq(checkStates.auditId, submitted.auditId));
    expect(graded).toHaveLength(97);
    // The fixture site is small and most detectors are unimplemented, so most
    // checks come back ungraded. What must never happen is a check passing
    // without evidence behind it.
    expect(graded.some((row) => row.coverage === 'verified')).toBe(true);
    expect(
      graded.every((row) => row.status !== 'passed' || row.coverage !== 'unknown'),
    ).toBe(true);

    const [crawlRow] = await db.select().from(crawls).where(eq(crawls.id, outcome.crawlId));
    expect(crawlRow?.status).toBe('complete');
    expect(crawlRow?.seedUrls).toEqual([`${site.origin}/`]);

    const pageRows = await db.select().from(pages).where(eq(pages.crawlId, outcome.crawlId));
    expect(pageRows.length).toBe(outcome.pagesCrawled);

    const probeRows = await db
      .select()
      .from(probeResults)
      .where(eq(probeResults.auditId, submitted.auditId));
    expect(probeRows.length).toBe(outcome.probeRuns);

    await scheduler.close();
  }, 60_000);

  it('never runs two audits of one site at the same time', async () => {
    const scheduler = new AuditScheduler({ db, corpus, crawl: BUDGET, concurrency: 2 });
    const first = await scheduler.submit({ siteId, corpusVersion: '4.4' });
    const second = await scheduler.submit({ siteId, corpusVersion: '4.4' });

    await Promise.all([first.done, second.done]);

    const one = await auditRow(first.auditId);
    const two = await auditRow(second.auditId);
    // Both had a slot available; the lane is what held the second one back.
    expect(two!.startedAt!.getTime()).toBeGreaterThanOrEqual(one!.finishedAt!.getTime());

    await scheduler.close();
  }, 90_000);

  it('marks a cancelled audit cancelled and never crawls it', async () => {
    const scheduler = new AuditScheduler({ db, corpus, crawl: BUDGET, paused: true });
    const submitted = await scheduler.submit({ siteId, corpusVersion: '4.4' });

    expect(await scheduler.cancel(submitted.auditId)).toBe(true);

    const audit = await auditRow(submitted.auditId);
    expect(audit?.status).toBe('cancelled');
    expect(audit?.startedAt).toBeNull();

    const crawlRows = await db.select().from(crawls).where(eq(crawls.auditId, submitted.auditId));
    expect(crawlRows).toHaveLength(0);

    await expect(submitted.done).rejects.toThrow(/cancelled/);
    expect(await scheduler.cancel(submitted.auditId)).toBe(false);
    await scheduler.close();
  });

  it('records a failed audit as failed, with the reason', async () => {
    const scheduler = new AuditScheduler({ db, corpus, crawl: BUDGET });
    const submitted = await scheduler.submit({
      siteId,
      corpusVersion: '4.4',
      seeds: ['not-a-url'],
    });

    await expect(submitted.done).rejects.toThrow();

    const audit = await auditRow(submitted.auditId);
    expect(audit?.status).toBe('failed');
    expect(audit?.error).toBeTruthy();
    expect(audit?.finishedAt).toBeInstanceOf(Date);
    // An unusable seed is a bug in the request, not a blip: one attempt.
    expect(scheduler.status(submitted.auditId)?.attempt).toBe(1);

    await scheduler.close();
  });

  it('retries a transient failure, and stays pending while it waits', async () => {
    let resolutions = 0;
    const flaky = (version: string) => {
      resolutions += 1;
      // Stands in for the class of failure a retry exists for: infrastructure
      // that was briefly not there, rather than anything about this audit.
      if (resolutions === 1) throw new Error('connection terminated unexpectedly');
      return corpus(version);
    };

    let sawRetry!: () => void;
    const retrying = new Promise<void>((resolve) => {
      sawRetry = resolve;
    });

    const scheduler = new AuditScheduler({
      db,
      corpus: flaky,
      crawl: BUDGET,
      retry: auditRetryPolicy({ maxAttempts: 2, baseMs: 400, jitter: 0 }),
      onEvent: (event) => {
        if (event.type === 'retrying') sawRetry();
      },
    });
    const submitted = await scheduler.submit({ siteId, corpusVersion: '4.4' });

    await retrying;
    const waiting = await auditRow(submitted.auditId);
    // The failed attempt closed the row out; the scheduler reopened it before
    // starting the wait, so nothing polling this row ever sees an audit
    // reported as failed while another attempt is already scheduled.
    expect(waiting?.status).toBe('pending');
    expect(waiting?.error).toBe('connection terminated unexpectedly');
    expect(waiting?.finishedAt).toBeNull();

    const outcome = await submitted.done;
    expect(outcome.pagesCrawled).toBeGreaterThan(0);

    const audit = await auditRow(submitted.auditId);
    expect(audit?.status).toBe('complete');
    // The audit is the same audit: one id, one row, two attempts.
    expect(audit?.error).toBeNull();
    expect(scheduler.status(submitted.auditId)?.attempt).toBe(2);
    expect(resolutions).toBe(2);

    await scheduler.close();
  }, 60_000);

  it('fails an audit pinned to a corpus this process cannot produce, before crawling', async () => {
    const scheduler = new AuditScheduler({ db, corpus, crawl: BUDGET });
    const submitted = await scheduler.submit({ siteId, corpusVersion: '9.9' });

    await expect(submitted.done).rejects.toThrow(/no corpus 9\.9/);

    const audit = await auditRow(submitted.auditId);
    expect(audit?.status).toBe('failed');
    // Permanent, so it stood on its first attempt rather than being repeated
    // twice more at four minutes apart to reach the same answer.
    expect(scheduler.status(submitted.auditId)?.attempt).toBe(1);
    // Nothing was fetched: an unreportable audit must not spend someone
    // else's bandwidth finding that out.
    expect(await db.select().from(crawls).where(eq(crawls.auditId, submitted.auditId)))
      .toHaveLength(0);

    await scheduler.close();
  });

  it('refuses an audit for a site that does not exist', async () => {
    const scheduler = new AuditScheduler({ db, corpus, crawl: BUDGET, paused: true });
    await expect(
      scheduler.submit({ siteId: crypto.randomUUID(), corpusVersion: '4.4' }),
    ).rejects.toBeInstanceOf(UnknownSiteError);
    await scheduler.close();
  });

  it('lets a request narrow the crawl budget it was given', async () => {
    const scheduler = new AuditScheduler({ db, corpus, crawl: BUDGET });
    const submitted = await scheduler.submit({
      siteId,
      corpusVersion: '4.4',
      crawl: { maxPages: 2, followSitemaps: false },
    });
    const outcome = await submitted.done;

    expect(outcome.pagesCrawled).toBe(2);
    const [crawlRow] = await db.select().from(crawls).where(eq(crawls.id, outcome.crawlId));
    expect(crawlRow?.maxPages).toBe(2);
    // Untouched fields still come from the scheduler's defaults.
    expect(crawlRow?.maxDepth).toBe(BUDGET.maxDepth);

    await scheduler.close();
  }, 60_000);
});
