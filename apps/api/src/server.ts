/**
 * The audit API's release endpoint.
 *
 * `POST /releases` is the same door `npm run release` already opens —
 * `parseReleaseFile` and `importReleaseFile` from @seo/grader, unchanged —
 * so the file import and this endpoint read one rulebook and cannot come to
 * disagree about what a release file is allowed to say.
 */

import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Corpus } from '@seo/core';
import type { Database } from '@seo/db';
import {
  ReleaseFileError,
  ReviewRunConflictError,
  UnknownSiteOriginError,
  importReleaseFile,
  parseReleaseFile,
} from '@seo/grader';

export interface ApiServerOptions {
  readonly db: Database;
  /** Resolves a corpus version — the file's own, or the caller's default when it names none. */
  readonly loadCorpus: (version: string | undefined) => Corpus;
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
  const path = (req.url ?? '').split('?')[0];
  if (req.method === 'POST' && path === '/releases') {
    await postRelease(req, res, options);
    return;
  }
  send(res, 404, { error: 'not found' });
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
