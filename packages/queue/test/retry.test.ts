/**
 * Retries: the mechanism in the queue, and the policy handed to it.
 *
 * The delays here are a few milliseconds because the point of each test is the
 * decision, not the wait. What the wait itself has to prove — that a job held
 * back is genuinely not running, and that the slot and the lane are free while
 * it waits — is asserted directly rather than by sleeping and hoping.
 */

import { describe, expect, it, vi } from 'vitest';
import { exponentialBackoff, JobCancelledError, JobQueue } from '@seo/queue';
import type { JobEvent } from '@seo/queue';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

describe('retrying a failed job', () => {
  it('runs it again until it succeeds, counting the attempts', async () => {
    const attempts: number[] = [];
    const queue = new JobQueue<string, string>({
      concurrency: 1,
      retry: exponentialBackoff({ maxAttempts: 3, baseMs: 1, jitter: 0 }),
      handler: (payload, context) => {
        attempts.push(context.job.attempt);
        if (context.job.attempt < 3) throw new Error(`attempt ${context.job.attempt} failed`);
        return payload;
      },
    });

    const handle = queue.enqueue('done');
    await expect(handle.done).resolves.toBe('done');
    expect(attempts).toEqual([1, 2, 3]);
    expect(handle.snapshot().state).toBe('complete');
  });

  it('gives up at the policy’s limit and keeps the last failure', async () => {
    let runs = 0;
    const queue = new JobQueue<null, void>({
      concurrency: 1,
      retry: exponentialBackoff({ maxAttempts: 2, baseMs: 1, jitter: 0 }),
      handler: () => {
        runs += 1;
        throw new Error(`boom ${runs}`);
      },
    });

    const handle = queue.enqueue(null);
    await expect(handle.done).rejects.toThrow('boom 2');
    expect(runs).toBe(2);

    const job = handle.snapshot();
    expect(job.state).toBe('failed');
    expect(job.attempt).toBe(2);
    expect(job.error).toBe('boom 2');
    expect(job.nextAttemptAt).toBeNull();
  });

  it('settles as failed on the first attempt when no policy was given', async () => {
    let runs = 0;
    const queue = new JobQueue<null, void>({
      concurrency: 1,
      handler: () => {
        runs += 1;
        throw new Error('boom');
      },
    });

    await expect(queue.enqueue(null).done).rejects.toThrow('boom');
    expect(runs).toBe(1);
  });

  it('leaves a failure the policy refuses alone', async () => {
    let runs = 0;
    const queue = new JobQueue<null, void>({
      concurrency: 1,
      retry: exponentialBackoff({
        maxAttempts: 5,
        baseMs: 1,
        jitter: 0,
        retryable: (cause) => !(cause instanceof TypeError),
      }),
      handler: () => {
        runs += 1;
        throw new TypeError('a bug in the engine repeats identically');
      },
    });

    await expect(queue.enqueue(null).done).rejects.toThrow(TypeError);
    expect(runs).toBe(1);
  });

  it('fails the job when the policy itself throws', async () => {
    const queue = new JobQueue<null, void>({
      concurrency: 1,
      retry: () => {
        throw new Error('the policy is broken');
      },
      handler: () => {
        throw new Error('boom');
      },
    });

    // The failure the policy was asked about is the one that stands.
    await expect(queue.enqueue(null).done).rejects.toThrow('boom');
  });

  it('reports the wait through events and the job snapshot', async () => {
    const events: JobEvent<null>[] = [];
    let runs = 0;
    const queue = new JobQueue<null, void>({
      concurrency: 1,
      onEvent: (event) => events.push(event),
      retry: () => 25,
      handler: () => {
        runs += 1;
        if (runs === 1) throw new Error('transport reset');
      },
    });

    const handle = queue.enqueue(null);
    await handle.done;

    // Read from the event rather than by polling: the wait is 25ms and the
    // assertion is about what the queue said, not about catching it in time.
    const retrying = events.find((event) => event.type === 'retrying');
    const waiting = retrying?.job;
    expect(waiting?.state).toBe('queued');
    expect(waiting?.attempt).toBe(1);
    expect(waiting?.error).toBe('transport reset');
    expect(waiting?.nextAttemptAt).toBeInstanceOf(Date);
    expect(handle.snapshot().attempt).toBe(2);
    expect(retrying).toMatchObject({ delayMs: 25 });
    expect(events.filter((event) => event.type === 'started')).toHaveLength(2);
    expect(events.some((event) => event.type === 'failed')).toBe(false);
  });

  it('drains only once the retried job has settled', async () => {
    let runs = 0;
    const queue = new JobQueue<null, void>({
      concurrency: 1,
      retry: () => 20,
      handler: () => {
        runs += 1;
        if (runs === 1) throw new Error('boom');
      },
    });

    queue.enqueue(null);
    await queue.drain();
    expect(runs).toBe(2);
    expect(queue.idle).toBe(true);
  });

  it('frees the lane while a job waits, so the next audit of that origin runs', async () => {
    const order: string[] = [];
    const queue = new JobQueue<string, void>({
      concurrency: 2,
      paused: true,
      retry: () => 30,
      handler: (name) => {
        order.push(name);
        if (name === 'first' && order.filter((n) => n === 'first').length === 1) {
          throw new Error('boom');
        }
      },
    });

    queue.enqueue('first', { lane: 'https://example.com' });
    queue.enqueue('second', { lane: 'https://example.com' });
    queue.resume();
    await queue.drain();

    // The second job did not wait out the first job's backoff behind a lane
    // nobody was using.
    expect(order).toEqual(['first', 'second', 'first']);
  });
});

