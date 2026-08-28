import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig(({ mode }) => ({
  resolve: {
    alias: {
      // Test against source, so no build step is needed to run the suite.
      '@seo/core': r('./packages/core/src/index.ts'),
      '@seo/corpus': r('./packages/corpus/src/index.ts'),
      '@seo/crawler': r('./packages/crawler/src/index.ts'),
      '@seo/db': r('./packages/db/src/index.ts'),
      '@seo/persistence': r('./packages/persistence/src/index.ts'),
      '@seo/probes': r('./packages/probes/src/index.ts'),
      '@seo/testkit': r('./packages/testkit/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
    environment: 'node',
    // Unprefixed, so DATABASE_URL from a local .env reaches the tests that
    // need a live database. Those tests skip themselves when it is unset.
    env: loadEnv(mode, process.cwd(), ''),
  },
}));
