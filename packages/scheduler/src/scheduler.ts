/**
 * The audit scheduler: the front door.
 *
 * Everything below this point already existed — a crawl loop, a sink, a probe
 * registry, a queue. What was missing was the thing that turns "audit this
 * site" into all four in the right order, and hands back an id before any of it
 * has happened. That last part is the point: an HTTP handler (ROADMAP Phase 7)
 * has to answer its caller in milliseconds while the crawl it just started runs
 * for minutes, so `submit` writes the `audits` row, enqueues, and returns.
 *
 * The division of labour is deliberate. This class owns the audit's lifecycle
 * in the database — pending, running, complete, failed, cancelled. The queue
 * owns how many run at once and which may run together. Neither knows the
 * other's rules, and the lane is the one place they meet: an audit is laned on
 * its site's origin, so two audits of one customer queue behind each other
 * however much concurrency is on offer, and the politeness the crawl loop
 * promises that origin survives being scheduled.
 *
 * An audit that finishes here is graded: the run ends by turning the evidence
 * it gathered into `checkStates` and freezing a readiness verdict onto the row,
 * so `complete` means the launch decision is made rather than merely that the
 * crawl stopped.
 *
 * An audit that fails is retried, if the failure is one a repeat could fix —
 * see `./retry.ts` for where that line is drawn. The audit id does not change
 * across attempts: a retry is the same audit running again, writing a second
 * crawl under the same row, not a new audit that a caller would have to be
 * told about. What the row says while it waits is part of the contract, so the
 * status a failed attempt wrote is reopened to `pending` before the wait
 * starts, and only the last attempt's failure is left standing as `failed`.
 *
 * A queue given a `store` survives a restart: outstanding audits are written to
 * the `jobs` table as they are submitted, and `recover` on the way up reads them
 * back and puts each row to `pending` before anything runs again. Without one
 * the scheduler is memory-only, and a restart leaves those audits `pending`
 * forever with nothing on its way to run them — fine for a test, not something
 * to put a public API in front of.
 *
 * Recovery only finds work the store knows about. A row that reads `pending`
 * with no job behind it — submitted before the store existed, or lost to a
 * store that refused the write — would otherwise stay pending forever, waited
 * on by whoever holds its id. `reconcile` is the sweep that closes those out,
 * so every audit row eventually reaches a state that is true.
 */

import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { CrawlOptions } from '@seo/crawler';
import { audits, sites } from '@seo/db';
import type { Database } from '@seo/db';
import { JobQueue } from '@seo/queue';
import type { Job, JobEvent, JobStore, RetryAttempt, RetryPolicy } from '@seo/queue';
import { auditRetryPolicy } from './retry.js';
import { runAudit } from './run-audit.js';
import { UnknownSiteError } from './types.js';
import type {
  AuditHandle,
  AuditJob,
  AuditOutcome,
  AuditRequest,
  CorpusSource,
  CrawlBudget,
} from './types.js';

export interface AuditSchedulerOptions {
  readonly db: Database;
  /** Applied to every audit; a request may override any field. */
  readonly crawl: CrawlBudget;
  /**
   * Resolves the version an audit pinned to the checks it is graded against.
   *
   * Required rather than optional: an audit that gathered evidence and never
   * graded it leaves a row that reads `complete` next to a null readiness, and
   * a caller has no way to tell that from a site with nothing to report.
   */
  readonly corpus: CorpusSource;
  /**
   * Audits running at once, across all sites. Two is a deliberately shy
   * default: each audit holds a whole crawl in memory and a database
   * transaction per page.
   */
  readonly concurrency?: number;
  /**
   * What to do with a failed audit. Defaults to `auditRetryPolicy()`: three
   * attempts, backing off from 30 seconds, and only for failures a repeat
   * could fix. Pass `false` to let every failure stand on its first attempt.
   */
  readonly retry?: RetryPolicy<AuditJob> | false;
  /**
   * Where queued audits are written down, so a restart resumes them.
   *
   * Pass a `PostgresJobStore` from @seo/job-store in anything long-lived.
   * Without one the scheduler keeps its queue in memory only, and `submit`
   * resolving means the audit row exists — not that anything will ever run it
   * again after a restart.
   */
  readonly store?: JobStore<AuditJob>;
  /** Told when the store refuses a write for an audit already under way. */
  readonly onStoreError?: (error: unknown, job: Job<AuditJob>) => void;
  readonly onEvent?: (event: JobEvent<AuditJob>) => void;
  /** Start paused, so a batch can be submitted before anything runs. */
  readonly paused?: boolean;
}

/** Written to `audits.error` for a row `reconcile` closes out. */
export const ORPHANED_AUDIT_ERROR =
  'interrupted: no queued work was found for this audit, so nothing was going to run it';

