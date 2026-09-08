/**
 * Probe vocabulary.
 *
 * A probe observes; it does not grade. Its id is a detector id declared by the
 * corpus, which is what binds a machine observation to the methodology's
 * "Done when" wording — an observation nothing in the corpus asked for has no
 * place in a report, and the matrix in `matrix.ts` refuses to lose track of one.
 */

import type { AiCrawlerPolicy } from '@seo/core';
import type { CrawlResult, CrawledPage } from '@seo/crawler';

export type ProbeScope = 'site' | 'page';

/**
 * `error` means the probe could not run. It is never evidence of a site
 * defect and must never be scored as a failure.
 */
export type ProbeOutcome = 'pass' | 'fail' | 'warn' | 'not-applicable' | 'error';

export interface Observation {
  readonly outcome: ProbeOutcome;
  /** One report-ready line. Detail belongs in `data`. */
  readonly summary: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface SiteContext {
  readonly origin: string;
  readonly crawl: CrawlResult;
  /** Site-profile flags, as held on the site record. */
  readonly flags: readonly string[];
  /**
   * The AI crawler policy the site's owners approved, or null when none is
   * recorded. An input a person supplied, not something the crawl observed.
   */
  readonly aiPolicy?: AiCrawlerPolicy | null;
}

export interface PageContext {
  readonly page: CrawledPage;
  readonly site: SiteContext;
}

interface ProbeBase {
  /** A detector id declared by the corpus. */
  readonly id: string;
  /** What the probe looks at, in the report's words. */
  readonly title: string;
}

export interface PageProbe extends ProbeBase {
  readonly scope: 'page';
  /** Skip pages that are not HTML. Almost every page probe wants this. */
  readonly htmlOnly?: boolean;
  run(context: PageContext): Observation;
}

export interface SiteProbe extends ProbeBase {
  readonly scope: 'site';
  run(context: SiteContext): Observation;
}

export type Probe = PageProbe | SiteProbe;

/** One observation, with the subject it was made about. */
export interface ProbeRun {
  readonly probeId: string;
  readonly scope: ProbeScope;
  /** Normalized URL for page-scoped runs; undefined for site-scoped ones. */
  readonly pageUrl?: string;
  readonly observation: Observation;
}

export const pass = (summary: string, data?: Record<string, unknown>): Observation =>
  data === undefined ? { outcome: 'pass', summary } : { outcome: 'pass', summary, data };

export const fail = (summary: string, data?: Record<string, unknown>): Observation =>
  data === undefined ? { outcome: 'fail', summary } : { outcome: 'fail', summary, data };

export const warn = (summary: string, data?: Record<string, unknown>): Observation =>
  data === undefined ? { outcome: 'warn', summary } : { outcome: 'warn', summary, data };

export const notApplicable = (summary: string): Observation =>
  ({ outcome: 'not-applicable', summary });

/**
 * The probe could not answer its question, and says why.
 *
 * Distinct from `not-applicable`, which means the question does not arise.
 * This is the question arising and the evidence being unavailable — a body the
 * crawler cut at its size limit, most often — and the grader leaves the check
 * ungraded rather than crediting or blaming the site for what nobody saw.
 */
export const errored = (summary: string, data?: Record<string, unknown>): Observation =>
  data === undefined ? { outcome: 'error', summary } : { outcome: 'error', summary, data };
