// Plain browser JS, no build step and no framework — the dashboard talks to
// the audit API through this same-origin `/api` proxy (server.ts) and renders
// what it gets back. Every fact shown here already exists on some API
// response; this file only lays it out.

import { overallPercent, diffReadiness, diffChecks } from './compare.js';

const siteListEl = document.getElementById('site-list');
const detailPanel = document.getElementById('detail-panel');
const siteNameEl = document.getElementById('site-name');
const siteOriginEl = document.getElementById('site-origin');
const trendChartEl = document.getElementById('trend-chart');
const auditTableBody = document.querySelector('#audit-table tbody');
const resultPanel = document.getElementById('result-panel');
const resultAuditIdEl = document.getElementById('result-audit-id');
const checksTableBody = document.querySelector('#checks-table tbody');
const evidencePanel = document.getElementById('evidence-panel');
const evidenceCheckIdEl = document.getElementById('evidence-check-id');
const evidenceListEl = document.getElementById('evidence-list');
const attestPanel = document.getElementById('attest-panel');
const attestCheckIdEl = document.getElementById('attest-check-id');
const attestForm = document.getElementById('attest-form');
const attestByEl = document.getElementById('attest-by');
const attestStatusEl = document.getElementById('attest-status');
const attestApplicabilityEl = document.getElementById('attest-applicability');
const attestRationaleLabel = document.getElementById('attest-rationale-label');
const attestRationaleEl = document.getElementById('attest-rationale');
const attestStatementEl = document.getElementById('attest-statement');
const attestExpiresEl = document.getElementById('attest-expires');
const attestMessageEl = document.getElementById('attest-message');
const compareSiteSelect = document.getElementById('compare-site-select');
const compareAuditSelect = document.getElementById('compare-audit-select');
const compareButton = document.getElementById('compare-button');
const compareResultEl = document.getElementById('compare-result');

let allSites = [];
let selectedSiteId = null;
let selectedAuditId = null;
let selectedAuditData = null; // last GET /audits/:id/result payload for the selected audit
let selectedCheckId = null;

