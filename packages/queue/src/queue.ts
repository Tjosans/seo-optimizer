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
 * The queue is in-process and holds its state in memory: a restart loses what
 * was queued. That is the same trade the crawl loop makes and it is fine for a
 * library, but it is why an API-triggered scheduler needs a durable store
 * behind this before it can promise an audit will actually run (ROADMAP Phase
 * 4). The public surface here is the seam that change goes through.
 *
 * Not here, on purpose: retries. A failed job settles as `failed` and stays
 * that way. Retry policy is its own roadmap item, and guessing at one now would
 * mean guessing which failures are worth repeating — a transport timeout, yes;
 * a site that answered 403 to the first request, almost never.
 */

import { JobCancelledError } from './types.js';
import type { Job, JobEvent, JobHandler, JobState } from './types.js';

export interface JobQueueOptions<TPayload, TResult> {
  /** Maximum handlers running at once. Must be at least 1. */
  readonly concurrency: number;
  readonly handler: JobHandler<TPayload, TResult>;
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
  state: JobState;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  /** Set by `cancel` on a running job; read once the handler returns. */
  cancelRequested: boolean;
}

const TERMINAL: ReadonlySet<JobState> = new Set<JobState>(['complete', 'failed', 'cancelled']);

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export class JobQueue<TPayload, TResult = void> {
  readonly concurrency: number;

  readonly #handler: JobHandler<TPayload, TResult>;
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

  constructor(options: JobQueueOptions<TPayload, TResult>) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new Error('concurrency must be a positive integer');
    }
    this.concurrency = options.concurrency;
    this.#handler = options.handler;
    this.#onEvent = options.onEvent;
    this.#now = options.now ?? (() => new Date());
    this.#historyLimit = options.historyLimit ?? 500;
    this.#paused = options.paused ?? false;
  }

  /** Jobs waiting for a slot. */
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

  /** True when nothing is waiting and nothing is running. */
  get idle(): boolean {
    return this.#queued.length === 0 && this.#active.size === 0;
  }

  enqueue(payload: TPayload, options: EnqueueOptions = {}): JobHandle<TPayload, TResult> {
    if (this.#closed) throw new Error('cannot enqueue on a closed queue');

    const id = options.id ?? crypto.randomUUID();
    if (this.#byId.has(id)) throw new Error(`a job with id ${id} already exists`);

    let resolve!: (result: TResult) => void;
    let reject!: (cause: unknown) => void;
    const done = new Promise<TResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // A caller is free to ignore `done` — a fire-and-forget batch is the normal
    // case — so the rejection is claimed here rather than left to crash the
    // process as an unhandled one. Awaiting `done` later still rejects.
    done.catch(() => {});

    const entry: Entry<TPayload, TResult> = {
      id,
      payload,
      lane: options.lane ?? null,
      priority: options.priority ?? 0,
      enqueuedAt: this.#now(),
      controller: new AbortController(),
      resolve,
      reject,
      state: 'queued',
      startedAt: null,
      finishedAt: null,
      error: null,
      cancelRequested: false,
    };

    this.#byId.set(id, entry);
    this.#queued.push(entry);
    this.#emit({ type: 'enqueued', job: snapshot(entry) });
    this.#pump();

    return {
      id,
      snapshot: () => snapshot(entry),
      done,
    };
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

    for (const entry of [...this.#queued]) this.cancel(entry.id);
    for (const entry of [...this.#active]) this.cancel(entry.id);

    if (this.#active.size > 0) await this.drain();
  }

  #pump(): void {
    while (!this.#paused && this.#active.size < this.concurrency) {
      const entry = this.#take();
      if (entry === undefined) break;
      void this.#run(entry);
    }
    this.#checkIdle();
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
      if (candidate.lane !== null && this.#busyLanes.has(candidate.lane)) continue;
      const incumbent = best === -1 ? undefined : this.#queued[best];
      if (incumbent === undefined || candidate.priority > incumbent.priority) best = i;
    }
    if (best === -1) return undefined;
    return this.#queued.splice(best, 1)[0];
  }

  async #run(entry: Entry<TPayload, TResult>): Promise<void> {
    entry.state = 'running';
    entry.startedAt = this.#now();
    this.#active.add(entry);
    if (entry.lane !== null) this.#busyLanes.add(entry.lane);
    this.#emit({ type: 'started', job: snapshot(entry) });

    try {
      const result = await this.#handler(entry.payload, {
        job: snapshot(entry),
        signal: entry.controller.signal,
      });
      if (entry.cancelRequested) this.#settle(entry, 'cancelled', new JobCancelledError(entry.id));
      else this.#settle(entry, 'complete', undefined, result);
    } catch (cause) {
      // A handler that threw because it was cancelled reports as cancelled, not
      // as a site or engine failure. The distinction matters: a failed audit is
      // something to investigate, a cancelled one is something someone did.
      if (entry.cancelRequested) this.#settle(entry, 'cancelled', new JobCancelledError(entry.id));
      else this.#settle(entry, 'failed', cause);
    } finally {
      this.#active.delete(entry);
      if (entry.lane !== null) this.#busyLanes.delete(entry.lane);
      this.#pump();
    }
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
    enqueuedAt: entry.enqueuedAt,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    error: entry.error,
  });
}
