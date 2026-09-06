/**
 * Where a queued job survives a restart.
 *
 * The queue holds its working state in memory because that is what a
 * scheduling decision needs: which lanes are busy, which slot just freed, which
 * job is next. None of that has to outlive the process. What does is the far
 * smaller fact that *someone asked for this work and it has not happened yet* —
 * and until now that fact lived only in the same memory, so a deploy in the
 * middle of a batch of audits lost every one that had not started.
 *
 * A `JobStore` is the durable half. The queue writes a job to it at enqueue and
 * at every transition after, removes it when the job reaches a terminal state,
 * and reads what is left back on the way up. That is deliberately the whole
 * interface: three methods, no locking protocol, no visibility rules. The store
 * is a record of outstanding work, not a second scheduler.
 *
 * Two consequences worth being plain about.
 *
 *   **Terminal jobs are removed, not archived.** A store that kept every
 *   finished job would need a retention policy, and the answer to "what
 *   happened to that audit" already exists in a table built for it — `audits`
 *   holds the status, the timestamps and the error, and it outlives the queue
 *   entirely. Duplicating that here would create a second history to keep
 *   consistent with the first.
 *
 *   **Delivery is at-least-once.** A process that dies between a handler
 *   returning and the removal landing will find the job still stored and run it
 *   again. There is no way around that without a transaction spanning the
 *   handler's own side effects, which the queue cannot open on the handler's
 *   behalf. Handlers must therefore tolerate a repeat — which an audit already
 *   does, because a retry is the same thing by another name.
 *
 * A job restored from a store comes back `queued`, whatever it was when the
 * process died, and keeps the attempt count it had. Keeping the count is what
 * stops a job that crashes the process from being restarted forever: the retry
 * policy's limit still counts a crash as an attempt, because from the outside
 * it is one.
 */

import type { JobState } from './types.js';

/**
 * A job as it is written down: everything needed to rebuild it, and nothing
 * about the run in progress.
 *
 * `startedAt` and `finishedAt` are absent on purpose. They describe an attempt
 * by a process that is, by the time anyone reads this record back, gone.
 */
export interface StoredJob<TPayload> {
  readonly id: string;
  readonly payload: TPayload;
  readonly lane: string | null;
  readonly priority: number;
  /** Only `queued` and `running` are ever written; terminal jobs are removed. */
  readonly state: JobState;
  readonly attempt: number;
  readonly enqueuedAt: Date;
  /** When a job waiting out a retry backoff becomes eligible again. */
  readonly nextAttemptAt: Date | null;
  /** Last failure message, while a retry is pending. */
  readonly error: string | null;
}

export interface JobStore<TPayload> {
  /**
   * Every job that has not finished, oldest first.
   *
   * Called once by `JobQueue.recover`. An implementation backed by shared
   * storage claims what it returns, so a second process reading the same store
   * does not hand out the same work twice.
   */
  load(): Promise<readonly StoredJob<TPayload>[]>;
  /** Write a job, creating it or replacing what is stored under its id. */
  save(job: StoredJob<TPayload>): Promise<void>;
  /** Forget a job. Removing one that is not there is not an error. */
  remove(id: string): Promise<void>;
}

/**
 * A store that keeps jobs in a `Map`.
 *
 * It survives nothing, which makes it useless in production and exactly right
 * in a test: the same code path a Postgres store exercises, with the database
 * taken out. `snapshot` is the seam a test uses to hand one queue's outstanding
 * work to the next, which is a restart with the crash left out.
 */
export class MemoryJobStore<TPayload> implements JobStore<TPayload> {
  readonly #jobs = new Map<string, StoredJob<TPayload>>();

  constructor(initial: Iterable<StoredJob<TPayload>> = []) {
    for (const job of initial) this.#jobs.set(job.id, job);
  }

  load(): Promise<readonly StoredJob<TPayload>[]> {
    const jobs = [...this.#jobs.values()].sort(
      (a, b) => a.enqueuedAt.getTime() - b.enqueuedAt.getTime(),
    );
    return Promise.resolve(jobs);
  }

  save(job: StoredJob<TPayload>): Promise<void> {
    this.#jobs.set(job.id, job);
    return Promise.resolve();
  }

  remove(id: string): Promise<void> {
    this.#jobs.delete(id);
    return Promise.resolve();
  }

  /** What is outstanding right now, without claiming it. For assertions. */
  snapshot(): readonly StoredJob<TPayload>[] {
    return [...this.#jobs.values()];
  }

  get size(): number {
    return this.#jobs.size;
  }
}
