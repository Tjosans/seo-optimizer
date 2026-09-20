/**
 * How the response was delivered: status, redirects, transport security,
 * caching and protocol version. These read headers and the transport, not
 * markup, so they apply to every response, not just HTML.
 */

import { isAllowed, isSameSite, normalizeUrl, registrableDomain } from '@seo/crawler';
import { inputRecordProblem } from '@seo/core';
import type { AuxiliaryFetch, FetchResult } from '@seo/crawler';
import type { PageProbe, SiteProbe } from '../types.js';
import { errored, fail, notApplicable, pass, warn } from '../types.js';
import { matrixMatcher } from './site.js';

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

const hostnameOf = (url: string): string | null => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

/** A domain expiring inside this many days of the RDAP lookup is a near-term risk. */
const EXPIRY_WARNING_DAYS = 30;

/** RDAP statuses that mean the registration has already lapsed into the deletion process. */
const LAPSED_STATUSES = ['pending delete', 'redemption period'];

/**
 * Whether the production domain is at risk of expiring out from under the site.
 *
 * 1.18's "Done when" is mostly a registrar-account record — named owner,
 * recovery contacts, protected access — that no public record carries. Expiry
 * is the one fact settled either way by the registry's own RDAP record: a
 * domain days from lapsing, or already in the post-expiry deletion process,
 * is a defect however the rest of the record reads, and a domain comfortably
 * inside its term is not something a person needs to re-confirm. Registrar
 * name and transfer-lock status are recorded for the review the rest of 1.18
 * still needs, but do not move this verdict — many legitimately-run domains
 * carry no lock status in RDAP at all.
 */
