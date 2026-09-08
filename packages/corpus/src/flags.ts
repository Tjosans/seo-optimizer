/**
 * Which site-profile flags a corpus actually recognises.
 *
 * Scope is stated as a rule over flags: a check applies universally, or to a
 * site holding at least one of the flags it names. The flags themselves are
 * free text on the `sites` row, put there by a person.
 *
 * That is a quiet hazard, because of how `resolveScope` reads a filled-in
 * profile. A site with flags has made a statement, so a check whose flags none
 * of them match is narrowed to `no` — *with a rationale that reads as
 * deliberate*. Someone who types `ecommmerce` therefore does not get an error.
 * They get launch gates excluded from their audit, each one explaining
 * confidently that the site is not an e-commerce site.
 *
 * So the flags are checked against the corpus before an audit runs. It is the
 * corpus that decides what a flag means, which is why this lives here and not
 * on the `sites` table: a flag no check names today may be named by the next
 * version, and pinning the vocabulary in a Postgres enum would make every
 * corpus revision a migration.
 */

import type { Corpus } from '@seo/core';

/** Every flag any check in this corpus can be brought into scope by. */
export function knownFlags(corpus: Corpus): ReadonlySet<string> {
  const flags = new Set<string>();
  for (const check of corpus.checks) {
    for (const flag of check.applicability.any) flags.add(flag);
  }
  return flags;
}

/**
 * The flags this corpus has never heard of, in the order given.
 *
 * Empty is the good answer. A non-empty result means the site profile says
 * something the pinned corpus cannot act on, which is never what the person
 * who typed it intended.
 */
export function unknownFlags(corpus: Corpus, flags: readonly string[]): readonly string[] {
  const known = knownFlags(corpus);
  return flags.filter((flag) => !known.has(flag));
}
