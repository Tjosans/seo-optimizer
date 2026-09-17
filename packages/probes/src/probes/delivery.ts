/**
 * How the response was delivered: status, redirects, transport security,
 * caching and protocol version. These read headers and the transport, not
 * markup, so they apply to every response, not just HTML.
 */

import type { AuxiliaryFetch, FetchResult } from '@seo/crawler';
import type { PageProbe, SiteProbe } from '../types.js';
import { errored, fail, notApplicable, pass, warn } from '../types.js';

export const httpStatus: PageProbe = {
  id: 'http-status',
  scope: 'page',
  title: 'Linked URLs return a successful status',
  run({ page }) {
    const { status, error } = page.fetch;
    if (error !== null) {
      return fail(`Request failed: ${error}`, { error, url: page.url });
    }
    if (status === null) return fail('No response status was recorded.');
    if (status >= 500) return fail(`Server error ${status}.`, { status });
    if (status >= 400) {
      return fail(`Client error ${status}${page.discoveredFrom === null ? '' : ', linked from a crawled page'}.`, {
        status,
        linkedFrom: page.discoveredFrom,
      });
    }
    return pass(`Responded ${status}.`, { status });
  },
};

export const redirectChain: PageProbe = {
  id: 'redirect-chain',
  scope: 'page',
  title: 'Internal links point at final URLs',
  run({ page }) {
    const chain = page.fetch.redirectChain;
    if (chain.length === 0) return pass('Reached directly, with no redirect.');
    const hops = chain.map((hop) => ({ from: hop.url, status: hop.status, to: hop.location }));
    // v5.0 1.3 asks for one hop "where feasible" and has external chains
    // "assessed by impact", so a chain holds the check for that assessment.
    if (chain.length > 1) {
      return warn(`Redirect chain of ${chain.length} hops before the final URL.`, { hops });
    }
    return warn('One redirect before the final URL; link to the destination directly.', { hops });
  },
};

export const httpsEnforcement: PageProbe = {
  id: 'https-enforcement',
  scope: 'page',
  title: 'Every URL is served over HTTPS',
  run({ page }) {
    const isHttps = page.fetch.finalUrl.startsWith('https://');
    const startedInsecure = page.url.startsWith('http://');
    if (!isHttps) return fail('Final URL is served over plain HTTP.', { url: page.fetch.finalUrl });
    if (startedInsecure) return pass('HTTP request was upgraded to HTTPS.');
    return pass('Served over HTTPS.');
  },
};

export const mixedContent: PageProbe = {
  id: 'mixed-content',
  scope: 'page',
  htmlOnly: true,
  run({ page }) {
    if (!page.fetch.finalUrl.startsWith('https://')) {
      return notApplicable('Page is not served over HTTPS, so mixed content cannot apply.');
    }
    const extracted = page.extracted;
    if (extracted === null) return notApplicable('No HTML was parsed for this response.');

    const insecure = [
      ...extracted.scripts,
      ...extracted.images.map((image) => image.src ?? ''),
    ].filter((url) => url.startsWith('http://'));

    return insecure.length === 0
      ? pass('All subresources are referenced over HTTPS.')
      : fail(`${insecure.length} subresource(s) referenced over plain HTTP.`, {
          samples: insecure.slice(0, 10),
        });
  },
  title: 'Pages load no insecure subresources',
};

export const securityHeaders: PageProbe = {
  id: 'security-headers',
  scope: 'page',
  title: 'Baseline security headers are present',
  run({ page }) {
    const headers = page.fetch.headers;
    const isHttps = page.fetch.finalUrl.startsWith('https://');

    const missing: string[] = [];
    if (isHttps && headers['strict-transport-security'] === undefined) {
      missing.push('strict-transport-security');
    }
    if (headers['x-content-type-options']?.toLowerCase() !== 'nosniff') {
      missing.push('x-content-type-options: nosniff');
    }
    if (headers['content-security-policy'] === undefined && headers['x-frame-options'] === undefined) {
      missing.push('content-security-policy or x-frame-options');
    }
    if (headers['referrer-policy'] === undefined) missing.push('referrer-policy');

    return missing.length === 0
      ? pass('All baseline security headers are present.')
      : warn(`Missing ${missing.length} baseline security header(s).`, { missing });
  },
};

