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

/**
 * The non-production environments of the site (1.8): origins a person names,
 * because no crawl of production can discover where staging lives. The record
 * fields say who vouches for the list and when it was last true.
 */
export interface EnvironmentsRecord extends InputRecord {
  readonly staging?: string;
  readonly preview?: string;
}

/**
 * The CI guard that stops an SEO regression shipping (1.10). `seededDefectsCaught`
 * names the defect kinds the guard was shown to catch when they were planted in
 * a build; `cleanRunPassed` is whether an unmodified build passed it.
 */
export interface CiGuardRecord extends InputRecord {
  /** Which build or pipeline run the guard was exercised on. */
  readonly build: string;
  /** ISO 8601 instant the guard was exercised. */
  readonly ranAt: string;
  readonly seededDefectsCaught: readonly string[];
  readonly cleanRunPassed: boolean;
}

/** The defect kinds a CI guard has to be shown to catch (1.10). */
export const CI_GUARD_DEFECTS = ['noindex', 'canonical', 'crawler-access', 'critical-link'] as const;

/**
 * One rule in the site's extended CI checks (1.11). `severity` is free text
 * (`block`, `warn`…), blank when nobody chose one; `falsePositiveRate` is a
 * fraction from 0 to 1 of the runs in which the rule flagged something that
 * was not a defect.
 */
export interface CiRuleRecord extends InputRecord {
  readonly rule: string;
  readonly severity: string;
  readonly falsePositiveRate: number;
}

/** Above this false-positive rate a rule teaches people to ignore it (1.11). */
export const CI_RULE_MAX_FALSE_POSITIVE_RATE = 0.1;

/**
 * One row of the URL matrix (0.3): what a person decided a URL pattern must
 * do at launch. `pattern` is an exact URL or a glob (`*` within a path
 * segment, `**` across segments), absolute or a path from the site root.
 * `canonical` is `self`, `none` or the URL the pattern canonicalizes to.
 * `priority` marks a launch template (absent means not a priority);
 * `environment` names where the row applies (absent means everywhere).
 */
export interface UrlMatrixEntry extends InputRecord {
  readonly pattern: string;
  readonly priority?: boolean;
  /** The HTTP status the pattern must answer with. */
  readonly status: number;
  readonly indexable: boolean;
  readonly canonical: string;
  readonly inSitemap: boolean;
  readonly access: 'public' | 'private';
  readonly environment?: string;
}

/** The values `UrlMatrixEntry.access` takes. */
export const URL_MATRIX_ACCESS = ['public', 'private'] as const;

/**
 * The availability canary and its alert (5.5). `urls` are the pages watched;
 * `targetMinutes` is how quickly an alert must reach `recipient`.
 * `lastTestAlertAt` is when a test alert was raised, `deliveredAt` when the
 * recipient got it; either is absent when it has not happened.
 */
export interface CanaryRecord extends InputRecord {
  readonly urls: readonly string[];
  readonly targetMinutes: number;
  readonly recipient: string;
  /** ISO 8601 instant. */
  readonly lastTestAlertAt?: string;
  /** ISO 8601 instant. */
  readonly deliveredAt?: string;
}

/** Every section an audit can be given. */
export interface AuditInputs {
  /** The availability canary and its alert delivery (5.5). */
  readonly canary?: CanaryRecord;
  /** The URL matrix: expected status, indexability, canonical and sitemap membership per pattern (0.3). */
  readonly urlMatrix?: readonly UrlMatrixEntry[];
  /** The extended CI rules and who answers for each (1.11). */
  readonly ciRules?: readonly CiRuleRecord[];
  /** The CI guard against SEO regressions (1.10). */
  readonly ciGuard?: CiGuardRecord;
  /** Experiments the site runs on separate URLs (1.19). */
  readonly experiments?: readonly ExperimentRecord[];
  /** Staging and preview origins the site keeps (1.8). */
  readonly environments?: EnvironmentsRecord;
}

/** Section names `parseInputs` accepts. */
export const INPUT_SECTIONS: readonly (keyof AuditInputs & string)[] = ['experiments', 'environments', 'ciGuard', 'ciRules', 'urlMatrix', 'canary'];

