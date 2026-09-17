/**
 * A release file: the way a person enters a release and its review runs
 * until the audit API exists.
 *
 * The file is data, already parsed from YAML or JSON; reading it off disk is
 * the caller's business. It names a site by origin and carries at most one
 * release and any number of review runs:
 *
 *     site: https://www.example.com
 *     release: { releaseId: '2026.10', scopeRevision: S-3, … }
 *     reviews:
 *       - { runId: R-1, checkId: '1.1', … }
 *
 * Three rules shape an import:
 *
 * Nothing is guessed. An unknown key, a number where text belongs (YAML reads
 * `2026.10` as 2026.1) or a date that does not parse is refused, because a
 * misspelt field would otherwise be stored as a blank and read as a scope
 * error nobody can find.
 *
 * All or nothing. Every run is checked before anything is written, and the
 * release and the runs go down in one transaction.
 *
 * A file can be imported again. The review log is append-only, so the natural
 * way to keep one is a file that grows: a run already logged exactly as the
 * file gives it is left alone, and one logged differently is refused — a
 * correction is a later run, never an edit.
 */

import { eq } from 'drizzle-orm';
import { instant, reviewRunProblem } from '@seo/core';
import type { Corpus, CutoverAuthorization, LaunchDecision, ReviewRun } from '@seo/core';
import { reviewRuns, sites } from '@seo/db';
import type { Database } from '@seo/db';
import { loadReviewRuns, reviewRunRow, saveRelease } from './release.js';
import type { ReleaseInput } from './release.js';

export interface ReleaseFile {
  /** The site's origin, as `sites.origin` holds it. */
  readonly site: string;
  /** Corpus version the runs name checks from. Absent means the caller's default. */
  readonly corpus?: string;
  readonly release?: ReleaseInput;
  readonly reviews: readonly ReviewRun[];
}

/** A file that is not a release file. Every problem is listed, by path. */
export class ReleaseFileError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`not a valid release file:\n  ${problems.join('\n  ')}`);
    this.name = 'ReleaseFileError';
  }
}

export class UnknownSiteOriginError extends Error {
  constructor(readonly origin: string) {
    super(`no site with origin ${origin}`);
    this.name = 'UnknownSiteOriginError';
  }
}

/** Runs the file gives differently from the log. Nothing was written. */
export class ReviewRunConflictError extends Error {
  constructor(readonly runIds: readonly string[]) {
    super(
      `review runs ${runIds.join(', ')} are already logged with different values; ` +
        'the log is append-only, so record a correction as a new run',
    );
    this.name = 'ReviewRunConflictError';
  }
}

const RELEASE_TEXT = [
  'releaseId', 'scopeRevision', 'origin', 'scopeApprover', 'scopeApprovalEvidence', 'decisionOwner',
] as const;
const RELEASE_TIMES = ['scopeApprovedAt'] as const;
const CUTOVER_TEXT = ['authorizer', 'decisionReference'] as const;
const CUTOVER_TIMES = ['authorizedAt', 'cutoverAt'] as const;
const BINDING_TEXT = ['releaseId', 'scopeRevision', 'origin', 'assessment'] as const;
const RUN_TEXT = [
  'runId', 'checkId', 'releaseId', 'scopeRevision', 'criteriaRevision', 'origin',
  'environment', 'tester', 'result', 'evidence', 'reviewedBy', 'eventTrigger',
] as const;
const RUN_TIMES = ['testedAt', 'reviewedAt', 'nextReviewAt'] as const;
const DECISIONS: ReadonlySet<string> = new Set<LaunchDecision['decision']>(['GO', 'HOLD', 'rollback']);

type Record_ = Record<string, unknown>;

const isRecord = (value: unknown): value is Record_ =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Absent or blank. A value of the wrong type is not blank; it is reported as such. */
const blank = (node: Record_, key: string): boolean => {
  const value = node[key];
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
};

/**
 * Check a parsed file's shape and return it typed, with every time written
 * as an ISO instant. Throws `ReleaseFileError` listing every problem found.
 *
 * Whether a run would count in the assessment is a separate question,
 * answered by `importReleaseFile` against a corpus.
 */
