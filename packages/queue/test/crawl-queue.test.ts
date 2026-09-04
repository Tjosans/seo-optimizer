/**
 * The queue against the thing it exists for.
 *
 * Two fixture sites stand in for two customers being audited at once. The
 * assertion that matters is the pair: crawls of different origins overlap, and
 * crawls of the same origin never do.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crawl } from '@seo/crawler';
import type { CrawlResult } from '@seo/crawler';
import { JobQueue } from '@seo/queue';
import { startFixtureSite } from '@seo/testkit';
import type { FixtureSite } from '@seo/testkit';

interface CrawlJob {
  readonly origin: string;
}

const USER_AGENT = 'seo-optimizer/0.1 (+test)';

let sites: FixtureSite[];

beforeAll(async () => {
  sites = await Promise.all([startFixtureSite(), startFixtureSite()]);
}, 30_000);

afterAll(async () => {
  await Promise.all(sites.map((site) => site.close()));
});

describe('crawling through the queue', () => {
  it('overlaps crawls of different origins and never two of one origin', async () => {
    const active = new Set<string>();
    const overlaps: string[] = [];
    let peak = 0;

    const queue = new JobQueue<CrawlJob, CrawlResult>({
      concurrency: 4,
      handler: async ({ origin }) => {
        if (active.has(origin)) overlaps.push(origin);
        active.add(origin);
        peak = Math.max(peak, active.size);
        try {
          return await crawl({
            seeds: [`${origin}/`],
            userAgent: USER_AGENT,
            maxPages: 10,
            maxDepth: 2,
          });
        } finally {
          active.delete(origin);
        }
      },
    });

    // Two audits of each site, all four eligible to start at once as far as the
    // concurrency budget is concerned.
    const handles = sites.flatMap((site) => [
      queue.enqueue({ origin: site.origin }, { lane: site.origin }),
      queue.enqueue({ origin: site.origin }, { lane: site.origin }),
    ]);

    const results = await Promise.all(handles.map((handle) => handle.done));

    expect(overlaps).toEqual([]);
    expect(peak).toBe(2);
    for (const result of results) expect(result.pages.length).toBeGreaterThan(0);
    expect(queue.list('complete')).toHaveLength(4);
  }, 30_000);

  it('reports a crawl that throws as a failed job and keeps going', async () => {
    const queue = new JobQueue<CrawlJob, CrawlResult>({
      concurrency: 2,
      handler: ({ origin }) =>
        crawl({ seeds: origin === '' ? [] : [`${origin}/`], userAgent: USER_AGENT, maxPages: 5, maxDepth: 1 }),
    });

    const site = sites[0];
    expect(site).toBeDefined();

    const broken = queue.enqueue({ origin: '' }, { id: 'broken', lane: 'broken' });
    const fine = queue.enqueue({ origin: site!.origin }, { id: 'fine', lane: site!.origin });

    await expect(broken.done).rejects.toThrow(/at least one seed/);
    await expect(fine.done).resolves.toBeDefined();
    expect(queue.get('broken')?.state).toBe('failed');
    expect(queue.get('fine')?.state).toBe('complete');
  }, 30_000);
});
