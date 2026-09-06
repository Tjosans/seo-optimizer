/**
 * A `JobStore` backed by the `jobs` table.
 *
 * This is the piece that makes a queued audit survive a deploy. @seo/queue
 * keeps its scheduling state in memory and writes outstanding work here; on the
 * way up, `recover` reads it back and the batch resumes instead of sitting in
 * `audits` as a row that says `pending` with nothing on its way to run it.
 *
 * It lives in its own package rather than in @seo/queue because the queue is
 * generic and knows nothing about Postgres, and rather than in @seo/db because
 * that package is schema and connection only. This is the join between them,
 * and it is the only file that needs both.
 *
 * ## What one owner means
 *
 * A `queue` name is a namespace, and the design assumes exactly one process
 * runs a given name at a time. `load` therefore claims *everything* under that
 * name, not merely rows it left behind itself: a restart comes back with a new
 * pid, and a store that only reclaimed its own owner string would strand every
 * job the previous process had started. Ownership is recorded rather than
 * enforced — two processes sharing a name today would divide the outstanding
 * jobs between them and both run, and nothing here would stop it.
 *
 * The claim is still written as `SELECT … FOR UPDATE SKIP LOCKED` followed by a
 * stamp, which is the shape a multi-worker claim has to be. What is missing for
 * that is a lease that expires and a heartbeat to renew it; when those arrive,
 * the change is the `where` clause in `load` and nothing else — no migration,
 * because `owner` and `leased_at` are already columns, and no change to the
 * `JobStore` interface, because claiming is what `load` already means.
 *
 * ## Payloads
 *
 * A payload is stored as `jsonb`, so it must survive `JSON.stringify` and come
 * back meaning the same thing. Plain data does; a `Date`, a `Map`, a class
 * instance or a function does not. `AuditJob` is plain data on purpose. Pass
 * `revive` when a payload needs rebuilding from what JSON kept.
 */

import { and, asc, eq, inArray } from 'drizzle-orm';
import { jobs } from '@seo/db';
import type { Database } from '@seo/db';
import type { JobStore, StoredJob } from '@seo/queue';
import { hostname } from 'node:os';

/** States a stored job can be in. Terminal jobs are deleted, never written. */
const OUTSTANDING = ['queued', 'running'] as const;

export interface PostgresJobStoreOptions<TPayload> {
  readonly db: Database;
  /**
   * Namespace for this queue's rows, e.g. `'audits'`.
   *
   * Two queues in one process must not share a name, or each would recover the
   * other's work and hand it to a handler that cannot run it.
   */
  readonly queue: string;
  /**
   * Recorded on every row this process claims, for diagnostics. Defaults to
   * host and pid. Nothing keys off it yet — see the note above.
   */
  readonly owner?: string;
  /**
   * Rebuild a payload from the JSON that came back.
   *
   * Defaults to using it as-is, which is right whenever the payload is plain
   * data. A payload holding anything JSON flattens needs this to put it back.
   */
  readonly revive?: (raw: unknown) => TPayload;
}

export class PostgresJobStore<TPayload> implements JobStore<TPayload> {
  readonly #db: Database;
  readonly #queue: string;
  readonly #owner: string;
  readonly #revive: (raw: unknown) => TPayload;

  constructor(options: PostgresJobStoreOptions<TPayload>) {
    this.#db = options.db;
    this.#queue = options.queue;
    this.#owner = options.owner ?? `${hostname()}#${process.pid}`;
    this.#revive = options.revive ?? ((raw) => raw as TPayload);
  }

  /** Who this store records as holding the jobs it claims. */
  get owner(): string {
    return this.#owner;
  }

  /**
   * Claim and return every outstanding job in this namespace, oldest first.
   *
   * One transaction: the rows are locked, stamped with this owner, and handed
   * back together, so a reader that dies halfway leaves the table as it found
   * it rather than a half-claimed set.
   */
  async load(): Promise<readonly StoredJob<TPayload>[]> {
    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.queue, this.#queue), inArray(jobs.state, [...OUTSTANDING])))
        .orderBy(asc(jobs.enqueuedAt))
        .for('update', { skipLocked: true });

      if (rows.length === 0) return [];

      await tx
        .update(jobs)
        .set({ owner: this.#owner, leasedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(jobs.queue, this.#queue),
            inArray(
              jobs.id,
              rows.map((row) => row.id),
            ),
          ),
        );

      return rows.map((row) => ({
        id: row.id,
        payload: this.#revive(row.payload),
        lane: row.lane,
        priority: row.priority,
        state: row.state,
        attempt: row.attempt,
        enqueuedAt: row.enqueuedAt,
        nextAttemptAt: row.nextAttemptAt,
        error: row.error,
      }));
    });
  }

  /**
   * Write a job down, replacing what is stored under its id.
   *
   * An upsert rather than an insert-or-update pair, because the queue calls
   * this for a job it created and for the same job three transitions later, and
   * a store that had to know which is which would be keeping its own state
   * about the queue's state.
   */
  async save(job: StoredJob<TPayload>): Promise<void> {
    const row = {
      id: job.id,
      queue: this.#queue,
      payload: job.payload as unknown,
      lane: job.lane,
      priority: job.priority,
      state: job.state,
      attempt: job.attempt,
      enqueuedAt: job.enqueuedAt,
      nextAttemptAt: job.nextAttemptAt,
      error: job.error,
      owner: this.#owner,
      leasedAt: new Date(),
      updatedAt: new Date(),
    };

    await this.#db
      .insert(jobs)
      .values(row)
      .onConflictDoUpdate({
        target: [jobs.queue, jobs.id],
        set: {
          state: row.state,
          attempt: row.attempt,
          priority: row.priority,
          lane: row.lane,
          payload: row.payload,
          nextAttemptAt: row.nextAttemptAt,
          error: row.error,
          owner: row.owner,
          leasedAt: row.leasedAt,
          updatedAt: row.updatedAt,
        },
      });
  }

  /** Forget a settled job. What became of it is recorded by its own domain. */
  async remove(id: string): Promise<void> {
    await this.#db.delete(jobs).where(and(eq(jobs.id, id), eq(jobs.queue, this.#queue)));
  }

  /** How many jobs are outstanding in this namespace. For tests and health checks. */
  async size(): Promise<number> {
    const rows = await this.#db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.queue, this.#queue), inArray(jobs.state, [...OUTSTANDING])));
    return rows.length;
  }
}
