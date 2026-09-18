import { createHash } from 'node:crypto';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { BlobStore } from './blob-store.js';

export interface S3BlobStoreOptions {
  readonly client: S3Client;
  readonly bucket: string;
  /**
   * Prepended to every key. Lets one bucket hold more than this project's
   * bodies without a key from one tenant ever colliding with another's — two
   * prefixes hashing the same bytes still land at two different keys.
   */
  readonly prefix?: string;
}

/**
 * `BlobStore` over any S3-compatible object store: AWS S3 itself, GCS's S3
 * interoperability API (HMAC keys, `endpoint: https://storage.googleapis.com`),
 * or MinIO for local development (`forcePathStyle: true`). The store never
 * cares which — it only ever calls the three verbs common to all of them.
 */
export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix?: string;

  constructor(options: S3BlobStoreOptions) {
    this.client = options.client;
    this.bucket = options.bucket;
    if (options.prefix !== undefined) this.prefix = options.prefix;
  }

  async put(bytes: Uint8Array): Promise<string> {
    const key = this.keyFor(bytes);
    // Content-addressed, so an object already at this key is these same
    // bytes. Skipping the write on a hit is what makes re-crawling an
    // unchanged page cost a HEAD, not a PUT of a body that has not moved.
    if (await this.exists(key)) return key;
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes }),
    );
    return key;
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!response.Body) return null;
      return await response.Body.transformToByteArray();
    } catch (cause) {
      if (isNotFound(cause)) return null;
      throw cause;
    }
  }

  private async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (cause) {
      if (isNotFound(cause)) return false;
      throw cause;
    }
  }

  private keyFor(bytes: Uint8Array): string {
    const hash = createHash('sha256').update(bytes).digest('hex');
    // Sharded by the hash's first byte, the same layout git uses for loose
    // objects, so no single prefix ever holds the whole corpus's bodies.
    const key = `sha256/${hash.slice(0, 2)}/${hash.slice(2)}`;
    return this.prefix ? `${this.prefix}/${key}` : key;
  }
}

/** True for both the SDK's typed `NotFound`/`NoSuchKey` and a bare 404. */
function isNotFound(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false;
  const name = 'name' in cause ? cause.name : undefined;
  if (name === 'NotFound' || name === 'NoSuchKey') return true;
  const metadata = '$metadata' in cause ? cause.$metadata : undefined;
  return (
    typeof metadata === 'object' &&
    metadata !== null &&
    'httpStatusCode' in metadata &&
    metadata.httpStatusCode === 404
  );
}
