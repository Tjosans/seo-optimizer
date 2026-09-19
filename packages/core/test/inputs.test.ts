import { describe, expect, it } from 'vitest';
import { InputsError, inputRecordProblem, parseInputRecord, parseInputs, redirectMapUrls } from '../src/inputs.js';

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

describe('parseInputs redirectMap', () => {
  const base = {
    owner: 'Jane',
    recordedAt: '2026-09-01T00:00:00Z',
    kind: 'move',
    oldOrigin: 'https://old.example.com/',
    entries: [
      { from: '/a', expect: 301, to: 'https://example.com/a' },
      { from: '/gone', expect: 410 },
    ],
  };
  const problemsOf = (redirectMap: unknown): string[] => {
    try {
      parseInputs({ redirectMap });
      return [];
    } catch (error) {
      return [...(error as InputsError).problems];
    }
  };

  it('parses a move, normalising the old origin', () => {
    const { redirectMap } = parseInputs({ redirectMap: base });
    expect(redirectMap?.oldOrigin).toBe('https://old.example.com');
    expect(redirectMap?.entries).toHaveLength(2);
    expect(redirectMap?.entries[1]).toEqual({ from: '/gone', expect: 410 });
  });

  it('allows history-only with no entries', () => {
    expect(parseInputs({ redirectMap: { owner: 'Jane', recordedAt: base.recordedAt, kind: 'history-only' } }).redirectMap?.entries).toEqual([]);
  });

  it('refuses a bad kind, status, target and unknown field', () => {
    expect(problemsOf({ ...base, kind: 'copy' })).toEqual([expect.stringContaining('redirectMap.kind')]);
    expect(problemsOf({ ...base, entries: [{ from: '/a', expect: 302, to: '/b' }] })).toEqual([expect.stringContaining('entries[0].expect')]);
    expect(problemsOf({ ...base, entries: [{ from: '/a', expect: 301 }] })).toEqual([expect.stringContaining('entries[0].to')]);
    expect(problemsOf({ ...base, entries: [{ from: '/a', expect: 404, to: '/b' }] })).toEqual([expect.stringContaining('not allowed')]);
    expect(problemsOf({ ...base, entries: [{ from: '/a', expect: 404, why: 'x' }] })).toEqual([expect.stringContaining('unknown field')]);
    expect(problemsOf({ ...base, oldOrigin: 'ftp://x' })).toEqual([expect.stringContaining('oldOrigin')]);
  });

  it('refuses a duplicate from', () => {
    expect(problemsOf({ ...base, entries: [{ from: '/a', expect: 410 }, { from: '/a', expect: 404 }] })).toEqual([expect.stringContaining('duplicate entry')]);
  });
});

describe('redirectMapUrls', () => {
  const record = { owner: 'a', recordedAt: '2026-09-01', kind: 'move' as const, oldOrigin: 'https://old.example.com', entries: [] };

  it('resolves paths against the old origin, keeps absolute URLs, drops repeats', () => {
    const urls = redirectMapUrls({
      ...record,
      entries: [
        { from: '/a', expect: 410 },
        { from: 'https://other.example.com/b', expect: 404 },
        { from: '/a', expect: 404 },
      ],
    });
    expect(urls).toEqual(['https://old.example.com/a', 'https://other.example.com/b']);
  });

  it('leaves out a path it cannot resolve, and reads no map as none', () => {
    expect(redirectMapUrls({ ...record, oldOrigin: undefined, entries: [{ from: '/a', expect: 410 }] })).toEqual([]);
    expect(redirectMapUrls(undefined)).toEqual([]);
  });
});

