/**
 * The S3 blob store, against a live MinIO.
 *
 * Skipped unless STORAGE_ENDPOINT is set: `npm run stack:up`, then copy
 * .env.example to .env. There is nothing to assert about an object store
 * without one, the same reasoning @seo/job-store's Postgres suite gives for
 * skipping rather than mocking.
 *
 * MinIO starts with no buckets — unlike Postgres, there is no migration step
 * that provisions one — so `beforeAll` creates it, ignoring the error a
 * bucket that already exists (from a previous run against the same volume)
 * raises.
 */

import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { createBlobStore, storageConfigFromEnv } from '@seo/storage';
import type { BlobStore, S3StorageConfig } from '@seo/storage';

const endpoint = process.env['STORAGE_ENDPOINT'];

describe.skipIf(!endpoint)('S3BlobStore', () => {
  let config: S3StorageConfig;
  let store: BlobStore;

  beforeAll(async () => {
    config = storageConfigFromEnv();
    const client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
    try {
      await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
    } catch (cause) {
      const name = typeof cause === 'object' && cause !== null ? (cause as { name?: string }).name : undefined;
      if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw cause;
    }
    store = createBlobStore(config);
  });

  it('returns the same content-addressed key for the same bytes', async () => {
    const bytes = new TextEncoder().encode(`hello, blob store — ${crypto.randomUUID()}`);
    const first = await store.put(bytes);
    const second = await store.put(bytes);
    expect(second).toBe(first);
  });

  it('names the key after the content hash, sharded like git loose objects', async () => {
    const bytes = new TextEncoder().encode(`sharded — ${crypto.randomUUID()}`);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const key = await store.put(bytes);
    expect(key).toBe(`sha256/${hash.slice(0, 2)}/${hash.slice(2)}`);
  });

  it('reads back exactly the bytes that were written', async () => {
    const bytes = new TextEncoder().encode(`round trip — ${crypto.randomUUID()}`);
    const key = await store.put(bytes);
    const read = await store.get(key);
    expect(read).not.toBeNull();
    expect(Buffer.from(read!).toString('utf8')).toBe(Buffer.from(bytes).toString('utf8'));
  });

  it('gives two different bodies two different keys', async () => {
    const a = await store.put(new TextEncoder().encode(`a — ${crypto.randomUUID()}`));
    const b = await store.put(new TextEncoder().encode(`b — ${crypto.randomUUID()}`));
    expect(a).not.toBe(b);
  });

  it('returns null for a key nothing was ever written to', async () => {
    const read = await store.get('sha256/00/does-not-exist');
    expect(read).toBeNull();
  });
});
