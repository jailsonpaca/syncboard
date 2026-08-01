const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  clipboard,
  nativeImage,
  shell,
  dialog,
  ipcMain,
  globalShortcut,
  Notification,
} = require('electron');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Store = require('electron-store');
const WebSocket = require('ws');
const autostart = require('./autostart');
const hotkeyUtil = require('./hotkey');
const appPaths = require('./paths');
const offlineCache = require('./offline-cache');
const { createOfflineHub } = require('./offline-hub');
const { simulatePaste, sleep } = require('./paste');
const { discoverByCode, discoverServers, parseJoinPayload } = require('./pair-discover');
const {
  setupUpdater,
  loadReleaseConfig,
  fetchGithubReleaseNotes,
  isNewer,
} = require('./updater');
const {
  readClipboardFilePaths,
  writeClipboardFilePaths,
  mimeFromPath,
  resolveNamedMediaFile,
  copyToPublicInbox,
  revealFileInFolder,
} = require('./clipboard-files');

/** Vídeos/arquivos grandes — upload multipart (não path como texto). */
const MAX_FILE_UPLOAD = 200 * 1024 * 1024;
const OFFLINE_PORT = 8790;

const ROOT = appPaths.ROOT;
const store = new Store({
  defaults: {
    serverUrl: 'http://localhost:8787',
    runLocalServer: true,
    deviceName: os.hostname(),
    autoSync: true,
    launchAtLogin: true,
    autoUpdate: true,
    port: 8787,
    hotkey: hotkeyUtil.DEFAULT_HOTKEY,
  },
});

// Migra atalho antigo padrão → Alt+V
const LEGACY_DEFAULT_HOTKEYS = new Set([
  'CommandOrControl+Shift+V',
  'CmdOrCtrl+Shift+V',
  'Control+Shift+V',
  'Command+Shift+V',
]);
{
  const currentHotkey = store.get('hotkey');
  if (LEGACY_DEFAULT_HOTKEYS.has(currentHotkey) || /[^\x20-\x7E]/.test(String(currentHotkey || ''))) {
    store.set('hotkey', hotkeyUtil.DEFAULT_HOTKEY);
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  console.error('[syncboard] Já existe uma instância. Saindo.');
  app.quit();
  process.exit(0);
}

console.log('[syncboard] iniciando', {
  packaged: app.isPackaged,
  platform: process.platform,
  version: app.getVersion(),
  userData: app.getPath('userData'),
});

let tray = null;
let mainWindow = null;
let compactWindow = null;
let compactReady = false;
let prefsWindow = null;
let serverProcess = null;
let serverStartedByUs = false;
let ws = null;
let wsReconnectTimer = null;
let pollTimer = null;
let remoteProbeTimer = null;
let lastHash = '';
/** Hashes recentes (evita reupload da mesma imagem no Mac). */
const recentClipHashes = new Set();
const RECENT_HASH_LIMIT = 40;
let pollInFlight = false;
let connected = false;
/** true = usando hub local (sem rede do servidor remoto). */
let offlineMode = false;
let offlineHub = null;
let offlineStarting = false;
let remoteFailStreak = 0;
/** URL remota preferida quando o cliente não hospeda o servidor. */
let preferredRemoteUrl = null;
let pinnedItems = [];
let historyItems = [];
/** @type {null | {
 *   version: string,
 *   downloaded: boolean,
 *   releaseNotes?: string,
 *   phase?: 'idle' | 'downloading' | 'installing' | 'error',
 *   progress?: number,
 *   error?: string | null,
 * }} */
let updateInfo = null;
let updaterApi = null;
let updateCheckTimer = null;
let updateBusy = false;

const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

function offlineRoot() {
  return path.join(app.getPath('userData'), 'offline');
}

function persistLocalCache() {
  offlineCache.save(offlineRoot(), { pinned: pinnedItems, history: historyItems });
}

function loadLocalCache() {
  const data = offlineCache.load(offlineRoot());
  pinnedItems = data.pinned || [];
  historyItems = data.history || [];
}

async function cacheItemBlob(item) {
  if (!item || item.type === 'text' || offlineCache.hasBlob(offlineRoot(), item.id)) return;
  try {
    const res = await fetch(`${apiBase()}/items/${item.id}/blob`);
    if (!res.ok) return;
    const buf = Buffer.from(await res.arrayBuffer());
    offlineCache.saveBlob(offlineRoot(), item.id, buf);
  } catch {
    /* offline / blob indisponível */
  }
}

async function cacheImportantBlobs() {
  const targets = [
    ...pinnedItems.filter((i) => i.type !== 'text').slice(0, 30),
    ...historyItems.filter((i) => i.type === 'image').slice(0, 15),
  ];
  for (const item of targets) {
    await cacheItemBlob(item);
  }
}

// Linux: sem Dock. Mac: mantém no Dock para o usuário achar/abrir a janela.
if (isLinux) {
  app.dock?.hide();
}

app.setName('SyncBoard');

function getConfig(key) {
  return store.get(key);
}

function setConfig(key, value) {
  store.set(key, value);
}

function apiBase() {
  return `${getConfig('serverUrl').replace(/\/$/, '')}/api`;
}

function wsUrl() {
  const u = new URL(getConfig('serverUrl'));
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws';
  return u.toString();
}

function trayIconName() {
  const size = isMac ? 22 : 32;
  return isMac ? `tray-template-${size}.png` : `tray-${size}.png`;
}

function loadTrayIcon() {
  const name = trayIconName();
  const candidates = [];
  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'icons', name));
  }
  candidates.push(path.join(__dirname, 'icons', name));
  candidates.push(path.join(app.getPath('userData'), 'icons', name));

  for (const iconPath of candidates) {
    try {
      if (!fs.existsSync(iconPath)) continue;
      const img = nativeImage.createFromPath(iconPath);
      if (img.isEmpty()) continue;
      if (isMac) img.setTemplateImage(true);
      return img;
    } catch {
      /* tenta próximo */
    }
  }

  // Nunca escrever dentro do .asar — gera em userData
  try {
    const outDir = path.join(app.getPath('userData'), 'icons');
    require('./generate-icons').generateTo(outDir);
    const img = nativeImage.createFromPath(path.join(outDir, name));
    if (isMac) img.setTemplateImage(true);
    return img;
  } catch (err) {
    console.warn('[tray] ícone fallback vazio:', err.message);
    return nativeImage.createEmpty();
  }
}

function waitForServer(maxAttempts = 30) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = async () => {
      try {
        const res = await fetch(`${apiBase()}/health`);
        if (res.ok) return resolve(true);
      } catch { /* retry */ }
      attempts++;
      if (attempts >= maxAttempts) return reject(new Error('Servidor não respondeu'));
      setTimeout(check, 500);
    };
    check();
  });
}

