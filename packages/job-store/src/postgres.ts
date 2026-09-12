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
 * ## Who owns a job
 *
 * A `queue` name is a namespace, and how many processes may run one depends on
 * a single option.
 *
 * **Without `leaseMs`** the namespace has exactly one owner, which is what it
 * had before leases existed. `load` claims *everything* under the name, not
 * merely rows it left behind itself: a restart comes back with a new pid, and a
 * store that only reclaimed its own owner string would strand every job the
 * previous process had started. Ownership is recorded rather than enforced —
 * two processes sharing a name here would divide the outstanding jobs between
 * them and both run, and nothing would stop it.
 *
 * **With `leaseMs`** a claim is a statement with an expiry on it. `load` takes
 * only what is free — never claimed, already this owner's, or held by a claim
 * older than the lease — and leaves the rest alone. `renew` is how a live
 * worker keeps saying "still mine", and how it finds out when the answer has
 * become no. `save` and `remove` refuse to touch a row another worker holds, so
 * a process that has been superseded and does not know it yet cannot overwrite
 * or delete the new owner's work. That is the whole of what a second worker
 * needs, and it costs no migration: `owner` and `leased_at` were already
 * columns, and claiming is what `load` already meant.
 *
 * A lease covers a job; `acquire` covers its lane. The queue keeps lanes in
 * memory, which is one process's view, so a worker about to run a laned job
 * asks here first whether another live worker is running one in that lane —
 * two audits of one site landing on two workers must still crawl it one at a
 * time. `lane` was already a column too.
 *
 * Two things a caller has to get right for leases to hold.
 *
 *   **The lease must outlast a beat, and the beat must outrun the lease.** The
 *   queue's `heartbeatMs` should be well under `leaseMs` — a third is the usual
 *   shape — so a slow database or a busy event loop costs a renewal, not the
 *   job.
 *
 *   **`owner` should be stable across a restart.** The default is host and pid,
 *   which is fine for diagnostics and wrong for recovery: a process that comes
 *   back under a new name cannot reclaim its own rows and has to wait out its
 *   own lease. Give each worker a name it keeps — a pod name, a slot number —
 *   and a restart picks up where it left off.
 *
 * Expiry is measured by the database clock, not this process's. Every
 * timestamp being compared was written by Postgres, and a claim whose
 * correctness depended on two machines agreeing about the time would eventually
 * hand one worker's job to another for no reason but a skewed clock.
 *
 * ## Payloads
 *
 * A payload is stored as `jsonb`, so it must survive `JSON.stringify` and come
 * back meaning the same thing. Plain data does; a `Date`, a `Map`, a class
 * instance or a function does not. `AuditJob` is plain data on purpose. Pass
 * `revive` when a payload needs rebuilding from what JSON kept.
 */

