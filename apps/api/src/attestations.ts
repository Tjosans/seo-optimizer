/**
 * Attestation request validation, for `POST /audits/:id/attestations`.
 *
 * Same discipline as `parseAuditRequest` and `parseSiteInput`: an unknown
 * field or a value of the wrong type is refused rather than silently
 * dropped or coerced. `checkId`, `attestedBy`, `statement`, `expiresAt` and
 * `status` are required; whether the check id is one the pinned corpus
 * actually holds, and whether the expiry date is in the future, is
 * `recordAttestation`'s (@seo/grader) to say — both need the corpus and the
 * clock, neither of which this layer has an opinion about.
 */

import { checkStatusEnum } from '@seo/db';
import type { AttestationInput } from '@seo/grader';

/** A request body that is not a valid attestation. Every problem is listed, by field. */
export class AttestationInputError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`invalid attestation:\n  ${problems.join('\n  ')}`);
    this.name = 'AttestationInputError';
  }
}

type Record_ = Record<string, unknown>;

const isRecord = (value: unknown): value is Record_ =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const ALLOWED = [
  'checkId',
  'attestedBy',
  'statement',
  'expiresAt',
  'status',
  'applicability',
  'applicabilityRationale',
] as const;

const STATUSES = new Set<string>(checkStatusEnum.enumValues);
const APPLICABILITIES = new Set(['yes', 'no', 'review']);

export function parseAttestationInput(value: unknown): AttestationInput {
  const problems: string[] = [];
  const problem = (path: string, text: string) => problems.push(`${path}: ${text}`);

  if (!isRecord(value)) {
    throw new AttestationInputError(['body: expected a mapping']);
  }
  for (const key of Object.keys(value)) {
    if (!(ALLOWED as readonly string[]).includes(key)) problem(key, 'unknown field');
  }

  let checkId: string | undefined;
  if ('checkId' in value) {
    const raw = value['checkId'];
    if (typeof raw !== 'string' || raw.trim() === '') problem('checkId', 'expected non-empty text');
    else checkId = raw;
  } else {
    problem('checkId', 'required');
  }

  let attestedBy: string | undefined;
  if ('attestedBy' in value) {
    const raw = value['attestedBy'];
    if (typeof raw !== 'string' || raw.trim() === '') problem('attestedBy', 'expected non-empty text');
    else attestedBy = raw;
  } else {
    problem('attestedBy', 'required');
  }

  let statement: string | undefined;
  if ('statement' in value) {
    const raw = value['statement'];
    if (typeof raw !== 'string' || raw.trim() === '') problem('statement', 'expected non-empty text');
    else statement = raw;
  } else {
    problem('statement', 'required');
  }

  let expiresAt: string | undefined;
  if ('expiresAt' in value) {
    const raw = value['expiresAt'];
    if (typeof raw !== 'string' || raw.trim() === '') problem('expiresAt', 'expected non-empty text');
    else expiresAt = raw;
  } else {
    problem('expiresAt', 'required');
  }

  let status: AttestationInput['status'] | undefined;
  if ('status' in value) {
    const raw = value['status'];
    if (typeof raw !== 'string' || !STATUSES.has(raw)) {
      problem('status', `expected one of ${[...STATUSES].join(', ')}`);
    } else {
      status = raw as AttestationInput['status'];
    }
  } else {
    problem('status', 'required');
  }

  let applicability: AttestationInput['applicability'];
  if ('applicability' in value) {
    const raw = value['applicability'];
    if (typeof raw !== 'string' || !APPLICABILITIES.has(raw)) {
      problem('applicability', 'expected one of yes, no, review');
    } else {
      applicability = raw as AttestationInput['applicability'];
    }
  }

  let applicabilityRationale: string | undefined;
  if ('applicabilityRationale' in value) {
    const raw = value['applicabilityRationale'];
    if (typeof raw !== 'string' || raw.trim() === '') {
      problem('applicabilityRationale', 'expected non-empty text');
    } else {
      applicabilityRationale = raw;
    }
  }

  if (problems.length > 0) throw new AttestationInputError(problems);

  return {
    checkId: checkId!,
    attestedBy: attestedBy!,
    statement: statement!,
    expiresAt: expiresAt!,
    status: status!,
    ...(applicability !== undefined ? { applicability } : {}),
    ...(applicabilityRationale !== undefined ? { applicabilityRationale } : {}),
  };
}
