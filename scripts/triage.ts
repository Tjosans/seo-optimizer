/**
 * Automation triage, one table per corpus version. `triageFor(version)` is
 * what the compiler reads; a version with no table does not compile.
 *
 * Automation triage for the v4.4 corpus: 97 checks.
 *
 * Each entry is [automation tier, remediation class, detector ids].
 *
 *   automated - machine-verifiable end to end; detectors fully satisfy "Done when".
 *   assisted  - engine gathers evidence and proposes; a human confirms.
 *   attested  - governance no crawler can verify; human attestation only.
 *
 * The remediation class answers "what would fixing this take?" and feeds the
 * rebuild-vs-adjust verdict: only `structural` and `platform` debt is unreachable
 * without changing the architecture of the site.
 *
 * THIS TABLE REQUIRES SIGN-OFF. Misclassifying a row either overpromises
 * automation or wastes a detector, and everything downstream keys off it.
 *
 * Signed off 2026-09-04 against corpus v4.4, all 97 rows.
 *
 * The rule applied: a row is `automated` only when its "Done when" can close
 * on observation alone. Where the text requires a person to record a decision,
 * an owner or an exception, the row is `assisted` however mechanical the
 * evidence-gathering is. That moved nine rows out of `automated` (2.11, 3.10,
 * 4.2, 4.5, 4.6, 5.5, 6.3, 6.8, 7.10). Wording like "agreed budget" or
 * "approved baseline" was read as naming an input to the check, not an
 * artifact a human must produce, so those rows stayed `automated`.
 *
 * Amended 2026-09-11, signed off by the maintainer: 3.11 moved to `assisted`
 * under the same rule. Its "Done when" asks that media alternatives are
 * *accurate* and content understandable, which is a person reading the page;
 * markup shows only that the alternatives exist. No audit had graded 3.11
 * before the change — its detector did not exist — so no delivered verdict
 * moves with it.
 *
 * Amended 2026-09-11, signed off by the maintainer: 3.9 moved to `assisted`
 * under the same rule. Its "Done when" asks that content *answers* its query,
 * that claims *needing* support carry sources, and that bylines and dates
 * appear where readers would *reasonably expect* them — three editorial
 * judgements, where markup shows only that headings, bylines and dates exist.
 * Neither of its detectors existed before the change, so no verdict moves.
 *
 * Tiers claim what CAN be automated, not what is built: 41 automated rows are
 * not yet fully coverable by the probe registry. That gap belongs to the
 * detector roadmap, not to this table.
 */
import type { AutomationTier, RemediationClass } from '../packages/core/src/check.ts';

/** [automation tier, remediation class, detector ids] for one check. */
export type TriageEntry = readonly [AutomationTier, RemediationClass, readonly string[]];

export type TriageTable = Readonly<Record<string, TriageEntry>>;

