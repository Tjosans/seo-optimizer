/**
 * Persistence schema.
 *
 * Two things are deliberately NOT stored here:
 *
 *   The corpus. It is file-backed, versioned and immutable (corpus/v4.4), so
 *   check ids are plain text columns rather than foreign keys. An audit pins
 *   `corpusVersion` instead, which is what makes an old report reproducible.
 *
 *   Response bodies. Pages record a content hash and an object-store key; the
 *   bytes themselves never enter Postgres.
 *
 * The split between evidence and verdict is the other load-bearing decision:
 * `probeResults` are observations a machine made and can re-make, while
 * `checkStates` are the graded answers a report is built from. They are joined
 * through `checkEvidence`, so every verdict can be traced to what produced it.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  applicabilityEnum,
  auditStatusEnum,
  checkStatusEnum,
  coverageEnum,
  crawlStatusEnum,
  linkKindEnum,
  probeOutcomeEnum,
  probeScopeEnum,
  profileEnum,
  renderModeEnum,
} from './enums.js';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** A site under audit. */
export const sites = pgTable('sites', {
  id: id(),
  name: text('name').notNull(),
  /** Canonical origin, scheme included and no trailing slash: https://example.com */
  origin: text('origin').notNull().unique(),
  /**
   * Site-profile flags that resolve corpus applicability rules — 'ecommerce',
   * 'multilingual', 'migration' and so on. A check is in scope when it is
   * universal or when it names at least one flag held here.
   */
  flags: text('flags').array().notNull().default(sql`'{}'::text[]`),
  /** Advisory effort scoping. Never a launch filter; see @seo/core. */
  profile: profileEnum('profile').notNull().default('core'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One assessment of a site against one pinned corpus version. */
export const audits = pgTable(
  'audits',
  {
    id: id(),
    siteId: uuid('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
    /** Pinned so a historical report can always be re-explained. */
    corpusVersion: text('corpus_version').notNull(),
    status: auditStatusEnum('status').notNull().default('pending'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /**
     * Launch readiness frozen at completion. Recomputable from `checkStates`
     * while an audit is live, but a delivered report must not change when the
     * engine's scoring later does.
     */
    readiness: jsonb('readiness'),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [index('audits_site_created_idx').on(t.siteId, t.createdAt)],
);

/**
 * Per-audit state of one corpus check. Mirrors CheckState in @seo/core.
 *
 * The two check constraints encode integrity rules the engine also enforces in
 * computeLaunchReadiness. They are duplicated here on purpose: a violation
 * written by any other client would otherwise silently corrupt a launch
 * decision, and the database is the last place able to refuse it.
 */
export const checkStates = pgTable(
  'check_states',
  {
    auditId: uuid('audit_id').notNull().references(() => audits.id, { onDelete: 'cascade' }),
    /** Corpus check id, e.g. "1.3". Stable across corpus versions. */
    checkId: text('check_id').notNull(),
    applicability: applicabilityEnum('applicability').notNull().default('review'),
    applicabilityRationale: text('applicability_rationale'),
    status: checkStatusEnum('status').notNull().default('not-started'),
    coverage: coverageEnum('coverage').notNull().default('unknown'),
    /** Human-readable pointer to the proof; the machine trail is checkEvidence. */
    evidence: text('evidence'),
    attestationExpiresAt: timestamp('attestation_expires_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.auditId, t.checkId] }),
    index('check_states_audit_status_idx').on(t.auditId, t.status),
    check(
      'excluded_needs_rationale',
      sql`${t.applicability} <> 'no' OR ${t.applicabilityRationale} IS NOT NULL`,
    ),
    check(
      'attestation_needs_expiry',
      sql`${t.coverage} <> 'attested' OR ${t.attestationExpiresAt} IS NOT NULL`,
    ),
  ],
);

/**
 * A human sign-off on a check no crawler can verify. Rows are append-only:
 * a lapsed attestation stays on the record and coverage reverts to `unknown`
 * rather than the history being rewritten.
 */
export const attestations = pgTable(
  'attestations',
  {
    id: id(),
    auditId: uuid('audit_id').notNull().references(() => audits.id, { onDelete: 'cascade' }),
    checkId: text('check_id').notNull(),
    /** Who takes responsibility. Free text until identities are modelled. */
    attestedBy: text('attested_by').notNull(),
    /** What was attested, in the attester's own words. */
    statement: text('statement').notNull(),
    attestedAt: timestamp('attested_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('attestations_audit_check_idx').on(t.auditId, t.checkId)],
);

/** One crawl session. An audit may run several — raw, rendered, re-crawls. */
export const crawls = pgTable(
  'crawls',
  {
    id: id(),
    auditId: uuid('audit_id').notNull().references(() => audits.id, { onDelete: 'cascade' }),
    /**
     * Where the crawl started, in order. The first entry is load-bearing: it
     * is the origin every other URL is scoped against, so a URL on a different
     * host than seeds[0] is off-site even when a later seed names that host.
     */
    seedUrls: text('seed_urls').array().notNull(),
    status: crawlStatusEnum('status').notNull().default('queued'),
    /** Sent on every request; recorded because robots rules key off it. */
    userAgent: text('user_agent').notNull(),
    respectRobots: boolean('respect_robots').notNull().default(true),
    maxPages: integer('max_pages').notNull(),
    maxDepth: integer('max_depth').notNull(),
    /** Politeness delay actually applied, after any robots crawl-delay. */
    requestDelayMs: integer('request_delay_ms').notNull().default(0),
    /** robots.txt as fetched, so a later dispute can be settled. */
    robotsTxt: text('robots_txt'),
    /**
     * Every URL the site's own sitemaps declared, normalized.
     *
     * Stored rather than re-derived because four site-scoped probes compare it
     * against what was actually crawled — sitemap validity, sitemap/canonical
     * agreement, index bloat and orphan detection all read it — and a sitemap
     * is a file the site can change between the crawl and the report. Keeping
     * it here is what lets those probes be re-run against a stored crawl and
     * reach the same answer.
     *
     * With this and `robotsTxt` recorded, the two other lists a crawl produces
     * are recoverable: a discovered URL with no page row was either disallowed
     * or out of budget, and robots.txt says which.
     */
    sitemapUrls: text('sitemap_urls').array().notNull().default(sql`'{}'::text[]`),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [index('crawls_audit_idx').on(t.auditId)],
);

/**
 * One URL fetched in one crawl.
 *
 * `url` is what was requested; `normalizedUrl` is the identity used for
 * dedup and link resolution. Keeping both is what lets a probe report that a
 * site treats two spellings of the same URL as two pages.
 */
export const pages = pgTable(
  'pages',
  {
    id: id(),
    crawlId: uuid('crawl_id').notNull().references(() => crawls.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    normalizedUrl: text('normalized_url').notNull(),
    depth: integer('depth').notNull(),
    /** The page this URL was first discovered on; null for a seed. */
    discoveredFromId: uuid('discovered_from_id').references(
      (): AnyPgColumn => pages.id,
      { onDelete: 'set null' },
    ),
    /** Final HTTP status, or null when the request never completed. */
    status: smallint('status'),
    /** Transport-level failure (DNS, TLS, timeout). Never a site verdict on its own. */
    fetchError: text('fetch_error'),
    contentType: text('content_type'),
    contentLength: integer('content_length'),
    /** [{ url, status }] in order, empty when the response was direct. */
    redirectChain: jsonb('redirect_chain').notNull().default(sql`'[]'::jsonb`),
    ttfbMs: integer('ttfb_ms'),
    totalMs: integer('total_ms'),
    /** Response headers, lowercased keys, as received. */
    headers: jsonb('headers'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('pages_crawl_url_uniq').on(t.crawlId, t.normalizedUrl),
    index('pages_crawl_status_idx').on(t.crawlId, t.status),
  ],
);

/**
 * A captured representation of a page. One row per render mode, which is what
 * makes the raw-vs-rendered parity detector expressible as a join rather than
 * a special case.
 */
export const renders = pgTable(
  'renders',
  {
    id: id(),
    pageId: uuid('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
    mode: renderModeEnum('mode').notNull(),
    /** sha256 of the captured markup. Equal hashes mean nothing changed. */
    bodyHash: text('body_hash').notNull(),
    /** Object-store key for the bytes. Bodies never live in Postgres. */
    bodyKey: text('body_key'),
    byteLength: integer('byte_length').notNull(),
    /** sha256 of extracted visible text, for parity independent of markup noise. */
    textHash: text('text_hash'),
    /** Extracted signals a probe reads without re-parsing: title, canonical, robots… */
    extracted: jsonb('extracted'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('renders_page_mode_uniq').on(t.pageId, t.mode)],
);

/**
 * A directed edge discovered during a crawl.
 *
 * `toPageId` stays null when the target was never fetched — out of scope,
 * blocked, or beyond the crawl budget — which is exactly the signal orphan and
 * broken-link probes need, so unresolved edges are kept rather than dropped.
 */
export const pageLinks = pgTable(
  'page_links',
  {
    id: id(),
    crawlId: uuid('crawl_id').notNull().references(() => crawls.id, { onDelete: 'cascade' }),
    fromPageId: uuid('from_page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
    toPageId: uuid('to_page_id').references(() => pages.id, { onDelete: 'set null' }),
    toUrl: text('to_url').notNull(),
    toNormalizedUrl: text('to_normalized_url').notNull(),
    kind: linkKindEnum('kind').notNull().default('anchor'),
    anchorText: text('anchor_text'),
    rel: text('rel'),
    nofollow: boolean('nofollow').notNull().default(false),
    /** False for links only reachable after JavaScript runs. */
    inRawHtml: boolean('in_raw_html').notNull().default(true),
  },
  (t) => [
    index('page_links_from_idx').on(t.fromPageId),
    index('page_links_target_idx').on(t.crawlId, t.toNormalizedUrl),
  ],
);

/**
 * One observation by one probe. This is the evidence layer: probes state what
 * they saw, never what it means for a launch. Grading happens in `checkStates`.
 *
 * `probeId` is a detector id declared by the corpus (Check.detectors). It is
 * text rather than an enum because the probe matrix grows without a migration.
 */
export const probeResults = pgTable(
  'probe_results',
  {
    id: id(),
    auditId: uuid('audit_id').notNull().references(() => audits.id, { onDelete: 'cascade' }),
    crawlId: uuid('crawl_id').references(() => crawls.id, { onDelete: 'cascade' }),
    /** Set for page-scoped probes; null for site-scoped ones. */
    pageId: uuid('page_id').references(() => pages.id, { onDelete: 'cascade' }),
    probeId: text('probe_id').notNull(),
    scope: probeScopeEnum('scope').notNull(),
    outcome: probeOutcomeEnum('outcome').notNull(),
    /** One line, report-ready. The detail lives in `data`. */
    summary: text('summary').notNull(),
    /** Structured observation: measured values, offending selectors, samples. */
    data: jsonb('data'),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('probe_results_audit_probe_idx').on(t.auditId, t.probeId),
    index('probe_results_page_idx').on(t.pageId),
    check(
      'page_scope_needs_page',
      sql`${t.scope} <> 'page' OR ${t.pageId} IS NOT NULL`,
    ),
  ],
);

/** Ties a graded check back to the observations that produced it. */
export const checkEvidence = pgTable(
  'check_evidence',
  {
    auditId: uuid('audit_id').notNull(),
    checkId: text('check_id').notNull(),
    probeResultId: uuid('probe_result_id')
      .notNull()
      .references(() => probeResults.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.auditId, t.checkId, t.probeResultId] }),
    foreignKey({
      columns: [t.auditId, t.checkId],
      foreignColumns: [checkStates.auditId, checkStates.checkId],
      name: 'check_evidence_state_fk',
    }).onDelete('cascade'),
  ],
);
