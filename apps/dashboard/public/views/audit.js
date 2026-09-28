// One audit: while it runs, where it has got to; once graded, the verdict and
// why, cutover when it names a release, progress per phase, and every check
// with its evidence and the decisions people record on it.

import { h, fill } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { getCorpus } from '../lib/corpus.js';
import { dateTime, duration, hostOf, plural } from '../lib/format.js';
import { crawlBar, phaseRing, ringLegend } from '../lib/charts.js';
import { banner, card, empty, errorPanel, pageHead } from '../lib/ui.js';
import { isCurrent, navigate } from '../lib/router.js';
import { openAuditForm } from '../lib/forms.js';
import { auditStatusBadge, isActive } from '../lib/states.js';
import { checkDetail } from '../lib/check-detail.js';
import { checkTable, filtersFrom } from '../lib/check-table.js';
import { joinChecks, tiles, verdictBox } from './dashboard.js';
import { cancelAudit } from './audits.js';

export async function auditView(root, { id }, query, token) {
  let timer = null;
  const filters = filtersFrom(query);
  let selected = query.check ?? null;

  async function paint() {
    let audit, sites, corpus, result;
    try {
      audit = await api.get(`/audits/${encodeURIComponent(id)}`);
      [{ sites }, corpus, result] = await Promise.all([
        api.get('/sites'),
        getCorpus(audit.corpusVersion),
        audit.readiness ? api.get(`/audits/${encodeURIComponent(id)}/result`) : null,
      ]);
    } catch (error) {
      if (isCurrent(token)) fill(root, pageHead({ title: 'Audit', crumbs: h('a', { href: '#/audits' }, 'Audits') }), errorPanel(error, paint));
      return;
    }
    if (!isCurrent(token)) return;

    const site = sites.find((s) => s.id === audit.siteId);
    const head = pageHead({
      crumbs: [h('a', { href: '#/audits' }, 'Audits'), ' / ', site ? h('a', { href: `#/sites/${site.id}` }, site.name) : 'Unknown site'],
      title: site ? site.name : 'Audit',
      sub: [site ? h('a', { href: site.origin, target: '_blank', rel: 'noreferrer' }, hostOf(site.origin), ' ', icon('external', 13)) : null,
        ` · started ${dateTime(audit.createdAt)} · methodology v${audit.corpusVersion}${audit.releaseId ? ' · release on record' : ''}`],
      actions: [
        auditStatusBadge(audit),
        isActive(audit) ? h('button', { class: 'btn danger', type: 'button', onclick: () => cancelAudit(audit, paint) }, icon('stop', 14), 'Cancel audit') : null,
        audit.readiness ? h('a', { class: 'btn', href: `#/compare?b=${audit.id}` }, icon('compare', 15), 'Compare') : null,
        h('button', { class: 'btn outline-accent', type: 'button', onclick: () => openAuditForm(audit.siteId) }, icon('play', 14), 'Run again'),
      ],
    });

    if (!audit.readiness) {
      fill(root, head, statusPanel(audit));
      clearTimeout(timer);
      if (isActive(audit)) timer = setTimeout(paint, 3000);
      return;
    }
    clearTimeout(timer);

    const rows = joinChecks(corpus, result);
    fill(root, head, ...graded(audit, corpus, rows));
  }

  function graded(audit, corpus, rows) {
    const frozen = audit.readiness;
    const workspace = h('div', { class: 'workspace' });

    const openCheck = (checkId) => {
      selected = checkId;
      paintWorkspace();
      table.markSelected();
    };

    let table;
    const tableCard = card({ title: 'Checks', hint: `${rows.length} in methodology v${corpus.version}`, flush: true });

    function paintTable() {
      table = checkTable({ corpus, rows, filters, withState: true, selected: () => selected, onSelect: openCheck });
      fill(tableCard.querySelector('.card-body'), table.el);
    }

    function paintWorkspace() {
      const row = rows.find((r) => r.check.id === selected);
      workspace.classList.toggle('open', Boolean(row));
      fill(workspace, tableCard, row
        ? checkDetail(row.check, {
            state: row.state,
            audit,
            onClose: () => { selected = null; paintWorkspace(); table.markSelected(); },
            onChanged: paint,
          })
        : null);
    }

    const rings = h('div', { class: 'rings' });
    const paintRings = () => fill(rings, ...corpus.phases.map((p) =>
      phaseRing(p.phase, p.label, frozen.progress.find((x) => x.phase === p.phase), {
        pressed: filters.phase === String(p.phase),
        onClick: () => {
          filters.phase = filters.phase === String(p.phase) ? '' : String(p.phase);
          paintRings();
          paintTable();
          paintWorkspace();
        },
      })));

    const pick = (next) => {
      for (const key of ['status', 'scope', 'gate']) filters[key] = '';
      Object.assign(filters, next);
      paintTable();
      paintWorkspace();
      tableCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    paintRings();
    paintTable();
    paintWorkspace();

    return [
      verdictCard(audit, corpus, rows, pick),
      frozen.cutover ? cutoverCard(frozen.cutover, corpus, openCheck) : null,
      h('div', { style: { marginTop: '16px' } }, card({ title: 'Progress by lifecycle phase', hint: 'select a phase to filter the checks' }, rings, ringLegend())),
      h('div', { style: { marginTop: '16px' } }, workspace),
    ];
  }

  root.append(h('p', { class: 'skeleton' }, 'Loading…'));
  await paint();
  return () => clearTimeout(timer);
}

function statusPanel(audit) {
  const crawl = audit.crawl;
  switch (audit.status) {
    case 'pending':
      return card({ title: audit.error ? 'Waiting to retry' : 'Queued' }, h('div', { class: 'status-panel' },
        audit.error
          ? banner('warn', 'refresh', 'The engine hit a problem it expects a repeat to fix, and will try again.', h('p', { class: 'mono', style: { fontSize: '12.5px' } }, audit.error))
          : h('p', null, 'Waiting for a free slot. Only one crawl runs against a host at a time, so another audit of the same site may be ahead of this one.'),
        audit.queue ? h('p', { class: 'muted' }, `Attempt ${audit.queue.attempt + 1}.`) : null,
        h('p', { class: 'muted' }, 'You can close the app. A queued audit resumes when it starts again.')));
    case 'running':
      return card({ title: 'Running' }, h('div', { class: 'status-panel' },
        h('p', null, crawl ? `Crawling — ${plural(crawl.pagesFetched, 'page')} fetched so far, against a budget of ${crawl.maxPages}.` : 'Starting the crawl…'),
        crawl ? crawlBar(crawl) : null,
        h('p', { class: 'muted' }, `Running for ${duration(audit.startedAt)}. Detectors and grading follow the crawl; the verdict appears here when it is done.`)));
    case 'failed':
      return card({ title: 'This audit failed' }, h('div', { class: 'status-panel' },
        banner('fail', 'fail', 'The engine could not finish it, and will not retry. This is worth investigating.', h('p', { class: 'mono', style: { fontSize: '12.5px' } }, audit.error ?? 'No error was recorded.')),
        crawl ? h('p', { class: 'muted' }, `${plural(crawl.pagesFetched, 'page')} were crawled before it stopped, and stay on record.`) : null));
    case 'cancelled':
      return card({ title: 'Cancelled' }, h('div', { class: 'status-panel' },
        h('p', null, 'A person stopped this audit. Nothing needs investigating.'),
        crawl ? h('p', { class: 'muted' }, `${plural(crawl.pagesFetched, 'page')} were crawled before the cancel. They stay as evidence of what was there.`) : null));
    default:
      return card({ title: 'Complete, without a verdict' }, empty('No readiness was frozen for this audit.'));
  }
}

function verdictCard(audit, corpus, rows, pick) {
  const r = audit.readiness.readiness;
  const reasons = [];
  const reason = (kind, iconName, text, onclick) =>
    h('li', { class: kind }, icon(iconName, 16), onclick ? h('button', { class: 'link-btn', type: 'button', onclick, style: { color: 'var(--ink)', fontWeight: 400, textAlign: 'left' } }, text) : h('span', null, text));
  if (r.gatesFailed) reasons.push(reason('fail', 'fail', `${plural(r.gatesFailed, 'launch gate')} failed`, () => pick({ gate: '1', status: 'failed' })));
  const unfinished = r.gatesOutstanding - r.gatesFailed;
  if (unfinished > 0) reasons.push(reason('warn', 'clock', `${plural(unfinished, 'launch gate')} not yet passed`, () => pick({ gate: '1', status: 'open' })));
  if (r.applicabilityDecisionsOutstanding) reasons.push(reason('warn', 'help', `${plural(r.applicabilityDecisionsOutstanding, 'launch gate')} with scope undecided`, () => pick({ gate: '1', scope: 'review' })));
  if (r.attestationsLapsed) reasons.push(reason('warn', 'clock', `${plural(r.attestationsLapsed, 'attestation')} lapsed — no longer counting`));
  for (const v of r.violations) reasons.push(reason('fail', 'warn', `Integrity violation on ${v.checkId}: ${v.message}`));
  if (reasons.length === 0) reasons.push(reason('pass', 'pass', 'Every applicable launch gate passed.'));

  return card({ title: 'Verdict', hint: `graded ${dateTime(audit.readiness.gradedAt)}` },
    h('div', { class: 'verdict-card' },
      verdictBox(audit.readiness, true),
      h('div', null,
        h('ul', { class: 'reasons' }, reasons),
        h('p', { class: 'muted', style: { margin: '10px 0 0', fontSize: '12.5px' } },
          'The verdict is frozen at grading, against the methodology the audit is pinned to. Decisions recorded since update the checks below.'))),
    tiles(corpus, audit.readiness, rows, pick));
}

function cutoverCard(c, corpus, openCheck) {
  const ready = c.cutover !== 'HOLD';
  return h('div', { style: { marginTop: '16px' } }, card({ title: 'Cutover readiness', hint: 'for the release this audit names' },
    c.launchDecision === 'conflict'
      ? banner('fail', 'warn', 'Conflict: a GO was recorded for this release while the calculation says HOLD.', 'Reconcile the record before acting on it.')
      : null,
    h('div', { class: 'chips', style: { alignItems: 'center', gap: '12px', marginBottom: '12px' } },
      h('div', { class: `verdict ${ready ? 'go' : 'hold'}` }, h('b', null, ready ? 'READY FOR CUTOVER' : 'HOLD'), h('span', null, 'cutover')),
      h('div', { class: `verdict ${c.final === 'GO' ? 'go' : 'hold'}` }, h('b', null, c.final), h('span', null, 'final, after launch-day checks')),
      h('span', { class: 'muted' }, `Recorded launch decision: ${c.launchDecision}`)),
    h('dl', { class: 'kv' },
      h('dt', null, 'Pre-cutover gates outstanding'), h('dd', null, c.preCutoverGatesOutstanding),
      h('dt', null, 'Live gates outstanding'), h('dd', null, c.liveGatesOutstanding),
      h('dt', null, 'Evidence incomplete'), h('dd', null, `${c.preCutoverEvidenceIncomplete} pre-cutover, ${c.liveEvidenceIncomplete} live`),
      h('dt', null, 'Cutover record'), h('dd', null, c.cutoverRecordValid ? 'Valid' : 'Missing or invalid'),
      h('dt', null, 'Review-log errors'), h('dd', null, c.inputErrors),
      h('dt', null, 'Scope problems'), h('dd', null, c.scopeProblems.length ? c.scopeProblems.join(', ') : c.scopeErrors ? `${c.scopeErrors}` : 'None')),
    c.blockers.length
      ? h('div', { class: 'table-wrap', style: { marginTop: '14px' } }, h('table', { class: 'data' },
          h('thead', null, h('tr', null, ['Gate', 'Evidence class', 'Review state', 'Problem'].map((t) => h('th', null, t)))),
          h('tbody', null, c.blockers.map((b) => h('tr', { class: 'clickable', onclick: () => openCheck(b.checkId) },
            h('td', null, h('div', { class: 'cell-title' }, h('span', { class: 'id' }, b.checkId), h('span', { class: 't' }, corpus.byId.get(b.checkId)?.task ?? ''))),
            h('td', null, h('span', { class: 'badge outline' }, b.evidenceClass)),
            h('td', null, b.reviewState),
            h('td', null, b.evidenceProblem || (b.outstanding ? 'Gate not passed' : '—')))))))
      : null));
}
