// Plain browser JS, no build step and no framework — the dashboard talks to
// the audit API through this same-origin `/api` proxy (server.ts) and renders
// what it gets back. Every fact shown here already exists on some API
// response; this file only lays it out.

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

let selectedSiteId = null;
let selectedAuditId = null;

async function api(path) {
  const res = await fetch(`/api${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json();
}

/** Weighted mean of every phase's percentComplete, weighted by its active check count. */
function overallPercent(progress) {
  if (!progress || progress.length === 0) return null;
  const totalActive = progress.reduce((sum, p) => sum + p.active, 0);
  if (totalActive === 0) return null;
  const weighted = progress.reduce((sum, p) => sum + p.percentComplete * p.active, 0);
  return Math.round(weighted / totalActive);
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
  resultPanel.classList.remove('hidden');
  evidencePanel.classList.add('hidden');
  resultAuditIdEl.textContent = auditId;
  checksTableBody.innerHTML = '<tr><td colspan="5">Loading&hellip;</td></tr>';

  let data;
  try {
    data = await api(`/audits/${auditId}/result`);
  } catch (error) {
    checksTableBody.innerHTML = `<tr><td colspan="5">Could not load result: ${error.message}</td></tr>`;
    return;
  }

  checksTableBody.innerHTML = '';
  if (data.checks.length === 0) {
    checksTableBody.innerHTML = '<tr><td colspan="5">No checks graded yet.</td></tr>';
    return;
  }

  for (const check of data.checks) {
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

    tr.addEventListener('click', () => selectCheck(check.checkId));
    checksTableBody.append(tr);
  }
}

/** Drill down from a graded check to the probe evidence behind it. */
async function selectCheck(checkId) {
  for (const tr of checksTableBody.children) tr.classList.toggle('selected', tr.dataset.checkId === checkId);

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

loadSites();