async function api(path) {
  const res = await fetch(`/api${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function postJson(path, body) {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = Array.isArray(data.problems)
      ? `${data.error ?? 'invalid request'}: ${data.problems.join('; ')}`
      : (data.error ?? `${res.status} ${res.statusText}`);
    throw new Error(message);
  }
  return data;
}

function badge(text, cls) {
  const span = document.createElement('span');
  span.className = `badge ${cls}`;
  span.textContent = text;
  return span;
}

function decisionBadge(frozen) {
  if (!frozen) return badge('ungraded', 'muted');
  return badge(frozen.readiness.decision, frozen.readiness.decision.toLowerCase());
}

async function loadSites() {
  siteListEl.innerHTML = '';
  let data;
  try {
    data = await api('/sites');
  } catch (error) {
    siteListEl.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = `Could not load sites: ${error.message}`;
    siteListEl.append(li);
    return;
  }

  allSites = data.sites;

  if (data.sites.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No sites yet.';
    siteListEl.append(li);
    return;
  }

  for (const site of data.sites) {
    const li = document.createElement('li');
    li.textContent = site.name;
    li.dataset.id = site.id;
    const origin = document.createElement('span');
    origin.className = 'origin';
    origin.textContent = site.origin;
    li.append(origin);
    li.addEventListener('click', () => selectSite(site));
    siteListEl.append(li);
  }
}

function renderTrend(rows) {
  trendChartEl.innerHTML = '';
  // Oldest first, left to right, matching how a trend is read.
  const chronological = [...rows].reverse().map((a) => ({
    at: a.createdAt,
    overall: overallPercent(a.readiness?.progress),
    decision: a.readiness?.readiness.decision ?? null,
  }));
  const plottable = chronological.filter((p) => p.overall !== null);

  if (plottable.length < 2) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = plottable.length === 0
      ? 'No graded audits yet.'
      : 'Need at least two graded audits to plot a trend.';
    trendChartEl.append(empty);
    return;
  }

  const width = 300;
  const height = 100;
  const pad = 8;
  const step = (width - pad * 2) / (plottable.length - 1);
  const y = (pct) => height - pad - (pct / 100) * (height - pad * 2);

  const points = plottable.map((p, i) => [pad + i * step, y(p.overall)]);
  const polyline = points.map(([x, py]) => `${x},${py}`).join(' ');

  const dots = plottable
    .map((p, i) => {
      const [x, py] = points[i];
      const color = p.decision === 'GO' ? 'var(--pass)' : 'var(--fail)';
      return `<circle cx="${x}" cy="${py}" r="3" fill="${color}"><title>${p.overall}%</title></circle>`;
    })
    .join('');

  trendChartEl.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <polyline points="${polyline}" fill="none" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.5" />
      ${dots}
    </svg>`;
}

function renderAuditTable(rows) {
  auditTableBody.innerHTML = '';
  for (const audit of rows) {
    const tr = document.createElement('tr');

    const date = document.createElement('td');
    date.textContent = new Date(audit.createdAt).toLocaleString();
    tr.append(date);

    const corpus = document.createElement('td');
    corpus.textContent = audit.corpusVersion;
    tr.append(corpus);

    const status = document.createElement('td');
    status.append(badge(audit.status, audit.status));
    tr.append(status);

    const decision = document.createElement('td');
    decision.append(decisionBadge(audit.readiness));
    tr.append(decision);

    const overall = document.createElement('td');
    const pct = overallPercent(audit.readiness?.progress);
    overall.textContent = pct === null ? '—' : `${pct}%`;
    tr.append(overall);

    tr.addEventListener('click', () => selectAudit(audit.id));
    auditTableBody.append(tr);
  }
}

async function selectSite(site) {
  selectedSiteId = site.id;
  for (const li of siteListEl.children) li.classList.toggle('selected', li.dataset.id === site.id);

  detailPanel.classList.remove('hidden');
  resultPanel.classList.add('hidden');
  siteNameEl.textContent = site.name;
  siteOriginEl.textContent = site.origin;

  let data;
  try {
    data = await api(`/sites/${site.id}/audits`);
  } catch (error) {
    auditTableBody.innerHTML = `<tr><td colspan="5">Could not load audits: ${error.message}</td></tr>`;
    return;
  }

  renderTrend(data.audits);
  renderAuditTable(data.audits);
}

async function selectAudit(auditId) {
  selectedAuditId = auditId;
  selectedAuditData = null;
  selectedCheckId = null;
  resultPanel.classList.remove('hidden');
  evidencePanel.classList.add('hidden');
  attestPanel.classList.add('hidden');
  resultAuditIdEl.textContent = auditId;
  checksTableBody.innerHTML = '<tr><td colspan="5">Loading&hellip;</td></tr>';
  compareResultEl.innerHTML = '';

  let data;
  try {
    data = await api(`/audits/${auditId}/result`);
  } catch (error) {
    checksTableBody.innerHTML = `<tr><td colspan="5">Could not load result: ${error.message}</td></tr>`;
    return;
  }

  selectedAuditData = data;
  populateCompareControls();
  renderChecksTable(data.checks);
}

function renderChecksTable(checks) {
  checksTableBody.innerHTML = '';
  if (checks.length === 0) {
    checksTableBody.innerHTML = '<tr><td colspan="5">No checks graded yet.</td></tr>';
    return;
  }

  for (const check of checks) {
    const tr = document.createElement('tr');
    tr.dataset.checkId = check.checkId;
    const id = document.createElement('td');
    id.textContent = check.checkId;
    tr.append(id);

    const applicability = document.createElement('td');
    applicability.append(badge(check.applicability, check.applicability === 'no' ? 'muted' : check.applicability));
    tr.append(applicability);

    const status = document.createElement('td');
    status.append(badge(check.status, check.status));
    tr.append(status);

    const coverage = document.createElement('td');
    coverage.textContent = check.coverage;
    tr.append(coverage);

    const evidence = document.createElement('td');
    evidence.textContent = check.evidence ?? '—';
    tr.append(evidence);

    tr.addEventListener('click', () => selectCheck(check.checkId, check));
    checksTableBody.append(tr);
  }
}

/** Drill down from a graded check to the probe evidence behind it, and open the attestation form for it. */
async function selectCheck(checkId, checkData) {
  selectedCheckId = checkId;
  for (const tr of checksTableBody.children) tr.classList.toggle('selected', tr.dataset.checkId === checkId);

  openAttestForm(checkId, checkData);

  evidencePanel.classList.remove('hidden');
  evidenceCheckIdEl.textContent = checkId;
  evidenceListEl.innerHTML = '<li class="empty">Loading&hellip;</li>';

  let data;
  try {
    data = await api(`/audits/${selectedAuditId}/checks/${encodeURIComponent(checkId)}/evidence`);
  } catch (error) {
    evidenceListEl.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = `Could not load evidence: ${error.message}`;
    evidenceListEl.append(li);
    return;
  }

  evidenceListEl.innerHTML = '';
  if (data.evidence.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No probe evidence recorded for this check.';
    evidenceListEl.append(li);
    return;
  }

  for (const item of data.evidence) {
    const li = document.createElement('li');

    const head = document.createElement('div');
    head.className = 'evidence-head';
    const probe = document.createElement('span');
    probe.className = 'evidence-probe';
    probe.textContent = item.probeId;
    head.append(probe);
    head.append(badge(item.outcome, item.outcome));
    if (item.page) {
      const page = document.createElement('span');
      page.className = 'evidence-page';
      page.textContent = item.page.url;
      head.append(page);
    }
    li.append(head);

    const summary = document.createElement('p');
    summary.className = 'evidence-summary';
    summary.textContent = item.summary;
    li.append(summary);

    if (item.data !== null && item.data !== undefined) {
      const pre = document.createElement('pre');
      pre.className = 'evidence-data';
      pre.textContent = JSON.stringify(item.data, null, 2);
      li.append(pre);
    }

    evidenceListEl.append(li);
  }
}

/** Open the attestation form for one check, prefilled from its current graded state when known. */
function openAttestForm(checkId, checkData) {
  attestPanel.classList.remove('hidden');
  attestCheckIdEl.textContent = checkId;
  attestMessageEl.textContent = '';
  attestMessageEl.className = '';

  attestByEl.value = '';
  attestStatementEl.value = '';
  attestStatusEl.value = checkData?.status ?? 'passed';
  attestApplicabilityEl.value = checkData?.applicability ?? 'yes';
  attestRationaleEl.value = checkData?.applicabilityRationale ?? '';
  attestRationaleLabel.classList.toggle('hidden', attestApplicabilityEl.value !== 'no');

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  attestExpiresEl.min = tomorrow.toISOString().slice(0, 10);
  attestExpiresEl.value = '';
}

attestApplicabilityEl.addEventListener('change', () => {
  attestRationaleLabel.classList.toggle('hidden', attestApplicabilityEl.value !== 'no');
});

attestForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!selectedAuditId || !selectedCheckId) return;

  attestMessageEl.className = '';
  attestMessageEl.textContent = 'Recording…';

  const body = {
    checkId: selectedCheckId,
    attestedBy: attestByEl.value.trim(),
    statement: attestStatementEl.value.trim(),
    expiresAt: new Date(attestExpiresEl.value).toISOString(),
    status: attestStatusEl.value,
    applicability: attestApplicabilityEl.value,
  };
  if (body.applicability === 'no') {
    body.applicabilityRationale = attestRationaleEl.value.trim();
  }

  try {
    await postJson(`/audits/${selectedAuditId}/attestations`, body);
  } catch (error) {
    attestMessageEl.className = 'error-banner';
    attestMessageEl.textContent = `Could not record attestation: ${error.message}`;
    return;
  }

  const checkId = selectedCheckId;
  await reloadCheckResult(checkId);
});

