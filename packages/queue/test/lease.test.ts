/**
 * Sharing a namespace: what a lease promises, and what happens when one goes.
 *
 * Two workers are staged with two handles on one `MemoryJobStore`, which is a
 * table with the database left out — the same rows, the same claims, and two
 * owners that agree about nothing else. The lease clock is injected, so a job
 * is taken over at an exact moment rather than after a sleep long enough to be
 * flaky on a loaded machine.
 *
 * The queue's own heartbeat runs on real timers, deliberately: the claim it
 * renews has to survive the event loop it shares with the handlers, and a test
 * that faked that away would prove nothing about it.
 */

import { describe, expect, it, vi } from 'vitest';
import { JobLeaseLostError, JobQueue, MemoryJobStore } from '@seo/queue';
import type { StoredJob } from '@seo/queue';

const LEASE_MS = 1_000;
const HEARTBEAT_MS = 5;

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

/** A store whose lease clock a test moves by hand. */
const leased = (owner: string) => {
  const clock = { ms: 1_000_000 };
  const store = new MemoryJobStore<string>([], {
    owner,
    leaseMs: LEASE_MS,
    now: () => clock.ms,
  });
  return { store, clock };
};

const job = (id: string): StoredJob<string> => ({
  id,
  payload: `payload for ${id}`,
  lane: null,
  priority: 0,
  state: 'queued',
  attempt: 0,
  enqueuedAt: new Date('2026-09-08T09:00:00.000Z'),
  nextAttemptAt: null,
  error: null,
});