describe('searchConsole', () => {
  const base = { owner: 'Jane', recordedAt: '2026-09-01T09:00:00Z' };
  const full = {
    ...base,
    property: { type: 'domain', url: 'sc-domain:example.com', owners: [{ email: 'jane@example.com', verifiedAt: '2026-08-01T09:00:00Z' }] },
    sitemaps: [{ url: 'https://example.com/sitemap.xml', submittedAt: '2026-08-02T09:00:00Z', status: 'Success', errors: 0 }],
    manualActions: [{ type: 'Pure spam', scope: 'partial', detectedAt: '2026-08-10T00:00:00Z' }],
    securityIssues: [],
  };

  it('reads each subsection, normalizing times', () => {
    const sc = parseInputs({ searchConsole: full }).searchConsole;
    expect(sc?.property?.owners[0]?.verifiedAt).toBe('2026-08-01T09:00:00.000Z');
    expect(sc?.sitemaps?.[0]).toMatchObject({ status: 'Success', errors: 0 });
    expect(sc?.manualActions?.[0]).toEqual({ type: 'Pure spam', scope: 'partial', detectedAt: '2026-08-10T00:00:00.000Z' });
  });

  it('tells an empty report from one not supplied', () => {
    const sc = parseInputs({ searchConsole: { ...full, manualActions: undefined } }).searchConsole;
    expect(sc?.manualActions).toBeUndefined();
    expect(sc?.securityIssues).toEqual([]);
  });

  it('refuses what Search Console would not export, listing every path', () => {
    const run = (patch: object) => () => parseInputs({ searchConsole: { ...full, ...patch } });
    expect(run({ extra: 1 })).toThrow(/searchConsole\.extra: unknown field/);
    expect(run({ property: { ...full.property, type: 'host' } })).toThrow(/property\.type: expected domain or url-prefix/);
    expect(run({ property: { type: 'url-prefix', url: 'example.com', owners: [] } })).toThrow(/property\.url: expected an http\(s\) URL/);
    expect(run({ property: { ...full.property, owners: [{ email: 'nope', verifiedAt: '2026-08-01T09:00:00Z' }] } })).toThrow(/not an email address/);
    expect(run({ sitemaps: [{ ...full.sitemaps[0], errors: -1 }] })).toThrow(/sitemaps\[0\]\.errors/);
    expect(run({ sitemaps: [{ ...full.sitemaps[0], errors: '0' }] })).toThrow(/sitemaps\[0\]\.errors/);
    expect(run({ sitemaps: [full.sitemaps[0], full.sitemaps[0]] })).toThrow(/duplicate sitemap/);
    expect(run({ manualActions: [{ type: 'Pure spam', scope: 'some' }] })).toThrow(/manualActions\[0\]\.scope/);
    expect(run({ securityIssues: [{ type: 'Malware', detectedAt: 'yesterday' }] })).toThrow(/securityIssues\[0\]\.detectedAt: not a date/);
    expect(run({ securityIssues: {} })).toThrow(/securityIssues: expected a list/);
  });
});

