/**
 * The audit API's entry point.
 *
 *     npm run serve
 *
 * Listens on PORT (default 3000). Corpus versions are read from the repo's
 * own `corpus/` directory, the same one `npm run release` reads. Page bodies
 * are kept in the object store `STORAGE_*` names when `STORAGE_BUCKET` is set,
 * and only hashed when it is not. Audits are queued in memory, so one a
 * previous run left `pending` or `running` is closed out as failed on the way
 * up: nothing here is going to run it. What a
 * running API is — the scheduler, its crawl budget, the server — is decided
 * in `start.ts`, which @seo/desktop runs too; this file only says where the
 * repo keeps things.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { databaseUrlFromEnv } from '@seo/db';
import { createBlobStore, storageConfigFromEnv } from '@seo/storage';
import { startApi } from './start.js';

const ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  // No .env: DATABASE_URL may come from the environment itself.
}

// A bucket named is a store asked for: the keys beside it missing is then an
// error to stop on, not a reason to run without one.
const bucket = process.env['STORAGE_BUCKET'];
const blobStore = bucket ? createBlobStore(storageConfigFromEnv()) : undefined;

const api = await startApi({
  databaseUrl: databaseUrlFromEnv(),
  corpusDir: join(ROOT, 'corpus'),
  port: Number(process.env['PORT'] ?? 3000),
  reconcile: {},
  ...(blobStore === undefined ? {} : { blobStore }),
});
console.log(`@seo/api listening on :${new URL(api.url).port}`);
console.log(bucket ? `page bodies kept in bucket "${bucket}"` : 'no STORAGE_BUCKET: page bodies are hashed, not kept');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void api.close().then(() => process.exit(0));
  });
}
