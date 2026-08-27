/**
 * Postgres enums for the corpus vocabulary.
 *
 * Every enum here mirrors a union type in @seo/core. The `AssertSame` lines
 * below are the guard: if a union in core gains or loses a member and this
 * file is not updated, the package stops compiling. Without that, drift would
 * only show up as a runtime insert failure against a live database.
 *
 * Adding a member to a Postgres enum requires a migration, so these are
 * deliberately narrow — anything genuinely open-ended is stored as text.
 */

import { pgEnum } from 'drizzle-orm/pg-core';
import type {
  Applicability,
  AutomationTier,
  CheckStatus,
  Coverage,
  Priority,
  Profile,
  RemediationClass,
} from '@seo/core';

/** Compiles to `true` only when the two unions have exactly the same members. */
type AssertSame<A extends string, B extends string> = [
  Exclude<A, B>,
  Exclude<B, A>,
] extends [never, never]
  ? true
  : never;

export const priorityEnum = pgEnum('priority', ['P0', 'P1', 'P2']);
const _priority: AssertSame<Priority, (typeof priorityEnum.enumValues)[number]> = true;

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

export const automationTierEnum = pgEnum('automation_tier', [
  'automated',
  'assisted',
  'attested',
]);
const _automationTier: AssertSame<
  AutomationTier,
  (typeof automationTierEnum.enumValues)[number]
> = true;

export const remediationClassEnum = pgEnum('remediation_class', [
  'config',
  'content',
  'code',
  'structural',
  'platform',
]);
const _remediationClass: AssertSame<
  RemediationClass,
  (typeof remediationClassEnum.enumValues)[number]
> = true;

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
 * How a page representation was captured. Detector 1.1 compares the two:
 * `raw` is the server response as delivered, `rendered` is the DOM after
 * client-side JavaScript has run.
 */
export const renderModeEnum = pgEnum('render_mode', ['raw', 'rendered']);

/** Where a link was found, since not every edge is an `<a href>`. */
export const linkKindEnum = pgEnum('link_kind', [
  'anchor',
  'canonical',
  'hreflang',
  'pagination',
  'redirect',
  'sitemap',
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
