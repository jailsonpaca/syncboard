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

function normalizeNotes(raw) {
  if (!raw) return '';
  if (Array.isArray(raw)) {
    return raw
      .map((block) => {
        if (!block) return '';
        if (typeof block === 'string') return block;
        return String(block.note || block.body || '');
      })
      .filter(Boolean)
      .join('\n\n');
  }
  return String(raw);
}

function parseVersion(v) {
  return String(v || '0')
    .replace(/^v/, '')
    .split('.')
    .map((n) => parseInt(String(n).replace(/\D.*/, ''), 10) || 0);
}

function isNewer(remote, local) {
  const a = parseVersion(remote);
  const b = parseVersion(local);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

/**
 * @param {{
 *   getAutoCheck: () => boolean,
 *   onUpdateAvailable: (info: { version: string, releaseNotes?: string }) => void,
 *   onUpdateDownloaded: (info: { version: string, releaseNotes?: string }) => void,
 *   onDownloadProgress?: (p: { percent: number, transferred: number, total: number, bytesPerSecond: number }) => void,
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
    hooks.onUpdateAvailable({
      version: info.version,
      releaseNotes: normalizeNotes(info.releaseNotes),
    });
  });

  autoUpdater.on('download-progress', (p) => {
    hooks.onDownloadProgress?.({
      percent: Number(p.percent) || 0,
      transferred: Number(p.transferred) || 0,
      total: Number(p.total) || 0,
      bytesPerSecond: Number(p.bytesPerSecond) || 0,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    hooks.onUpdateDownloaded({
      version: info.version,
      releaseNotes: normalizeNotes(info.releaseNotes),
    });
  });

  autoUpdater.on('error', (err) => {
    console.warn('[updater]', err.message);
    hooks.onError?.(err);
  });

  /**
   * @param {{ force?: boolean }} [opts]
   * force=true ignora a preferência autoUpdate (checagem manual / botão da UI).
   */
  async function check(opts = {}) {
    const force = Boolean(opts.force);
    if (!force && !hooks.getAutoCheck()) return null;
    try {
      const result = await autoUpdater.checkForUpdates();
      const info = result?.updateInfo || null;
      if (info) {
        info.releaseNotes = normalizeNotes(info.releaseNotes);
      }
      return info;
    } catch (err) {
      console.warn('[updater] check:', err.message);
      if (force) throw err;
      return null;
    }
  }

  async function download() {
    await autoUpdater.downloadUpdate();
  }

  function install() {
    autoUpdater.quitAndInstall(false, true);
  }

  return { check, download, install, autoUpdater, loadReleaseConfig };
}

async function fetchGithubReleaseNotes(version) {
  const cfg = loadReleaseConfig();
  const owner = process.env.SYNCBOARD_GH_OWNER || cfg.owner;
  const repo = process.env.SYNCBOARD_GH_REPO || cfg.repo;
  const tag = version ? `v${String(version).replace(/^v/, '')}` : 'latest';
  const url =
    tag === 'latest'
      ? `https://api.github.com/repos/${owner}/${repo}/releases/latest`
      : `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`;

  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'SyncBoard-Desktop',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return '';
    const data = await res.json();
    return String(data.body || '').trim();
  } catch {
    return '';
  }
}

module.exports = {
  setupUpdater,
  loadReleaseConfig,
  fetchGithubReleaseNotes,
  normalizeNotes,
  parseVersion,
  isNewer,
};
