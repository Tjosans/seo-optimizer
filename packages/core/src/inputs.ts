/**
 * Supplied evidence: what a person hands the audit because nothing observable
 * can stand in for it (the AI crawler policy is the first such input, and
 * still lives on the site record).
 *
 * An `AuditInputs` is an optional bag of named sections, one per kind of
 * evidence. Three rules hold for every section a detector reads:
 *
 * - A missing section makes the detectors that read it `not-applicable`.
 *   Nothing is guessed from its absence.
 * - Each section (or each entry of one) carries an `InputRecord`: who stands
 *   behind it, when it was recorded and, optionally, when it goes stale.
 * - A record with no owner, or one past its `nextReviewAt`, holds its check
 *   (`warn`), never passes it: evidence nobody answers for, or nobody has
 *   looked at lately, is not proof.
 *
 * Each section is added with the detector that reads it.
 */

import { instant } from './review.js';

/** Who supplied a piece of evidence, and how long it can be trusted. */
export interface InputRecord {
  readonly owner: string;
  /** ISO 8601 instant. */
  readonly recordedAt: string;
  /** ISO 8601 instant. Absent means the record does not expire. */
  readonly nextReviewAt?: string;
}

export const INPUT_RECORD_TEXT = ['owner'] as const;
export const INPUT_RECORD_TIMES = ['recordedAt', 'nextReviewAt'] as const;
export const INPUT_RECORD_KEYS: readonly string[] = [...INPUT_RECORD_TEXT, ...INPUT_RECORD_TIMES];

/**
 * One running test whose variants live at their own URLs (1.19). The record
 * fields say who registered it and when; `retireBy` is when the experiment
 * must be over and its variants gone or folded into the control.
 */
export interface ExperimentRecord extends InputRecord {
  readonly controlUrl: string;
  readonly variantUrls: readonly string[];
  /** How the variants are served: `redirect`, `canonical`, `cookie`… free text. */
  readonly method: string;
  /** ISO 8601 instant. */
  readonly retireBy: string;
}

/** Every section an audit can be given. */
export interface AuditInputs {
  /** Experiments the site runs on separate URLs (1.19). */
  readonly experiments?: readonly ExperimentRecord[];
}

/** Section names `parseInputs` accepts. */
export const INPUT_SECTIONS: readonly (keyof AuditInputs & string)[] = ['experiments'];

/** A value that is not valid inputs. Every problem is listed, by path. */
export class InputsError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`not valid audit inputs:\n  ${problems.join('\n  ')}`);
    this.name = 'InputsError';
  }
}

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Check one `InputRecord`'s shape, reporting into `problem`. Text and times
 * must be strings, times must parse (and are returned as ISO instants); a
 * blank owner is allowed and read later by `inputRecordProblem`, the way a
 * blank release field is counted rather than refused. Sections call this for
 * each record they hold.
 */
export function parseInputRecord(
  path: string,
  node: unknown,
  problem: (path: string, text: string) => void,
  extra: readonly string[] = [],
): InputRecord | null {
  if (!isNode(node)) {
    problem(path, 'expected a mapping');
    return null;
  }
  for (const key of Object.keys(node)) {
    if (!INPUT_RECORD_KEYS.includes(key) && !extra.includes(key)) problem(`${path}.${key}`, 'unknown field');
  }
  let ok = true;
  const out: { owner: string; recordedAt: string; nextReviewAt?: string } = { owner: '', recordedAt: '' };
  for (const key of INPUT_RECORD_KEYS) {
    const raw = node[key];
    if (raw === undefined || raw === null) {
      if (key === 'recordedAt') {
        problem(`${path}.${key}`, 'required');
        ok = false;
      }
      continue;
    }
    if (typeof raw !== 'string') {
      problem(`${path}.${key}`, `expected text, got ${typeof raw} (quote it)`);
      ok = false;
      continue;
    }
    if (key === 'owner') {
      out.owner = raw.trim();
      continue;
    }
    const ms = instant(raw);
    if (ms === null) {
      problem(`${path}.${key}`, `not a date and time: ${raw}`);
      ok = false;
      continue;
    }
    const iso = new Date(ms).toISOString();
    if (key === 'recordedAt') out.recordedAt = iso;
    else out.nextReviewAt = iso;
  }
  return ok ? out : null;
}

