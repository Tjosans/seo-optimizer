/**
 * Release files: the shape a person writes, and what an import does with it.
 *
 * The parser runs without a database. The import tests skip unless
 * DATABASE_URL is set (`npm run stack:up`), and prove the three promises the
 * file format makes: nothing is guessed, nothing is half written, and the same
 * file can be imported again.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { parse } from 'yaml';
import { reviewRunProblem } from '@seo/core';
import type { Check, Corpus } from '@seo/core';
import { CURRENT_CORPUS_VERSION, loadCorpus } from '@seo/corpus';
import { createDatabase, releases, reviewRuns, sites } from '@seo/db';
import {
  ReleaseFileError,
  ReviewRunConflictError,
  UnknownSiteOriginError,
  importReleaseFile,
  loadRelease,
  parseReleaseFile,
} from '@seo/grader';

const ORIGIN = 'https://release-file-test.example';

const run = (over: Record<string, unknown> = {}) => ({
  runId: 'run-1',
  checkId: '1.1',
  releaseId: 'r1',
  scopeRevision: 's1',
  criteriaRevision: 'test',
  origin: ORIGIN,
  environment: 'pre-production',
  testedAt: '2026-09-02T00:00:00Z',
  tester: 'Tess',
  result: 'passed',
  evidence: 'EV-1',
  reviewedBy: 'Rex',
  reviewedAt: '2026-09-02T01:00:00Z',
  nextReviewAt: '2027-01-01T00:00:00Z',
  ...over,
});

const problemsOf = (value: unknown): readonly string[] => {
  try {
    parseReleaseFile(value);
  } catch (error) {
    if (error instanceof ReleaseFileError) return error.problems;
    throw error;
  }
  return [];
};

describe('parseReleaseFile', () => {
  it('reads a release and runs, writing every time as an ISO instant', () => {
    const file = parseReleaseFile({
      site: `${ORIGIN}/`,
      release: {
        releaseId: 'r1',
        scopeApprovedAt: '2026-09-01T02:00:00+02:00',
        criteria: { '1.1': 'test' },
        cutover: { authorizer: 'Ava', binding: { releaseId: 'r1' } },
        launchDecision: { decision: 'HOLD', decidedBy: 'Owen', decidedAt: '2026-09-12T10:00:00Z' },
      },
      reviews: [run({ nextReviewAt: '' })],
    });

    expect(file.site).toBe(ORIGIN);
    expect(file.release).toEqual({
      releaseId: 'r1',
      scopeApprovedAt: '2026-09-01T00:00:00.000Z',
      criteria: { '1.1': 'test' },
      cutover: { authorizer: 'Ava', binding: { releaseId: 'r1' } },
      launchDecision: { decision: 'HOLD', decidedBy: 'Owen', decidedAt: '2026-09-12T10:00:00.000Z' },
    });
    expect(file.reviews[0]).toMatchObject({
      testedAt: '2026-09-02T00:00:00.000Z',
      nextReviewAt: '',
    });
  });

  it('refuses what it would otherwise have to guess, naming every problem', () => {
    expect(
      problemsOf({
        site: ORIGIN,
        release: { releaseId: 2026.1, scopeRevison: 's1', scopeApprovedAt: 'last Tuesday' },
        reviews: [run({ checkId: 1.1 }), run({ tester: undefined, colour: 'red' })],
      }),
    ).toEqual([
      'release.scopeRevison: unknown field',
      'release.releaseId: expected text, got number (quote it)',
      'release.scopeApprovedAt: not a date and time: last Tuesday',
      'reviews[0].checkId: expected text, got number (quote it)',
      'reviews[1].colour: unknown field',
      'reviews[1].runId: run-1 appears twice in the file',
    ]);
  });

  it('requires a site, a release name and something to record', () => {
    expect(problemsOf({ release: {} })).toEqual([
      'file.site: required: the site’s origin',
      'release.releaseId: required: the name the release is saved under',
    ]);
    expect(problemsOf({ site: ORIGIN })).toEqual(['file: holds neither a release nor any reviews']);
    expect(problemsOf([])).toEqual(['file: expected a mapping']);
    expect(problemsOf({ site: ORIGIN, reviews: {} })).toEqual(['reviews: expected a list']);
  });

  it('refuses a launch decision that is not one', () => {
    expect(
      problemsOf({ site: ORIGIN, release: { releaseId: 'r1', launchDecision: { decision: 'yes' } } }),
    ).toEqual([
      'release.launchDecision.decision: expected GO, HOLD or rollback',
      'release.launchDecision.decidedBy: required on a recorded decision',
      'release.launchDecision.decidedAt: required on a recorded decision',
    ]);
  });

  it('accepts the example file, and its runs count against the current corpus', () => {
    const text = readFileSync(
      fileURLToPath(new URL('../../../scripts/release.example.yaml', import.meta.url)),
      'utf8',
    );
    const file = parseReleaseFile(parse(text));
    expect(file.corpus).toBe(CURRENT_CORPUS_VERSION);
    expect(file.release?.releaseId).toBe('2026.10');

    const corpus = loadCorpus(
      fileURLToPath(new URL(`../../../corpus/v${CURRENT_CORPUS_VERSION}`, import.meta.url)),
    );
    const known = new Set(corpus.checks.map((check) => check.id));
    for (const review of file.reviews) {
      expect(reviewRunProblem(review, known, '2026-09-17T00:00:00Z')).toBeNull();
    }
  });
});

const CORPUS: Corpus = {
  version: 'test',
  reviewed: '2026-09-17',
  checks: [{ id: '1.1' } as Check],
};

const url = process.env['DATABASE_URL'];

describe.skipIf(!url)('importReleaseFile', () => {
  const handle = createDatabase(url ?? '', { max: 4 });
  const { db } = handle;
  let siteId: string;

  const logged = () => db.select().from(reviewRuns).where(eq(reviewRuns.siteId, siteId));
  const saved = () => db.select().from(releases).where(eq(releases.siteId, siteId));
  const load = (value: unknown) => parseReleaseFile(value);

  afterAll(async () => {
    await db.delete(sites).where(sql`${sites.origin} = ${ORIGIN}`);
    await handle.close();
  });

  beforeEach(async () => {
    await db.delete(sites).where(sql`${sites.origin} = ${ORIGIN}`);
    const [site] = await db
      .insert(sites)
      .values({ name: 'release file fixture', origin: ORIGIN })
      .returning({ id: sites.id });
    siteId = site!.id;
  });

  it('saves the release and appends the runs', async () => {
    const file = load({ site: ORIGIN, release: { releaseId: 'r1', decisionOwner: 'Owen' }, reviews: [run()] });
    const result = await importReleaseFile(db, { file, corpus: CORPUS });

    expect(result).toMatchObject({ siteId, recorded: ['run-1'], unchanged: [], dryRun: false });
    const release = await loadRelease(db, result.release!.id);
    expect(release).toMatchObject({ releaseId: 'r1', decisionOwner: 'Owen' });
    expect(release.reviews).toEqual([parseReleaseFile({ site: ORIGIN, reviews: [run()] }).reviews[0]]);
  });

  it('skips runs already logged unchanged, so a growing file can be imported again', async () => {
    await importReleaseFile(db, { file: load({ site: ORIGIN, reviews: [run()] }), corpus: CORPUS });
    const again = await importReleaseFile(db, {
      // The same instants, written another way, are the same run.
      file: load({
        site: ORIGIN,
        reviews: [run({ testedAt: '2026-09-02T02:00:00+02:00' }), run({ runId: 'run-2' })],
      }),
      corpus: CORPUS,
    });

    expect(again).toMatchObject({ recorded: ['run-2'], unchanged: ['run-1'] });
    expect(await logged()).toHaveLength(2);
  });

  it('refuses a run logged differently, and writes nothing else from the file', async () => {
    await importReleaseFile(db, { file: load({ site: ORIGIN, reviews: [run()] }), corpus: CORPUS });
    const edited = load({
      site: ORIGIN,
      release: { releaseId: 'r1' },
      reviews: [run({ runId: 'run-2' }), run({ result: 'failed' })],
    });

    await expect(importReleaseFile(db, { file: edited, corpus: CORPUS })).rejects.toBeInstanceOf(
      ReviewRunConflictError,
    );
    expect(await logged()).toHaveLength(1);
    expect(await saved()).toHaveLength(0);
  });

  it('refuses the whole file when any run would be an input error', async () => {
    const file = load({
      site: ORIGIN,
      release: { releaseId: 'r1' },
      reviews: [run(), run({ runId: 'run-2', checkId: '9.9' }), run({ runId: 'run-3', result: 'reopened' })],
    });

    await expect(importReleaseFile(db, { file, corpus: CORPUS })).rejects.toMatchObject({
      problems: [
        'reviews[1] (run-2): unknown check 9.9',
        'reviews[2] (run-3): a reopened run needs the event that reopened it',
      ],
    });
    expect(await logged()).toHaveLength(0);
    expect(await saved()).toHaveLength(0);
  });

  it('writes nothing on a dry run, and reports what it would have done', async () => {
    const file = load({ site: ORIGIN, release: { releaseId: 'r1' }, reviews: [run()] });
    const result = await importReleaseFile(db, { file, corpus: CORPUS, dryRun: true });

    expect(result).toMatchObject({ dryRun: true, recorded: ['run-1'], release: { releaseId: 'r1' } });
    expect(await logged()).toHaveLength(0);
    expect(await saved()).toHaveLength(0);
  });

  it('refuses a site that is not on record', async () => {
    const file = load({ site: 'https://nobody-here.example', reviews: [run()] });
    await expect(importReleaseFile(db, { file, corpus: CORPUS })).rejects.toBeInstanceOf(
      UnknownSiteOriginError,
    );
  });
});
