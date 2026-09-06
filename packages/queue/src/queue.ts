/**
 * A bounded-concurrency job queue.
 *
 * The crawl loop is deliberately sequential — one request at a time, paced by a
 * politeness delay — because an audit crawler runs against someone else's
 * production site. That decision is about one crawl. It says nothing about how
 * many crawls a machine should run at once, and until now nothing did: a caller
 * with fifty sites to audit either ran them one after another or ran them all
 * at once and hoped. This is the missing piece between those two.
 *
 * Two rules do the work:
 *
 *   `concurrency` caps how many handlers run at the same time, which is what
 *   keeps a batch of audits from exhausting sockets, memory or the database
 *   pool on the machine doing the auditing.
 *
 *   `lane` caps how many run against the same *target*. Jobs sharing a lane are
 *   serialized whatever the concurrency budget allows, so two audits of one
 *   origin queue behind each other and the site sees the request rate the crawl
 *   loop promised it.
 *
 * Scheduling state stays in memory — which lane is busy, which slot just freed,
 * which job is next — because none of it needs to outlive the process. What
 * does is the fact that work was asked for and has not happened, and that goes
 * to an optional `JobStore`: written at enqueue, updated on every transition,
 * removed when the job settles, and read back by `recover` on the way up. With
 * one attached, a restart resumes what was queued instead of dropping it; with
 * none, the queue behaves exactly as it did before, which is what keeps it
 * usable in a test and in the offline analyzer. See `./store.ts` for what the
 * store does and does not promise.
 *
 * Retries are mechanism here and policy elsewhere. This file knows how to hold
 * a failed job back, wake it and run it again; it holds no opinion on which
 * failures deserve that, because the answer is about the work rather than about
 * scheduling it — a transport timeout, yes; a site that answered 403 to the
 * first request, almost never. Pass a `retry` policy and it is consulted; pass
 * none and a failed job settles as `failed` and stays that way.
 */

import { JobCancelledError } from './types.js';
import type { RetryPolicy } from './retry.js';
import type { JobStore, StoredJob } from './store.js';
import type { Job, JobEvent, JobHandler, JobState } from './types.js';

export interface JobQueueOptions<TPayload, TResult> {
  /** Maximum handlers running at once. Must be at least 1. */
  readonly concurrency: number;
  readonly handler: JobHandler<TPayload, TResult>;
  /**
   * Consulted after every failed attempt. Without one, nothing is retried.
   *
   * See `exponentialBackoff` for the usual shape. The policy may be async,
   * which is where a caller records the decision durably before the wait
   * starts — the job stays this queue's responsibility throughout.
   */
  readonly retry?: RetryPolicy<TPayload>;
  /**
   * Where outstanding jobs are written down, so a restart can resume them.
   *
   * Without one the queue is memory-only and a restart loses what was queued.
   * With one, `enqueue` is not durable until the returned handle's `stored`
   * resolves — await it when the caller needs the guarantee, ignore it when a
   * lost job is acceptable.
   */
  readonly store?: JobStore<TPayload>;
  /**
   * Called when a store write fails after the job was created.
   *
   * Those writes are best-effort by design: a job whose `running` update was
   * lost still runs, and the cost of the loss is that a restart runs it again.
   * Failing the job instead would turn a storage blip into a lost audit, which
   * is the thing the store exists to prevent. The handler is how an operator
   * finds out the store is unwell.
   */
  readonly onStoreError?: (error: unknown, job: Job<TPayload>) => void;
  /** Called on every state transition. Throwing from it never fails a job. */
  readonly onEvent?: (event: JobEvent<TPayload>) => void;
  /** Start paused, so a caller can enqueue a batch before anything runs. */
  readonly paused?: boolean;
  /**
   * How many finished jobs stay readable through `get` and `list`.
   *
   * Terminal jobs are kept so a caller can ask what happened, and evicted
   * oldest-first past this bound so a long-lived process does not accumulate
   * every audit it has ever run.
   */
  readonly historyLimit?: number;
  /** Injection seam for tests that assert on timestamps. */
  readonly now?: () => Date;
}

export interface EnqueueOptions {
  /** Supply one to make enqueueing idempotent against your own ids. */
  readonly id?: string;
  readonly priority?: number;
  readonly lane?: string | null;
}

