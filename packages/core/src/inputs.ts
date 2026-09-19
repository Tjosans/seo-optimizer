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

/**
 * One old URL and what the migration promises for it (0.8). `from` is an
 * absolute URL or a path from the old origin's root. A 301 or 308 names its
 * destination in `to`; a 404 or 410 (a page retired on purpose) has none.
 */
export interface RedirectMapEntry {
  readonly from: string;
  readonly expect: 301 | 308 | 404 | 410;
  readonly to?: string;
}

/** The statuses a `RedirectMapEntry` can expect. */
export const REDIRECT_MAP_EXPECT = [301, 308, 404, 410] as const;

/** The kinds of migration a `redirectMap` can describe. */
export const REDIRECT_MAP_KINDS = ['move', 'history-only'] as const;

/** The statuses a `ChangeOfAddress` can be in. */
export const CHANGE_OF_ADDRESS_STATUSES = ['pending', 'accepted'] as const;

/** Where the Search Console change of address stands, and when it was submitted. */
export interface ChangeOfAddress {
  readonly status: (typeof CHANGE_OF_ADDRESS_STATUSES)[number];
  /** ISO 8601 instant. */
  readonly submittedAt: string;
}

/**
 * The redirect map of a migration (0.8). `move` is a site changing address or
 * structure: `oldOrigin` names where the old URLs lived and every one needs an
 * entry. `history-only` is a site with history worth keeping but no URLs to
 * carry over, so `entries` may be empty.
 */
export interface RedirectMapRecord extends InputRecord {
  readonly kind: (typeof REDIRECT_MAP_KINDS)[number];
  readonly oldOrigin?: string;
  /** The Search Console change of address for `oldOrigin` (5.2), when the move is to a new domain. */
  readonly changeOfAddress?: ChangeOfAddress;
  readonly entries: readonly RedirectMapEntry[];
}

/**
 * The absolute old URLs a redirect map names, in entry order and without
 * repeats. A path is resolved against `oldOrigin`; one that cannot be (no
 * `oldOrigin`, or not a URL at all) is left out rather than guessed at.
 */
export function redirectMapUrls(record: RedirectMapRecord | undefined): string[] {
  if (record === undefined) return [];
  const urls = new Set<string>();
  for (const entry of record.entries) {
    try {
      const url = new URL(entry.from, record.oldOrigin);
      if (url.protocol === 'http:' || url.protocol === 'https:') urls.add(url.toString());
    } catch {
      // Not resolvable to an address; nothing to request.
    }
  }
  return [...urls];
}

/**
 * The old origin's root document, which 5.2 requires to keep redirecting. Absent
 * when the map names no `oldOrigin`.
 */
export function redirectMapRootUrl(record: RedirectMapRecord | undefined): string | undefined {
  if (record?.oldOrigin === undefined) return undefined;
  try {
    return new URL('/', record.oldOrigin).toString();
  } catch {
    return undefined;
  }
}

/** One look at the history of a domain the site inherited (0.8): what was checked, what it found, when. */
export interface DomainHistoryCheck {
  /** What was looked at: a manual-actions review, an archive review, a backlink audit… */
  readonly name: string;
  /** What the check found, in the reviewer's words. */
  readonly result: string;
  /** ISO 8601 instant. */
  readonly checkedAt: string;
}

/** A problem the history turned up that blocks launch until it is resolved. */
export interface DomainHistoryIssue {
  readonly issue: string;
  readonly resolved: boolean;
}

/**
 * What a person learned about the past of a domain the site inherited (0.8):
 * the checks they ran and the blocking issues those found. Nothing observable
 * from a crawl can say what a domain was used for before.
 */
export interface DomainHistoryRecord extends InputRecord {
  readonly checks: readonly DomainHistoryCheck[];
  readonly blockingIssues: readonly DomainHistoryIssue[];
}

/** The checks a domain history must hold, each with the words a check's name has to contain. */
export const DOMAIN_HISTORY_REQUIRED_CHECKS = [
  { label: 'manual-action', words: ['manual'] },
  { label: 'archive', words: ['archive', 'wayback'] },
] as const;

