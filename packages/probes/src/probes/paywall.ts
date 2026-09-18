/**
 * 2.15's markup half: whether a page that declares itself paywalled says so
 * completely enough for Google to read.
 *
 * The check's `doneWhen` is mostly a policy question — approved indexing,
 * sampling and access model, reader/crawler parity, no private data leaking
 * through page, API or cache. None of that is visible from a raw crawl: it
 * needs a second identity's-worth of requests (an authorized reader, a
 * logged-out client, a verified crawler) that this engine does not make. What
 * a crawl *can* read is the one thing the corpus asks for in markup terms —
 * `isAccessibleForFree` on the gated content, and, where the site marks a
 * partial preview, `cssSelector` on each `hasPart` section — because Google's
 * own paywalled-content guide makes those the required properties. A page
 * that opts into this markup at all is judged on whether it shipped it
 * completely; a page that declares nothing is left alone, the same way
 * `product-schema` leaves `merchant-feed-parity` to a person; here, silence is
 * also what 1.8's "deliberately excluded" gated content looks like from
 * outside.
 */

import type { CrawledPage } from '@seo/crawler';
import type { SiteProbe } from '../types.js';
import { fail, notApplicable, pass } from '../types.js';

const findKey = (node: Record<string, unknown>, name: string): string | undefined =>
  Object.keys(node).find((key) => key.toLowerCase() === name.toLowerCase());

const presentValue = (value: unknown): boolean => {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
};

/** `true`/`false`, `undefined` when absent, `null` when present but not a recognized boolean. */
function accessibleForFree(node: Record<string, unknown>): boolean | null | undefined {
  const key = findKey(node, 'isAccessibleForFree');
  if (key === undefined) return undefined;
  const raw = node[key];
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const word = raw.trim().toLowerCase();
    if (word === 'true') return true;
    if (word === 'false') return false;
  }
  return null;
}

function hasPartEntries(node: Record<string, unknown>): Record<string, unknown>[] {
  const key = findKey(node, 'hasPart');
  if (key === undefined) return [];
  return [node[key]]
    .flat()
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null);
}

/**
 * Every JSON-LD node on the page that opts into paywall markup — declaring
 * `isAccessibleForFree` itself, or naming `hasPart` sections that do — walking
 * `@graph`. The `hasPart`-only case is deliberately included even though the
 * node itself is silent: that silence is the defect this detector names.
 */
function paywallNodes(page: CrawledPage): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const record = value as Record<string, unknown>;
    const opensIn =
      findKey(record, 'isAccessibleForFree') !== undefined || hasPartEntries(record).length > 0;
    if (opensIn) found.push(record);
    if (Array.isArray(record['@graph'])) visit(record['@graph']);
  };
  (page.extracted?.jsonLd ?? []).forEach(visit);
  return found;
}

interface PaywallIssue {
  readonly url: string;
  readonly issue: string;
}

export const paywallAccessModel: SiteProbe = {
  id: 'paywall-access-model',
  scope: 'site',
  title: 'Paywalled pages declare isAccessibleForFree and complete section markup',
  run({ crawl, flags }) {
    if (!flags.includes('paywall')) {
      return notApplicable('Site profile does not claim paywalled or registration-gated publishing.');
    }

    const pages = crawl.pages.filter(
      (page) => page.extracted !== null && page.fetch.status === 200,
    );
    const declared = pages
      .map((page) => ({ page, nodes: paywallNodes(page) }))
      .filter((entry) => entry.nodes.length > 0);

    if (declared.length === 0) {
      // Deliberately excluded gated content (1.8) carries no such markup
      // either, so absence here is not evidence of a defect.
      return notApplicable(
        'No crawled page declares isAccessibleForFree, so paywall access markup is not observable; ' +
          'the site may deliberately exclude gated content from the index (see 1.8).',
      );
    }

    const issues: PaywallIssue[] = [];
    for (const { page, nodes } of declared) {
      const url = page.normalizedUrl;
      for (const node of nodes) {
        const access = accessibleForFree(node);
        if (access === null) {
          issues.push({
            url,
            issue: 'declares isAccessibleForFree with a value that is not a recognized true/false',
          });
        }

        const parts = hasPartEntries(node);
        if (parts.length > 0 && access === undefined) {
          issues.push({
            url,
            issue: 'declares hasPart sections but the page itself has no isAccessibleForFree',
          });
        }
        for (const part of parts) {
          if (!presentValue(part[findKey(part, 'cssSelector') ?? 'cssSelector'])) {
            issues.push({
              url,
              issue: 'a hasPart entry has no cssSelector, so Google cannot map it to page content',
            });
          }
          const partAccess = accessibleForFree(part);
          if (partAccess === undefined) {
            issues.push({
              url,
              issue: 'a hasPart entry has no isAccessibleForFree, so Google cannot tell which side of the gate it is on',
            });
          } else if (partAccess === null) {
            issues.push({
              url,
              issue: 'a hasPart entry declares isAccessibleForFree with a value that is not a recognized true/false',
            });
          }
        }
      }
    }

    const counts = { pagesWithPaywallMarkup: declared.length };

    if (issues.length > 0) {
      return fail(
        `${issues.length} paywall markup defect(s) across ${declared.length} page(s) declaring isAccessibleForFree.`,
        { ...counts, samples: issues.slice(0, 10) },
      );
    }
    return pass(
      `All ${declared.length} page(s) declaring isAccessibleForFree carry complete section markup.`,
      counts,
    );
  },
};

export const paywallProbes = [paywallAccessModel];
