// The three small charts the app draws: a phase ring, the automation-tier
// donut, and a percent bar. Each is one value or one part-of-whole, so each
// carries its number as text beside the mark and a native tooltip.

import { h, s } from './dom.js';
import { icon } from './icons.js';
import { plural } from './format.js';

/**
 * One lifecycle phase: percent complete as a ring. The ring's colour says the
 * phase's state, never its score: red while anything in it failed, green
 * when complete, accent while under way, grey when nothing in it is active.
 */
export function phaseRing(phase, label, progress, { onClick, pressed } = {}) {
  const size = 64;
  const r = 27;
  const c = 2 * Math.PI * r;
  const active = progress?.active ?? 0;
  const pct = active > 0 ? progress.percentComplete : null;
  const color =
    pct === null ? 'var(--neutral)'
    : progress.failed > 0 ? 'var(--fail)'
    : pct >= 100 ? 'var(--pass)'
    : 'var(--accent)';

  const tip = progress
    ? [
        `Phase ${phase} — ${label}`,
        `${progress.passed} passed · ${progress.failed} failed · ${progress.inProgress} in progress · ${progress.notStarted} not started`,
        progress.skipped ? `${progress.skipped} skipped` : null,
        progress.scopeReview ? `${progress.scopeReview} scope undecided` : null,
        `${active} of the phase's checks in scope`,
      ].filter(Boolean).join('\n')
    : `Phase ${phase} — ${label}`;

  const svg = s(
    'svg',
    { width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': pct === null ? 'nothing in scope' : `${pct}% complete` },
    s('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: 'var(--track)', 'stroke-width': 7 }),
    pct === null
      ? null
      : s('circle', {
          cx: size / 2, cy: size / 2, r, fill: 'none', stroke: color, 'stroke-width': 7,
          'stroke-linecap': pct > 0 && pct < 100 ? 'round' : 'butt',
          'stroke-dasharray': `${(c * Math.max(0, Math.min(100, pct))) / 100} ${c}`,
          transform: `rotate(-90 ${size / 2} ${size / 2})`,
        }),
    s('text', { x: '50%', y: '50%', 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'pct' }, pct === null ? '—' : `${pct}%`),
  );

  const note = progress?.failed
    ? h('span', { class: 'note' }, icon('fail', 12), `${progress.failed} failed`)
    : progress?.scopeReview
      ? h('span', { class: 'note' }, `${progress.scopeReview} scope undecided`)
      : null;

  const body = [svg, h('span', { class: 'lbl' }, h('b', null, phase), label, active ? h('span', { class: 'muted' }, ` (${active})`) : null), note];
  return onClick
    ? h('button', { class: 'ring', type: 'button', title: tip, onclick: onClick, 'aria-pressed': String(Boolean(pressed)) }, body)
    : h('div', { class: 'ring', title: tip }, body);
}

export function ringLegend() {
  const item = (color, text) => h('span', null, h('i', { class: 'swatch', style: { background: color } }), text);
  return h('div', { class: 'ring-legend', 'aria-label': 'Ring colours' },
    item('var(--accent)', 'Under way'),
    item('var(--fail)', 'Something failed'),
    item('var(--pass)', 'Complete'),
    item('var(--neutral)', 'Nothing in scope'),
  );
}

/** Part of whole as a donut with a 2px surface gap between segments, and a legend with counts. */
export function donut(parts, total, centerLabel) {
  const size = 180;
  const r = 70;
  const stroke = 28;
  const c = 2 * Math.PI * r;
  const gap = parts.filter((p) => p.value > 0).length > 1 ? 2 : 0;
  let offset = 0;
  const arcs = parts.map((p) => {
    const len = (p.value / total) * c;
    const arc = s('circle', {
      cx: size / 2, cy: size / 2, r, fill: 'none', stroke: p.color, 'stroke-width': stroke,
      'stroke-dasharray': `${Math.max(0, len - gap)} ${c}`,
      'stroke-dashoffset': -offset,
      transform: `rotate(-90 ${size / 2} ${size / 2})`,
    }, s('title', null, `${p.label}: ${p.value} (${((p.value / total) * 100).toFixed(1)}%)`));
    offset += len;
    return arc;
  });
  const svg = s('svg', { class: 'donut', width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': parts.map((p) => `${p.label} ${p.value}`).join(', ') },
    s('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: 'var(--track)', 'stroke-width': stroke }),
    arcs,
    s('text', { x: '50%', y: '46%', 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'center-n' }, total),
    s('text', { x: '50%', y: '62%', 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'center-l' }, centerLabel),
  );
  const legend = h('ul', { class: 'legend' }, parts.map((p) =>
    h('li', null,
      h('i', { class: 'swatch', style: { background: p.color } }),
      h('span', null, h('b', null, p.value), ' ', p.label, h('span', { class: 'muted' }, ` (${((p.value / total) * 100).toFixed(1)}%)`)),
      h('span', { class: 'what' }, p.what),
    )));
  return h('div', { class: 'donut-wrap' }, svg, legend);
}

/** A percent as a thin bar with its value beside it; `null` shows a dash, not an empty bar. */
export function percentBar(pct, title) {
  if (pct === null || pct === undefined) return h('span', { class: 'muted' }, '—');
  return h('div', { class: 'pbar', title },
    h('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 },
      h('span', { style: { width: `${Math.max(0, Math.min(100, pct))}%` } })),
    h('span', { class: 'v' }, `${pct}%`));
}

/** Pages fetched against the crawl's page budget. */
export function crawlBar(crawl) {
  const pct = Math.min(100, Math.round((crawl.pagesFetched / Math.max(1, crawl.maxPages)) * 100));
  return h('div', { class: 'pbar', title: `${plural(crawl.pagesFetched, 'page')} of a ${crawl.maxPages}-page budget` },
    h('div', { class: 'bar' }, h('span', { style: { width: `${pct}%` } })),
    h('span', { class: 'v' }, `${crawl.pagesFetched} / ${crawl.maxPages}`));
}
