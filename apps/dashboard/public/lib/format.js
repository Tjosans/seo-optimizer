// Dates, durations and labels as a person reads them.

const pad = (n) => String(n).padStart(2, '0');

/** 2026-09-28 14:32, in the viewer's own time zone. */
export function dateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function date(value) {
  if (!value) return '—';
  const d = new Date(value);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 4m 26s — from `startedAt` to `finishedAt`, or to now while running. */
export function duration(start, end) {
  if (!start) return '—';
  const ms = (end ? new Date(end) : new Date()) - new Date(start);
  if (!(ms >= 0)) return '—';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${pad(sec)}s`;
  return `${sec}s`;
}

/** "3 h ago", coarse on purpose. */
export function ago(value) {
  if (!value) return '';
  const minutes = Math.round((Date.now() - new Date(value)) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** `trust-safety` → "Trust & safety", `seo` → "SEO". */
export function roleLabel(role) {
  const special = { seo: 'SEO', 'trust-safety': 'Trust & safety', 'subject-expert': 'Subject expert' };
  if (special[role]) return special[role];
  return role.charAt(0).toUpperCase() + role.slice(1).replace(/-/g, ' ');
}

export function hostOf(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}
