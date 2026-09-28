// Hash routes (`#/audits/<id>?check=1.4`), so the static server needs no
// fallback and a reload lands where the person was.

const routes = [];
let outlet = null;
let cleanup = null;
let onRoute = () => {};
let generation = 0;

/** `pattern` like `/sites/:id`; `view(root, params, query)` may return a cleanup function. */
export function route(pattern, view, nav) {
  const keys = [];
  const regex = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, key) => (keys.push(key), '([^/]+)'))}$`);
  routes.push({ regex, keys, view, nav });
}

export function navigate(path) {
  if (location.hash === `#${path}`) render();
  else location.hash = `#${path}`;
}

export function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  return { path, query: Object.fromEntries(new URLSearchParams(qs)) };
}

/** Rewrite the query in place, without re-rendering: for selection state a view already shows. */
export function replaceQuery(query) {
  const { path } = parseHash();
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  history.replaceState(null, '', `#${path}${qs ? `?${qs}` : ''}`);
}

/** Whether the view that asked is still the one on screen — async work checks before it paints. */
export const isCurrent = (token) => token === generation;

export async function render() {
  const { path, query } = parseHash();
  cleanup?.();
  cleanup = null;
  const token = ++generation;

  for (const r of routes) {
    const match = r.regex.exec(path);
    if (!match) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
    onRoute(r.nav);
    outlet.replaceChildren();
    window.scrollTo(0, 0);
    const result = await r.view(outlet, params, query, token);
    if (typeof result === 'function') {
      if (isCurrent(token)) cleanup = result;
      else result();
    }
    return;
  }
  navigate('/');
}

export function start(el, handleRoute) {
  outlet = el;
  onRoute = handleRoute;
  window.addEventListener('hashchange', render);
  render();
}
