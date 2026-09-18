/**
 * Domain registration data, read from the registry's own RDAP record.
 *
 * Corpus check 1.18 asks for a domain with no near-term expiry risk and a
 * named, protected owner — most of which lives in a registrar account this
 * engine cannot see. Expiry is the one fact a public record settles either
 * way: RDAP (RFC 9083), the successor to WHOIS, answers in JSON over HTTPS
 * and every gTLD and most ccTLD registries publish one. `rdap.org` is used as
 * the single entry point rather than IANA's own bootstrap registry, because it
 * already does the bootstrap lookup and redirects to the authoritative server,
 * which keeps this to one request instead of two.
 *
 * Made through `fetchPage`, the crawl's own request function, because RDAP is
 * nothing but an HTTPS GET returning JSON and `fetchPage` already reads a
 * JSON body, follows redirects and reports a failure as data rather than an
 * exception — everything this needs and nothing it does not.
 */

import { isIP } from 'node:net';
import { fetchPage } from './fetch.js';
import type { FetchOptions, FetchResult } from './fetch.js';

export interface RdapCheck {
  /** The registrable domain looked up. */
  readonly domain: string;
  /** The registry's expiration event, as an ISO date/time. Null if absent. */
  readonly expiresAt: string | null;
  /** The registrar's name, from the RDAP entity carrying the `registrar` role. */
  readonly registrar: string | null;
  /** RDAP status values verbatim — `client transfer prohibited`, `active`, … */
  readonly statuses: readonly string[];
  /**
   * When the lookup was made, by the crawl's clock, as an ISO 8601 instant.
   *
   * "Expires in 10 days" means nothing without the day it was said on, and
   * recording it here — rather than asking the clock when a probe runs — keeps
   * a re-grade of a stored crawl saying what it said the first time.
   */
  readonly fetchedAt: string;
  /** Set when no registration record was obtained. Never a verdict about the site. */
  readonly error: string | null;
}

export interface RdapOptions {
  readonly timeoutMs?: number;
  readonly userAgent?: string;
  /** Injection seam for tests, like `fetchImpl` on the crawl itself. */
  readonly request?: (url: string, options: FetchOptions) => Promise<FetchResult>;
}

/**
 * The registrable domain, approximated as a host's last two labels.
 *
 * The correct answer needs the public suffix list, to tell "example.co.uk"
 * (three labels) from "example.com" (two), and this engine carries no such
 * list. Guessing wrong sends the registry a domain that does not exist, which
 * RDAP answers with a 404 — recorded here as a lookup `error`, never as a
 * finding about the site, so an approximation that fails closed rather than
 * asserting an expiry date for the wrong name.
 */
export function registrableDomain(hostname: string): string | null {
  if (isIP(hostname) !== 0) return null;
  const labels = hostname.split('.').filter((label) => label !== '');
  if (labels.length < 2) return null;
  return labels.slice(-2).join('.');
}

interface RdapEvent {
  readonly eventAction?: string;
  readonly eventDate?: string;
}

interface RdapEntity {
  readonly roles?: readonly string[];
  readonly vcardArray?: unknown;
}

/** The registrar entity's `fn` (formatted name) field from its jCard. */
function registrarName(entities: unknown): string | null {
  if (!Array.isArray(entities)) return null;
  for (const entity of entities as unknown[]) {
    if (typeof entity !== 'object' || entity === null) continue;
    const roles = (entity as RdapEntity).roles;
    if (!Array.isArray(roles) || !roles.includes('registrar')) continue;
    const vcard = (entity as RdapEntity).vcardArray;
    if (!Array.isArray(vcard) || !Array.isArray(vcard[1])) continue;
    for (const field of vcard[1] as unknown[]) {
      if (Array.isArray(field) && field[0] === 'fn' && typeof field[3] === 'string') {
        return field[3];
      }
    }
  }
  return null;
}

const failure = (domain: string, fetchedAt: string, error: string): RdapCheck => ({
  domain,
  expiresAt: null,
  registrar: null,
  statuses: [],
  fetchedAt,
  error,
});

export async function lookupDomainRdap(hostname: string, options: RdapOptions = {}): Promise<RdapCheck> {
  const domain = registrableDomain(hostname);
  if (domain === null) {
    return failure(hostname, new Date().toISOString(), 'no registrable domain to look up');
  }

  const request = options.request ?? fetchPage;
  const result = await request(`https://rdap.org/domain/${domain}`, {
    userAgent: options.userAgent ?? 'seo-optimizer/0.1 (+rdap)',
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const fetchedAt = new Date().toISOString();

  if (result.error !== null) return failure(domain, fetchedAt, result.error);
  if (result.status !== 200) return failure(domain, fetchedAt, `RDAP answered ${result.status ?? 'no status'}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    return failure(domain, fetchedAt, 'RDAP response was not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return failure(domain, fetchedAt, 'RDAP response was not a JSON object');
  }

  const record = parsed as { events?: readonly RdapEvent[]; status?: unknown; entities?: unknown };
  const expiresAt = Array.isArray(record.events)
    ? record.events.find((event) => event.eventAction === 'expiration')?.eventDate ?? null
    : null;
  const statuses = Array.isArray(record.status)
    ? record.status.filter((value): value is string => typeof value === 'string')
    : [];

  return {
    domain,
    expiresAt,
    registrar: registrarName(record.entities),
    statuses,
    fetchedAt,
    error: null,
  };
}
