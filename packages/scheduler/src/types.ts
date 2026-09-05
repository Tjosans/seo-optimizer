/**
 * What an audit request is, and what running one produces.
 *
 * The shape here is the one an HTTP handler will marshal into (ROADMAP Phase
 * 7): a site id, a pinned corpus version, and an optional narrowing of the
 * crawl budget. Everything else the engine already knows or can default.
 */

import type { Corpus } from '@seo/core';
import type { CrawlOptions } from '@seo/crawler';
import type { FrozenReadiness } from '@seo/grader';

/**
 * How the scheduler gets the corpus an audit pinned.
 *
 * A function rather than a `Corpus`, because the version is per request: an
 * audit submitted against 4.4 must be graded against 4.4 however many newer
 * corpora the process has since loaded. Resolving through the version is what
 * keeps an old report re-explainable.
 */
export type CorpusSource = (version: string) => Corpus | Promise<Corpus>;

/**
 * The crawl budget, minus the parts the scheduler fills in per site.
 *
 * `seeds` is absent because it comes from the site record, and `onPage` and
 * `fetchImpl` because a scheduled audit streams to the database rather than to
 * a caller's closure.
 */
export type CrawlBudget = Omit<CrawlOptions, 'seeds' | 'onPage' | 'fetchImpl'>;

export interface AuditRequest {
  readonly siteId: string;
  /** Pinned so the report stays reproducible, e.g. "4.4". */
  readonly corpusVersion: string;
  /**
   * Where to start. Defaults to the site's own origin.
   *
   * The first entry is load-bearing — it is the origin every other URL is
   * scoped against — so a caller overriding this is choosing the crawl's
   * boundary, not just adding entry points.
   */
  readonly seeds?: readonly string[];
  /** Overrides the scheduler's defaults, field by field. */
  readonly crawl?: Partial<CrawlBudget>;
}

/** The payload the queue carries. Everything needed to run without re-reading. */
export interface AuditJob {
  readonly auditId: string;
  readonly siteId: string;
  readonly origin: string;
  readonly flags: readonly string[];
  /** Pinned at submit time; the version the grader must be handed. */
  readonly corpusVersion: string;
  readonly options: CrawlOptions;
}

export interface AuditOutcome {
  readonly auditId: string;
  readonly crawlId: string;
  readonly pagesCrawled: number;
  readonly probeRuns: number;
  /** Checks whose state this run wrote. */
  readonly checksGraded: number;
  /** The verdict, as frozen onto the audit row. */
  readonly readiness: FrozenReadiness;
}

export interface AuditHandle {
  /** Available the moment `submit` resolves, before the crawl starts. */
  readonly auditId: string;
  /** Resolves when the audit finishes; rejects if it failed or was cancelled. */
  readonly done: Promise<AuditOutcome>;
}

/** The site id in an audit request names no row. */
export class UnknownSiteError extends Error {
  readonly siteId: string;

  constructor(siteId: string) {
    super(`no site with id ${siteId}`);
    this.name = 'UnknownSiteError';
    this.siteId = siteId;
  }
}
