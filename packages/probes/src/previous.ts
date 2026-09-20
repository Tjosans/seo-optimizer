/**
 * A previous audit, as far as a probe may lean on it.
 *
 * Some questions are only answerable against an earlier look at the same site:
 * did a URL that was indexable stay indexable, did a canonical move, did a
 * redirect map land where it promised. The earlier look is an input, like the AI
 * crawler policy — a probe reads it and never fetches — and it is deliberately a
 * small, plain snapshot rather than a crawl: what a person can save to a file
 * beside an `npm run analyze` snapshot, and what the scheduler can rebuild from
 * the rows the last completed audit left in the database.
 */

import { normalizeUrl } from '@seo/crawler';
import type { CrawlResult, CrawlSettings, Extracted } from '@seo/crawler';
import { jsonLdTypes } from './probes/metadata.js';
import type { ProbeOutcome, ProbeRun } from './types.js';

/** Bump when a field's meaning changes; `parsePrevious` refuses any other. */
export const PREVIOUS_AUDIT_SCHEMA = 1;

export interface PreviousPage {
  /** Normalized URL, the key a current page is looked up by. */
  readonly url: string;
  /** Final HTTP status, or null when the request never completed. */
  readonly status: number | null;
  /** Where the redirect chain ended; equals `url` when it did not redirect. */
  readonly finalUrl: string | null;
  /** `<meta name="robots">` as written; null when absent or the page was not HTML. */
  readonly metaRobots: string | null;
  /** The `X-Robots-Tag` response header as sent. */
  readonly xRobotsTag: string | null;
  readonly canonical: string | null;
  readonly title: string | null;
  /** The first `<h1>`. Absent from snapshots taken before it was recorded. */
  readonly h1?: string | null;
  /** Words of reading matter. Absent from snapshots taken before it was recorded. */
  readonly words?: number | null;
  /** schema.org `@type` values found in JSON-LD, sorted and unique. */
  readonly jsonLdTypes: readonly string[];
  readonly hreflang: readonly { readonly hreflang: string; readonly url: string }[];
  /**
   * The axe-core violations the earlier crawl recorded on this page's render.
   * Null when axe was not run or failed there; absent from snapshots taken
   * before it was recorded or rebuilt from stored rows.
   */
  readonly axe?: readonly PreviousAxeViolation[] | null;
}

export interface PreviousAxeViolation {
  readonly id: string;
  readonly impact: string | null;
  readonly nodes: number;
}

export interface PreviousProbe {
  readonly probeId: string;
  /** Normalized URL for a page-scoped outcome; null for a site-scoped one. */
  readonly pageUrl: string | null;
  readonly outcome: ProbeOutcome;
}

export interface PreviousAudit {
  readonly schema: typeof PREVIOUS_AUDIT_SCHEMA;
  readonly origin: string;
  /** ISO 8601 moment the earlier audit's crawl finished. */
  readonly takenAt: string;
  readonly pages: readonly PreviousPage[];
  /**
   * The limits and render settings the earlier crawl ran under. Absent when the
   * snapshot was rebuilt from stored rows, which do not keep them.
   */
  readonly settings?: CrawlSettings;
  /**
   * Normalized URLs the earlier crawl found disallowed by robots.txt. Absent when
   * the snapshot was rebuilt from stored rows, which do not keep the list.
   */
  readonly blockedByRobots?: readonly string[];
  readonly probes: readonly PreviousProbe[];
}

/** What `snapshotPage` needs of a page — a crawled one, or one read back from the database. */
export interface PageFacts {
  readonly url: string;
  readonly finalUrl: string | null;
  readonly status: number | null;
  readonly headers: Readonly<Record<string, string>> | null;
  readonly extracted:
    | (Pick<Extracted, 'metaRobots' | 'canonical' | 'title' | 'jsonLd' | 'hreflang'> &
        Partial<Pick<Extracted, 'headings' | 'content'>>)
    | null;
  /** The page's axe result, when the caller has one; null for none usable. */
  readonly axe?: readonly PreviousAxeViolation[] | null;
}

