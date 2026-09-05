/**
 * Retry policy: whether a failed job runs again, and when.
 *
 * The queue deliberately holds no opinion here. Which failures deserve a
 * repeat is a question about the work, not about scheduling it — a transport
 * timeout is worth another go, a request that came back 403 on the first hop
 * will come back 403 on the fourth, and a queue that guessed would bury that
 * judgement somewhere nobody looks. So the mechanism lives in `JobQueue` and
 * the decision arrives as a function the caller wrote.
 *
 * A policy answers with a delay in milliseconds, or `null` for "this one is
 * over". It may be async, which is the seam a caller uses to record the
 * decision somewhere durable before the delay starts — @seo/scheduler puts the
 * audit row back to `pending` there, so a status endpoint never reports an
 * audit as failed while another attempt is already scheduled.
 */

import { JobCancelledError } from './types.js';
import type { Job } from './types.js';

export interface RetryAttempt<TPayload> {
  /** The job as it stands, with `attempt` and `error` from the failed run. */
  readonly job: Job<TPayload>;
  /** Whatever the handler threw. */
  readonly cause: unknown;
  /** Attempts made so far, including the one that just failed. First is 1. */
  readonly attempt: number;
}

/**
 * Milliseconds to wait before running the job again, or `null` to let it fail.
 *
 * A policy that throws is treated as `null`: a broken policy must not be able
 * to hold a job open forever.
 */
export type RetryPolicy<TPayload> = (
  attempt: RetryAttempt<TPayload>,
) => number | null | Promise<number | null>;

export interface ExponentialBackoffOptions<TPayload> {
  /** Total attempts, first one included. `1` means no retries at all. */
  readonly maxAttempts: number;
  /** Delay after the first failure. Doubles from there by default. */
  readonly baseMs?: number;
  readonly factor?: number;
  /** Ceiling on the computed delay, before jitter. */
  readonly maxMs?: number;
  /**
   * Proportional spread, 0 to 1. At 0.2 a delay lands anywhere in ±20% of the
   * computed one.
   *
   * This is not decoration. Ten audits of one origin that all failed on the
   * same outage would otherwise retry in lockstep and hit the site again as a
   * burst — the thing the crawl loop's politeness delay exists to prevent.
   */
  readonly jitter?: number;
  /** Which failures are worth repeating. Everything but cancellation, by default. */
  readonly retryable?: (cause: unknown, job: Job<TPayload>) => boolean;
  /** Injection seam for tests. */
  readonly random?: () => number;
}

const DEFAULTS = {
  baseMs: 1_000,
  factor: 2,
  maxMs: 60_000,
  jitter: 0.2,
};

/** A cancelled job is something someone did, never something to repeat. */
const defaultRetryable = (cause: unknown): boolean => !(cause instanceof JobCancelledError);

/**
 * The usual policy: a capped number of attempts, backing off exponentially
 * with jitter.
 */
export function exponentialBackoff<TPayload>(
  options: ExponentialBackoffOptions<TPayload>,
): RetryPolicy<TPayload> {
  const { maxAttempts } = options;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive integer');
  }

  const baseMs = options.baseMs ?? DEFAULTS.baseMs;
  const factor = options.factor ?? DEFAULTS.factor;
  const maxMs = options.maxMs ?? DEFAULTS.maxMs;
  const jitter = options.jitter ?? DEFAULTS.jitter;
  if (jitter < 0 || jitter > 1) throw new Error('jitter must be between 0 and 1');

  const retryable = options.retryable ?? ((cause: unknown) => defaultRetryable(cause));
  const random = options.random ?? Math.random;

  return ({ job, cause, attempt }) => {
    if (attempt >= maxAttempts) return null;
    if (!retryable(cause, job)) return null;

    const raw = Math.min(baseMs * factor ** (attempt - 1), maxMs);
    const spread = raw * jitter * (random() * 2 - 1);
    return Math.max(0, Math.round(raw + spread));
  };
}