/** The environment names an `EnvironmentsRecord` can hold an origin for. */
export const ENVIRONMENT_NAMES = ['staging', 'preview'] as const;

/** The origins an `environments` section names, in `ENVIRONMENT_NAMES` order. */
export function environmentOrigins(record: EnvironmentsRecord | undefined): { name: string; origin: string }[] {
  if (record === undefined) return [];
  const out: { name: string; origin: string }[] = [];
  for (const name of ENVIRONMENT_NAMES) {
    const origin = record[name];
    if (origin !== undefined) out.push({ name, origin });
  }
  return out;
}

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

function parseEnvironments(value: unknown, problem: (path: string, text: string) => void): EnvironmentsRecord | null {
  const record = parseInputRecord('environments', value, problem, ENVIRONMENT_NAMES);
  if (record === null || !isNode(value)) return null;
  const out: { -readonly [K in keyof EnvironmentsRecord]: EnvironmentsRecord[K] } = { ...record };
  let ok = true;
  for (const name of ENVIRONMENT_NAMES) {
    const raw = value[name];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') {
      problem(`environments.${name}`, `expected text, got ${typeof raw} (quote it)`);
      ok = false;
      continue;
    }
    let origin: string | null = null;
    try {
      const url = new URL(raw.trim());
      if (url.protocol === 'http:' || url.protocol === 'https:') origin = url.origin;
    } catch {
      // reported below
    }
    if (origin === null) {
      problem(`environments.${name}`, `not an http(s) origin: ${raw}`);
      ok = false;
      continue;
    }
    out[name] = origin;
  }
  if (ok && out.staging === undefined && out.preview === undefined) {
    problem('environments', 'expected at least one of staging, preview');
    ok = false;
  }
  return ok ? out : null;
}

const CI_GUARD_KEYS = ['build', 'ranAt', 'seededDefectsCaught', 'cleanRunPassed'];

function parseCiGuard(value: unknown, problem: (path: string, text: string) => void): CiGuardRecord | null {
  const record = parseInputRecord('ciGuard', value, problem, CI_GUARD_KEYS);
  if (record === null || !isNode(value)) return null;
  let ok = true;
  const text = (key: 'build' | 'ranAt'): string | null => {
    const raw = value[key];
    if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
    problem(`ciGuard.${key}`, raw === undefined || raw === null || raw === '' ? 'required' : `expected text, got ${typeof raw} (quote it)`);
    return null;
  };
  const build = text('build');
  const ranRaw = text('ranAt');
  let ranAt: string | null = null;
  if (ranRaw !== null) {
    const ms = instant(ranRaw);
    if (ms === null) problem('ciGuard.ranAt', `not a date and time: ${ranRaw}`);
    else ranAt = new Date(ms).toISOString();
  }
  const caughtRaw = value['seededDefectsCaught'];
  const caught: string[] = [];
  if (!Array.isArray(caughtRaw)) {
    problem('ciGuard.seededDefectsCaught', 'expected a list of defect kinds');
    ok = false;
  } else {
    caughtRaw.forEach((item, index) => {
      if (typeof item !== 'string' || item.trim() === '') {
        problem(`ciGuard.seededDefectsCaught[${index}]`, 'expected text');
        ok = false;
      } else {
        caught.push(item.trim().toLowerCase());
      }
    });
  }
  const clean = value['cleanRunPassed'];
  if (typeof clean !== 'boolean') {
    problem('ciGuard.cleanRunPassed', clean === undefined || clean === null ? 'required' : 'expected true or false');
    ok = false;
  }
  if (!ok || build === null || ranAt === null || typeof clean !== 'boolean') return null;
  return { ...record, build, ranAt, seededDefectsCaught: caught, cleanRunPassed: clean };
}

const CI_RULE_KEYS = ['rule', 'severity', 'falsePositiveRate'];

