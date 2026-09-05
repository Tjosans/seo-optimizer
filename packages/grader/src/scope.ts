/**
 * Is this check in scope for this site?
 *
 * The corpus states scope as a rule over site-profile flags: a check applies
 * either universally or to a site holding at least one of the flags it names.
 * The flags themselves live on the `sites` row, put there by a person who knows
 * what was built.
 *
 * The one place this gets delicate is a flag that is absent. On a site whose
 * profile has been filled in, an absent flag is a statement — "this is not a
 * multilingual site" — and narrowing the check to `no` with that rationale is
 * the honest reading. On a site with no flags at all, nothing has been stated:
 * treating silence as "none of these apply" would quietly clear thirty-nine
 * conditional checks, several of them launch gates, on the strength of a form
 * nobody filled in. So an empty profile leaves conditional checks at `review`,
 * which is what holds a launch until someone decides.
 */

import type { Applicability, Check } from '@seo/core';

export interface ScopeDecision {
  readonly applicability: Applicability;
  /** Recorded whenever scope is narrowed; the schema refuses `no` without it. */
  readonly rationale: string | null;
}

export function resolveScope(check: Check, flags: readonly string[]): ScopeDecision {
  if (check.applicability.universal) return { applicability: 'yes', rationale: null };

  const held = new Set(flags);
  const matched = check.applicability.any.filter((flag) => held.has(flag));
  if (matched.length > 0) return { applicability: 'yes', rationale: null };

  const wanted = check.applicability.any.join(', ');
  if (flags.length === 0) {
    return {
      applicability: 'review',
      rationale: null,
    };
  }

  return {
    applicability: 'no',
    rationale:
      `the check applies to sites flagged ${wanted}; this site's profile ` +
      `declares ${flags.join(', ')}`,
  };
}
