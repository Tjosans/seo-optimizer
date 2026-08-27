/**
 * URL identity.
 *
 * Normalization here decides what counts as "the same page", which is the
 * single most consequential choice in a crawler: normalize too little and one
 * page is crawled a hundred times, normalize too much and a real duplicate-
 * content defect is hidden by the tool meant to find it.
 *
 * The rule followed: only collapse differences that are equivalent by the URL
 * standard itself (case of scheme and host, default ports, empty path, the
 * fragment), plus tracking parameters that no server routes on. Everything
 * else — parameter order, trailing slash, letter case in the path — is left
 * alone, because a site treating those as distinct pages IS the finding.
 */

/** Parameters that identify a campaign, never a document. */
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'gbraid', 'wbraid', 'dclid', 'fbclid', 'msclkid', 'ttclid',
  'mc_cid', 'mc_eid', 'igshid', 'ref_src',
]);

const DEFAULT_PORTS: Readonly<Record<string, string>> = { 'http:': '80', 'https:': '443' };

export interface NormalizeOptions {
  /** Drop campaign parameters. On by default; disable to audit them. */
  readonly stripTracking?: boolean;
}

/**
 * Canonical identity for a URL, or null when it is not an absolute http(s) URL.
 *
 * Returning null rather than throwing is deliberate: pages link to `mailto:`,
 * `tel:` and malformed hrefs constantly, and that is not a crawl error.
 */
export function normalizeUrl(input: string, options: NormalizeOptions = {}): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.hash = '';
  if (url.port === DEFAULT_PORTS[url.protocol]) url.port = '';
  if (url.pathname === '') url.pathname = '/';

  if (options.stripTracking !== false) {
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    // URLSearchParams re-encodes on write; only pay that cost if it emptied.
    if ([...url.searchParams.keys()].length === 0) url.search = '';
  }

  return url.toString();
}

/** Resolve an href against the page it was found on. Null when unusable. */
export function resolveUrl(href: string, base: string): string | null {
  const trimmed = href.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return null;
  }
}

/** Registrable-domain-agnostic host comparison: exact host, or a subdomain. */
export function isSameSite(url: string, origin: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(origin);
    return a.host === b.host;
  } catch {
    return false;
  }
}

/** Path depth, counting segments. "/" is 0, "/a/b" is 2. */
export function pathDepth(url: string): number {
  try {
    return new URL(url).pathname.split('/').filter((s) => s !== '').length;
  } catch {
    return 0;
  }
}
