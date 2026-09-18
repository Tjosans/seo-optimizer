/**
 * Site input validation, shared by `POST /sites` and `PATCH /sites/:id`.
 *
 * Same discipline as `parseReleaseFile` (@seo/grader): nothing is guessed. An
 * unknown field or a value of the wrong type is refused rather than silently
 * dropped or coerced, so a typo never ends up stored as a blank. A create
 * requires `name` and `origin`; an update may touch any subset of the same
 * fields, which is why every field here is optional and presence — not
 * truthiness — is what decides whether a column changes.
 */

import { parseAiCrawlerPolicy } from '@seo/core';
import type { AiCrawlerPolicy } from '@seo/core';
import { profileEnum } from '@seo/db';

/** A create or update body that is not a valid site write. Every problem is listed, by field. */
export class SiteInputError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`invalid site:\n  ${problems.join('\n  ')}`);
    this.name = 'SiteInputError';
  }
}

const PROFILES = new Set<string>(profileEnum.enumValues);

export interface SiteWrite {
  readonly name?: string;
  readonly origin?: string;
  readonly flags?: string[];
  readonly profile?: 'core' | 'extended';
  readonly aiPolicy?: AiCrawlerPolicy | null;
  readonly profileCorpusVersion?: string | null;
}

type Record_ = Record<string, unknown>;

const isRecord = (value: unknown): value is Record_ =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const ALLOWED = ['name', 'origin', 'flags', 'profile', 'aiPolicy', 'profileCorpusVersion'] as const;

/**
 * Validate a create or update body. `requireCore` demands `name` and
 * `origin` (a create); an update (`requireCore: false`) accepts any subset,
 * including an empty one — the caller decides whether that is worth an error.
 *
 * `origin` is trimmed and stripped of a trailing slash, the same
 * normalization `parseReleaseFile` applies to the site it names, so the two
 * doors cannot disagree about what origin a site was declared under.
 */
export function parseSiteInput(value: unknown, requireCore: boolean): SiteWrite {
  const problems: string[] = [];
  const problem = (path: string, text: string) => problems.push(`${path}: ${text}`);

  if (!isRecord(value)) {
    throw new SiteInputError(['body: expected a mapping']);
  }
  for (const key of Object.keys(value)) {
    if (!(ALLOWED as readonly string[]).includes(key)) problem(key, 'unknown field');
  }

  const out: { -readonly [K in keyof SiteWrite]: SiteWrite[K] } = {};

  if ('name' in value) {
    const name = value['name'];
    if (typeof name !== 'string' || name.trim() === '') problem('name', 'expected non-empty text');
    else out.name = name;
  } else if (requireCore) {
    problem('name', 'required');
  }

  if ('origin' in value) {
    const origin = value['origin'];
    if (typeof origin !== 'string' || origin.trim() === '') {
      problem('origin', 'expected non-empty text');
    } else {
      out.origin = origin.trim().replace(/\/+$/, '');
    }
  } else if (requireCore) {
    problem('origin', 'required');
  }

  if ('flags' in value) {
    const flags = value['flags'];
    if (!Array.isArray(flags) || flags.some((f) => typeof f !== 'string' || f.trim() === '')) {
      problem('flags', 'expected an array of non-empty text');
    } else {
      out.flags = flags as string[];
    }
  }

  if ('profile' in value) {
    const profile = value['profile'];
    if (typeof profile !== 'string' || !PROFILES.has(profile)) {
      problem('profile', `expected one of ${[...PROFILES].join(', ')}`);
    } else {
      out.profile = profile as 'core' | 'extended';
    }
  }

  if ('aiPolicy' in value) {
    try {
      out.aiPolicy = parseAiCrawlerPolicy(value['aiPolicy']);
    } catch (error) {
      problem('aiPolicy', error instanceof Error ? error.message : 'invalid');
    }
  }

  if ('profileCorpusVersion' in value) {
    const version = value['profileCorpusVersion'];
    if (version !== null && (typeof version !== 'string' || version.trim() === '')) {
      problem('profileCorpusVersion', 'expected text or null');
    } else {
      out.profileCorpusVersion = version;
    }
  }

  if (problems.length > 0) throw new SiteInputError(problems);
  return out;
}
