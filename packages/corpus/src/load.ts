import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type {
  AutomationTier,
  Check,
  Corpus,
  LifecyclePhase,
  Priority,
  Profile,
  RemediationClass,
  Role,
  SourceRef,
} from '@seo/core';

/** A structural problem in the corpus itself, reported with its check id. */
export class CorpusError extends Error {
  constructor(readonly checkId: string, message: string) {
    super(`corpus check ${checkId}: ${message}`);
    this.name = 'CorpusError';
  }
}

const PRIORITIES = new Set<Priority>(['P0', 'P1', 'P2']);
const PROFILES = new Set<Profile>(['core', 'extended']);
const TIERS = new Set<AutomationTier>(['automated', 'assisted', 'attested']);
const CLASSES = new Set<RemediationClass>([
  'config', 'content', 'code', 'structural', 'platform',
]);

function req(raw: Record<string, unknown>, key: string, id: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CorpusError(id, `missing required string field "${key}"`);
  }
  return value;
}

function toCheck(raw: Record<string, unknown>): Check {
  const id = typeof raw['id'] === 'string' ? raw['id'] : '<unknown>';

  const phase = raw['phase'];
  if (typeof phase !== 'number' || phase < 0 || phase > 7) {
    throw new CorpusError(id, `phase must be 0-7, got ${String(phase)}`);
  }

  const priority = raw['priority'] as Priority;
  if (!PRIORITIES.has(priority)) {
    throw new CorpusError(id, `unknown priority "${String(priority)}"`);
  }

  const profile = raw['profile'] as Profile;
  if (!PROFILES.has(profile)) {
    throw new CorpusError(id, `unknown profile "${String(profile)}"`);
  }

  const automation = raw['automation'] as AutomationTier;
  if (!TIERS.has(automation)) {
    throw new CorpusError(id, `unknown automation tier "${String(automation)}"`);
  }

  const remediationClass = raw['remediationClass'] as RemediationClass;
  if (!CLASSES.has(remediationClass)) {
    throw new CorpusError(id, `unknown remediation class "${String(remediationClass)}"`);
  }

  const applicability = raw['applicability'] as
    | { universal?: unknown; any?: unknown; source?: unknown }
    | undefined;
  if (!applicability || typeof applicability.universal !== 'boolean') {
    throw new CorpusError(id, 'applicability.universal must be a boolean');
  }
  const anyFlags = Array.isArray(applicability.any)
    ? (applicability.any as string[])
    : [];
  if (!applicability.universal && anyFlags.length === 0) {
    throw new CorpusError(
      id,
      'a non-universal check must list at least one applicability flag, ' +
        'otherwise it can never come into scope',
    );
  }
  if (anyFlags.includes('UNMAPPED')) {
    throw new CorpusError(id, 'applicability was not mapped by the compiler');
  }

  const detectors = Array.isArray(raw['detectors'])
    ? (raw['detectors'] as string[])
    : [];

  // The corpus contract: an attested check has no detectors, because nothing
  // can verify it mechanically; every other tier must bind at least one.
  if (automation === 'attested' && detectors.length > 0) {
    throw new CorpusError(id, 'attested checks must not declare detectors');
  }
  if (automation !== 'attested' && detectors.length === 0) {
    throw new CorpusError(id, `${automation} checks must declare at least one detector`);
  }

  const cadence = (raw['cadence'] ?? {}) as Record<string, unknown>;
  const sources = Array.isArray(raw['sources'])
    ? (raw['sources'] as SourceRef[])
    : [];

  return {
    id,
    phase: phase as LifecyclePhase,
    phaseLabel: req(raw, 'phaseLabel', id),
    priority,
    profile,
    launchGate: raw['launchGate'] === true,
    applicability: {
      universal: applicability.universal,
      any: anyFlags,
      source: typeof applicability.source === 'string' ? applicability.source : '',
    },
    task: req(raw, 'task', id),
    whatToDo: req(raw, 'whatToDo', id),
    doneWhen: req(raw, 'doneWhen', id),
    owners: (Array.isArray(raw['owners']) ? raw['owners'] : []) as Role[],
    ownerSource: typeof raw['ownerSource'] === 'string' ? raw['ownerSource'] : '',
    tools: typeof raw['tools'] === 'string' ? raw['tools'] : '',
    cadence: {
      triggers: (Array.isArray(cadence['triggers']) ? cadence['triggers'] : []) as string[],
      ...(typeof cadence['interval'] === 'string'
        ? { interval: cadence['interval'] as never }
        : {}),
      ...(typeof cadence['windowDays'] === 'number'
        ? { windowDays: cadence['windowDays'] }
        : {}),
      source: typeof cadence['source'] === 'string' ? cadence['source'] : '',
    },
    notes: typeof raw['notes'] === 'string' ? raw['notes'] : '',
    automation,
    remediationClass,
    detectors,
    sources,
  };
}

/**
 * Load and validate a compiled corpus from disk.
 *
 * Throws on any structural defect rather than degrading, so a malformed corpus
 * can never silently produce a score. Callers should treat a throw here as a
 * build failure.
 */
export function loadCorpus(dir: string): Corpus {
  const manifest = parse(readFileSync(join(dir, 'manifest.yaml'), 'utf8')) as {
    version: string;
    reviewed: string;
    checkCount: number;
  };

  const checks: Check[] = [];
  const files = readdirSync(dir)
    .filter((f) => /^phase-\d+\.yaml$/.test(f))
    .sort();

  for (const file of files) {
    const parsed = parse(readFileSync(join(dir, file), 'utf8'));
    if (!Array.isArray(parsed)) {
      throw new Error(`corpus file ${file} must contain a list of checks`);
    }
    for (const raw of parsed) {
      checks.push(toCheck(raw as Record<string, unknown>));
    }
  }

  const seen = new Set<string>();
  for (const check of checks) {
    if (seen.has(check.id)) {
      throw new CorpusError(check.id, 'duplicate check id');
    }
    seen.add(check.id);
  }

  if (checks.length !== manifest.checkCount) {
    throw new Error(
      `corpus manifest declares ${manifest.checkCount} checks but ${checks.length} were loaded`,
    );
  }

  return { version: manifest.version, reviewed: manifest.reviewed, checks };
}