/** Servidor antigo (pré-pareamento) responde /health mas não tem /pair. */
async function serverSupportsPairing() {
  try {
    const res = await fetch(`${apiBase()}/pair`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function killListenersOnPort(port) {
  try {
    if (process.platform === 'win32') {
      execSync(
        `for /f "tokens=5" %a in ('netstat -ano ^| findstr :${port} ^| findstr LISTENING') do taskkill /F /PID %a`,
        { stdio: 'ignore', shell: 'cmd.exe' }
      );
      return;
    }
    const pids = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`, { encoding: 'utf8' })
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGTERM');
      } catch { /* already gone */ }
    }
  } catch {
    /* nobody listening */
  }
}

async function startLocalServer() {
  if (!getConfig('runLocalServer')) return;
  // Linux empacotado = sempre cliente remoto (conecta ao Mac)
  if (isLinux && appPaths.isPackaged()) return;

  // Daemon externo / LaunchAgent — reutilizar se já tiver API de pareamento
  try {
    await waitForServer(3);
    if (await serverSupportsPairing()) {
      serverStartedByUs = false;
      console.log('[server] já online (daemon externo)');
      return;
    }
    console.warn('[server] online mas sem /api/pair — reiniciando processo na porta');
    killListenersOnPort(getConfig('port'));
    await new Promise((r) => setTimeout(r, 600));
  } catch { /* sobe um filho detached */ }

  const serverDist = appPaths.serverDistPath();
  if (!fs.existsSync(serverDist)) {
    throw new Error('Servidor não encontrado. Reinstale o SyncBoard.');
  }

  const nodeBin = appPaths.isPackaged() ? process.execPath : 'node';
  const releaseDir = path.join(appPaths.ROOT, 'desktop', 'release');
  const releaseConfigPath = app.isPackaged
    ? path.join(process.resourcesPath, 'release.config.json')
    : path.join(ROOT, 'release.config.json');
  const spawnEnv = {
    ...process.env,
    PORT: String(getConfig('port')),
    HOST: '0.0.0.0',
    SYNCBOARD_DATA: appPaths.userDataPath(),
    SYNCBOARD_CLIENT_DIST: appPaths.clientDistPath(),
    SYNCBOARD_RELEASE_DIR: fs.existsSync(releaseDir) ? releaseDir : '',
    SYNCBOARD_RELEASE_CONFIG: fs.existsSync(releaseConfigPath) ? releaseConfigPath : '',
    SYNCBOARD_GH_OWNER: loadReleaseConfig().owner,
    SYNCBOARD_GH_REPO: loadReleaseConfig().repo,
  };
  if (appPaths.isPackaged()) {
    spawnEnv.ELECTRON_RUN_AS_NODE = '1';
  }

  await new Promise((resolve, reject) => {
    // detached: server continua se o Electron for morto/reiniciado
    serverProcess = spawn(nodeBin, [serverDist], {
      cwd: appPaths.serverCwd(),
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    serverStartedByUs = true;
    serverProcess.unref();

    serverProcess.stdout?.on('data', (d) => process.stdout.write(`[server] ${d}`));
    serverProcess.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));
    serverProcess.on('error', reject);
    serverProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) console.error(`[server] encerrado com código ${code}`);
      serverProcess = null;
    });

    waitForServer(40).then(resolve).catch(reject);
  });
}

function stopLocalServer() {
  // Não mata o daemon — senão a rede (Linux/Android) cai ao fechar o app
  serverProcess = null;
  serverStartedByUs = false;
}

/** Paths temporários / screenshot do pasteboard do macOS — não tratar como "arquivo". */
function isMacEphemeralImagePath(filePath) {
  if (!filePath) return false;
  const p = String(filePath);
  const base = path.basename(p).toLowerCase();
  const ext = path.extname(base);
  const imageExt = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.tif', '.tiff', '.heic']);
  if (!imageExt.has(ext)) return false;
  if (p.includes('/var/folders/') || p.includes('/private/var/folders/')) return true;
  if (p.startsWith('/tmp') || p.includes('/TemporaryItems/')) return true;
  // Screenshot na Área de Trabalho / pasta Screenshots ainda tem bitmap no clipboard
  if (/^screenshot\b/i.test(base) || /^screen shot\b/i.test(base)) return true;
  return false;
}

function readClipboardImage() {
  const img = clipboard.readImage();
  if (!img || img.isEmpty()) return null;
  // Bitmap cru é estável no Mac; toPNG() muda a cada leitura e gerava duplicatas
  let bitmap;
  try {
    bitmap = img.toBitmap();
  } catch {
    bitmap = null;
  }
  const size = img.getSize();
  if (!bitmap || !bitmap.length || !size.width || !size.height) {
    const png = img.toPNG();
    if (!png || png.length < 100) return null;
    return { type: 'image', data: png, mime: 'image/png', bitmap: null, width: 0, height: 0 };
  }
  // PNG só na hora do upload (uma vez), não a cada poll
  return {
    type: 'image',
    mime: 'image/png',
    bitmap,
    width: size.width,
    height: size.height,
    get data() {
      if (!this._png) this._png = img.toPNG();
      return this._png;
    },
  };
}

function readLocalClipboard() {
  const imageClip = readClipboardImage();

  // Arquivos do Finder/Nautilus — mas no Mac imagem+path temporário causa flip/flicker.
  // Com bitmap presente, pula osascript (caro) — evita travar o SyncBoard no poll.
  const filePaths = readClipboardFilePaths({ skipOsascript: Boolean(imageClip && isMac) });
  if (filePaths.length) {
    const filePath = filePaths[0];
    let st;
    try {
      st = fs.statSync(filePath);
    } catch {
      st = null;
    }
    if (st?.isFile()) {
      const mime = mimeFromPath(filePath);
      const ephemeralImage = isMac && imageClip && isMacEphemeralImagePath(filePath);
      const imageFileWithBitmap =
        isMac && imageClip && mime.startsWith('image/');

      // Prioriza o bitmap da clipboard (estável) em vez do path que oscila no macOS
      if (ephemeralImage || imageFileWithBitmap) {
        return imageClip;
      }

      return {
        type: 'file',
        filePath,
        filename: path.basename(filePath),
        mime,
        size: st.size,
        mtimeMs: st.mtimeMs,
      };
    }
  }

  if (imageClip) return imageClip;

  const text = clipboard.readText()?.trim();
  if (text) {
    // WhatsApp etc.: só o nome "video.mp4" sem arquivo → não sincroniza lixo
    const looksLikeMediaName =
      /^[^\\/]+\.(mp4|m4v|mov|mkv|webm|avi|mp3|wav|pdf|zip|png|jpe?g|gif|webp)$/i.test(text);
    if (looksLikeMediaName && !resolveNamedMediaFile(text)) {
      console.warn('[sync] nome de mídia sem arquivo em Disco/Downloads:', text);
      return null;
    }
    return { type: 'text', data: text };
  }
  return null;
}

function rememberHash(hash) {
  if (!hash) return;
  lastHash = hash;
  recentClipHashes.add(hash);
  if (recentClipHashes.size > RECENT_HASH_LIMIT) {
    const first = recentClipHashes.values().next().value;
    recentClipHashes.delete(first);
  }
}

/** Libera hash reservado quando o upload falha — permite retry no próximo poll. */
function forgetHash(hash) {
  if (!hash) return;
  recentClipHashes.delete(hash);
  if (lastHash === hash) lastHash = '';
}

function hashClip(clip) {
  if (clip.type === 'text') {
    return crypto.createHash('sha256').update(`text:${clip.data}`).digest('hex');
  }
  if (clip.type === 'file') {
    return crypto
      .createHash('sha256')
      .update(`file:${clip.filePath}:${clip.size}:${clip.mtimeMs}`)
      .digest('hex');
  }
  // Imagem: hash do bitmap (estável). PNG do macOS NÃO é estável entre leituras.
  if (clip.bitmap && clip.width && clip.height) {
    return crypto
      .createHash('sha256')
      .update(`image:${clip.width}x${clip.height}:`)
      .update(clip.bitmap)
      .digest('hex');
  }
  return crypto.createHash('sha256').update(clip.data).digest('hex');
}

function inboxDir() {
  const dir = path.join(app.getPath('userData'), 'inbox');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function downloadItemToInbox(item) {
  const res = await fetch(`${apiBase()}/items/${item.id}/blob`);
  if (!res.ok) throw new Error('Falha ao baixar arquivo');
  const buf = Buffer.from(await res.arrayBuffer());
  const safeName = (item.filename || `syncboard-${item.id}`).replace(/[^\w.\- ()[\]]+/g, '_');
  const dest = path.join(inboxDir(), `${item.id.slice(0, 8)}-${safeName}`);
  fs.writeFileSync(dest, buf);
  return dest;
}

function writeLocalClipboardText(text) {
  clipboard.writeText(text);
}

function writeLocalClipboardImage(buffer) {
  const img = nativeImage.createFromBuffer(buffer);
  clipboard.writeImage(img);
}

/** Depois de escrever na clipboard, marca o hash estável (bitmap) para não reenviar. */
function rememberClipboardAfterWrite(fallbackClip) {
  try {
    const current = readLocalClipboard();
    if (current) {
      rememberHash(hashClip(current));
      return;
    }
  } catch {
    /* ok */
  }
  if (fallbackClip) rememberHash(hashClip(fallbackClip));
}

async function pushClip(clip) {
  if (clip.type === 'text') {
    const res = await fetch(`${apiBase()}/items/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: clip.data, deviceName: getConfig('deviceName') }),
    });
    return res.ok;
  }

  if (clip.type === 'file') {
    if (clip.size > MAX_FILE_UPLOAD) {
      console.warn(
        `[sync] arquivo grande demais (${Math.round(clip.size / 1024 / 1024)}MB > ${MAX_FILE_UPLOAD / 1024 / 1024}MB):`,
        clip.filename
      );
      return false;
    }
    const buf = fs.readFileSync(clip.filePath);
    const form = new FormData();
    form.append(
      'file',
      new Blob([buf], { type: clip.mime }),
      clip.filename || 'file'
    );
    form.append('deviceName', getConfig('deviceName'));
    const res = await fetch(`${apiBase()}/items/upload`, {
      method: 'POST',
      body: form,
    });
    return res.ok;
  }

  const res = await fetch(`${apiBase()}/items/upload-base64`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: clip.data.toString('base64'),
      mimeType: clip.mime,
      filename: 'clipboard.png',
      deviceName: getConfig('deviceName'),
    }),
  });
  return res.ok;
}