describe('searchConsole, part two', () => {
  const base = { owner: 'Jane', recordedAt: '2026-09-01T09:00:00Z' };
  const part = {
    ...base,
    pageIndexing: [{ url: 'https://example.com/a', reason: 'Crawled - currently not indexed' }],
    urlInspection: [
      { url: 'https://example.com/', verdict: 'Pass', coverage: 'Submitted and indexed', googleCanonical: 'https://example.com/', robots: 'Allowed', indexing: 'Indexing allowed' },
      { url: 'https://example.com/b', verdict: 'Neutral', coverage: 'Discovered - currently not indexed', robots: 'Allowed', indexing: 'Indexing allowed' },
    ],
    performance: [
      { page: 'https://example.com/', clicks: 10, impressions: 200, period: '2026-06-01/2026-08-31' },
      { page: 'https://example.com/', query: 'shoes', clicks: 3, impressions: 40, period: '2026-06-01/2026-08-31' },
    ],
    links: [{ site: 'news.example.org', count: 12 }],
  };
  const run = (patch: object) => () => parseInputs({ searchConsole: { ...part, ...patch } });

  it('reads each subsection', () => {
    const sc = parseInputs({ searchConsole: part }).searchConsole;
    expect(sc?.pageIndexing).toEqual(part.pageIndexing);
    expect(sc?.urlInspection?.[0]?.googleCanonical).toBe('https://example.com/');
    expect(sc?.urlInspection?.[1]).not.toHaveProperty('googleCanonical');
    expect(sc?.performance?.[0]).not.toHaveProperty('query');
    expect(sc?.performance?.[1]?.query).toBe('shoes');
    expect(sc?.links).toEqual([{ site: 'news.example.org', count: 12 }]);
  });

  it('keeps an empty list as an answer', () => {
    const sc = parseInputs({ searchConsole: { ...base, pageIndexing: [], links: [] } }).searchConsole;
    expect(sc?.pageIndexing).toEqual([]);
    expect(sc?.urlInspection).toBeUndefined();
  });

  it('refuses what an export would not hold, listing every path', () => {
    expect(run({ pageIndexing: [{ url: 'a/b', reason: 'x' }] })).toThrow(/pageIndexing\[0\]\.url: expected an http\(s\) URL/);
    expect(run({ pageIndexing: [{ url: 'https://example.com/a' }] })).toThrow(/pageIndexing\[0\]\.reason: required/);
    expect(run({ pageIndexing: [{ url: 'https://example.com/a', reason: 'x', extra: 1 }] })).toThrow(/pageIndexing\[0\]\.extra: unknown field/);
    expect(run({ urlInspection: [part.urlInspection[0], part.urlInspection[0]] })).toThrow(/duplicate inspection/);
    expect(run({ urlInspection: [{ ...part.urlInspection[0], robots: undefined }] })).toThrow(/urlInspection\[0\]\.robots: required/);
    expect(run({ urlInspection: [{ ...part.urlInspection[0], googleCanonical: 'none' }] })).toThrow(/googleCanonical: expected an http/);
    expect(run({ performance: [{ ...part.performance[0], clicks: -1 }] })).toThrow(/performance\[0\]\.clicks/);
    expect(run({ performance: [{ ...part.performance[0], impressions: '5' }] })).toThrow(/performance\[0\]\.impressions/);
    expect(run({ performance: [{ ...part.performance[0], clicks: 500 }] })).toThrow(/more clicks than impressions/);
    expect(run({ performance: [part.performance[0], part.performance[0]] })).toThrow(/duplicate row/);
    expect(run({ links: [{ site: 'a.org', count: 1.5 }] })).toThrow(/links\[0\]\.count/);
    expect(run({ links: [{ site: 'a.org', count: 1 }, { site: 'a.org', count: 2 }] })).toThrow(/duplicate site/);
    expect(run({ links: {} })).toThrow(/links: expected a list/);
  });
});

describe('scripts/inputs.example.yaml', () => {
  it('parses, searchConsole included', async () => {
    const { readFileSync } = await import('node:fs');
    const { parse } = await import('yaml');
    const text = readFileSync(new URL('../../../scripts/inputs.example.yaml', import.meta.url), 'utf8');
    const inputs = parseInputs(parse(text));
    expect(inputs.searchConsole?.property?.type).toBe('domain');
    expect(inputs.searchConsole?.urlInspection).toHaveLength(1);
    expect(inputs.searchConsole?.links?.[0]?.count).toBe(12);
  });
});

describe('contentDecisions', () => {
  const row = { url: 'https://example.com/a', decision: 'refresh', decidedAt: '2026-09-05T09:00:00Z', owner: 'Jane', recordedAt: '2026-09-05T09:00:00Z' };

  it('reads a decision and refuses a bad one', () => {
    expect(parseInputs({ contentDecisions: [row] }).contentDecisions?.[0]).toMatchObject({ url: row.url, decision: 'refresh' });
    expect(() => parseInputs({ contentDecisions: [{ ...row, decidedAt: 'soon' }, row, row] })).toThrow(/decidedAt[\s\S]*duplicate decision/);
    expect(() => parseInputs({ contentDecisions: [{ ...row, url: '/a' }] })).toThrow(/http\(s\) URL/);
  });
});