/** Re-fetches the current audit's result after a write, then reopens the given check with its new state. */
async function reloadCheckResult(checkId) {
  const auditId = selectedAuditId;
  if (!auditId) return;

  let data;
  try {
    data = await api(`/audits/${auditId}/result`);
  } catch (error) {
    attestMessageEl.className = 'error-banner';
    attestMessageEl.textContent = `Attestation recorded, but could not refresh results: ${error.message}`;
    return;
  }

  selectedAuditData = data;
  populateCompareControls();
  renderChecksTable(data.checks);

  const updated = data.checks.find((c) => c.checkId === checkId);
  selectedCheckId = checkId;
  for (const tr of checksTableBody.children) tr.classList.toggle('selected', tr.dataset.checkId === checkId);
  openAttestForm(checkId, updated);
  attestMessageEl.className = 'success-banner';
  attestMessageEl.textContent = 'Attestation recorded.';
}

/** Fill the compare-site dropdown from the sites already loaded, defaulting to the current one. */
function populateCompareControls() {
  compareSiteSelect.innerHTML = '';
  for (const site of allSites) {
    const opt = document.createElement('option');
    opt.value = site.id;
    opt.textContent = site.name;
    if (site.id === selectedSiteId) opt.selected = true;
    compareSiteSelect.append(opt);
  }
  loadCompareAudits(compareSiteSelect.value);
}

/** Fill the compare-audit dropdown with the chosen site's audits, excluding the one already selected. */
async function loadCompareAudits(siteId) {
  compareButton.disabled = true;
  compareAuditSelect.disabled = true;
  compareAuditSelect.innerHTML = '<option value="">Loading&hellip;</option>';

  if (!siteId) return;

  let data;
  try {
    data = await api(`/sites/${siteId}/audits`);
  } catch (error) {
    compareAuditSelect.innerHTML = `<option value="">Could not load: ${error.message}</option>`;
    return;
  }

  const candidates = data.audits.filter((a) => a.id !== selectedAuditId);
  compareAuditSelect.innerHTML = '';
  if (candidates.length === 0) {
    compareAuditSelect.innerHTML = '<option value="">No other audits on this site</option>';
    return;
  }

  for (const audit of candidates) {
    const opt = document.createElement('option');
    opt.value = audit.id;
    opt.textContent = `${new Date(audit.createdAt).toLocaleString()} — ${audit.status}`;
    compareAuditSelect.append(opt);
  }
  compareAuditSelect.disabled = false;
  compareButton.disabled = false;
}