/** Guarda o clipboard só no cache local (sem servidor remoto). */
function pushClipLocal(clip) {
  const root = offlineRoot();
  const data = offlineCache.load(root);
  const deviceName = getConfig('deviceName');

  if (clip.type === 'text') {
    return offlineCache.createText(root, data, {
      content: clip.data,
      deviceName,
    });
  }

  if (clip.type === 'file') {
    if (clip.size > MAX_FILE_UPLOAD) return null;
    const buf = fs.readFileSync(clip.filePath);
    return offlineCache.createBinary(root, data, {
      buffer: buf,
      type: 'file',
      mimeType: clip.mime,
      filename: clip.filename || path.basename(clip.filePath),
      deviceName,
    });
  }

  return offlineCache.createBinary(root, data, {
    buffer: clip.data,
    type: 'image',
    mimeType: clip.mime || 'image/png',
    filename: 'clipboard.png',
    deviceName,
  });
}

async function pullItem(item) {
  if (item.deviceName === getConfig('deviceName')) return;

  if (item.type === 'text' && item.content) {
    writeLocalClipboardText(item.content);
    rememberClipboardAfterWrite({ type: 'text', data: item.content });
    updateTrayMenu();
    return;
  }

  if (item.type === 'image') {
    const res = await fetch(`${apiBase()}/items/${item.id}/blob`);
    if (!res.ok) return;
    const buf = Buffer.from(await res.arrayBuffer());
    writeLocalClipboardImage(buf);
    rememberClipboardAfterWrite({ type: 'image', data: buf });
    updateTrayMenu();
    return;
  }

  // Arquivos/vídeos: não auto-cola (evita path texto); usuário escolhe no popup
  if (item.type === 'file') {
    updateTrayMenu();
  }
}

async function pollClipboard() {
  if (!getConfig('autoSync')) return;
  // Evita uploads paralelos: no Mac a imagem demora e o interval disparava 4–5x
  if (pollInFlight) return;
  pollInFlight = true;

  try {
    const clip = readLocalClipboard();
    if (!clip) return;

    const hash = hashClip(clip);
    if (hash === lastHash || recentClipHashes.has(hash)) {
      lastHash = hash;
      return;
    }

    // Reserva o hash ANTES do upload (upload lento ≠ novo item)
    rememberHash(hash);

    // Tenta HTTP mesmo se o WS caiu — sync de clipboard não depende só do WebSocket
    try {
      const ok = await pushClip(clip);
      if (ok) {
        await refreshItems();
        updateTrayMenu();
        return;
      }
      // HTTP respondeu erro — libera para retry no próximo poll
      forgetHash(hash);
      console.warn('[sync] upload falhou — retry no próximo poll');
      return;
    } catch (err) {
      forgetHash(hash);
      console.warn('[sync] upload erro:', err?.message || err);
      // Sem servidor: cai no modo local abaixo
    }

    // Offline: histórico local no próprio cliente (clipboard entre si + Fixo em cache)
    try {
      // Re-reserva: item ficou só no cache local
      rememberHash(hash);
      const item = pushClipLocal(clip);
      if (!item) return;
      historyItems = [item, ...historyItems.filter((i) => i.id !== item.id)].slice(0, 100);
      persistLocalCache();
      if (offlineHub) {
        offlineHub.broadcast({ type: 'item_created', item });
      }
      updateTrayMenu();
    } catch (err) {
      console.warn('[sync] local:', err.message);
    }
  } finally {
    pollInFlight = false;
  }
}

async function fetchItemsFlat(pinned, limit) {
  const res = await fetch(`${apiBase()}/items?pinned=${pinned}&limit=${limit}&flat=true`);
  if (!res.ok) throw new Error('items');
  const data = await res.json();
  return Array.isArray(data) ? data : data.items || [];
}

