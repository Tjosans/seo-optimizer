/**
 * A second audit of a site reads the first one back as `SiteContext.previous`.
 *
 * Skipped unless DATABASE_URL is set: `npm run stack:up`, then copy
 * .env.example to .env.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { loadCorpus } from '@seo/corpus';
import type { AxeViolation, RenderResult } from '@seo/crawler';
import { createDatabase, probeResults, sites } from '@seo/db';
import { AuditScheduler, PermanentAuditError, loadPreviousAudit } from '@seo/scheduler';
import type { CrawlBudget } from '@seo/scheduler';
import { startFixtureSite } from '@seo/testkit';
import type { FixtureSite } from '@seo/testkit';

const BUDGET: CrawlBudget = { userAgent: 'seo-optimizer/0.1 (+test)', maxPages: 5, maxDepth: 1 };
const CORPUS = loadCorpus(fileURLToPath(new URL('../../../corpus/v4.4', import.meta.url)));
const corpus = (version: string) => {
  if (version !== CORPUS.version) throw new PermanentAuditError(`no corpus ${version} on disk`);
  return CORPUS;
};

let site: FixtureSite;
beforeAll(async () => {
  site = await startFixtureSite();
}, 30_000);
afterAll(async () => {
  await site.close();
});

const url = process.env['DATABASE_URL'];

describe.skipIf(!url)('loadPreviousAudit', () => {
  const handle = createDatabase(url ?? '', { max: 4 });
  const { db } = handle;

  afterAll(async () => {
    await db.delete(sites).where(eq(sites.origin, site.origin));
    await handle.close();
  });

  it('is null for a site with no earlier completed audit, then rebuilds the first from its rows', async () => {
    await db.delete(sites).where(eq(sites.origin, site.origin));
    const [row] = await db
      .insert(sites)
      .values({ name: 'fixture-previous', origin: site.origin, flags: [] })
      .returning({ id: sites.id });
    const siteId = row!.id;

    const scheduler = new AuditScheduler({ db, corpus, crawl: BUDGET });
    const first = await scheduler.submit({ siteId, corpusVersion: '4.4' });
    await first.done;
    expect(
      await loadPreviousAudit(db, { siteId, origin: site.origin, excludeAuditId: first.auditId }),
    ).toBeNull();

    const second = await scheduler.submit({ siteId, corpusVersion: '4.4' });
    await second.done;
    await scheduler.close();

    const previous = await loadPreviousAudit(db, {
      siteId,
      origin: site.origin,
      excludeAuditId: second.auditId,
    });
    expect(previous?.pages.length).toBeGreaterThan(0);
    expect(previous?.pages.some((page) => page.status === 200 && page.title !== null)).toBe(true);
    expect(previous?.probes.length).toBeGreaterThan(0);
  }, 90_000);

  it('rebuilds each page’s axe results from its rendered row, so a second rendered audit is compared', async () => {
    const rendered = await startFixtureSite();
    // The browser is stood in for: every page renders with one violation, and
    // the second audit's renders carry a critical one the first did not.
    let violations: AxeViolation[] = [{ id: 'color-contrast', impact: 'serious', nodes: 3 }];
    const renderImpl = async (target: string): Promise<RenderResult> => ({
      requestedUrl: target,
      finalUrl: target,
      status: 200,
      html: '<!doctype html><html lang="en"><head><title>Rendered</title></head><body><h1>Rendered</h1></body></html>',
      totalMs: 5,
      error: null,
      requests: [],
      accessibility: { violations, error: null },
      largestPaint: null,
    });
    const [row] = await db
      .insert(sites)
      .values({ name: 'fixture-previous-rendered', origin: rendered.origin, flags: [] })
      .returning({ id: sites.id });
    const siteId = row!.id;
    const scheduler = new AuditScheduler({
      db,
      corpus,
      crawl: { ...BUDGET, renderPages: true, renderAccessibility: true, renderImpl },
    });
    try {
      const first = await scheduler.submit({ siteId, corpusVersion: '4.4' });
      await first.done;

      violations = [...violations, { id: 'image-alt', impact: 'critical', nodes: 1 }];
      const second = await scheduler.submit({ siteId, corpusVersion: '4.4' });
      await second.done;

      const previous = await loadPreviousAudit(db, {
        siteId,
        origin: rendered.origin,
        excludeAuditId: second.auditId,
      });
      const home = previous?.pages.find((page) => page.url === `${rendered.origin}/`);
      expect(home?.axe).toEqual([{ id: 'color-contrast', impact: 'serious', nodes: 3 }]);
      // A page with no rendered row — a redirect, a 404 with no HTML — has none.
      expect(previous?.pages.every((page) => page.axe !== undefined)).toBe(true);

      const [verdict] = await db
        .select({ outcome: probeResults.outcome, summary: probeResults.summary })
        .from(probeResults)
        .where(
          and(eq(probeResults.auditId, second.auditId), eq(probeResults.probeId, 'a11y-regression-sampling')),
        );
      expect(verdict?.outcome).toBe('fail');
      expect(verdict?.summary).toContain('image-alt');
    } finally {
      await scheduler.close();
      await db.delete(sites).where(eq(sites.id, siteId));
      await rendered.close();
    }
  }, 90_000);
});