/** How a Search Console property is verified: the whole domain, or one URL prefix. */
export const SEARCH_CONSOLE_PROPERTY_TYPES = ['domain', 'url-prefix'] as const;

/** A verified owner of a Search Console property, as its Users and permissions page lists them. */
export interface SearchConsoleOwner {
  readonly email: string;
  /** ISO 8601 instant. */
  readonly verifiedAt: string;
}

/** The Search Console property the site is managed under. */
export interface SearchConsoleProperty {
  readonly type: (typeof SEARCH_CONSOLE_PROPERTY_TYPES)[number];
  /** A URL prefix property's address, or a domain property's `sc-domain:` name or bare host. */
  readonly url: string;
  readonly owners: readonly SearchConsoleOwner[];
}

/** One row of the Sitemaps report: what was submitted, when, what Search Console made of it. */
export interface SearchConsoleSitemap {
  readonly url: string;
  /** ISO 8601 instant. */
  readonly submittedAt: string;
  /** The report's own words: `Success`, `Has errors`, `Couldn't fetch`… */
  readonly status: string;
  /** Errors the report counts against the file. */
  readonly errors: number;
}

/** The scope of a manual action: the whole site or only part of it. */
export const SEARCH_CONSOLE_ACTION_SCOPES = ['site-wide', 'partial'] as const;

/** One row of the Manual actions report. An empty list is a report that says "no issues detected". */
export interface SearchConsoleManualAction {
  /** The report's issue type: `Unnatural links to your site`, `Pure spam`… */
  readonly type: string;
  readonly scope: (typeof SEARCH_CONSOLE_ACTION_SCOPES)[number];
  /** ISO 8601 instant, when Search Console shows one. */
  readonly detectedAt?: string;
}

/** One row of the Security issues report. An empty list is a report that says "no issues detected". */
export interface SearchConsoleSecurityIssue {
  /** The report's issue type: `Hacked content`, `Malware`, `Deceptive pages`… */
  readonly type: string;
  /** ISO 8601 instant, when Search Console shows one. */
  readonly detectedAt?: string;
}

/** One row of the Page indexing report: a URL Search Console did not index, and the reason it gives. */
export interface SearchConsolePageIndexing {
  readonly url: string;
  /** The report's own words: `Crawled - currently not indexed`, `Duplicate without user-selected canonical`… */
  readonly reason: string;
}

/** One URL Inspection result, in the inspection tool's own words. */
export interface SearchConsoleUrlInspection {
  readonly url: string;
  /** `Pass`, `Neutral`, `Fail`… */
  readonly verdict: string;
  /** The coverage state: `Submitted and indexed`, `Discovered - currently not indexed`… */
  readonly coverage: string;
  /** The canonical Google selected; absent when the tool shows none. */
  readonly googleCanonical?: string;
  /** Whether robots.txt allowed the crawl: `Allowed`, `Blocked`… */
  readonly robots: string;
  /** Whether indexing was allowed: `Indexing allowed`, `Blocked by 'noindex' tag`… */
  readonly indexing: string;
}

/** One row of the Performance report: clicks and impressions for a page, and for a query when the export is split by one. */
export interface SearchConsolePerformance {
  readonly page: string;
  readonly query?: string;
  readonly clicks: number;
  readonly impressions: number;
  /** The date range the numbers cover, as exported: `2026-06-01/2026-08-31`, `Last 3 months`… */
  readonly period: string;
}

/** One row of the Links report: a site linking to the property, and how many links it has. */
export interface SearchConsoleLink {
  readonly site: string;
  readonly count: number;
}

/**
 * What a person exports from Search Console. An absent subsection was not
 * supplied; an empty list is the report saying there is nothing, which is an
 * answer, not a gap.
 */
