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

import { JobLeaseLostError } from './types.js';
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
   * Every job that has not finished and that this owner may run, oldest first.
   *
   * Called once by `JobQueue.recover`. An implementation backed by shared
   * storage claims what it returns, so a second process reading the same store
   * does not hand out the same work twice. A store that leases its jobs returns
   * only what is free — unclaimed, already this owner's, or held by a lease
   * that has expired — and leaves the rest to whoever is still holding them.
   */
  load(): Promise<readonly StoredJob<TPayload>[]>;
  /** Write a job, creating it or replacing what is stored under its id. */
  save(job: StoredJob<TPayload>): Promise<void>;
  /** Forget a job. Removing one that is not there is not an error. */
  remove(id: string): Promise<void>;
  /**
   * Refresh this owner's claim on the jobs it is still working, and report
   * which of them it has lost.
   *
   * Optional, and the whole of what makes a namespace shareable. A lease says
   * "this worker holds this job until then", and a worker that has stopped —
   * crashed, wedged, cut off from the database — stops saying it, so the claim
   * ages out and another worker may take the job. That is only safe if a worker
   * still alive keeps renewing, and only honest if a worker whose claim was
   * taken finds out. This method is both halves.
   *
   * Returns the subset of `ids` this owner no longer holds: taken by another
   * worker, or gone from the store entirely. The queue stops those jobs and
   * writes nothing further about them.
   *
   * A store without leases leaves this undefined, and a queue given one never
   * asks. That is the single-owner arrangement, unchanged.
   */
  renew?(ids: readonly string[]): Promise<readonly string[]>;
  /**
   * Write a job down as running, unless another worker is running one in its
   * lane. Returns false, having written nothing, when one is.
   *
   * Optional, and the other half of sharing a namespace. The queue keeps its
   * lanes in memory, which serializes a lane within one process and says
   * nothing about the next: two workers each handed an audit of one site would
   * each find the lane free and crawl it together, which is the load the lane
   * exists to refuse. This is the question asked of the one place both workers
   * can see.
   *
   * "Another worker" is exact. A running job in the lane blocks only while the
   * claim on it is live — a dead worker's row ages out with its lease, as its
   * work does — and only when someone else holds it: this owner's own jobs are
   * the queue's lane bookkeeping to track, and counting them here would stall
   * a job behind the removal of its predecessor's row.
   *
   * Throws `JobLeaseLostError` when the job itself is held elsewhere. A queue
   * that does not lease never asks, and neither does one running a job with no
   * lane.
   */
  acquire?(job: StoredJob<TPayload>): Promise<boolean>;
  /**
   * Every outstanding job id in this namespace, whoever holds it.
   *
   * Optional, and deliberately not a claim: it is how a caller tells "nothing
   * is going to run this" apart from "someone else is". @seo/scheduler's
   * `reconcile` uses it so a second worker's audits are not closed out from
   * under it as abandoned.
   */
  outstanding?(): Promise<readonly string[]>;
}

/** What a store remembers about who holds a job, and since when. */
interface Lease {
  readonly owner: string;
  readonly leasedAt: number;
}

export interface MemoryJobStoreOptions<TPayload> {
  /** Which worker this handle speaks for. Only matters with `leaseMs`. */
  readonly owner?: string;
  /**
   * How long a claim stands without being renewed. Omit for no leases at all,
   * which is the single-owner behaviour: `load` claims everything it finds.
   */
  readonly leaseMs?: number;
  /** Injection seam for a test that needs to age a lease without waiting. */
  readonly now?: () => number;
  /**
   * The state another handle on the same store already holds.
   *
   * Not for callers to build — `withOwner` passes it. Two handles sharing this
   * are two workers sharing one store, which is what a lease test needs and
   * what a table gives you for free.
   */
  readonly shared?: {
    readonly jobs: Map<string, StoredJob<TPayload>>;
    readonly leases: Map<string, Lease>;
  };
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
  readonly #jobs: Map<string, StoredJob<TPayload>>;
  readonly #leases: Map<string, Lease>;
  readonly #owner: string;
  readonly #leaseMs: number | undefined;
  readonly #now: () => number;

