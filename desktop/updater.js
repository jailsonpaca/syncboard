const { autoUpdater } = require('electron-updater');
const fs = require('fs');
const path = require('path');

function loadReleaseConfig() {
  const candidates = [
    path.join(process.resourcesPath || '', 'release.config.json'),
    path.join(__dirname, '..', 'release.config.json'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      /* next */
    }
  }
  return { owner: 'jailsonpaca', repo: 'syncboard', downloadUrl: '' };
}

/**
 * @param {{
 *   getAutoCheck: () => boolean,
 *   onUpdateAvailable: (info: { version: string }) => void,
 *   onUpdateDownloaded: (info: { version: string }) => void,
 *   onError?: (err: Error) => void,
 * }} hooks
 */
function setupUpdater(hooks) {
  const cfg = loadReleaseConfig();
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  try {
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: process.env.SYNCBOARD_GH_OWNER || cfg.owner,
      repo: process.env.SYNCBOARD_GH_REPO || cfg.repo,
    });
  } catch (err) {
    console.warn('[updater] feed:', err.message);
  }

  autoUpdater.on('update-available', (info) => {
    hooks.onUpdateAvailable({ version: info.version });
  });

  autoUpdater.on('update-downloaded', (info) => {
    hooks.onUpdateDownloaded({ version: info.version });
  });

  autoUpdater.on('error', (err) => {
    console.warn('[updater]', err.message);
    hooks.onError?.(err);
  });

  async function check() {
    if (!hooks.getAutoCheck()) return null;
    try {
      const result = await autoUpdater.checkForUpdates();
      return result?.updateInfo || null;
    } catch (err) {
      console.warn('[updater] check:', err.message);
      return null;
    }
  }

  async function download() {
    await autoUpdater.downloadUpdate();
  }

  function install() {
    autoUpdater.quitAndInstall(false, true);
  }

  return { check, download, install, autoUpdater };
}

module.exports = { setupUpdater, loadReleaseConfig };
