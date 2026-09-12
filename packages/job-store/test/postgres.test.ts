/**
 * The Postgres job store, against a live database.
 *
 * Skipped unless DATABASE_URL is set: `npm run stack:up`, then copy
 * .env.example to .env. There is nothing to assert about durable storage
 * without storage, so this layer has no unit half — @seo/queue's own suite
 * covers the queue side against an in-memory store.
 *
 * Each test namespaces its rows under its own `queue` name, because the point
 * of that column is that two queues cannot see each other's work, and sharing
 * one name across tests would quietly prove the opposite.
 *
 * The lease tests are the exception that proves it: there, two stores *do*
 * share a name, because that is what a second worker is. A lease is aged by
 * writing `leased_at` into the past rather than by waiting, so the tests assert
 * on the expiry rule rather than on how long a test machine takes to run them —
 * and the comparison is still Postgres's `now()`, which is the clock the store
 * itself uses.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createDatabase, jobs } from '@seo/db';
import { PostgresJobStore } from '@seo/job-store';
import { JobLeaseLostError, JobQueue } from '@seo/queue';
import type { StoredJob } from '@seo/queue';

interface Payload {
  readonly auditId: string;
  readonly seeds: readonly string[];
  readonly flags: readonly string[];
}

const job = (id: string, over: Partial<StoredJob<Payload>> = {}): StoredJob<Payload> => ({
  id,
  payload: { auditId: id, seeds: ['https://example.com/'], flags: ['ecommerce'] },
  lane: 'https://example.com',
  priority: 0,
  state: 'queued',
  attempt: 0,
  enqueuedAt: new Date('2026-09-05T10:00:00.000Z'),
  nextAttemptAt: null,
  error: null,
  ...over,
});

const url = process.env['DATABASE_URL'];

describe.skipIf(!url)('the Postgres job store', () => {
  const handle = createDatabase(url ?? '', { max: 4 });
  const { db } = handle;
  const namespaces: string[] = [];

  const storeFor = (name: string, owner = 'test#1') => {
    const queue = `test-${name}-${crypto.randomUUID()}`;
    namespaces.push(queue);
    return new PostgresJobStore<Payload>({ db, queue, owner });
  };

  afterAll(async () => {
    for (const queue of namespaces) await db.delete(jobs).where(eq(jobs.queue, queue));
    await handle.close();
  });

  it('round-trips a job, payload and all', async () => {
    const store = storeFor('roundtrip');
    await store.save(job('a', { priority: 5, attempt: 2, error: 'last time it timed out' }));

    const [loaded] = await store.load();
    expect(loaded).toEqual({
      id: 'a',
      payload: { auditId: 'a', seeds: ['https://example.com/'], flags: ['ecommerce'] },
      lane: 'https://example.com',
      priority: 5,
      state: 'queued',
      attempt: 2,
      enqueuedAt: new Date('2026-09-05T10:00:00.000Z'),
      nextAttemptAt: null,
      error: 'last time it timed out',
    });
  });

  it('replaces a job rather than duplicating it', async () => {
    const store = storeFor('upsert');
    await store.save(job('a'));
    await store.save(job('a', { state: 'running', attempt: 1 }));

    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ state: 'running', attempt: 1 });
  });

  it('returns outstanding jobs oldest first, and stamps them with its owner', async () => {
    const store = storeFor('order', 'worker#7');
    await store.save(job('late', { enqueuedAt: new Date('2026-09-05T12:00:00.000Z') }));
    await store.save(job('early', { enqueuedAt: new Date('2026-09-05T09:00:00.000Z') }));

    expect((await store.load()).map((row) => row.id)).toEqual(['early', 'late']);

    const [row] = await db.select().from(jobs).where(eq(jobs.id, 'early'));
    expect(row?.owner).toBe('worker#7');
    expect(row?.leasedAt).toBeInstanceOf(Date);
  });

  it('does not see another queue’s work', async () => {
    const mine = storeFor('mine');
    const theirs = storeFor('theirs');
    await mine.save(job('a'));
    await theirs.save(job('b'));

    expect((await mine.load()).map((row) => row.id)).toEqual(['a']);
    expect((await theirs.load()).map((row) => row.id)).toEqual(['b']);
  });

  it('forgets a removed job, and shrugs at removing one twice', async () => {
    const store = storeFor('remove');
    await store.save(job('a'));
    await store.remove('a');
    await store.remove('a');

    expect(await store.load()).toEqual([]);
    expect(await store.size()).toBe(0);
  });
});

describe.skipIf(!url)('a queue backed by Postgres', () => {
  const handle = createDatabase(url ?? '', { max: 4 });
  const { db } = handle;
  let queueName: string;

  beforeEach(() => {
    queueName = `test-restart-${crypto.randomUUID()}`;
  });

  afterAll(async () => {
    await handle.close();
  });

  it('resumes what a previous process left queued', async () => {
    const before = new PostgresJobStore<Payload>({ db, queue: queueName, owner: 'first#1' });
    const dying = new JobQueue<Payload, string>({
      concurrency: 1,
      store: before,
      paused: true,
      handler: (payload) => payload.auditId,
    });

    await Promise.all([
      dying.enqueue(job('one').payload, { id: 'one', lane: 'https://one.example' }).stored,
      dying.enqueue(job('two').payload, { id: 'two', priority: 9 }).stored,
    ]);
    expect(await before.size()).toBe(2);

    // The process goes away. Nothing is drained and nothing is closed: that is
    // the whole point.
    const after = new PostgresJobStore<Payload>({ db, queue: queueName, owner: 'second#2' });
    const ran: string[] = [];
    const revived = new JobQueue<Payload, string>({
      concurrency: 1,
      store: after,
      paused: true,
      handler: (payload) => {
        ran.push(payload.auditId);
        return payload.auditId;
      },
    });

    const restored = await revived.recover();
    expect(restored.map((row) => row.id).sort()).toEqual(['one', 'two']);
    expect(restored.find((row) => row.id === 'one')?.lane).toBe('https://one.example');

    revived.resume();
    await revived.drain();

    // Priority still decides the order, which is only true if it survived the
    // round trip through Postgres.
    expect(ran).toEqual(['two', 'one']);
    expect(await after.size()).toBe(0);
  });

  it('leaves nothing behind for a job that finished', async () => {
    const store = new PostgresJobStore<Payload>({ db, queue: queueName, owner: 'only#1' });
    const queue = new JobQueue<Payload, string>({
      concurrency: 1,
      store,
      handler: (payload) => payload.auditId,
    });

    const handle_ = queue.enqueue(job('done').payload, { id: 'done' });
    await expect(handle_.done).resolves.toBe('done');
    await queue.drain();

    expect(await store.size()).toBe(0);
    const rows = await db.select().from(jobs).where(eq(jobs.id, 'done'));
    expect(rows).toEqual([]);
  });
});

describe.skipIf(!url)('two workers sharing a namespace', () => {
  const handle = createDatabase(url ?? '', { max: 4 });
  const { db } = handle;
  const LEASE_MS = 30_000;
  const namespaces: string[] = [];

  afterAll(async () => {
    for (const queue of namespaces) await db.delete(jobs).where(eq(jobs.queue, queue));
    await handle.close();
  });

  /** Two stores on one namespace: the same table, two owners. */
  const pair = () => {
    const queue = `test-lease-${crypto.randomUUID()}`;
    namespaces.push(queue);
    const worker = (owner: string) =>
      new PostgresJobStore<Payload>({ db, queue, owner, leaseMs: LEASE_MS });
    return { queue, a: worker('worker-a'), b: worker('worker-b') };
  };

  /** Age a claim past its lease, by the database's clock rather than by waiting. */
  const expire = async (queue: string, id: string) => {
    await db
      .update(jobs)
      .set({ leasedAt: sql`now() - make_interval(secs => ${LEASE_MS / 1000 + 1})` })
      .where(and(eq(jobs.queue, queue), eq(jobs.id, id)));
  };

  const ownerOf = async (queue: string, id: string) => {
    const [row] = await db
      .select({ owner: jobs.owner })
      .from(jobs)
      .where(and(eq(jobs.queue, queue), eq(jobs.id, id)));
    return row?.owner;
  };

  it('leaves a job alone while the worker holding it is still saying so', async () => {
    const { queue, a, b } = pair();
    await a.save(job('a1'));

    expect(await b.load()).toEqual([]);
    // The holder takes its own work back without waiting out its own lease,
    // which is what a restart under a stable name depends on.
    expect((await a.load()).map((row) => row.id)).toEqual(['a1']);
    expect(await ownerOf(queue, 'a1')).toBe('worker-a');
  });

  it('hands the job on once nobody has renewed the claim', async () => {
    const { queue, a, b } = pair();
    await a.save(job('a1'));
    await expire(queue, 'a1');

    expect((await b.load()).map((row) => row.id)).toEqual(['a1']);
    expect(await ownerOf(queue, 'a1')).toBe('worker-b');
    // And the worker that lost it is told, rather than left crawling a site
    // another worker has already started on.
    expect(await a.renew(['a1'])).toEqual(['a1']);
  });

  it('hands an abandoned job to a worker already running, without anyone restarting', async () => {
    const { queue, a, b } = pair();
    await a.save(job('a1', { state: 'running', attempt: 1 }));
    await expire(queue, 'a1');

    const [taken] = await b.adopt();
    expect(taken).toMatchObject({ id: 'a1', attempt: 1, state: 'queued' });
    expect(await ownerOf(queue, 'a1')).toBe('worker-b');
    // Written back as queued, so the dead worker's row stops holding the lane.
    const [row] = await db.select({ state: jobs.state }).from(jobs).where(and(eq(jobs.queue, queue), eq(jobs.id, 'a1')));
    expect(row?.state).toBe('queued');
  });

  it('adopts nothing that a live claim still covers, and nothing of its own', async () => {
    const { queue, a, b } = pair();
    await a.save(job('a1'));
    await b.save(job('b1'));
    await expire(queue, 'b1');

    // a1 is held and stays held; b1 is worker B's own, stale claim or not.
    expect(await b.adopt()).toEqual([]);
    expect(await ownerOf(queue, 'a1')).toBe('worker-a');
    expect(await ownerOf(queue, 'b1')).toBe('worker-b');
  });

  it('adopts nothing in a namespace with one owner, where no work is abandoned', async () => {
    const queue = `test-adopt-single-${crypto.randomUUID()}`;
    namespaces.push(queue);
    const store = new PostgresJobStore<Payload>({ db, queue, owner: 'worker-a' });
    await store.save(job('a1'));
    expect(await store.adopt()).toEqual([]);
  });

  it('renews a claim it still holds, expired or not', async () => {
    const { queue, a, b } = pair();
    await a.save(job('a1'));
    await expire(queue, 'a1');

    // Nobody took it, so it is still worker A's — a lease is an invitation to
    // take over, not a punishment for being late.
    expect(await a.renew(['a1'])).toEqual([]);
    expect(await b.load()).toEqual([]);
  });

  it('divides the backlog rather than handing it to both', async () => {
    const { queue, a, b } = pair();
    await a.save(job('a1'));
    await a.save(job('a2'));
    await expire(queue, 'a1');

    // Only the abandoned one moves; the claim still standing is not up for
    // grabs however much work the second worker is looking for.
    expect((await b.load()).map((row) => row.id)).toEqual(['a1']);
    expect(await ownerOf(queue, 'a2')).toBe('worker-a');
  });

  it('refuses to write over a row that has moved on, and says which', async () => {
    const { queue, a, b } = pair();
    await a.save(job('a1'));
    await expire(queue, 'a1');
    await b.load();

    await expect(a.save(job('a1', { state: 'running', attempt: 9 }))).rejects.toBeInstanceOf(
      JobLeaseLostError,
    );

    const [row] = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.queue, queue), eq(jobs.id, 'a1')));
    expect(row?.owner).toBe('worker-b');
    expect(row?.state).toBe('queued');
    expect(row?.attempt).toBe(0);
  });

  it('does not delete a job it has lost', async () => {
    const { queue, a, b } = pair();
    await a.save(job('a1'));
    await expire(queue, 'a1');
    await b.load();

    // Worker A finishing the run it was already making must not cancel the
    // work worker B has taken over.
    await a.remove('a1');
    expect((await b.renew(['a1'])).length).toBe(0);
    expect(await b.size()).toBe(1);
  });

  it('lists what is outstanding whoever holds it', async () => {
    const { a, b } = pair();
    await a.save(job('a1'));
    await b.save(job('b1'));

    expect([...(await a.outstanding())].sort()).toEqual(['a1', 'b1']);
    // Which is a different question from what this worker may run: b1 is
    // worker B's, and worker A leaves it alone.
    expect((await a.load()).map((row) => row.id)).toEqual(['a1']);
  });

  it('claims everything when the namespace has no leases', async () => {
    const queue = `test-lease-off-${crypto.randomUUID()}`;
    namespaces.push(queue);
    const single = new PostgresJobStore<Payload>({ db, queue, owner: 'worker-a' });
    const next = new PostgresJobStore<Payload>({ db, queue, owner: 'worker-b' });
    await single.save(job('a1'));

    // The single-owner arrangement, unchanged: a process coming back under a
    // new name reclaims what the last one left rather than stranding it.
    expect((await next.load()).map((row) => row.id)).toEqual(['a1']);
  });

  it('refuses a lane another worker is running, and only that lane', async () => {
    const { queue, a, b } = pair();
    await a.save(job('a1', { state: 'running', attempt: 1 }));

    expect(await b.acquire(job('b1', { state: 'running', attempt: 1 }))).toBe(false);
    // Refused means nothing was written.
    const rows = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.queue, queue), eq(jobs.id, 'b1')));
    expect(rows).toEqual([]);

    expect(
      await b.acquire(job('b2', { lane: 'https://other.example', state: 'running', attempt: 1 })),
    ).toBe(true);
    expect(await ownerOf(queue, 'b2')).toBe('worker-b');
  });

  it('does not count queued work, or the asking worker’s own', async () => {
    const { a, b } = pair();
    await a.save(job('a1'));
    expect(await b.acquire(job('b1', { state: 'running', attempt: 1 }))).toBe(true);

    // b1 is worker B's own running job, and B asking again for the lane is the
    // queue's business, not the table's.
    expect(await b.acquire(job('b2', { state: 'running', attempt: 1 }))).toBe(true);
  });

  it('lets the lane go once the worker running it stops renewing', async () => {
    const { queue, a, b } = pair();
    await a.save(job('a1', { state: 'running', attempt: 1 }));
    await expire(queue, 'a1');

    expect(await b.acquire(job('b1', { state: 'running', attempt: 1 }))).toBe(true);
  });

  it('writes a recovered job back as queued, so it holds no lane while it waits', async () => {
    const { queue, a, b } = pair();
    await a.save(job('a1', { state: 'running', attempt: 1 }));

    // Worker A comes back under its own name and takes the job back.
    await a.load();
    const [row] = await db
      .select({ state: jobs.state })
      .from(jobs)
      .where(and(eq(jobs.queue, queue), eq(jobs.id, 'a1')));
    expect(row?.state).toBe('queued');
    expect(await b.acquire(job('b1', { state: 'running', attempt: 1 }))).toBe(true);
  });

  it('gives one lane to exactly one of two workers asking at once', async () => {
    const { queue, a, b } = pair();
    const running = (id: string) => job(id, { state: 'running', attempt: 1 });

    // Many rounds, because a race that is lost one time in ten is a race.
    for (let round = 0; round < 10; round += 1) {
      const [left, right] = await Promise.all([
        a.acquire(running(`a-${round}`)),
        b.acquire(running(`b-${round}`)),
      ]);
      expect([left, right].filter(Boolean)).toHaveLength(1);
      await db.delete(jobs).where(eq(jobs.queue, queue));
    }
  });

  it('runs a job the previous worker abandoned mid-flight', async () => {
    const { queue, a, b } = pair();
    // What a worker that died leaves: its own claim, and a job marked running
    // that nothing is running.
    await a.save(job('a1', { state: 'running', attempt: 1 }));
    await expire(queue, 'a1');

    const ran: string[] = [];
    const queued = new JobQueue<Payload, string>({
      concurrency: 1,
      store: b,
      // Paused so the attempt count can be read as it came back, before the
      // run that is about to spend the next one.
      paused: true,
      handler: (payload) => {
        ran.push(payload.auditId);
        return payload.auditId;
      },
    });

    expect((await queued.recover()).map((row) => row.attempt)).toEqual([1]);
    queued.resume();
    await queued.drain();
    expect(ran).toEqual(['a1']);
    // Settled by its new owner, and gone from the table.
    const rows = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.queue, queue), inArray(jobs.id, ['a1'])));
    expect(rows).toEqual([]);
    await queued.close();
  });
});
