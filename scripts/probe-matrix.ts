/**
 * Print the probe matrix: every detector the corpus declares, and whether the
 * engine can observe it yet.
 *
 * Run it before promising a customer that a check is automated.
 *
 *     npm run probes:matrix
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorpus } from '@seo/corpus';
import { buildProbeMatrix, formatProbeMatrix } from '@seo/probes';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const corpus = loadCorpus(join(root, 'corpus', 'v4.4'));
const matrix = buildProbeMatrix(corpus);

console.log(formatProbeMatrix(matrix));

if (matrix.orphanProbes.length > 0) {
  console.log(`\nORPHAN PROBES (no corpus check declares these): ${matrix.orphanProbes.join(', ')}`);
  process.exitCode = 1;
}
