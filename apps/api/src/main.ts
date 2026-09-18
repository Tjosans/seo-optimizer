/**
 * The audit API's entry point.
 *
 *     npm run serve
 *
 * Listens on PORT (default 3000). Corpus versions are read from the repo's
 * own `corpus/` directory, the same one `npm run release` reads.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CURRENT_CORPUS_VERSION, loadCorpus } from '@seo/corpus';
import { createDatabase, databaseUrlFromEnv } from '@seo/db';
import { createServer } from './server.js';

const ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  // No .env: DATABASE_URL may come from the environment itself.
}

const handle = createDatabase(databaseUrlFromEnv());
const server = createServer({
  db: handle.db,
  loadCorpus: (version) => loadCorpus(join(ROOT, 'corpus', `v${version ?? CURRENT_CORPUS_VERSION}`)),
});

const port = Number(process.env['PORT'] ?? 3000);
server.listen(port, () => {
  console.log(`@seo/api listening on :${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      void handle.close().then(() => process.exit(0));
    });
  });
}
