import { describe, expect, it } from 'vitest';
import { parseInputs } from '../src/inputs.js';

describe('crux', () => {
  const full = {
    owner: 'Jane',
    recordedAt: '2026-09-10T09:00:00Z',
    populations: [
      {
        source: 'crux-origin',
        target: 'https://example.com',
        formFactor: 'mobile',
        lcpMs: 2300,
        cls: 0.05,
        actions: [{ metric: 'inp', owner: 'Jane', retestAt: '2026-10-01T00:00:00Z' }],
      },
    ],
  };
  const run = (patch: object) => () => parseInputs({ crux: { ...full, ...patch } });

  it('reads populations and leaves an unreported metric absent', () => {
    const p = parseInputs({ crux: full }).crux?.populations[0];
    expect(p?.lcpMs).toBe(2300);
    expect(p?.inpMs).toBeUndefined();
    expect(p?.actions[0]?.metric).toBe('inp');
  });

  it('refuses what a report would not hold', () => {
    expect(run({ extra: 1 })).toThrow(/crux\.extra: unknown field/);
    expect(run({ populations: [{ ...full.populations[0], source: 'psi' }] })).toThrow(/populations\[0\]\.source: expected one of/);
    expect(run({ populations: [{ ...full.populations[0], lcpMs: '2300' }] })).toThrow(/populations\[0\]\.lcpMs/);
    expect(run({ populations: [full.populations[0], full.populations[0]] })).toThrow(/duplicate population/);
    expect(run({ populations: [{ ...full.populations[0], actions: [{ metric: 'lcp', owner: 'Jane' }] }] })).toThrow(/actions\[0\]\.retestAt: required/);
  });

  it('is in scripts/inputs.example.yaml', async () => {
    const { readFileSync } = await import('node:fs');
    const { parse } = await import('yaml');
    const text = readFileSync(new URL('../../../scripts/inputs.example.yaml', import.meta.url), 'utf8');
    expect(parseInputs(parse(text)).crux?.populations).toHaveLength(1);
  });
});
