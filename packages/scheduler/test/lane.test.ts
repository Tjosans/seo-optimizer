/**
 * Which audits share a lane.
 *
 * No database: the lane is a pure function of a site's origin, and what it has
 * to get right is which spellings reach the same server.
 */

import { describe, expect, it } from 'vitest';
import { auditLane } from '@seo/scheduler';

describe('the lane an audit runs in', () => {
  it('is one lane for every scheme and www spelling of a site', () => {
    // An audit of any of these tests all four, so any two of them run
    // together would reach the same server twice over.
    const spellings = [
      'https://example.com',
      'http://example.com',
      'https://www.example.com',
      'http://WWW.Example.COM',
      'https://example.com:443',
    ];
    expect(new Set(spellings.map(auditLane))).toEqual(new Set(['example.com']));
  });

  it('keeps a service on its own port apart', () => {
    expect(auditLane('https://example.com:8443')).toBe('example.com:8443');
    // Which is what lets two fixture sites on one loopback address run side
    // by side in a test.
    expect(auditLane('http://127.0.0.1:4001')).not.toBe(auditLane('http://127.0.0.1:4002'));
  });

  it('keeps other subdomains apart', () => {
    expect(auditLane('https://blog.example.com')).toBe('blog.example.com');
    expect(auditLane('https://blog.example.com')).not.toBe(auditLane('https://example.com'));
  });

  it('refuses an origin that is not a URL rather than laning it with nothing', () => {
    expect(() => auditLane('example.com')).toThrow();
  });
});
