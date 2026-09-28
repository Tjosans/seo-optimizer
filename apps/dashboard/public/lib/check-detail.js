// One check, in the detail pane: the methodology's text for it, and — when
// an audit is open — what that audit concluded, the evidence behind it, and
// the form a person records a decision with.

import { h, fill, append } from './dom.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { date, roleLabel } from './format.js';
import { field, modal, toast } from './ui.js';
import {
  CHECK_STATUS,
  COVERAGE,
  applicabilityBadge,
  basisOf,
  checkStatusBadge,
  coverageBadge,
  gateMark,
  outcomeBadge,
  priorityBadge,
  tierBadge,
} from './states.js';

const DAY = 86_400_000;

/**
 * `audit` is `{ id }` for an audit's view of the check, absent in the corpus
 * browser. `onChanged` runs after a decision is recorded.
 */
export function checkDetail(check, { state, audit, onClose, onChanged } = {}) {
  const pane = h('aside', { class: 'card detail', 'aria-label': `Check ${check.id}` });
  const body = h('div', { class: 'card-body' });
  pane.append(body);

  append(body, [
    h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'flex-start' } },
      h('div', { class: 'chips', style: { alignItems: 'center' } },
        h('span', { class: 'mono', style: { fontWeight: 600 } }, check.id),
        check.launchGate ? gateMark() : null, priorityBadge(check.priority), tierBadge(check.automation)),
      onClose ? h('button', { class: 'btn ghost small', type: 'button', 'aria-label': 'Close', onclick: onClose }, icon('x', 16)) : null),
    h('h3', { style: { marginTop: '10px' } }, check.task),
    h('p', { class: 'muted', style: { fontSize: '13px' } }, `Phase ${check.phase} · ${check.phaseLabel}`),
  ]);

  if (audit) body.append(stateBlock(check, state, audit, onChanged));

  append(body, [
    h('h4', null, 'What to do'), h('p', null, check.whatToDo),
    h('h4', null, 'Done when'), h('div', { class: 'block' }, check.doneWhen),
    h('h4', null, 'About this check'),
    h('dl', { class: 'kv' },
      h('dt', null, 'Owners'), h('dd', null, check.owners.map(roleLabel).join(', ') || '—'),
      h('dt', null, 'Applies to'), h('dd', null, check.applicability.universal ? 'Every site' : check.applicability.source,
        !check.applicability.universal && check.applicability.any.length ? h('div', { class: 'chips', style: { marginTop: '4px' } }, check.applicability.any.map((f) => h('span', { class: 'badge outline' }, f))) : null),
      h('dt', null, 'Launch gate'), h('dd', null, check.launchGate ? 'Yes — blocks GO while applicable and not passed' : 'No'),
      h('dt', null, 'Fix type'), h('dd', null, check.remediationClass),
      h('dt', null, 'Review'), h('dd', null, check.cadence?.source || '—'),
      h('dt', null, 'Detectors'), h('dd', null, check.detectors.length ? h('span', { class: 'mono' }, check.detectors.join(', ')) : 'None — only a person’s attestation counts')),
  ]);
  if (check.notes) body.append(h('h4', null, 'Notes'), h('p', { class: 'muted', style: { fontSize: '13px' } }, check.notes));
  if (check.sources?.length) {
    body.append(h('h4', null, 'Sources'), h('ol', { class: 'sources' }, check.sources.map((src) =>
      h('li', null, h('a', { href: src.url, target: '_blank', rel: 'noreferrer' }, src.topic), h('span', { class: 'muted' }, ` — verified ${src.verified}`)))));
  }
  return pane;
}

function stateBlock(check, state, audit, onChanged) {
  const wrap = h('div');
  if (!state) {
    wrap.append(h('h4', null, 'In this audit'), h('p', { class: 'muted' }, 'This audit graded no state for this check.'));
    return wrap;
  }

  const basis = basisOf(state);
  const expires = state.attestationExpiresAt ? new Date(state.attestationExpiresAt) : null;
  const lapsed = expires && expires.getTime() <= Date.now();
  const soon = expires && !lapsed && expires.getTime() - Date.now() < 30 * DAY;

  const action =
    check.automation === 'attested' ? 'Attest'
    : basis === 'awaiting-confirmation' ? 'Confirm or reject'
    : 'Record a decision';

  append(wrap, [
    h('h4', null, 'In this audit'),
    h('div', { class: 'chips' }, checkStatusBadge(state), applicabilityBadge(state.applicability, state.applicabilityRationale), coverageBadge(state.coverage)),
    state.applicability === 'no' && state.applicabilityRationale
      ? h('p', { style: { marginTop: '8px', fontSize: '13px' } }, h('b', null, 'Why it is out of scope: '), state.applicabilityRationale) : null,
    state.evidence ? h('div', { class: 'block', style: { marginTop: '8px', fontSize: '13px' } }, state.evidence) : null,
    basis === 'awaiting-confirmation'
      ? h('p', { style: { marginTop: '8px', fontSize: '13px' } }, icon('person', 14), ' The engine found nothing wrong. An assisted check still needs a person to confirm it before it counts as passed.') : null,
    expires ? h('p', { style: { marginTop: '8px', fontSize: '13px', color: lapsed ? 'var(--fail)' : soon ? 'var(--warn)' : undefined } },
      icon(lapsed ? 'fail' : 'clock', 14),
      lapsed ? ` Attestation lapsed ${date(expires)}. It stays on record but no longer counts, and holds its gate.` : ` Attestation expires ${date(expires)}${soon ? ' — soon' : ''}.`) : null,
    h('div', { style: { marginTop: '12px' } },
      h('button', { class: 'btn primary small', type: 'button', onclick: () => openAttestation(check, state, audit, onChanged) }, icon('person', 14), action)),
  ]);

  if (check.detectors.length) wrap.append(evidenceSection(check, audit));
  return wrap;
}