export interface SearchConsoleRecord extends InputRecord {
  readonly property?: SearchConsoleProperty;
  readonly sitemaps?: readonly SearchConsoleSitemap[];
  readonly manualActions?: readonly SearchConsoleManualAction[];
  readonly securityIssues?: readonly SearchConsoleSecurityIssue[];
  readonly pageIndexing?: readonly SearchConsolePageIndexing[];
  readonly urlInspection?: readonly SearchConsoleUrlInspection[];
  readonly performance?: readonly SearchConsolePerformance[];
  readonly links?: readonly SearchConsoleLink[];
}

/**
 * What a person decided for a URL whose search traffic is declining (7.2):
 * `refresh`, `merge`, `redirect`, `retire`, `keep`… in their words. `url` is an
 * http(s) address, `decidedAt` an ISO 8601 instant.
 */
export interface ContentDecision extends InputRecord {
  readonly url: string;
  readonly decision: string;
  readonly decidedAt: string;
}

/** Every section an audit can be given. */
export interface AuditInputs {
  /** Search Console exports: property, sitemaps, manual actions, security issues. */
  readonly searchConsole?: SearchConsoleRecord;
  /** The history of an inherited domain (0.8). */
  readonly domainHistory?: DomainHistoryRecord;
  /** The migration's redirect map (0.8). */
  readonly redirectMap?: RedirectMapRecord;
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
  /** What was decided for each declining URL (7.2). */
  readonly contentDecisions?: readonly ContentDecision[];
}

/** Section names `parseInputs` accepts. */
export const INPUT_SECTIONS: readonly (keyof AuditInputs & string)[] = ['experiments', 'environments', 'ciGuard', 'ciRules', 'urlMatrix', 'canary', 'redirectMap', 'domainHistory', 'searchConsole', 'contentDecisions'];

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

const REDIRECT_MAP_KEYS = ['kind', 'oldOrigin', 'entries', 'changeOfAddress'];
const REDIRECT_ENTRY_KEYS = ['from', 'expect', 'to'];