function parseCiRules(value: unknown, problem: (path: string, text: string) => void): CiRuleRecord[] | null {
  if (!Array.isArray(value)) {
    problem('ciRules', 'expected a list');
    return null;
  }
  const out: CiRuleRecord[] = [];
  let ok = true;
  value.forEach((node, index) => {
    const path = `ciRules[${index}]`;
    const record = parseInputRecord(path, node, problem, CI_RULE_KEYS);
    if (record === null || !isNode(node)) {
      ok = false;
      return;
    }
    const rule = node['rule'];
    if (typeof rule !== 'string' || rule.trim() === '') {
      problem(`${path}.rule`, rule === undefined || rule === null || rule === '' ? 'required' : `expected text, got ${typeof rule} (quote it)`);
      ok = false;
    }
    const severityRaw = node['severity'];
    if (severityRaw !== undefined && severityRaw !== null && typeof severityRaw !== 'string') {
      problem(`${path}.severity`, `expected text, got ${typeof severityRaw} (quote it)`);
      ok = false;
    }
    const rate = node['falsePositiveRate'];
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1) {
      problem(`${path}.falsePositiveRate`, rate === undefined || rate === null ? 'required' : 'expected a fraction from 0 to 1');
      ok = false;
    }
    if (typeof rule !== 'string' || typeof rate !== 'number' || rule.trim() === '') return;
    out.push({
      ...record,
      rule: rule.trim(),
      severity: typeof severityRaw === 'string' ? severityRaw.trim() : '',
      falsePositiveRate: rate,
    });
  });
  return ok ? out : null;
}

const URL_MATRIX_KEYS = ['pattern', 'priority', 'status', 'indexable', 'canonical', 'inSitemap', 'access', 'environment'];

const isHttpUrl = (raw: string): boolean => {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

function parseUrlMatrix(value: unknown, problem: (path: string, text: string) => void): UrlMatrixEntry[] | null {
  if (!Array.isArray(value)) {
    problem('urlMatrix', 'expected a list');
    return null;
  }
  const out: UrlMatrixEntry[] = [];
  let ok = true;
  const seen = new Set<string>();
  value.forEach((node, index) => {
    const path = `urlMatrix[${index}]`;
    const record = parseInputRecord(path, node, problem, URL_MATRIX_KEYS);
    if (record === null || !isNode(node)) {
      ok = false;
      return;
    }
    const fail = (key: string, text: string): void => {
      problem(`${path}.${key}`, text);
      ok = false;
    };
    const missing = (raw: unknown): boolean => raw === undefined || raw === null || raw === '';
    const text = (key: string): string | null => {
      const raw = node[key];
      if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
      fail(key, missing(raw) ? 'required' : `expected text, got ${typeof raw} (quote it)`);
      return null;
    };
    const flag = (key: 'indexable' | 'inSitemap'): boolean | null => {
      const raw = node[key];
      if (typeof raw === 'boolean') return raw;
      fail(key, missing(raw) ? 'required' : 'expected true or false');
      return null;
    };

    const pattern = text('pattern');
    if (pattern !== null && !(pattern.startsWith('/') || isHttpUrl(pattern))) {
      fail('pattern', `expected an http(s) URL or a path starting with /: ${pattern}`);
    }
    const status = node['status'];
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
      fail('status', missing(status) ? 'required' : 'expected an HTTP status code from 100 to 599');
    }
    const indexable = flag('indexable');
    const inSitemap = flag('inSitemap');
    const canonical = text('canonical');
    if (canonical !== null && canonical !== 'self' && canonical !== 'none' && !isHttpUrl(canonical)) {
      fail('canonical', `expected self, none or an http(s) URL: ${canonical}`);
    }
    const access = text('access');
    if (access !== null && !(URL_MATRIX_ACCESS as readonly string[]).includes(access)) {
      fail('access', `expected public or private: ${access}`);
    }
    const priority = node['priority'];
    if (!missing(priority) && typeof priority !== 'boolean') fail('priority', 'expected true or false');
    const environment = node['environment'];
    if (!missing(environment) && (typeof environment !== 'string' || environment.trim() === '')) {
      fail('environment', `expected text, got ${typeof environment} (quote it)`);
    }
    if (pattern !== null) {
      const key = `${pattern}\n${typeof environment === 'string' ? environment.trim() : ''}`;
      if (seen.has(key)) fail('pattern', `duplicate pattern: ${pattern}`);
      seen.add(key);
    }
    if (!ok || pattern === null || indexable === null || inSitemap === null || canonical === null || access === null) return;
    out.push({
      ...record,
      pattern,
      ...(typeof priority === 'boolean' ? { priority } : {}),
      status: status as number,
      indexable,
      canonical,
      inSitemap,
      access: access as 'public' | 'private',
      ...(typeof environment === 'string' ? { environment: environment.trim() } : {}),
    });
  });
  return ok ? out : null;
}