async function refreshItems() {
  try {
    const [pinned, history] = await Promise.all([
      fetchItemsFlat(true, 50),
      fetchItemsFlat(false, 50),
    ]);
    pinnedItems = pinned;
    historyItems = history;
    if (!offlineMode) {
      offlineCache.mergeFromRemote(offlineRoot(), offlineCache.load(offlineRoot()), {
        pinned,
        history,
      });
      const merged = offlineCache.load(offlineRoot());
      // Mantém itens localOnly criados offline junto com o snapshot remoto
      const localPinned = merged.pinned.filter((i) => i.localOnly);
      const localHistory = merged.history.filter((i) => i.localOnly);
      pinnedItems = [...pinned, ...localPinned.filter((i) => !pinned.some((p) => p.id === i.id))];
      historyItems = [
        ...history,
        ...localHistory.filter((i) => !history.some((h) => h.id === i.id)),
      ].slice(0, 100);
      void cacheImportantBlobs();
    }
    persistLocalCache();
  } catch {
    // Não apaga o que já temos — usa cache local
    if (!pinnedItems.length && !historyItems.length) {
      loadLocalCache();
    }
  }
}

function connectWs() {
  if (ws) {
    ws.removeAllListeners();
    ws.close();
  }

  try {
    ws = new WebSocket(wsUrl());
  } catch (err) {
    connected = false;
    updateTrayMenu();
    wsReconnectTimer = setTimeout(connectWs, 3000);
    return;
  }

  ws.on('open', () => {
    connected = true;
    remoteFailStreak = 0;
    try {
      ws.send(JSON.stringify({ type: 'hello', deviceName: getConfig('deviceName') }));
    } catch {
      /* ok */
    }
    updateTrayMenu();
  });

  ws.on('message', async (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'sync_request' && msg.items) {
      pinnedItems = msg.items.pinned || [];
      historyItems = msg.items.history || [];
      persistLocalCache();
      if (!offlineMode) void cacheImportantBlobs();
      updateTrayMenu();
    }
    if (msg.type === 'item_created' && msg.item) {
      if (msg.item.pinned) {
        pinnedItems = [msg.item, ...pinnedItems.filter((i) => i.id !== msg.item.id)];
      } else {
        historyItems = [msg.item, ...historyItems.filter((i) => i.id !== msg.item.id)];
      }
      persistLocalCache();
      if (!offlineMode) void cacheItemBlob(msg.item);
      updateTrayMenu();
      await pullItem(msg.item);
    }
    if (msg.type === 'item_updated' && msg.item) {
      await refreshItems();
      updateTrayMenu();
    }
    if (msg.type === 'item_deleted' && msg.id) {
      pinnedItems = pinnedItems.filter((i) => i.id !== msg.id);
      historyItems = historyItems.filter((i) => i.id !== msg.id);
      persistLocalCache();
      updateTrayMenu();
    }
  });

  ws.on('close', () => {
    connected = false;
    updateTrayMenu();
    // Quedas longas (não glitches): ativa modo local no cliente remoto
    if (!offlineMode && !getConfig('runLocalServer')) {
      remoteFailStreak += 1;
      if (remoteFailStreak >= 3) {
        void ensureOfflineMode('ws-unreachable');
      }
    }
    wsReconnectTimer = setTimeout(connectWs, 3000);
  });

  ws.on('error', () => ws?.close());
}

async function ensureOfflineMode(reason = '') {
  if (offlineMode || offlineStarting) return;
  if (getConfig('runLocalServer')) {
    // Servidor local: só garante cache; a UI já aponta para localhost
    loadLocalCache();
    updateTrayMenu();
    return;
  }

  offlineStarting = true;
  console.log(`[offline] ativando hub local (${reason || 'remoto indisponível'})`);
  preferredRemoteUrl = preferredRemoteUrl || getConfig('serverUrl');
  loadLocalCache();

  try {
    if (!offlineHub) {
      offlineHub = createOfflineHub({
        root: offlineRoot(),
        clientDist: appPaths.clientDistPath(),
        port: OFFLINE_PORT,
        deviceName: getConfig('deviceName'),
      });
      await offlineHub.start();
    }
    offlineMode = true;
    setConfig('serverUrl', `http://127.0.0.1:${OFFLINE_PORT}`);
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    connectWs();
    await refreshItems();
    reloadAppWindows();
    updateTrayMenu();
    startRemoteProbe();
  } catch (err) {
    console.error('[offline] falha ao iniciar hub:', err.message);
    // Mesmo sem hub HTTP, tray/clipboard local continuam via cache
    offlineMode = true;
    updateTrayMenu();
  } finally {
    offlineStarting = false;
  }
}

async function leaveOfflineMode() {
  if (!offlineMode || !preferredRemoteUrl) return;

  const remote = preferredRemoteUrl.replace(/\/$/, '');
  try {
    const res = await fetch(`${remote}/api/health`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return;
  } catch {
    return;
  }

  console.log('[offline] servidor remoto de volta — reconectando');
  offlineMode = false;
  setConfig('serverUrl', remote);
  preferredRemoteUrl = null;

  if (offlineHub) {
    try {
      await offlineHub.stop();
    } catch {
      /* ok */
    }
    offlineHub = null;
  }

  if (remoteProbeTimer) {
    clearInterval(remoteProbeTimer);
    remoteProbeTimer = null;
  }

  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  connectWs();
  await refreshItems();
  reloadAppWindows();
  updateTrayMenu();
}

function startRemoteProbe() {
  if (remoteProbeTimer) clearInterval(remoteProbeTimer);
  remoteProbeTimer = setInterval(() => {
    void leaveOfflineMode();
  }, 15000);
}

function reloadAppWindows() {
  const mainUrl = getAppUrl(false);
  const compactUrl = getAppUrl(true);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(mainUrl);
  }
  if (compactWindow && !compactWindow.isDestroyed()) {
    compactReady = false;
    compactWindow.loadURL(compactUrl);
  }
}