function parseRedirectMap(value: unknown, problem: (path: string, text: string) => void): RedirectMapRecord | null {
  const record = parseInputRecord('redirectMap', value, problem, REDIRECT_MAP_KEYS);
  if (record === null || !isNode(value)) return null;
  let ok = true;
  const fail = (path: string, text: string): void => {
    problem(`redirectMap${path}`, text);
    ok = false;
  };
  const missing = (raw: unknown): boolean => raw === undefined || raw === null || raw === '';

  const kind = value['kind'];
  if (typeof kind !== 'string' || !(REDIRECT_MAP_KINDS as readonly string[]).includes(kind)) {
    fail('.kind', missing(kind) ? 'required' : `expected move or history-only: ${String(kind)}`);
  }
  const oldRaw = value['oldOrigin'];
  let oldOrigin: string | undefined;
  if (!missing(oldRaw)) {
    let origin: string | null = null;
    if (typeof oldRaw === 'string') {
      try {
        const url = new URL(oldRaw.trim());
        if (url.protocol === 'http:' || url.protocol === 'https:') origin = url.origin;
      } catch {
        // reported below
      }
    }
    if (origin === null) fail('.oldOrigin', typeof oldRaw === 'string' ? `not an http(s) origin: ${oldRaw}` : `expected text, got ${typeof oldRaw} (quote it)`);
    else oldOrigin = origin;
  }

  const entriesRaw = value['entries'];
  const entries: RedirectMapEntry[] = [];
  if (!missing(entriesRaw) && !Array.isArray(entriesRaw)) {
    fail('.entries', 'expected a list');
  } else if (Array.isArray(entriesRaw)) {
    const seen = new Set<string>();
    entriesRaw.forEach((node, index) => {
      const path = `.entries[${index}]`;
      if (!isNode(node)) {
        fail(path, 'expected a mapping');
        return;
      }
      for (const key of Object.keys(node)) {
        if (!REDIRECT_ENTRY_KEYS.includes(key)) fail(`${path}.${key}`, 'unknown field');
      }
      const from = node['from'];
      let fromText: string | null = null;
      if (typeof from === 'string' && from.trim() !== '') {
        fromText = from.trim();
        if (!(fromText.startsWith('/') || isHttpUrl(fromText))) {
          fail(`${path}.from`, `expected an http(s) URL or a path starting with /: ${fromText}`);
          fromText = null;
        } else if (seen.has(fromText)) {
          fail(`${path}.from`, `duplicate entry: ${fromText}`);
        } else {
          seen.add(fromText);
        }
      } else {
        fail(`${path}.from`, missing(from) ? 'required' : `expected text, got ${typeof from} (quote it)`);
      }
      const expect = node['expect'];
      const expectOk = (REDIRECT_MAP_EXPECT as readonly unknown[]).includes(expect);
      if (!expectOk) fail(`${path}.expect`, missing(expect) ? 'required' : 'expected 301, 308, 404 or 410');
      const to = node['to'];
      let toText: string | undefined;
      if (!missing(to)) {
        if (typeof to !== 'string') fail(`${path}.to`, `expected text, got ${typeof to} (quote it)`);
        else if (!(to.trim().startsWith('/') || isHttpUrl(to.trim()))) fail(`${path}.to`, `expected an http(s) URL or a path starting with /: ${to}`);
        else toText = to.trim();
      }
      if (expectOk && (expect === 301 || expect === 308) && missing(to)) fail(`${path}.to`, `required when expect is ${String(expect)}`);
      if (expectOk && (expect === 404 || expect === 410) && !missing(to)) fail(`${path}.to`, `not allowed when expect is ${String(expect)}`);
      if (fromText !== null && expectOk) {
        entries.push({ from: fromText, expect: expect as RedirectMapEntry['expect'], ...(toText !== undefined ? { to: toText } : {}) });
      }
    });
  }
  const changeRaw = value['changeOfAddress'];
  let changeOfAddress: ChangeOfAddress | undefined;
  if (!missing(changeRaw)) {
    if (!isNode(changeRaw)) {
      fail('.changeOfAddress', 'expected a mapping');
    } else {
      for (const key of Object.keys(changeRaw)) {
        if (key !== 'status' && key !== 'submittedAt') fail(`.changeOfAddress.${key}`, 'unknown field');
      }
      const status = changeRaw['status'];
      const statusOk = typeof status === 'string' && (CHANGE_OF_ADDRESS_STATUSES as readonly string[]).includes(status);
      if (!statusOk) fail('.changeOfAddress.status', missing(status) ? 'required' : `expected pending or accepted: ${String(status)}`);
      const at = changeRaw['submittedAt'];
      const ms = typeof at === 'string' ? instant(at) : null;
      if (ms === null) fail('.changeOfAddress.submittedAt', missing(at) ? 'required' : typeof at === 'string' ? `not a date and time: ${at}` : `expected text, got ${typeof at} (quote it)`);
      else if (statusOk) changeOfAddress = { status: status as ChangeOfAddress['status'], submittedAt: new Date(ms).toISOString() };
    }
  }
  if (!ok || typeof kind !== 'string') return null;
  return {
    ...record,
    kind: kind as RedirectMapRecord['kind'],
    ...(oldOrigin !== undefined ? { oldOrigin } : {}),
    ...(changeOfAddress !== undefined ? { changeOfAddress } : {}),
    entries,
  };
}

const DOMAIN_HISTORY_KEYS = ['checks', 'blockingIssues'];

