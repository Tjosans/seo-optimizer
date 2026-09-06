/**
 * What survives a restart.
 *
 * Skipped unless DATABASE_URL is set: `npm run stack:up`, then copy
 * .env.example to .env.
 *
 * A restart is staged by abandoning one scheduler — never closed, never
 * drained, exactly as a process that was killed leaves it — and standing a
 * second one up on the same `jobs` namespace. That is the whole claim of this
 * phase: an audit submitted and not yet run is still going to run.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { loadCorpus } from '@seo/corpus';
import { audits, createDatabase, jobs, sites } from '@seo/db';
import { PostgresJobStore } from '@seo/job-store';
import { AuditScheduler, ORPHANED_AUDIT_ERROR, PermanentAuditError } from '@seo/scheduler';
import type { AuditJob, CrawlBudget } from '@seo/scheduler';
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

describe.skipIf(!url)('an audit across a restart', () => {
  const handle = createDatabase(url ?? '', { max: 6 });
  const { db } = handle;
  const queue = `audits-test-${crypto.randomUUID()}`;

  let siteId: string;

  beforeAll(async () => {
    const [row] = await db
      .insert(sites)
      .values({ name: 'fixture-recovery', origin: site.origin, flags: ['hierarchical'] })
      .returning({ id: sites.id });
    siteId = row!.id;
  });

  afterAll(async () => {
    await db.delete(jobs).where(eq(jobs.queue, queue));
    await db.delete(sites).where(eq(sites.origin, site.origin));
    await handle.close();
  });

  const store = () => new PostgresJobStore<AuditJob>({ db, queue });

  const auditRow = async (auditId: string) => {
    const [row] = await db.select().from(audits).where(eq(audits.id, auditId));
    return row;
  };

  it('is written down at submit, and run by the process that comes next', async () => {
    // A process that takes submissions and then dies before running any.
    const dying = new AuditScheduler({ db, corpus, crawl: BUDGET, store: store(), paused: true });
    const submitted = await dying.submit({ siteId, corpusVersion: '4.4' });

    expect((await auditRow(submitted.auditId))?.status).toBe('pending');
    const [stored] = await db.select().from(jobs).where(eq(jobs.id, submitted.auditId));
    expect(stored).toMatchObject({ queue, state: 'queued', attempt: 0 });
    // The lane is what keeps two audits of one origin from crawling together,
    // so it has to come back with the job rather than be re-derived.
    expect(stored?.lane).toBe(site.origin);
    expect(stored?.payload).toMatchObject({ auditId: submitted.auditId, origin: site.origin });

    // No close, no drain: the process is simply gone.
    const revived = new AuditScheduler({ db, corpus, crawl: BUDGET, store: store() });
    expect(await revived.recover()).toBe(1);

    const resumed = revived.status(submitted.auditId);
    expect(resumed?.payload.auditId).toBe(submitted.auditId);
    expect(resumed?.lane).toBe(site.origin);

    await revived.drain();

    const audit = await auditRow(submitted.auditId);
    expect(audit?.status).toBe('complete');
    expect(audit?.readiness).not.toBeNull();

    // Nothing left outstanding: the job is done and the row is gone.
    expect(await db.select().from(jobs).where(eq(jobs.id, submitted.auditId))).toEqual([]);
    await revived.close();
  }, 60_000);

  it('reopens a row a dead process left reading `running`', async () => {
    const dying = new AuditScheduler({ db, corpus, crawl: BUDGET, store: store(), paused: true });
    const submitted = await dying.submit({ siteId, corpusVersion: '4.4' });

    // What a process killed mid-crawl leaves behind: the row says running, and
    // the stored job has spent an attempt.
    await db
      .update(audits)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(audits.id, submitted.auditId));
    await db
      .update(jobs)
      .set({ state: 'running', attempt: 1 })
      .where(eq(jobs.id, submitted.auditId));

    const revived = new AuditScheduler({
      db,
      corpus,
      crawl: BUDGET,
      store: store(),
      paused: true,
    });
    expect(await revived.recover()).toBe(1);

    const audit = await auditRow(submitted.auditId);
    expect(audit?.status).toBe('pending');
    expect(audit?.startedAt).toBeNull();
    // The attempt is kept, so a crawl that kills the process still costs an
    // attempt against the retry policy rather than being free forever.
    expect(revived.status(submitted.auditId)?.attempt).toBe(1);

    await revived.close();
  });

  it('recovers nothing when there is no store, and says so', async () => {
    const scheduler = new AuditScheduler({ db, corpus, crawl: BUDGET, paused: true });
    expect(await scheduler.recover()).toBe(0);
    await scheduler.close();
  });

  describe('reconciling rows nothing is going to run', () => {
    // Scoped to this file's own site: `audits` is shared, and a database-wide
    // sweep would close out audits belonging to a test running beside this one.
    const scope = () => ({ siteIds: [siteId] });

    it('closes out an audit with no job behind it', async () => {
      // What a lost enqueue leaves: a row, and nothing on its way to run it.
      const [orphan] = await db
        .insert(audits)
        .values({ siteId, corpusVersion: '4.4' })
        .returning({ id: audits.id });

      const scheduler = new AuditScheduler({
        db,
        corpus,
        crawl: BUDGET,
        store: store(),
        paused: true,
      });
      await scheduler.recover();
      expect(await scheduler.reconcile(scope())).toBeGreaterThanOrEqual(1);

      const row = await auditRow(orphan!.id);
      expect(row?.status).toBe('failed');
      expect(row?.error).toBe(ORPHANED_AUDIT_ERROR);
      expect(row?.finishedAt).toBeInstanceOf(Date);

      await scheduler.close();
    });

    it('leaves a recovered audit alone', async () => {
      const dying = new AuditScheduler({
        db,
        corpus,
        crawl: BUDGET,
        store: store(),
        paused: true,
      });
      const submitted = await dying.submit({ siteId, corpusVersion: '4.4' });

      const revived = new AuditScheduler({
        db,
        corpus,
        crawl: BUDGET,
        store: store(),
        paused: true,
      });
      expect(await revived.recover()).toBe(1);
      await revived.reconcile(scope());

      // It has a job behind it, so it is queued work rather than a lost row.
      expect((await auditRow(submitted.auditId))?.status).toBe('pending');
      await revived.close();
    });

    it('refuses to run before recovery, or without a store', async () => {
      const unrecovered = new AuditScheduler({
        db,
        corpus,
        crawl: BUDGET,
        store: store(),
        paused: true,
      });
      await expect(unrecovered.reconcile(scope())).rejects.toThrow('call recover()');
      await unrecovered.close();

      // Without a store nothing is written down, so every pending audit would
      // look abandoned and the sweep would fail the entire backlog.
      const storeless = new AuditScheduler({ db, corpus, crawl: BUDGET, paused: true });
      await storeless.recover();
      await expect(storeless.reconcile(scope())).rejects.toThrow('needs a store');
      await storeless.close();
    });
  });
});
