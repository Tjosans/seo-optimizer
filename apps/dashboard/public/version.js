// The version beside the product name, and the self-updater's progress in
// the sidebar. The version comes from the dashboard server (`GET /version`),
// so the browser dashboard and the desktop app show it the same way. Inside
// the desktop app the preload script also exposes `window.seoDesktop`, which
// reports the updater's state, and installs a downloaded update only when
// its button is pressed; the Settings page reads the last one from
// `window.seoUpdateStatus` and listens for `seo-update-status`.

const versionText = document.getElementById('version-text');
const badge = document.getElementById('version-badge');
const updateText = document.getElementById('update-text');
const updateBar = document.getElementById('update-bar');
const restartButton = document.getElementById('update-restart');

fetch('/version')
  .then((res) => res.json())
  .then(({ version }) => {
    if (version) {
      versionText.textContent = `v${version}`;
      window.seoVersion = version;
      window.dispatchEvent(new CustomEvent('seo-version', { detail: version }));
    }
  })
  .catch(() => {});

const desktop = window.seoDesktop;
if (desktop) {
  desktop.onUpdateStatus(showUpdate);
  restartButton.addEventListener('click', () => desktop.restartToUpdate());
}

export function updateMessage(status) {
  const messages = {
    checking: null,
    'up-to-date': null,
    available: `v${status.version} found, downloading…`,
    downloading: `Downloading v${status.version} — ${Math.round(status.percent ?? 0)}%`,
    ready: `v${status.version} is ready to install.`,
    restarting: `Installing v${status.version} — the app reopens by itself`,
    error: 'The update check failed. The app tries again within the hour.',
  };
  return messages[status.state] ?? null;
}

function showUpdate(status) {
  window.seoUpdateStatus = status;
  window.dispatchEvent(new CustomEvent('seo-update-status', { detail: status }));
  const message = updateMessage(status);
  badge.hidden = message === null;
  updateText.textContent = message ?? '';
  updateBar.hidden = status.state !== 'downloading';
  updateBar.firstElementChild.style.width = `${Math.round(status.percent ?? 0)}%`;
  if (status.state === 'ready') restartButton.textContent = `Update to v${status.version}`;
  restartButton.hidden = status.state !== 'ready';
}
