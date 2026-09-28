// Sites: the list, and one site's profile, readiness over time and history.

import { h, s, fill } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { getCorpus } from '../lib/corpus.js';
import { date, dateTime, hostOf } from '../lib/format.js';
import { banner, card, confirmAction, empty, errorPanel, pageHead, toast } from '../lib/ui.js';
import { isCurrent, navigate } from '../lib/router.js';
import { openAuditForm, openSiteForm } from '../lib/forms.js';
import { auditOutcomeBadge, isActive } from '../lib/states.js';
import { overallPercent } from '../compare.js';
import { auditRow, auditTable } from './audits.js';

export async function sitesView(root, _params, _query, token) {
  async function paint() {
    let sites, audits;
    try {
      [{ sites }, { audits }] = await Promise.all([api.get('/sites'), api.get('/audits?limit=100')]);
    } catch (error) {
      if (isCurrent(token)) fill(root, pageHead({ title: 'Sites' }), errorPanel(error, paint));
      return;
    }
    if (!isCurrent(token)) return;

    const add = () => h('button', { class: 'btn primary', type: 'button', onclick: () => openSiteForm(null, (site) => navigate(`/sites/${site.id}`)) }, icon('plus', 16), 'Add site');
    const latestBySite = new Map();
    for (const a of audits) if (!latestBySite.has(a.siteId)) latestBySite.set(a.siteId, a);

    fill(root,
      pageHead({ title: 'Sites', sub: 'The websites under audit, each identified by its origin.', actions: add() }),
      card({ title: `${sites.length} ${sites.length === 1 ? 'site' : 'sites'}`, flush: true },
        sites.length === 0
          ? empty('No sites yet', 'Add the site you want to audit. You can describe it with flags that bring conditional checks into scope.', add())
          : h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
              h('thead', null, h('tr', null, ['Site', 'Profile', 'Flags', 'Latest audit', 'Verdict', ''].map((t) => h('th', null, t)))),
              h('tbody', null, sites.map((site) => {
                const latest = latestBySite.get(site.id);
                return h('tr', { class: 'clickable', onclick: () => navigate(`/sites/${site.id}`) },
                  h('td', null, h('div', { class: 'cell-title' }, h('span', { class: 't' }, site.name), h('span', { class: 'muted', style: { fontSize: '12.5px' } }, site.origin))),
                  h('td', null, h('span', { class: 'badge outline' }, site.profile)),
                  h('td', null, site.flags.length ? h('div', { class: 'chips' }, site.flags.slice(0, 4).map((f) => h('span', { class: 'badge outline' }, f)), site.flags.length > 4 ? h('span', { class: 'muted' }, `+${site.flags.length - 4}`) : null) : h('span', { class: 'muted' }, 'None')),
                  h('td', { class: 'nowrap' }, latest ? dateTime(latest.createdAt) : h('span', { class: 'muted' }, 'Never audited')),
                  h('td', null, latest ? auditOutcomeBadge(latest) : null),
                  h('td', { class: 'num' }, h('button', {
                    class: 'btn small', type: 'button', title: `Run an audit of ${site.name}`,
                    onclick: (e) => { e.stopPropagation(); openAuditForm(site.id); },
                  }, icon('play', 13), 'Run audit')));
              }))))),
    );
  }

  root.append(h('p', { class: 'skeleton' }, 'Loading…'));
  await paint();
}

