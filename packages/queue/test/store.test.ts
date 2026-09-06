/**
 * Durability: what the queue writes down, and what it takes back.
 *
 * A restart is simulated by handing one queue's store to the next, which is the
 * interesting half of a crash with the crash left out. What the crash itself has
 * to prove — that a job is never started before it is written down, and that a
 * process which dies mid-handler comes back having spent an attempt — is
 * asserted directly rather than by killing anything.
 */

import { describe, expect, it, vi } from 'vitest';
import { exponentialBackoff, JobQueue, MemoryJobStore } from '@seo/queue';
import type { JobStore, StoredJob } from '@seo/queue';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

/** A store whose writes a test controls, for asserting on ordering. */
class GatedStore<TPayload> implements JobStore<TPayload> {
  readonly inner: MemoryJobStore<TPayload>;
  #gate: Promise<void> | null = null;

  constructor(initial: Iterable<StoredJob<TPayload>> = []) {
    this.inner = new MemoryJobStore<TPayload>(initial);
  }

  /** Hold every write until the returned function is called. */
  hold(): () => void {
    const { promise, resolve } = deferred();
    this.#gate = promise;
    return () => {
      this.#gate = null;
      resolve();
    };
  }

  async load(): Promise<readonly StoredJob<TPayload>[]> {
    return this.inner.load();
  }

