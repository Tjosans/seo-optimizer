/**
 * Which audit failures are worth repeating.
 *
 * The queue can hold a failed job back and run it again; it refuses to guess
 * which failures deserve that, and this file is where the guess stops being one.
 * The rule is about what a repeat can possibly fix:
 *
 *   A repeat can fix a failure that was about *this moment* — a database
 *   connection reset mid-crawl, a socket that hung up, a machine briefly out of
 *   file handles. Those are the failures an audit hits by being long-running
 *   work over a network, and running the same audit twenty seconds later is a
 *   reasonable answer to all of them.
 *
 *   A repeat cannot fix a failure that was about *this audit*. A site id that
 *   names no row, a corpus version this process cannot produce, a bug in the
 *   engine: those come back identically however many times they are run, and
 *   retrying them spends a site's bandwidth to learn nothing.
 *
 * So permanence is enumerated and everything else is retried. That direction is
 * deliberate. An unrecognised failure retried three times costs one extra crawl
 * of a site that is already being audited; an unrecognised failure written off
 * as permanent loses an audit to a blip nobody will ever see the cause of.
 *
 * Note what is *not* here. A site that answers 403, times out, or serves a
 * broken page does not fail an audit at all — `@seo/crawler` returns transport
 * failures as data, because a site that will not answer is a finding rather
 * than an exception. Those audits complete, and the report says what happened.
 * By the time a failure reaches this file, something in the engine or its
 * infrastructure fell over, not the site under audit.
 */

import { CorpusVersionMismatchError } from '@seo/grader';
import { exponentialBackoff, JobCancelledError } from '@seo/queue';
import type { RetryPolicy } from '@seo/queue';
import { UnknownSiteError } from './types.js';
import type { AuditJob } from './types.js';

/**
 * A failure that will happen again for the same reason.
 *
 * Throw it from a corpus source, or from anything else the scheduler calls,
 * to say "do not bother repeating this". The scheduler treats every other
 * unrecognised failure as worth one more attempt.
 */
export class PermanentAuditError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentAuditError';
  }
}

/**
 * Errors a runtime raises about the program rather than about the world.
 * A repeat runs the same code against the same input and lands here again.
 */
const isProgrammerError = (cause: unknown): boolean =>
  cause instanceof TypeError ||
  cause instanceof RangeError ||
  cause instanceof ReferenceError ||
  cause instanceof SyntaxError;

/** True when running this audit again cannot change the outcome. */
export function isPermanentAuditFailure(cause: unknown): boolean {
  return (
    // Not a failure at all: someone stopped it.
    cause instanceof JobCancelledError ||
    cause instanceof PermanentAuditError ||
    cause instanceof UnknownSiteError ||
    cause instanceof CorpusVersionMismatchError ||
    isProgrammerError(cause)
  );
}

export interface AuditRetryOptions {
  /** Total attempts, the first included. Defaults to 3. */
  readonly maxAttempts?: number;
  /** Wait after the first failure. Defaults to 30 seconds. */
  readonly baseMs?: number;
  readonly factor?: number;
  /** Ceiling on the wait. Defaults to 10 minutes. */
  readonly maxMs?: number;
  readonly jitter?: number;
  /** Overrides the permanence rule above, for a caller who knows better. */
  readonly retryable?: (cause: unknown) => boolean;
}

const DEFAULTS = {
  maxAttempts: 3,
  /**
   * Half a minute, not half a second. Every failure that reaches here cost a
   * crawl of somebody's site, so the retry is worth spacing out far enough
   * that whatever fell over has a chance to have got back up.
   */
  baseMs: 30_000,
  factor: 4,
  maxMs: 600_000,
};

/**
 * The scheduler's default: three attempts, backing off from 30 seconds, and
 * only for failures a repeat could plausibly fix.
 */
export function auditRetryPolicy(options: AuditRetryOptions = {}): RetryPolicy<AuditJob> {
  const retryable = options.retryable ?? ((cause: unknown) => !isPermanentAuditFailure(cause));

  return exponentialBackoff<AuditJob>({
    maxAttempts: options.maxAttempts ?? DEFAULTS.maxAttempts,
    baseMs: options.baseMs ?? DEFAULTS.baseMs,
    factor: options.factor ?? DEFAULTS.factor,
    maxMs: options.maxMs ?? DEFAULTS.maxMs,
    ...(options.jitter === undefined ? {} : { jitter: options.jitter }),
    retryable: (cause) => retryable(cause),
  });
}