  constructor(
    initial: Iterable<StoredJob<TPayload>> = [],
    options: MemoryJobStoreOptions<TPayload> = {},
  ) {
    this.#jobs = options.shared?.jobs ?? new Map();
    this.#leases = options.shared?.leases ?? new Map();
    this.#owner = options.owner ?? 'memory';
    this.#leaseMs = options.leaseMs;
    this.#now = options.now ?? (() => Date.now());
    for (const job of initial) this.#jobs.set(job.id, job);
  }

  /** Who this handle claims jobs as. */
  get owner(): string {
    return this.#owner;
  }

  /**
   * A second handle on the same jobs, speaking for a different worker.
   *
   * This is what makes two workers testable without two processes: the stored
   * state is shared exactly as a table is, and the handles agree about nothing
   * else.
   */
  withOwner(owner: string): MemoryJobStore<TPayload> {
    return new MemoryJobStore<TPayload>([], {
      owner,
      ...(this.#leaseMs === undefined ? {} : { leaseMs: this.#leaseMs }),
      now: this.#now,
      shared: { jobs: this.#jobs, leases: this.#leases },
    });
  }

  /** Whether someone else's claim on this job is still standing. */
  #heldByAnother(id: string): boolean {
    if (this.#leaseMs === undefined) return false;
    const lease = this.#leases.get(id);
    if (lease === undefined || lease.owner === this.#owner) return false;
    return this.#now() - lease.leasedAt < this.#leaseMs;
  }

  #claim(id: string): void {
    this.#leases.set(id, { owner: this.#owner, leasedAt: this.#now() });
  }

  load(): Promise<readonly StoredJob<TPayload>[]> {
    const jobs = [...this.#jobs.values()]
      .filter((job) => !this.#heldByAnother(job.id))
      .sort((a, b) => a.enqueuedAt.getTime() - b.enqueuedAt.getTime());
    for (const job of jobs) {
      this.#claim(job.id);
      // The queue takes these back as queued, so the record says so too: a row
      // still reading `running` would hold its lane against every other worker
      // for as long as the job waits here for a slot.
      this.#jobs.set(job.id, { ...job, state: 'queued' });
    }
    return Promise.resolve(jobs);
  }

  acquire(job: StoredJob<TPayload>): Promise<boolean> {
    if (job.lane !== null && this.#leaseMs !== undefined) {
      for (const other of this.#jobs.values()) {
        if (other.id === job.id || other.lane !== job.lane || other.state !== 'running') continue;
        if (this.#heldByAnother(other.id)) return Promise.resolve(false);
      }
    }
    return this.save(job).then(() => true);
  }

  save(job: StoredJob<TPayload>): Promise<void> {
    // Refused rather than merged: the row is another worker's now, and the
    // version this handle holds describes a run that worker has taken over.
    if (this.#heldByAnother(job.id)) {
      return Promise.reject(new JobLeaseLostError(job.id));
    }
    this.#jobs.set(job.id, job);
    this.#claim(job.id);
    return Promise.resolve();
  }

  remove(id: string): Promise<void> {
    if (this.#heldByAnother(id)) return Promise.resolve();
    this.#jobs.delete(id);
    this.#leases.delete(id);
    return Promise.resolve();
  }

  renew(ids: readonly string[]): Promise<readonly string[]> {
    const lost: string[] = [];
    for (const id of ids) {
      if (!this.#jobs.has(id) || this.#heldByAnother(id)) {
        lost.push(id);
        continue;
      }
      this.#claim(id);
    }
    return Promise.resolve(lost);
  }

  outstanding(): Promise<readonly string[]> {
    return Promise.resolve([...this.#jobs.keys()]);
  }

  /** What is outstanding right now, without claiming it. For assertions. */
  snapshot(): readonly StoredJob<TPayload>[] {
    return [...this.#jobs.values()];
  }

  get size(): number {
    return this.#jobs.size;
  }
}
