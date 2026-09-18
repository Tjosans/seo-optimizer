/**
 * The audit API.
 *
 * `POST /releases` is the same door `npm run release` already opens —
 * `parseReleaseFile` and `importReleaseFile` from @seo/grader, unchanged —
 * so the file import and this endpoint read one rulebook and cannot come to
 * disagree about what a release file is allowed to say.
 *
 * `/sites` is site management: create, list, update, delete. Validation lives
 * in `sites.ts` (`parseSiteInput`), shared by the create and update handlers
 * the same way `parseReleaseFile` is shared by the release door above.
 *
 * `/audits` is the audit lifecycle: `POST /audits` submits one through the
 * same `AuditScheduler` a caller building this server already constructed —
 * this endpoint carries no scheduling policy of its own, only request
 * validation (`audits.ts`, `parseAuditRequest`). `GET /audits/:id` reads the
 * durable row back, and `GET /audits/:id/result` adds the checks graded
 * against it. Attestation and a standalone readiness endpoint are their own
 * roadmap lines.
 */

import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { asc, eq } from 'drizzle-orm';
import type { Corpus } from '@seo/core';
import type { Database } from '@seo/db';
import { audits, checkStates, sites } from '@seo/db';
import {
  ReleaseFileError,
  ReviewRunConflictError,
  UnknownReleaseError,
  UnknownSiteOriginError,
  importReleaseFile,
  parseReleaseFile,
} from '@seo/grader';
import type { AuditScheduler } from '@seo/scheduler';
import { UnknownSiteError } from '@seo/scheduler';
import { AuditInputError, parseAuditRequest } from './audits.js';
import { SiteInputError, parseSiteInput } from './sites.js';

export interface ApiServerOptions {
  readonly db: Database;
  /** Resolves a corpus version — the file's own, or the caller's default when it names none. */
  readonly loadCorpus: (version: string | undefined) => Corpus;
  /**
   * Runs the audits this server submits. Optional so a server built only for
   * `/releases` or `/sites` (as every existing test here does) need not wire
   * one up; `/audits` answers 503 without it rather than throwing.
   */
  readonly scheduler?: AuditScheduler;
}

export function createServer(options: ApiServerOptions): Server {
  return createHttpServer((req, res) => {
    handle(req, res, options).catch((error) => {
      console.error(error);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      else res.end();
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, options: ApiServerOptions): Promise<void> {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (req.method === 'POST' && path === '/releases') {
    await postRelease(req, res, options);
    return;
  }
  if (path === '/sites') {
    if (req.method === 'POST') {
      await postSite(req, res, options);
      return;
    }
    if (req.method === 'GET') {
      await listSites(res, options);
      return;
    }
  }
  const siteMatch = /^\/sites\/([^/]+)$/.exec(path);
  if (siteMatch) {
    const id = decodeURIComponent(siteMatch[1]!);
    if (req.method === 'PATCH') {
      await patchSite(req, res, options, id);
      return;
    }
    if (req.method === 'DELETE') {
      await deleteSite(res, options, id);
      return;
    }
  }
  if (req.method === 'POST' && path === '/audits') {
    await postAudit(req, res, options);
    return;
  }
  const auditResultMatch = /^\/audits\/([^/]+)\/result$/.exec(path);
  if (auditResultMatch && req.method === 'GET') {
    await getAuditResult(res, options, decodeURIComponent(auditResultMatch[1]!));
    return;
  }
  const auditMatch = /^\/audits\/([^/]+)$/.exec(path);
  if (auditMatch && req.method === 'GET') {
    await getAudit(res, options, decodeURIComponent(auditMatch[1]!));
    return;
  }
  send(res, 404, { error: 'not found' });
}

async function postSite(req: IncomingMessage, res: ServerResponse, options: ApiServerOptions): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    send(res, 400, { error: error instanceof Error ? error.message : 'invalid JSON body' });
    return;
  }

  let input;
  try {
    input = parseSiteInput(body, true);
  } catch (error) {
    if (error instanceof SiteInputError) {
      send(res, 400, { error: 'invalid site', problems: error.problems });
      return;
    }
    throw error;
  }

  try {
    const [row] = await options.db
      .insert(sites)
      .values({
        name: input.name!,
        origin: input.origin!,
        ...(input.flags !== undefined ? { flags: input.flags } : {}),
        ...(input.profile !== undefined ? { profile: input.profile } : {}),
        ...(input.aiPolicy !== undefined ? { aiPolicy: input.aiPolicy } : {}),
        ...(input.profileCorpusVersion !== undefined
          ? { profileCorpusVersion: input.profileCorpusVersion }
          : {}),
      })
      .returning();
    send(res, 201, row);
  } catch (error) {
    if (isUniqueViolation(error)) {
      send(res, 409, { error: `a site with origin ${input.origin} already exists` });
      return;
    }
    throw error;
  }
}

async function listSites(res: ServerResponse, options: ApiServerOptions): Promise<void> {
  const rows = await options.db.select().from(sites).orderBy(sites.createdAt);
  send(res, 200, { sites: rows });
}

async function patchSite(
  req: IncomingMessage,
  res: ServerResponse,
  options: ApiServerOptions,
  id: string,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    send(res, 400, { error: error instanceof Error ? error.message : 'invalid JSON body' });
    return;
  }

  let input;
  try {
    input = parseSiteInput(body, false);
  } catch (error) {
    if (error instanceof SiteInputError) {
      send(res, 400, { error: 'invalid site', problems: error.problems });
      return;
    }
    throw error;
  }

  if (Object.keys(input).length === 0) {
    send(res, 400, { error: 'no fields to update' });
    return;
  }

  try {
    const [row] = await options.db
      .update(sites)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(sites.id, id))
      .returning();
    if (row === undefined) {
      send(res, 404, { error: `no site ${id}` });
      return;
    }
    send(res, 200, row);
  } catch (error) {
    if (isUniqueViolation(error)) {
      send(res, 409, { error: `a site with origin ${input.origin} already exists` });
      return;
    }
    if (isInvalidId(error)) {
      send(res, 400, { error: `invalid site id: ${id}` });
      return;
    }
    throw error;
  }
}

