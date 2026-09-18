/**
 * The dashboard: a static file server for `public/` plus a reverse proxy at
 * `/api/*` onto the audit API (@seo/api). Proxying rather than having the
 * browser call the API origin directly avoids CORS entirely — `@seo/api` sets
 * no CORS headers today, and giving the dashboard its own same-origin `/api`
 * path needs no change to it. The dashboard holds no database connection and
 * no corpus of its own; every fact it shows came from a `GET`/`POST` the API
 * already answers.
 */

import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

export interface DashboardServerOptions {
  /** Origin of the audit API this dashboard reads from, no trailing slash. */
  readonly apiUrl: string;
  /** Absolute path to the `public/` directory of static assets. */
  readonly publicDir: string;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function createServer(options: DashboardServerOptions): Server {
  return createHttpServer((req, res) => {
    handle(req, res, options).catch((error) => {
      console.error(error);
      if (!res.headersSent) res.writeHead(500).end('internal error');
      else res.end();
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, options: DashboardServerOptions): Promise<void> {
  const rawUrl = req.url ?? '/';
  const path = rawUrl.split('?')[0] ?? '/';

  if (path === '/api' || path.startsWith('/api/')) {
    await proxy(req, res, options, rawUrl.slice('/api'.length) || '/');
    return;
  }

  await serveStatic(req, res, options.publicDir, path);
}

/** Forwards one request to the API, unmodified but for the `/api` prefix. */
async function proxy(
  req: IncomingMessage,
  res: ServerResponse,
  options: DashboardServerOptions,
  upstreamPath: string,
): Promise<void> {
  const method = req.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
  const contentType = req.headers['content-type'];

  let upstream: Response;
  try {
    upstream = await fetch(`${options.apiUrl}${upstreamPath}`, {
      method,
      headers: contentType !== undefined ? { 'content-type': contentType } : {},
      ...(body !== undefined ? { body } : {}),
    });
  } catch {
    res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'audit API unreachable' }));
    return;
  }

  const text = await upstream.text();
  res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  publicDir: string,
  path: string,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }

  const relative = normalize(path === '/' ? '/index.html' : path).replace(/^([.][.][/\\])+/, '');
  const filePath = join(publicDir, relative);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(400).end();
    return;
  }

  try {
    const data = await readFile(filePath);
    const contentType = CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': contentType });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}
