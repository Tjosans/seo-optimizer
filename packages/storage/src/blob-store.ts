/**
 * The seam page bodies write through. `@seo/persistence` stores a hash and a
 * key in Postgres (`renders.bodyHash`, `renders.bodyKey`); the bytes
 * themselves live here instead, per the schema's own comment: "Bodies never
 * live in Postgres."
 *
 * Content-addressed means the key is a function of the bytes, not a caller's
 * choice: writing the same body twice, from two crawls of two different
 * sites, returns the same key and costs one upload, not two.
 */
export interface BlobStore {
  /**
   * Write bytes and return the key they were written under. Idempotent: a
   * second `put` of the same bytes returns the same key without writing
   * again, so re-crawling a page whose body has not changed costs a read, not
   * a write.
   */
  put(bytes: Uint8Array): Promise<string>;

  /** Read back the bytes at a key this store produced, or null if none exist. */
  get(key: string): Promise<Uint8Array | null>;
}
