import { describe, expect, it } from 'vitest';
import { gateHistory } from '../src/gates.js';

const checks = [
  { id: '1.1', launchGate: true },
  { id: '1.2', launchGate: true },
  { id: '1.3', launchGate: false },
];

describe('gateHistory', () => {
  it('keeps only launch gates and sorts each list', () => {
    const history = gateHistory({
      checks,
      previousStates: [
        { checkId: '1.2', status: 'passed' },
        { checkId: '1.1', status: 'passed' },
        { checkId: '1.3', status: 'passed' },
      ],
      grade: {
        checks: [
          { checkId: '1.2', status: 'failed' },
          { checkId: '1.3', status: 'failed' },
          { checkId: '1.1', status: 'passed' },
        ],
      } as never,
      reopened: ['1.2', '1.2'],
    });
    expect(history).toEqual({
      passedBefore: ['1.1', '1.2'],
      failingNow: ['1.2'],
      reopened: ['1.2'],
    });
  });

  it('is empty when the previous audit passed nothing', () => {
    const history = gateHistory({
      checks,
      previousStates: [{ checkId: '1.1', status: 'failed' }],
      grade: { checks: [] } as never,
      reopened: [],
    });
    expect(history.passedBefore).toEqual([]);
  });
});
