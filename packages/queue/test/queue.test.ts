import { describe, expect, it } from 'vitest';
import { JobCancelledError, JobQueue } from '@seo/queue';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

describe('JobQueue concurrency', () => {
  it('never runs more handlers at once than the concurrency budget', async () => {
    let inFlight = 0;
    let peak = 0;
    const queue = new JobQueue<number>({
      concurrency: 2,
      handler: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await sleep(5);
        inFlight -= 1;
      },
    });

    for (let i = 0; i < 6; i += 1) queue.enqueue(i);
    await queue.drain();

    expect(peak).toBe(2);
    expect(queue.running).toBe(0);
    expect(queue.queued).toBe(0);
  });

  it('rejects a concurrency that is not a positive integer', () => {
    expect(() => new JobQueue<number>({ concurrency: 0, handler: () => {} })).toThrow(
      /positive integer/,
    );
  });

  it('drains immediately when there is nothing to do', async () => {
    const queue = new JobQueue<number>({ concurrency: 1, handler: () => {} });
    expect(queue.idle).toBe(true);
    await expect(queue.drain()).resolves.toBeUndefined();
  });
});

describe('JobQueue lanes', () => {
  it('serializes jobs sharing a lane while other lanes run side by side', async () => {
    const active = new Set<string>();
    const overlaps: string[] = [];
    let peak = 0;

    const queue = new JobQueue<string>({
      concurrency: 4,
      handler: async (lane) => {
        if (active.has(lane)) overlaps.push(lane);
        active.add(lane);
        peak = Math.max(peak, active.size);
        await sleep(5);
        active.delete(lane);
      },
    });

    for (const lane of ['a', 'a', 'a', 'b', 'b', 'c']) queue.enqueue(lane, { lane });
    await queue.drain();

    expect(overlaps).toEqual([]);
    // Three lanes were free at the start, so the block above is not passing
    // merely because everything ran one at a time.
    expect(peak).toBe(3);
  });

  it('passes over a blocked lane rather than stalling behind it', async () => {
    const order: string[] = [];
    const queue = new JobQueue<string>({
      concurrency: 2,
      paused: true,
      handler: async (name) => {
        order.push(name);
        await sleep(5);
      },
    });

    queue.enqueue('busy-1', { lane: 'busy' });
    queue.enqueue('busy-2', { lane: 'busy' });
    queue.enqueue('other', { lane: 'other' });
    queue.resume();
    await queue.drain();

    // busy-2 was ahead of `other` in the queue but its lane was taken, so the
    // free slot went to `other` instead of idling until busy-1 finished.
    expect(order).toEqual(['busy-1', 'other', 'busy-2']);
  });
});

describe('JobQueue ordering', () => {
  it('runs higher priority first and keeps enqueue order among equals', async () => {
    const order: string[] = [];
    const queue = new JobQueue<string>({
      concurrency: 1,
      paused: true,
      handler: async (name) => {
        order.push(name);
        await sleep(1);
      },
    });

    queue.enqueue('a');
    queue.enqueue('b', { priority: 5 });
    queue.enqueue('c');
    queue.enqueue('d', { priority: 5 });
    queue.resume();
    await queue.drain();

    expect(order).toEqual(['b', 'd', 'a', 'c']);
  });

  it('emits one event per transition', async () => {
    const events: string[] = [];
    const queue = new JobQueue<string>({
      concurrency: 1,
      onEvent: (event) => events.push(`${event.type}:${event.job.payload}`),
      handler: () => {},
    });

    queue.enqueue('a');
    await queue.drain();

    expect(events).toEqual(['enqueued:a', 'started:a', 'completed:a']);
  });
});

describe('JobQueue failure', () => {
  it('settles a throwing job as failed without stopping the queue', async () => {
    const queue = new JobQueue<string, string>({
      concurrency: 1,
      handler: (name) => {
        if (name === 'bad') throw new Error('boom');
        return name;
      },
    });

    const bad = queue.enqueue('bad', { id: 'bad' });
    const good = queue.enqueue('good', { id: 'good' });

    await expect(bad.done).rejects.toThrow('boom');
    await expect(good.done).resolves.toBe('good');
    expect(queue.get('bad')?.state).toBe('failed');
    expect(queue.get('bad')?.error).toBe('boom');
    expect(queue.get('good')?.state).toBe('complete');
  });

  it('does not fail a job because an event listener threw', async () => {
    const queue = new JobQueue<string, string>({
      concurrency: 1,
      onEvent: () => {
        throw new Error('listener is broken');
      },
      handler: (name) => name,
    });

    await expect(queue.enqueue('a').done).resolves.toBe('a');
  });
});

