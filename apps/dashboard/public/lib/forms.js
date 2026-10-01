// The two forms most journeys start from: a site (create or edit) and an
// audit. Validation is the API's; these only collect and send.

import { h } from './dom.js';
import { icon } from './icons.js';
import { api, ApiError } from './api.js';
import { getCorpus } from './corpus.js';
import { banner, field, modal, toast } from './ui.js';
import { navigate } from './router.js';

const KNOWN_AGENTS = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'PerplexityBot', 'Google-Extended', 'CCBot', 'Bytespider', 'Applebot-Extended'];

/** Add a site, or edit one when `site` is given. Resolves with the saved row. */
export async function openSiteForm(site, onSaved) {
  const corpus = await getCorpus();
  const chosen = new Set(site?.flags ?? []);

  const name = h('input', { type: 'text', name: 'name', value: site?.name ?? '', placeholder: 'Marketing site', autocomplete: 'off' });
  const origin = h('input', { type: 'url', name: 'origin', value: site?.origin ?? '', placeholder: 'https://www.example.com', autocomplete: 'off' });
  const profile = h('select', { name: 'profile' },
    h('option', { value: 'core', selected: (site?.profile ?? 'core') === 'core' }, 'Core — the work a small team commonly still runs'),
    h('option', { value: 'extended', selected: site?.profile === 'extended' }, 'Extended — depth for an agency, specialist or regulated context'));

  // Flags: a picker over the corpus's own vocabulary, never free text.
  const filter = h('input', { type: 'text', class: 'input', placeholder: 'Filter flags', 'aria-label': 'Filter flags' });
  const opts = h('div', { class: 'opts' }, corpus.knownFlags.map((flag) =>
    h('label', { dataset: { flag } },
      h('input', { type: 'checkbox', value: flag, checked: chosen.has(flag), onchange: (e) => (e.target.checked ? chosen.add(flag) : chosen.delete(flag)) }),
      flag)));
  filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    for (const label of opts.children) label.hidden = q !== '' && !label.dataset.flag.includes(q);
  });
  const unknown = (site?.flags ?? []).filter((f) => !corpus.knownFlags.includes(f));
  const flags = h('div', { class: 'flag-picker' }, filter, opts,
    unknown.length ? banner('warn', 'warn', `Not recognised by methodology v${corpus.version}: ${unknown.join(', ')}. An audit refuses a flag it does not know; uncheck it by saving without it.`) : null);

  // AI crawler policy: a business decision, optional, recorded with who and when.
  const policy = site?.aiPolicy ?? null;
  const policyOn = h('input', { type: 'checkbox', checked: policy !== null });
  const agentRows = h('div', { class: 'grid', style: { gap: '8px' } });
  const addAgent = (agent = '', stance = 'disallow') => {
    const row = h('div', { class: 'agent-row' },
      h('input', { type: 'text', class: 'input', value: agent, list: 'ai-agents', placeholder: 'Crawler, e.g. GPTBot', 'aria-label': 'Crawler' }),
      h('select', { class: 'select', 'aria-label': 'Stance' },
        h('option', { value: 'allow', selected: stance === 'allow' }, 'Allow'),
        h('option', { value: 'disallow', selected: stance === 'disallow' }, 'Disallow')),
      h('button', { class: 'btn ghost small', type: 'button', 'aria-label': 'Remove crawler', onclick: () => row.remove() }, icon('x', 14)));
    agentRows.append(row);
  };
  for (const [agent, stance] of Object.entries(policy?.agents ?? {})) addAgent(agent, stance);
  if (!policy) addAgent('GPTBot');
  const approvedBy = h('input', { type: 'text', value: policy?.approvedBy ?? '', placeholder: 'Who approved it' });
  const approvedAt = h('input', { type: 'date', value: policy?.approvedAt ?? '' });
  const policyBody = h('div', { class: 'grid', style: { gap: '10px' }, hidden: policy === null },
    agentRows,
    h('div', null, h('button', { class: 'link-btn', type: 'button', onclick: () => addAgent() }, icon('plus', 14), 'Add a crawler')),
    h('div', { class: 'row2' }, field('aiPolicy.approvedBy', 'Approved by', approvedBy), field('aiPolicy.approvedAt', 'Approved on', approvedAt)),
    h('datalist', { id: 'ai-agents' }, KNOWN_AGENTS.map((a) => h('option', { value: a }))));
  policyOn.addEventListener('change', () => (policyBody.hidden = !policyOn.checked));

  modal({
    title: site ? `Edit ${site.name}` : 'Add a site',
    submitLabel: site ? 'Save changes' : 'Add site',
    body: [
      h('div', { class: 'row2' }, field('name', 'Name', name), field('origin', 'Origin', origin, 'Scheme and host, no path.')),
      field('profile', 'Profile', profile, 'Advisory effort scoping. It never changes what blocks launch.'),
      field('flags', 'Site flags', flags,
        'Flags bring conditional checks into scope. Once any flag is set, a check whose flags the site lacks is excluded — so a missing flag removes checks, it does not add them.'),
      h('div', { class: 'field', dataset: { field: 'aiPolicy' } },
        h('label', { class: 'check-line' }, policyOn, h('span', null, h('b', null, 'Record an AI crawler policy'), h('span', { class: 'muted' }, ' — which AI crawlers the owners want in or out. The crawl cannot observe this.'))),
        policyBody,
        h('div', { class: 'problems' })),
    ],
    async onSubmit() {
      const body = {
        name: name.value.trim(),
        origin: origin.value.trim(),
        profile: profile.value,
        flags: [...chosen].sort(),
        // A profile is a statement about the conditions its author could see.
        profileCorpusVersion: chosen.size > 0 ? corpus.version : null,
      };
      if (policyOn.checked) {
        const agents = {};
        for (const row of agentRows.children) {
          const [agentEl, stanceEl] = row.querySelectorAll('input, select');
          if (agentEl.value.trim()) agents[agentEl.value.trim()] = stanceEl.value;
        }
        body.aiPolicy = { agents, approvedBy: approvedBy.value.trim(), approvedAt: approvedAt.value };
      } else if (policy !== null) {
        body.aiPolicy = null;
      }
      const saved = site ? await api.patch(`/sites/${site.id}`, body) : await api.post('/sites', body);
      toast(site ? 'Site saved.' : `${saved.name} added.`);
      onSaved?.(saved);
    },
  });
}