/**
 * Why a record cannot back a pass, or null when it can. `at` is when the
 * audit is judged (the crawl's time), never the wall clock at read time.
 */
export function inputRecordProblem(record: InputRecord, at: Date): string | null {
  if (record.owner.trim() === '') return 'no owner is recorded for this input';
  const due = instant(record.nextReviewAt);
  if (due !== null && due < at.getTime()) return `review of this input was due ${record.nextReviewAt}`;
  return null;
}

const EXPERIMENT_KEYS = ['controlUrl', 'variantUrls', 'method', 'retireBy'];

function parseExperiments(value: unknown, problem: (path: string, text: string) => void): ExperimentRecord[] | null {
  if (!Array.isArray(value)) {
    problem('experiments', 'expected a list');
    return null;
  }
  const out: ExperimentRecord[] = [];
  let ok = true;
  value.forEach((node, index) => {
    const path = `experiments[${index}]`;
    const record = parseInputRecord(path, node, problem, EXPERIMENT_KEYS);
    if (record === null || !isNode(node)) {
      ok = false;
      return;
    }
    const text = (key: string): string | null => {
      const raw = node[key];
      if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
      problem(`${path}.${key}`, raw === undefined || raw === null || raw === '' ? 'required' : `expected text, got ${typeof raw} (quote it)`);
      return null;
    };
    const controlUrl = text('controlUrl');
    const method = text('method');
    const retireRaw = text('retireBy');
    let retireBy: string | null = null;
    if (retireRaw !== null) {
      const ms = instant(retireRaw);
      if (ms === null) problem(`${path}.retireBy`, `not a date and time: ${retireRaw}`);
      else retireBy = new Date(ms).toISOString();
    }
    const urls = node['variantUrls'];
    const variantUrls: string[] = [];
    if (!Array.isArray(urls) || urls.length === 0) {
      problem(`${path}.variantUrls`, 'expected a non-empty list of URLs');
    } else {
      urls.forEach((url, at) => {
        if (typeof url !== 'string' || url.trim() === '') problem(`${path}.variantUrls[${at}]`, 'expected a URL');
        else variantUrls.push(url.trim());
      });
    }
    if (controlUrl === null || method === null || retireBy === null || variantUrls.length !== (Array.isArray(urls) ? urls.length : -1)) {
      ok = false;
      return;
    }
    out.push({ ...record, controlUrl, variantUrls, method, retireBy });
  });
  return ok ? out : null;
}

/**
 * Check a parsed inputs value's shape and return it typed. `undefined` and
 * `null` are no inputs. Throws `InputsError` listing every problem found:
 * an unknown section, a value of the wrong type, a date that does not parse.
 */
export function parseInputs(value: unknown): AuditInputs {
  if (value === undefined || value === null) return {};
  const problems: string[] = [];
  if (!isNode(value)) throw new InputsError(['inputs: expected a mapping']);
  for (const key of Object.keys(value)) {
    if (!INPUT_SECTIONS.includes(key as never)) problems.push(`${key}: unknown section`);
  }
  const problem = (path: string, text: string): void => {
    problems.push(`${path}: ${text}`);
  };
  const inputs: { experiments?: readonly ExperimentRecord[] } = {};
  if (value['experiments'] !== undefined && value['experiments'] !== null) {
    const experiments = parseExperiments(value['experiments'], problem);
    if (experiments !== null) inputs.experiments = experiments;
  }
  if (problems.length > 0) throw new InputsError(problems);
  return inputs;
}
