/**
 * How the response was delivered: status, redirects, transport security,
 * caching and protocol version. These read headers and the transport, not
 * markup, so they apply to every response, not just HTML.
 */

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
    if (chain.length > 1) {
      return fail(`Redirect chain of ${chain.length} hops before the final URL.`, { hops });
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

export const deliveryProbes = [
  httpStatus,
  redirectChain,
  httpsEnforcement,
  mixedContent,
  securityHeaders,
  compressionCache,
  httpVersion,
];