const CANARY_KEYS = ['urls', 'targetMinutes', 'recipient', 'lastTestAlertAt', 'deliveredAt'];

function parseCanary(value: unknown, problem: (path: string, text: string) => void): CanaryRecord | null {
  const record = parseInputRecord('canary', value, problem, CANARY_KEYS);
  if (record === null || !isNode(value)) return null;
  let ok = true;
  const fail = (key: string, text: string): void => {
    problem(`canary.${key}`, text);
    ok = false;
  };
  const missing = (raw: unknown): boolean => raw === undefined || raw === null || raw === '';

  const urlsRaw = value['urls'];
  const urls: string[] = [];
  if (!Array.isArray(urlsRaw) || urlsRaw.length === 0) {
    fail('urls', 'expected a non-empty list of URLs');
  } else {
    urlsRaw.forEach((url, index) => {
      if (typeof url !== 'string' || !isHttpUrl(url.trim())) fail(`urls[${index}]`, 'expected an http(s) URL');
      else urls.push(url.trim());
    });
  }
  const target = value['targetMinutes'];
  if (typeof target !== 'number' || !Number.isFinite(target) || target <= 0) {
    fail('targetMinutes', missing(target) ? 'required' : 'expected a positive number of minutes');
  }
  const recipientRaw = value['recipient'];
  if (!missing(recipientRaw) && typeof recipientRaw !== 'string') {
    fail('recipient', `expected text, got ${typeof recipientRaw} (quote it)`);
  }
  const times: { lastTestAlertAt?: string; deliveredAt?: string } = {};
  for (const key of ['lastTestAlertAt', 'deliveredAt'] as const) {
    const raw = value[key];
    if (missing(raw)) continue;
    const ms = typeof raw === 'string' ? instant(raw) : null;
    if (ms === null) fail(key, typeof raw === 'string' ? `not a date and time: ${raw}` : `expected text, got ${typeof raw} (quote it)`);
    else times[key] = new Date(ms).toISOString();
  }
  if (!ok || typeof target !== 'number') return null;
  return {
    ...record,
    urls,
    targetMinutes: target,
    recipient: typeof recipientRaw === 'string' ? recipientRaw.trim() : '',
    ...times,
  };
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
  const inputs: {
    experiments?: readonly ExperimentRecord[];
    environments?: EnvironmentsRecord;
    ciGuard?: CiGuardRecord;
    ciRules?: readonly CiRuleRecord[];
    urlMatrix?: readonly UrlMatrixEntry[];
    canary?: CanaryRecord;
  } = {};
  if (value['canary'] !== undefined && value['canary'] !== null) {
    const canary = parseCanary(value['canary'], problem);
    if (canary !== null) inputs.canary = canary;
  }
  if (value['urlMatrix'] !== undefined && value['urlMatrix'] !== null) {
    const urlMatrix = parseUrlMatrix(value['urlMatrix'], problem);
    if (urlMatrix !== null) inputs.urlMatrix = urlMatrix;
  }
  if (value['ciRules'] !== undefined && value['ciRules'] !== null) {
    const ciRules = parseCiRules(value['ciRules'], problem);
    if (ciRules !== null) inputs.ciRules = ciRules;
  }
  if (value['ciGuard'] !== undefined && value['ciGuard'] !== null) {
    const ciGuard = parseCiGuard(value['ciGuard'], problem);
    if (ciGuard !== null) inputs.ciGuard = ciGuard;
  }
  if (value['experiments'] !== undefined && value['experiments'] !== null) {
    const experiments = parseExperiments(value['experiments'], problem);
    if (experiments !== null) inputs.experiments = experiments;
  }
  if (value['environments'] !== undefined && value['environments'] !== null) {
    const environments = parseEnvironments(value['environments'], problem);
    if (environments !== null) inputs.environments = environments;
  }
  if (problems.length > 0) throw new InputsError(problems);
  return inputs;
}
