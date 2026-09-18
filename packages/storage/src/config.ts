import { S3Client } from '@aws-sdk/client-s3';
import { S3BlobStore } from './s3-blob-store.js';
import type { BlobStore } from './blob-store.js';

export interface S3StorageConfig {
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Real AWS regions matter to S3; MinIO and GCS accept any non-empty string. */
  readonly region: string;
  /** Unset for AWS S3 itself; a URL for GCS's interop endpoint or MinIO. */
  readonly endpoint?: string;
  /** MinIO and most S3-compatible stores need bucket-in-path, not bucket-in-host. */
  readonly forcePathStyle?: boolean;
  readonly prefix?: string;
}

/** Build a store from an already-resolved config, for tests and callers that assemble their own. */
export function createBlobStore(config: S3StorageConfig): BlobStore {
  const client = new S3Client({
    region: config.region,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    forcePathStyle: config.forcePathStyle ?? false,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  return new S3BlobStore({
    client,
    bucket: config.bucket,
    ...(config.prefix === undefined ? {} : { prefix: config.prefix }),
  });
}

/** Read `STORAGE_*` from the environment, failing loudly if the required ones are unset. */
export function storageConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3StorageConfig {
  const bucket = env['STORAGE_BUCKET'];
  const accessKeyId = env['STORAGE_ACCESS_KEY_ID'];
  const secretAccessKey = env['STORAGE_SECRET_ACCESS_KEY'];
  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'STORAGE_BUCKET, STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY must all be set. ' +
        'Copy .env.example to .env, or start the local stack with `docker compose up -d`.',
    );
  }
  const endpoint = env['STORAGE_ENDPOINT'];
  return {
    bucket,
    accessKeyId,
    secretAccessKey,
    region: env['STORAGE_REGION'] || 'us-east-1',
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: env['STORAGE_FORCE_PATH_STYLE'] === 'true',
  };
}
