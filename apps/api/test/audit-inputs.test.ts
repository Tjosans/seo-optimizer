/** `inputs` on `POST /audits` follows `parseInputs`' rules (no database needed). */

import { describe, expect, it } from 'vitest';
import { AuditInputError, parseAuditRequest } from '../src/audits.js';

const BASE = { siteId: 's', corpusVersion: '5.0' };

describe('parseAuditRequest inputs', () => {
  it('passes parsed inputs through', () => {
    expect(parseAuditRequest({ ...BASE, inputs: {} }).inputs).toEqual({});
  });

  it('leaves inputs absent when none are given', () => {
    expect('inputs' in parseAuditRequest(BASE)).toBe(false);
  });

  it('refuses an unknown section, naming it', () => {
    expect(() => parseAuditRequest({ ...BASE, inputs: { nope: {} } })).toThrow(AuditInputError);
    try {
      parseAuditRequest({ ...BASE, inputs: { nope: {} } });
    } catch (error) {
      expect((error as AuditInputError).problems).toContain('inputs.nope: unknown section');
    }
  });

  it('refuses inputs that are not a mapping', () => {
    expect(() => parseAuditRequest({ ...BASE, inputs: [] })).toThrow(AuditInputError);
  });
});