export function parseReleaseFile(value: unknown): ReleaseFile {
  const problems: string[] = [];
  const problem = (path: string, text: string) => problems.push(`${path}: ${text}`);

  /** Keys outside `allowed`, reported; returns whether `value` is a mapping at all. */
  const mapping = (path: string, node: unknown, allowed: readonly string[]): node is Record_ => {
    if (!isRecord(node)) {
      problem(path, 'expected a mapping');
      return false;
    }
    for (const key of Object.keys(node)) {
      if (!allowed.includes(key)) problem(`${path}.${key}`, 'unknown field');
    }
    return true;
  };

  /** Copy the text fields present; a time is normalized, blank stays blank. */
  const fields = (
    path: string,
    node: Record_,
    text: readonly string[],
    times: readonly string[],
  ): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const key of [...text, ...times]) {
      const raw = node[key];
      if (raw === undefined || raw === null) continue;
      if (typeof raw !== 'string') {
        problem(`${path}.${key}`, `expected text, got ${typeof raw} (quote it)`);
        continue;
      }
      if (times.includes(key) && raw.trim() !== '') {
        const ms = instant(raw);
        if (ms === null) {
          problem(`${path}.${key}`, `not a date and time: ${raw}`);
          continue;
        }
        out[key] = new Date(ms).toISOString();
      } else {
        out[key] = raw;
      }
    }
    return out;
  };

  if (!mapping('file', value, ['site', 'corpus', 'release', 'reviews'])) {
    throw new ReleaseFileError(problems);
  }

  const top = fields('file', value, ['site', 'corpus'], []);
  const site = (top['site'] ?? '').trim().replace(/\/+$/, '');
  if (blank(value, 'site')) problem('file.site', 'required: the site’s origin');

  let release: ReleaseInput | undefined;
  if (value['release'] !== undefined) {
    const node = value['release'];
    if (
      mapping('release', node, [
        ...RELEASE_TEXT, ...RELEASE_TIMES, 'criteria', 'cutover', 'launchDecision',
      ])
    ) {
      const base = fields('release', node, RELEASE_TEXT, RELEASE_TIMES);
      if (blank(node, 'releaseId')) {
        problem('release.releaseId', 'required: the name the release is saved under');
      }

      let criteria: Record<string, string> | undefined;
      const revisions = node['criteria'];
      if (revisions !== undefined) {
        if (isRecord(revisions)) {
          criteria = fields('release.criteria', revisions, Object.keys(revisions), []);
        } else {
          problem('release.criteria', 'expected a mapping from check id to criterion revision');
        }
      }

      let cutover: CutoverAuthorization | undefined;
      const cut = node['cutover'];
      if (cut !== undefined && mapping('release.cutover', cut, [...CUTOVER_TEXT, ...CUTOVER_TIMES, 'binding'])) {
        const binding = cut['binding'];
        cutover = {
          ...fields('release.cutover', cut, CUTOVER_TEXT, CUTOVER_TIMES),
          ...(binding !== undefined && mapping('release.cutover.binding', binding, BINDING_TEXT)
            ? { binding: fields('release.cutover.binding', binding, BINDING_TEXT, []) }
            : {}),
        };
      }

      let launchDecision: LaunchDecision | undefined;
      const decided = node['launchDecision'];
      if (
        decided !== undefined &&
        mapping('release.launchDecision', decided, ['decision', 'decidedBy', 'decidedAt'])
      ) {
        const got = fields('release.launchDecision', decided, ['decision', 'decidedBy'], ['decidedAt']);
        if (!DECISIONS.has(got['decision'] ?? '')) {
          problem('release.launchDecision.decision', 'expected GO, HOLD or rollback');
        }
        for (const key of ['decidedBy', 'decidedAt']) {
          if (blank(decided, key)) {
            problem(`release.launchDecision.${key}`, 'required on a recorded decision');
          }
        }
        launchDecision = got as unknown as LaunchDecision;
      }

      release = {
        ...(base as unknown as ReleaseInput),
        ...(criteria === undefined ? {} : { criteria }),
        ...(cutover === undefined ? {} : { cutover }),
        ...(launchDecision === undefined ? {} : { launchDecision }),
      };
    }
  }

  const reviews: ReviewRun[] = [];
  const list = value['reviews'];
  if (list !== undefined && list !== null && !Array.isArray(list)) {
    problem('reviews', 'expected a list');
  } else {
    const seen = new Set<string>();
    (list ?? []).forEach((node: unknown, index: number) => {
      const path = `reviews[${index}]`;
      if (!mapping(path, node, [...RUN_TEXT, ...RUN_TIMES])) return;
      const run = fields(path, node, RUN_TEXT, RUN_TIMES);
      const runId = run['runId'];
      if (runId !== undefined && runId !== '') {
        if (seen.has(runId)) problem(`${path}.runId`, `${runId} appears twice in the file`);
        seen.add(runId);
      }
      reviews.push(run as unknown as ReviewRun);
    });
  }

  if (release === undefined && reviews.length === 0 && problems.length === 0) {
    problem('file', 'holds neither a release nor any reviews');
  }
  if (problems.length > 0) throw new ReleaseFileError(problems);

  return {
    site,
    ...(top['corpus'] === undefined ? {} : { corpus: top['corpus'] }),
    ...(release === undefined ? {} : { release }),
    reviews,
  };
}