function truncate(text, max = 40) {
  if (!text) return '(vazio)';
  const oneLine = text.replace(/\s+/g, ' ');
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function itemLabel(item) {
  if (item.label) return item.label;
  if (item.type === 'text') return truncate(item.content, 35);
  if (item.type === 'image') return item.filename || 'Imagem';
  return item.filename || 'Arquivo';
}

async function resolveItemBuffer(item) {
  const local = offlineCache.readBlob(offlineRoot(), item.id);
  if (local) return local;

  const res = await fetch(`${apiBase()}/items/${item.id}/blob`);
  if (!res.ok) throw new Error('Falha ao baixar arquivo');
  const buf = Buffer.from(await res.arrayBuffer());
  offlineCache.saveBlob(offlineRoot(), item.id, buf);
  return buf;
}

async function copyItem(item) {
  try {
    if (item.type === 'text' && item.content) {
      writeLocalClipboardText(item.content);
      rememberClipboardAfterWrite({ type: 'text', data: item.content });
    } else if (item.type === 'image') {
      const buf = await resolveItemBuffer(item);
      writeLocalClipboardImage(buf);
      rememberClipboardAfterWrite({ type: 'image', data: buf });
    } else if (item.type === 'file') {
      let filePath;
      const localBuf = offlineCache.readBlob(offlineRoot(), item.id);
      if (localBuf) {
        const safeName = (item.filename || `syncboard-${item.id}`).replace(/[^\w.\- ()[\]]+/g, '_');
        filePath = path.join(inboxDir(), `${item.id.slice(0, 8)}-${safeName}`);
        fs.writeFileSync(filePath, localBuf);
      } else {
        filePath = await downloadItemToInbox(item);
        try {
          offlineCache.saveBlob(offlineRoot(), item.id, fs.readFileSync(filePath));
        } catch {
          /* ok */
        }
      }
      const publicPath = copyToPublicInbox(filePath, item.filename || path.basename(filePath));
      const wrote = await writeClipboardFilePaths([publicPath]);
      const st = fs.statSync(publicPath);
      rememberHash(hashClip({
        type: 'file',
        filePath: publicPath,
        size: st.size,
        mtimeMs: st.mtimeMs,
      }));
      updateTrayMenu();
      return {
        ok: true,
        pasted: false,
        kind: 'file',
        localPath: publicPath,
        wroteClipboard: wrote,
      };
    } else {
      shell.openExternal(`${apiBase()}/items/${item.id}/blob`);
      return { ok: true, pasted: false, kind: 'file' };
    }
    updateTrayMenu();
    return { ok: true, pasted: false, kind: item.type };
  } catch (err) {
    dialog.showErrorBox('SyncBoard', `Erro ao copiar: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

function notifyUser(title, body) {
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body }).show();
    }
  } catch { /* ok */ }
  console.log(`[notify] ${title}: ${body}`);
}

async function bumpItemToTop(item) {
  if (!item?.id || item.pinned) return item;
  try {
    const res = await fetch(`${apiBase()}/items/${item.id}/touch`, { method: 'POST' });
    if (res.ok) {
      const updated = await res.json();
      historyItems = [updated, ...historyItems.filter((i) => i.id !== updated.id)];
      persistLocalCache();
      updateTrayMenu();
      return updated;
    }
  } catch {
    /* offline sem hub: bump só na memória/cache */
    const updated = { ...item, updatedAt: Date.now() };
    historyItems = [updated, ...historyItems.filter((i) => i.id !== updated.id)];
    persistLocalCache();
    updateTrayMenu();
    return updated;
  }
  return item;
}

/** Tenta colar com retries — o app anterior precisa recuperar o foco após esconder o popup. */
async function simulatePasteWithRetry(attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    // Espera o foco voltar ao app anterior (blur/hide do Electron é assíncrono)
    await sleep(i === 0 ? 160 : 220);
    const pasted = await simulatePaste();
    if (pasted) return true;
  }
  return false;
}

/** Copia e cola no app que estava focado antes do popup (texto/imagem/arquivo). */
async function pasteItemIntoFocus(item) {
  // Esconde a UI cedo para o app anterior recuperar o foco enquanto baixamos/copiamos
  if (compactWindow && !compactWindow.isDestroyed() && compactWindow.isVisible()) {
    compactWindow.hide();
  }
  if (isMac) app.hide();

  const target = await bumpItemToTop(item);
  const copied = await copyItem(target);
  if (!copied?.ok) return copied;

  try {
    // Arquivo: Ctrl+V é instável — SEMPRE salva e abre a pasta com o arquivo
    if (target.type === 'file' && copied.localPath) {
      const revealed = revealFileInFolder(copied.localPath);
      // tenta colar na pasta focada também (bônus)
      if (copied.wroteClipboard) {
        await simulatePasteWithRetry(2);
      }
      notifyUser(
        'SyncBoard',
        revealed
          ? `Vídeo salvo: ${copied.localPath}`
          : `Salvo em Downloads/SyncBoard — ${path.basename(copied.localPath)}`
      );
      return {
        ok: true,
        pasted: false,
        kind: 'file',
        localPath: copied.localPath,
        revealed: true,
      };
    }

    const pasted = await simulatePasteWithRetry(3);

    return { ok: true, pasted, kind: target.type };
  } catch (err) {
    console.warn('[paste]', err.message);
    if (target.type === 'file' && copied.localPath) {
      revealFileInFolder(copied.localPath);
      notifyUser('SyncBoard', `Salvo em ${copied.localPath}`);
    }
    return { ok: true, pasted: false, kind: target.type, error: err.message, revealed: true, localPath: copied.localPath };
  }
}

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

function getAppUrl(compact = false) {
  const base = getConfig('serverUrl').replace(/\/$/, '');
  return compact ? `${base}?view=compact` : base;
}

function setupCompactAutoClose(win) {
  win.on('blur', () => {
    setTimeout(() => {
      if (!compactWindow || compactWindow.isDestroyed() || win !== compactWindow) return;
      if (prefsWindow && !prefsWindow.isDestroyed() && prefsWindow.isFocused()) return;
      // Esconde em vez de destruir — próximo atalho abre instantaneamente
      if (!win.isFocused() && win.isVisible()) win.hide();
    }, 80);
  });
}

/** Pré-cria o popup do atalho (oculto) para abertura quase instantânea. */
function ensureCompactWindow() {
  if (compactWindow && !compactWindow.isDestroyed()) return compactWindow;

  compactReady = false;
  compactWindow = new BrowserWindow({
    width: 380,
    height: 480,
    minWidth: 320,
    minHeight: 380,
    maxWidth: 480,
    maxHeight: 620,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: 'SyncBoard',
    backgroundColor: '#0f0f12',
    show: false,
    frame: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });

  compactWindow.setAlwaysOnTop(true, 'floating');
  setupCompactAutoClose(compactWindow);

  compactWindow.webContents.once('did-finish-load', () => {
    compactReady = true;
  });

  compactWindow.on('closed', () => {
    compactWindow = null;
    compactReady = false;
  });

  // Evita fechar com Cmd+W destruindo a janela — só esconde
  compactWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      compactWindow.hide();
    }
  });

  attachExternalLinkHandler(compactWindow);
  compactWindow.loadURL(getAppUrl(true));
  return compactWindow;
}

function openMainWindow() {
  const url = getAppUrl(false);

  if (mainWindow && !mainWindow.isDestroyed()) {
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 360,
    minHeight: 500,
    title: 'SyncBoard',
    backgroundColor: '#0f0f12',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  attachExternalLinkHandler(mainWindow);
  mainWindow.loadURL(url);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function openCompactWindow() {
  const win = ensureCompactWindow();

  // Toggle: se já visível, esconde
  if (win.isVisible()) {
    win.hide();
    return;
  }

  // Mostra imediatamente (mesmo se ainda carregando) — sensação de atalho rápido
  win.center();
  if (isMac) {
    app.focus({ steal: true });
  }
  win.show();
  win.focus();

  // Se a página ainda não carregou, garante foco quando ficar pronta
  if (!compactReady) {
    win.webContents.once('did-finish-load', () => {
      if (!win.isDestroyed() && win.isVisible()) win.focus();
    });
  }
}

function registerGlobalHotkey() {
  const current = getConfig('hotkey');
  hotkeyUtil.unregisterHotkey(current);
  const result = hotkeyUtil.registerHotkey(current, openCompactWindow);
  if (!result.ok) {
    console.error(`[hotkey] ${result.error}: ${current}`);
  } else if (result.hotkey !== current) {
    setConfig('hotkey', result.hotkey);
  }
  return result;
}

function openPrefsWindow() {
  if (prefsWindow) {
    prefsWindow.focus();
    return;
  }

  prefsWindow = new BrowserWindow({
    width: 440,
    height: 560,
    resizable: false,
    title: 'Preferências — SyncBoard',
    parent: mainWindow || undefined,
    modal: !!mainWindow,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  attachExternalLinkHandler(prefsWindow);
  prefsWindow.loadFile(path.join(__dirname, 'prefs.html'));
  prefsWindow.on('closed', () => { prefsWindow = null; });
}

function updateTrayMenu() {
  if (!tray) return;

  const statusIcon = connected ? '●' : '○';
  const serverLabel = offlineMode
    ? `Modo local (offline) ${statusIcon}`
    : getConfig('runLocalServer')
      ? `Servidor local :${getConfig('port')} ${statusIcon}`
      : `Servidor: ${getConfig('serverUrl')} ${statusIcon}`;

  const pinnedMenu =
    pinnedItems.length > 0
      ? pinnedItems.slice(0, 12).map((item) => ({
          label: `${item.type === 'text' ? '📝' : item.type === 'image' ? '🖼' : '📎'} ${itemLabel(item)}`,
          click: () => pasteItemIntoFocus(item),
        }))
      : [{ label: '(nenhum atalho)', enabled: false }];

  const historyMenu =
    historyItems.length > 0
      ? historyItems.slice(0, 8).map((item) => ({
          label: truncate(itemLabel(item), 45),
          click: () => pasteItemIntoFocus(item),
        }))
      : [{ label: '(vazio)', enabled: false }];

  const networkInfo = getConfig('runLocalServer')
    ? `Rede: http://${getLocalIp()}:${getConfig('port')}`
    : '';

  const menu = Menu.buildFromTemplate([
    { label: 'SyncBoard', enabled: false },
    { type: 'separator' },
    { label: 'Fixo', submenu: pinnedMenu },
    { label: 'Recentes', submenu: historyMenu },
    { type: 'separator' },
    {
      label: `Popup rápido (${hotkeyUtil.formatHotkeyDisplay(getConfig('hotkey'))})`,
      click: openCompactWindow,
    },
    {
      label: 'Abrir janela completa',
      click: openMainWindow,
    },
    {
      label: 'Copiar último item',
      click: () => {
        const last = historyItems[0] || pinnedItems[0];
        if (last) pasteItemIntoFocus(last);
      },
    },
    { type: 'separator' },
    {
      label: `Sync automático: ${getConfig('autoSync') ? 'Ativado ✓' : 'Desativado'}`,
      type: 'checkbox',
      checked: getConfig('autoSync'),
      click: (mi) => {
        setConfig('autoSync', mi.checked);
        updateTrayMenu();
      },
    },
    { label: serverLabel, enabled: false },
    ...(networkInfo ? [{ label: networkInfo, enabled: false }] : []),
    { type: 'separator' },
    {
      label: 'Iniciar com o sistema',
      type: 'checkbox',
      checked: autostart.isEnabled(),
      click: (mi) => {
        autostart.setEnabled(mi.checked);
        setConfig('launchAtLogin', mi.checked);
        updateTrayMenu();
      },
    },
    ...(updateInfo
      ? [
          { type: 'separator' },
          {
            label: updateInfo.downloaded
              ? `Instalar SyncBoard ${updateInfo.version}`
              : `Nova versão ${updateInfo.version} — baixar`,
            click: () => {
              if (updateInfo.downloaded) updaterApi?.install();
              else void downloadAndNotifyUpdate();
            },
          },
        ]
      : []),
    { label: 'Preferências…', click: openPrefsWindow },
    {
      label: 'Verificar atualização',
      click: () => void checkForAppUpdate(true),
    },
    { type: 'separator' },
    { label: 'Sair', role: 'quit' },
  ]);

  tray.setContextMenu(menu);
  tray.setToolTip(
    offlineMode
      ? 'SyncBoard ○ modo local (sem rede do servidor)'
      : `SyncBoard ${connected ? '● conectado' : '○ offline'}`
  );
}

function setupTray() {
  try {
    tray = new Tray(loadTrayIcon());
    if (isMac) tray.setTitle('');

    tray.on('click', () => {
      if (isMac) tray.popUpContextMenu();
      else openMainWindow();
    });
    tray.on('right-click', () => tray.popUpContextMenu());
    updateTrayMenu();
  } catch (err) {
    console.error('[tray] falhou (comum no GNOME sem AppIndicator):', err.message);
    tray = null;
  }
}

function setupAutostart() {
  const enabled = getConfig('launchAtLogin');
  autostart.setEnabled(enabled);
}

function broadcastUpdateToWindows() {
  const payload = {
    updateAvailable: Boolean(updateInfo),
    version: updateInfo?.version || null,
    downloaded: Boolean(updateInfo?.downloaded),
    appVersion: app.getVersion(),
    downloadPage: loadReleaseConfig().downloadUrl || null,
    releaseNotes: updateInfo?.releaseNotes || '',
    phase: updateInfo?.phase || (updateInfo?.downloaded ? 'ready' : 'idle'),
    progress: Number(updateInfo?.progress) || 0,
    error: updateInfo?.error || null,
  };
  for (const win of [mainWindow, compactWindow, prefsWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('update-status', payload);
    }
  }
}

async function ensureReleaseNotes() {
  if (!updateInfo?.version) return '';
  if (updateInfo.releaseNotes) return updateInfo.releaseNotes;
  const notes = await fetchGithubReleaseNotes(updateInfo.version);
  if (notes) {
    updateInfo = { ...updateInfo, releaseNotes: notes };
    broadcastUpdateToWindows();
  }
  return notes || '';
}

function getManualDownloadUrl() {
  const cfg = loadReleaseConfig();
  return cfg.downloadUrl || `https://github.com/${cfg.owner}/${cfg.repo}/releases/latest`;
}

async function openExternalUrl(url) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) {
    return { ok: false, error: 'URL inválida' };
  }
  await shell.openExternal(target);
  return { ok: true, url: target };
}

function attachExternalLinkHandler(win) {
  if (!win || win.isDestroyed()) return;
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const current = win.webContents.getURL();
    if (url !== current && /^https?:\/\//i.test(url)) {
      // Permite navegar no app local/http do SyncBoard; externos abrem no browser
      try {
        const next = new URL(url);
        const cur = new URL(current);
        if (next.origin !== cur.origin) {
          event.preventDefault();
          void openExternalUrl(url);
        }
      } catch {
        /* ignore */
      }
    }
  });
}