export const domainExpiryRdap: SiteProbe = {
  id: 'domain-expiry-rdap',
  scope: 'site',
  title: 'The production domain is not at risk of near-term expiry',
  run({ crawl }) {
    const rdap = crawl.rdap;
    if (rdap === undefined) {
      const root = [...crawl.pages].sort((a, b) => a.depth - b.depth)[0];
      const host = root === undefined ? null : hostnameOf(root.fetch.finalUrl);
      if (host !== null && registrableDomain(host) === null) {
        return notApplicable(`${host} has no registrable domain, so there is no registry to ask.`);
      }
      return errored('No RDAP lookup was recorded for this crawl.');
    }
    const data = {
      domain: rdap.domain,
      registrar: rdap.registrar,
      expiresAt: rdap.expiresAt,
      statuses: rdap.statuses,
    };
    if (rdap.error !== null) {
      return errored(`The RDAP lookup for ${rdap.domain} failed: ${rdap.error}.`, data);
    }
    if (rdap.statuses.some((status) => LAPSED_STATUSES.includes(status.toLowerCase()))) {
      return fail(`${rdap.domain} carries an RDAP status of the post-expiry deletion process: ${rdap.statuses.join(', ')}.`, data);
    }
    if (rdap.expiresAt === null) {
      return errored(`The RDAP record for ${rdap.domain} names no expiration date.`, data);
    }
    const expires = new Date(rdap.expiresAt);
    const fetchedAt = new Date(rdap.fetchedAt);
    if (Number.isNaN(expires.getTime())) {
      return errored(`The RDAP record for ${rdap.domain} names an unparseable expiration date "${rdap.expiresAt}".`, data);
    }
    const daysLeft = (expires.getTime() - fetchedAt.getTime()) / 86_400_000;
    if (daysLeft < 0) {
      return fail(`${rdap.domain} expired ${rdap.expiresAt}.`, data);
    }
    if (daysLeft <= EXPIRY_WARNING_DAYS) {
      return warn(`${rdap.domain} expires ${rdap.expiresAt}, within ${EXPIRY_WARNING_DAYS} days.`, data);
    }
    return pass(`${rdap.domain} does not expire until ${rdap.expiresAt}.`, data);
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

/** Google fetches a page's rendering resources under its main crawler token. */
const RESOURCE_AGENT = 'Googlebot';

/**
 * v5.0 4.2 asks that "essential rendering resources" are not blocked, among a
 * matrix of cache, auth and directive checks a raw crawl cannot see. A
 * same-site stylesheet or script robots.txt turns Googlebot away from is the
 * one part of that matrix a crawl can name outright: the resource is linked,
 * the rule is on record, and the two disagree.
 */
export const indexabilityMatrixReconciliation: PageProbe = {
  id: 'indexability-matrix-reconciliation',
  scope: 'page',
  htmlOnly: true,
  title: "CSS and JavaScript the page needs to render are not blocked by robots.txt",
  run({ page, site }) {
    const extracted = page.extracted;
    if (extracted === null) return notApplicable('No HTML to read linked resources from.');

    const urls = [...new Set([...extracted.stylesheets, ...extracted.scripts])];
    if (urls.length === 0) {
      return notApplicable('The page links no stylesheet or script.');
    }

    const sameSite = urls.filter((url) => isSameSite(url, site.origin));
    if (sameSite.length === 0) {
      return pass(
        "Every linked stylesheet and script is hosted off-site; this site's robots.txt has nothing to say about them.",
        { urls },
      );
    }

    const blocked = sameSite.filter((url) => !isAllowed(site.crawl.robots, RESOURCE_AGENT, url));
    if (blocked.length > 0) {
      return fail(
        `robots.txt blocks Googlebot from ${blocked.length} resource${blocked.length === 1 ? '' : 's'} this page needs to render: ${blocked.join(', ')}.`,
        { blocked },
      );
    }
    return pass('Every same-site stylesheet and script the page links is crawlable.', { checked: sameSite.length });
  },
};

/**
 * v5.0 1.5 asks that lab performance stays inside a budget a person set. The
 * `perfPolicy` supplied with the Lighthouse reports is that budget, and no
 * crawl can stand in for it. A report over any threshold fails, and so does a
 * report run under another test profile: a desktop run judged against a mobile
 * budget says nothing about mobile. Nothing in the policy waives a threshold,
 * so a failure is never passed. What cannot be judged (no report, a missing
 * metric, a report older than the policy's revision, an unowned or overdue
 * record) holds the check with a `warn`.
 */
export const labPerfBudget: SiteProbe = {
  id: 'lab-perf-budget',
  scope: 'site',
  title: 'Lighthouse lab results stay inside the performance budget',
  run({ crawl, inputs }) {
    const record = inputs?.lighthouse;
    const policy = record?.perfPolicy;
    if (record === undefined || policy === undefined) return notApplicable('No performance policy was supplied.');

    const failures: string[] = [];
    const held: string[] = [];
    const limits = Object.entries(policy.thresholds) as [keyof typeof policy.thresholds, number][];
    for (const report of record.reports) {
      const metrics = report.metrics;
      if (metrics === undefined) {
        held.push(`${report.url}: the report has not been read`);
        continue;
      }
      if (metrics.testProfile !== policy.testProfile) {
        failures.push(`${report.url}: run as ${metrics.testProfile ?? 'an unknown profile'}, the policy is ${policy.testProfile}`);
        continue;
      }
      const over: string[] = [];
      const missing: string[] = [];
      for (const [key, limit] of limits) {
        const value = metrics[key];
        if (value === undefined) missing.push(key);
        else if (value > limit) over.push(`${key} ${value} over ${limit}`);
      }
      if (over.length > 0) failures.push(`${report.url}: ${over.join(', ')}`);
      else if (missing.length > 0) held.push(`${report.url}: the report holds no ${missing.join(', ')}`);
      else if (metrics.fetchedAt !== undefined && Date.parse(metrics.fetchedAt) < Date.parse(policy.revision)) {
        held.push(`${report.url}: the report predates the policy revision ${policy.revision}`);
      }
    }

    const data = { reports: record.reports.length, failures: failures.slice(0, 10), held: held.slice(0, 10) };
    if (failures.length > 0) return fail(`${failures.length} report(s) break the performance policy: ${failures.slice(0, 3).join(' | ')}.`, data);

    if (record.reports.length === 0) held.push('the policy has no report to judge');
    const at = crawl.crawledAt ?? null;
    const problem = record.owner.trim() === '' || policy.owner.trim() === ''
      ? 'the performance policy has no owner'
      : at === null ? null : inputRecordProblem(record, new Date(at));
    if (problem !== null) held.push(problem);
    if (held.length > 0) return warn(`The performance budget is not settled: ${held.slice(0, 3).join('; ')}.`, data);
    return pass(`${record.reports.length} report(s) run under ${policy.testProfile} stay inside the policy.`, data);
  },
};

/**
 * v5.0 4.5 asks that every launch template has been measured against the
 * performance budget. Each priority `urlMatrix` pattern is a launch template;
 * the Lighthouse reports whose URL the pattern matches are its evidence. A
 * template fails with no report, with only reports older than the policy's
 * `revision` (measured against a budget that has since changed), and with a
 * current report over a threshold or run under another test profile. A current
 * report missing a metric, unread or undated holds the check with a `warn`, as
 * does an unowned or overdue record. Rows for another environment or private
 * access are set aside. Without a policy or a priority row there is no budget
 * or no template, so the check is `not-applicable`.
 */
export const templateLabPerf: SiteProbe = {
  id: 'template-lab-perf',
  scope: 'site',
  title: 'Every launch template has a Lighthouse report inside the performance budget',
  run({ crawl, inputs, origin }) {
    const record = inputs?.lighthouse;
    const policy = record?.perfPolicy;
    if (record === undefined || policy === undefined) return notApplicable('No performance policy was supplied.');
    const rows = (inputs?.urlMatrix ?? []).filter(
      (row) => row.priority === true && row.access !== 'private' &&
        (row.environment === undefined || row.environment === 'production'),
    );
    if (rows.length === 0) return notApplicable('The URL matrix names no priority template.');

    const revision = Date.parse(policy.revision);
    const failures: string[] = [];
    const held: string[] = [];
    const limits = Object.entries(policy.thresholds) as [keyof typeof policy.thresholds, number][];
    for (const row of rows) {
      const { test } = matrixMatcher(row.pattern, origin);
      const reports = record.reports.filter((r) => {
        const url = normalizeUrl(r.url);
        return url !== null && test(url);
      });
      if (reports.length === 0) {
        failures.push(`${row.pattern}: no Lighthouse report`);
        continue;
      }
      const stale = reports.filter((r) => r.metrics?.fetchedAt !== undefined && Date.parse(r.metrics.fetchedAt) < revision);
      const current = reports.filter((r) => !stale.includes(r));
      if (current.length === 0) {
        failures.push(`${row.pattern}: every report predates the policy revision ${policy.revision}`);
        continue;
      }
      for (const report of current) {
        const metrics = report.metrics;
        if (metrics === undefined) {
          held.push(`${row.pattern}: the report for ${report.url} has not been read`);
          continue;
        }
        if (metrics.testProfile !== policy.testProfile) {
          failures.push(`${row.pattern}: run as ${metrics.testProfile ?? 'an unknown profile'}, the policy is ${policy.testProfile}`);
          continue;
        }
        const over: string[] = [];
        const missing: string[] = [];
        for (const [key, limit] of limits) {
          const value = metrics[key];
          if (value === undefined) missing.push(key);
          else if (value > limit) over.push(`${key} ${value} over ${limit}`);
        }
        if (over.length > 0) failures.push(`${row.pattern}: ${over.join(', ')}`);
        else if (missing.length > 0) held.push(`${row.pattern}: the report holds no ${missing.join(', ')}`);
        else if (metrics.fetchedAt === undefined) held.push(`${row.pattern}: the report carries no run date`);
      }
    }

    const data = { templates: rows.length, failures: failures.slice(0, 10), held: held.slice(0, 10) };
    if (failures.length > 0) return fail(`${failures.length} launch template problem(s): ${failures.slice(0, 3).join(' | ')}.`, data);

    const at = crawl.crawledAt ?? null;
    const problem = record.owner.trim() === '' || policy.owner.trim() === ''
      ? 'the performance policy has no owner'
      : at === null ? null : inputRecordProblem(record, new Date(at));
    if (problem !== null) held.push(problem);
    if (held.length > 0) return warn(`Launch template performance is not settled: ${held.slice(0, 3).join('; ')}.`, data);
    return pass(`${rows.length} launch template(s) have a current report inside the ${policy.testProfile} policy.`, data);
  },
};

const MEDIA_LCP_TAGS =new Set(['img', 'image', 'video', 'picture', 'source']);

/** The `@font-face` rules in the page's own `<style>` blocks that name no `font-display`. */
function fontFacesWithoutDisplay(html: string): { total: number; without: number } {
  let total = 0;
  let without = 0;
  for (const style of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    for (const rule of (style[1] ?? '').matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
      total += 1;
      if (!/font-display\s*:/i.test(rule[1] ?? '')) without += 1;
    }
  }
  return { total, without };
}

/** Whether the raw markup names the image the LCP element loaded, as written or by its path. */
function rawHtmlNamesSource(html: string, src: string): boolean {
  if (html.includes(src)) return true;
  try {
    const url = new URL(src, 'https://placeholder.invalid');
    return html.includes(url.pathname + url.search);
  } catch {
    return false;
  }
}

/**
 * v5.0 1.5 asks that the element the browser paints largest is not held back by
 * how the page loads it. The element comes from a supplied Lighthouse report,
 * because only a browser knows which element that was; the raw HTML is what the
 * crawl fetched. An LCP image marked `loading="lazy"` or `fetchpriority="low"`
 * fails, and so does one the raw HTML never names (a script builds it, so the
 * preload scanner cannot find it). A text LCP warns when an inline `@font-face`
 * has no `font-display`. Linked stylesheets are not read, so a text LCP whose
 * fonts sit in one is `not-applicable` rather than passed: absence of evidence.
 */
export const lcpElementStrategy: PageProbe = {
  id: 'lcp-element-strategy',
  scope: 'page',
  htmlOnly: true,
  title: 'The LCP element is discoverable and prioritised',
  run({ page, site }) {
    const reports = site.inputs?.lighthouse?.reports;
    if (reports === undefined) return notApplicable('No Lighthouse report was supplied.');
    const selves = new Set([page.normalizedUrl, normalizeUrl(page.fetch.finalUrl)]);
    const report = reports.find((r) => selves.has(normalizeUrl(r.url)));
    if (report === undefined) return notApplicable('No Lighthouse report covers this page.');

    const element = report.metrics?.lcpElement;
    if (element === undefined) {
      return warn('The Lighthouse report names no LCP element, so how the page loads it is unchecked.', { report: report.url });
    }

    if (MEDIA_LCP_TAGS.has(element.tag)) {
      const problems: string[] = [];
      if (element.loading?.toLowerCase() === 'lazy') problems.push('it is loading="lazy"');
      if (element.fetchPriority?.toLowerCase() === 'low') problems.push('it is fetchpriority="low"');
      const data = { tag: element.tag, src: element.src ?? null, loading: element.loading ?? null, fetchPriority: element.fetchPriority ?? null };
      if (element.src !== undefined && !element.src.startsWith('data:')) {
        if (page.fetch.truncated) {
          if (problems.length === 0) return errored('The page body was cut at the size limit, so the LCP image could not be looked for in the raw HTML.', data);
        } else if (!rawHtmlNamesSource(page.fetch.body, element.src)) {
          problems.push('the raw HTML never names it, so a script must build it');
        }
      }
      if (problems.length > 0) return fail(`The LCP ${element.tag} is held back: ${problems.join('; ')}.`, data);
      return pass(`The LCP ${element.tag} is in the raw HTML and is not lazy or low priority.`, data);
    }

    const faces = fontFacesWithoutDisplay(page.fetch.body);
    const data = { tag: element.tag, fontFaces: faces.total, withoutFontDisplay: faces.without };
    if (faces.without > 0) {
      return warn(`The LCP is text (<${element.tag}>) and ${faces.without} of ${faces.total} inline @font-face rule(s) set no font-display.`, data);
    }
    if (faces.total === 0) return notApplicable(`The LCP is text (<${element.tag}>) and the page's own markup declares no web font; linked stylesheets are not read.`);
    return pass(`The LCP is text (<${element.tag}>) and every inline @font-face sets font-display.`, data);
  },
};

/** Google Core Web Vitals boundaries at p75: Good up to `good`, Poor above `poor`. */
export const FIELD_VITAL_THRESHOLDS = {
  lcp: { good: 2500, poor: 4000, unit: 'ms' },
  inp: { good: 200, poor: 500, unit: 'ms' },
  cls: { good: 0.1, poor: 0.25, unit: '' },
} as const;

export type FieldVitalGrade = 'good' | 'needs-improvement' | 'poor';

/** Grade one p75 by Google's thresholds. */
export function gradeFieldVital(metric: keyof typeof FIELD_VITAL_THRESHOLDS, p75: number): FieldVitalGrade {
  const { good, poor } = FIELD_VITAL_THRESHOLDS[metric];
  return p75 <= good ? 'good' : p75 <= poor ? 'needs-improvement' : 'poor';
}

/**
 * v5.0 6.2 is a review of field LCP, INP and CLS at p75, and it says outright
 * that completing the review does not claim the site has Good field Core Web
 * Vitals. Each population the person supplied (a named source, target and
 * device segment) is graded metric by metric and never averaged into one
 * score. A Poor metric with no action record (an owner and a retest date)
 * fails. A metric the source did not report is unavailable, which holds the
 * check with a `warn` and is never read as Good. The check is `assisted`, so
 * whatever is left (Needs Improvement, a Poor metric with an action) is
 * reported for a person to confirm.
 */
export const fieldCwvMonitor: SiteProbe = {
  id: 'field-cwv-monitor',
  scope: 'site',
  title: 'Field Core Web Vitals are graded and Poor ones have an action',
  run({ crawl, inputs }) {
    const record = inputs?.crux;
    if (record === undefined) return notApplicable('No field Core Web Vitals were supplied.');

    const failures: string[] = [];
    const unavailable: string[] = [];
    const graded: string[] = [];
    const attention: string[] = [];
    for (const population of record.populations) {
      const name = `${population.source} ${population.target} (${population.formFactor})`;
      const values = { lcp: population.lcpMs, inp: population.inpMs, cls: population.cls };
      for (const metric of ['lcp', 'inp', 'cls'] as const) {
        const value = values[metric];
        const label = metric.toUpperCase();
        if (value === undefined) {
          unavailable.push(`${name}: ${label}`);
          continue;
        }
        const shown = `${value}${FIELD_VITAL_THRESHOLDS[metric].unit}`;
        const grade = gradeFieldVital(metric, value);
        graded.push(`${name}: ${label} p75 ${shown} is ${grade}`);
        if (grade === 'needs-improvement') attention.push(`${name}: ${label} needs improvement`);
        if (grade !== 'poor') continue;
        if (population.actions.some((action) => action.metric === metric && action.owner.trim() !== '')) {
          attention.push(`${name}: ${label} is poor, with an action`);
        } else failures.push(`${name}: ${label} p75 ${shown} is poor with no action record`);
      }
    }

    const data = {
      populations: record.populations.length,
      graded: graded.slice(0, 20),
      failures: failures.slice(0, 10),
      unavailable: unavailable.slice(0, 10),
      attention: attention.slice(0, 10),
    };
    if (failures.length > 0) return fail(`${failures.length} Poor field metric(s) have no action record: ${failures.slice(0, 3).join(' | ')}.`, data);

    const held: string[] = [];
    if (record.populations.length === 0) held.push('no population was supplied');
    if (unavailable.length > 0) held.push(`unavailable, not Good: ${unavailable.slice(0, 3).join(', ')}`);
    const at = crawl.crawledAt ?? null;
    const problem = record.owner.trim() === '' ? 'the field data has no owner' : at === null ? null : inputRecordProblem(record, new Date(at));
    if (problem !== null) held.push(problem);
    if (held.length > 0) return warn(`The field vitals review is not settled: ${held.join('; ')}.`, data);

    const note = attention.length > 0 ? ` ${attention.length} need attention: ${attention.slice(0, 3).join('; ')}.` : '';
    return pass(`${graded.length} field p75 value(s) across ${record.populations.length} population(s) are graded; this review does not claim the site has Good field Core Web Vitals.${note}`, data);
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
  domainExpiryRdap,
  crawlerFetchLimit,
  privateResponseCaching,
  indexabilityMatrixReconciliation,
  labPerfBudget,
  templateLabPerf,
  lcpElementStrategy,
  fieldCwvMonitor,
];
