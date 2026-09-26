/**
 * The audit API's entry point.
 *
 *     npm run serve
 *
 * Listens on PORT (default 3000). Corpus versions are read from the repo's
 * own `corpus/` directory, the same one `npm run release` reads. What a
 * running API is — the scheduler, its crawl budget, the server — is decided
 * in `start.ts`, which @seo/desktop runs too; this file only says where the
 * repo keeps things.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { databaseUrlFromEnv } from '@seo/db';
import { startApi } from './start.js';

const ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  // No .env: DATABASE_URL may come from the environment itself.
}

const api = await startApi({
  databaseUrl: databaseUrlFromEnv(),
  corpusDir: join(ROOT, 'corpus'),
  port: Number(process.env['PORT'] ?? 3000),
});
console.log(`@seo/api listening on :${new URL(api.url).port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void api.close().then(() => process.exit(0));
  });
}