const V4_4: TriageTable = {
  // -- Phase 0: discovery and strategy. Decisions, not site state. ---------
  '0.1': ['assisted', 'config', ['competitor-serp-baseline']],
  '0.2': ['assisted', 'content', ['keyword-intent-map']],
  '0.3': ['assisted', 'config', ['url-inventory-builder']],
  '0.4': ['attested', 'config', []],
  '0.5': ['assisted', 'content', ['brand-entity-consistency']],
  '0.6': ['attested', 'config', []],
  '0.7': ['attested', 'config', []],
  '0.8': ['assisted', 'config', ['migration-map-builder']],
  '0.9': ['attested', 'config', []],

  // -- Phase 1: day-1 architecture. The foundational layer. ---------------
  '1.1': ['automated', 'structural', ['raw-rendered-parity', 'rendering-strategy-classifier']],
  '1.2': ['automated', 'structural', ['semantic-html', 'crawlable-links', 'heading-outline']],
  '1.3': ['automated', 'config', ['canonicalization', 'url-convention', 'host-slash-policy']],
  '1.4': ['automated', 'code', ['http-status', 'soft-404', 'redirect-chain', 'internal-search-indexability']],
  '1.5': ['automated', 'code', ['lab-perf-budget', 'lcp-element-strategy']],
  '1.6': ['automated', 'config', ['https-enforcement', 'mixed-content', 'host-redirect']],
  '1.7': ['automated', 'config', ['security-headers', 'http-version', 'compression-cache', 'third-party-budget']],
  '1.8': ['assisted', 'config', ['staging-protection']],
  '1.9': ['automated', 'code', ['responsive-media', 'image-dimensions', 'lcp-not-lazy', 'media-alternatives']],
  '1.10': ['assisted', 'config', ['ci-seo-guards']],
  '1.11': ['assisted', 'config', ['ci-extended-checks']],
  '1.12': ['automated', 'structural', ['faceted-nav-control', 'parameter-crawl-space']],
  '1.13': ['automated', 'structural', ['pagination-crawl-path']],
  '1.14': ['automated', 'config', ['hreflang-implementation', 'locale-canonical', 'lang-attribute']],
  '1.15': ['automated', 'structural', ['product-variant-canonical', 'product-lifecycle-state']],
  '1.16': ['automated', 'config', ['x-robots-tag-non-html']],
  '1.17': ['attested', 'config', []],
  '1.18': ['automated', 'config', ['domain-expiry-rdap']],
  '1.19': ['assisted', 'config', ['experiment-cloaking-divergence']],

  // -- Phase 2: pre-launch configuration. ---------------------------------
  '2.1': ['automated', 'config', ['sitemap-validity', 'robots-txt', 'index-bloat', 'sitemap-canonical-agreement']],
  '2.2': ['automated', 'content', ['image-alt-quality']],
  '2.3': ['assisted', 'content', ['image-discoverability']],
  '2.4': ['assisted', 'config', ['gsc-property-ownership']],
  '2.5': ['assisted', 'config', ['analytics-implementation']],
  '2.6': ['assisted', 'config', ['consent-mode-config']],
  '2.7': ['automated', 'code', ['schema-eligibility-matrix']],
  '2.8': ['automated', 'config', ['social-metadata']],
  '2.9': ['automated', 'config', ['ai-crawler-directive-verify']],
  '2.10': ['assisted', 'config', ['indexnow-integration']],
  '2.11': ['assisted', 'code', ['product-schema', 'merchant-feed-parity', 'review-integrity']],
  '2.12': ['assisted', 'config', ['gbp-setup']],
  '2.13': ['automated', 'config', ['favicon-site-name']],
  '2.14': ['automated', 'code', ['video-watch-page', 'videoobject-schema', 'video-sitemap']],
  '2.15': ['assisted', 'structural', ['paywall-access-model']],
  '2.16': ['assisted', 'content', ['publisher-discover-readiness']],
  '2.17': ['automated', 'code', ['breadcrumb-navigation', 'breadcrumblist-schema']],

  // -- Phase 3: content and trust. ----------------------------------------
  '3.1': ['automated', 'content', ['title-uniqueness', 'primary-heading']],
  '3.2': ['automated', 'content', ['meta-description']],
  '3.3': ['automated', 'content', ['internal-linking', 'click-depth', 'orphan-pages']],
  '3.4': ['assisted', 'content', ['trust-pages-presence']],
  '3.5': ['assisted', 'content', ['content-helpfulness']],
  '3.6': ['attested', 'content', []],
  '3.7': ['assisted', 'content', ['launch-content-completeness']],
  '3.8': ['attested', 'content', []],
  '3.9': ['assisted', 'content', ['answer-first-structure', 'author-date-signals']],
  '3.10': ['assisted', 'content', ['cannibalization']],
  '3.11': ['assisted', 'content', ['content-accessibility']],
  '3.12': ['assisted', 'content', ['locale-content-parity']],
  '3.13': ['assisted', 'content', ['ugc-governance', 'outbound-link-qualification']],

  // -- Phase 4: pre-launch QA. Crawl-driven, so largely automatable. -------
  '4.1': ['automated', 'code', ['raw-rendered-crawl-diff', 'broken-links', 'metadata-completeness']],
  '4.2': ['assisted', 'config', ['indexability-matrix-reconciliation']],
  '4.3': ['assisted', 'code', ['mobile-journey-qa']],
  '4.4': ['assisted', 'code', ['axe-accessibility', 'manual-a11y-evaluation']],
  '4.5': ['assisted', 'code', ['template-lab-perf']],
  '4.6': ['assisted', 'code', ['schema-validation-parity']],
  '4.7': ['assisted', 'config', ['analytics-consent-matrix']],
  '4.8': ['assisted', 'config', ['migration-redirect-test', 'content-parity-diff']],
  '4.9': ['automated', 'config', ['hreflang-cluster-qa']],
  '4.10': ['assisted', 'code', ['product-checkout-qa']],
  '4.11': ['automated', 'config', ['prelaunch-baseline-snapshot']],
  '4.12': ['attested', 'config', []],

  // -- Phase 5: launch day. -----------------------------------------------
  '5.1': ['automated', 'config', ['production-smoke-test']],
  '5.2': ['automated', 'config', ['migration-redirects-live']],
  '5.3': ['automated', 'config', ['production-crawl-verify']],
  '5.4': ['automated', 'config', ['sitemap-submit', 'url-inspection']],
  '5.5': ['assisted', 'config', ['availability-canary', 'indexability-canary']],
  '5.6': ['assisted', 'config', ['live-analytics-smoke']],
  '5.7': ['attested', 'config', []],
  '5.8': ['assisted', 'config', ['bing-onboarding']],

  // -- Phase 6: first 30 days. Largely Search Console driven. -------------
  '6.1': ['automated', 'config', ['indexation-review']],
  '6.2': ['automated', 'code', ['field-cwv-monitor']],
  '6.3': ['assisted', 'config', ['reporting-anomaly-thresholds']],
  '6.4': ['automated', 'content', ['ai-visibility-baseline']],
  '6.5': ['automated', 'config', ['security-manual-actions']],
  '6.6': ['automated', 'config', ['post-migration-monitor']],
  '6.7': ['assisted', 'config', ['analytics-reconciliation']],
  '6.8': ['assisted', 'config', ['backlink-monitor']],
  '6.9': ['automated', 'config', ['conditional-template-monitor']],

  // -- Phase 7: ongoing. The retainer engine. -----------------------------
  '7.1': ['assisted', 'config', ['monitoring-incident-sla']],
  '7.2': ['automated', 'content', ['content-decay']],
  '7.3': ['automated', 'config', ['quarterly-regression-crawl']],
  '7.4': ['assisted', 'config', ['release-regression-review']],
  '7.5': ['assisted', 'content', ['digital-pr-tracking']],
  '7.6': ['assisted', 'content', ['offpage-reputation-governance']],
  '7.7': ['assisted', 'code', ['a11y-regression-sampling']],
  '7.8': ['assisted', 'config', ['log-file-analysis']],
  '7.9': ['automated', 'config', ['schema-hreflang-maintenance']],
  '7.10': ['assisted', 'config', ['security-dependency-maintenance']],
};