async function downloadAndNotifyUpdate() {
  if (updateBusy) {
    return { ok: false, error: 'Atualização já em andamento', fallbackUrl: getManualDownloadUrl() };
  }
  if (!updaterApi) {
    return { ok: false, error: 'Atualizador indisponível', fallbackUrl: getManualDownloadUrl() };
  }
  if (!updateInfo) {
    return {
      ok: false,
      error: 'Nenhuma atualização pronta no auto-updater',
      fallbackUrl: getManualDownloadUrl(),
    };
  }

  // Já baixou → só instala
  if (updateInfo.downloaded) {
    updateBusy = true;
    try {
      updateInfo = { ...updateInfo, phase: 'installing', progress: 100, error: null };
      broadcastUpdateToWindows();
      notifyUser('SyncBoard', `Instalando versão ${updateInfo.version}…`);
      for (const step of [30, 60, 100]) {
        updateInfo = { ...updateInfo, phase: 'installing', progress: step };
        broadcastUpdateToWindows();
        await new Promise((r) => setTimeout(r, 160));
      }
      updaterApi.install();
      return { ok: true };
    } catch (err) {
      updateInfo = { ...updateInfo, phase: 'error', error: err.message, progress: 0 };
      broadcastUpdateToWindows();
      return { ok: false, error: err.message, fallbackUrl: getManualDownloadUrl() };
    } finally {
      updateBusy = false;
    }
  }

  if (!app.isPackaged) {
    return {
      ok: false,
      error: 'Auto-update só funciona no app instalado. Abrindo página de download…',
      fallbackUrl: getManualDownloadUrl(),
    };
  }

  updateBusy = true;
  try {
    updateInfo = {
      ...updateInfo,
      phase: 'downloading',
      progress: 0,
      error: null,
      downloaded: false,
    };
    broadcastUpdateToWindows();
    notifyUser('SyncBoard', `Baixando versão ${updateInfo.version}…`);
    await updaterApi.download();

    updateInfo = {
      ...updateInfo,
      downloaded: true,
      phase: 'installing',
      progress: 100,
      error: null,
    };
    broadcastUpdateToWindows();
    notifyUser('SyncBoard', `Instalando versão ${updateInfo.version}…`);

    // pequena animação de “instalação” antes do quit
    for (const step of [15, 40, 70, 100]) {
      updateInfo = { ...updateInfo, phase: 'installing', progress: step };
      broadcastUpdateToWindows();
      await new Promise((r) => setTimeout(r, 180));
    }

    updaterApi.install();
    return { ok: true };
  } catch (err) {
    updateInfo = {
      ...updateInfo,
      phase: 'error',
      error: err.message,
      progress: 0,
    };
    broadcastUpdateToWindows();
    return { ok: false, error: err.message, fallbackUrl: getManualDownloadUrl() };
  } finally {
    updateBusy = false;
  }
}

