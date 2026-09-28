// The front page: the latest audit and its verdict, progress by lifecycle
// phase, what ran lately, the corpus by automation tier, and the checks the
// latest verdict is waiting on.

import { h, fill } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { getCorpus, compareIds } from '../lib/corpus.js';
import { dateTime, duration, hostOf, roleLabel } from '../lib/format.js';
import { donut, phaseRing, ringLegend, crawlBar } from '../lib/charts.js';
import { card, empty, errorPanel, pageHead } from '../lib/ui.js';
import { navigate, isCurrent } from '../lib/router.js';
import { openAuditForm, openSiteForm } from '../lib/forms.js';
import { TIERS, basisOf, checkStatusBadge, gateMark, isActive, tierBadge } from '../lib/states.js';
import { auditRow, auditTable } from './audits.js';

const filters = { phase: '', owner: '', status: 'open' };

export async function dashboardView(root, _params, _query, token) {
  let timer = null;

  async function load() {
    const [corpus, { sites }, { audits }] = await Promise.all([getCorpus(), api.get('/sites'), api.get('/audits?limit=8')]);
    const latest = audits[0] ?? null;
    const graded = audits.find((a) => a.readiness) ?? null;
    const [live, result] = await Promise.all([
      latest && isActive(latest) ? api.get(`/audits/${latest.id}`) : null,
      graded ? api.get(`/audits/${graded.id}/result`) : null,
    ]);
    return { corpus, sites, audits, latest, live, graded, result };
  }

  async function paint() {
    let data;
    try {
      data = await load();
    } catch (error) {
      if (isCurrent(token)) fill(root, pageHead({ title: 'Dashboard' }), errorPanel(error, paint));
      return;
    }
    if (!isCurrent(token)) return;
    fill(root, ...build(data));
    clearTimeout(timer);
    if (data.audits.some(isActive)) timer = setTimeout(paint, 4000);
  }

  function build({ corpus, sites, audits, latest, live, graded, result }) {
    const head = pageHead({
      title: 'Dashboard',
      sub: 'Launch-readiness SEO auditing for your websites',
      actions: [
        h('button', { class: 'btn primary', type: 'button', onclick: () => openSiteForm(null, () => paint()) }, icon('plus', 16), 'Add site'),
        h('button', { class: 'btn outline-accent', type: 'button', onclick: () => openAuditForm() }, icon('play', 15), 'Run audit'),
      ],
    });

    if (sites.length === 0) {
      return [head, card({ title: 'Welcome' }, empty(
        'Add your first site',
        'SEO Optimizer crawls a site the way a search crawler would, tests it against the methodology’s checks, and says whether it is ready to launch. Start by registering the site you want to audit.',
        h('button', { class: 'btn primary', type: 'button', onclick: () => openSiteForm(null, (s) => navigate(`/sites/${s.id}`)) }, icon('plus', 16), 'Add a site')))];
    }

    const checks = joinChecks(corpus, result);
    return [
      head,
      h('div', { class: 'grid dash-top' }, latestCard(corpus, latest, live, graded, result), phaseCard(corpus, graded)),
      h('div', { class: 'grid dash-mid', style: { marginTop: '16px' } }, recentCard(audits, paint), tierCard(corpus)),
      h('div', { class: 'grid dash-bot', style: { marginTop: '16px' } }, attentionCard(corpus, graded, checks, paint), quickCard()),
    ];
  }

  root.append(h('p', { class: 'skeleton' }, 'Loading…'));
  await paint();
  return () => clearTimeout(timer);
}

/** Each graded state beside the check it grades, in corpus order. */
export function joinChecks(corpus, result) {
  if (!result) return [];
  const states = new Map(result.checks.map((c) => [c.checkId, c]));
  return corpus.checks.map((check) => ({ check, state: states.get(check.id) ?? null })).sort((a, b) => compareIds(a.check.id, b.check.id));
}

/** Counts behind the six tiles. A check out of scope counts only as that. */
export function tally(checks) {
  const t = { passed: 0, failed: 0, inProgress: 0, notStarted: 0, skipped: 0, notInScope: 0, scopeUndecided: 0 };
  for (const { state } of checks) {
    if (!state) continue;
    if (state.applicability === 'no') t.notInScope += 1;
    else if (state.status === 'passed') t.passed += 1;
    else if (state.status === 'failed') t.failed += 1;
    else if (state.status === 'in-progress') t.inProgress += 1;
    else if (state.status === 'skipped') t.skipped += 1;
    else t.notStarted += 1;
    if (state.applicability === 'review') t.scopeUndecided += 1;
  }
  return t;
}

export function verdictBox(frozen, big = false) {
  const decision = frozen?.readiness?.decision;
  if (decision === 'GO') return h('div', { class: `verdict go${big ? ' big' : ''}` }, h('b', null, icon('pass', big ? 26 : 18), 'GO'), h('span', null, 'Every applicable launch gate passed'));
  if (decision === 'HOLD') return h('div', { class: `verdict hold${big ? ' big' : ''}` }, h('b', null, icon('fail', big ? 26 : 18), 'HOLD'), h('span', null, 'Not ready to launch'));
  return h('div', { class: `verdict none${big ? ' big' : ''}` }, h('b', null, 'No verdict'), h('span', null, 'Not graded yet'));
}

