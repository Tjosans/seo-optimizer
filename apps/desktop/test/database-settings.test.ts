/**
 * The desktop app's database address (`database-settings.ts`), without
 * Electron: the fields the setup page edits, and the `.env` line they end up
 * as. What is written must read back through Node's own `.env` parser
 * (`process.loadEnvFile` in main.ts) as exactly the URL that connected.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DATABASE_URL,
  fromFields,
  redact,
  saveDatabaseUrl,
  toFields,
  withDatabaseUrl,
} from '../src/database-settings.js';
import type { DatabaseFields } from '../src/database-settings.js';

const LOCAL: DatabaseFields = { host: 'localhost', port: '5433', database: 'seo_optimizer', user: 'seo', password: 'seo', ssl: false };

describe('toFields and fromFields', () => {
  it('reads the local stack default into fields, and back', () => {
    expect(toFields(DEFAULT_DATABASE_URL)).toEqual(LOCAL);
    expect(fromFields(LOCAL)).toEqual({ url: DEFAULT_DATABASE_URL });
  });

  it('round-trips a password full of URL syntax', () => {
    const fields = { ...LOCAL, password: 'p@ss:w/rd#1?%' };
    const built = fromFields(fields);
    if (!('url' in built)) throw new Error('expected a url');
    expect(toFields(built.url)).toEqual(fields);
    expect(new URL(built.url).hostname).toBe('localhost');
  });

  it('asks for SSL with sslmode=require, and reads it back', () => {
    const built = fromFields({ ...LOCAL, host: 'ep-x.neon.tech', port: '', ssl: true });
    expect(built).toEqual({ url: 'postgres://seo:seo@ep-x.neon.tech/seo_optimizer?sslmode=require' });
    expect(toFields('postgresql://a:b@h/db?sslmode=verify-full').ssl).toBe(true);
    expect(toFields('postgresql://a:b@h/db?sslmode=disable').ssl).toBe(false);
  });

  it('refuses every bad field at once, each by name', () => {
    expect(fromFields({ host: 'db.example.com/x', port: '99999', database: ' ', user: '', password: 'a\nb', ssl: false })).toEqual({
      problems: {
        host: 'A host name or IP address only, like localhost or db.example.com.',
        port: 'A number from 1 to 65535, or blank for 5432.',
        database: 'Required.',
        user: 'Required.',
        password: 'A password cannot contain a line break.',
      },
    });
  });

  it('allows a blank password and a bracketed IPv6 host', () => {
    expect(fromFields({ ...LOCAL, host: '[::1]', password: '' })).toEqual({ url: 'postgres://seo@[::1]:5433/seo_optimizer' });
  });

  it('falls back to the default for an address that does not parse', () => {
    expect(toFields('not a url')).toEqual(LOCAL);
  });
});

describe('redact', () => {
  it('hides the password and nothing else', () => {
    expect(redact('postgres://seo:secret@db:5432/x')).toBe('postgres://seo:***@db:5432/x');
    expect(redact('postgres://seo@db/x')).toBe('postgres://seo@db/x');
  });
});

describe('withDatabaseUrl', () => {
  const read = (text: string) => parseEnv(text)['DATABASE_URL'];

  it('writes a first line into an empty file', () => {
    expect(withDatabaseUrl('', DEFAULT_DATABASE_URL)).toBe(`DATABASE_URL='${DEFAULT_DATABASE_URL}'\n`);
  });

  it('replaces the live line in place and leaves the rest alone', () => {
    const before = '# settings\nREDIS_URL=redis://x\nDATABASE_URL=postgres://old\n# DATABASE_URL=postgres://other\n';
    const after = withDatabaseUrl(before, 'postgres://new/db');
    expect(after).toBe("# settings\nREDIS_URL=redis://x\nDATABASE_URL='postgres://new/db'\n# DATABASE_URL=postgres://other\n");
  });

  it('appends when only a commented-out line exists, keeping CRLF files CRLF', () => {
    expect(withDatabaseUrl('# DATABASE_URL=x\r\nA=1', 'postgres://n/db')).toBe("# DATABASE_URL=x\r\nA=1\r\nDATABASE_URL='postgres://n/db'\r\n");
  });

  it('reads back through Node’s parser verbatim, a # in the password included', () => {
    const built = fromFields({ ...LOCAL, password: "it's#not=a comment" });
    if (!('url' in built)) throw new Error('expected a url');
    expect(read(withDatabaseUrl('', built.url))).toBe(built.url);
    // A hand-written URL with a raw quote in it still reads back.
    expect(read(withDatabaseUrl('', "postgres://a:it's@h/db"))).toBe("postgres://a:it's@h/db");
  });
});

describe('saveDatabaseUrl', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it('creates the settings folder and file, then updates it in place', () => {
    dir = mkdtempSync(join(tmpdir(), 'seo-desktop-'));
    const env = join(dir, 'SEO Optimizer', '.env');
    saveDatabaseUrl(env, 'postgres://a/one');
    writeFileSync(env, `${readFileSync(env, 'utf8')}OTHER=1\n`);
    saveDatabaseUrl(env, 'postgres://a/two');
    expect(readFileSync(env, 'utf8')).toBe("DATABASE_URL='postgres://a/two'\nOTHER=1\n");
  });
});
