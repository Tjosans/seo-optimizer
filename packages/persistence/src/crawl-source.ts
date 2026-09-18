/**
 * The read side of `crawl-sink.ts`: given a crawl already written to the
 * database, and the same `BlobStore` its bodies were uploaded to, retrieve the
 * markup each render captured.
 *
 * A page can be archived with nothing to retrieve — `renders.bodyKey` stays
 * null wherever no store was configured when the row was written (see
 * @seo/storage gotcha 5 in CLAUDE.md) — and a stored key can still fail to
 * resolve: the object store is a second system with its own failure modes.
 * `bodyHash` is what lets a caller tell "recovered exactly what was written"
 * from "recovered something, but not that", the same way a checksum on a
 * download would. `ArchivedRenderStatus` names all four shapes a render can be
 * found in rather than throwing on the last two, because a caller
 * reconstructing a whole crawl needs to keep going past one missing or
 * corrupt body, not abort the rest of the crawl on it.
 */

import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { pages, renders } from '@seo/db';
import type { Database } from '@seo/db';
import type { BlobStore } from '@seo/storage';

export type ArchivedRenderStatus =
  /** The body was retrieved and its hash matches what was recorded at capture time. */
  | 'ok'
  /** No key was ever recorded — no store was configured when this render was written. */
  | 'not-stored'
  /** A key was recorded, but the store holds nothing under it. */
  | 'missing'
  /** A key was recorded and the store answered, but the bytes hash to something else. */
  | 'corrupt';

export interface ArchivedRender {
  readonly renderId: string;
  readonly pageId: string;
  readonly mode: 'raw' | 'rendered';
  readonly bodyKey: string | null;
  readonly bodyHash: string;
  readonly status: ArchivedRenderStatus;
  /** The markup itself, present only when `status` is `'ok'`. */
  readonly body: string | null;
}

/**
 * Retrieve and verify one render's body.
 *
 * Pure with respect to the database — it takes the row's own
 * `bodyKey`/`bodyHash` rather than a render id — so the verification rule is
 * testable against a fake store with no query involved, the same split
 * `map.ts` keeps between translation and I/O.
 */
export async function readRenderBody(
  blobStore: BlobStore,
  render: { readonly bodyKey: string | null; readonly bodyHash: string },
): Promise<Pick<ArchivedRender, 'status' | 'body'>> {
  if (render.bodyKey === null) return { status: 'not-stored', body: null };

  const bytes = await blobStore.get(render.bodyKey);
  if (bytes === null) return { status: 'missing', body: null };

  const body = new TextDecoder('utf-8').decode(bytes);
  const hash = createHash('sha256').update(body, 'utf8').digest('hex');
  if (hash !== render.bodyHash) return { status: 'corrupt', body: null };

  return { status: 'ok', body };
}

/**
 * Every render belonging to one archived crawl, bodies retrieved and verified
 * against the hash recorded when each was written.
 */
export async function readArchivedCrawl(
  db: Database,
  blobStore: BlobStore,
  crawlId: string,
): Promise<ArchivedRender[]> {
  const rows = await db
    .select({
      renderId: renders.id,
      pageId: renders.pageId,
      mode: renders.mode,
      bodyKey: renders.bodyKey,
      bodyHash: renders.bodyHash,
    })
    .from(renders)
    .innerJoin(pages, eq(renders.pageId, pages.id))
    .where(eq(pages.crawlId, crawlId));

  const out: ArchivedRender[] = [];
  for (const row of rows) {
    const read = await readRenderBody(blobStore, row);
    out.push({ ...row, ...read });
  }
  return out;
}