export function tiles(corpus, frozen, checks, onPick) {
  const t = tally(checks);
  const tile = (cls, iconName, n, label, filter) => {
    const body = [h('div', { class: 'n' }, iconName ? icon(iconName, 16) : null, n), h('div', { class: 'l' }, label)];
    return onPick && filter
      ? h('button', { class: `tile ${cls}`, type: 'button', onclick: () => onPick(filter), title: `Show ${label.toLowerCase()}` }, body)
      : h('div', { class: `tile ${cls}` }, body);
  };
  return h('div', { class: 'tiles' },
    tile('pass', 'pass', t.passed, 'passed', { status: 'passed' }),
    tile('fail', 'fail', t.failed, 'failed', { status: 'failed' }),
    tile('warn', 'clock', t.inProgress, 'in progress', { status: 'in-progress' }),
    tile('neutral', 'dashed', t.notStarted + t.skipped, t.skipped ? `not started (${t.skipped} skipped)` : 'not started', { status: 'not-started' }),
    tile('neutral', 'minus', t.notInScope, 'not in scope', { scope: 'no' }),
    tile('', 'shield', frozen ? `${frozen.readiness.gatesOutstanding}` : '—', `of ${corpus.gateCount} gates open`, { gate: '1', status: 'open' }));
}

function latestCard(corpus, latest, live, graded, result) {
  const site = (audit) => h('a', { class: 'site', href: audit.siteOrigin, target: '_blank', rel: 'noreferrer', title: 'Open the site' }, hostOf(audit.siteOrigin), icon('external', 15));

  if (!latest) {
    return card({ title: 'Latest audit' }, empty('No audits yet', 'Run one to get a verdict.',
      h('button', { class: 'btn primary', type: 'button', onclick: () => openAuditForm() }, icon('play', 15), 'Run an audit')));
  }

  const parts = [];
  if (latest !== graded) {
    // The newest audit has no verdict of its own yet — say what it is doing.
    const status = {
      pending: latest.error ? `Retrying after an engine error: ${latest.error}` : 'Queued — waiting for a slot, or for another crawl of the same host',
      running: 'Crawling and grading',
      failed: `Failed: ${latest.error ?? 'no error recorded'}`,
      cancelled: 'Cancelled by a person. Pages crawled before the cancel stay as evidence.',
    }[latest.status] ?? latest.status;
    parts.push(h('div', { class: 'latest' },
      h('div', null, site(latest), h('div', { class: 'meta' }, `Started ${dateTime(latest.createdAt)} · ${status}`),
        live?.crawl ? h('div', { style: { marginTop: '8px', maxWidth: '360px' } }, crawlBar(live.crawl)) : null),
      h('a', { class: 'btn small', href: `#/audits/${latest.id}` }, 'Open', icon('arrow', 14))));
    if (graded) parts.push(h('p', { class: 'muted', style: { margin: '14px 0 0', fontSize: '13px' } }, 'Latest verdict, from an earlier audit:'));
  }

  if (graded) {
    parts.push(h('div', { class: 'latest', style: latest !== graded ? { marginTop: '8px' } : undefined },
      h('div', null,
        site(graded),
        h('div', { class: 'meta' }, `${graded.status === 'complete' ? 'Completed' : 'Graded'} ${dateTime(graded.finishedAt ?? graded.createdAt)} · ${duration(graded.startedAt, graded.finishedAt)} · methodology v${graded.corpusVersion}`)),
      h('a', { href: `#/audits/${graded.id}`, title: 'Open the verdict', style: { textDecoration: 'none' } }, verdictBox(graded.readiness))));
    parts.push(tiles(corpus, graded.readiness, joinChecks(corpus, result), (f) => navigate(`/audits/${graded.id}?${new URLSearchParams(f)}`)));
  }

  return card({ title: 'Latest audit', more: { href: '#/audits', label: 'View all audits' } }, parts);
}

function phaseCard(corpus, graded) {
  const progress = graded?.readiness?.progress ?? [];
  return card({
    title: 'Progress by lifecycle phase',
    hint: graded ? `${hostOf(graded.siteOrigin)}, ${dateTime(graded.createdAt)}` : undefined,
    more: graded ? { href: `#/audits/${graded.id}`, label: 'View results' } : undefined,
  },
  graded
    ? [h('div', { class: 'rings' }, corpus.phases.map((p) =>
        phaseRing(p.phase, p.label, progress.find((x) => x.phase === p.phase), { onClick: () => navigate(`/audits/${graded.id}?phase=${p.phase}`) }))),
      ringLegend()]
    : empty('No graded audit yet', 'Progress per phase appears once an audit has been graded.'));
}