function parseDomainHistory(value: unknown, problem: (path: string, text: string) => void): DomainHistoryRecord | null {
  const record = parseInputRecord('domainHistory', value, problem, DOMAIN_HISTORY_KEYS);
  if (record === null || !isNode(value)) return null;
  let ok = true;
  const fail = (path: string, text: string): void => {
    problem(`domainHistory${path}`, text);
    ok = false;
  };
  const missing = (raw: unknown): boolean => raw === undefined || raw === null || raw === '';
  const text = (node: Node, path: string, key: string): string | null => {
    const raw = node[key];
    if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
    fail(`${path}.${key}`, missing(raw) ? 'required' : `expected text, got ${typeof raw} (quote it)`);
    return null;
  };

  const checks: DomainHistoryCheck[] = [];
  const checksRaw = value['checks'];
  if (!missing(checksRaw) && !Array.isArray(checksRaw)) {
    fail('.checks', 'expected a list');
  } else if (Array.isArray(checksRaw)) {
    checksRaw.forEach((node, index) => {
      const path = `.checks[${index}]`;
      if (!isNode(node)) {
        fail(path, 'expected a mapping');
        return;
      }
      for (const key of Object.keys(node)) {
        if (!['name', 'result', 'checkedAt'].includes(key)) fail(`${path}.${key}`, 'unknown field');
      }
      const name = text(node, path, 'name');
      const result = text(node, path, 'result');
      const at = text(node, path, 'checkedAt');
      const ms = at === null ? null : instant(at);
      if (at !== null && ms === null) fail(`${path}.checkedAt`, `not a date and time: ${at}`);
      if (name !== null && result !== null && ms !== null) checks.push({ name, result, checkedAt: new Date(ms).toISOString() });
    });
  }

  const blockingIssues: DomainHistoryIssue[] = [];
  const issuesRaw = value['blockingIssues'];
  if (!missing(issuesRaw) && !Array.isArray(issuesRaw)) {
    fail('.blockingIssues', 'expected a list');
  } else if (Array.isArray(issuesRaw)) {
    issuesRaw.forEach((node, index) => {
      const path = `.blockingIssues[${index}]`;
      if (!isNode(node)) {
        fail(path, 'expected a mapping');
        return;
      }
      for (const key of Object.keys(node)) {
        if (key !== 'issue' && key !== 'resolved') fail(`${path}.${key}`, 'unknown field');
      }
      const issue = text(node, path, 'issue');
      const resolved = node['resolved'];
      if (typeof resolved !== 'boolean') fail(`${path}.resolved`, missing(resolved) ? 'required' : 'expected true or false');
      if (issue !== null && typeof resolved === 'boolean') blockingIssues.push({ issue, resolved });
    });
  }
  return ok ? { ...record, checks, blockingIssues } : null;
}

const CONTENT_DECISION_KEYS = ['url', 'decision', 'decidedAt'];

function parseContentDecisions(value: unknown, problem: (path: string, text: string) => void): ContentDecision[] | null {
  if (!Array.isArray(value)) {
    problem('contentDecisions', 'expected a list');
    return null;
  }
  const out: ContentDecision[] = [];
  let ok = true;
  const seen = new Set<string>();
  value.forEach((node, index) => {
    const path = `contentDecisions[${index}]`;
    const record = parseInputRecord(path, node, problem, CONTENT_DECISION_KEYS);
    if (record === null || !isNode(node)) {
      ok = false;
      return;
    }
    const text = (key: string): string | null => {
      const raw = node[key];
      if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
      problem(`${path}.${key}`, raw === undefined || raw === null || raw === '' ? 'required' : `expected text, got ${typeof raw} (quote it)`);
      ok = false;
      return null;
    };
    const url = text('url');
    if (url !== null && !isHttpUrl(url)) {
      problem(`${path}.url`, `expected an http(s) URL: ${url}`);
      ok = false;
    } else if (url !== null) {
      if (seen.has(url)) {
        problem(`${path}.url`, `duplicate decision: ${url}`);
        ok = false;
      }
      seen.add(url);
    }
    const decision = text('decision');
    const decidedRaw = text('decidedAt');
    const ms = decidedRaw === null ? null : instant(decidedRaw);
    if (decidedRaw !== null && ms === null) {
      problem(`${path}.decidedAt`, `not a date and time: ${decidedRaw}`);
      ok = false;
    }
    if (url !== null && decision !== null && ms !== null) out.push({ ...record, url, decision, decidedAt: new Date(ms).toISOString() });
  });
  return ok ? out : null;
}

