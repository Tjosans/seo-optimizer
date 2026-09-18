/**
 * The audit API's entry point.
 *
 *     npm run serve
 *
 * Listens on PORT (default 3000). Corpus versions are read from the repo's
 * own `corpus/` directory, the same one `npm run release` reads. An
 * `AuditScheduler` is built here rather than in `server.ts` — the crawl
 * budget, concurrency and retry policy are process configuration, the same
 * reasoning `AuditSchedulerOptions.blobStore`'s doc comment already gives for
 * a `BlobStore` — so a test building a server for `/releases` or `/sites`
 * alone need not stand one up.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CURRENT_CORPUS_VERSION, loadCorpus } from '@seo/corpus';
import { createDatabase, databaseUrlFromEnv } from '@seo/db';
import { AuditScheduler } from '@seo/scheduler';
import type { CrawlBudget } from '@seo/scheduler';
import { createServer } from './server.js';

const ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  // No .env: DATABASE_URL may come from the environment itself.
}

const handle = createDatabase(databaseUrlFromEnv());
const resolveCorpus = (version: string | undefined) =>
  loadCorpus(join(ROOT, 'corpus', `v${version ?? CURRENT_CORPUS_VERSION}`));

const CRAWL_BUDGET: CrawlBudget = {
  userAgent: 'seo-optimizer/0.1 (+https://github.com/Tjosans/seo-optimizer)',
  maxPages: 200,
  maxDepth: 5,
};

const scheduler = new AuditScheduler({
  db: handle.db,
  crawl: CRAWL_BUDGET,
  corpus: resolveCorpus,
});
void scheduler.recover();

const server = createServer({
  db: handle.db,
  loadCorpus: resolveCorpus,
  scheduler,
});

const port = Number(process.env['PORT'] ?? 3000);
server.listen(port, () => {
  console.log(`@seo/api listening on :${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      void scheduler
        .close()
        .then(() => handle.close())
        .then(() => process.exit(0));
    });
  });
}
