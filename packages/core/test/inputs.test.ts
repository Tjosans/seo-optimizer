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

describe('experiments section', () => {
  const entry = {
    owner: 'Jane',
    recordedAt: '2026-09-01T09:00:00Z',
    controlUrl: 'https://example.com/a',
    variantUrls: ['https://example.com/b'],
    method: 'redirect',
    retireBy: '2026-12-01T00:00:00Z',
  };

  it('parses an experiment and normalizes its dates', () => {
    const inputs = parseInputs({ experiments: [entry] });
    expect(inputs.experiments?.[0]?.retireBy).toBe('2026-12-01T00:00:00.000Z');
    expect(inputs.experiments?.[0]?.variantUrls).toEqual(['https://example.com/b']);
  });

  it('refuses a missing field, an empty variant list and a bad date', () => {
    expect(() => parseInputs({ experiments: [{ ...entry, method: undefined }] })).toThrow(/method: required/);
    expect(() => parseInputs({ experiments: [{ ...entry, variantUrls: [] }] })).toThrow(/variantUrls/);
    expect(() => parseInputs({ experiments: [{ ...entry, retireBy: 'later' }] })).toThrow(/not a date/);
    expect(() => parseInputs({ experiments: {} })).toThrow(/expected a list/);
    expect(() => parseInputs({ experiments: [{ ...entry, extra: 1 }] })).toThrow(/unknown field/);
  });
});

describe('environments section', () => {
  const base = { owner: 'Jane', recordedAt: '2026-09-01T09:00:00Z' };

  it('parses origins and reduces them to origins', () => {
    const inputs = parseInputs({ environments: { ...base, staging: 'https://staging.example.com/path', preview: 'http://p.example.com' } });
    expect(inputs.environments?.staging).toBe('https://staging.example.com');
    expect(inputs.environments?.preview).toBe('http://p.example.com');
  });

  it('refuses an empty section, a bad origin and an unknown field', () => {
    expect(() => parseInputs({ environments: base })).toThrow(/at least one/);
    expect(() => parseInputs({ environments: { ...base, staging: 'staging' } })).toThrow(/not an http\(s\) origin/);
    expect(() => parseInputs({ environments: { ...base, staging: 'ftp://x.example.com' } })).toThrow(/not an http\(s\) origin/);
    expect(() => parseInputs({ environments: { ...base, staging: 'https://s.example.com', qa: 'x' } })).toThrow(/unknown field/);
  });
});

describe('parseInputs ciGuard', () => {
  const base = {
    owner: 'Jane',
    recordedAt: '2026-09-01T00:00:00Z',
    build: 'ci-1',
    ranAt: '2026-09-01T00:00:00Z',
    seededDefectsCaught: ['NoIndex', 'canonical'],
    cleanRunPassed: true,
  };

  it('parses a record and lower-cases the defect kinds', () => {
    const { ciGuard } = parseInputs({ ciGuard: base });
    expect(ciGuard?.seededDefectsCaught).toEqual(['noindex', 'canonical']);
    expect(ciGuard?.cleanRunPassed).toBe(true);
  });

  it('refuses a non-boolean cleanRunPassed and a missing build', () => {
    expect(() => parseInputs({ ciGuard: { ...base, cleanRunPassed: 'yes' } })).toThrow(/cleanRunPassed/);
    expect(() => parseInputs({ ciGuard: { ...base, build: undefined } })).toThrow(/ciGuard.build/);
  });
});

describe('urlMatrix', () => {
  const row = {
    pattern: 'https://example.com/products/*',
    priority: true,
    status: 200,
    indexable: true,
    canonical: 'self',
    inSitemap: true,
    access: 'public',
    owner: 'Jane',
    recordedAt: '2026-09-01T09:00:00Z',
  };
  const problemsOf = (rows: unknown): readonly string[] => {
    try {
      parseInputs({ urlMatrix: rows });
      return [];
    } catch (error) {
      return (error as InputsError).problems;
    }
  };

  it('reads a row, with priority and environment optional', () => {
    const { urlMatrix } = parseInputs({
      urlMatrix: [row, { ...row, pattern: '/a/**', priority: undefined, canonical: 'https://example.com/b', environment: ' staging ' }],
    });
    expect(urlMatrix?.[0]).toMatchObject({ pattern: row.pattern, priority: true, status: 200, canonical: 'self', access: 'public' });
    expect(urlMatrix?.[1]).toMatchObject({ canonical: 'https://example.com/b', environment: 'staging' });
    expect(urlMatrix?.[1]).not.toHaveProperty('priority');
  });

  it('refuses what is not a list, and unknown fields', () => {
    expect(problemsOf({})).toEqual(['urlMatrix: expected a list']);
    expect(problemsOf([{ ...row, extra: 1 }])).toEqual(['urlMatrix[0].extra: unknown field']);
  });

  it('lists every bad field by path', () => {
    const problems = problemsOf([
      { ...row, pattern: 'products', status: '200', indexable: 'yes', canonical: 'elsewhere', inSitemap: undefined, access: 'secret', priority: 1 },
    ]);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('urlMatrix[0].pattern'),
        'urlMatrix[0].status: expected an HTTP status code from 100 to 599',
        'urlMatrix[0].indexable: expected true or false',
        expect.stringContaining('urlMatrix[0].canonical'),
        'urlMatrix[0].inSitemap: required',
        expect.stringContaining('urlMatrix[0].access'),
        'urlMatrix[0].priority: expected true or false',
      ]),
    );
  });

  it('refuses a duplicate pattern in one environment, not across environments', () => {
    expect(problemsOf([row, row])).toEqual([expect.stringContaining('duplicate pattern')]);
    expect(problemsOf([row, { ...row, environment: 'staging' }])).toEqual([]);
  });
});

describe('parseInputs canary', () => {
  const base = {
    owner: 'Jane',
    recordedAt: '2026-09-01T00:00:00Z',
    urls: ['https://example.com/'],
    targetMinutes: 5,
    recipient: 'oncall@example.com',
    lastTestAlertAt: '2026-09-10T08:00:00Z',
    deliveredAt: '2026-09-10T08:03:00Z',
  };

  it('parses a record, with the alert times optional', () => {
    expect(parseInputs({ canary: base }).canary?.deliveredAt).toBe('2026-09-10T08:03:00.000Z');
    const { canary } = parseInputs({ canary: { ...base, lastTestAlertAt: undefined, deliveredAt: undefined } });
    expect(canary?.lastTestAlertAt).toBeUndefined();
  });

  it('refuses no URLs, a bad target and a bad date', () => {
    expect(() => parseInputs({ canary: { ...base, urls: [] } })).toThrow(/canary.urls/);
    expect(() => parseInputs({ canary: { ...base, targetMinutes: 0 } })).toThrow(/targetMinutes/);
    expect(() => parseInputs({ canary: { ...base, deliveredAt: 'soon' } })).toThrow(/deliveredAt/);
  });
});
