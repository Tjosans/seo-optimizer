/**
 * The database address the desktop app connects to, and the settings file it
 * lives in. No Electron here, so it is tested without a window.
 *
 * The setup page edits the address as fields rather than one URL, so a
 * password is typed into a password box and never shown back in the clear;
 * `toFields` and `fromFields` translate. `sslmode=require` is the one query
 * parameter it knows, because hosted Postgres (Neon, Supabase, RDS) wants it.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** The local stack's database, as `.env.example` and docker-compose.yml have it. */
export const DEFAULT_DATABASE_URL = 'postgres://seo:seo@localhost:5433/seo_optimizer';

export interface DatabaseFields {
  readonly host: string;
  readonly port: string;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly ssl: boolean;
}

/** One problem per field, keyed by the field it belongs beside. */
export type FieldProblems = Partial<Record<keyof DatabaseFields, string>>;

export function toFields(url: string): DatabaseFields {
  try {
    const parsed = new URL(url);
    const sslmode = parsed.searchParams.get('sslmode') ?? parsed.searchParams.get('ssl');
    return {
      host: decodeURIComponent(parsed.hostname),
      port: parsed.port,
      database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      ssl: sslmode !== null && !['disable', 'false', 'allow', 'prefer'].includes(sslmode),
    };
  } catch {
    return toFields(DEFAULT_DATABASE_URL);
  }
}

/** The URL the fields describe, or what is wrong with them, by field. */
export function fromFields(fields: DatabaseFields): { url: string } | { problems: FieldProblems } {
  const problems: FieldProblems = {};
  const host = fields.host.trim();
  const port = fields.port.trim();
  const database = fields.database.trim();
  const user = fields.user.trim();

  if (host === '') problems.host = 'Required.';
  else if (/[\s/@?#:]/.test(host) && !/^\[[0-9a-f:]+\]$/i.test(host)) problems.host = 'A host name or IP address only, like localhost or db.example.com.';
  if (port !== '' && !(/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) problems.port = 'A number from 1 to 65535, or blank for 5432.';
  if (database === '') problems.database = 'Required.';
  if (user === '') problems.user = 'Required.';
  if (/[\r\n]/.test(fields.password)) problems.password = 'A password cannot contain a line break.';
  if (Object.keys(problems).length > 0) return { problems };

  const url = new URL('postgres://placeholder');
  url.hostname = host;
  url.port = port;
  url.pathname = `/${encodeURIComponent(database)}`;
  url.username = encodeURIComponent(user);
  url.password = encodeURIComponent(fields.password);
  if (fields.ssl) url.searchParams.set('sslmode', 'require');
  return { url: url.toString() };
}

/** The URL as it appears in a message: host and database, never the password. */
export function redact(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password !== '') parsed.password = '***';
    return parsed.toString();
  } catch {
    return 'DATABASE_URL';
  }
}

/** The innermost message: a refused connection arrives wrapped once or twice. */
export function describe(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) return describe(error.errors[0]);
  if (error instanceof Error) return error.cause !== undefined ? describe(error.cause) : error.message;
  return String(error);
}

/**
 * `text` with its `DATABASE_URL` line set to `url`: the first uncommented one
 * replaced where it stands, or a line appended. Every other line — comments,
 * other settings, a second commented-out address — is left exactly as it was.
 */
export function withDatabaseUrl(text: string, url: string): string {
  const line = `DATABASE_URL=${quote(url)}`;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^\s*(export\s+)?DATABASE_URL\s*=/.test(l));
  if (at >= 0) {
    lines[at] = line;
  } else {
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    lines.push(line);
  }
  return lines.join(eol) + (lines[lines.length - 1] === '' ? '' : eol);
}

/**
 * Quoted so `process.loadEnvFile` reads it back verbatim: unquoted, a `#` in
 * a password would start a comment. Single quotes are literal; a URL holding
 * one (fromFields percent-encodes, a hand-written one might not) gets double.
 */
function quote(url: string): string {
  return url.includes("'") ? `"${url}"` : `'${url}'`;
}

export function saveDatabaseUrl(envPath: string, url: string): void {
  let text = '';
  try {
    text = readFileSync(envPath, 'utf8');
  } catch {
    // No settings file yet: this is its first line.
  }
  mkdirSync(dirname(envPath), { recursive: true });
  writeFileSync(envPath, withDatabaseUrl(text, url));
}
