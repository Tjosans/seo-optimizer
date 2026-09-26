// Lays out the app electron-builder packages, in `stage/`.
//
// The main process is bundled with esbuild into one file, because the
// workspace's @seo/* packages are symlinks electron-builder cannot follow.
// What cannot be bundled stays external and is installed into the stage
// with npm: electron-updater, and Playwright, which @seo/crawler imports for
// rendered crawls and which resolves its own files at run time. The version
// stamped on the app is the root package.json's, the project's one version.

import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(desktop, '..', '..');
const stage = join(desktop, 'stage');

const EXTERNAL = ['electron-updater', 'playwright', '@axe-core/playwright'];
// Read off disk: not every package exports its package.json. The workspace
// hoists them all to the root node_modules.
const installed = (name) =>
  JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

await build({
  entryPoints: [join(desktop, 'dist', 'main.js')],
  outfile: join(stage, 'main.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['electron', ...EXTERNAL],
  // CommonJS dependencies bundled into an ES module still call require().
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'warning',
});
copyFileSync(join(desktop, 'dist', 'preload.cjs'), join(stage, 'preload.cjs'));

const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify(
    {
      name: 'seo-optimizer',
      productName: 'SEO Optimizer',
      version: rootPackage.version,
      description: 'SEO launch-readiness auditor',
      author: 'Tjosans',
      type: 'module',
      main: 'main.js',
      dependencies: Object.fromEntries(EXTERNAL.map((name) => [name, installed(name)])),
    },
    null,
    2,
  ) + '\n',
);
execSync('npm install --omit=dev --no-audit --no-fund --workspaces=false', { cwd: stage, stdio: 'inherit' });
console.log(`staged v${rootPackage.version} in ${stage}`);