compareSiteSelect.addEventListener('change', () => loadCompareAudits(compareSiteSelect.value));
compareButton.addEventListener('click', runCompare);

async function runCompare() {
  const compareAuditId = compareAuditSelect.value;
  if (!compareAuditId || !selectedAuditData) return;

  compareResultEl.innerHTML = '<p class="empty">Comparing&hellip;</p>';

  let baselineData;
  try {
    baselineData = await api(`/audits/${compareAuditId}/result`);
  } catch (error) {
    compareResultEl.innerHTML = `<p class="empty">Could not load comparison audit: ${error.message}</p>`;
    return;
  }

  renderCompare(baselineData, selectedAuditData);
}

/** Render a diff of `baselineData` (an older or different-site audit) against `currentData` (the selected one). */
function renderCompare(baselineData, currentData) {
  compareResultEl.innerHTML = '';

  if (!baselineData.readiness || !currentData.readiness) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'One or both audits are not graded yet — nothing to compare.';
    compareResultEl.append(p);
    return;
  }

  const readinessDiff = diffReadiness(baselineData.readiness, currentData.readiness);

  if (readinessDiff.corpusVersionMismatch) {
    const warn = document.createElement('p');
    warn.className = 'error-banner';
    warn.textContent = `Corpus versions differ: ${readinessDiff.baseline.corpusVersion} vs ${readinessDiff.current.corpusVersion} — verdicts may not be directly comparable.`;
    compareResultEl.append(warn);
  }

  const summary = document.createElement('p');
  summary.className = 'compare-summary';
  summary.append(badge(readinessDiff.baseline.decision, readinessDiff.baseline.decision.toLowerCase()));
  summary.append(document.createTextNode(' → '));
  summary.append(badge(readinessDiff.current.decision, readinessDiff.current.decision.toLowerCase()));
  const gates = document.createElement('span');
  gates.className = 'compare-gates';
  gates.textContent = ` gates outstanding ${readinessDiff.baseline.gatesOutstanding} → ${readinessDiff.current.gatesOutstanding}, failed ${readinessDiff.baseline.gatesFailed} → ${readinessDiff.current.gatesFailed}`;
  summary.append(gates);
  compareResultEl.append(summary);

  const phaseTable = document.createElement('table');
  phaseTable.className = 'compare-phase-table';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Phase</th><th>Baseline</th><th>Current</th><th>Delta</th></tr>';
  phaseTable.append(thead);
  const tbody = document.createElement('tbody');
  for (const p of readinessDiff.phaseDeltas) {
    const tr = document.createElement('tr');
    const phase = document.createElement('td');
    phase.textContent = p.phase;
    tr.append(phase);
    const b = document.createElement('td');
    b.textContent = p.baselinePercent === null ? '—' : `${p.baselinePercent}%`;
    tr.append(b);
    const c = document.createElement('td');
    c.textContent = p.currentPercent === null ? '—' : `${p.currentPercent}%`;
    tr.append(c);
    const d = document.createElement('td');
    d.textContent = p.delta === null ? '—' : p.delta > 0 ? `+${p.delta}` : `${p.delta}`;
    tr.append(d);
    tbody.append(tr);
  }
  phaseTable.append(tbody);
  compareResultEl.append(phaseTable);

  const checksDiff = diffChecks(baselineData.checks, currentData.checks);
  const movedHeading = document.createElement('h4');
  movedHeading.textContent = `Checks with a different verdict (${checksDiff.length})`;
  compareResultEl.append(movedHeading);

  if (checksDiff.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No verdict changed between these two audits.';
    compareResultEl.append(p);
    return;
  }

  const list = document.createElement('ul');
  list.className = 'compare-moves';
  for (const move of checksDiff) {
    const li = document.createElement('li');
    const id = document.createElement('span');
    id.className = 'compare-move-id';
    id.textContent = move.checkId;
    li.append(id);
    if (move.before) {
      li.append(badge(move.before.status, move.before.status));
      li.append(document.createTextNode(' → '));
    } else {
      const news = document.createElement('span');
      news.className = 'compare-move-new';
      news.textContent = 'new — ';
      li.append(news);
    }
    li.append(badge(move.after.status, move.after.status));
    list.append(li);
  }
  compareResultEl.append(list);
}

loadSites();
