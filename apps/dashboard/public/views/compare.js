// Two audits side by side: the same site before and after a fix, or two
// sites. The diff helpers are `../compare.js`, unit-tested on their own.

import { h, fill } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { getCorpus, compareIds } from '../lib/corpus.js';
import { dateTime, hostOf } from '../lib/format.js';
import { banner, card, empty, errorPanel, pageHead } from '../lib/ui.js';
import { isCurrent, replaceQuery } from '../lib/router.js';
import { applicabilityBadge, checkStatusBadge, decisionBadge } from '../lib/states.js';
import { diffChecks, diffReadiness } from '../compare.js';

export async function compareView(root, _params, query, token) {
  let audits;
  try {
    ({ audits } = await api.get('/audits?limit=100'));
  } catch (error) {
    if (isCurrent(token)) fill(root, pageHead({ title: 'Compare' }), errorPanel(error));
    return;
  }
  if (!isCurrent(token)) return;

  const graded = audits.filter((a) => a.readiness);
  const head = pageHead({ title: 'Compare audits', sub: 'Confirm a fix against the audit before it, or set two sites side by side.' });
  if (graded.length < 2) {
    fill(root, head, card({}, empty('Nothing to compare yet', 'Comparing needs two graded audits.')));
    return;
  }

  // Default: the newest graded audit against the one before it on the same site.
  let current = graded.find((a) => a.id === query.b) ?? graded[0];
  let baseline = graded.find((a) => a.id === query.a) ?? graded.find((a) => a.id !== current.id && a.siteId === current.siteId) ?? graded.find((a) => a.id !== current.id);

  const label = (a) => `${a.siteName} — ${dateTime(a.createdAt)} — ${a.readiness.readiness.decision} (v${a.corpusVersion})`;
  const picker = (value, onchange, aria) => h('select', { class: 'select', style: { minWidth: '320px' }, 'aria-label': aria, onchange: (e) => onchange(graded.find((a) => a.id === e.target.value)) },
    groupBySite(graded).map(([site, list]) => h('optgroup', { label: site }, list.map((a) => h('option', { value: a.id, selected: a.id === value.id }, label(a))))));

  const out = h('div');
  const controls = h('div', { class: 'filters' },
    h('span', { class: 'muted' }, 'Baseline'), picker(baseline, (a) => { baseline = a; run(); }, 'Baseline audit'),
    icon('arrow', 16),
    h('span', { class: 'muted' }, 'Current'), picker(current, (a) => { current = a; run(); }, 'Current audit'));

  fill(root, head, card({ title: 'Audits' }, controls), h('div', { style: { marginTop: '16px' } }, out));

  async function run() {
    replaceQuery({ a: baseline.id, b: current.id });
    fill(out, h('p', { class: 'skeleton' }, 'Comparing…'));
    let a, b, corpus;
    try {
      [a, b, corpus] = await Promise.all([api.get(`/audits/${baseline.id}/result`), api.get(`/audits/${current.id}/result`), getCorpus(current.corpusVersion)]);
    } catch (error) {
      fill(out, errorPanel(error, run));
      return;
    }
    fill(out, ...render(a, b, corpus));
  }

  function render(a, b, corpus) {
    const diff = diffReadiness(a.readiness, b.readiness);
    const moves = diffChecks(a.checks, b.checks).sort((x, y) => compareIds(x.checkId, y.checkId));
    const same = baseline.siteId === current.siteId;
    const stat = (title, before, after, better) => {
      const delta = after - before;
      const good = delta === 0 ? null : better === 'lower' ? delta < 0 : delta > 0;
      return h('div', { class: 'tile' },
        h('div', { class: 'l' }, title),
        h('div', { class: 'n', style: { fontSize: '20px' } }, `${before} → ${after}`),
        delta === 0 ? h('div', { class: 'l' }, 'no change') : h('div', { class: 'l', style: { color: good ? 'var(--pass)' : 'var(--fail)' } }, icon(good ? 'pass' : 'warn', 12), ` ${delta > 0 ? '+' : ''}${delta}`));
    };

    return [
      diff.corpusVersionMismatch
        ? banner('warn', 'warn', `These audits are pinned to different methodology versions (v${diff.baseline.corpusVersion} and v${diff.current.corpusVersion}).`, 'Their verdicts may not be comparable: a check id means what its own version says it means.')
        : null,
      !same ? banner('info', 'info', `Comparing two sites: ${hostOf(baseline.siteOrigin)} and ${hostOf(current.siteOrigin)}.`) : null,
      card({ title: 'Verdict' },
        h('div', { class: 'chips', style: { alignItems: 'center', gap: '10px', marginBottom: '14px' } },
          decisionBadge(a.readiness), icon('arrow', 16), decisionBadge(b.readiness),
          diff.decisionChanged ? h('b', null, 'The decision changed.') : h('span', { class: 'muted' }, 'Same decision.')),
        h('div', { class: 'tiles', style: { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' } },
          stat('Overall complete', diff.baseline.overallPercent ?? 0, diff.current.overallPercent ?? 0, 'higher'),
          stat('Launch gates outstanding', diff.baseline.gatesOutstanding, diff.current.gatesOutstanding, 'lower'),
          stat('Launch gates failed', diff.baseline.gatesFailed, diff.current.gatesFailed, 'lower'))),
      h('div', { class: 'grid dash-mid', style: { marginTop: '16px' } },
        card({ title: 'Checks whose verdict changed', hint: `${moves.length}`, flush: true },
          moves.length === 0 ? empty('No verdict changed', 'Every check reads the same in both audits.')
            : h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
                h('thead', null, h('tr', null, ['Check', 'Before', 'After'].map((t) => h('th', null, t)))),
                h('tbody', null, moves.map((m) => h('tr', { class: 'clickable', onclick: () => { location.hash = `#/audits/${current.id}?check=${encodeURIComponent(m.checkId)}`; } },
                  h('td', null, h('div', { class: 'cell-title' }, h('span', { class: 'id' }, m.checkId), h('span', { class: 't' }, corpus.byId.get(m.checkId)?.task ?? ''))),
                  h('td', null, m.before ? h('div', { class: 'chips' }, checkStatusBadge(m.before), m.before.applicability !== m.after.applicability ? applicabilityBadge(m.before.applicability) : null) : h('span', { class: 'muted' }, 'not in baseline')),
                  h('td', null, h('div', { class: 'chips' }, checkStatusBadge(m.after), m.before && m.before.applicability !== m.after.applicability ? applicabilityBadge(m.after.applicability) : null)))))))),
        card({ title: 'By lifecycle phase', flush: true },
          h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
            h('thead', null, h('tr', null, ['Phase', 'Before', 'After', 'Change'].map((t) => h('th', { class: t === 'Phase' ? undefined : 'num' }, t)))),
            h('tbody', null, diff.phaseDeltas.map((p) => h('tr', null,
              h('td', null, `${p.phase}. ${corpus.phaseLabel(p.phase)}`),
              h('td', { class: 'num' }, p.baselinePercent === null ? '—' : `${p.baselinePercent}%`),
              h('td', { class: 'num' }, p.currentPercent === null ? '—' : `${p.currentPercent}%`),
              h('td', { class: 'num', style: { color: p.delta > 0 ? 'var(--pass)' : p.delta < 0 ? 'var(--fail)' : undefined } },
                p.delta === null ? '—' : p.delta > 0 ? `+${p.delta}` : `${p.delta}`)))))))),
    ];
  }

  run();
}

function groupBySite(audits) {
  const groups = new Map();
  for (const a of audits) {
    const key = `${a.siteName} (${hostOf(a.siteOrigin)})`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  return [...groups];
}