describe('cancelling across a retry', () => {
  it('stops a job that is waiting out its delay', async () => {
    let runs = 0;
    const queue = new JobQueue<null, void>({
      concurrency: 1,
      retry: () => 50,
      handler: () => {
        runs += 1;
        throw new Error('boom');
      },
    });

    const handle = queue.enqueue(null);
    await vi.waitFor(() => expect(handle.snapshot().state).toBe('queued'));

    expect(queue.cancel(handle.id)).toBe(true);
    await expect(handle.done).rejects.toBeInstanceOf(JobCancelledError);

    await sleep(60);
    expect(runs).toBe(1);
    expect(handle.snapshot().state).toBe('cancelled');
  });

  it('wins over a policy that was still deciding', async () => {
    const decided = deferred();
    let runs = 0;
    const queue = new JobQueue<null, void>({
      concurrency: 1,
      retry: async () => {
        await decided.promise;
        return 1;
      },
      handler: () => {
        runs += 1;
        throw new Error('boom');
      },
    });

    const handle = queue.enqueue(null);
    await vi.waitFor(() => expect(runs).toBe(1));

    expect(queue.cancel(handle.id)).toBe(true);
    decided.resolve();

    await expect(handle.done).rejects.toBeInstanceOf(JobCancelledError);
    expect(runs).toBe(1);
  });

  it('does not retry once the queue is closing', async () => {
    let runs = 0;
    const queue = new JobQueue<null, void>({
      concurrency: 1,
      retry: () => 1,
      handler: async () => {
        runs += 1;
        await sleep(5);
        throw new Error('boom');
      },
    });

    const handle = queue.enqueue(null);
    await vi.waitFor(() => expect(runs).toBe(1));
    await queue.close();

    expect(runs).toBe(1);
    expect(handle.snapshot().state).toBe('cancelled');
    expect(queue.idle).toBe(true);
  });
});

describe('exponentialBackoff', () => {
  it('grows the delay by the factor and caps it', () => {
    const policy = exponentialBackoff<null>({
      maxAttempts: 10,
      baseMs: 100,
      factor: 3,
      maxMs: 1_000,
      jitter: 0,
    });

    const delays = [1, 2, 3, 4].map((attempt) =>
      policy({ job: job(attempt), cause: new Error('boom'), attempt }),
    );
    expect(delays).toEqual([100, 300, 900, 1_000]);
  });

  it('spreads the delay within the jitter band', () => {
    const policy = exponentialBackoff<null>({
      maxAttempts: 2,
      baseMs: 1_000,
      jitter: 0.25,
      random: () => 1,
    });
    expect(policy({ job: job(1), cause: new Error('boom'), attempt: 1 })).toBe(1_250);

    const low = exponentialBackoff<null>({
      maxAttempts: 2,
      baseMs: 1_000,
      jitter: 0.25,
      random: () => 0,
    });
    expect(low({ job: job(1), cause: new Error('boom'), attempt: 1 })).toBe(750);
  });

  it('never repeats a cancellation', () => {
    const policy = exponentialBackoff<null>({ maxAttempts: 5 });
    expect(policy({ job: job(1), cause: new JobCancelledError('x'), attempt: 1 })).toBeNull();
  });

  it('rejects a nonsense configuration', () => {
    expect(() => exponentialBackoff<null>({ maxAttempts: 0 })).toThrow(/positive integer/);
    expect(() => exponentialBackoff<null>({ maxAttempts: 2, jitter: 2 })).toThrow(/jitter/);
  });
});

const job = (attempt: number) => ({
  id: 'job',
  payload: null,
  lane: null,
  priority: 0,
  state: 'running' as const,
  attempt,
  enqueuedAt: new Date(0),
  startedAt: new Date(0),
  finishedAt: null,
  nextAttemptAt: null,
  error: null,
});
