/**
 * Audit request validation, shared by `POST /audits`.
 *
 * Same discipline as `parseSiteInput` and `parseReleaseFile`: an unknown
 * field or a value of the wrong type is refused rather than silently dropped
 * or coerced. `siteId` and `corpusVersion` are required — everything else is
 * exactly what `AuditRequest` (@seo/scheduler) already accepts, narrowed to
 * the fields a caller may safely override from outside.
 */

import type { AuditRequest } from '@seo/scheduler';

/** A create body that is not a valid audit request. Every problem is listed, by field. */
export class AuditInputError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`invalid audit:\n  ${problems.join('\n  ')}`);
    this.name = 'AuditInputError';
  }
}

type Record_ = Record<string, unknown>;

const isRecord = (value: unknown): value is Record_ =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const ALLOWED = ['siteId', 'corpusVersion', 'seeds', 'crawl', 'release'] as const;

const CRAWL_ALLOWED = [
  'maxPages',
  'maxDepth',
  'userAgent',
  'requestDelayMs',
  'respectRobots',
  'followSitemaps',
  'timeoutMs',
  'auxiliary',
  'renderPages',
  'renderTimeoutMs',
  'renderSettleMs',
] as const;

/** A non-negative finite number — the shape every millisecond/count field here takes. */
const isNonNegativeNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function parseAuditRequest(value: unknown): AuditRequest {
  const problems: string[] = [];
  const problem = (path: string, text: string) => problems.push(`${path}: ${text}`);

  if (!isRecord(value)) {
    throw new AuditInputError(['body: expected a mapping']);
  }
  for (const key of Object.keys(value)) {
    if (!(ALLOWED as readonly string[]).includes(key)) problem(key, 'unknown field');
  }

  let siteId: string | undefined;
  if ('siteId' in value) {
    const raw = value['siteId'];
    if (typeof raw !== 'string' || raw.trim() === '') problem('siteId', 'expected non-empty text');
    else siteId = raw;
  } else {
    problem('siteId', 'required');
  }

  let corpusVersion: string | undefined;
  if ('corpusVersion' in value) {
    const raw = value['corpusVersion'];
    if (typeof raw !== 'string' || raw.trim() === '') problem('corpusVersion', 'expected non-empty text');
    else corpusVersion = raw;
  } else {
    problem('corpusVersion', 'required');
  }

  let seeds: string[] | undefined;
  if ('seeds' in value) {
    const raw = value['seeds'];
    if (!Array.isArray(raw) || raw.length === 0 || raw.some((s) => typeof s !== 'string' || s.trim() === '')) {
      problem('seeds', 'expected a non-empty array of non-empty text');
    } else {
      seeds = raw as string[];
    }
  }

  let release: string | undefined;
  if ('release' in value) {
    const raw = value['release'];
    if (typeof raw !== 'string' || raw.trim() === '') problem('release', 'expected non-empty text');
    else release = raw;
  }

  let crawl: AuditRequest['crawl'] | undefined;
  if ('crawl' in value) {
    const rawCrawl = value['crawl'];
    if (!isRecord(rawCrawl)) {
      problem('crawl', 'expected a mapping');
    } else {
      const out: { -readonly [K in keyof NonNullable<AuditRequest['crawl']>]?: unknown } = {};
      for (const key of Object.keys(rawCrawl)) {
        if (!(CRAWL_ALLOWED as readonly string[]).includes(key)) problem(`crawl.${key}`, 'unknown field');
      }

      if ('maxPages' in rawCrawl) {
        const v = rawCrawl['maxPages'];
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) problem('crawl.maxPages', 'expected a positive integer');
        else out.maxPages = v;
      }
      if ('maxDepth' in rawCrawl) {
        const v = rawCrawl['maxDepth'];
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) problem('crawl.maxDepth', 'expected a non-negative integer');
        else out.maxDepth = v;
      }
      if ('userAgent' in rawCrawl) {
        const v = rawCrawl['userAgent'];
        if (typeof v !== 'string' || v.trim() === '') problem('crawl.userAgent', 'expected non-empty text');
        else out.userAgent = v;
      }
      if ('requestDelayMs' in rawCrawl) {
        const v = rawCrawl['requestDelayMs'];
        if (!isNonNegativeNumber(v)) problem('crawl.requestDelayMs', 'expected a non-negative number');
        else out.requestDelayMs = v;
      }
      if ('respectRobots' in rawCrawl) {
        const v = rawCrawl['respectRobots'];
        if (typeof v !== 'boolean') problem('crawl.respectRobots', 'expected true or false');
        else out.respectRobots = v;
      }
      if ('followSitemaps' in rawCrawl) {
        const v = rawCrawl['followSitemaps'];
        if (typeof v !== 'boolean') problem('crawl.followSitemaps', 'expected true or false');
        else out.followSitemaps = v;
      }
      if ('timeoutMs' in rawCrawl) {
        const v = rawCrawl['timeoutMs'];
        if (!isNonNegativeNumber(v)) problem('crawl.timeoutMs', 'expected a non-negative number');
        else out.timeoutMs = v;
      }
      if ('auxiliary' in rawCrawl) {
        const v = rawCrawl['auxiliary'];
        if (typeof v !== 'boolean') problem('crawl.auxiliary', 'expected true or false');
        else out.auxiliary = v;
      }
      if ('renderPages' in rawCrawl) {
        const v = rawCrawl['renderPages'];
        if (typeof v !== 'boolean') problem('crawl.renderPages', 'expected true or false');
        else out.renderPages = v;
      }
      if ('renderTimeoutMs' in rawCrawl) {
        const v = rawCrawl['renderTimeoutMs'];
        if (!isNonNegativeNumber(v)) problem('crawl.renderTimeoutMs', 'expected a non-negative number');
        else out.renderTimeoutMs = v;
      }
      if ('renderSettleMs' in rawCrawl) {
        const v = rawCrawl['renderSettleMs'];
        if (!isNonNegativeNumber(v)) problem('crawl.renderSettleMs', 'expected a non-negative number');
        else out.renderSettleMs = v;
      }

      if (Object.keys(out).length > 0) crawl = out as AuditRequest['crawl'];
    }
  }

  if (problems.length > 0) throw new AuditInputError(problems);

  return {
    siteId: siteId!,
    corpusVersion: corpusVersion!,
    ...(seeds !== undefined ? { seeds } : {}),
    ...(crawl !== undefined ? { crawl } : {}),
    ...(release !== undefined ? { release } : {}),
  };
}