export interface JobHandle<TPayload, TResult> {
  readonly id: string;
  /** The job as it stands now. */
  snapshot(): Job<TPayload>;
  /**
   * Resolves once the job is durable, and immediately when there is no store.
   *
   * This is the promise a caller awaits to mean "queued" honestly. Until it
   * settles the job cannot start, and if it rejects the job never runs and
   * `done` rejects with the same error — a job the store would not accept was
   * never really enqueued, and reporting it as queued would be the lie the
   * store was added to stop telling.
   */
  readonly stored: Promise<void>;
  /**
   * The handler's result. Rejects with whatever the handler threw, or with a
   * `JobCancelledError` if the job was cancelled.
   */
  readonly done: Promise<TResult>;
}

interface Entry<TPayload, TResult> {
  readonly id: string;
  readonly payload: TPayload;
  readonly lane: string | null;
  readonly priority: number;
  readonly enqueuedAt: Date;
  readonly controller: AbortController;
  readonly resolve: (result: TResult) => void;
  readonly reject: (cause: unknown) => void;
  /** Settled by `#settle`. Held on the entry because a recovered job has no handle. */
  readonly done: Promise<TResult>;
  state: JobState;
  attempt: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** Shown to callers as `nextAttemptAt`; stamped from the injected clock. */
  notBefore: Date | null;
  /**
   * The same instant on the real clock, which is what `setTimeout` and the
   * eligibility test in `#take` go by. The injected clock exists for the
   * timestamps a caller reads, and a test that freezes it must not thereby
   * freeze the queue.
   */
  dueAt: number | null;
  error: string | null;
  /** Set by `cancel` on a running job; read once the handler returns. */
  cancelRequested: boolean;
  /**
   * Whether the job's first store write has landed. A `pending` job is skipped
   * by `#take`, so nothing runs before it is durable.
   */
  durability: 'none' | 'pending' | 'stored';
  /**
   * Serializes this job's store writes. Transitions are generated faster than
   * a database answers, and two updates racing could leave the stored state
   * behind the real one — for a retry backoff, by the whole delay.
   */
  storeChain: Promise<void>;
}