import { and, asc, eq, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { jobs } from '@seo/db';
import type { Database } from '@seo/db';
import { ADOPTION_BATCH, JobLeaseLostError } from '@seo/queue';
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
   * Which worker this store speaks for. Defaults to host and pid.
   *
   * With `leaseMs` set this is load-bearing rather than diagnostic: it decides
   * which rows are this worker's to run, renew, update and delete. Give it a
   * name that survives a restart — see the note above.
   */
  readonly owner?: string;
  /**
   * How long a claim stands without being renewed.
   *
   * Omit for a namespace with one owner, which claims everything it finds and
   * never expires. Set it to share the namespace: a claim older than this is
   * treated as abandoned and may be taken by another worker, so it has to be
   * comfortably longer than the queue's `heartbeatMs` and longer than the
   * worst pause — a long GC, a database failover — that should not cost a job.
   * Tens of seconds, not tens of milliseconds.
   */
  readonly leaseMs?: number;
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
  readonly #leaseMs: number | undefined;
  readonly #revive: (raw: unknown) => TPayload;

  constructor(options: PostgresJobStoreOptions<TPayload>) {
    this.#db = options.db;
    this.#queue = options.queue;
    this.#owner = options.owner ?? `${hostname()}#${process.pid}`;
    this.#leaseMs = options.leaseMs;
    this.#revive = options.revive ?? ((raw) => raw as TPayload);
  }

  /** Who this store records as holding the jobs it claims. */
  get owner(): string {
    return this.#owner;
  }

  /** How long a claim stands, or undefined when this namespace has one owner. */
  get leaseMs(): number | undefined {
    return this.#leaseMs;
  }

  /**
   * Rows this owner may take: nobody's, already ours, or held by a claim the
   * database's own clock says has aged out.
   *
   * Undefined without a lease, where every row in the namespace is ours.
   */
  #claimable(): SQL | undefined {
    if (this.#leaseMs === undefined) return undefined;
    return or(
      isNull(jobs.owner),
      eq(jobs.owner, this.#owner),
      isNull(jobs.leasedAt),
      lt(jobs.leasedAt, sql`now() - make_interval(secs => ${this.#leaseMs / 1000})`),
    );
  }

  /**
   * Claim and return the outstanding jobs in this namespace that are free to
   * take, oldest first.
   *
   * "Free to take" is everything, without a lease. With one it is what no live
   * worker is holding, so two workers starting at once divide the backlog
   * instead of both running it.
   *
   * One transaction: the rows are locked, stamped with this owner, and handed
   * back together, so a reader that dies halfway leaves the table as it found
   * it rather than a half-claimed set. `SKIP LOCKED` is what keeps two workers
   * loading at the same instant from queueing behind each other.
   */
  async load(): Promise<readonly StoredJob<TPayload>[]> {
    return this.#db.transaction(async (tx) => {
      const claimable = this.#claimable();
      const rows = await tx
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.queue, this.#queue),
            inArray(jobs.state, [...OUTSTANDING]),
            ...(claimable === undefined ? [] : [claimable]),
          ),
        )
        .orderBy(asc(jobs.enqueuedAt))
        .for('update', { skipLocked: true });

      if (rows.length === 0) return [];

      // Written back as queued, which is what the queue takes them back as. A
      // row left reading `running` would hold its lane against every other
      // worker for as long as the job waits here for a slot.
      await tx
        .update(jobs)
        .set({
          owner: this.#owner,
          leasedAt: sql`now()`,
          updatedAt: sql`now()`,
          state: 'queued',
        })
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
   * Claim and return the jobs in this namespace that no live worker holds any
   * more, oldest first, up to a beat's worth.
   *
   * The rows `load` would take, minus this worker's own: a claim that has aged
   * out by the database's clock, or a row nobody ever claimed. Excluding our
   * own is what makes this safe to call while running — they are already this
   * queue's to track, and the write below would stamp a job we are running as
   * `queued`, which would drop its lane for every other worker.
   *
   * Nothing without `leaseMs`: a namespace with one owner has no abandoned
   * work in it, only work that owner has not got to yet.
   *
   * Otherwise the shape is `load`'s — one transaction, `SKIP LOCKED`, written
   * back as `queued` — because it is the same act at a different moment.
   */
  async adopt(): Promise<readonly StoredJob<TPayload>[]> {
    const leaseMs = this.#leaseMs;
    if (leaseMs === undefined) return [];

    return this.#db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.queue, this.#queue),
            inArray(jobs.state, [...OUTSTANDING]),
            or(isNull(jobs.owner), ne(jobs.owner, this.#owner)),
            or(
              isNull(jobs.leasedAt),
              lt(jobs.leasedAt, sql`now() - make_interval(secs => ${leaseMs / 1000})`),
            ),
          ),
        )
        .orderBy(asc(jobs.enqueuedAt))
        .limit(ADOPTION_BATCH)
        .for('update', { skipLocked: true });

      if (rows.length === 0) return [];

      await tx
        .update(jobs)
        .set({
          owner: this.#owner,
          leasedAt: sql`now()`,
          updatedAt: sql`now()`,
          state: 'queued',
        })
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
        state: 'queued' as const,
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
    await this.#write(this.#db, job);
  }

  /**
   * Write a job down as running, unless another worker is running one in its
   * lane.
   *
   * The check and the write share a transaction behind an advisory lock on the
   * lane, because without one two workers asking at the same instant would each
   * read no running job, each write their own, and crawl the site together —
   * the one outcome this exists to rule out. The lock is transaction-scoped, so
   * it goes back to the pool with the connection and a worker that dies holding
   * it releases it with the session. It covers this namespace's lane and
   * nothing wider: the lock is on the pair.
   *
   * Only a live claim holds a lane. A running row whose lease has aged out
   * belongs to a worker that has stopped renewing, and the site is no longer
   * being crawled by it; waiting on that row would make one crash stall a site
   * until someone cleaned the table. Without a lease the namespace has one
   * owner, so there is no one else to wait for.
   */
  async acquire(job: StoredJob<TPayload>): Promise<boolean> {
    const lane = job.lane;
    if (lane === null || this.#leaseMs === undefined) {
      await this.save(job);
      return true;
    }
    const leaseMs = this.#leaseMs;

    return this.#db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${this.#queue}), hashtext(${lane}))`,
      );

      const [held] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.queue, this.#queue),
            eq(jobs.lane, lane),
            eq(jobs.state, 'running'),
            ne(jobs.id, job.id),
            ne(jobs.owner, this.#owner),
            gte(jobs.leasedAt, sql`now() - make_interval(secs => ${leaseMs / 1000})`),
          ),
        )
        .limit(1);
      if (held !== undefined) return false;

      await this.#write(tx, job);
      return true;
    });
  }

  /** The upsert behind `save` and `acquire`, on whichever connection is holding the lock. */
  async #write(executor: Pick<Database, 'insert'>, job: StoredJob<TPayload>): Promise<void> {
    const claimable = this.#claimable();
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
      leasedAt: sql`now()`,
      updatedAt: sql`now()`,
    };

    const written = await executor
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
        // The write lands only on a row this worker may hold. A process whose
        // claim has been taken must not put its version of the job back: the
        // new owner is running it, and the state it is writing is the true one.
        ...(claimable === undefined ? {} : { setWhere: claimable }),
      })
      .returning({ id: jobs.id });

    // Nothing came back, so the conflict target matched and the guard did not:
    // this row is somebody else's. Said out loud rather than swallowed, because
    // a caller who thinks a job is written down when it is not is exactly the
    // situation a durable store exists to prevent.
    if (written.length === 0) throw new JobLeaseLostError(job.id);
  }

  /**
   * Forget a settled job. What became of it is recorded by its own domain.
   *
   * Scoped to rows this worker may hold, and silent when it holds none: a job
   * whose lease has moved on has been taken over, and deleting it here would
   * cancel the new owner's work rather than clean up after this one's.
   */
  async remove(id: string): Promise<void> {
    const claimable = this.#claimable();
    await this.#db
      .delete(jobs)
      .where(
        and(
          eq(jobs.id, id),
          eq(jobs.queue, this.#queue),
          ...(claimable === undefined ? [] : [claimable]),
        ),
      );
  }

  /**
   * Say "still mine" about the jobs this worker is running, and report the ones
   * that are not.
   *
   * One statement: the rows this owner still holds have their claim pushed
   * forward, and whatever did not come back is lost — taken by another worker,
   * or already gone from the table. A claim of this owner's that has expired
   * with nobody taking it renews normally, because a lease is an invitation to
   * take over, not a punishment for being late.
   */
  async renew(ids: readonly string[]): Promise<readonly string[]> {
    if (ids.length === 0) return [];

    const held = await this.#db
      .update(jobs)
      .set({ leasedAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          eq(jobs.queue, this.#queue),
          inArray(jobs.id, [...ids]),
          eq(jobs.owner, this.#owner),
        ),
      )
      .returning({ id: jobs.id });

    const renewed = new Set(held.map((row) => row.id));
    return ids.filter((id) => !renewed.has(id));
  }

  /**
   * Every outstanding job in this namespace, whoever holds it.
   *
   * Not a claim and not filtered by owner: this answers "is anything going to
   * run this?", which is a different question from "is it mine to run?" and the
   * one a reconciliation sweep has to ask before it writes an audit off.
   */
  async outstanding(): Promise<readonly string[]> {
    const rows = await this.#db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.queue, this.#queue), inArray(jobs.state, [...OUTSTANDING])));
    return rows.map((row) => row.id);
  }

  /** How many jobs are outstanding in this namespace. For tests and health checks. */
  async size(): Promise<number> {
    const ids = await this.outstanding();
    return ids.length;
  }
}
