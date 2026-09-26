// Packages `stage/` (see scripts/stage.mjs) as a one-click Windows installer
// that installs per-user — no admin prompt — and updates itself in place from
// this repository's GitHub Releases. `npm run dist` builds it locally;
// `npm run release` also publishes, which CI does (.github/workflows/release.yml).

module.exports = {
  appId: 'com.tjosans.seo-optimizer',
  productName: 'SEO Optimizer',
  electronVersion: require('electron/package.json').version,
  directories: { app: 'stage', output: 'release', buildResources: 'build' },
  files: ['**/*'],
  asar: true,
  // Read from disk at run time, so they sit beside the app, not in the asar.
  extraResources: [
    { from: '../../corpus', to: 'corpus', filter: ['v*/**'] },
    { from: '../../packages/db/migrations', to: 'migrations' },
    { from: '../dashboard/public', to: 'public' },
  ],
  win: {
    target: ['nsis'],
    artifactName: 'SEO-Optimizer-Setup-${version}.${ext}',
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    shortcutName: 'SEO Optimizer',
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    // Settings (.env) and logs survive an uninstall; the database is not ours.
    deleteAppDataOnUninstall: false,
  },
  // SEO_UPDATE_FEED points a build at a plain HTTP directory instead, to try
  // an update end to end without publishing a release: build one version with
  // it set, install that, then serve a later build's `release/` from the URL.
  publish: process.env.SEO_UPDATE_FEED
    ? [{ provider: 'generic', url: process.env.SEO_UPDATE_FEED }]
    : [{ provider: 'github', owner: 'Tjosans', repo: 'seo-optimizer', releaseType: 'release' }],
};
