/**
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
 * Tiers claim what CAN be automated, not what is built: 42 automated rows are
 * not yet fully coverable by the probe registry. That gap belongs to the
 * detector roadmap, not to this table.
 */
import type { AutomationTier, RemediationClass } from '../packages/core/src/check.ts';

/** [automation tier, remediation class, detector ids] for one check. */
export type TriageEntry = readonly [AutomationTier, RemediationClass, readonly string[]];

export const TRIAGE: Readonly<Record<string, TriageEntry>> = {
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
  '3.9': ['automated', 'content', ['answer-first-structure', 'author-date-signals']],
  '3.10': ['assisted', 'content', ['cannibalization']],
  '3.11': ['automated', 'content', ['content-accessibility']],
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
