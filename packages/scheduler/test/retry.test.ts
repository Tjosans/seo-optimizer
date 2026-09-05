/**
 * Which audit failures come back for another go.
 *
 * No database here: the classification is the whole subject, and it is a
 * decision about the failure, not about the row it will be written to.
 */

import { describe, expect, it } from 'vitest';
import { CorpusVersionMismatchError } from '@seo/grader';
import { JobCancelledError } from '@seo/queue';
import type { Job } from '@seo/queue';
import {
  auditRetryPolicy,
  isPermanentAuditFailure,
  PermanentAuditError,
  UnknownSiteError,
} from '@seo/scheduler';
import type { AuditJob } from '@seo/scheduler';

describe('isPermanentAuditFailure', () => {
  it('refuses to repeat what a repeat cannot fix', () => {
    const permanent: unknown[] = [
      new JobCancelledError('audit-1'),
      new PermanentAuditError('no corpus 4.4 on disk'),
      new UnknownSiteError('site-1'),
      new CorpusVersionMismatchError('4.4', '4.5'),
      new TypeError("cannot read properties of undefined (reading 'pages')"),
      new RangeError('maximum call stack size exceeded'),
    ];
    for (const cause of permanent) expect(isPermanentAuditFailure(cause)).toBe(true);
  });

  it('treats an unrecognised failure as worth one more attempt', () => {
    // The bias is deliberate. A blip retried costs one more crawl of a site
    // already under audit; a blip written off loses the audit entirely.
    expect(isPermanentAuditFailure(new Error('connection terminated unexpectedly'))).toBe(false);
    expect(isPermanentAuditFailure('ECONNRESET')).toBe(false);
    expect(isPermanentAuditFailure(undefined)).toBe(false);
  });
});

describe('auditRetryPolicy', () => {
  const attempt = (n: number, cause: unknown) => ({
    job: job(n),
    cause,
    attempt: n,
  });

  it('backs off across three attempts and then stops', () => {
    const policy = auditRetryPolicy({ jitter: 0 });
    const transient = new Error('connection terminated unexpectedly');

    expect(policy(attempt(1, transient))).toBe(30_000);
    expect(policy(attempt(2, transient))).toBe(120_000);
    expect(policy(attempt(3, transient))).toBeNull();
  });

  it('stops at the first attempt for a permanent failure', () => {
    const policy = auditRetryPolicy({ jitter: 0 });
    expect(policy(attempt(1, new UnknownSiteError('site-1')))).toBeNull();
  });

  it('lets a caller decide for itself', () => {
    const policy = auditRetryPolicy({
      maxAttempts: 2,
      baseMs: 5,
      jitter: 0,
      retryable: () => false,
    });
    expect(policy(attempt(1, new Error('anything at all')))).toBeNull();
  });
});

const job = (attempt: number): Job<AuditJob> => ({
  id: 'audit-1',
  payload: {
    auditId: 'audit-1',
    siteId: 'site-1',
    origin: 'https://example.com',
    flags: [],
    corpusVersion: '4.4',
    options: { seeds: ['https://example.com/'], userAgent: 'test' },
  },
  lane: 'https://example.com',
  priority: 0,
  state: 'running',
  attempt,
  enqueuedAt: new Date(0),
  startedAt: new Date(0),
  finishedAt: null,
  nextAttemptAt: null,
  error: null,
});