export interface ImportResult {
  readonly siteId: string;
  /** The saved release's row id and name, or null when the file held none. */
  readonly release: { readonly id: string; readonly releaseId: string } | null;
  /** Run ids appended to the log. */
  readonly recorded: readonly string[];
  /** Run ids the log already held exactly as the file gives them. */
  readonly unchanged: readonly string[];
  /** True when nothing was written. */
  readonly dryRun: boolean;
}

class DryRun extends Error {
  constructor(readonly result: ImportResult) {
    super('dry run');
  }
}

/**
 * Write a parsed release file. `corpus` is what the runs' check ids are
 * checked against, and `now` bounds their review times as `recordReviewRun`
 * does. With `dryRun` every check and comparison runs and the transaction is
 * rolled back.
 *
 * Throws `ReleaseFileError` listing every run the assessment would count as
 * an input error, `UnknownSiteOriginError` for a site that is not on record —
 * adding sites is the audit API's job — and `ReviewRunConflictError` for runs
 * the log holds differently. Any of them means nothing was written.
 */
export async function importReleaseFile(
  db: Database,
  args: {
    readonly file: ReleaseFile;
    readonly corpus: Corpus;
    readonly now?: Date;
    readonly dryRun?: boolean;
  },
): Promise<ImportResult> {
  const { file } = args;
  const known = new Set(args.corpus.checks.map((check) => check.id));
  const now = (args.now ?? new Date()).toISOString();
  const invalid = file.reviews.flatMap((run, index) => {
    const problem = reviewRunProblem(run, known, now);
    return problem === null ? [] : [`reviews[${index}] (${run.runId || 'no id'}): ${problem}`];
  });
  if (invalid.length > 0) throw new ReleaseFileError(invalid);

  const [site] = await db.select({ id: sites.id }).from(sites).where(eq(sites.origin, file.site));
  if (site === undefined) throw new UnknownSiteOriginError(file.site);

  try {
    return await db.transaction(async (tx) => {
      const logged = new Map((await loadReviewRuns(tx, site.id)).map((run) => [run.runId, run]));
      const conflicts: string[] = [];
      const unchanged: string[] = [];
      const fresh: ReviewRun[] = [];
      for (const run of file.reviews) {
        const held = logged.get(run.runId);
        if (held === undefined) fresh.push(run);
        else if (sameRun(held, run)) unchanged.push(run.runId);
        else conflicts.push(run.runId);
      }
      if (conflicts.length > 0) throw new ReviewRunConflictError(conflicts);

      const release =
        file.release === undefined
          ? null
          : { id: await saveRelease(tx, site.id, file.release), releaseId: file.release.releaseId };
      if (fresh.length > 0) {
        await tx.insert(reviewRuns).values(fresh.map((run) => reviewRunRow(site.id, run)));
      }

      const result: ImportResult = {
        siteId: site.id,
        release,
        recorded: fresh.map((run) => run.runId),
        unchanged,
        dryRun: args.dryRun === true,
      };
      if (args.dryRun === true) throw new DryRun(result);
      return result;
    });
  } catch (error) {
    if (error instanceof DryRun) return error.result;
    throw error;
  }
}

/** Two runs say the same thing. Blank optional fields and absent ones agree. */
function sameRun(a: ReviewRun, b: ReviewRun): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof ReviewRun>;
  for (const key of keys) {
    const left = a[key] ?? '';
    const right = b[key] ?? '';
    if (RUN_TIMES.includes(key as (typeof RUN_TIMES)[number]) && left !== '' && right !== '') {
      if (instant(left) !== instant(right)) return false;
    } else if (left !== right) {
      return false;
    }
  }
  return true;
}
