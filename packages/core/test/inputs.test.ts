import { describe, expect, it } from 'vitest';
import { InputsError, inputRecordProblem, parseInputRecord, parseInputs } from '../src/inputs.js';

describe('parseInputs', () => {
  it('reads nothing as no inputs', () => {
    expect(parseInputs(undefined)).toEqual({});
    expect(parseInputs(null)).toEqual({});
    expect(parseInputs({})).toEqual({});
  });

  it('refuses an unknown section and a non-mapping', () => {
    expect(() => parseInputs({ performance: {} })).toThrow(InputsError);
    expect(() => parseInputs([])).toThrow(InputsError);
    expect(() => parseInputs('x')).toThrow(/expected a mapping/);
  });
});

describe('parseInputRecord', () => {
  const run = (node: unknown) => {
    const problems: string[] = [];
    const record = parseInputRecord('r', node, (path, text) => problems.push(`${path}: ${text}`));
    return { record, problems };
  };

  it('normalizes times and keeps a blank owner for the detector to hold', () => {
    const { record, problems } = run({ owner: ' ', recordedAt: '2026-09-01T09:00:00Z' });
    expect(problems).toEqual([]);
    expect(record).toEqual({ owner: '', recordedAt: '2026-09-01T09:00:00.000Z' });
  });

  it('refuses unknown keys, wrong types and bad dates', () => {
    const { record, problems } = run({ owner: 7, recordedAt: 'soon', nextReviewAt: '2027-01-01T00:00:00Z', x: 1 });
    expect(record).toBeNull();
    expect(problems).toHaveLength(3);
  });

  it('requires recordedAt', () => {
    expect(run({ owner: 'a' }).problems).toEqual(['r.recordedAt: required']);
  });
});

describe('inputRecordProblem', () => {
  const at = new Date('2026-09-19T00:00:00Z');
  const base = { owner: 'Jane', recordedAt: '2026-09-01T00:00:00.000Z' };

  it('accepts an owned, current record', () => {
    expect(inputRecordProblem(base, at)).toBeNull();
    expect(inputRecordProblem({ ...base, nextReviewAt: '2027-01-01T00:00:00.000Z' }, at)).toBeNull();
  });

  it('holds a record with no owner or past its review', () => {
    expect(inputRecordProblem({ ...base, owner: '' }, at)).toMatch(/no owner/);
    expect(inputRecordProblem({ ...base, nextReviewAt: '2026-09-10T00:00:00.000Z' }, at)).toMatch(/due/);
  });
});
