// The methodology itself, check by check: what each asks, how it is tested,
// who owns it, and whether it can block launch.

import { h, fill } from '../lib/dom.js';
import { getCorpus, compareIds } from '../lib/corpus.js';
import { date } from '../lib/format.js';
import { card, errorPanel, pageHead } from '../lib/ui.js';
import { isCurrent } from '../lib/router.js';
import { checkDetail } from '../lib/check-detail.js';
import { checkTable, filtersFrom } from '../lib/check-table.js';

export async function checksView(root, _params, query, token) {
  let corpus;
  try {
    corpus = await getCorpus(query.v || undefined);
  } catch (error) {
    if (isCurrent(token)) fill(root, pageHead({ title: 'Checks' }), errorPanel(error, () => checksView(root, _params, query, token)));
    return;
  }
  if (!isCurrent(token)) return;

  const filters = filtersFrom(query);
  let selected = query.check ?? null;
  const rows = [...corpus.checks].sort((a, b) => compareIds(a.id, b.id)).map((check) => ({ check, state: null }));
  const workspace = h('div', { class: 'workspace' });
  const tableCard = card({ title: 'Checks', hint: `${corpus.gateCount} are launch gates`, flush: true });

  const table = checkTable({
    corpus, rows, filters, withState: false,
    selected: () => selected,
    onSelect: (id) => { selected = id; paintDetail(); table.markSelected(); },
    extraQuery: query.v ? { v: query.v } : {},
  });
  tableCard.querySelector('.card-body').append(table.el);

  function paintDetail() {
    const check = corpus.byId.get(selected);
    workspace.classList.toggle('open', Boolean(check));
    fill(workspace, tableCard, check
      ? checkDetail(check, { onClose: () => { selected = null; paintDetail(); table.markSelected(); } })
      : null);
  }
  paintDetail();

  fill(root,
    pageHead({
      title: 'Checks',
      sub: `Methodology v${corpus.version}, reviewed ${date(corpus.reviewed)}: ${corpus.checks.length} checks in ${corpus.phases.length} lifecycle phases, evidenced by ${corpus.detectorCount} detectors.`,
    }),
    workspace,
  );
}
