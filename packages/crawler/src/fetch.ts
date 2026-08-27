/**
 * A single HTTP fetch, recorded the way an audit needs it.
 *
 * Redirects are followed manually rather than by the platform, because the
 * chain itself is evidence: detector `redirect-chain` cannot be answered from
 * a final 200. Transport failures are returned as data rather than thrown —
 * a site that times out is a finding, not an exception.
 */

export interface RedirectHop {
  readonly url: string;
  readonly status: number;
  readonly location: string;
}

export interface FetchResult {
  /** The URL requested, before any redirect. */
  readonly requestedUrl: string;
  /** Where the chain ended. Equals requestedUrl when there was no redirect. */
  readonly finalUrl: string;
  readonly status: number | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly redirectChain: readonly RedirectHop[];
  readonly body: string;
  readonly byteLength: number;
  readonly contentType: string | null;
  /** Time to the response head, in ms. */
  readonly ttfbMs: number | null;
  /** Time to the last byte of the body, in ms. */
  readonly totalMs: number | null;
  /** Set when no response was obtained at all. Never a verdict about the site. */
  readonly error: string | null;
}

export interface FetchOptions {
  readonly userAgent: string;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  /** Stop reading a body past this size. Protects against tarpits. */
  readonly maxBytes?: number;
  readonly acceptLanguage?: string;
}

const DEFAULTS = {
  timeoutMs: 15_000,
  maxRedirects: 10,
  maxBytes: 5_000_000,
};

const headersToObject = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => { out[key.toLowerCase()] = value; });
  return out;
};

/** Only these bodies are worth reading; anything else is measured, not parsed. */
const TEXTUAL = /^(text\/|application\/(xhtml\+xml|xml|json|ld\+json|rss\+xml))/;

export async function fetchPage(url: string, options: FetchOptions): Promise<FetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxRedirects = options.maxRedirects ?? DEFAULTS.maxRedirects;
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;

  const redirectChain: RedirectHop[] = [];
  const started = performance.now();
  let current = url;

  const headers: Record<string, string> = {
    'user-agent': options.userAgent,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-encoding': 'gzip, deflate, br',
  };
  if (options.acceptLanguage) headers['accept-language'] = options.acceptLanguage;

  const failure = (error: string): FetchResult => ({
    requestedUrl: url,
    finalUrl: current,
    status: null,
    headers: {},
    redirectChain,
    body: '',
    byteLength: 0,
    contentType: null,
    ttfbMs: null,
    totalMs: null,
    error,
  });

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(current, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (cause) {
      clearTimeout(timer);
      const reason = cause instanceof Error ? cause.message : String(cause);
      return failure(controller.signal.aborted ? `timeout after ${timeoutMs}ms` : reason);
    }
    const ttfbMs = Math.round(performance.now() - started);
    const responseHeaders = headersToObject(response.headers);

    const location = responseHeaders['location'];
    if (response.status >= 300 && response.status < 400 && location !== undefined) {
      clearTimeout(timer);
      await response.body?.cancel();
      redirectChain.push({ url: current, status: response.status, location });
      let next: string;
      try {
        next = new URL(location, current).toString();
      } catch {
        return failure(`unresolvable redirect target "${location}"`);
      }
      if (next === current) return failure('redirect loop: target is the current URL');
      current = next;
      continue;
    }

    const contentType = responseHeaders['content-type'] ?? null;
    let body = '';
    let byteLength = 0;
    try {
      const buffer = await response.arrayBuffer();
      byteLength = buffer.byteLength;
      if (contentType === null || TEXTUAL.test(contentType)) {
        body = new TextDecoder().decode(
          byteLength > maxBytes ? buffer.slice(0, maxBytes) : buffer,
        );
      }
    } catch (cause) {
      clearTimeout(timer);
      return failure(cause instanceof Error ? cause.message : String(cause));
    }
    clearTimeout(timer);

    return {
      requestedUrl: url,
      finalUrl: current,
      status: response.status,
      headers: responseHeaders,
      redirectChain,
      body,
      byteLength,
      contentType,
      ttfbMs,
      totalMs: Math.round(performance.now() - started),
      error: null,
    };
  }

  return failure(`exceeded ${maxRedirects} redirects`);
}