export const compressionCache: PageProbe = {
  id: 'compression-cache',
  scope: 'page',
  title: 'Text responses are compressed and cacheable',
  run({ page }) {
    const headers = page.fetch.headers;
    const contentType = page.fetch.contentType ?? '';
    const compressible = /^(text\/|application\/(javascript|json|xml|xhtml\+xml))/i.test(contentType);
    if (!compressible) return notApplicable(`Content type ${contentType || 'unknown'} is not text.`);

    const problems: string[] = [];
    // fetch() transparently decodes, so a decoded body still proves the
    // response was compressed on the wire when this header survives.
    if (headers['content-encoding'] === undefined) problems.push('no content-encoding');
    if (headers['cache-control'] === undefined && headers['etag'] === undefined) {
      problems.push('no cache-control or etag');
    }

    return problems.length === 0
      ? pass('Compressed and cacheable.')
      : warn(`Delivery could be improved: ${problems.join('; ')}.`, {
          contentEncoding: headers['content-encoding'] ?? null,
          cacheControl: headers['cache-control'] ?? null,
        });
  },
};

/** An `Alt-Svc` entry offering HTTP/3, final or draft: `h3=":443"`, `h3-29=":443"`. */
const ADVERTISES_H3 = /(^|,)\s*h3(-\d+)?\s*=/i;

/**
 * Which HTTP version a visitor's browser gets.
 *
 * Asked of the host the root document came from, which is where a visit
 * lands. HTTP/2 is settled in the TLS handshake the crawl made for exactly
 * this; HTTP/3 is offered in an `Alt-Svc` header, and a browser that sees one
 * switches to it for the next request. Either answers the corpus's "HTTP/2 or
 * HTTP/3".
 *
 * HTTP/1.1 alone is a `warn`, not a `fail`, alongside its neighbours in 1.7:
 * missing compression and missing security headers are held the same way. It
 * is a delivery that could be better, which a machine will not clear, rather
 * than a defect that stops anything working.
 */
export const httpVersion: SiteProbe = {
  id: 'http-version',
  scope: 'site',
  title: 'The site is served over HTTP/2 or HTTP/3',
  run({ crawl }) {
    const root = [...crawl.pages].sort((a, b) => a.depth - b.depth)[0];
    if (root === undefined || root.fetch.error !== null || root.fetch.status === null) {
      return errored('The root document could not be fetched, so there is no host to ask about.');
    }

    const landed = root.fetch.finalUrl;
    const altSvc = root.fetch.headers['alt-svc'] ?? null;
    const h3 = altSvc !== null && ADVERTISES_H3.test(altSvc);
    const protocol = crawl.protocol;
    const data = {
      url: landed,
      alpn: protocol?.alpn ?? null,
      tlsVersion: protocol?.tlsVersion ?? null,
      altSvc,
    };

    if (!landed.startsWith('https://')) {
      return warn(
        'Served over plain HTTP, which every browser speaks as HTTP/1.1: HTTP/2 is only offered over TLS (see https-enforcement).',
        data,
      );
    }
    if (protocol?.alpn === 'h2') {
      return pass(`Negotiates HTTP/2${h3 ? ' and advertises HTTP/3' : ''}.`, data);
    }
    if (h3) {
      // A browser upgrades on the header whatever the handshake said, so this
      // is true however the handshake went, or whether one was made at all.
      return pass('Advertises HTTP/3 in Alt-Svc, which browsers switch to after the first request.', data);
    }
    if (protocol === undefined) {
      return errored('No TLS handshake was recorded for this crawl, so the HTTP version is unknown.', data);
    }
    if (protocol.error !== null) {
      return errored(`The TLS handshake failed (${protocol.error}), so the HTTP version is unknown.`, data);
    }
    return warn(
      `Only HTTP/1.1 is offered: the TLS handshake ${protocol.alpn === null ? 'negotiated no protocol at all' : 'chose http/1.1 over h2'}, and no Alt-Svc header advertises HTTP/3.`,
      data,
    );
  },
};

/**
 * Googlebot's per-file fetch limits for Search, uncompressed: v5.0 1.5, SRC040,
 * verified 2026-09-08. Google writes "2MB" and "64MB" without saying which
 * megabyte, so each limit is held as the two readings: past the binary one is
 * past it however Google counts, and between the two is past it only perhaps.
 */
export const GOOGLEBOT_FETCH_LIMIT = { decimal: 2_000_000, binary: 2 * 1024 * 1024, label: '2 MB' } as const;
export const GOOGLEBOT_PDF_FETCH_LIMIT = { decimal: 64_000_000, binary: 64 * 1024 * 1024, label: '64 MB' } as const;

/** The share of a limit, on its stricter reading, a file may reach before it is held for a person. */
export const FETCH_LIMIT_MARGIN = 0.75;

/** Media other crawlers fetch, or nothing indexes as a document. */
const NOT_A_DOCUMENT = /^(image|video|audio|font)\/|^application\/(octet-stream|zip|gzip|x-gzip|wasm)$/;

const mediaType = (contentType: string | null): string | null =>
  contentType === null ? null : (contentType.split(';')[0] ?? '').trim().toLowerCase();

const bytesText = (bytes: number): string => `${bytes.toLocaleString('en-US')} bytes`;

