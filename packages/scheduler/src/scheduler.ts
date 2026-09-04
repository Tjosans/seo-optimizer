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
 * State lives in memory, so a restart loses what was queued and leaves those
 * audits `pending` forever. That is the durable-store item in ROADMAP Phase 4,
 * and it is the reason this is not yet safe to put behind a public API.
 */

import { eq } from 'drizzle-orm';
import type { CrawlOptions } from '@seo/crawler';
import { audits, sites } from '@seo/db';
import type { Database } from '@seo/db';
import { JobQueue } from '@seo/queue';
import type { Job, JobEvent } from '@seo/queue';
import { runAudit } from './run-audit.js';
import { UnknownSiteError } from './types.js';
import type { AuditHandle, AuditJob, AuditOutcome, AuditRequest, CrawlBudget } from './types.js';

export interface AuditSchedulerOptions {
  readonly db: Database;
  /** Applied to every audit; a request may override any field. */
  readonly crawl: CrawlBudget;
  /**
   * Audits running at once, across all sites. Two is a deliberately shy
   * default: each audit holds a whole crawl in memory and a database
   * transaction per page.
   */
  readonly concurrency?: number;
  readonly onEvent?: (event: JobEvent<AuditJob>) => void;
  /** Start paused, so a batch can be submitted before anything runs. */
  readonly paused?: boolean;
}

export class AuditScheduler {
  readonly #db: Database;
  readonly #crawl: CrawlBudget;
  readonly #queue: JobQueue<AuditJob, AuditOutcome>;

  constructor(options: AuditSchedulerOptions) {
    this.#db = options.db;
    this.#crawl = options.crawl;
    this.#queue = new JobQueue<AuditJob, AuditOutcome>({
      concurrency: options.concurrency ?? 2,
      handler: (job, context) => runAudit(this.#db, job, context.signal),
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
   * Resolves as soon as the row exists — long before the crawl finishes. Await
   * the handle's `done` only if you actually want to wait for the result.
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
      options,
    };

    // The audit id doubles as the job id, so `cancel` and `status` take the one
    // identifier a caller was given rather than a second one to keep track of.
    const handle = this.#queue.enqueue(job, { id: audit.id, lane: site.origin });
    return { auditId: audit.id, done: handle.done };
  }

  /**
   * Stop an audit. One still queued never starts; one already running is
   * signalled and stops at its next checkpoint — which, until the crawl loop
   * takes a signal of its own, is after the crawl it started has finished.
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

  /** In-process view of one audit. The row in `audits` is the durable one. */
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

  #optionsFor(origin: string, request: AuditRequest): CrawlOptions {
    const budget: CrawlBudget = { ...this.#crawl, ...request.crawl };
    const seeds = request.seeds ?? [new URL('/', origin).toString()];
    if (seeds.length === 0) throw new Error('an audit needs at least one seed URL');
    return { ...budget, seeds };
  }
}
