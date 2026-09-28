// Shared pieces every view is built from: cards, empty and error states, a
// modal form with problems shown by field, a confirm step, and toasts.

import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { ApiError, isUnreachable } from './api.js';

export function card({ title, hint, more, actions, flush, id }, ...body) {
  return h('section', { class: 'card', id },
    title ? h('header', { class: 'card-head' },
      h('h2', null, title, hint ? h('span', { class: 'hint' }, hint) : null),
      h('div', { class: 'actions' }, actions, more ? h('a', { class: 'more', href: more.href }, more.label, icon('arrow', 14)) : null)) : null,
    h('div', { class: flush ? 'card-body flush' : 'card-body' }, body));
}

export function pageHead({ title, sub, crumbs, actions }) {
  return h('header', { class: 'page-head' },
    h('div', null, crumbs ? h('div', { class: 'crumbs' }, crumbs) : null, h('h1', null, title), sub ? h('p', { class: 'sub' }, sub) : null),
    actions ? h('div', { class: 'actions' }, actions) : null);
}

export function empty(title, text, action) {
  return h('div', { class: 'empty' }, h('h3', null, title), text ? h('p', null, text) : null, action);
}

export function banner(kind, iconName, ...lines) {
  return h('div', { class: `banner ${kind}`, role: kind === 'fail' ? 'alert' : 'status' },
    icon(iconName, 18), h('div', null, lines.map((l) => (typeof l === 'string' ? h('p', null, l) : l))));
}

/**
 * The page a view shows when it could not load. A database the API cannot
 * reach gets an explanation and where to fix it, not an empty list.
 */
export function errorPanel(error, retry) {
  if (error instanceof ApiError && (error.status === 0 || error.status === 502)) {
    return card({ title: 'The audit engine is not answering' },
      banner('fail', 'fail', 'The window is up, but the engine behind it did not answer. Restarting the app usually brings it back.', h('p', { class: 'muted' }, `Details: ${error.message}`)),
      retry ? h('button', { class: 'btn', type: 'button', onclick: retry }, icon('refresh', 16), 'Try again') : null);
  }
  if (isUnreachable(error)) {
    return card({ title: 'The database is not answering' },
      banner('fail', 'database',
        'SEO Optimizer keeps sites and audits in a Postgres database, and it could not reach it.',
        h('p', { class: 'muted' }, `Details: ${error.message}`)),
      h('p', null, 'Start the database (', h('code', { class: 'mono' }, 'npm run stack:up'), ' from a checkout), or point the app at another one by setting ',
        h('code', { class: 'mono' }, 'DATABASE_URL'), ' in the app’s settings file, ',
        h('code', { class: 'mono' }, '%APPDATA%\\SEO Optimizer\\.env'), ', then restart the app.'),
      retry ? h('button', { class: 'btn', type: 'button', onclick: retry }, icon('refresh', 16), 'Try again') : null);
  }
  return card({ title: 'Something went wrong' },
    banner('fail', 'fail', error instanceof ApiError ? error.message : String(error?.message ?? error)),
    retry ? h('button', { class: 'btn', type: 'button', onclick: retry }, icon('refresh', 16), 'Try again') : null);
}

/* ---------- Toasts ---------- */

export function toast(message, kind = 'info') {
  let root = document.getElementById('toasts');
  if (!root) document.body.append((root = h('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite' })));
  const el = h('div', { class: `toast ${kind}` }, message);
  root.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 4000);
}

/* ---------- Fields ---------- */

/** A labelled field whose problems the modal fills in by `name`. */
export function field(name, label, control, help) {
  const id = `f-${name}-${Math.random().toString(36).slice(2, 7)}`;
  if (control instanceof HTMLElement && !control.id && /^(INPUT|SELECT|TEXTAREA)$/.test(control.tagName)) control.id = id;
  return h('div', { class: 'field', dataset: { field: name } },
    h(control.id ? 'label' : 'div', control.id ? { for: control.id } : { class: 'label' }, label),
    control,
    help ? h('p', { class: 'help' }, help) : null,
    h('div', { class: 'problems' }));
}

function showProblems(form, error) {
  for (const el of form.querySelectorAll('.field')) {
    el.classList.remove('invalid');
    clear(el.querySelector('.problems'));
  }
  const general = form.querySelector('.form-error');
  clear(general);
  if (!error) return;

  const byField = error instanceof ApiError ? error.byField() : {};
  const unplaced = [];
  for (const [name, texts] of Object.entries(byField)) {
    // The field the path names, or the one holding it: `aiPolicy.agents` lands on `aiPolicy`.
    const target =
      form.querySelector(`.field[data-field="${CSS.escape(name)}"]`) ??
      form.querySelector(`.field[data-field="${CSS.escape(name.split(/[.[]/)[0])}"]`);
    if (!target) {
      unplaced.push(...texts.map((t) => (name ? `${name}: ${t}` : t)));
      continue;
    }
    target.classList.add('invalid');
    target.querySelector('.problems').append(...texts.map((t) => h('p', { class: 'problem' }, icon('fail', 13), t)));
  }
  if (unplaced.length > 0 || Object.keys(byField).length === 0) {
    general.append(banner('fail', 'fail', error.message, ...unplaced));
  }
  form.querySelector('.field.invalid input, .field.invalid select, .field.invalid textarea')?.focus();
}

/* ---------- Modal ---------- */

/**
 * A form in a dialog. `onSubmit` returns normally to close, or throws: an
 * ApiError's problems land beside their fields, every one at once (R10).
 */
export function modal({ title, body, submitLabel = 'Save', danger = false, onSubmit, wide }) {
  const dialog = h('dialog', { class: 'modal', style: wide ? { width: 'min(760px, calc(100vw - 32px))' } : undefined });
  const submit = h('button', { class: danger ? 'btn danger solid' : 'btn primary', type: 'submit' }, submitLabel);
  const form = h('form', { method: 'dialog', novalidate: true },
    h('div', { class: 'modal-head' },
      h('h2', null, title),
      h('button', { class: 'btn ghost small', type: 'button', 'aria-label': 'Close', onclick: () => dialog.close() }, icon('x', 16))),
    h('div', { class: 'modal-body' }, h('div', { class: 'form-error' }), body),
    h('div', { class: 'modal-foot' },
      h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Cancel'),
      submit));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      await onSubmit(form);
      dialog.close();
    } catch (error) {
      showProblems(form, error);
    } finally {
      submit.disabled = false;
    }
  });

  dialog.append(form);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  form.querySelector('input:not([type=hidden]), select, textarea')?.focus();
  return dialog;
}

/** An in-page confirm step for something that cannot be undone. */
export function confirmAction({ title, text, confirmLabel, onConfirm }) {
  return modal({ title, body: h('p', { style: { margin: 0 } }, text), submitLabel: confirmLabel, danger: true, onSubmit: onConfirm });
}
