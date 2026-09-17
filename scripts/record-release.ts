/**
 * Enter a release and its review runs from a file — the way in until the
 * audit API exists.
 *
 *     npm run release -- my-release.yaml
 *     npm run release -- my-release.yaml --dry-run
 *
 * The file names a site by origin; the site must already be on record. See
 * `scripts/release.example.yaml` for every field, and `release-file.ts` in
 * @seo/grader for the rules: nothing guessed, all or nothing, and a file can
 * be imported again as it grows.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { CURRENT_CORPUS_VERSION, loadCorpus } from '@seo/corpus';
import { createDatabase, databaseUrlFromEnv } from '@seo/db';
import { importReleaseFile, parseReleaseFile } from '@seo/grader';
import type { ReleaseFile } from '@seo/grader';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const paths = args.filter((arg) => !arg.startsWith('--'));
const unknown = args.filter((arg) => arg.startsWith('--') && arg !== '--dry-run');
if (paths.length !== 1 || unknown.length > 0) {
  console.error('usage: npm run release -- <file.yaml|file.json> [--dry-run]');
  process.exit(2);
}

try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  // No .env: DATABASE_URL may come from the environment itself.
}

let file: ReleaseFile;
try {
  // JSON is YAML, so one parser reads both.
  file = parseReleaseFile(parse(readFileSync(paths[0]!, 'utf8')));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
const version = file.corpus ?? CURRENT_CORPUS_VERSION;
const corpus = loadCorpus(join(ROOT, 'corpus', `v${version}`));

const handle = createDatabase(databaseUrlFromEnv(), { max: 1 });
try {
  const result = await importReleaseFile(handle.db, { file, corpus, dryRun });
  const verb = result.dryRun ? 'would record' : 'recorded';
  console.log(`${file.site} (site ${result.siteId}), checked against corpus v${version}`);
  if (result.release !== null) {
    console.log(`  release ${result.release.releaseId}: ${result.dryRun ? 'would save' : 'saved'} as ${result.release.id}`);
  }
  console.log(`  ${verb} ${result.recorded.length} review run(s)${list(result.recorded)}`);
  console.log(`  already logged: ${result.unchanged.length}${list(result.unchanged)}`);
  if (result.dryRun) console.log('  dry run: nothing was written');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await handle.close();
}

function list(ids: readonly string[]): string {
  return ids.length === 0 ? '' : ` (${ids.join(', ')})`;
}
