import { describe, expect, it } from 'vitest';
import { hostVariants, isSameSite, normalizeUrl, pathDepth, resolveUrl } from '@seo/crawler';

describe('normalizeUrl', () => {
  it('collapses only differences the URL standard calls equivalent', () => {
    expect(normalizeUrl('HTTPS://Example.COM:443/a')).toBe('https://example.com/a');
    expect(normalizeUrl('http://example.com:80')).toBe('http://example.com/');
    expect(normalizeUrl('https://example.com/a#section')).toBe('https://example.com/a');
  });

  it('keeps differences a server may legitimately route on', () => {
    // Trailing slash, path case and parameter order are the site's business,
    // and treating them as identical would hide the duplicate-content finding.
    expect(normalizeUrl('https://example.com/a')).not.toBe(normalizeUrl('https://example.com/a/'));
    expect(normalizeUrl('https://example.com/A')).not.toBe(normalizeUrl('https://example.com/a'));
    expect(normalizeUrl('https://example.com/?b=2&a=1')).toBe('https://example.com/?b=2&a=1');
  });

  it('strips campaign parameters, which never identify a document', () => {
    expect(normalizeUrl('https://example.com/a?utm_source=x&id=7')).toBe(
      'https://example.com/a?id=7',
    );
    expect(normalizeUrl('https://example.com/a?gclid=x')).toBe('https://example.com/a');
    expect(normalizeUrl('https://example.com/a?utm_source=x', { stripTracking: false })).toBe(
      'https://example.com/a?utm_source=x',
    );
  });

  it('returns null for anything that is not an absolute http(s) URL', () => {
    for (const input of ['mailto:a@b.com', 'tel:+123', 'javascript:void(0)', '/relative', 'nonsense']) {
      expect(normalizeUrl(input), input).toBeNull();
    }
  });
});

describe('resolveUrl', () => {
  it('resolves relative hrefs against the page they were found on', () => {
    expect(resolveUrl('../b', 'https://example.com/a/c')).toBe('https://example.com/b');
    expect(resolveUrl('  /b  ', 'https://example.com/a')).toBe('https://example.com/b');
  });

  it('ignores in-page anchors and empty hrefs', () => {
    expect(resolveUrl('#top', 'https://example.com/a')).toBeNull();
    expect(resolveUrl('', 'https://example.com/a')).toBeNull();
  });
});

describe('scope helpers', () => {
  it('treats a subdomain as a different site', () => {
    expect(isSameSite('https://example.com/a', 'https://example.com')).toBe(true);
    expect(isSameSite('https://shop.example.com/a', 'https://example.com')).toBe(false);
  });

  it('counts path segments', () => {
    expect(pathDepth('https://example.com/')).toBe(0);
    expect(pathDepth('https://example.com/a/b/')).toBe(2);
  });
});

describe('hostVariants', () => {
  it('offers both schemes and both host spellings of a real domain', () => {
    expect(hostVariants('https://example.com/some/page').sort()).toEqual([
      'http://example.com/',
      'http://www.example.com/',
      'https://example.com/',
      'https://www.example.com/',
    ]);
  });

  it('reaches the same four from a www seed', () => {
    expect(hostVariants('http://www.example.com/').sort()).toEqual(
      hostVariants('https://example.com/').sort(),
    );
  });

  it('offers none for a host that cannot have them', () => {
    // A staging environment is not a misconfigured site, and reporting
    // www.127.0.0.1 as unreachable would say it was.
    expect(hostVariants('http://127.0.0.1:8080/')).toEqual([]);
    expect(hostVariants('http://localhost:3000/')).toEqual([]);
    expect(hostVariants('not a url')).toEqual([]);
  });
});
