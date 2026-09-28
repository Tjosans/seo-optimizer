// SEO Optimizer's interface: plain browser JS, no build step and no
// framework. It talks to the audit API through the dashboard server's
// same-origin `/api` proxy (server.ts); every fact on screen came from an
// API response, and this file only wires the shell and the routes together.

import { h, clear } from './lib/dom.js';
import { icon } from './lib/icons.js';
import { getCorpus } from './lib/corpus.js';
import { date } from './lib/format.js';
import { route, start } from './lib/router.js';
import { dashboardView } from './views/dashboard.js';
import { sitesView, siteView } from './views/sites.js';
import { auditsView, latestResultsView } from './views/audits.js';
import { auditView } from './views/audit.js';
import { checksView } from './views/checks.js';
import { compareView } from './views/compare.js';
import { settingsView } from './views/settings.js';

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: 'home', href: '#/' },
  { id: 'sites', label: 'Sites', icon: 'globe', href: '#/sites' },
  { id: 'audits', label: 'Audits', icon: 'audits', href: '#/audits' },
  { id: 'results', label: 'Results', icon: 'results', href: '#/results' },
  { id: 'checks', label: 'Checks', icon: 'checks', href: '#/checks' },
  { id: 'compare', label: 'Compare', icon: 'compare', href: '#/compare' },
  { id: 'settings', label: 'Settings', icon: 'settings', href: '#/settings' },
];

const nav = document.getElementById('nav');
nav.append(...NAV.map((item) => h('a', { href: item.href, dataset: { nav: item.id } }, icon(item.icon, 19), item.label)));

function highlight(id) {
  for (const a of nav.children) {
    if (a.dataset.nav === id) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

route('/', dashboardView, 'dashboard');
route('/sites', sitesView, 'sites');
route('/sites/:id', siteView, 'sites');
route('/audits', auditsView, 'audits');
route('/audits/:id', auditView, 'results');
route('/results', latestResultsView, 'results');
route('/checks', checksView, 'checks');
route('/compare', compareView, 'compare');
route('/settings', settingsView, 'settings');

start(document.getElementById('view'), highlight);

// The methodology the app grades against, in the sidebar's foot.
const methodology = document.getElementById('methodology');
getCorpus()
  .then((corpus) => {
    clear(methodology).append(
      h('i', { class: 'dot ok', title: 'Connected' }),
      h('b', null, `Methodology v${corpus.version}`),
      h('span'),
      h('span', null, `${corpus.checks.length} checks · ${corpus.detectorCount} detectors`),
      h('span'),
      h('span', null, `Reviewed ${date(corpus.reviewed)}`),
    );
  })
  .catch(() => {
    clear(methodology).append(h('i', { class: 'dot bad' }), h('span', null, 'Not connected'));
  });
