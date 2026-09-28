// Every audit across sites, newest first, and the rows other views reuse.

import { h, fill } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { dateTime, duration, hostOf } from '../lib/format.js';
import { percentBar } from '../lib/charts.js';
import { card, empty, errorPanel, pageHead, toast } from '../lib/ui.js';
import { navigate, isCurrent, replaceQuery } from '../lib/router.js';
import { openAuditForm } from '../lib/forms.js';
import { auditOutcomeBadge, auditStatusBadge, isActive } from '../lib/states.js';
import { overallPercent } from '../compare.js';

export async function cancelAudit(audit, after) {
  try {
    const { status } = await api.post(`/audits/${audit.id}/cancel`);
    toast(status === 'cancelled' ? 'Audit cancelled.' : 'Cancelling — the crawl stops after the request in flight.');
  } catch (error) {
    toast(`Could not cancel: ${error.message}`, 'error');
  }
  after?.();
}

/** One audit as a table row. `site: true` adds the site column, for lists across sites. */
export function auditRow(audit, refresh, { site = true, compact = false } = {}) {
  const pct = overallPercent(audit.readiness?.progress);
  return h('tr', { class: 'clickable', onclick: () => navigate(`/audits/${audit.id}`) },
    site ? h('td', null, h('div', { class: 'cell-title' },
      h('span', { class: 't' }, audit.siteName),
      h('a', { href: audit.siteOrigin, target: '_blank', rel: 'noreferrer', class: 'nowrap', style: { fontSize: '12.5px' }, onclick: (e) => e.stopPropagation() }, hostOf(audit.siteOrigin), ' ', icon('external', 12)))) : null,
    h('td', { class: 'nowrap' }, dateTime(audit.createdAt)),
    h('td', { class: 'nowrap num' }, audit.finishedAt || audit.status === 'running' ? duration(audit.startedAt, audit.finishedAt) : '—'),
    h('td', null, auditOutcomeBadge(audit)),
    compact ? null : h('td', { class: 'mono' }, `v${audit.corpusVersion}`),
    h('td', null, audit.readiness ? percentBar(pct, 'Overall percent complete, weighted by each phase’s checks in scope') : h('span', { class: 'muted' }, '—')),
    h('td', { class: 'num' }, isActive(audit)
      ? h('button', { class: 'btn small danger', type: 'button', title: 'Cancel this audit', 'aria-label': 'Cancel this audit', onclick: (e) => { e.stopPropagation(); cancelAudit(audit, refresh); } }, icon('stop', 13), compact ? null : 'Cancel')
      : h('span', { class: 'muted' }, icon('arrow', 16))));
}

export function auditTable(rows, { site = true, compact = false } = {}) {
  const heads = [site ? 'Site' : null, 'Started', 'Duration', 'Verdict', compact ? null : 'Methodology', 'Progress', ''].filter((x) => x !== null);
  return h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', null, h('tr', null, heads.map((t) => h('th', { class: t === 'Duration' ? 'num' : undefined }, t)))),
    h('tbody', null, rows)));
}

const STATUSES = [
  ['', 'All'],
  ['active', 'Queued or running'],
  ['complete', 'Complete'],
  ['failed', 'Failed'],
  ['cancelled', 'Cancelled'],
];

export async function auditsView(root, _params, query, token) {
  let timer = null;
  let status = query.status ?? '';

  async function paint() {
    let audits;
    try {
      ({ audits } = await api.get('/audits?limit=100'));
    } catch (error) {
      if (isCurrent(token)) fill(root, pageHead({ title: 'Audits' }), errorPanel(error, paint));
      return;
    }
    if (!isCurrent(token)) return;

    const shown = audits.filter((a) => status === '' || (status === 'active' ? isActive(a) : a.status === status));
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Status' }, STATUSES.map(([value, label]) =>
      h('button', { type: 'button', 'aria-pressed': String(status === value), onclick: () => { status = value; replaceQuery({ status }); paint(); } }, label)));

    fill(root,
      pageHead({
        title: 'Audits',
        sub: 'Every audit, newest first. Failed means something to investigate; cancelled means a person stopped it.',
        actions: h('button', { class: 'btn primary', type: 'button', onclick: () => openAuditForm() }, icon('play', 15), 'Run audit'),
      }),
      card({ title: `${shown.length} ${shown.length === 1 ? 'audit' : 'audits'}`, actions: seg, flush: true },
        shown.length === 0 ? empty('No audits match', status ? 'Try another status.' : 'Run one to get started.') : auditTable(shown.map((a) => auditRow(a, paint)))),
      audits.length === 100 ? h('p', { class: 'muted', style: { fontSize: '12.5px' } }, 'Showing the 100 most recent. Older audits are on each site’s page.') : null,
    );
    clearTimeout(timer);
    if (audits.some(isActive)) timer = setTimeout(paint, 4000);
  }

  root.append(h('p', { class: 'skeleton' }, 'Loading…'));
  await paint();
  return () => clearTimeout(timer);
}

/** "Results" in the navigation: the most recent audit with a verdict. */
export async function latestResultsView(root, _params, _query, token) {
  let audits;
  try {
    ({ audits } = await api.get('/audits?limit=100'));
  } catch (error) {
    fill(root, pageHead({ title: 'Results' }), errorPanel(error, () => latestResultsView(root, _params, _query, token)));
    return;
  }
  if (!isCurrent(token)) return;
  const graded = audits.find((a) => a.readiness);
  if (graded) {
    history.replaceState(null, '', `#/audits/${graded.id}`);
    navigate(`/audits/${graded.id}`);
    return;
  }
  fill(root, pageHead({ title: 'Results' }), card({}, empty('No results yet', 'Results appear once an audit has been graded.',
    h('button', { class: 'btn primary', type: 'button', onclick: () => openAuditForm() }, icon('play', 15), 'Run an audit'))));
}

export { auditStatusBadge };