  async save(job: StoredJob<TPayload>): Promise<void> {
    if (this.#gate !== null) await this.#gate;
    await this.inner.save(job);
  }

  async remove(id: string): Promise<void> {
    if (this.#gate !== null) await this.#gate;
    await this.inner.remove(id);
  }
}

describe('writing a job down', () => {
  it('stores it at enqueue and forgets it once it settles', async () => {
    const store = new MemoryJobStore<string>();
    const queue = new JobQueue<string, string>({
      concurrency: 1,
      store,
      paused: true,
      handler: (payload) => payload,
    });

    const handle = queue.enqueue('one', { lane: 'https://example.com', priority: 3 });
    await handle.stored;

    const [stored] = store.snapshot();
    expect(stored).toMatchObject({
      id: handle.id,
      payload: 'one',
      lane: 'https://example.com',
      priority: 3,
      state: 'queued',
      attempt: 0,
    });

    queue.resume();
    await expect(handle.done).resolves.toBe('one');
    await queue.drain();
    expect(store.size).toBe(0);
  });

  it('does not start a job before the store has accepted it', async () => {
    const store = new GatedStore<string>();
    const release = store.hold();
    let ran = false;

    const queue = new JobQueue<string, void>({
      concurrency: 1,
      store,
      handler: () => {
        ran = true;
      },
    });

    const handle = queue.enqueue('held');
    await sleep(10);
    expect(ran).toBe(false);
    expect(handle.snapshot().state).toBe('queued');

    release();
    await handle.stored;
    await queue.drain();
    expect(ran).toBe(true);
  });

  it('fails a job the store refuses, and never runs it', async () => {
    const refusing: JobStore<string> = {
      load: () => Promise.resolve([]),
      save: () => Promise.reject(new Error('disk is on fire')),
      remove: () => Promise.resolve(),
    };
    let ran = false;

    const queue = new JobQueue<string, void>({
      concurrency: 1,
      store: refusing,
      handler: () => {
        ran = true;
      },
    });

    const handle = queue.enqueue('doomed');
    await expect(handle.stored).rejects.toThrow('disk is on fire');
    await expect(handle.done).rejects.toThrow('disk is on fire');
    expect(ran).toBe(false);
    expect(handle.snapshot().state).toBe('failed');
  });

  it('records the attempt before the handler runs, not after', async () => {
    const store = new MemoryJobStore<string>();
    const running = deferred();
    const finish = deferred();

    const queue = new JobQueue<string, void>({
      concurrency: 1,
      store,
      handler: async () => {
        running.resolve();
        await finish.promise;
      },
    });

    const handle = queue.enqueue('slow');
    await running.promise;
    // The write is issued before the handler is called but is not awaited, so
    // give the microtask that lands it a turn.
    await sleep(5);

    const [stored] = store.snapshot();
    expect(stored).toMatchObject({ id: handle.id, state: 'running', attempt: 1 });

    finish.resolve();
    await queue.drain();
    expect(store.size).toBe(0);
  });

  it('keeps a pending retry’s deadline and its reason', async () => {
    const store = new MemoryJobStore<string>();
    const queue = new JobQueue<string, void>({
      concurrency: 1,
      store,
      retry: exponentialBackoff({ maxAttempts: 2, baseMs: 200, jitter: 0 }),
      handler: () => {
        throw new Error('transient');
      },
    });

    const handle = queue.enqueue('flaky');
    await handle.stored;
    await vi.waitFor(() => {
      const [stored] = store.snapshot();
      expect(stored?.state).toBe('queued');
      expect(stored?.attempt).toBe(1);
      expect(stored?.error).toBe('transient');
      expect(stored?.nextAttemptAt).toBeInstanceOf(Date);
    });

    await expect(handle.done).rejects.toThrow('transient');
    await queue.drain();
    expect(store.size).toBe(0);
  });

  it('waits for its writes before it calls itself drained', async () => {
    const store = new GatedStore<string>();
    const queue = new JobQueue<string, void>({
      concurrency: 1,
      store,
      handler: () => {},
    });

    const handle = queue.enqueue('one');
    await handle.stored;

    const release = store.hold();
    let drained = false;
    const draining = queue.drain().then(() => {
      drained = true;
    });

    // The handler has nothing to do; only the removal is outstanding.
    await sleep(20);
    expect(drained).toBe(false);

    release();
    await draining;
    expect(store.inner.snapshot()).toHaveLength(0);
  });

  it('reports a failed update without failing the job', async () => {
    const errors: string[] = [];
    const flaky: JobStore<string> = {
      load: () => Promise.resolve([]),
      save: (job) =>
        job.state === 'running'
          ? Promise.reject(new Error('write timeout'))
          : Promise.resolve(),
      remove: () => Promise.resolve(),
    };

    const queue = new JobQueue<string, string>({
      concurrency: 1,
      store: flaky,
      onStoreError: (error) => errors.push(String(error)),
      handler: (payload) => payload,
    });

    const handle = queue.enqueue('survives');
    await expect(handle.done).resolves.toBe('survives');
    await queue.drain();
    expect(errors).toEqual([expect.stringContaining('write timeout')]);
  });
});

describe('recovering after a restart', () => {
  it('takes back what was queued and runs it', async () => {
    const store = new MemoryJobStore<string>();

    const before = new JobQueue<string, void>({
      concurrency: 1,
      store,
      paused: true,
      handler: () => {},
    });
    await Promise.all([
      before.enqueue('a', { id: 'a', lane: 'https://one.example' }).stored,
      before.enqueue('b', { id: 'b', priority: 7 }).stored,
    ]);
    expect(store.size).toBe(2);

    // The process goes away without either job running.
    const ran: string[] = [];
    const after = new JobQueue<string, void>({
      concurrency: 1,
      store,
      paused: true,
      handler: (payload) => {
        ran.push(payload);
      },
    });

    const restored = await after.recover();
    expect(restored.map((job) => job.id).sort()).toEqual(['a', 'b']);
    expect(restored.find((job) => job.id === 'a')?.lane).toBe('https://one.example');
    expect(restored.find((job) => job.id === 'b')?.priority).toBe(7);

    after.resume();
    await after.drain();
    // Priority still decides the order, which is only true if it survived.
    expect(ran).toEqual(['b', 'a']);
    expect(store.size).toBe(0);
  });

  it('keeps the attempt count, so a job that kills the process still gives up', async () => {
    // Attempt 1 "crashed the process": the store holds it mid-flight.
    const store = new MemoryJobStore<string>([
      {
        id: 'poison',
        payload: 'poison',
        lane: null,
        priority: 0,
        state: 'running',
        attempt: 1,
        enqueuedAt: new Date(),
        nextAttemptAt: null,
        error: null,
      },
    ]);

    let runs = 0;
    const queue = new JobQueue<string, void>({
      concurrency: 1,
      store,
      paused: true,
      retry: exponentialBackoff({ maxAttempts: 2, baseMs: 1, jitter: 0 }),
      handler: () => {
        runs += 1;
        throw new Error('still poison');
      },
    });

    const [restored] = await queue.recover();
    expect(restored?.state).toBe('queued');
    expect(restored?.attempt).toBe(1);

    queue.resume();
    await queue.drain();
    // One more attempt, not two: the crash counted.
    expect(runs).toBe(1);
    expect(store.size).toBe(0);
  });

  it('leaves the rest of a retry backoff standing', async () => {
    const due = new Date(Date.now() + 10_000);
    const store = new MemoryJobStore<string>([
      {
        id: 'waiting',
        payload: 'waiting',
        lane: null,
        priority: 0,
        state: 'queued',
        attempt: 1,
        enqueuedAt: new Date(),
        nextAttemptAt: due,
        error: 'the site was down',
      },
    ]);

    let ran = false;
    const queue = new JobQueue<string, void>({
      concurrency: 1,
      store,
      handler: () => {
        ran = true;
      },
    });

    const [restored] = await queue.recover();
    expect(restored?.nextAttemptAt).toEqual(due);
    expect(restored?.error).toBe('the site was down');

    await sleep(20);
    expect(ran).toBe(false);
    expect(queue.queued).toBe(1);
  });

  it('ignores a job this queue already has, and refuses a second run', async () => {
    const store = new MemoryJobStore<string>();
    const queue = new JobQueue<string, void>({
      concurrency: 1,
      store,
      paused: true,
      handler: () => {},
    });

    await queue.enqueue('mine', { id: 'mine' }).stored;
    expect(await queue.recover()).toHaveLength(0);
    await expect(queue.recover()).rejects.toThrow('already run');
  });

  it('is a no-op without a store', async () => {
    const queue = new JobQueue<string, void>({ concurrency: 1, handler: () => {} });
    expect(queue.durable).toBe(false);
    expect(await queue.recover()).toEqual([]);
  });
});