describe('JobQueue cancellation', () => {
  it('keeps a cancelled job from ever running', async () => {
    const ran: string[] = [];
    const queue = new JobQueue<string>({
      concurrency: 1,
      paused: true,
      handler: (name) => {
        ran.push(name);
      },
    });

    queue.enqueue('a', { id: 'a' });
    const b = queue.enqueue('b', { id: 'b' });

    expect(queue.cancel('b')).toBe(true);
    queue.resume();
    await queue.drain();

    expect(ran).toEqual(['a']);
    await expect(b.done).rejects.toBeInstanceOf(JobCancelledError);
    expect(queue.get('b')?.state).toBe('cancelled');
  });

  it('aborts the signal of a running job and settles it as cancelled', async () => {
    const started = deferred();
    const queue = new JobQueue<string>({
      concurrency: 1,
      handler: async (_name, context) => {
        started.resolve();
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason));
        });
      },
    });

    const handle = queue.enqueue('slow', { id: 'slow' });
    await started.promise;

    expect(queue.cancel('slow')).toBe(true);
    await expect(handle.done).rejects.toBeInstanceOf(JobCancelledError);
    expect(queue.get('slow')?.state).toBe('cancelled');
  });

  it('reports a job that ignored the abort signal as cancelled, not complete', async () => {
    const started = deferred();
    const release = deferred();
    const queue = new JobQueue<string, string>({
      concurrency: 1,
      handler: async (name) => {
        started.resolve();
        await release.promise;
        return name;
      },
    });

    const handle = queue.enqueue('stubborn', { id: 'stubborn' });
    await started.promise;
    queue.cancel('stubborn');
    release.resolve();

    await expect(handle.done).rejects.toBeInstanceOf(JobCancelledError);
    expect(queue.get('stubborn')?.state).toBe('cancelled');
  });

  it('refuses to cancel an unknown or already finished job', async () => {
    const queue = new JobQueue<string, string>({ concurrency: 1, handler: (name) => name });
    await queue.enqueue('a', { id: 'a' }).done;

    expect(queue.cancel('a')).toBe(false);
    expect(queue.cancel('never-existed')).toBe(false);
  });
});

describe('JobQueue shutdown', () => {
  it('cancels queued work, waits for running work, and refuses new work', async () => {
    const started = deferred();
    const release = deferred();
    const queue = new JobQueue<string>({
      concurrency: 1,
      handler: async (name) => {
        if (name !== 'running') return;
        started.resolve();
        await release.promise;
      },
    });

    queue.enqueue('running', { id: 'running' });
    const waiting = queue.enqueue('waiting', { id: 'waiting' });
    await started.promise;

    const closing = queue.close();
    expect(queue.get('waiting')?.state).toBe('cancelled');
    await expect(waiting.done).rejects.toBeInstanceOf(JobCancelledError);
    expect(queue.running).toBe(1);

    release.resolve();
    await closing;

    expect(queue.running).toBe(0);
    expect(queue.closed).toBe(true);
    expect(() => queue.enqueue('late')).toThrow(/closed queue/);
  });

  it('forgets finished jobs past the history limit', async () => {
    const queue = new JobQueue<number, number>({
      concurrency: 1,
      historyLimit: 1,
      handler: (n) => n,
    });

    queue.enqueue(1, { id: 'one' });
    queue.enqueue(2, { id: 'two' });
    queue.enqueue(3, { id: 'three' });
    await queue.drain();

    expect(queue.get('one')).toBeUndefined();
    expect(queue.get('two')).toBeUndefined();
    expect(queue.get('three')?.state).toBe('complete');
    expect(queue.list('complete')).toHaveLength(1);
  });
});
