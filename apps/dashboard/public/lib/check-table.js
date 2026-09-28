// The check list both the audit workspace and the methodology browser use:
// one filter row above one table, with a detail pane beside it.

import { h, fill } from './dom.js';
import { roleLabel } from './format.js';
import { replaceQuery } from './router.js';
import { applicabilityBadge, basisOf, checkStatusBadge, gateMark, priorityBadge, tierBadge, TIERS } from './states.js';

export const STATUS_FILTERS = {
  '': { label: 'All statuses', test: () => true },
  open: { label: 'Needs attention', test: (s) => s?.status === 'failed' || s?.status === 'in-progress' },
  failed: { label: 'Failed', test: (s) => s?.status === 'failed' },
  'in-progress': { label: 'In progress', test: (s) => s?.status === 'in-progress' },
  held: { label: '… held by warning', test: (s) => s?.status === 'in-progress' && basisOf(s) === 'held-by-warning' },
  confirm: { label: '… awaiting confirmation', test: (s) => s?.status === 'in-progress' && basisOf(s) === 'awaiting-confirmation' },
  passed: { label: 'Passed', test: (s) => s?.status === 'passed' },
  'not-started': { label: 'Not started', test: (s) => !s || s.status === 'not-started' },
  skipped: { label: 'Skipped', test: (s) => s?.status === 'skipped' },
};

const FILTER_KEYS = ['q', 'phase', 'status', 'scope', 'tier', 'owner', 'priority', 'gate'];

export function filtersFrom(query) {
  return Object.fromEntries(FILTER_KEYS.map((k) => [k, query[k] ?? '']));
}

function matches(row, f) {
  const { check, state } = row;
  if (f.phase !== '' && String(check.phase) !== f.phase) return false;
  if (f.tier !== '' && check.automation !== f.tier) return false;
  if (f.owner !== '' && !check.owners.includes(f.owner)) return false;
  if (f.priority !== '' && check.priority !== f.priority) return false;
  if (f.gate === '1' && !check.launchGate) return false;
  if (f.scope !== '' && state?.applicability !== f.scope) return false;
  // "Needs attention" means in scope and not settled; out-of-scope rows never need it.
  if (f.status !== '') {
    if (f.status === 'open' && state?.applicability === 'no') return false;
    if (!(STATUS_FILTERS[f.status] ?? STATUS_FILTERS['']).test(state)) return false;
  }
  if (f.q) {
    const q = f.q.toLowerCase();
    if (!`${check.id} ${check.task} ${check.whatToDo} ${state?.evidence ?? ''}`.toLowerCase().includes(q)) return false;
  }
  return true;
}

/**
 * `rows` are `{ check, state }`; `withState` adds the audit's columns and
 * filters. `filters` is mutated as the person changes it, and mirrored into
 * the URL so a reload keeps it. `selected`/`onSelect` drive the detail pane.
 */
export function checkTable({ corpus, rows, filters, withState, selected, onSelect, extraQuery = {} }) {
  const tbody = h('tbody');
  const count = h('span', { class: 'count' });

  const control = (key, options, label) => h('select', {
    class: 'select', 'aria-label': label,
    onchange: (e) => { filters[key] = e.target.value; update(); },
  }, options.map(([v, l]) => h('option', { value: v, selected: filters[key] === v }, l)));

  const search = h('input', { class: 'input search', type: 'search', placeholder: 'Search checks', value: filters.q, 'aria-label': 'Search checks' });
  let debounce = null;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { filters.q = search.value.trim(); update(); }, 150);
  });
  const gate = h('input', { type: 'checkbox', checked: filters.gate === '1', onchange: (e) => { filters.gate = e.target.checked ? '1' : ''; update(); } });

  const bar = h('div', { class: 'filters', style: { padding: '12px 16px', borderBottom: '1px solid var(--rule)' } },
    search,
    control('phase', [['', 'All phases'], ...corpus.phases.map((p) => [String(p.phase), `${p.phase}. ${p.label}`])], 'Phase'),
    withState ? control('status', Object.entries(STATUS_FILTERS).map(([k, v]) => [k, v.label]), 'Status') : null,
    withState ? control('scope', [['', 'Any scope'], ['yes', 'In scope'], ['review', 'Scope undecided'], ['no', 'Not in scope']], 'Scope') : null,
    control('tier', [['', 'All tiers'], ...TIERS.map((t) => [t.id, t.label])], 'Automation tier'),
    control('owner', [['', 'All owners'], ...corpus.owners.map((o) => [o, roleLabel(o)])], 'Owner'),
    control('priority', [['', 'Any priority'], ['P0', 'P0'], ['P1', 'P1'], ['P2', 'P2']], 'Priority'),
    h('label', { class: 'toggle' }, gate, 'Launch gates only'),
    count);

  const heads = withState
    ? ['Check', 'Phase', 'Status', 'Scope', 'Automation', 'Owner', '']
    : ['Check', 'Phase', 'Automation', 'Owner', 'Priority', ''];

  function update() {
    replaceQuery({ ...extraQuery, ...filters, check: selected() ?? undefined });
    const shown = rows.filter((r) => matches(r, filters));
    count.textContent = `${shown.length} of ${rows.length} checks`;
    fill(tbody, ...(shown.length === 0
      ? [h('tr', null, h('td', { colspan: heads.length, class: 'empty' }, 'No check matches these filters.'))]
      : shown.map((r) => rowFor(r))));
  }

  function rowFor({ check, state }) {
    const tr = h('tr', {
      class: `clickable${selected() === check.id ? ' selected' : ''}`,
      dataset: { check: check.id },
      tabindex: 0,
      onclick: () => onSelect(check.id),
      onkeydown: (e) => { if (e.key === 'Enter') onSelect(check.id); },
    },
    h('td', null, h('div', { class: 'cell-title' },
      h('span', { class: 'id' }, check.id),
      h('span', { class: 't' }, check.task),
      withState && state?.evidence ? h('span', { class: 'ev' }, state.evidence) : null)),
    h('td', { class: 'nowrap' }, `${check.phase}. ${check.phaseLabel}`),
    withState ? h('td', null, checkStatusBadge(state)) : null,
    withState ? h('td', null, state ? applicabilityBadge(state.applicability, state.applicabilityRationale) : '—') : null,
    h('td', null, tierBadge(check.automation)),
    h('td', null, check.owners.slice(0, 2).map(roleLabel).join(', ') + (check.owners.length > 2 ? ` +${check.owners.length - 2}` : '')),
    withState ? null : h('td', null, priorityBadge(check.priority)),
    h('td', { class: 'nowrap' }, check.launchGate ? gateMark() : withState ? h('span', { class: 'muted' }, check.priority) : null));
    return tr;
  }

  update();
  const table = h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', null, h('tr', null, heads.map((t) => h('th', null, t)))), tbody));

  return {
    el: h('div', null, bar, table),
    /** Re-mark the selected row without rebuilding the list. */
    markSelected() {
      for (const tr of tbody.children) tr.classList.toggle('selected', tr.dataset.check === selected());
      replaceQuery({ ...extraQuery, ...filters, check: selected() ?? undefined });
    },
    setFilters(next) {
      Object.assign(filters, next);
      update();
    },
  };
}
