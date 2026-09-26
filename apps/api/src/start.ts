/**
 * The audit API as a running process, for whoever hosts it: `main.ts` for
 * `npm run serve`, and @seo/desktop, which runs it inside its own window.
 *
 * What differs between the two is where things live — the corpus and the
 * migrations sit in the repo for one and in the installed app's resources for
 * the other — and whether the database is brought up to date on the way up,
 * so those are options and everything else is decided here once.
 */

import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { CURRENT_CORPUS_VERSION, loadCorpus } from '@seo/corpus';
import { createDatabase } from '@seo/db';
import { PostgresJobStore } from '@seo/job-store';
import { AuditScheduler } from '@seo/scheduler';
import type { AuditJob, CrawlBudget } from '@seo/scheduler';
import { createServer } from './server.js';

export const CRAWL_BUDGET: CrawlBudget = {
  userAgent: 'seo-optimizer/0.1 (+https://github.com/Tjosans/seo-optimizer)',
  maxPages: 200,
  maxDepth: 5,
};

export interface StartApiOptions {
  readonly databaseUrl: string;
  /** The directory holding `v<version>/` corpus directories. */
  readonly corpusDir: string;
  /**
   * Drizzle's migrations directory. Given one, the database is migrated
   * before the server listens — what an installed app needs, since an update
   * may carry a migration and there is nobody to run `npm run db:migrate`.
   */
  readonly migrationsDir?: string;
  /**
   * Outstanding audits are written to the `jobs` table under this owner and
   * resumed on the next start. Omit for the in-memory queue `npm run serve`
   * has always had. One process per owner: there is no lease.
   */
  readonly jobOwner?: string;
  /** Defaults to every interface, as `server.listen(port)` does. */
  readonly host?: string;
  /** 0 picks a free port; read the one chosen from `url`. */
  readonly port: number;
}

export interface RunningApi {
  readonly server: Server;
  readonly scheduler: AuditScheduler;
  /** `http://<host>:<port>`, with the port actually bound. */
  readonly url: string;
  /** Stops accepting requests, then the scheduler, then the pool. */
  readonly close: () => Promise<void>;
}

export async function startApi(options: StartApiOptions): Promise<RunningApi> {
  // Postgres notices ("schema drizzle already exists, skipping") are not news.
  const handle = createDatabase(options.databaseUrl, { onnotice: () => {} });
  try {
    if (options.migrationsDir !== undefined) {
      await migrate(handle.db, { migrationsFolder: options.migrationsDir });
    }

    const resolveCorpus = (version: string | undefined) =>
      loadCorpus(join(options.corpusDir, `v${version ?? CURRENT_CORPUS_VERSION}`));

    const scheduler = new AuditScheduler({
      db: handle.db,
      crawl: CRAWL_BUDGET,
      corpus: resolveCorpus,
      ...(options.jobOwner === undefined
        ? {}
        : { store: new PostgresJobStore<AuditJob>({ db: handle.db, queue: 'audits', owner: options.jobOwner }) }),
    });
    void scheduler.recover().catch((error: unknown) => console.error('audit recovery failed', error));

    const server = createServer({ db: handle.db, loadCorpus: resolveCorpus, scheduler });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      if (options.host === undefined) server.listen(options.port, resolve);
      else server.listen(options.port, options.host, resolve);
    });

    const { port } = server.address() as AddressInfo;
    const host = options.host === undefined || options.host === '0.0.0.0' ? 'localhost' : options.host;

    return {
      server,
      scheduler,
      url: `http://${host}:${port}`,
      close: () =>
        new Promise<void>((resolve) => server.close(() => resolve()))
          .then(() => scheduler.close())
          .then(() => handle.close()),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
