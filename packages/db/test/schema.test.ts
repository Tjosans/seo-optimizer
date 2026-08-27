import { afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  audits,
  checkEvidence,
  checkStates,
  crawls,
  createDatabase,
  pages,
  probeResults,
  sites,
} from '@seo/db';

/**
 * Integration tests against a live Postgres. They verify the constraints the
 * schema claims to enforce — a schema whose guards were never exercised is
 * just documentation.
 *
 * Skipped unless DATABASE_URL is set: `docker compose up -d --wait`, then copy
 * .env.example to .env.
 */
const url = process.env['DATABASE_URL'];

/**
 * Run a statement that must be rejected, and return the name of the constraint
 * that rejected it. Drizzle wraps driver errors in a generic "Failed query"
 * message, so the constraint name — the thing worth asserting on — is only
 * reachable through the cause.
 */
async function violatedConstraint(statement: PromiseLike<unknown>): Promise<string> {
  try {
    await statement;
  } catch (error) {
    const cause = (error as { cause?: { constraint_name?: string } }).cause;
    return cause?.constraint_name ?? String(error);
  }
  throw new Error('expected the statement to be rejected, but it succeeded');
}

describe.skipIf(!url)('schema constraints', () => {
  const handle = createDatabase(url ?? '', { max: 2 });
  const { db } = handle;
  const origins: string[] = [];

  afterAll(async () => {
    for (const origin of origins) await db.delete(sites).where(eq(sites.origin, origin));
    await handle.close();
  });

  /** A site plus an audit, torn down by cascade in afterAll. */
  async function fixture() {
    const origin = `https://test-${crypto.randomUUID()}.example`;
    origins.push(origin);
    const [site] = await db
      .insert(sites)
      .values({ name: 'fixture', origin, flags: ['ecommerce'] })
      .returning();
    const [audit] = await db
      .insert(audits)
      .values({ siteId: site!.id, corpusVersion: '4.4' })
      .returning();
    return { site: site!, audit: audit! };
  }

  it('round-trips a site with its applicability flags', async () => {
    const { site } = await fixture();
    const [read] = await db.select().from(sites).where(eq(sites.id, site.id));
    expect(read?.flags).toEqual(['ecommerce']);
    expect(read?.profile).toBe('core');
  });

  it('refuses to take a check out of scope without a rationale', async () => {
    const { audit } = await fixture();
    expect(
      await violatedConstraint(
        db.insert(checkStates).values({
          auditId: audit.id,
          checkId: '1.14',
          applicability: 'no',
        }),
      ),
    ).toBe('excluded_needs_rationale');

    await db.insert(checkStates).values({
      auditId: audit.id,
      checkId: '1.14',
      applicability: 'no',
      applicabilityRationale: 'Site publishes no non-HTML files.',
    });
    const [read] = await db
      .select()
      .from(checkStates)
      .where(and(eq(checkStates.auditId, audit.id), eq(checkStates.checkId, '1.14')));
    expect(read?.applicability).toBe('no');
  });

  it('refuses an attestation that never lapses', async () => {
    const { audit } = await fixture();
    expect(
      await violatedConstraint(
        db.insert(checkStates).values({
          auditId: audit.id,
          checkId: '0.4',
          applicability: 'yes',
          status: 'passed',
          coverage: 'attested',
        }),
      ),
    ).toBe('attestation_needs_expiry');
  });

  it('refuses a page-scoped probe result with no page', async () => {
    const { audit } = await fixture();
    expect(
      await violatedConstraint(
        db.insert(probeResults).values({
          auditId: audit.id,
          probeId: 'canonicalization',
          scope: 'page',
          outcome: 'fail',
          summary: 'no page attached',
        }),
      ),
    ).toBe('page_scope_needs_page');
  });

  it('keeps every graded check traceable to the observation behind it', async () => {
    const { audit } = await fixture();
    const [crawl] = await db
      .insert(crawls)
      .values({
        auditId: audit.id,
        seedUrl: 'https://example.test/',
        userAgent: 'seo-optimizer/0.1',
        maxPages: 10,
        maxDepth: 2,
      })
      .returning();
    const [page] = await db
      .insert(pages)
      .values({
        crawlId: crawl!.id,
        url: 'https://example.test/',
        normalizedUrl: 'https://example.test/',
        depth: 0,
        status: 200,
      })
      .returning();
    const [result] = await db
      .insert(probeResults)
      .values({
        auditId: audit.id,
        crawlId: crawl!.id,
        pageId: page!.id,
        probeId: 'canonicalization',
        scope: 'page',
        outcome: 'fail',
        summary: 'Self-referencing canonical missing.',
        data: { canonical: null },
      })
      .returning();

    // Evidence cannot be filed against a check that was never graded.
    expect(
      await violatedConstraint(
        db.insert(checkEvidence).values({
          auditId: audit.id,
          checkId: '1.3',
          probeResultId: result!.id,
        }),
      ),
    ).toBe('check_evidence_state_fk');

    await db.insert(checkStates).values({
      auditId: audit.id,
      checkId: '1.3',
      applicability: 'yes',
      status: 'failed',
      coverage: 'verified',
    });
    await db.insert(checkEvidence).values({
      auditId: audit.id,
      checkId: '1.3',
      probeResultId: result!.id,
    });

    const trail = await db
      .select({ summary: probeResults.summary })
      .from(checkEvidence)
      .innerJoin(probeResults, eq(probeResults.id, checkEvidence.probeResultId))
      .where(and(eq(checkEvidence.auditId, audit.id), eq(checkEvidence.checkId, '1.3')));
    expect(trail).toHaveLength(1);
    expect(trail[0]?.summary).toContain('canonical');
  });

  it('rejects the same URL twice in one crawl', async () => {
    const { audit } = await fixture();
    const [crawl] = await db
      .insert(crawls)
      .values({
        auditId: audit.id,
        seedUrl: 'https://example.test/',
        userAgent: 'seo-optimizer/0.1',
        maxPages: 10,
        maxDepth: 2,
      })
      .returning();
    const row = {
      crawlId: crawl!.id,
      url: 'https://example.test/a',
      normalizedUrl: 'https://example.test/a',
      depth: 1,
    };
    await db.insert(pages).values(row);
    expect(await violatedConstraint(db.insert(pages).values(row))).toBe(
      'pages_crawl_url_uniq',
    );
  });
});