function evidenceSection(check, audit) {
  const list = h('div', null, h('p', { class: 'muted' }, 'Loading evidence…'));
  const section = h('div', null, h('h4', null, 'Evidence'), list);
  api.get(`/audits/${audit.id}/checks/${encodeURIComponent(check.id)}/evidence`)
    .then(({ evidence }) => {
      if (evidence.length === 0) {
        fill(list, h('p', { class: 'muted' }, 'No detector observations are linked to this check in this audit.'));
        return;
      }
      const counts = {};
      for (const e of evidence) counts[e.outcome] = (counts[e.outcome] ?? 0) + 1;
      const order = ['fail', 'error', 'warn', 'pass', 'not-applicable'];
      const sorted = [...evidence].sort((a, b) => order.indexOf(a.outcome) - order.indexOf(b.outcome));
      let limit = 25;
      const items = h('ul', { class: 'evidence' });
      const more = h('button', { class: 'link-btn', type: 'button' });
      const paint = () => {
        fill(items, ...sorted.slice(0, limit).map(evidenceItem));
        more.hidden = sorted.length <= limit;
        more.textContent = `Show all ${sorted.length}`;
      };
      more.addEventListener('click', () => { limit = Infinity; paint(); });
      paint();
      fill(list,
        h('div', { class: 'chips', style: { marginBottom: '8px' } }, order.filter((o) => counts[o]).map((o) => h('span', { class: 'chips', style: { gap: '4px', alignItems: 'center' } }, outcomeBadge(o), h('span', { class: 'muted num' }, `× ${counts[o]}`)))),
        items, more);
    })
    .catch((error) => fill(list, h('p', { class: 'muted' }, `Could not load evidence: ${error.message}`)));
  return section;
}

function evidenceItem(e) {
  return h('li', null,
    h('div', { class: 'head' }, outcomeBadge(e.outcome), h('span', { class: 'probe' }, e.probeId)),
    e.page ? h('a', { class: 'page', href: e.page.url, target: '_blank', rel: 'noreferrer' }, e.page.url) : h('span', { class: 'muted page' }, 'Whole site'),
    h('span', null, e.summary),
    e.data !== null && e.data !== undefined
      ? h('details', null, h('summary', null, 'Observation data'), h('pre', { class: 'json' }, JSON.stringify(e.data, null, 2))) : null);
}

/** A person's decision on one check, always with an expiry (R4) and a reason for any exclusion (R5). */
function openAttestation(check, state, audit, onChanged) {
  let remembered = '';
  try { remembered = localStorage.getItem('seo-attested-by') ?? ''; } catch {}
  const expiry = new Date(Date.now() + 90 * DAY).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + DAY).toISOString().slice(0, 10);

  const by = h('input', { type: 'text', value: remembered, placeholder: 'Your name' });
  const status = h('select', null, ['passed', 'failed', 'in-progress', 'not-started', 'skipped'].map((s) =>
    h('option', { value: s, selected: s === (state.status === 'in-progress' && basisOf(state) === 'awaiting-confirmation' ? 'passed' : state.status) }, CHECK_STATUS[s].label)));
  const applicability = h('select', null, [['yes', 'In scope'], ['no', 'Not in scope'], ['review', 'Scope undecided']].map(([v, l]) =>
    h('option', { value: v, selected: v === state.applicability }, l)));
  const rationale = h('textarea', { rows: 2, value: state.applicabilityRationale ?? '', placeholder: 'Why this check does not apply to this site' });
  const rationaleField = field('applicabilityRationale', 'Reason it is out of scope', rationale, 'Required. It is printed wherever this check is reported.');
  const statement = h('textarea', { rows: 3, placeholder: 'What you checked, and what you found' });
  const expires = h('input', { type: 'date', value: expiry, min: tomorrow });
  const sync = () => { rationaleField.hidden = applicability.value !== 'no'; };
  applicability.addEventListener('change', sync);
  sync();

  modal({
    title: `${check.id} — record a decision`,
    submitLabel: 'Record decision',
    body: [
      h('p', { class: 'muted', style: { margin: 0 } }, check.task),
      check.launchGate ? h('p', { style: { margin: 0, fontSize: '13px' } }, icon('shield', 14), ' This is a launch gate. Skipping an applicable gate is refused; set it out of scope with a reason instead.') : null,
      field('attestedBy', 'Attested by', by),
      h('div', { class: 'row2' }, field('status', 'Status', status), field('applicability', 'Scope', applicability)),
      rationaleField,
      field('statement', 'Statement', statement),
      field('expiresAt', 'Expires', expires, 'After this date the decision stops counting and holds its gate until someone renews it.'),
    ],
    async onSubmit() {
      const body = {
        checkId: check.id,
        attestedBy: by.value.trim(),
        statement: statement.value.trim(),
        expiresAt: expires.value ? new Date(`${expires.value}T23:59:59`).toISOString() : '',
        status: status.value,
        applicability: applicability.value,
      };
      if (body.applicability === 'no') body.applicabilityRationale = rationale.value.trim();
      await api.post(`/audits/${audit.id}/attestations`, body);
      try { localStorage.setItem('seo-attested-by', body.attestedBy); } catch {}
      toast(`Decision on ${check.id} recorded.`);
      onChanged?.();
    },
  });
}

export { COVERAGE };