export class AuditScheduler {
  readonly #db: Database;
  readonly #crawl: CrawlBudget;
  readonly #corpus: CorpusSource;
  readonly #queue: JobQueue<AuditJob, AuditOutcome>;
  /**
   * When this process took the queue over, read from the database clock.
   *
   * `reconcile` looks no later than this, so an audit submitted while the sweep
   * runs cannot be mistaken for an abandoned one — nothing this process
   * accepted can have been orphaned by the last. It has to come from the same
   * clock as `audits.createdAt`: comparing a Postgres timestamp against this
   * process's own `new Date()` makes the sweep's correctness depend on two
   * machines agreeing about the time, and they do not.
   */
  #cutoff: Date | null = null;

  constructor(options: AuditSchedulerOptions) {
    this.#db = options.db;
    this.#crawl = options.crawl;
    this.#corpus = options.corpus;

    const policy = options.retry === false ? undefined : (options.retry ?? auditRetryPolicy());
    this.#queue = new JobQueue<AuditJob, AuditOutcome>({
      concurrency: options.concurrency ?? 2,
      handler: (job, context) => runAudit(this.#db, job, this.#corpus, context.signal),
      ...(policy === undefined
        ? {}
        : { retry: (attempt: RetryAttempt<AuditJob>) => this.#decideRetry(policy, attempt) }),
      ...(options.store === undefined ? {} : { store: options.store }),
      ...(options.onStoreError === undefined ? {} : { onStoreError: options.onStoreError }),
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
      ...(options.paused === undefined ? {} : { paused: options.paused }),
    });
  }

  /** Audits waiting for a slot. */
  get queued(): number {
    return this.#queue.queued;
  }

  /** Audits whose crawl is in flight. */
  get running(): number {
    return this.#queue.running;
  }

  /**
   * Create the audit and queue it.
   *
   * Resolves as soon as the audit is queued durably — long before the crawl
   * finishes. Await the handle's `done` only if you actually want to wait for
   * the result.
   *
   * "Durably" is the part worth being exact about. With a store attached this
   * waits for the job to be written down before it returns, so an id handed
   * back is a promise that the work will happen even across a restart. If the
   * store refuses, the audit is closed out as `failed` and the error is thrown
   * rather than swallowed: a caller told an audit is queued has no other way to
   * find out that nothing is going to run it.
   */
  async submit(request: AuditRequest): Promise<AuditHandle> {
    const [site] = await this.#db
      .select({ id: sites.id, origin: sites.origin, flags: sites.flags })
      .from(sites)
      .where(eq(sites.id, request.siteId));
    if (site === undefined) throw new UnknownSiteError(request.siteId);

    const options = this.#optionsFor(site.origin, request);

    const [audit] = await this.#db
      .insert(audits)
      .values({ siteId: site.id, corpusVersion: request.corpusVersion })
      .returning({ id: audits.id });
    if (audit === undefined) throw new Error('the audit row was not created');

    const job: AuditJob = {
      auditId: audit.id,
      siteId: site.id,
      origin: site.origin,
      flags: site.flags,
      corpusVersion: request.corpusVersion,
      options,
    };

    // The audit id doubles as the job id, so `cancel` and `status` take the one
    // identifier a caller was given rather than a second one to keep track of.
    const handle = this.#queue.enqueue(job, { id: audit.id, lane: site.origin });
    try {
      await handle.stored;
    } catch (cause) {
      await this.#db
        .update(audits)
        .set({ status: 'failed', finishedAt: new Date(), error: messageOf(cause) })
        .where(eq(audits.id, audit.id));
      throw cause;
    }
    return { auditId: audit.id, done: handle.done };
  }

  /**
   * Resume the audits a previous process left outstanding.
   *
   * Call once, before submitting anything. Each recovered audit keeps its id
   * and its attempt count, and its row goes back to `pending` with the last
   * error still readable — which is what it is: an audit that was interrupted
   * and is queued again, not one that failed. A row left reading `running` by a
   * process that no longer exists is the status this exists to clear.
   *
   * The queue is held paused for the length of it, so no recovered audit starts
   * and overwrites its own row's status before the reset lands.
   *
   * Returns how many audits were resumed. Without a store, that is always zero.
   */
  async recover(): Promise<number> {
    const wasPaused = this.#queue.paused;
    this.#queue.pause();
    try {
      // Read before anything is restored, so nothing this process goes on to
      // start can fall on the abandoned side of the line.
      this.#cutoff = await this.#databaseNow();
      const restored = await this.#queue.recover();
      if (restored.length === 0) return 0;

      await this.#db
        .update(audits)
        .set({ status: 'pending', startedAt: null, finishedAt: null })
        .where(
          inArray(
            audits.id,
            restored.map((job) => job.payload.auditId),
          ),
        );
      return restored.length;
    } finally {
      if (!wasPaused) this.#queue.resume();
    }
  }

  /**
   * Close out audits that nothing is going to run.
   *
   * `recover` brings back the work the store wrote down. This is the other
   * half: a row that says `pending` or `running` from before this process
   * started, with no job behind it, is an audit that was lost — the store never
   * accepted it, or it predates the store — and leaving it pending means
   * whoever holds its id waits forever for an answer that is not coming. Each
   * one is marked `failed` with `ORPHANED_AUDIT_ERROR`, which is what happened:
   * the audit did not run and no one is going to make it.
   *
   * Call once, after `recover` and before accepting submissions. It refuses to
   * run before `recover`, and refuses entirely without a store, because in
   * either case every pending audit would look abandoned and the sweep would
   * fail the whole backlog.
   *
   * The sweep is database-wide by default, which is right when one scheduler
   * owns the database — the same single owner the store already assumes. Pass
   * `siteIds` to narrow it when that is not true, and a second scheduler's live
   * audits are left alone instead of being closed out from under it.
   *
   * Returns how many rows it closed.
   */
  async reconcile(options: { readonly siteIds?: readonly string[] } = {}): Promise<number> {
    if (!this.#queue.durable) {
      throw new Error('reconcile needs a store: without one every audit looks abandoned');
    }
    const cutoff = this.#cutoff;
    if (cutoff === null) throw new Error('call recover() before reconcile()');

    const live = new Set<string>();
    for (const state of ['queued', 'running'] as const) {
      for (const job of this.#queue.list(state)) live.add(job.payload.auditId);
    }

    const open = await this.#db
      .select({ id: audits.id })
      .from(audits)
      .where(
        and(
          inArray(audits.status, ['pending', 'running']),
          lt(audits.createdAt, cutoff),
          ...(options.siteIds === undefined
            ? []
            : [inArray(audits.siteId, [...options.siteIds])]),
        ),
      );

    const orphaned = open.map((row) => row.id).filter((id) => !live.has(id));
    if (orphaned.length === 0) return 0;

    await this.#db
      .update(audits)
      .set({ status: 'failed', finishedAt: new Date(), error: ORPHANED_AUDIT_ERROR })
      .where(inArray(audits.id, orphaned));
    return orphaned.length;
  }

  /**
   * Stop an audit. One still queued never starts; one already running is
   * signalled, and its crawl stops after at most the one request already in
   * flight rather than at the end of its page budget.
   *
   * Returns false when the audit is unknown to this process or already over.
   */
  async cancel(auditId: string): Promise<boolean> {
    const job = this.#queue.get(auditId);
    if (job === undefined) return false;

    const neverStarted = job.state === 'queued';
    if (!this.#queue.cancel(auditId)) return false;

    // A job cancelled before it ran leaves no one to close the row out: the
    // handler that would have written the status never executed.
    if (neverStarted) {
      await this.#db
        .update(audits)
        .set({ status: 'cancelled', finishedAt: new Date() })
        .where(eq(audits.id, auditId));
    }
    return true;
  }

  /**
   * In-process view of one audit, including which attempt it is on and when
   * the next one is due. The row in `audits` is the durable one.
   */
  status(auditId: string): Job<AuditJob> | undefined {
    return this.#queue.get(auditId);
  }

  pause(): void {
    this.#queue.pause();
  }

  resume(): void {
    this.#queue.resume();
  }

  /** Resolve once every submitted audit has finished. */
  drain(): Promise<void> {
    return this.#queue.drain();
  }

  /**
   * Refuse new audits, cancel those still queued, signal those running, and
   * resolve when the last one returns. The database handle is the caller's to
   * close: the scheduler borrowed it and does not own its lifetime.
   */
  close(): Promise<void> {
    return this.#queue.close();
  }

  /**
   * Ask the policy, then reopen the row before the wait begins.
   *
   * The failed attempt has already written `failed` and its message — that is
   * `runAudit` reporting honestly on the run it just made, and it has no way
   * to know another is coming. Putting the row back to `pending` here is what
   * keeps the two consistent: for the length of the backoff the audit is
   * pending with the last failure still readable in `error`, which is exactly
   * what it is.
   *
   * If that write fails, so does the audit. A retry nobody can see coming
   * would leave a row reading `failed` while a crawl of that site starts
   * anyway, and a caller reading the row would have no way to know.
   */
  async #decideRetry(
    policy: RetryPolicy<AuditJob>,
    attempt: RetryAttempt<AuditJob>,
  ): Promise<number | null> {
    const delayMs = await policy(attempt);
    if (delayMs === null) return null;

    await this.#db
      .update(audits)
      .set({ status: 'pending', startedAt: null, finishedAt: null })
      .where(eq(audits.id, attempt.job.payload.auditId));
    return delayMs;
  }

  /**
   * The database's idea of now.
   *
   * Every timestamp `reconcile` compares against was written by Postgres, so
   * the boundary has to be Postgres's too.
   */
  async #databaseNow(): Promise<Date> {
    const rows = (await this.#db.execute(sql`select now() as now`)) as unknown as readonly {
      readonly now: Date;
    }[];
    const now = rows[0]?.now;
    return now instanceof Date ? now : new Date();
  }

  #optionsFor(origin: string, request: AuditRequest): CrawlOptions {
    const budget: CrawlBudget = { ...this.#crawl, ...request.crawl };
    const seeds = request.seeds ?? [new URL('/', origin).toString()];
    if (seeds.length === 0) throw new Error('an audit needs at least one seed URL');
    return { ...budget, seeds };
  }
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
