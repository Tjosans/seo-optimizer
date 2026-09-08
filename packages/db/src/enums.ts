/**
 * Postgres enums: the closed vocabularies a column may hold.
 *
 * Every enum here mirrors a union type in @seo/core AND is used by a column.
 * The `AssertSame` lines are the guard on the first half: if a union in core
 * gains or loses a member and this file is not updated, the package stops
 * compiling, rather than the drift surfacing as a runtime insert failure
 * against a live database.
 *
 * The second half is the rule that keeps this file from growing things nobody
 * stores. An enum with no column behind it guards nothing — the type checker
 * already compares the union against itself — while still charging a migration
 * for every change to it. So a vocabulary earns a Postgres type by being
 * written to a row, and not otherwise.
 *
 * That is why the corpus's own vocabulary is absent. `Priority`,
 * `AutomationTier` and `RemediationClass` are properties of a check, and checks
 * are file-backed and versioned under `corpus/v<version>` precisely so a
 * methodology revision needs no migration (see the note atop `schema.ts`).
 * Mirroring them here would have made a corpus edit a schema change — the exact
 * coupling the corpus was kept out of the database to avoid. If a column ever
 * does need one of them, add the enum back with the column, in the same
 * migration.
 *
 * Adding a member to a Postgres enum requires a migration, so these are
 * deliberately narrow — anything genuinely open-ended is stored as text.
 */

import { pgEnum } from 'drizzle-orm/pg-core';
import type { Applicability, CheckStatus, Coverage, Profile } from '@seo/core';

/** Compiles to `true` only when the two unions have exactly the same members. */
type AssertSame<A extends string, B extends string> = [
  Exclude<A, B>,
  Exclude<B, A>,
] extends [never, never]
  ? true
  : never;

export const profileEnum = pgEnum('profile', ['core', 'extended']);
const _profile: AssertSame<Profile, (typeof profileEnum.enumValues)[number]> = true;

export const applicabilityEnum = pgEnum('applicability', ['yes', 'no', 'review']);
const _applicability: AssertSame<
  Applicability,
  (typeof applicabilityEnum.enumValues)[number]
> = true;

export const checkStatusEnum = pgEnum('check_status', [
  'not-started',
  'in-progress',
  'passed',
  'failed',
  'skipped',
]);
const _checkStatus: AssertSame<
  CheckStatus,
  (typeof checkStatusEnum.enumValues)[number]
> = true;

export const coverageEnum = pgEnum('coverage', [
  'verified',
  'attested',
  'unknown',
  'not-applicable',
]);
const _coverage: AssertSame<Coverage, (typeof coverageEnum.enumValues)[number]> = true;

// --- run-time vocabulary, owned by the engine rather than the corpus --------

/** Lifecycle of one audit run. */
export const auditStatusEnum = pgEnum('audit_status', [
  'pending',
  'running',
  'complete',
  'failed',
  'cancelled',
]);

/** Lifecycle of one crawl within an audit. */
export const crawlStatusEnum = pgEnum('crawl_status', [
  'queued',
  'running',
  'complete',
  'failed',
  'cancelled',
]);

/**
 * Lifecycle of one queued job. The same five words again, because a job, a
 * crawl and an audit are one piece of work seen from three heights, and a
 * report explaining why an audit never finished has to line them up.
 *
 * Only `queued` and `running` are ever written today: @seo/queue removes a job
 * from the store the moment it settles, because what happened to a finished
 * audit is already recorded on `audits` and a second history would only be
 * something to keep consistent with the first. The terminal three are here so
 * that a store which does want to retain them needs no migration.
 */
export const jobStateEnum = pgEnum('job_state', [
  'queued',
  'running',
  'complete',
  'failed',
  'cancelled',
]);

/**
 * How a page representation was captured. Detector 1.1 compares the two:
 * `raw` is the server response as delivered, `rendered` is the DOM after
 * client-side JavaScript has run.
 */
export const renderModeEnum = pgEnum('render_mode', ['raw', 'rendered']);

/**
 * Where a link was found, since not every edge is an `<a href>`.
 *
 * Every member names something one page declares about another. A sitemap
 * entry does not: it is the site speaking, not a page, and `pageLinks` has no
 * from-page to hang it on. Those URLs live on `crawls.sitemapUrls` instead.
 */
export const linkKindEnum = pgEnum('link_kind', [
  'anchor',
  'canonical',
  'hreflang',
  'pagination',
  'redirect',
]);

/** What a probe observes about. Determines which id column is populated. */
export const probeScopeEnum = pgEnum('probe_scope', ['site', 'page', 'template']);

/**
 * Probe outcome. `error` means the probe itself could not run and is never
 * evidence of a site defect — it must not be scored as a failure.
 */
export const probeOutcomeEnum = pgEnum('probe_outcome', [
  'pass',
  'fail',
  'warn',
  'not-applicable',
  'error',
]);
