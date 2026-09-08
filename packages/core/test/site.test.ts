/**
 * Reading an AI crawler policy off a site record.
 *
 * The parser is strict on purpose. A policy is the one input to check 2.9 that
 * nothing can be derived from, so a malformed one has no safe reading: grading
 * against half a policy would report agreement with a decision nobody made.
 * A site with no policy at all is a different thing entirely, and is fine.
 */

import { describe, expect, it } from 'vitest';
import { parseAiCrawlerPolicy } from '@seo/core';

const VALID = {
  agents: { GPTBot: 'disallow', 'Google-Extended': 'allow' },
  approvedAt: '2026-09-01',
  approvedBy: 'legal@example.com',
  notes: 'Out of training, in for retrieval.',
};

describe('parseAiCrawlerPolicy', () => {
  it('reads a complete policy', () => {
    expect(parseAiCrawlerPolicy(VALID)).toEqual({
      agents: { GPTBot: 'disallow', 'Google-Extended': 'allow' },
      approvedAt: '2026-09-01',
      approvedBy: 'legal@example.com',
      notes: 'Out of training, in for retrieval.',
    });
  });

  it('treats no policy as no policy rather than an error', () => {
    expect(parseAiCrawlerPolicy(null)).toBeNull();
    expect(parseAiCrawlerPolicy(undefined)).toBeNull();
  });

  it('drops notes when there are none', () => {
    const { notes: _notes, ...withoutNotes } = VALID;
    expect(parseAiCrawlerPolicy(withoutNotes)).not.toHaveProperty('notes');
  });

  it('refuses a policy nobody dated', () => {
    expect(() => parseAiCrawlerPolicy({ ...VALID, approvedAt: 'last spring' })).toThrow(
      /YYYY-MM-DD/,
    );
    const { approvedAt: _at, ...undated } = VALID;
    expect(() => parseAiCrawlerPolicy(undated)).toThrow(/approvedAt/);
  });

  it('refuses a policy nobody signed', () => {
    expect(() => parseAiCrawlerPolicy({ ...VALID, approvedBy: '  ' })).toThrow(/approvedBy/);
  });

  it('refuses a stance that is neither allow nor disallow', () => {
    expect(() => parseAiCrawlerPolicy({ ...VALID, agents: { GPTBot: 'maybe' } })).toThrow(
      /"GPTBot"/,
    );
  });

  it('refuses agents that are not a map of crawler to stance', () => {
    expect(() => parseAiCrawlerPolicy({ ...VALID, agents: ['GPTBot'] })).toThrow(/agents object/);
    const { agents: _agents, ...withoutAgents } = VALID;
    expect(() => parseAiCrawlerPolicy(withoutAgents)).toThrow(/agents object/);
  });

  it('accepts a policy that names no crawlers, which is a decision too', () => {
    // "We considered this and chose to say nothing" is recordable; what it
    // means for a check is the probe's business, not the parser's.
    expect(parseAiCrawlerPolicy({ ...VALID, agents: {} })?.agents).toEqual({});
  });
});