/**
 * How large a response was, uncompressed, and how sure that is.
 *
 * `fetch` undoes transport compression, so a body read to its end measures
 * itself. A body the crawler cut measures only how far the read got, unless
 * the server said how long it was: `Content-Length` is the uncompressed size
 * exactly when no `Content-Encoding` stands between the two.
 */
function measure(fetch: FetchResult): { bytes: number; exact: boolean; from: 'body' | 'content-length' } {
  if (!fetch.truncated) return { bytes: fetch.byteLength, exact: true, from: 'body' };
  const encoding = fetch.headers['content-encoding']?.trim().toLowerCase();
  const declared = Number(fetch.headers['content-length']);
  if ((encoding === undefined || encoding === 'identity') && Number.isSafeInteger(declared) && declared >= fetch.byteLength) {
    return { bytes: declared, exact: true, from: 'content-length' };
  }
  return { bytes: fetch.byteLength, exact: false, from: 'body' };
}

interface SizeVerdict {
  readonly outcome: 'pass' | 'warn' | 'fail' | 'error';
  readonly note: string;
  readonly bytes: number;
  readonly exact: boolean;
  readonly measuredFrom: 'body' | 'content-length';
  readonly share: number;
}

/**
 * Judges one response's uncompressed size against Googlebot's per-file limit.
 *
 * Only a file past the limit on either reading of "MB" fails; one between
 * the two readings is a `warn`, since Google may read it whole and a margin
 * is gone regardless. A body the crawler cut at its own `maxBytes` fails when
 * the cut is already past the limit, since the file is at least that large. Cut below the limit,
 * with no length declared, the size is unknown, and that is an `error`.
 */
interface FetchLimit {
  readonly decimal: number;
  readonly binary: number;
  readonly label: string;
}

function judgeSize(fetch: FetchResult, limit: FetchLimit, named: string): SizeVerdict {
  const size = measure(fetch);
  const share = Math.round((size.bytes / limit.decimal) * 100);
  const base = { bytes: size.bytes, exact: size.exact, measuredFrom: size.from, share };

  if (size.bytes > limit.binary) {
    const amount = size.exact ? bytesText(size.bytes) : `At least ${bytesText(size.bytes)} (the crawler stopped reading there)`;
    return {
      ...base,
      outcome: 'fail',
      note: `${amount} uncompressed, past ${named}: Search indexes the first ${limit.label} and nothing after it.`,
    };
  }
  if (!size.exact) {
    return {
      ...base,
      outcome: 'error',
      note: `The crawler stopped reading at ${bytesText(size.bytes)}, inside the ${limit.label} limit, and no Content-Length says how large the file is.`,
    };
  }
  if (size.bytes > limit.decimal) {
    return {
      ...base,
      outcome: 'warn',
      note: `${bytesText(size.bytes)} uncompressed: past ${named} if Google counts ${bytesText(limit.decimal)}, inside it at ${bytesText(limit.binary)}. Google does not say which, and either way there is no margin left.`,
    };
  }
  if (size.bytes >= limit.decimal * FETCH_LIMIT_MARGIN) {
    return {
      ...base,
      outcome: 'warn',
      note: `${bytesText(size.bytes)} uncompressed, ${share}% of ${named}, inside the ${Math.round((1 - FETCH_LIMIT_MARGIN) * 100)}% margin 1.5 asks to keep.`,
    };
  }
  return { ...base, outcome: 'pass', note: `${bytesText(size.bytes)} uncompressed, ${share}% of ${named}.` };
}

/** Higher outrates lower: a fail anywhere outranks a warn or error elsewhere, so the worst finding wins the page's verdict. */
const SEVERITY: Record<SizeVerdict['outcome'], number> = { pass: 0, warn: 1, error: 2, fail: 3 };

/**
 * Whether Googlebot reads each document, stylesheet and script to its end.
 *
 * Search fetches the first 2 MB of a file, or 64 MB of a PDF, and indexes what
 * it got: a page past the limit is not refused, it is quietly cut, and the
 * links, structured data and text below the cut stop existing for Search.
 * v5.0 1.5 asks for each document *and resource* against the limit "and a
 * margin", and keeps that apart from page weight — this is the size of one
 * file, not of everything the page loads. Googlebot fetches CSS and
 * JavaScript separately from the document, under the same per-file limit, so
 * a page's linked stylesheets and scripts are judged alongside it — each one
 * the crawl fetched (@seo/crawler's bounded `asset` auxiliary pass), read
 * from `site.crawl.auxiliary`, since a probe never fetches on its own.
 */
