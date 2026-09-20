/**
 * Reading the access log a `serverLogs` input points at. The parser in
 * `inputs.ts` stays pure and only checks the path is text; this is where the
 * file becomes hits, so a detector reads `hits` and never a file.
 *
 * Privacy: only `{ at, method, path, status, userAgent }` survives a line. The
 * client address, user, referrer and the query string of the request target
 * are never stored.
 */

import { createReadStream } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { AuditInputs, ServerLogHit } from './inputs.js';

// host ident user [time] "request" status bytes "referrer" "user agent"
const COMBINED = /^\S+ \S+ \S+ \[([^\]]+)\] "([^"]*)" (\d{3}) (?:\d+|-)(?: "(?:[^"\\]|\\.)*" "((?:[^"\\]|\\.)*)")?\s*$/;
const TIME = /^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function logTime(text: string): string | null {
  const m = TIME.exec(text);
  if (m === null) return null;
  const month = MONTHS.indexOf(m[2]!.toLowerCase());
  if (month < 0) return null;
  const local = Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]));
  const offset = (Number(m[8]) * 60 + Number(m[9])) * 60_000 * (m[7] === '-' ? -1 : 1);
  const date = new Date(local - offset);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The path of a request target with its query string and fragment removed. */
function stripQuery(target: string): string {
  let path = target;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(path);
  if (scheme !== null) path = path.slice(scheme[0].length);
  const cut = path.search(/[?#]/);
  if (cut >= 0) path = path.slice(0, cut);
  return path === '' ? '/' : path;
}

/** One combined-format line as a hit, or null when it is not one. */
export function parseAccessLogLine(line: string): ServerLogHit | null {
  const m = COMBINED.exec(line);
  if (m === null) return null;
  const at = logTime(m[1]!);
  const request = /^([A-Z]+) (\S+)(?: \S+)?$/.exec(m[2]!);
  if (at === null || request === null) return null;
  return {
    at,
    method: request[1]!,
    path: stripQuery(request[2]!),
    status: Number(m[3]),
    userAgent: (m[4] ?? '').replace(/\\(.)/g, '$1'),
  };
}

/** Read a whole access log a line at a time. */
export async function readAccessLog(file: string): Promise<{ hits: ServerLogHit[]; skippedLines: number }> {
  const hits: ServerLogHit[] = [];
  let skippedLines = 0;
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === '') continue;
    const hit = parseAccessLogLine(line);
    if (hit === null) skippedLines += 1;
    else hits.push(hit);
  }
  return { hits, skippedLines };
}

/**
 * Read the log a `serverLogs` section points at and return the inputs with
 * `hits` filled in. The path resolves against `baseDir`. A file that cannot be
 * read throws with its path: a log the person named and we cannot read is an
 * error, not a gap.
 */
export async function loadServerLogs(inputs: AuditInputs, baseDir: string): Promise<AuditInputs> {
  const section = inputs.serverLogs;
  if (section === undefined) return inputs;
  const file = resolve(baseDir, section.path);
  try {
    return { ...inputs, serverLogs: { ...section, ...(await readAccessLog(file)) } };
  } catch (error) {
    throw new Error(`server log (${file}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** `loadServerLogs` for an inputs file: the path is relative to where that file lives. */
export function loadServerLogsFor(inputs: AuditInputs, inputsFile: string): Promise<AuditInputs> {
  return loadServerLogs(inputs, dirname(resolve(inputsFile)));
}
