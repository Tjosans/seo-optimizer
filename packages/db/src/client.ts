import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Database = PostgresJsDatabase<typeof schema>;

export interface DatabaseHandle {
  readonly db: Database;
  /** The underlying driver, for migrations and `LISTEN`/`NOTIFY`. */
  readonly sql: postgres.Sql;
  readonly close: () => Promise<void>;
}

/**
 * Open a connection pool.
 *
 * Callers own the lifetime: one handle per process, closed on shutdown. The
 * URL is passed in rather than read from the environment here, so tests and
 * migrations can point at a throwaway database without mutating process.env.
 */
export function createDatabase(url: string, options: postgres.Options<{}> = {}): DatabaseHandle {
  const sql = postgres(url, options);
  return {
    db: drizzle(sql, { schema }),
    sql,
    close: () => sql.end(),
  };
}

/** Read the connection URL from the environment, failing loudly if unset. */
export function databaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const url = env['DATABASE_URL'];
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env, or start the local ' +
        'stack with `docker compose up -d`.',
    );
  }
  return url;
}
