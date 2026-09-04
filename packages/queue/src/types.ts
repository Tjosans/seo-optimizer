/**
 * The vocabulary of a queued unit of work.
 *
 * `JobState` deliberately mirrors `crawlStatusEnum` in @seo/db. A crawl that is
 * queued in this process and a crawl row in Postgres describe the same thing at
 * two altitudes, and a report that has to explain "why did this audit never
 * finish" is only readable if both use one set of words.
 */

/** Lifecycle of one job. Terminal states are complete, failed and cancelled. */
export type JobState = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';

export interface Job<TPayload> {
  readonly id: string;
  readonly payload: TPayload;
  /**
   * Mutual-exclusion key. Two jobs sharing a lane never run at the same time,
   * however much concurrency is available.
   *
   * For a crawl the lane is the site's origin. The crawl loop paces itself with
   * a politeness delay measured between its own requests; two workers crawling
   * one origin would each honour that delay and together still double the load
   * the site agreed to. Serializing per origin is what keeps the guarantee the
   * crawler makes true once more than one crawl is in flight.
   */
  readonly lane: string | null;
  /** Higher runs first. Jobs of equal priority run in enqueue order. */
  readonly priority: number;
  readonly state: JobState;
  readonly enqueuedAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  /** Message of the failure, when the state is `failed`. */
  readonly error: string | null;
}

export interface JobContext<TPayload> {
  /** Snapshot as of the moment the handler was called. */
  readonly job: Job<TPayload>;
  /**
   * Aborted when the job is cancelled or the queue is closed.
   *
   * Cancellation is cooperative: nothing here can interrupt a handler that
   * ignores the signal, and the job stays `running` until the handler returns.
   */
  readonly signal: AbortSignal;
}

export type JobHandler<TPayload, TResult> = (
  payload: TPayload,
  context: JobContext<TPayload>,
) => Promise<TResult> | TResult;

/** Emitted on every state transition, for logging and for a future scheduler. */
export type JobEvent<TPayload> =
  | { readonly type: 'enqueued'; readonly job: Job<TPayload> }
  | { readonly type: 'started'; readonly job: Job<TPayload> }
  | { readonly type: 'completed'; readonly job: Job<TPayload> }
  | { readonly type: 'failed'; readonly job: Job<TPayload>; readonly cause: unknown }
  | { readonly type: 'cancelled'; readonly job: Job<TPayload> };

/** Rejection reason for a job cancelled before or during its run. */
export class JobCancelledError extends Error {
  readonly jobId: string;

  constructor(jobId: string) {
    super(`job ${jobId} was cancelled`);
    this.name = 'JobCancelledError';
    this.jobId = jobId;
  }
}