/** Start an audit. Only settings a person changed are sent; the rest are the engine's defaults. */
export async function openAuditForm(siteId) {
  const [corpus, { sites }] = await Promise.all([getCorpus(), api.get('/sites')]);
  if (sites.length === 0) {
    toast('Add a site first — an audit runs against one.', 'error');
    return;
  }

  const site = h('select', { name: 'siteId' }, sites.map((s) =>
    h('option', { value: s.id, selected: s.id === siteId }, `${s.name} — ${s.origin}`)));
  const version = h('input', { type: 'text', value: corpus.version, inputmode: 'decimal' });
  const release = h('input', { type: 'text', placeholder: 'e.g. 2026.10 (optional)' });
  const maxPages = h('input', { type: 'number', min: 1, placeholder: '200' });
  const maxDepth = h('input', { type: 'number', min: 0, placeholder: '5' });
  const delay = h('input', { type: 'number', min: 0, placeholder: '0' });
  const robots = h('input', { type: 'checkbox', checked: true });
  const sitemaps = h('input', { type: 'checkbox', checked: true });
  const render = h('input', { type: 'checkbox' });

  modal({
    title: 'Run an audit',
    submitLabel: 'Start audit',
    body: [
      field('siteId', 'Site', site),
      h('div', { class: 'row2' },
        field('corpusVersion', 'Methodology version', version, `The audit is pinned to it for good. Current: v${corpus.version}.`),
        field('release', 'Release', release, 'Name a release on record to also assess READY FOR CUTOVER.')),
      h('details', { class: 'advanced' },
        h('summary', null, 'Crawl settings'),
        h('div', null,
          h('div', { class: 'row3' },
            field('crawl.maxPages', 'Page budget', maxPages),
            field('crawl.maxDepth', 'Max depth', maxDepth),
            field('crawl.requestDelayMs', 'Delay between requests (ms)', delay)),
          h('label', { class: 'check-line' }, robots, 'Respect robots.txt'),
          h('label', { class: 'check-line' }, sitemaps, 'Follow sitemaps'),
          h('label', { class: 'check-line' }, render, 'Render pages in a headless browser (slower; needed for script-built pages, accessibility and the phone view)'))),
    ],
    async onSubmit() {
      const crawl = {};
      if (maxPages.value !== '') crawl.maxPages = Number(maxPages.value);
      if (maxDepth.value !== '') crawl.maxDepth = Number(maxDepth.value);
      if (delay.value !== '') crawl.requestDelayMs = Number(delay.value);
      if (!robots.checked) crawl.respectRobots = false;
      if (!sitemaps.checked) crawl.followSitemaps = false;
      // One box for all three, as `npm run analyze -- --render` is: the page as
      // a browser builds it, axe-core on it, and the same page as a phone.
      if (render.checked) Object.assign(crawl, { renderPages: true, renderAccessibility: true, renderMobile: true });
      const body = { siteId: site.value, corpusVersion: version.value.trim() };
      if (release.value.trim()) body.release = release.value.trim();
      if (Object.keys(crawl).length > 0) body.crawl = crawl;
      const { auditId } = await api.post('/audits', body);
      toast('Audit queued. It runs in the background.');
      navigate(`/audits/${auditId}`);
    },
  });
}

export { ApiError };