async function deleteSite(res: ServerResponse, options: ApiServerOptions, id: string): Promise<void> {
  try {
    const [row] = await options.db.delete(sites).where(eq(sites.id, id)).returning({ id: sites.id });
    if (row === undefined) {
      send(res, 404, { error: `no site ${id}` });
      return;
    }
    res.writeHead(204);
    res.end();
  } catch (error) {
    if (isInvalidId(error)) {
      send(res, 400, { error: `invalid site id: ${id}` });
      return;
    }
    throw error;
  }
}

async function postAudit(req: IncomingMessage, res: ServerResponse, options: ApiServerOptions): Promise<void> {
  const scheduler = options.scheduler;
  if (scheduler === undefined) {
    send(res, 503, { error: 'no audit scheduler is configured on this server' });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    send(res, 400, { error: error instanceof Error ? error.message : 'invalid JSON body' });
    return;
  }

  let request;
  try {
    request = parseAuditRequest(body);
  } catch (error) {
    if (error instanceof AuditInputError) {
      send(res, 400, { error: 'invalid audit', problems: error.problems });
      return;
    }
    throw error;
  }

  try {
    const handle = await scheduler.submit(request);
    send(res, 202, { auditId: handle.auditId, status: 'pending' });
  } catch (error) {
    if (error instanceof UnknownSiteError) {
      send(res, 404, { error: error.message });
    } else if (error instanceof UnknownReleaseError) {
      send(res, 404, { error: error.message });
    } else if (error instanceof Error) {
      // Everything else `submit` throws synchronously is a bad request: no
      // seeds, or a site's own AI policy this engine cannot read.
      send(res, 400, { error: error.message });
    } else {
      throw error;
    }
  }
}

async function getAudit(res: ServerResponse, options: ApiServerOptions, id: string): Promise<void> {
  let row;
  try {
    [row] = await options.db.select().from(audits).where(eq(audits.id, id));
  } catch (error) {
    if (isInvalidId(error)) {
      send(res, 400, { error: `invalid audit id: ${id}` });
      return;
    }
    throw error;
  }
  if (row === undefined) {
    send(res, 404, { error: `no audit ${id}` });
    return;
  }

  // The in-process view, when this is the worker running it: which attempt,
  // and whether it is still waiting for a slot. Absent — on another worker,
  // after a restart, or with no scheduler configured — the database row
  // above is the whole answer, exactly as durability promises it should be.
  const job = options.scheduler?.status(id);
  send(res, 200, {
    ...row,
    queue: job === undefined ? null : { state: job.state, attempt: job.attempt, priority: job.priority },
  });
}

async function getAuditResult(res: ServerResponse, options: ApiServerOptions, id: string): Promise<void> {
  let row;
  try {
    [row] = await options.db.select().from(audits).where(eq(audits.id, id));
  } catch (error) {
    if (isInvalidId(error)) {
      send(res, 400, { error: `invalid audit id: ${id}` });
      return;
    }
    throw error;
  }
  if (row === undefined) {
    send(res, 404, { error: `no audit ${id}` });
    return;
  }

  const checks = await options.db
    .select()
    .from(checkStates)
    .where(eq(checkStates.auditId, id))
    .orderBy(asc(checkStates.checkId));

  send(res, 200, {
    auditId: row.id,
    status: row.status,
    readiness: row.readiness,
    checks,
  });
}

/** Postgres' error code, unwrapped from drizzle's own `DrizzleQueryError` wrapper. */
function pgCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') return code;
  return pgCode((error as { cause?: unknown }).cause);
}

/** Postgres' `unique_violation` — a second site claiming an origin already on record. */
function isUniqueViolation(error: unknown): boolean {
  return pgCode(error) === '23505';
}

/** Postgres' `invalid_text_representation` — an id that is not even a UUID. */
function isInvalidId(error: unknown): boolean {
  return pgCode(error) === '22P02';
}

async function postRelease(req: IncomingMessage, res: ServerResponse, options: ApiServerOptions): Promise<void> {
  const dryRun = new URL(req.url ?? '', 'http://localhost').searchParams.get('dryRun') === 'true';

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    send(res, 400, { error: error instanceof Error ? error.message : 'invalid JSON body' });
    return;
  }

  let file;
  try {
    file = parseReleaseFile(body);
  } catch (error) {
    if (error instanceof ReleaseFileError) {
      send(res, 400, { error: 'invalid release file', problems: error.problems });
      return;
    }
    throw error;
  }

  const corpus = options.loadCorpus(file.corpus);
  try {
    const result = await importReleaseFile(options.db, { file, corpus, dryRun });
    send(res, dryRun ? 200 : 201, result);
  } catch (error) {
    if (error instanceof ReleaseFileError) {
      send(res, 400, { error: 'invalid release file', problems: error.problems });
    } else if (error instanceof UnknownSiteOriginError) {
      send(res, 404, { error: error.message });
    } else if (error instanceof ReviewRunConflictError) {
      send(res, 409, { error: error.message, runIds: error.runIds });
    } else {
      throw error;
    }
  }
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(text);
}