const TERMINAL: ReadonlySet<JobState> = new Set<JobState>(['complete', 'failed', 'cancelled']);

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export class JobQueue<TPayload, TResult = void> {
  readonly concurrency: number;

  readonly #handler: JobHandler<TPayload, TResult>;
  readonly #retry: RetryPolicy<TPayload> | undefined;
  readonly #store: JobStore<TPayload> | undefined;
  readonly #onStoreError: ((error: unknown, job: Job<TPayload>) => void) | undefined;
  readonly #onEvent: ((event: JobEvent<TPayload>) => void) | undefined;
  readonly #now: () => Date;
  readonly #historyLimit: number;

  readonly #queued: Entry<TPayload, TResult>[] = [];
  readonly #active = new Set<Entry<TPayload, TResult>>();
  readonly #busyLanes = new Set<string>();
  readonly #byId = new Map<string, Entry<TPayload, TResult>>();
  /** Ids of finished jobs, oldest first, for bounded retention. */
  readonly #finished: string[] = [];
  readonly #idleWaiters: (() => void)[] = [];

  #paused: boolean;
  #closed = false;
  /** Failed jobs whose retry policy has not answered yet. Not idle. */
  #deciding = 0;
  /**
   * Store writes still in flight. Counted into `idle` so `drain` and `close`
   * wait for them: a caller that shuts down on drain and takes the process
   * with it would otherwise leave finished jobs stored, and a restart would
   * run them again.
   */
  #writes = 0;
  #recovered = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: JobQueueOptions<TPayload, TResult>) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new Error('concurrency must be a positive integer');
    }
    this.concurrency = options.concurrency;
    this.#handler = options.handler;
    this.#retry = options.retry;
    this.#store = options.store;
    this.#onStoreError = options.onStoreError;
    this.#onEvent = options.onEvent;
    this.#now = options.now ?? (() => new Date());
    this.#historyLimit = options.historyLimit ?? 500;
    this.#paused = options.paused ?? false;
  }

  /** Jobs waiting for a slot, including those waiting out a retry delay. */
  get queued(): number {
    return this.#queued.length;
  }

  /** Handlers currently running. */
  get running(): number {
    return this.#active.size;
  }

  get paused(): boolean {
    return this.#paused;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * True when nothing is waiting, running, awaiting a retry decision, or
   * still being written to the store.
   */
  get idle(): boolean {
    return (
      this.#queued.length === 0 &&
      this.#active.size === 0 &&
      this.#deciding === 0 &&
      this.#writes === 0
    );
  }

  /** Whether jobs are being written down at all. */
  get durable(): boolean {
    return this.#store !== undefined;
  }

  enqueue(payload: TPayload, options: EnqueueOptions = {}): JobHandle<TPayload, TResult> {
    if (this.#closed) throw new Error('cannot enqueue on a closed queue');

    const id = options.id ?? crypto.randomUUID();
    if (this.#byId.has(id)) throw new Error(`a job with id ${id} already exists`);

    const entry = this.#newEntry({
      id,
      payload,
      lane: options.lane ?? null,
      priority: options.priority ?? 0,
      enqueuedAt: this.#now(),
      attempt: 0,
      notBefore: null,
      error: null,
    });

    // The create is the one store write the queue refuses to treat as
    // best-effort, and the one it will not let a job outrun: until it lands the
    // job is skipped by `#take`, so nothing runs that a restart could not find.
    const stored = this.#create(entry);

    this.#admit(entry);
    return {
      id,
      snapshot: () => snapshot(entry),
      stored,
      done: entry.done,
    };
  }

  /**
   * Take back the outstanding jobs from the store and queue them.
   *
   * Call once, on the way up, before submitting anything new. Jobs come back
   * `queued` whatever they were when the process stopped, keeping their attempt
   * count, and one that was mid-retry keeps whatever is left of its backoff — a
   * wait that exists to give an outage time to clear is not served by a restart
   * cancelling it. Ids already known here are skipped, so a second call adds
   * nothing rather than duplicating work.
   *
   * Returns the jobs it queued, so a caller that keeps its own record of them
   * can bring that record back in line — @seo/scheduler puts each restored
   * audit's row back to `pending`, because a row still reading `running` from a
   * process that no longer exists is a status nobody can act on.
   */
  async recover(): Promise<readonly Job<TPayload>[]> {
    if (this.#store === undefined) return [];
    if (this.#recovered) throw new Error('recover has already run on this queue');
    if (this.#closed) throw new Error('cannot recover a closed queue');
    this.#recovered = true;

    const stored = await this.#store.load();
    const restored: Job<TPayload>[] = [];
    for (const job of stored) {
      if (this.#byId.has(job.id)) continue;

      const entry = this.#newEntry({
        id: job.id,
        payload: job.payload,
        lane: job.lane,
        priority: job.priority,
        enqueuedAt: job.enqueuedAt,
        attempt: job.attempt,
        notBefore: job.nextAttemptAt,
        error: job.error,
      });
      // It came out of the store, so it is already in it. Marking it stored
      // rather than writing it back keeps recovery a read.
      entry.durability = 'stored';
      if (job.nextAttemptAt !== null) {
        entry.dueAt = Math.max(Date.now(), job.nextAttemptAt.getTime());
      }

      this.#admit(entry);
      restored.push(snapshot(entry));
    }
    return restored;
  }

  /** Everything the queue would write down for `entry` as it stands. */
  #stored(entry: Entry<TPayload, TResult>): StoredJob<TPayload> {
    return {
      id: entry.id,
      payload: entry.payload,
      lane: entry.lane,
      priority: entry.priority,
      state: entry.state,
      attempt: entry.attempt,
      enqueuedAt: entry.enqueuedAt,
      nextAttemptAt: entry.notBefore,
      error: entry.error,
    };
  }

  #newEntry(seed: {
    readonly id: string;
    readonly payload: TPayload;
    readonly lane: string | null;
    readonly priority: number;
    readonly enqueuedAt: Date;
    readonly attempt: number;
    readonly notBefore: Date | null;
    readonly error: string | null;
  }): Entry<TPayload, TResult> {
    let resolve!: (result: TResult) => void;
    let reject!: (cause: unknown) => void;
    const done = new Promise<TResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // A caller is free to ignore `done` — a fire-and-forget batch is the normal
    // case, and a recovered job has no caller at all — so the rejection is
    // claimed here rather than left to crash the process as an unhandled one.
    // Awaiting `done` later still rejects.
    done.catch(() => {});

    return {
      id: seed.id,
      payload: seed.payload,
      lane: seed.lane,
      priority: seed.priority,
      enqueuedAt: seed.enqueuedAt,
      controller: new AbortController(),
      resolve,
      reject,
      done,
      state: 'queued',
      attempt: seed.attempt,
      startedAt: null,
      finishedAt: null,
      notBefore: seed.notBefore,
      dueAt: null,
      error: seed.error,
      cancelRequested: false,
      durability: this.#store === undefined ? 'none' : 'pending',
      storeChain: Promise.resolve(),
    };
  }

  #admit(entry: Entry<TPayload, TResult>): void {
    this.#byId.set(entry.id, entry);
    this.#queued.push(entry);
    this.#emit({ type: 'enqueued', job: snapshot(entry) });
    this.#pump();
  }

  /**
   * Write a new job down, and hold it back until that lands.
   *
   * A store that refuses the job fails it here rather than running it. The
   * caller was about to be told the work is queued, and a job that is not
   * written down is precisely the work a restart drops.
   */
  #create(entry: Entry<TPayload, TResult>): Promise<void> {
    const store = this.#store;
    if (store === undefined) return Promise.resolve();

    this.#writes += 1;
    const write = store.save(this.#stored(entry)).then(
      () => {
        entry.durability = 'stored';
      },
      (error: unknown) => {
        // Nothing has started, so there is nothing to stop: it never runs.
        const index = this.#queued.indexOf(entry);
        if (index >= 0) this.#queued.splice(index, 1);
        if (!TERMINAL.has(entry.state)) this.#settle(entry, 'failed', error);
        throw error;
      },
    );
    entry.storeChain = write.then(
      () => {},
      () => {},
    );

    const settled = write.finally(() => {
      this.#writes -= 1;
      this.#pump();
    });
    // Claimed here so a caller who ignores `stored` does not crash the process.
    settled.catch(() => {});
    return settled;
  }

  /**
   * Update or remove a stored job, behind that job's own earlier writes.
   *
   * Best-effort: a failure is reported and otherwise swallowed. By the time one
   * of these runs the job is already going or already over, and the worst a
   * lost write costs is that a restart sees a staler version of it than the
   * truth. Failing the job instead would turn a storage blip into a lost audit,
   * which is the thing the store exists to prevent.
   */
  #persist(entry: Entry<TPayload, TResult>, op: 'save' | 'remove'): void {
    const store = this.#store;
    if (store === undefined || entry.durability === 'none') return;

    const job = op === 'save' ? this.#stored(entry) : undefined;
    this.#writes += 1;
    entry.storeChain = entry.storeChain
      .then(() => (job === undefined ? store.remove(entry.id) : store.save(job)))
      .catch((error: unknown) => {
        this.#reportStoreError(error, entry);
      })
      .finally(() => {
        this.#writes -= 1;
        this.#checkIdle();
      });
  }

  /** A store that will not take a write is an operational fact, not a job's. */
  #reportStoreError(error: unknown, entry: Entry<TPayload, TResult>): void {
    if (this.#onStoreError === undefined) return;
    try {
      this.#onStoreError(error, snapshot(entry));
    } catch {
      // deliberately ignored
    }
  }

  /**
   * Cancel a job. A queued job never starts; a running one has its signal
   * aborted and settles as cancelled whenever its handler returns.
   *
   * Returns false when the job is unknown or already finished.
   */
  cancel(id: string): boolean {
    const entry = this.#byId.get(id);
    if (entry === undefined || TERMINAL.has(entry.state)) return false;

    if (entry.state === 'queued') {
      const index = this.#queued.indexOf(entry);
      if (index >= 0) this.#queued.splice(index, 1);
      this.#settle(entry, 'cancelled', new JobCancelledError(entry.id));
      this.#pump();
      return true;
    }

    entry.cancelRequested = true;
    entry.controller.abort(new JobCancelledError(entry.id));
    return true;
  }

  get(id: string): Job<TPayload> | undefined {
    const entry = this.#byId.get(id);
    return entry === undefined ? undefined : snapshot(entry);
  }

  /** Every job the queue still remembers, optionally filtered by state. */
  list(state?: JobState): readonly Job<TPayload>[] {
    const jobs: Job<TPayload>[] = [];
    for (const entry of this.#byId.values()) {
      if (state === undefined || entry.state === state) jobs.push(snapshot(entry));
    }
    return jobs;
  }

  /** Stop starting new jobs. Running ones are left alone. */
  pause(): void {
    this.#paused = true;
  }

  resume(): void {
    if (this.#closed) throw new Error('cannot resume a closed queue');
    this.#paused = false;
    this.#pump();
  }

  /**
   * Resolve once nothing is queued and nothing is running.
   *
   * A paused queue with work still waiting never drains; that is the honest
   * answer rather than a hidden resume.
   */
  drain(): Promise<void> {
    if (this.idle) return Promise.resolve();
    return new Promise((resolve) => {
      this.#idleWaiters.push(resolve);
    });
  }

  /**
   * Refuse new work, cancel what is still queued, signal what is running, and
   * resolve once every handler has returned.
   */
  async close(): Promise<void> {
    this.#closed = true;
    this.#paused = true;
    this.#scheduleWake();

    for (const entry of [...this.#queued]) this.cancel(entry.id);
    for (const entry of [...this.#active]) this.cancel(entry.id);

    // Not `#active.size`: a job whose handler has returned and whose retry
    // policy is still deciding belongs to nobody yet, and closing out from
    // under it would report the queue as done while a job was still settling.
    if (!this.idle) await this.drain();
  }

  #pump(): void {
    while (!this.#paused && this.#active.size < this.concurrency) {
      const entry = this.#take();
      if (entry === undefined) break;
      void this.#run(entry);
    }
    this.#scheduleWake();
    this.#checkIdle();
  }

  /**
   * Wake the queue when the earliest pending retry comes due.
   *
   * One timer for the whole queue rather than one per job: the set changes on
   * every pump, and a single timer is the version that cannot leak.
   */
  #scheduleWake(): void {
    if (this.#retryTimer !== undefined) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
    if (this.#paused || this.#closed) return;

    const now = Date.now();
    let earliest: number | undefined;
    for (const entry of this.#queued) {
      if (entry.durability === 'pending') continue;
      if (entry.dueAt === null || entry.dueAt <= now) continue;
      if (earliest === undefined || entry.dueAt < earliest) earliest = entry.dueAt;
    }
    if (earliest === undefined) return;

    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      this.#pump();
    }, earliest - now);
  }

  /**
   * The highest-priority queued job whose lane is free, in enqueue order among
   * equals. Skipping a lane-blocked job rather than stopping at it is what lets
   * a queue full of jobs for one busy origin still make progress on others.
   */
  #take(): Entry<TPayload, TResult> | undefined {
    let best = -1;
    for (let i = 0; i < this.#queued.length; i += 1) {
      const candidate = this.#queued[i];
      if (candidate === undefined) continue;
      if (candidate.durability === 'pending') continue;
      if (candidate.lane !== null && this.#busyLanes.has(candidate.lane)) continue;
      if (candidate.dueAt !== null && candidate.dueAt > Date.now()) continue;
      const incumbent = best === -1 ? undefined : this.#queued[best];
      if (incumbent === undefined || candidate.priority > incumbent.priority) best = i;
    }
    if (best === -1) return undefined;
    return this.#queued.splice(best, 1)[0];
  }

  async #run(entry: Entry<TPayload, TResult>): Promise<void> {
    entry.state = 'running';
    entry.attempt += 1;
    entry.startedAt = this.#now();
    entry.notBefore = null;
    entry.dueAt = null;
    this.#active.add(entry);
    if (entry.lane !== null) this.#busyLanes.add(entry.lane);
    // Recorded before the handler is called, and not awaited. The attempt
    // number is the part that matters: a job that takes the process down with
    // it must come back having used an attempt, or a poison payload would be
    // retried by every restart forever.
    this.#persist(entry, 'save');
    this.#emit({ type: 'started', job: snapshot(entry) });

    let result: TResult | undefined;
    let cause: unknown;
    let threw = false;
    try {
      result = await this.#handler(entry.payload, {
        job: snapshot(entry),
        signal: entry.controller.signal,
      });
    } catch (error) {
      threw = true;
      cause = error;
    }

    // The slot and the lane are given back before the retry policy is asked. A
    // policy that goes to the database to record its decision must not hold a
    // worker open, and must not keep another audit of the same origin waiting
    // behind a job that is no longer doing anything.
    this.#active.delete(entry);
    if (entry.lane !== null) this.#busyLanes.delete(entry.lane);

    // A handler that threw because it was cancelled reports as cancelled, not
    // as a site or engine failure. The distinction matters: a failed audit is
    // something to investigate, a cancelled one is something someone did.
    if (entry.cancelRequested) {
      this.#settle(entry, 'cancelled', new JobCancelledError(entry.id));
    } else if (!threw) {
      this.#settle(entry, 'complete', undefined, result as TResult);
    } else {
      // Counted as deciding from here until the job is settled or requeued.
      // In between it is in no collection at all, and a queue that called
      // itself idle in that window would let `drain` resolve on a job that is
      // about to run again.
      this.#deciding += 1;
      try {
        const delayMs = await this.#retryDelay(entry, cause);
        // Cancellation can land while the policy is deciding, and it wins: a
        // job someone stopped does not come back because a policy asked for it.
        if (entry.cancelRequested) {
          this.#settle(entry, 'cancelled', new JobCancelledError(entry.id));
        } else if (delayMs === null) {
          this.#settle(entry, 'failed', cause);
        } else {
          this.#requeue(entry, cause, delayMs);
        }
      } finally {
        this.#deciding -= 1;
      }
    }

    this.#pump();
  }

  /**
   * Ask the policy how long to wait, or `null` for "let it fail".
   *
   * A policy that throws, or answers with something that is not a usable
   * delay, fails the job. Holding work open on a broken policy would turn a
   * reporting bug into a job that never settles.
   */
  async #retryDelay(entry: Entry<TPayload, TResult>, cause: unknown): Promise<number | null> {
    if (this.#retry === undefined || this.#closed) return null;

    try {
      const delayMs = await this.#retry({
        job: snapshot(entry),
        cause,
        attempt: entry.attempt,
      });
      if (delayMs === null || !Number.isFinite(delayMs) || delayMs < 0) return null;
      return delayMs;
    } catch {
      return null;
    }
  }

  /** Put a failed job back in line, eligible once its delay has elapsed. */
  #requeue(entry: Entry<TPayload, TResult>, cause: unknown, delayMs: number): void {
    entry.state = 'queued';
    entry.startedAt = null;
    entry.finishedAt = null;
    entry.error = messageOf(cause);
    entry.notBefore = new Date(this.#now().getTime() + delayMs);
    entry.dueAt = Date.now() + delayMs;
    this.#queued.push(entry);
    this.#persist(entry, 'save');
    this.#emit({ type: 'retrying', job: snapshot(entry), cause, delayMs });
  }

  #settle(
    entry: Entry<TPayload, TResult>,
    state: 'complete' | 'failed' | 'cancelled',
    cause?: unknown,
    result?: TResult,
  ): void {
    entry.state = state;
    entry.finishedAt = this.#now();

    if (state === 'complete') {
      this.#emit({ type: 'completed', job: snapshot(entry) });
      entry.resolve(result as TResult);
    } else if (state === 'failed') {
      entry.error = messageOf(cause);
      this.#emit({ type: 'failed', job: snapshot(entry), cause });
      entry.reject(cause);
    } else {
      this.#emit({ type: 'cancelled', job: snapshot(entry) });
      entry.reject(cause);
    }

    this.#persist(entry, 'remove');
    this.#remember(entry.id);
  }

  #remember(id: string): void {
    this.#finished.push(id);
    while (this.#finished.length > this.#historyLimit) {
      const evicted = this.#finished.shift();
      if (evicted !== undefined) this.#byId.delete(evicted);
    }
  }

  #checkIdle(): void {
    if (!this.idle) return;
    const waiters = this.#idleWaiters.splice(0, this.#idleWaiters.length);
    for (const resolve of waiters) resolve();
  }

  /** A listener that throws is a reporting bug, never a reason to fail a job. */
  #emit(event: JobEvent<TPayload>): void {
    if (this.#onEvent === undefined) return;
    try {
      this.#onEvent(event);
    } catch {
      // deliberately ignored
    }
  }
}

function snapshot<TPayload, TResult>(entry: Entry<TPayload, TResult>): Job<TPayload> {
  return Object.freeze({
    id: entry.id,
    payload: entry.payload,
    lane: entry.lane,
    priority: entry.priority,
    state: entry.state,
    attempt: entry.attempt,
    enqueuedAt: entry.enqueuedAt,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    nextAttemptAt: entry.notBefore,
    error: entry.error,
  });
}