export function snapshotPage(facts: PageFacts): PreviousPage {
  const extracted = facts.extracted;
  return {
    url: normalizeUrl(facts.url) ?? facts.url,
    status: facts.status,
    finalUrl: facts.finalUrl,
    metaRobots: extracted?.metaRobots ?? null,
    xRobotsTag: facts.headers?.['x-robots-tag'] ?? null,
    canonical: extracted?.canonical ?? null,
    title: extracted?.title ?? null,
    ...(extracted?.headings === undefined
      ? {}
      : { h1: extracted.headings.find((heading) => heading.level === 1)?.text ?? null }),
    ...(extracted?.content?.sections === undefined
      ? {}
      : { words: extracted.content.sections.reduce((sum, section) => sum + section.words, 0) }),
    jsonLdTypes: [...new Set(jsonLdTypes(extracted?.jsonLd ?? []))].sort(),
    hreflang: (extracted?.hreflang ?? []).map(({ hreflang, url }) => ({ hreflang, url })),
    ...(facts.axe === undefined ? {} : { axe: facts.axe }),
  };
}

export function snapshotProbes(runs: readonly ProbeRun[]): PreviousProbe[] {
  return runs.map((run) => ({
    probeId: run.probeId,
    pageUrl: run.pageUrl === undefined ? null : run.pageUrl,
    outcome: run.observation.outcome,
  }));
}

/** A page's axe violations, or null when axe was not run or failed on it. */
const axeOf = (
  result: { readonly error: string | null; readonly violations: readonly PreviousAxeViolation[] } | undefined,
): PreviousAxeViolation[] | null =>
  result === undefined || result.error !== null
    ? null
    : result.violations.map(({ id, impact, nodes }) => ({ id, impact, nodes }));

/** Take the snapshot a later audit of this site will compare itself against. */
export function snapshotAudit(input: {
  readonly origin: string;
  readonly crawl: CrawlResult;
  readonly runs: readonly ProbeRun[];
  readonly takenAt: Date;
}): PreviousAudit {
  return {
    schema: PREVIOUS_AUDIT_SCHEMA,
    origin: input.origin,
    takenAt: input.takenAt.toISOString(),
    pages: input.crawl.pages.map((page) =>
      snapshotPage({
        url: page.normalizedUrl,
        finalUrl: page.fetch.finalUrl,
        status: page.fetch.status,
        headers: page.fetch.headers,
        extracted: page.extracted,
        axe: axeOf(page.rendered?.render.accessibility),
      }),
    ),
    ...(input.crawl.settings === undefined ? {} : { settings: input.crawl.settings }),
    blockedByRobots: [...input.crawl.blockedByRobots],
    probes: snapshotProbes(input.runs),
  };
}

const OUTCOMES: readonly string[] = ['pass', 'fail', 'warn', 'not-applicable', 'error'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function text(value: unknown, path: string, nullable: boolean): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'string') throw new Error(`${path}: expected text`);
  return value;
}

function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path}: expected a list`);
  return value;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path}: expected an object`);
  return value;
}

/**
 * Read a snapshot back from JSON, strictly: a wrong shape is refused rather
 * than read as an empty audit, because a comparison against nothing would
 * report every URL as new.
 */