function recentCard(audits, refresh) {
  return card({ title: 'Recent audits', more: { href: '#/audits', label: 'View all audits' }, flush: true },
    audits.length === 0 ? empty('No audits yet') : auditTable(audits.map((a) => auditRow(a, refresh, { compact: true })), { compact: true }));
}

function tierCard(corpus) {
  const parts = TIERS.map((t) => ({ label: t.label, color: t.color, what: t.what, value: corpus.checks.filter((c) => c.automation === t.id).length }));
  return card({ title: 'Checks by automation tier', hint: `methodology v${corpus.version}` },
    donut(parts, corpus.checks.length, 'checks'),
    h('p', { class: 'muted', style: { margin: '8px 0 0', fontSize: '12.5px' } }, 'Only automated checks can be passed by the engine alone. The rest wait for a person.'));
}

const STATUS_FILTERS = {
  open: { label: 'Needs attention', test: (s) => s.status === 'failed' || s.status === 'in-progress' },
  failed: { label: 'Failed', test: (s) => s.status === 'failed' },
  held: { label: 'Held by warning', test: (s) => basisOf(s) === 'held-by-warning' },
  confirm: { label: 'Awaiting confirmation', test: (s) => basisOf(s) === 'awaiting-confirmation' },
  'not-started': { label: 'Not started', test: (s) => s.status === 'not-started' },
};

const priorityRank = { P0: 0, P1: 1, P2: 2 };

function attentionCard(corpus, graded, checks, refresh) {
  if (!graded) return card({ title: 'Checks needing attention' }, empty('Nothing graded yet'));

  const select = (key, options) => h('select', {
    class: 'select', 'aria-label': key, onchange: (e) => {
      filters[key] = e.target.value;
      refresh();
    },
  }, options.map(([value, label]) => h('option', { value, selected: filters[key] === value }, label)));

  const rows = checks
    .filter(({ state }) => state && state.applicability !== 'no')
    .filter(({ state }) => STATUS_FILTERS[filters.status].test(state))
    .filter(({ check }) => filters.phase === '' || String(check.phase) === filters.phase)
    .filter(({ check }) => filters.owner === '' || check.owners.includes(filters.owner))
    .sort((a, b) =>
      Number(b.check.launchGate) - Number(a.check.launchGate) ||
      Number(b.state.status === 'failed') - Number(a.state.status === 'failed') ||
      priorityRank[a.check.priority] - priorityRank[b.check.priority] ||
      compareIds(a.check.id, b.check.id));

  const shown = rows.slice(0, 8);
  const query = new URLSearchParams({ status: filters.status === 'open' ? 'open' : filters.status, ...(filters.phase ? { phase: filters.phase } : {}), ...(filters.owner ? { owner: filters.owner } : {}) });

  return card({
    title: 'Checks needing attention',
    hint: `${rows.length} in the latest verdict`,
    actions: [
      select('phase', [['', 'All phases'], ...corpus.phases.map((p) => [String(p.phase), `${p.phase}. ${p.label}`])]),
      select('owner', [['', 'All owners'], ...corpus.owners.map((o) => [o, roleLabel(o)])]),
      select('status', Object.entries(STATUS_FILTERS).map(([k, v]) => [k, v.label])),
    ],
    more: { href: `#/audits/${graded.id}?${query}`, label: 'View all' },
    flush: true,
  },
  shown.length === 0
    ? empty('Nothing here', 'No check in the latest verdict matches these filters.')
    : h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, ['Check', 'Phase', 'Automation', 'Owner', 'Status', ''].map((t) => h('th', null, t)))),
        h('tbody', null, shown.map(({ check, state }) =>
          h('tr', { class: 'clickable', onclick: () => navigate(`/audits/${graded.id}?check=${encodeURIComponent(check.id)}`) },
            h('td', null, h('div', { class: 'cell-title' }, h('span', { class: 'id' }, check.id), h('span', { class: 't' }, check.task))),
            h('td', { class: 'nowrap' }, `${check.phase}. ${check.phaseLabel}`),
            h('td', null, tierBadge(check.automation)),
            h('td', null, check.owners.slice(0, 2).map(roleLabel).join(', ') + (check.owners.length > 2 ? ` +${check.owners.length - 2}` : '')),
            h('td', null, checkStatusBadge(state)),
            h('td', { class: 'nowrap' }, check.launchGate ? gateMark() : h('span', { class: 'muted' }, check.priority))))))));
}

function quickCard() {
  const item = (iconName, title, text, onclick, href) =>
    h(href ? 'a' : 'button', { type: href ? undefined : 'button', href, onclick }, icon(iconName, 22), h('b', null, title), h('span', null, text));
  return card({ title: 'Quick actions' },
    h('div', { class: 'quick' },
      item('plus', 'Add a site', 'Register a website to audit', () => openSiteForm(null, (s) => navigate(`/sites/${s.id}`))),
      item('play', 'Run an audit', 'Crawl and grade a site', () => openAuditForm()),
      item('compare', 'Compare audits', 'Confirm a fix, or set two sites side by side', null, '#/compare'),
      item('checks', 'Browse checks', 'The methodology, check by check', null, '#/checks')));
}
