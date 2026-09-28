// The version badge in the page's corner. The version comes from the
// dashboard server (`GET /version`), so the browser dashboard and the desktop
// app show it the same way. Inside the desktop app, the preload script also
// exposes `window.seoDesktop`, which reports the self-updater's progress here.

const versionText = document.getElementById('version-text');
const updateText = document.getElementById('update-text');
const restartButton = document.getElementById('update-restart');

fetch('/version')
  .then((res) => res.json())
  .then(({ version }) => {
    if (version) versionText.textContent = `v${version}`;
  })
  .catch(() => {});

const desktop = window.seoDesktop;
if (desktop) {
  desktop.onUpdateStatus(showUpdate);
  restartButton.addEventListener('click', () => desktop.restartToUpdate());
}

function showUpdate(status) {
  const messages = {
    checking: null,
    'up-to-date': null,
    available: `v${status.version} found, downloading…`,
    downloading: `downloading v${status.version} — ${Math.round(status.percent ?? 0)}%`,
    ready: `v${status.version} is ready to install`,
    restarting: `installing v${status.version} — reopens by itself`,
    error: 'update check failed',
  };
  const message = messages[status.state] ?? null;
  updateText.textContent = message ?? '';
  updateText.classList.toggle('hidden', message === null);
  if (status.state === 'ready') restartButton.textContent = `Update to v${status.version}`;
  restartButton.classList.toggle('hidden', status.state !== 'ready');
}
