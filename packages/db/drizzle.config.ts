import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit reads this to diff the schema and to apply migrations. Run from
 * the repo root: `npm run db:generate` then `npm run db:migrate`.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/enums.ts', './src/schema.ts'],
  out: './migrations',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://seo:seo@localhost:5433/seo_optimizer',
  },
  // Never destructive without being asked; a dropped column is a lost audit.
  strict: true,
  verbose: true,
});
