/**
 * Stopping a crawl in the middle of one.
 *
 * The claim being tested is about someone else's server: once a crawl is
 * cancelled, it stops asking for pages. Counting requests is therefore the
 * assertion that matters — a crawl that "stopped" but kept fetching to its
 * budget would satisfy every state check and still be doing the thing
 * cancellation exists to prevent.
 */

import { describe, expect, it } from 'vitest';
import { crawl, CrawlCancelledError } from '@seo/crawler';
import { startFixtureSite } from '@seo/testkit';

const BASE = {
  userAgent: 'seo-optimizer/0.1 (+test)',
  maxPages: 50,
  maxDepth: 3,
  followSitemaps: false,
} as const;

describe('cancelling a crawl', () => {
  it('stops fetching, and reports the stop as a cancellation', async () => {
    const site = await startFixtureSite();
    try {
      const controller = new AbortController();
      const fetched: string[] = [];

      const crawling = crawl({
        ...BASE,
        seeds: [`${site.origin}/`],
        signal: controller.signal,
        onPage: (page) => {
          fetched.push(page.normalizedUrl);
          // Stop as soon as the crawl has proved it is running.
          if (fetched.length === 2) controller.abort();
        },
      });

      await expect(crawling).rejects.toThrow(CrawlCancelledError);
      // At most the request already in flight when the signal landed.
      expect(fetched.length).toBeLessThanOrEqual(3);
    } finally {
      await site.close();
    }
  }, 30_000);

  it('does not wait out the politeness delay before noticing', async () => {
    const site = await startFixtureSite();
    try {
      const controller = new AbortController();
      const started = Date.now();

      const crawling = crawl({
        ...BASE,
        seeds: [`${site.origin}/`],
        // Ten seconds between requests: if cancellation waited for the delay,
        // this test would take ten seconds rather than failing.
        requestDelayMs: 10_000,
        signal: controller.signal,
        onPage: () => {
          controller.abort();
        },
      });

      await expect(crawling).rejects.toThrow(CrawlCancelledError);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await site.close();
    }
  }, 30_000);

  it('refuses to start at all when the signal is already aborted', async () => {
    const site = await startFixtureSite();
    try {
      let requests = 0;
      await expect(
        crawl({
          ...BASE,
          seeds: [`${site.origin}/`],
          signal: AbortSignal.abort(),
          onPage: () => {
            requests += 1;
          },
        }),
      ).rejects.toThrow(CrawlCancelledError);
      expect(requests).toBe(0);
    } finally {
      await site.close();
    }
  }, 30_000);

  it('is unaffected by a signal that never fires', async () => {
    const site = await startFixtureSite();
    try {
      const controller = new AbortController();
      const result = await crawl({
        ...BASE,
        seeds: [`${site.origin}/`],
        signal: controller.signal,
      });
      expect(result.pages.length).toBeGreaterThan(1);
    } finally {
      await site.close();
    }
  }, 30_000);
});
