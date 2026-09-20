import { describe, expect, it } from 'vitest';
import { parseInputs } from '../src/inputs.js';

describe('analytics', () => {
  const full = {
    owner: 'Jane',
    recordedAt: '2026-09-10T09:00:00Z',
    measurementIds: ['G-ABC123DEF4'],
    consentDefault: 'denied',
    events: [{ name: 'purchase', trigger: 'order confirmation', expect: 'sent' }],
    reported: [
      {
        metric: 'sessions',
        period: '2026-08',
        sourceA: { name: 'ga4', value: 100 },
        sourceB: { name: 'server-logs', value: 110 },
      },
    ],
  };
  const run = (patch: object) => () => parseInputs({ analytics: { ...full, ...patch } });

  it('reads the setup, plan and reconciliation', () => {
    const a = parseInputs({ analytics: full }).analytics;
    expect(a?.consentDefault).toBe('denied');
    expect(a?.events[0]?.expect).toBe('sent');
    expect(a?.reported[0]?.sourceB.value).toBe(110);
  });

  it('refuses what a tagging plan would not hold', () => {
    expect(run({ extra: 1 })).toThrow(/analytics\.extra: unknown field/);
    expect(run({ measurementIds: [] })).toThrow(/measurementIds: expected at least one/);
    expect(run({ measurementIds: ['G-A', 'G-A'] })).toThrow(/duplicate measurement ID/);
    expect(run({ consentDefault: 'maybe' })).toThrow(/consentDefault: expected one of granted, denied/);
    expect(run({ events: [{ name: 'x', trigger: 't', expect: 'fired' }] })).toThrow(/events\[0\]\.expect: expected one of sent, suppressed/);
    expect(run({ events: [{ name: 'x', expect: 'sent' }] })).toThrow(/events\[0\]\.trigger: required/);
    expect(run({ reported: [{ ...full.reported[0], sourceA: { name: 'ga4', value: '100' } }] })).toThrow(/sourceA\.value/);
    expect(run({ reported: [{ ...full.reported[0], sourceB: { name: 'ga4', value: 1 } }] })).toThrow(/two different sources/);
    expect(run({ reported: undefined })).toThrow(/analytics\.reported: required/);
  });

  it('is in scripts/inputs.example.yaml', async () => {
    const { readFileSync } = await import('node:fs');
    const { parse } = await import('yaml');
    const text = readFileSync(new URL('../../../scripts/inputs.example.yaml', import.meta.url), 'utf8');
    expect(parseInputs(parse(text)).analytics?.events).toHaveLength(2);
  });
});