/**
 * Automation triage for the v5.0 corpus: 98 checks.
 *
 * Signed off 2026-09-14 by the maintainer, all 98 rows. Every row was re-read
 * against its v5.0 "Done when". A row not listed below reads the same under
 * v5.0 as it did under v4.4 — its wording may have moved, but not in a way
 * that changes who can close it — and inherits its v4.4 entry.
 *
 * The rule is v4.4's, applied to the new wording: `automated` only when the
 * "Done when" closes on observation alone. v5.0 rewrote 71 of those criteria,
 * and most rewrites add a record a person produces as part of completing the
 * check — an owner for an unavailable measurement, a reason for an ineligible
 * case, a review of a retained duplicate, an assessment of an external chain.
 * Where the check itself asks for that record, it is `assisted`; where the
 * wording names a decision taken elsewhere ("the approved matrix", "the chosen
 * fallback"), that is an input and the tier stands. Fifteen rows move from
 * `automated` to `assisted` on that reading: automated checks 41 to 26.
 *
 * Detectors follow the requirement, not the id. v5.0 gave 3.9 a new meaning
 * (batch and AI-generated publishing), and the authorship-and-dates subject
 * the two content detectors read moved into 3.5; review integrity moved from
 * 2.11 to 3.13.
 */
const V5_0: TriageTable = {
  ...V4_4,

  // -- Tier moves: the v5.0 "Done when" asks a person for a record. ------
  // "Retained 200 duplicates have a justified canonical policy"; "external
  // chains are assessed by impact".
  '1.3': ['assisted', 'config', ['canonicalization', 'url-convention', 'host-slash-policy']],
  // "Missing resources return genuine errors with useful UX" is a reader's call.
  '1.4': ['assisted', 'code', ['http-status', 'soft-404', 'redirect-chain', 'internal-search-indexability']],
  // A versioned policy names thresholds and owners; overruns carry an owner and
  // date. Crawler byte limits are a new, observable part of the same check.
  '1.5': ['assisted', 'code', ['lab-perf-budget', 'lcp-element-strategy', 'crawler-fetch-limit']],
  // "Any retained duplicate or unavoidable external chain has reviewed evidence".
  '1.6': ['assisted', 'config', ['https-enforcement', 'mixed-content', 'host-redirect']],
  // Owners, testable policies, and absent layers "explicitly recorded"; private
  // responses must not be shared across users, which a crawl can partly see.
  '1.7': ['assisted', 'config', ['security-headers', 'http-version', 'compression-cache', 'third-party-budget', 'private-response-caching']],
  // The matrix "records ... recommended-property decisions".
  '2.7': ['assisted', 'code', ['schema-eligibility-matrix']],
  // Unobserved behaviour carries "an owner/follow-up", and identity-verified
  // requests come from trusted logs; a crawl can only simulate a user agent.
  '2.9': ['assisted', 'config', ['ai-crawler-directive-verify']],
  // An unobserved organic crawl is recorded "with an owner and first-week follow-up".
  '5.1': ['assisted', 'config', ['production-smoke-test']],
  // "Ineligible cases have a recorded reason."
  '5.2': ['assisted', 'config', ['migration-redirects-live']],
  // Submission is "explicitly pending with an owner and next action".
  '5.4': ['assisted', 'config', ['sitemap-submit', 'url-inspection']],
  // Blockers have "investigation, fix and retest owners".
  '6.1': ['assisted', 'config', ['indexation-review']],
  // Missing metrics carry "an owner and next review"; regressions "action owners".
  '6.2': ['assisted', 'code', ['field-cwv-monitor']],
  // "Required reports were actually reviewed ... actions/escalation are recorded."
  '6.5': ['assisted', 'config', ['security-manual-actions']],
  // "Owned regression tickets exist."
  '7.3': ['assisted', 'config', ['quarterly-regression-crawl']],
  // Defects "retained as open actions with owners"; markup retired "deliberately".
  '7.9': ['assisted', 'config', ['schema-hreflang-maintenance']],

  // -- Subjects that moved between checks. -------------------------------
  // Old 3.9's authorship and dates now sit in "Authorship and dates are
  // accurate where needed", and its clear answers in "serves its stated
  // purpose clearly".
  '3.5': ['assisted', 'content', ['content-helpfulness', 'answer-first-structure', 'author-date-signals']],
  // New meaning: an inventory of a publishing batch, its sampled defects and a
  // release safeguard. A crawl can surface a batch's near-identical pages; which
  // of them may be released is the reviewer's decision.
  '3.9': ['assisted', 'content', ['batch-page-quality']],
  // "Review authenticity and destination rules are recorded under 3.13/7.6."
  '2.11': ['assisted', 'code', ['product-schema', 'merchant-feed-parity']],
  '3.13': ['assisted', 'content', ['ugc-governance', 'outbound-link-qualification', 'review-integrity']],
  // Migration discovery now covers a domain's history, not only a URL move.
  '0.8': ['assisted', 'config', ['migration-map-builder', 'inherited-domain-history']],

  // -- New in v5.0. -------------------------------------------------------
  // A news-policy review is a person's; the feed and article templates are not.
  '2.18': ['assisted', 'code', ['news-sitemap', 'news-article-policy']],
};

const TABLES: Readonly<Record<string, TriageTable>> = { '4.4': V4_4, '5.0': V5_0 };

/** The triage table for a corpus version, or undefined when none exists. */
export function triageFor(version: string): TriageTable | undefined {
  return TABLES[version];
}
