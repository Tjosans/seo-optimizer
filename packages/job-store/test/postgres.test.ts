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
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabase, jobs } from '@seo/db';
import { PostgresJobStore } from '@seo/job-store';
import { JobQueue } from '@seo/queue';
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