export const crawlerFetchLimit: PageProbe = {
  id: 'crawler-fetch-limit',
  scope: 'page',
  title: "Each document and its linked CSS/JS fit within Googlebot's per-file fetch limit",
  run({ page, site }) {
    const { fetch } = page;
    if (fetch.error !== null || fetch.status === null || fetch.status < 200 || fetch.status >= 300) {
      return notApplicable('No successful response to measure (see http-status).');
    }
    const type = mediaType(fetch.contentType);
    if (type !== null && NOT_A_DOCUMENT.test(type)) {
      return notApplicable(`${type} is not a document Googlebot fetches for Search's text index.`);
    }

    const pdf = type === 'application/pdf';
    const limit = pdf ? GOOGLEBOT_PDF_FETCH_LIMIT : GOOGLEBOT_FETCH_LIMIT;
    const doc = judgeSize(fetch, limit, `Googlebot's ${limit.label} ${pdf ? 'PDF' : 'per-file'} limit`);

    const stylesheetUrls = new Set(page.extracted?.stylesheets ?? []);
    const assetUrls = [...new Set([...stylesheetUrls, ...(page.extracted?.scripts ?? [])])];
    const assets = assetUrls
      .map((url) => site.crawl.auxiliary.find((entry) => entry.reason === 'asset' && entry.url === url))
      .filter((entry): entry is AuxiliaryFetch => entry !== undefined)
      .map((entry) => ({
        url: entry.url,
        kind: stylesheetUrls.has(entry.url) ? ('stylesheet' as const) : ('script' as const),
        ...judgeSize(entry.fetch, GOOGLEBOT_FETCH_LIMIT, `Googlebot's ${GOOGLEBOT_FETCH_LIMIT.label} per-file limit`),
      }));

    let worst: { outcome: SizeVerdict['outcome']; note: string; source: string } = { ...doc, source: 'document' };
    for (const asset of assets) {
      if (SEVERITY[asset.outcome] > SEVERITY[worst.outcome]) {
        worst = { outcome: asset.outcome, note: asset.note, source: `linked ${asset.kind} ${asset.url}` };
      }
    }
    const summary = worst.source === 'document' ? worst.note : `${worst.note} (${worst.source})`;
    const data = {
      url: fetch.finalUrl,
      contentType: type,
      bytes: doc.bytes,
      exact: doc.exact,
      measuredFrom: doc.measuredFrom,
      limitBytes: limit.decimal,
      limitBytesBinary: limit.binary,
      share: doc.share,
      assets: assets.map(({ url, kind, outcome, bytes, share }) => ({ url, kind, outcome, bytes, share })),
      assetsUnchecked: assetUrls.length - assets.length,
    };

    switch (worst.outcome) {
      case 'fail': return fail(summary, data);
      case 'error': return errored(summary, data);
      case 'warn': return warn(summary, data);
      default: return pass(summary, data);
    }
  },
};

/**
 * A response marked `Cache-Control: public` that also sets or varies by a
 * cookie: v5.0 1.7 asks that "private responses are not shared across
 * users", and `public` is the one directive that tells a shared cache
 * (a CDN, a reverse proxy) it may store a response for everyone who asks.
 *
 * `Set-Cookie` on such a response is the sharper defect: a cache that stores
 * it can replay one visitor's cookie — a session id, a cart — to the next.
 * `Vary: Cookie` is subtler: it says the response differs per cookie, which
 * contradicts a directive meant for content that is the same for everyone,
 * and only works if every cache in front of the origin honours the variant
 * key. Either reads as a defect a machine can name outright, so both fail
 * rather than warn.
 */
export const privateResponseCaching: PageProbe = {
  id: 'private-response-caching',
  scope: 'page',
  title: 'A publicly cacheable response is not personalised',
  run({ page }) {
    const headers = page.fetch.headers;
    const cacheControl = headers['cache-control'] ?? '';
    const directives = cacheControl.toLowerCase().split(',').map((d) => d.trim());
    if (!directives.includes('public')) {
      return notApplicable('Response does not declare itself publicly cacheable (no "public" Cache-Control directive).');
    }

    if (headers['set-cookie'] !== undefined) {
      return fail(
        'Sets a cookie while declaring itself publicly cacheable ("Cache-Control: public"): a shared cache may store this response and replay its cookie to other visitors.',
        { cacheControl, setsCookie: true },
      );
    }

    const vary = (headers['vary'] ?? '').toLowerCase().split(',').map((v) => v.trim());
    if (vary.includes('cookie')) {
      return fail(
        'Varies by Cookie while declaring itself publicly cacheable ("Cache-Control: public"): content differs per visitor, which a directive meant for identical content only works around if every cache in front of the origin keys on the variant.',
        { cacheControl, vary: headers['vary'] },
      );
    }

    return pass('Publicly cacheable, with no cookie set and no per-cookie variation.', { cacheControl });
  },
};

export const deliveryProbes = [
  httpStatus,
  redirectChain,
  httpsEnforcement,
  mixedContent,
  securityHeaders,
  compressionCache,
  httpVersion,
  crawlerFetchLimit,
  privateResponseCaching,
];