export async function siteView(root, { id }, _query, token) {
  let timer = null;

  async function paint() {
    let sites, audits, corpus;
    try {
      [{ sites }, { audits }, corpus] = await Promise.all([api.get('/sites'), api.get(`/sites/${encodeURIComponent(id)}/audits`), getCorpus()]);
    } catch (error) {
      if (isCurrent(token)) fill(root, pageHead({ title: 'Site', crumbs: h('a', { href: '#/sites' }, 'Sites') }), errorPanel(error, paint));
      return;
    }
    if (!isCurrent(token)) return;
    const site = sites.find((x) => x.id === id);
    if (!site) {
      fill(root, pageHead({ title: 'Site not found', crumbs: h('a', { href: '#/sites' }, 'Sites') }), card({}, empty('No such site', 'It may have been deleted.')));
      return;
    }

    const withSite = audits.map((a) => ({ ...a, siteId: site.id, siteName: site.name, siteOrigin: site.origin }));
    fill(root,
      pageHead({
        crumbs: h('a', { href: '#/sites' }, 'Sites'),
        title: site.name,
        sub: h('a', { href: site.origin, target: '_blank', rel: 'noreferrer' }, site.origin, ' ', icon('external', 13)),
        actions: [
          h('button', { class: 'btn', type: 'button', onclick: () => openSiteForm(site, paint) }, icon('edit', 15), 'Edit'),
          h('button', { class: 'btn danger', type: 'button', onclick: () => remove(site, audits.length) }, icon('trash', 15), 'Delete'),
          h('button', { class: 'btn primary', type: 'button', onclick: () => openAuditForm(site.id) }, icon('play', 15), 'Run audit'),
        ],
      }),
      h('div', { class: 'grid dash-mid' }, profileCard(site, corpus, paint), trendCard(audits)),
      h('div', { style: { marginTop: '16px' } }, card({ title: 'Audit history', hint: 'newest first', flush: true },
        audits.length === 0
          ? empty('Never audited', 'Run the first audit to get a verdict.', h('button', { class: 'btn primary', type: 'button', onclick: () => openAuditForm(site.id) }, icon('play', 15), 'Run audit'))
          : auditTable(withSite.map((a) => auditRow(a, paint, { site: false })), { site: false }))),
    );
    clearTimeout(timer);
    if (audits.some(isActive)) timer = setTimeout(paint, 4000);
  }

  function remove(site, auditCount) {
    confirmAction({
      title: `Delete ${site.name}?`,
      text: `This deletes the site and everything under it: ${auditCount} ${auditCount === 1 ? 'audit' : 'audits'}, their crawls, evidence and recorded decisions. It cannot be undone.`,
      confirmLabel: 'Delete site',
      async onConfirm() {
        await api.del(`/sites/${site.id}`);
        toast(`${site.name} deleted.`);
        navigate('/sites');
      },
    });
  }

  root.append(h('p', { class: 'skeleton' }, 'Loading…'));
  await paint();
  return () => clearTimeout(timer);
}

function profileCard(site, corpus, refresh) {
  const stale = site.flags.length > 0 && site.profileCorpusVersion !== corpus.version;
  const unknown = site.flags.filter((f) => !corpus.knownFlags.includes(f));
  const policy = site.aiPolicy;
  return card({ title: 'Profile', actions: h('button', { class: 'btn small', type: 'button', onclick: () => openSiteForm(site, refresh) }, icon('edit', 13), 'Edit') },
    stale ? banner('warn', 'warn',
      `These flags were declared against methodology v${site.profileCorpusVersion ?? 'unknown'}, and audits now pin v${corpus.version}.`,
      'An audit refuses a profile declared against another version, because a new version can make a check conditional on a flag its author never saw. Review the flags and save to confirm them.') : null,
    unknown.length ? banner('fail', 'fail', `Flags v${corpus.version} does not know: ${unknown.join(', ')}. An audit refuses them.`) : null,
    h('dl', { class: 'kv' },
      h('dt', null, 'Profile'), h('dd', null, site.profile === 'core' ? 'Core' : 'Extended', h('span', { class: 'muted' }, ' — advisory; never changes what blocks launch')),
      h('dt', null, 'Flags'), h('dd', null, site.flags.length
        ? h('div', { class: 'chips' }, site.flags.map((f) => h('span', { class: 'badge outline' }, f)))
        : h('span', { class: 'muted' }, 'None — every conditional check stays at "scope undecided" until a person decides it')),
      h('dt', null, 'AI crawler policy'), h('dd', null, policy
        ? [h('div', { class: 'chips' }, Object.entries(policy.agents).map(([agent, stance]) =>
            h('span', { class: `badge ${stance === 'allow' ? 'pass' : 'neutral'}` }, icon(stance === 'allow' ? 'pass' : 'minus', 12), `${agent}: ${stance}`))),
          h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } }, `Approved by ${policy.approvedBy} on ${policy.approvedAt}`)]
        : h('span', { class: 'muted' }, 'None recorded — the AI crawler check is not applicable without one')),
      h('dt', null, 'Added'), h('dd', null, date(site.createdAt))));
}

