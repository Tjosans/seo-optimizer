/**
 * The registry lookup behind corpus check 1.18.
 *
 * Against a stubbed request function rather than a real registry: the
 * question under test is how an RDAP JSON body is read, and rdap.org is a
 * third party this suite has no business depending on. `crawl.test.ts` and
 * `protocol.test.ts` cover the seam that wires this into a crawl.
 */

import { describe, expect, it } from 'vitest';
import { lookupDomainRdap } from '@seo/crawler';
import type { FetchResult } from '@seo/crawler';

const response = (overrides: Partial<FetchResult> = {}): FetchResult => ({
  requestedUrl: 'https://rdap.org/domain/example.com',
  finalUrl: 'https://rdap.org/domain/example.com',
  status: 200,
  headers: {},
  redirectChain: [],
  body: '{}',
  byteLength: 2,
  truncated: false,
  contentType: 'application/rdap+json',
  ttfbMs: 1,
  totalMs: 1,
  error: null,
  ...overrides,
});

const record = (fields: Record<string, unknown>): string => JSON.stringify(fields);

describe('lookupDomainRdap', () => {
  it('reads the expiration event, registrar and statuses from an RDAP record', async () => {
    const asked: string[] = [];
    const check = await lookupDomainRdap('shop.example.com', {
      request: async (url) => {
        asked.push(url);
        return response({
          body: record({
            events: [
              { eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' },
              { eventAction: 'expiration', eventDate: '2027-01-01T00:00:00Z' },
            ],
            status: ['client transfer prohibited', 'active'],
            entities: [
              {
                roles: ['registrar'],
                vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'Example Registrar, Inc.']]],
              },
              { roles: ['administrative'], vcardArray: ['vcard', [['fn', {}, 'text', 'Not the registrar']]] },
            ],
          }),
        });
      },
    });

    // The registrable domain — last two labels — not the crawled subdomain.
    expect(asked).toEqual(['https://rdap.org/domain/example.com']);
    expect(check).toMatchObject({
      domain: 'example.com',
      expiresAt: '2027-01-01T00:00:00Z',
      registrar: 'Example Registrar, Inc.',
      statuses: ['client transfer prohibited', 'active'],
      error: null,
    });
  });

  it('records a lookup failure as data, never as a thrown error', async () => {
    const check = await lookupDomainRdap('example.com', {
      request: async () => response({ status: 404, body: '' }),
    });
    expect(check.error).toBe('RDAP answered 404');
    expect(check.expiresAt).toBeNull();
  });

  it('records a transport failure the same way', async () => {
    const check = await lookupDomainRdap('example.com', {
      request: async () => response({ status: null, error: 'timeout after 15000ms' }),
    });
    expect(check.error).toBe('timeout after 15000ms');
  });

  it('records an unparseable body as a lookup failure', async () => {
    const check = await lookupDomainRdap('example.com', {
      request: async () => response({ body: 'not json' }),
    });
    expect(check.error).toBe('RDAP response was not valid JSON');
  });

  it('declines a host with no registrable domain, without making a request', async () => {
    let called = false;
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      const check = await lookupDomainRdap(host, {
        request: async () => {
          called = true;
          return response();
        },
      });
      expect(check.error).toBe('no registrable domain to look up');
    }
    expect(called).toBe(false);
  });

  it('records a record with no expiration event as no date, not an error', async () => {
    const check = await lookupDomainRdap('example.com', {
      request: async () => response({ body: record({ events: [], status: [] }) }),
    });
    expect(check.error).toBeNull();
    expect(check.expiresAt).toBeNull();
  });
});
