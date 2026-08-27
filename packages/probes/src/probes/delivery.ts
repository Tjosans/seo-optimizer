/**
 * How the response was delivered: status, redirects, transport security and
 * caching. These read headers only, so they apply to every response, not just
 * HTML.
 */

import type { PageProbe } from '../types.js';
import { fail, notApplicable, pass, warn } from '../types.js';

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

export const deliveryProbes = [
  httpStatus,
  redirectChain,
  httpsEnforcement,
  mixedContent,
  securityHeaders,
  compressionCache,
];