function trendCard(audits) {
  const points = [...audits].reverse()
    .map((a) => ({ id: a.id, at: a.createdAt, pct: overallPercent(a.readiness?.progress), decision: a.readiness?.readiness.decision }))
    .filter((p) => p.pct !== null);
  if (points.length < 2) {
    return card({ title: 'Readiness over time' }, empty(points.length === 0 ? 'No graded audits yet' : 'One graded audit so far', 'The trend appears once there are two graded audits to compare.'));
  }
  const w = 420;
  const hgt = 150;
  const pad = { l: 34, r: 12, t: 12, b: 22 };
  const x = (i) => pad.l + (i * (w - pad.l - pad.r)) / (points.length - 1);
  const y = (pct) => pad.t + ((100 - pct) / 100) * (hgt - pad.t - pad.b);
  const grid = [0, 50, 100].map((v) => [
    s('line', { x1: pad.l, x2: w - pad.r, y1: y(v), y2: y(v), stroke: 'var(--rule)', 'stroke-width': 1 }),
    s('text', { x: pad.l - 6, y: y(v), 'text-anchor': 'end', 'dominant-baseline': 'central', 'font-size': 11, fill: 'var(--muted)' }, `${v}%`),
  ]);
  const line = s('polyline', { points: points.map((p, i) => `${x(i)},${y(p.pct)}`).join(' '), fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2, 'stroke-linejoin': 'round' });
  const dots = points.map((p, i) => {
    const color = p.decision === 'GO' ? 'var(--pass)' : 'var(--fail)';
    const g = s('a', { href: `#/audits/${p.id}` },
      s('circle', { cx: x(i), cy: y(p.pct), r: 10, fill: 'transparent' }),
      s('circle', { cx: x(i), cy: y(p.pct), r: 4.5, fill: color, stroke: 'var(--surface)', 'stroke-width': 2 }),
      s('title', null, `${dateTime(p.at)} — ${p.pct}% · ${p.decision}`));
    return g;
  });
  const first = points[0];
  const last = points[points.length - 1];
  return card({ title: 'Readiness over time', hint: 'overall percent complete per graded audit' },
    s('svg', { viewBox: `0 0 ${w} ${hgt}`, width: '100%', role: 'img', 'aria-label': `From ${first.pct}% to ${last.pct}% over ${points.length} graded audits` },
      grid, line, dots,
      s('text', { x: pad.l, y: hgt - 4, 'font-size': 11, fill: 'var(--muted)' }, date(first.at)),
      s('text', { x: w - pad.r, y: hgt - 4, 'font-size': 11, fill: 'var(--muted)', 'text-anchor': 'end' }, date(last.at))),
    h('div', { class: 'ring-legend' },
      h('span', null, h('i', { class: 'swatch', style: { background: 'var(--pass)', borderRadius: '50%' } }), 'GO'),
      h('span', null, h('i', { class: 'swatch', style: { background: 'var(--fail)', borderRadius: '50%' } }), 'HOLD'),
      h('span', null, `Latest ${last.pct}%, ${last.pct - first.pct >= 0 ? '+' : ''}${last.pct - first.pct} since ${date(first.at)}`)));
}

export { hostOf };
