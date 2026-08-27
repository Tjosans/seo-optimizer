import { describe, expect, it } from 'vitest';
import { crawlDelayMs, groupFor, isAllowed, parseRobots } from '@seo/crawler';

const AGENT = 'seo-optimizer';

describe('parseRobots', () => {
  it('groups consecutive user-agent lines with the rules that follow', () => {
    const robots = parseRobots(`
      User-agent: googlebot
      User-agent: seo-optimizer
      Disallow: /admin/
      Crawl-delay: 2

      User-agent: *
      Disallow: /
    `);
    expect(robots.groups).toHaveLength(2);
    expect(groupFor(robots, AGENT)?.agents).toContain('seo-optimizer');
    expect(crawlDelayMs(robots, AGENT)).toBe(2000);
  });

  it('reads sitemap lines and ignores comments', () => {
    const robots = parseRobots(
      '# a comment\nSitemap: https://example.com/sitemap.xml\nDisallow: /x # trailing',
    );
    expect(robots.sitemaps).toEqual(['https://example.com/sitemap.xml']);
  });

  it('treats an empty Disallow as no rule at all', () => {
    const robots = parseRobots('User-agent: *\nDisallow:');
    expect(isAllowed(robots, AGENT, 'https://example.com/anything')).toBe(true);
  });
});

describe('isAllowed', () => {
  it('lets the longest matching rule win, with Allow breaking a tie', () => {
    const robots = parseRobots(`
      User-agent: *
      Disallow: /files/
      Allow: /files/public/
    `);
    expect(isAllowed(robots, AGENT, 'https://example.com/files/secret.pdf')).toBe(false);
    expect(isAllowed(robots, AGENT, 'https://example.com/files/public/report.pdf')).toBe(true);
  });

  it('honours wildcards and end-of-path anchors', () => {
    const robots = parseRobots(`
      User-agent: *
      Disallow: /*.pdf$
      Disallow: /search?*
    `);
    expect(isAllowed(robots, AGENT, 'https://example.com/a/b.pdf')).toBe(false);
    expect(isAllowed(robots, AGENT, 'https://example.com/a/b.pdf?v=1')).toBe(true);
    expect(isAllowed(robots, AGENT, 'https://example.com/search?q=x')).toBe(false);
  });

  it('prefers the most specific agent group over the wildcard group', () => {
    const robots = parseRobots(`
      User-agent: *
      Disallow: /

      User-agent: seo-optimizer
      Disallow: /private/
    `);
    expect(isAllowed(robots, AGENT, 'https://example.com/public')).toBe(true);
    expect(isAllowed(robots, AGENT, 'https://example.com/private/x')).toBe(false);
    expect(isAllowed(robots, 'some-other-bot', 'https://example.com/public')).toBe(false);
  });

  it('allows anything no rule matches, and anything when robots.txt is absent', () => {
    const robots = parseRobots('User-agent: *\nDisallow: /admin/');
    expect(isAllowed(robots, AGENT, 'https://example.com/')).toBe(true);
    expect(isAllowed({ groups: [], sitemaps: [], absent: true }, AGENT, 'https://x.test/a')).toBe(
      true,
    );
  });
});