/** Resolve once `predicate` holds, or fail the test rather than hang forever. */
const until = async (predicate: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

describe('a claim with an expiry on it', () => {
  it('leaves a job alone while the worker holding it is still saying so', async () => {
    const { store } = leased('worker-a');
    const other = store.withOwner('worker-b');
    await store.save(job('a1'));

    expect(await other.load()).toEqual([]);
    // And the holder can still take its own work back — a restart under the
    // same name is not a reason to wait out your own lease.
    expect((await store.load()).map((j) => j.id)).toEqual(['a1']);
  });

  it('hands the job on once nobody has renewed the claim', async () => {
    const { store, clock } = leased('worker-a');
    const other = store.withOwner('worker-b');
    await store.save(job('a1'));

    clock.ms += LEASE_MS + 1;
    expect((await other.load()).map((j) => j.id)).toEqual(['a1']);

    // And the worker that lost it is told, which is the half that stops two
    // processes running one job in the belief they each own it.
    expect(await store.renew(['a1'])).toEqual(['a1']);
  });

  it('keeps a claim standing for as long as it is renewed', async () => {
    const { store, clock } = leased('worker-a');
    const other = store.withOwner('worker-b');
    await store.save(job('a1'));

    for (let i = 0; i < 4; i += 1) {
      clock.ms += LEASE_MS - 1;
      expect(await store.renew(['a1'])).toEqual([]);
    }

    clock.ms += LEASE_MS - 1;
    expect(await other.load()).toEqual([]);
  });

  it('refuses to write over or delete a row that has moved on', async () => {
    const { store, clock } = leased('worker-a');
    const other = store.withOwner('worker-b');
    await store.save(job('a1'));

    clock.ms += LEASE_MS + 1;
    await other.load();

    await expect(store.save({ ...job('a1'), state: 'running', attempt: 9 })).rejects.toBeInstanceOf(
      JobLeaseLostError,
    );
    await store.remove('a1');

    // Untouched: the new owner's version of the job, still outstanding.
    expect(other.snapshot()).toEqual([job('a1')]);
    expect(await other.outstanding()).toEqual(['a1']);
  });

  it('reports a job that is simply gone as lost too', async () => {
    const { store } = leased('worker-a');
    expect(await store.renew(['never-existed'])).toEqual(['never-existed']);
  });
});

describe('a queue whose lease is taken', () => {
  it('stops the running job, fails it, and leaves the new owner’s row alone', async () => {
    const { store, clock } = leased('worker-a');
    const thief = store.withOwner('worker-b');
    const started = deferred();
    const events: string[] = [];

    const queue = new JobQueue<string>({
      concurrency: 1,
      store,
      heartbeatMs: HEARTBEAT_MS,
      onEvent: (event) => events.push(event.type),
      handler: async (_payload, context) => {
        started.resolve();
        // A well-behaved handler: it watches the signal and stops when asked.
        await new Promise<void>((resolve) => {
          context.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    });

    const handle = queue.enqueue('crawl example.com', { id: 'a1' });
    await handle.stored;
    await started.promise;

    // Worker B decides this job has been abandoned and takes it.
    clock.ms += LEASE_MS + 1;
    expect((await thief.load()).map((j) => j.id)).toEqual(['a1']);

    await expect(handle.done).rejects.toBeInstanceOf(JobLeaseLostError);
    expect(queue.get('a1')?.state).toBe('failed');
    expect(events).toContain('lease-lost');

    // The row is worker B's now, and this queue has written nothing over it —
    // no status update, and no delete on the way out.
    expect(store.snapshot().map((j) => j.id)).toEqual(['a1']);
    await queue.close();
    expect(store.snapshot().map((j) => j.id)).toEqual(['a1']);
  });

  it('never starts a job it no longer holds', async () => {
    const { store, clock } = leased('worker-a');
    const thief = store.withOwner('worker-b');
    const handler = vi.fn();

    // Paused, because the interesting case is the job still waiting for a
    // slot: a claim covers queued work too, or a second worker would run what
    // this one is about to.
    const queue = new JobQueue<string>({
      concurrency: 1,
      store,
      heartbeatMs: HEARTBEAT_MS,
      paused: true,
      handler,
    });

    const handle = queue.enqueue('crawl example.com', { id: 'a1' });
    await handle.stored;

    clock.ms += LEASE_MS + 1;
    await thief.load();

    await expect(handle.done).rejects.toBeInstanceOf(JobLeaseLostError);
    expect(queue.queued).toBe(0);

    queue.resume();
    await until(() => queue.idle, 'the queue to go idle');
    expect(handler).not.toHaveBeenCalled();
    await queue.close();
  });

  it('does not retry it: the worker that took it is already running it', async () => {
    const { store, clock } = leased('worker-a');
    const thief = store.withOwner('worker-b');
    const retry = vi.fn(() => 0);
    const started = deferred();

    const queue = new JobQueue<string>({
      concurrency: 1,
      store,
      heartbeatMs: HEARTBEAT_MS,
      retry,
      handler: async (_payload, context) => {
        started.resolve();
        await new Promise<void>((resolve) => {
          context.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        // Throwing on the way out is the ordinary shape of an interrupted
        // handler, and must not be read as a failure worth repeating.
        throw new Error('interrupted');
      },
    });

    const handle = queue.enqueue('crawl example.com', { id: 'a1' });
    await handle.stored;
    await started.promise;

    clock.ms += LEASE_MS + 1;
    await thief.load();

    await expect(handle.done).rejects.toBeInstanceOf(JobLeaseLostError);
    expect(retry).not.toHaveBeenCalled();
    await queue.close();
  });

  it('asks for nothing when the store does not lease', async () => {
    const store = new MemoryJobStore<string>();
    const renew = vi.spyOn(store, 'renew');
    const queue = new JobQueue<string>({
      concurrency: 1,
      store,
      // Offered, and ignored: the queue still beats, because this store does
      // implement renew — what it does not do is expire anything.
      heartbeatMs: HEARTBEAT_MS,
      handler: () => {},
    });

    expect(queue.leased).toBe(true);
    const handle = queue.enqueue('crawl example.com', { id: 'a1' });
    await handle.done;
    await queue.close();
    // Nothing outstanding by the time the first beat could land, so there was
    // never anything to renew.
    expect(renew).not.toHaveBeenCalled();
  });

  it('does not beat at all without a store that can renew', () => {
    const queue = new JobQueue<string>({
      concurrency: 1,
      heartbeatMs: HEARTBEAT_MS,
      handler: () => {},
    });
    expect(queue.leased).toBe(false);
  });
});
