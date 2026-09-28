// Appearance, the app's version and updates, and whether the database answers.

import { h, fill } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { getCorpus } from '../lib/corpus.js';
import { date } from '../lib/format.js';
import { banner, card, pageHead } from '../lib/ui.js';
import { updateMessage } from '../version.js';

function currentTheme() {
  try {
    return localStorage.getItem('seo-theme') ?? 'system';
  } catch {
    return 'system';
  }
}

function setTheme(theme) {
  try {
    if (theme === 'system') localStorage.removeItem('seo-theme');
    else localStorage.setItem('seo-theme', theme);
  } catch {}
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

export async function settingsView(root) {
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Theme' });
  const paintSeg = () => fill(seg, ...[['system', 'Match Windows'], ['light', 'Light'], ['dark', 'Dark']].map(([value, label]) =>
    h('button', { type: 'button', 'aria-pressed': String(currentTheme() === value), onclick: () => { setTheme(value); paintSeg(); } }, label)));
  paintSeg();

  const connection = h('div', null, h('p', { class: 'muted' }, 'Checking…'));
  const about = h('dl', { class: 'kv' });
  const update = h('p', { class: 'muted', style: { margin: '10px 0 0' } });

  const paintUpdate = () => {
    const status = window.seoUpdateStatus;
    if (!window.seoDesktop) update.textContent = 'Updates are handled by the desktop app. This is the browser dashboard.';
    else update.textContent = (status && updateMessage(status)) ?? 'Up to date. The app checks for a new version on start and every hour.';
  };
  const onUpdate = () => paintUpdate();
  window.addEventListener('seo-update-status', onUpdate);
  paintUpdate();

  fill(root,
    pageHead({ title: 'Settings' }),
    h('div', { class: 'grid', style: { maxWidth: '760px' } },
      card({ title: 'Appearance' }, h('div', { class: 'field' }, h('span', { class: 'label' }, 'Theme'), seg)),
      card({ title: 'Database' }, connection),
      card({ title: 'About' }, about, update)),
  );

  const [corpus, sites] = await Promise.allSettled([getCorpus(), api.get('/sites')]);
  fill(about,
    h('dt', null, 'Version'), h('dd', null, window.seoVersion ? `v${window.seoVersion}` : '—'),
    h('dt', null, 'Methodology'), h('dd', null, corpus.status === 'fulfilled' ? `v${corpus.value.version}, reviewed ${date(corpus.value.reviewed)} — ${corpus.value.checks.length} checks, ${corpus.value.detectorCount} detectors` : '—'),
    h('dt', null, 'Source'), h('dd', null, h('a', { href: 'https://github.com/Tjosans/seo-optimizer', target: '_blank', rel: 'noreferrer' }, 'github.com/Tjosans/seo-optimizer ', icon('external', 12))));
  fill(connection, sites.status === 'fulfilled'
    ? banner('pass', 'database', `Connected. ${sites.value.sites.length} ${sites.value.sites.length === 1 ? 'site' : 'sites'} on record.`)
    : banner('fail', 'database', 'The database is not answering.', h('p', { class: 'muted' }, sites.reason?.message ?? '')),
  h('p', { class: 'muted', style: { margin: 0, fontSize: '13px' } }, 'The desktop app reads its database address from ', h('code', { class: 'mono' }, 'DATABASE_URL'), ' in ', h('code', { class: 'mono' }, '%APPDATA%\\SEO Optimizer\\.env'), '. Changing it takes a restart.'));

  return () => window.removeEventListener('seo-update-status', onUpdate);
}
