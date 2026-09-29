// The database setup page (setup.html). A classic script, not a module: the
// page loads from file://, where Chromium refuses module scripts.
//
// The desktop shell owns the address and the settings file; this page only
// shows what `seoDesktop.database.state()` reports and hands back the fields.
// Problems land beside the field they belong to, all at once.

(() => {
  const bridge = window.seoDesktop && window.seoDesktop.database;
  const $ = (id) => document.getElementById(id);
  const form = $('form');
  const inputs = {
    host: $('f-host'),
    port: $('f-port'),
    database: $('f-database'),
    user: $('f-user'),
    password: $('f-password'),
    ssl: $('f-ssl'),
  };

  const ICON_PATHS = {
    fail: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18', 'M12 7.5v5.5', 'M12 16.2v.3'],
    warn: ['M12 3.5 2.5 20h19z', 'M12 10v4.5', 'M12 17.2v.3'],
    info: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18', 'M12 11v5', 'M12 7.8v.3'],
  };
  function icon(name, size) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) {
      svg.setAttribute(k, String(v));
    }
    for (const d of ICON_PATHS[name]) {
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }
  function el(tag, cls, ...children) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    for (const child of children) if (child !== null && child !== undefined) node.append(child);
    return node;
  }
  function banner(kind, iconName, ...lines) {
    const box = el('div', `banner ${kind}`, icon(iconName, 18), el('div', null, ...lines.map((l) => (typeof l === 'string' ? el('p', null, l) : l))));
    box.setAttribute('role', kind === 'fail' ? 'alert' : 'status');
    return box;
  }

  function setFields(fields) {
    inputs.host.value = fields.host;
    inputs.port.value = fields.port;
    inputs.database.value = fields.database;
    inputs.user.value = fields.user;
    inputs.password.value = fields.password;
    inputs.ssl.checked = fields.ssl;
  }
  function readFields() {
    return {
      host: inputs.host.value,
      port: inputs.port.value,
      database: inputs.database.value,
      user: inputs.user.value,
      password: inputs.password.value,
      ssl: inputs.ssl.checked,
    };
  }

  function clearProblems() {
    for (const field of form.querySelectorAll('.field')) {
      field.classList.remove('invalid');
      field.querySelector('.problems').replaceChildren();
    }
    $('form-error').replaceChildren();
  }
  function showProblem(name, text) {
    const field = form.querySelector(`.field[data-field="${name}"]`);
    field.classList.add('invalid');
    field.querySelector('.problems').append(el('p', 'problem', icon('fail', 13), text));
  }

  /** A pasted URL, spread over the fields. The shell re-checks whatever is submitted. */
  function applyPaste() {
    const text = $('f-paste').value.trim();
    const field = form.querySelector('.field[data-field="paste"]');
    field.classList.remove('invalid');
    field.querySelector('.problems').replaceChildren();
    if (text === '') return;
    let url;
    try {
      url = new URL(text);
    } catch {
      url = null;
    }
    if (!url || !/^postgres(ql)?:$/.test(url.protocol)) {
      showProblem('paste', 'Expected a URL starting postgres:// or postgresql://.');
      return;
    }
    const sslmode = url.searchParams.get('sslmode') || url.searchParams.get('ssl');
    setFields({
      host: decodeURIComponent(url.hostname),
      port: url.port,
      database: decodeURIComponent(url.pathname.replace(/^\//, '')),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      ssl: sslmode !== null && !['disable', 'false', 'allow', 'prefer'].includes(sslmode),
    });
    $('f-paste').value = '';
    $('status').textContent = 'Filled in from the URL. Check the fields, then connect.';
  }

  let state = null;

  function paint() {
    const notices = $('notices');
    notices.replaceChildren();
    if (state.connected) {
      $('title').textContent = 'Database';
      $('sub').textContent = `Connected to ${state.tried}. Connecting somewhere else restarts the app; audits in progress carry on after it.`;
      $('connect').textContent = 'Connect and restart';
      $('back').hidden = false;
    } else if (state.error) {
      notices.append(banner('fail', 'fail',
        'SEO Optimizer could not reach its database.',
        el('p', 'muted', `Tried ${state.tried}: ${state.error}`)));
    }
    if (state.fromEnvironment) {
      notices.append(banner('warn', 'warn',
        'DATABASE_URL is also set in this computer’s environment, and that one wins when the app starts.',
        el('p', 'muted', 'What you connect to here lasts until the app closes. Remove the environment variable to make it stick.')));
    }
    $('env-path').textContent = state.envPath;
    if (state.version) $('version').textContent = `v${state.version}`;
  }

  async function connect(event) {
    event.preventDefault();
    clearProblems();
    const button = $('connect');
    button.disabled = true;
    $('status').textContent = state && state.connected ? 'Checking the new database…' : 'Connecting… this can take a few seconds.';
    try {
      const result = await bridge.connect(readFields());
      if (result.problems) {
        for (const [name, text] of Object.entries(result.problems)) showProblem(name, text);
        $('status').textContent = '';
        form.querySelector('.field.invalid input')?.focus();
      } else if (result.error) {
        $('form-error').append(banner('fail', 'fail', 'It did not connect.', el('p', 'muted', result.error)));
        $('status').textContent = '';
      } else if (result.restarting) {
        $('status').textContent = 'Connected. Restarting…';
        return;
      } else {
        $('status').textContent = 'Connected. Opening the app…';
        return;
      }
    } catch (error) {
      $('form-error').append(banner('fail', 'fail', String((error && error.message) || error)));
      $('status').textContent = '';
    }
    button.disabled = false;
  }

  if (!bridge) {
    $('setup-body').hidden = true;
    $('notices').append(banner('info', 'info', 'This page belongs to the desktop app.', el('p', 'muted', 'In the browser dashboard, the database is whatever DATABASE_URL the API server was started with.')));
    return;
  }

  form.addEventListener('submit', connect);
  $('f-paste').addEventListener('change', applyPaste);
  $('f-paste').addEventListener('paste', () => setTimeout(applyPaste, 0));
  $('local').addEventListener('click', () => {
    clearProblems();
    setFields(state.defaults);
    $('status').textContent = 'The local stack’s address is filled in. Start it with npm run stack:up, then connect.';
  });
  $('back').addEventListener('click', () => bridge.back());
  $('quit').addEventListener('click', () => bridge.quit());
  $('folder').addEventListener('click', () => bridge.openFolder());

  // A release that fixes whatever stops the app connecting can still arrive here.
  if (window.seoDesktop.onUpdateStatus) {
    window.seoDesktop.onUpdateStatus((status) => {
      const ready = status.state === 'ready';
      const text = ready ? `v${status.version} is ready to install.`
        : status.state === 'downloading' ? `Downloading v${status.version} — ${Math.round(status.percent || 0)}%`
        : null;
      $('update').hidden = text === null;
      $('update-text').textContent = text || '';
      $('update-restart').hidden = !ready;
      if (ready) $('update-restart').textContent = `Update to v${status.version}`;
    });
    $('update-restart').addEventListener('click', () => window.seoDesktop.restartToUpdate());
  }

  bridge.state().then((s) => {
    state = s;
    setFields(s.fields);
    paint();
    (s.error ? inputs.host : $('connect')).focus();
  });
})();
