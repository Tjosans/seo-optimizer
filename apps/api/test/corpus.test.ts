/**
 * `GET /corpus` and `GET /corpus/:version`: the methodology over HTTP. No
 * database — the handler reads only `loadCorpus`, so this runs everywhere.
 */

import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@seo/db';
import { CURRENT_CORPUS_VERSION, knownFlags, loadCorpus } from '@seo/corpus';
import { createServer } from '../src/server.js';

const CORPUS_DIR = fileURLToPath(new URL('../../../corpus', import.meta.url));
const requested: (string | undefined)[] = [];

describe('GET /corpus', () => {
  const server = createServer({
    db: {} as Database,
    loadCorpus: (version) => {
      requested.push(version);
      return loadCorpus(join(CORPUS_DIR, `v${version ?? CURRENT_CORPUS_VERSION}`));
    },
  });
  let base: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('serves the current corpus, every check with its text, and the flags it knows', async () => {
    const res = await fetch(`${base}/corpus`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const expected = loadCorpus(join(CORPUS_DIR, `v${CURRENT_CORPUS_VERSION}`));

    expect(body.version).toBe(CURRENT_CORPUS_VERSION);
    expect(body.reviewed).toBe(expected.reviewed);
    expect(body.checks).toHaveLength(expected.checks.length);
    expect(body.checks[0]).toMatchObject({
      id: expected.checks[0]!.id,
      task: expected.checks[0]!.task,
      whatToDo: expected.checks[0]!.whatToDo,
      doneWhen: expected.checks[0]!.doneWhen,
      automation: expected.checks[0]!.automation,
      launchGate: expected.checks[0]!.launchGate,
    });
    expect(body.knownFlags).toEqual([...knownFlags(expected)].sort());
    expect(requested.at(-1)).toBeUndefined();
  });

  it('serves a named version', async () => {
    const res = await fetch(`${base}/corpus/4.4`);
    expect(res.status).toBe(200);
    expect((await res.json()).version).toBe('4.4');
  });

  it('404s a version not on disk', async () => {
    const res = await fetch(`${base}/corpus/9.9`);
    expect(res.status).toBe(404);
  });

  it('400s a version that is not a version, before it reaches the loader', async () => {
    const before = requested.length;
    const res = await fetch(`${base}/corpus/..%2F..%2Fsecrets`);
    expect(res.status).toBe(400);
    expect(requested).toHaveLength(before);
  });
});
