/** `lcp-element-strategy` (1.5): is the report's LCP element discoverable and prioritised. */

import { describe, expect, it } from 'vitest';
import type { CrawledPage } from '@seo/crawler';
import { probeById } from '@seo/probes';
import type { Observation, PageProbe } from '@seo/probes';

const url = 'https://www.example.com/';
const at = '2026-09-01T00:00:00.000Z';

const check = (lcpElement: unknown, body: string, opts: { truncated?: boolean; reportUrl?: string; noReport?: boolean } = {}): Observation => {
  const lighthouse = opts.noReport === true
    ? undefined
    : { owner: 'Jane', recordedAt: at, reports: [{ url: opts.reportUrl ?? url, path: 'r.json', metrics: lcpElement === undefined ? {} : { lcpElement } }] };
  const page = {
    url,
    normalizedUrl: url,
    fetch: { finalUrl: url, body, truncated: opts.truncated ?? false },
    extracted: {},
  } as unknown as CrawledPage;
  return (probeById('lcp-element-strategy') as PageProbe).run({
    page,
    site: { origin: 'https://www.example.com', flags: [], crawl: {} as never, ...(lighthouse === undefined ? {} : { inputs: { lighthouse } as never }) },
  });
};

const html = '<html><body><img src="/hero.jpg"></body></html>';

describe('lcp-element-strategy', () => {
  it('is not applicable without a report for the page', () => {
    expect(check({ tag: 'img', src: '/hero.jpg' }, html, { noReport: true }).outcome).toBe('not-applicable');
    expect(check({ tag: 'img', src: '/hero.jpg' }, html, { reportUrl: 'https://www.example.com/other' }).outcome).toBe('not-applicable');
  });

  it('holds a report that names no LCP element', () => {
    expect(check(undefined, html).outcome).toBe('warn');
  });

  it('passes an LCP image in the raw HTML with default loading', () => {
    expect(check({ tag: 'img', src: 'https://www.example.com/hero.jpg' }, html).outcome).toBe('pass');
  });

  it('fails a lazy or low-priority LCP image', () => {
    expect(check({ tag: 'img', src: '/hero.jpg', loading: 'lazy' }, html).outcome).toBe('fail');
    expect(check({ tag: 'img', src: '/hero.jpg', fetchPriority: 'low' }, html).outcome).toBe('fail');
  });

  it('fails an LCP image the raw HTML does not name', () => {
    expect(check({ tag: 'img', src: '/built-by-script.jpg' }, html).outcome).toBe('fail');
  });

  it('cannot judge discoverability in a truncated body', () => {
    expect(check({ tag: 'img', src: '/late.jpg' }, html, { truncated: true }).outcome).toBe('error');
    expect(check({ tag: 'img', src: '/hero.jpg', loading: 'lazy' }, html, { truncated: true }).outcome).toBe('fail');
  });

  it('warns a text LCP whose inline font has no font-display', () => {
    const bad = '<style>@font-face{font-family:A;src:url(a.woff2)}</style>';
    const good = '<style>@font-face{font-family:A;src:url(a.woff2);font-display:swap}</style>';
    expect(check({ tag: 'h1' }, bad).outcome).toBe('warn');
    expect(check({ tag: 'h1' }, good).outcome).toBe('pass');
  });

  it('does not pass a text LCP when no font is visible', () => {
    expect(check({ tag: 'h1' }, '<html></html>').outcome).toBe('not-applicable');
  });
});
