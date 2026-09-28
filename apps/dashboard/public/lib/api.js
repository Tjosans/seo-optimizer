// The audit API, reached through the dashboard server's same-origin `/api`
// proxy. Every failure becomes an ApiError carrying the API's own `problems`
// list, so a form can show each one beside the field it names (R10).

export class ApiError extends Error {
  constructor(status, message, problems = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.problems = problems;
  }

  /** Problems keyed by the path they name: "crawl.maxPages: expected …" → { "crawl.maxPages": ["expected …"] }. */
  byField() {
    const out = {};
    for (const text of this.problems) {
      const at = text.indexOf(': ');
      const path = at === -1 ? '' : text.slice(0, at);
      (out[path] ??= []).push(at === -1 ? text : text.slice(at + 2));
    }
    return out;
  }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, 'The app could not reach its own server.');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, data.error ?? `${res.status} ${res.statusText}`, data.problems ?? []);
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body ?? {}),
  patch: (path, body) => request('PATCH', path, body),
  del: (path) => request('DELETE', path),
};

/** The API answers 500 when its database is down; the proxy 502 when the API is. */
export const isUnreachable = (error) => error instanceof ApiError && (error.status === 0 || error.status >= 500);