/**
 * @param {boolean} manual
 * @param {{ notify?: boolean }} [opts] notify=false evita diálogos (chamadas da UI).
 */
async function checkForAppUpdate(manual = false, opts = {}) {
  const notify = opts.notify !== false;
  if (!updaterApi) return null;
  if (!manual && !getConfig('autoUpdate')) return null;
  try {
    const info = await updaterApi.check({ force: manual });
    if (!info) {
      if (manual && notify) notifyUser('SyncBoard', 'Você já está na versão mais recente.');
      return null;
    }
    const remote = info.version;
    const local = app.getVersion();
    if (!remote || !isNewer(remote, local)) {
      if (manual && notify) notifyUser('SyncBoard', 'Você já está na versão mais recente.');
      return null;
    }
    return info;
  } catch (err) {
    if (manual && notify) {
      dialog.showErrorBox('SyncBoard', `Não foi possível verificar updates: ${err.message}`);
    }
    return null;
  }
}

function initUpdater() {
  updaterApi = setupUpdater({
    getAutoCheck: () => getConfig('autoUpdate') !== false,
    onUpdateAvailable: (info) => {
      updateInfo = {
        version: info.version,
        downloaded: false,
        releaseNotes: info.releaseNotes || updateInfo?.releaseNotes || '',
        phase: 'idle',
        progress: 0,
        error: null,
      };
      updateTrayMenu();
      broadcastUpdateToWindows();
      void ensureReleaseNotes();
      notifyUser('SyncBoard', `Nova versão ${info.version} disponível`);
    },
    onDownloadProgress: (p) => {
      if (!updateInfo) return;
      updateInfo = {
        ...updateInfo,
        phase: 'downloading',
        progress: Math.max(0, Math.min(100, Math.round(p.percent))),
        error: null,
      };
      broadcastUpdateToWindows();
    },
    onUpdateDownloaded: (info) => {
      updateInfo = {
        version: info.version,
        downloaded: true,
        releaseNotes: info.releaseNotes || updateInfo?.releaseNotes || '',
        phase: updateBusy ? 'installing' : 'ready',
        progress: 100,
        error: null,
      };
      updateTrayMenu();
      broadcastUpdateToWindows();
      if (!updateBusy) {
        notifyUser('SyncBoard', `Versão ${info.version} pronta — clique para instalar`);
      }
    },
    onError: (err) => {
      if (!updateInfo) return;
      updateInfo = {
        ...updateInfo,
        phase: 'error',
        error: err.message,
      };
      broadcastUpdateToWindows();
    },
  });
}

ipcMain.handle('get-config', () => ({
  serverUrl: getConfig('serverUrl'),
  runLocalServer: getConfig('runLocalServer'),
  deviceName: getConfig('deviceName'),
  autoSync: getConfig('autoSync'),
  autoUpdate: getConfig('autoUpdate') !== false,
  launchAtLogin: autostart.isEnabled(),
  hotkey: getConfig('hotkey'),
  hotkeyDisplay: hotkeyUtil.formatHotkeyDisplay(getConfig('hotkey')),
  port: getConfig('port'),
  localIp: getLocalIp(),
  appVersion: app.getVersion(),
  downloadPage: loadReleaseConfig().downloadUrl || null,
  update: {
    available: Boolean(updateInfo),
    version: updateInfo?.version || null,
    downloaded: Boolean(updateInfo?.downloaded),
  },
}));

