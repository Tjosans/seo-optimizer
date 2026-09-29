/**
 * `parseSiteInput` (`sites.ts`) without a database: what counts as an origin.
 * A site's origin seeds every crawl of it, so anything but
 * `scheme://host[:port]` is refused, listed with the other problems.
 */

import { describe, expect, it } from 'vitest';
import { parseSiteInput, SiteInputError } from '../src/sites.js';

const problemsOf = (body: unknown): readonly string[] => {
  try {
    parseSiteInput(body, true);
  } catch (error) {
    if (error instanceof SiteInputError) return error.problems;
    throw error;
  }
  return [];
};

describe('parseSiteInput origin', () => {
  it.each([
    'https://example.com',
    'http://example.com',
    'https://www.example.com',
    'https://example.com:8443',
    'http://127.0.0.1:3000',
    'http://localhost:3000',
    'HTTPS://Example.com',
  ])('accepts %s', (origin) => {
    expect(parseSiteInput({ name: 'x', origin }, true).origin).toBe(origin);
  });

  it('trims whitespace and trailing slashes, as parseReleaseFile does', () => {
    expect(parseSiteInput({ name: 'x', origin: '  https://example.com//  ' }, true).origin).toBe('https://example.com');
  });

  it.each([
    ['example.com', 'expected an origin like https://example.com'],
    ['example.com/path', 'expected an origin like https://example.com'],
    ['ftp://example.com', 'expected an http or https origin'],
    ['mailto:someone@example.com', 'expected an http or https origin'],
    ['https://user:secret@example.com', 'must not carry a user name or password'],
    ['https://example.com/path', 'expected scheme://host[:port], with no path, query or fragment'],
    ['https://example.com/.', 'expected scheme://host[:port], with no path, query or fragment'],
    ['https://example.com?utm=x', 'expected scheme://host[:port], with no path, query or fragment'],
    ['https://example.com#top', 'expected scheme://host[:port], with no path, query or fragment'],
    ['https:example.com', 'expected scheme://host[:port], with no path, query or fragment'],
    ['https://exa mple.com', 'expected an origin like https://example.com'],
  ])('refuses %s', (origin, text) => {
    expect(problemsOf({ name: 'x', origin })).toEqual([`origin: ${text}`]);
  });

  it('lists a bad origin with every other problem', () => {
    expect(problemsOf({ name: '', origin: 'example.com/path' })).toEqual([
      'name: expected non-empty text',
      'origin: expected an origin like https://example.com',
    ]);
  });

  it('checks an origin on an update too', () => {
    expect(() => parseSiteInput({ origin: 'https://example.com/shop' }, false)).toThrow(SiteInputError);
  });
});
