// Every state the engine can report, with the treatment each one gets. Each
// badge carries an icon and a label as well as a colour, because several of
// these states differ only in meaning (brief: "State reference").

import { h } from './dom.js';
import { icon } from './icons.js';

function badge(cls, iconName, label, title) {
  return h('span', { class: `badge ${cls}`, title }, iconName ? icon(iconName, 13) : null, label);
}

/** Launch decision on a frozen readiness block. No block means no verdict yet — not HOLD. */
export function decisionBadge(frozen) {
  const decision = frozen?.readiness?.decision;
  if (decision === 'GO') return badge('solid-go', null, 'GO');
  if (decision === 'HOLD') return badge('solid-hold', null, 'HOLD');
  return badge('neutral', 'dashed', 'No verdict');
}

/** Audit status. A pending audit with an error on it is waiting to retry. */
export function auditStatusBadge(audit) {
  switch (audit.status) {
    case 'pending':
      return audit.error ? badge('warn', 'refresh', 'Retrying', audit.error) : badge('neutral', 'clock', 'Queued');
    case 'running':
      return badge('info', 'refresh', 'Running');
    case 'complete':
      return badge('outline', 'pass', 'Complete');
    case 'failed':
      return badge('fail', 'fail', 'Failed', audit.error ?? undefined);
    case 'cancelled':
      return badge('outline', 'x', 'Cancelled');
    default:
      return badge('neutral', null, audit.status);
  }
}

/**
 * Verdict for a row in an audit list: the decision once graded, the status
 * until then. A failed or cancelled audit shows as such, never as HOLD.
 */
export function auditOutcomeBadge(audit) {
  return audit.readiness ? decisionBadge(audit.readiness) : auditStatusBadge(audit);
}

export const isActive = (audit) => audit.status === 'pending' || audit.status === 'running';

/**
 * Why the grader left a check where it is, read back from the evidence line
 * it wrote (`grade.ts`): the basis itself is not stored, but every summary
 * starts with the word that names it.
 */
export function basisOf(state) {
  const text = state?.evidence ?? '';
  if (text.startsWith('proposed:')) return 'awaiting-confirmation';
  if (text.startsWith('held:')) return 'held-by-warning';
  if (text.startsWith('not graded:')) return 'ungraded';
  if (text.startsWith('nothing to verify:')) return 'nothing-to-verify';
  return null;
}

export const CHECK_STATUS = {
  'not-started': { cls: 'neutral', icon: 'dashed', label: 'Not started' },
  'in-progress': { cls: 'warn', icon: 'clock', label: 'In progress' },
  passed: { cls: 'pass', icon: 'pass', label: 'Passed' },
  failed: { cls: 'fail', icon: 'fail', label: 'Failed' },
  skipped: { cls: 'outline', icon: 'minus', label: 'Skipped' },
};

/**
 * A check state's status. An assisted check with clean evidence reads
 * "Awaiting confirmation" (R2), a held one "Held by warning" (R3); nothing
 * the machine never looked at is ever shown green or red (R1).
 */
export function checkStatusBadge(state) {
  if (!state) return badge('neutral', 'dashed', 'Not graded');
  const basis = basisOf(state);
  if (state.status === 'in-progress' && basis === 'awaiting-confirmation') {
    return badge('info', 'person', 'Awaiting confirmation');
  }
  if (state.status === 'in-progress' && basis === 'held-by-warning') {
    return badge('warn', 'warn', 'Held by warning');
  }
  const def = CHECK_STATUS[state.status] ?? { cls: 'neutral', icon: null, label: state.status };
  return badge(def.cls, def.icon, def.label);
}

export const APPLICABILITY = {
  yes: { cls: 'outline', icon: null, label: 'In scope' },
  no: { cls: 'neutral', icon: 'minus', label: 'Not in scope' },
  review: { cls: 'warn', icon: 'help', label: 'Scope undecided' },
};

export function applicabilityBadge(value, rationale) {
  const def = APPLICABILITY[value] ?? { cls: 'neutral', label: value };
  return badge(def.cls, def.icon, def.label, value === 'no' ? rationale ?? undefined : undefined);
}

export const COVERAGE = {
  verified: 'Verified by the engine',
  attested: 'Attested by a person',
  unknown: 'Unknown — nobody has verified it',
  'not-applicable': 'Not applicable',
};

export function coverageBadge(value) {
  const cls = value === 'verified' || value === 'attested' ? 'info' : 'neutral';
  return badge(cls, null, value, COVERAGE[value]);
}

/** Probe outcome. `error` means the detector could not judge: dashed, not filled. */
export function outcomeBadge(outcome) {
  switch (outcome) {
    case 'pass':
      return badge('pass', 'pass', 'pass');
    case 'fail':
      return badge('fail', 'fail', 'fail');
    case 'warn':
      return badge('warn', 'warn', 'warn');
    case 'error':
      return badge('error', 'help', 'could not judge', 'The detector failed to run. This is not a finding about the site.');
    default:
      return badge('neutral', 'minus', outcome === 'not-applicable' ? 'n/a' : outcome);
  }
}

export const TIERS = [
  { id: 'automated', label: 'Automated', color: 'var(--series-1)', what: 'The engine can pass or fail it' },
  { id: 'assisted', label: 'Assisted', color: 'var(--series-2)', what: 'Engine proposes, a person confirms' },
  { id: 'attested', label: 'Attested', color: 'var(--series-3)', what: "Only a person's statement counts" },
];

export function tierBadge(tier) {
  const def = TIERS.find((t) => t.id === tier);
  return h('span', { class: 'badge tier', style: { '--tier': def?.color ?? 'var(--neutral)' }, title: def?.what }, def?.label ?? tier);
}

export const priorityBadge = (priority) =>
  h('span', { class: 'badge outline', title: 'Impact ranking. It does not decide what blocks launch.' }, priority);

export const gateMark = () =>
  h('span', { class: 'gate', title: 'Launch gate: blocks GO while applicable and not passed' }, icon('shield', 13), 'Gate');