const SEARCH_CONSOLE_KEYS = ['property', 'sitemaps', 'manualActions', 'securityIssues', 'pageIndexing', 'urlInspection', 'performance', 'links'];

function parseSearchConsole(value: unknown, problem: (path: string, text: string) => void): SearchConsoleRecord | null {
  const record = parseInputRecord('searchConsole', value, problem, SEARCH_CONSOLE_KEYS);
  if (record === null || !isNode(value)) return null;
  let ok = true;
  const fail = (path: string, text: string): void => {
    problem(`searchConsole${path}`, text);
    ok = false;
  };
  const missing = (raw: unknown): boolean => raw === undefined || raw === null || raw === '';
  const text = (node: Node, path: string, key: string): string | null => {
    const raw = node[key];
    if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
    fail(`${path}.${key}`, missing(raw) ? 'required' : `expected text, got ${typeof raw} (quote it)`);
    return null;
  };
  const time = (node: Node, path: string, key: string, required: boolean): string | null => {
    if (!required && missing(node[key])) return null;
    const raw = text(node, path, key);
    if (raw === null) return null;
    const ms = instant(raw);
    if (ms === null) {
      fail(`${path}.${key}`, `not a date and time: ${raw}`);
      return null;
    }
    return new Date(ms).toISOString();
  };
  const oneOf = <T extends string>(node: Node, path: string, key: string, allowed: readonly T[]): T | null => {
    const raw = node[key];
    if (typeof raw === 'string' && (allowed as readonly string[]).includes(raw)) return raw as T;
    fail(`${path}.${key}`, missing(raw) ? 'required' : `expected ${allowed.join(' or ')}: ${String(raw)}`);
    return null;
  };
  const unknownKeys = (node: Node, path: string, known: readonly string[]): void => {
    for (const key of Object.keys(node)) if (!known.includes(key)) fail(`${path}.${key}`, 'unknown field');
  };
  /** Visit each row of a list subsection; false when the subsection was not supplied or is not a list. */
  const rows = (key: string, each: (node: Node, path: string) => void): boolean => {
    const raw = value[key];
    if (missing(raw)) return false;
    if (!Array.isArray(raw)) {
      fail(`.${key}`, 'expected a list');
      return false;
    }
    raw.forEach((node, index) => {
      const path = `.${key}[${index}]`;
      if (!isNode(node)) {
        fail(path, 'expected a mapping');
        return;
      }
      each(node, path);
    });
    return true;
  };
  const out: {
    property?: SearchConsoleProperty;
    sitemaps?: SearchConsoleSitemap[];
    manualActions?: SearchConsoleManualAction[];
    securityIssues?: SearchConsoleSecurityIssue[];
    pageIndexing?: SearchConsolePageIndexing[];
    urlInspection?: SearchConsoleUrlInspection[];
    performance?: SearchConsolePerformance[];
    links?: SearchConsoleLink[];
  } = {};
  const count = (node: Node, path: string, key: string): number | null => {
    const raw = node[key];
    if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return raw;
    fail(`${path}.${key}`, missing(raw) ? 'required' : 'expected a whole number of 0 or more');
    return null;
  };
  const httpUrl = (node: Node, path: string, key: string): string | null => {
    const raw = text(node, path, key);
    if (raw !== null && !isHttpUrl(raw)) {
      fail(`${path}.${key}`, `expected an http(s) URL: ${raw}`);
      return null;
    }
    return raw;
  };

  const propertyRaw = value['property'];
  if (!missing(propertyRaw)) {
    if (!isNode(propertyRaw)) {
      fail('.property', 'expected a mapping');
    } else {
      unknownKeys(propertyRaw, '.property', ['type', 'url', 'owners']);
      const type = oneOf(propertyRaw, '.property', 'type', SEARCH_CONSOLE_PROPERTY_TYPES);
      const url = text(propertyRaw, '.property', 'url');
      if (type === 'url-prefix' && url !== null && !isHttpUrl(url)) fail('.property.url', `expected an http(s) URL for a url-prefix property: ${url}`);
      const owners: SearchConsoleOwner[] = [];
      const ownersRaw = propertyRaw['owners'];
      if (missing(ownersRaw)) {
        fail('.property.owners', 'required');
      } else if (!Array.isArray(ownersRaw)) {
        fail('.property.owners', 'expected a list');
      } else {
        ownersRaw.forEach((node, index) => {
          const path = `.property.owners[${index}]`;
          if (!isNode(node)) {
            fail(path, 'expected a mapping');
            return;
          }
          unknownKeys(node, path, ['email', 'verifiedAt']);
          const email = text(node, path, 'email');
          if (email !== null && !/^[^\s@]+@[^\s@]+$/.test(email)) fail(`${path}.email`, `not an email address: ${email}`);
          const verifiedAt = time(node, path, 'verifiedAt', true);
          if (email !== null && verifiedAt !== null) owners.push({ email, verifiedAt });
        });
      }
      if (type !== null && url !== null) out.property = { type, url, owners };
    }
  }

  const sitemaps: SearchConsoleSitemap[] = [];
  const seen = new Set<string>();
  if (
    rows('sitemaps', (node, path) => {
      unknownKeys(node, path, ['url', 'submittedAt', 'status', 'errors']);
      const url = text(node, path, 'url');
      if (url !== null && !isHttpUrl(url)) fail(`${path}.url`, `expected an http(s) URL: ${url}`);
      else if (url !== null && seen.has(url)) fail(`${path}.url`, `duplicate sitemap: ${url}`);
      else if (url !== null) seen.add(url);
      const submittedAt = time(node, path, 'submittedAt', true);
      const status = text(node, path, 'status');
      const errors = node['errors'];
      const errorsOk = typeof errors === 'number' && Number.isInteger(errors) && errors >= 0;
      if (!errorsOk) fail(`${path}.errors`, missing(errors) ? 'required' : 'expected a whole number of 0 or more');
      if (url !== null && submittedAt !== null && status !== null && errorsOk) sitemaps.push({ url, submittedAt, status, errors });
    })
  ) {
    out.sitemaps = sitemaps;
  }

  const manualActions: SearchConsoleManualAction[] = [];
  if (
    rows('manualActions', (node, path) => {
      unknownKeys(node, path, ['type', 'scope', 'detectedAt']);
      const type = text(node, path, 'type');
      const scope = oneOf(node, path, 'scope', SEARCH_CONSOLE_ACTION_SCOPES);
      const detectedAt = time(node, path, 'detectedAt', false);
      if (type !== null && scope !== null) manualActions.push({ type, scope, ...(detectedAt !== null ? { detectedAt } : {}) });
    })
  ) {
    out.manualActions = manualActions;
  }

  const securityIssues: SearchConsoleSecurityIssue[] = [];
  if (
    rows('securityIssues', (node, path) => {
      unknownKeys(node, path, ['type', 'detectedAt']);
      const type = text(node, path, 'type');
      const detectedAt = time(node, path, 'detectedAt', false);
      if (type !== null) securityIssues.push({ type, ...(detectedAt !== null ? { detectedAt } : {}) });
    })
  ) {
    out.securityIssues = securityIssues;
  }
  const pageIndexing: SearchConsolePageIndexing[] = [];
  const indexingSeen = new Set<string>();
  if (
    rows('pageIndexing', (node, path) => {
      unknownKeys(node, path, ['url', 'reason']);
      const url = httpUrl(node, path, 'url');
      const reason = text(node, path, 'reason');
      if (url !== null && reason !== null) {
        if (indexingSeen.has(`${url}\n${reason}`)) fail(`${path}.url`, `duplicate row: ${url}`);
        indexingSeen.add(`${url}\n${reason}`);
        pageIndexing.push({ url, reason });
      }
    })
  ) {
    out.pageIndexing = pageIndexing;
  }

  const urlInspection: SearchConsoleUrlInspection[] = [];
  const inspected = new Set<string>();
  if (
    rows('urlInspection', (node, path) => {
      unknownKeys(node, path, ['url', 'verdict', 'coverage', 'googleCanonical', 'robots', 'indexing']);
      const url = httpUrl(node, path, 'url');
      if (url !== null) {
        if (inspected.has(url)) fail(`${path}.url`, `duplicate inspection: ${url}`);
        inspected.add(url);
      }
      const verdict = text(node, path, 'verdict');
      const coverage = text(node, path, 'coverage');
      const hasCanonical = !missing(node['googleCanonical']);
      const googleCanonical = hasCanonical ? httpUrl(node, path, 'googleCanonical') : null;
      const robots = text(node, path, 'robots');
      const indexing = text(node, path, 'indexing');
      if (url !== null && verdict !== null && coverage !== null && robots !== null && indexing !== null && (googleCanonical !== null || !hasCanonical)) {
        urlInspection.push({ url, verdict, coverage, ...(googleCanonical !== null ? { googleCanonical } : {}), robots, indexing });
      }
    })
  ) {
    out.urlInspection = urlInspection;
  }

  const performance: SearchConsolePerformance[] = [];
  const perfSeen = new Set<string>();
  if (
    rows('performance', (node, path) => {
      unknownKeys(node, path, ['page', 'query', 'clicks', 'impressions', 'period']);
      const page = httpUrl(node, path, 'page');
      const hasQuery = !missing(node['query']);
      const query = hasQuery ? text(node, path, 'query') : null;
      const clicks = count(node, path, 'clicks');
      const impressions = count(node, path, 'impressions');
      if (clicks !== null && impressions !== null && clicks > impressions) fail(`${path}.clicks`, 'more clicks than impressions');
      const period = text(node, path, 'period');
      if (page !== null && period !== null) {
        const key = `${page}\n${query ?? ''}\n${period}`;
        if (perfSeen.has(key)) fail(`${path}.page`, `duplicate row: ${page}`);
        perfSeen.add(key);
      }
      if (page !== null && clicks !== null && impressions !== null && period !== null && (query !== null || !hasQuery)) {
        performance.push({ page, ...(query !== null ? { query } : {}), clicks, impressions, period });
      }
    })
  ) {
    out.performance = performance;
  }

  const links: SearchConsoleLink[] = [];
  const linkSeen = new Set<string>();
  if (
    rows('links', (node, path) => {
      unknownKeys(node, path, ['site', 'count']);
      const site = text(node, path, 'site');
      const linkCount = count(node, path, 'count');
      if (site !== null) {
        if (linkSeen.has(site)) fail(`${path}.site`, `duplicate site: ${site}`);
        linkSeen.add(site);
      }
      if (site !== null && linkCount !== null) links.push({ site, count: linkCount });
    })
  ) {
    out.links = links;
  }
  return ok ? { ...record, ...out } : null;
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
    redirectMap?: RedirectMapRecord;
    domainHistory?: DomainHistoryRecord;
    searchConsole?: SearchConsoleRecord;
    contentDecisions?: readonly ContentDecision[];
  } = {};
  if (value['contentDecisions'] !== undefined && value['contentDecisions'] !== null) {
    const contentDecisions = parseContentDecisions(value['contentDecisions'], problem);
    if (contentDecisions !== null) inputs.contentDecisions = contentDecisions;
  }
  if (value['searchConsole'] !== undefined && value['searchConsole'] !== null) {
    const searchConsole = parseSearchConsole(value['searchConsole'], problem);
    if (searchConsole !== null) inputs.searchConsole = searchConsole;
  }
  if (value['domainHistory'] !== undefined && value['domainHistory'] !== null) {
    const domainHistory = parseDomainHistory(value['domainHistory'], problem);
    if (domainHistory !== null) inputs.domainHistory = domainHistory;
  }
  if (value['redirectMap'] !== undefined && value['redirectMap'] !== null) {
    const redirectMap = parseRedirectMap(value['redirectMap'], problem);
    if (redirectMap !== null) inputs.redirectMap = redirectMap;
  }
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