export function parsePrevious(value: unknown): PreviousAudit {
  const root = record(value, 'previous');
  if (root['schema'] !== PREVIOUS_AUDIT_SCHEMA) {
    throw new Error(`previous.schema: expected ${PREVIOUS_AUDIT_SCHEMA}`);
  }
  const takenAt = text(root['takenAt'], 'previous.takenAt', false) ?? '';
  if (Number.isNaN(Date.parse(takenAt))) throw new Error('previous.takenAt: not a date');

  const pages = list(root['pages'], 'previous.pages').map((raw, i): PreviousPage => {
    const path = `previous.pages[${i}]`;
    const page = record(raw, path);
    const status = page['status'];
    if (status !== null && typeof status !== 'number') throw new Error(`${path}.status: expected a number`);
    const h1 = page['h1'];
    const words = page['words'];
    const axe = page['axe'];
    if (axe !== undefined && axe !== null) {
      list(axe, `${path}.axe`).forEach((raw, j) => {
        const item = record(raw, `${path}.axe[${j}]`);
        text(item['id'], `${path}.axe[${j}].id`, false);
        text(item['impact'], `${path}.axe[${j}].impact`, true);
        if (typeof item['nodes'] !== 'number') throw new Error(`${path}.axe[${j}].nodes: expected a number`);
      });
    }
    if (h1 !== undefined) text(h1, `${path}.h1`, true);
    if (words !== undefined && words !== null && typeof words !== 'number') {
      throw new Error(`${path}.words: expected a number`);
    }
    return {
      url: text(page['url'], `${path}.url`, false) ?? '',
      status,
      finalUrl: text(page['finalUrl'], `${path}.finalUrl`, true),
      metaRobots: text(page['metaRobots'], `${path}.metaRobots`, true),
      xRobotsTag: text(page['xRobotsTag'], `${path}.xRobotsTag`, true),
      canonical: text(page['canonical'], `${path}.canonical`, true),
      title: text(page['title'], `${path}.title`, true),
      ...(h1 === undefined ? {} : { h1: h1 as string | null }),
      ...(words === undefined ? {} : { words: words as number | null }),
      ...(axe === undefined ? {} : { axe: axe as PreviousAxeViolation[] | null }),
      jsonLdTypes: list(page['jsonLdTypes'], `${path}.jsonLdTypes`).map(
        (type, j) => text(type, `${path}.jsonLdTypes[${j}]`, false) ?? '',
      ),
      hreflang: list(page['hreflang'], `${path}.hreflang`).map((entry, j) => {
        const item = record(entry, `${path}.hreflang[${j}]`);
        return {
          hreflang: text(item['hreflang'], `${path}.hreflang[${j}].hreflang`, false) ?? '',
          url: text(item['url'], `${path}.hreflang[${j}].url`, false) ?? '',
        };
      }),
    };
  });

  const probes = list(root['probes'], 'previous.probes').map((raw, i): PreviousProbe => {
    const path = `previous.probes[${i}]`;
    const probe = record(raw, path);
    const outcome = text(probe['outcome'], `${path}.outcome`, false) ?? '';
    if (!OUTCOMES.includes(outcome)) throw new Error(`${path}.outcome: unknown outcome "${outcome}"`);
    return {
      probeId: text(probe['probeId'], `${path}.probeId`, false) ?? '',
      pageUrl: text(probe['pageUrl'], `${path}.pageUrl`, true),
      outcome: outcome as ProbeOutcome,
    };
  });

  const blocked = root['blockedByRobots'];
  const rawSettings = root['settings'];
  let settings: CrawlSettings | undefined;
  if (rawSettings !== undefined) {
    const item = record(rawSettings, 'previous.settings');
    for (const key of ['maxPages', 'maxDepth'] as const) {
      if (typeof item[key] !== 'number') throw new Error(`previous.settings.${key}: expected a number`);
    }
    for (const key of ['renderPages', 'renderMobile'] as const) {
      if (typeof item[key] !== 'boolean') throw new Error(`previous.settings.${key}: expected true or false`);
    }
    settings = item as unknown as CrawlSettings;
  }
  return {
    schema: PREVIOUS_AUDIT_SCHEMA,
    origin: text(root['origin'], 'previous.origin', false) ?? '',
    takenAt,
    pages,
    ...(settings === undefined ? {} : { settings }),
    ...(blocked === undefined
      ? {}
      : {
          blockedByRobots: list(blocked, 'previous.blockedByRobots').map(
            (url, i) => text(url, `previous.blockedByRobots[${i}]`, false) ?? '',
          ),
        }),
    probes,
  };
}

/** The earlier page at a URL, if the earlier crawl reached it. */
export function previousPage(previous: PreviousAudit, url: string): PreviousPage | undefined {
  const key = normalizeUrl(url) ?? url;
  return previous.pages.find((page) => page.url === key);
}