ipcMain.handle('save-config', async (_e, cfg) => {
  const needsRestart = cfg.runLocalServer !== getConfig('runLocalServer') ||
    cfg.port !== getConfig('port');

  // Sai do modo offline se o usuário reconfigurou o servidor remoto
  if (offlineMode && offlineHub) {
    try {
      await offlineHub.stop();
    } catch {
      /* ok */
    }
    offlineHub = null;
  }
  offlineMode = false;
  preferredRemoteUrl = cfg.runLocalServer ? null : cfg.serverUrl;

  setConfig('serverUrl', cfg.serverUrl);
  setConfig('runLocalServer', cfg.runLocalServer);
  setConfig('deviceName', cfg.deviceName);
  setConfig('autoSync', cfg.autoSync);
  if (cfg.autoUpdate !== undefined) setConfig('autoUpdate', Boolean(cfg.autoUpdate));
  setConfig('port', cfg.port);

  if (cfg.launchAtLogin !== undefined) {
    setConfig('launchAtLogin', Boolean(cfg.launchAtLogin));
    autostart.setEnabled(Boolean(cfg.launchAtLogin));
  }

  if (cfg.hotkey !== undefined) {
    const normalized = hotkeyUtil.normalizeHotkey(cfg.hotkey);
    hotkeyUtil.unregisterHotkey(getConfig('hotkey'));
    setConfig('hotkey', normalized);
    registerGlobalHotkey();
    updateTrayMenu();
  }

  if (cfg.runLocalServer) {
    setConfig('serverUrl', `http://localhost:${cfg.port}`);
  }

  if (needsRestart) {
    stopLocalServer();
    if (cfg.runLocalServer) await startLocalServer();
  }

  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  connectWs();
  await refreshItems();
  updateTrayMenu();

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(getAppUrl(false));
  }
  if (compactWindow && !compactWindow.isDestroyed()) {
    compactReady = false;
    compactWindow.loadURL(getAppUrl(true));
  }
  return { ok: true };
});

ipcMain.handle('test-hotkey', (_e, hotkey) => {
  const normalized = hotkeyUtil.normalizeHotkey(hotkey);
  const registered = hotkeyUtil.registerHotkey(normalized, () => {});
  if (registered.ok) hotkeyUtil.unregisterHotkey(normalized);
  return { ok: registered.ok, hotkey: normalized, error: registered.error };
});

ipcMain.handle('paste-item', async (_e, item) => pasteItemIntoFocus(item));

ipcMain.handle('discover-servers', async () => {
  try {
    const servers = await discoverServers(3500);
    return { ok: true, servers };
  } catch (err) {
    return { ok: false, error: err.message, servers: [] };
  }
});

ipcMain.handle('join-with-code', async (_e, raw) => {
  const parsed = parseJoinPayload(raw) || { code: String(raw || '').trim() };
  try {
    let serverUrl = parsed.serverUrl;
    if (!serverUrl && parsed.code) {
      const found = await discoverByCode(parsed.code);
      serverUrl = found.serverUrl;
    }
    if (!serverUrl) throw new Error('Informe um código ou QR válido');

    serverUrl = serverUrl.replace(/\/$/, '');
    // Valida health
    const res = await fetch(`${serverUrl}/api/health`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error('Servidor não respondeu');

    if (offlineMode && offlineHub) {
      try {
        await offlineHub.stop();
      } catch {
        /* ok */
      }
      offlineHub = null;
      offlineMode = false;
    }

    setConfig('runLocalServer', false);
    setConfig('serverUrl', serverUrl);
    preferredRemoteUrl = serverUrl;
    stopLocalServer();
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    connectWs();
    await refreshItems();
    reloadAppWindows();
    updateTrayMenu();
    return { ok: true, serverUrl };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('check-update', async () => {
  // Silencioso: feedback fica na UI (toast / fallback de download)
  const info = await checkForAppUpdate(true, { notify: false });
  if (info) {
    updateInfo = {
      version: info.version,
      downloaded: Boolean(updateInfo?.downloaded && updateInfo?.version === info.version),
      releaseNotes: info.releaseNotes || updateInfo?.releaseNotes || '',
      phase: updateInfo?.downloaded && updateInfo?.version === info.version ? 'ready' : 'idle',
      progress: updateInfo?.downloaded && updateInfo?.version === info.version ? 100 : 0,
      error: null,
    };
    broadcastUpdateToWindows();
    updateTrayMenu();
  }
  await ensureReleaseNotes();
  return {
    ok: true,
    updateAvailable: Boolean(updateInfo),
    version: updateInfo?.version || null,
    releaseNotes: updateInfo?.releaseNotes || '',
    downloaded: Boolean(updateInfo?.downloaded),
    fallbackUrl: getManualDownloadUrl(),
  };
});
ipcMain.handle('download-update', async () => downloadAndNotifyUpdate());
ipcMain.handle('install-update', () => {
  if (!updaterApi || !updateInfo?.downloaded) {
    return { ok: false, error: 'Nada para instalar', fallbackUrl: getManualDownloadUrl() };
  }
  try {
    updaterApi.install();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message, fallbackUrl: getManualDownloadUrl() };
  }
});
ipcMain.handle('open-external', async (_e, url) => openExternalUrl(url));
ipcMain.handle('get-update-notes', async () => {
  const notes = await ensureReleaseNotes();
  return {
    ok: true,
    version: updateInfo?.version || null,
    releaseNotes: notes,
  };
});

app.on('second-instance', () => {
  openMainWindow();
  if (isMac) app.dock?.show();
  app.focus({ steal: true });
});

app.whenReady().then(async () => {
  setupAutostart();
  loadLocalCache();
  initUpdater();

  try {
    if (getConfig('runLocalServer')) {
      setConfig('serverUrl', `http://localhost:${getConfig('port')}`);
      await startLocalServer();
    } else {
      preferredRemoteUrl = getConfig('serverUrl');
      await waitForServer(8);
    }
  } catch (err) {
    if (getConfig('runLocalServer')) {
      dialog.showErrorBox(
        'SyncBoard — Erro',
        `${err.message}\n\nVerifique se o servidor está rodando ou ative "Servidor local" nas preferências.`
      );
    } else {
      console.warn('[syncboard] Servidor remoto offline:', err.message);
      await ensureOfflineMode('startup');
    }
  }

  setupTray();
  connectWs();
  await refreshItems();
  // Se ainda não conectou e não é servidor local, garante modo offline
  if (!connected && !getConfig('runLocalServer') && !offlineMode) {
    await ensureOfflineMode('no-connection');
  }
  updateTrayMenu();

  // Pré-aquece o popup do atalho (escondido) — Mac e Linux
  try {
    ensureCompactWindow();
  } catch (err) {
    console.warn('[compact]', err.message);
  }

  pollTimer = setInterval(pollClipboard, 1200);
  void checkForAppUpdate(false);
  updateCheckTimer = setInterval(() => void checkForAppUpdate(false), 6 * 60 * 60 * 1000);

  try {
    registerGlobalHotkey();
  } catch (err) {
    console.warn('[hotkey]', err.message);
  }

  // Sempre abre janela no start — no Mac o tray sozinho parece que "não abriu"
  if (isMac) app.dock?.show();
  openMainWindow();
});

app.on('activate', () => {
  if (isMac) app.dock?.show();
  openMainWindow();
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  persistLocalCache();
  if (pollTimer) clearInterval(pollTimer);
  if (updateCheckTimer) clearInterval(updateCheckTimer);
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  if (remoteProbeTimer) clearInterval(remoteProbeTimer);
  ws?.close();
  if (offlineHub) {
    void offlineHub.stop();
    offlineHub = null;
  }
  stopLocalServer();
  if (compactWindow && !compactWindow.isDestroyed()) {
    compactWindow.removeAllListeners('close');
    compactWindow.close();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
