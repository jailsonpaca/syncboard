const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync, spawn } = require('child_process');
const { promisify } = require('util');
const { pathToFileURL, fileURLToPath } = require('url');
const { clipboard } = require('electron');

const execFileAsync = promisify(execFile);
const commandExistsCache = new Map();
const LINUX_CLIP_TIMEOUT_MS = 900;

const MEDIA_NAME_RE =
  /^(?!\/)[^\\/]+?\.(mp4|m4v|mov|mkv|webm|avi|mp3|wav|m4a|aac|pdf|zip|rar|7z|png|jpe?g|gif|webp|heic|doc|docx|xls|xlsx|ppt|pptx)$/i;

const MIME_BY_EXT = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain',
  '.json': 'application/json',
};

function mimeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function toFileUrl(filePath) {
  return pathToFileURL(path.resolve(filePath)).href;
}

function fileUrlToPathSafe(url) {
  if (!url) return null;
  let s = String(url).trim().replace(/\0/g, '');
  if (!s.startsWith('file:')) return null;
  try {
    return fileURLToPath(s.split(/[\t\n\r]/)[0]);
  } catch {
    try {
      return decodeURIComponent(
        s.replace(/^file:\/\/localhost/i, 'file://').replace(/^file:\/\//, '')
      );
    } catch {
      return null;
    }
  }
}

function parsePlistFilenames(plist) {
  if (!plist || !plist.includes('<string>')) return [];
  const out = [];
  const re = /<string>([^<]+)<\/string>/g;
  let m;
  while ((m = re.exec(plist))) {
    const p = m[1].trim();
    if (p.startsWith('/')) out.push(p);
  }
  return out;
}

function existingFiles(paths) {
  return paths.filter((p) => {
    try {
      return p && fs.existsSync(p) && fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

function commandExists(bin) {
  if (commandExistsCache.has(bin)) return commandExistsCache.get(bin);
  try {
    execFileSync('which', [bin], { stdio: 'ignore', timeout: 1000 });
    commandExistsCache.set(bin, true);
    return true;
  } catch {
    commandExistsCache.set(bin, false);
    return false;
  }
}

function isLinuxWayland() {
  return Boolean(process.env.WAYLAND_DISPLAY) || process.env.XDG_SESSION_TYPE === 'wayland';
}

function targetListHas(targets, needle) {
  const n = String(needle).toLowerCase();
  return targets.some((t) => t.toLowerCase() === n || t.toLowerCase().startsWith(`${n};`));
}

function pickImageMime(targets) {
  const preferred = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/bmp', 'image/gif'];
  for (const mime of preferred) {
    if (targetListHas(targets, mime)) return mime === 'image/jpg' ? 'image/jpeg' : mime;
  }
  return null;
}

/**
 * Lista MIME types disponíveis sem pedir o conteúdo.
 * Evita wl-paste/xclip travarem ao pedir image/png quando a clipboard só tem texto.
 */
async function listLinuxClipboardTargets() {
  if (process.platform !== 'linux') return [];

  const wayland = isLinuxWayland();
  try {
    if (wayland && commandExists('wl-paste')) {
      const { stdout } = await execFileAsync('wl-paste', ['-l'], {
        encoding: 'utf8',
        timeout: LINUX_CLIP_TIMEOUT_MS,
        maxBuffer: 256 * 1024,
      });
      return String(stdout || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    }
    if (commandExists('xclip')) {
      const { stdout } = await execFileAsync(
        'xclip',
        ['-selection', 'clipboard', '-t', 'TARGETS', '-o'],
        {
          encoding: 'utf8',
          timeout: LINUX_CLIP_TIMEOUT_MS,
          maxBuffer: 256 * 1024,
        }
      );
      return String(stdout || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    }
  } catch {
    return [];
  }
  return [];
}

async function execLinuxClipboard(bin, args, encoding = 'buffer') {
  if (!commandExists(bin)) return null;
  try {
    const opts = {
      timeout: LINUX_CLIP_TIMEOUT_MS,
      maxBuffer: 40 * 1024 * 1024,
      encoding: encoding === 'utf8' ? 'utf8' : 'buffer',
    };
    const { stdout } = await execFileAsync(bin, args, opts);
    if (encoding === 'utf8') {
      const t = String(stdout || '').trim();
      return t || null;
    }
    if (stdout && stdout.length > 0) {
      return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Lê clipboard no Linux via wl-paste/xclip (async — não bloqueia a main thread).
 * No Wayland o Electron só vê o que ELE escreveu — sem isso Linux→Mac quebra.
 *
 * Importante: lista targets primeiro. Pedir image/png sem imagem faz wl-paste
 * esperar até timeout e congelava o SyncBoard a cada poll.
 */
async function readLinuxClipboardNative() {
  if (process.platform !== 'linux') return null;

  const wayland = isLinuxWayland();
  const targets = await listLinuxClipboardTargets();

  // Sem targets: não pedir image/uri às cegas (trava). Só tenta texto uma vez.
  if (!targets.length) {
    const text = wayland
      ? (await execLinuxClipboard('wl-paste', ['-n'], 'utf8')) ||
        (await execLinuxClipboard('wl-paste', [], 'utf8'))
      : await execLinuxClipboard('xclip', ['-selection', 'clipboard', '-o'], 'utf8');
    if (text) return { type: 'text', data: String(text) };
    return null;
  }

  // Imagem — só se o tipo existir
  const imageMime = pickImageMime(targets);
  if (imageMime) {
    const img = wayland
      ? await execLinuxClipboard('wl-paste', ['-t', imageMime])
      : await execLinuxClipboard('xclip', ['-selection', 'clipboard', '-t', imageMime, '-o']);
    if (img && img.length > 100) {
      return { type: 'image', data: img, mime: imageMime };
    }
  }

  // Arquivos (uri-list)
  const wantUri =
    targetListHas(targets, 'text/uri-list') ||
    targetListHas(targets, 'x-special/gnome-copied-files');
  if (wantUri) {
    const uriRaw = wayland
      ? await execLinuxClipboard('wl-paste', ['-t', 'text/uri-list'], 'utf8')
      : await execLinuxClipboard(
          'xclip',
          ['-selection', 'clipboard', '-t', 'text/uri-list', '-o'],
          'utf8'
        );
    if (uriRaw) {
      const paths = [];
      for (const line of String(uriRaw).split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const p = fileUrlToPathSafe(t.split('\t')[0]);
        if (p) paths.push(p);
      }
      const files = existingFiles(paths);
      if (files.length) {
        const filePath = files[0];
        try {
          const st = fs.statSync(filePath);
          if (st.isFile()) {
            return {
              type: 'file',
              filePath,
              filename: path.basename(filePath),
              mime: mimeFromPath(filePath),
              size: st.size,
              mtimeMs: st.mtimeMs,
            };
          }
        } catch {
          /* next */
        }
      }
    }
  }

  // Texto
  const wantText =
    targetListHas(targets, 'text/plain') ||
    targetListHas(targets, 'text/plain;charset=utf-8') ||
    targetListHas(targets, 'UTF8_STRING') ||
    targetListHas(targets, 'STRING') ||
    targetListHas(targets, 'TEXT');
  if (wantText) {
    const text = wayland
      ? (await execLinuxClipboard('wl-paste', ['-n'], 'utf8')) ||
        (await execLinuxClipboard('wl-paste', [], 'utf8'))
      : await execLinuxClipboard('xclip', ['-selection', 'clipboard', '-o'], 'utf8');
    if (text) {
      return { type: 'text', data: String(text) };
    }
  }

  return null;
}

/**
 * WhatsApp/etc. às vezes colocam só o nome do arquivo na clipboard.
 * Resolve em Downloads / Spotlight.
 */
function resolveNamedMediaFile(name) {
  const clean = String(name || '').trim().replace(/^\.\/+/, '');
  if (!MEDIA_NAME_RE.test(clean)) return null;

  const candidates = [
    path.join(os.homedir(), 'Downloads', clean),
    path.join(os.homedir(), 'Desktop', clean),
    path.join(os.homedir(), 'Documents', clean),
    path.join(os.tmpdir(), clean),
  ];

  for (const p of candidates) {
    if (existingFiles([p]).length) return p;
  }

  // Spotlight (macOS) — arquivo baixado recentemente com esse nome
  if (process.platform === 'darwin' && commandExists('mdfind')) {
    try {
      const out = execFileSync(
        'mdfind',
        ['-name', clean],
        { encoding: 'utf8', timeout: 3000, maxBuffer: 2 * 1024 * 1024 }
      ).trim();
      const hits = out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .filter((p) => path.basename(p) === clean);
      const existing = existingFiles(hits);
      if (!existing.length) return null;
      // mais recente
      existing.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      return existing[0];
    } catch {
      return null;
    }
  }

  // Linux: find raso em Downloads
  if (process.platform === 'linux') {
    try {
      const dl = path.join(os.homedir(), 'Downloads');
      if (!fs.existsSync(dl)) return null;
      const out = execFileSync(
        'find',
        [dl, '-maxdepth', '3', '-type', 'f', '-name', clean],
        { encoding: 'utf8', timeout: 3000 }
      ).trim();
      const hits = existingFiles(out.split('\n').map((l) => l.trim()).filter(Boolean));
      if (!hits.length) return null;
      hits.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      return hits[0];
    } catch {
      return null;
    }
  }

  return null;
}

function readMacFilesViaOsascript() {
  if (process.platform !== 'darwin') return [];
  try {
    const script = `
try
  set theFile to the clipboard as «class furl»
  return POSIX path of theFile
on error
  return ""
end try
`;
    const out = execFileSync('osascript', ['-e', script], {
      encoding: 'utf8',
      timeout: 2000,
    }).trim();
    if (!out) return [];
    // WhatsApp devolve "/Nome.mp4" inválido — ignora
    if (!out.startsWith(os.homedir()) && !out.startsWith('/Users/') && !out.startsWith('/tmp')) {
      return [];
    }
    return existingFiles([out]);
  } catch {
    return [];
  }
}

/**
 * Caminhos de arquivos na área de transferência (Finder / Nautilus / nome WhatsApp).
 * @param {{ skipOsascript?: boolean }} [opts] — no Mac, osascript é lento; pule no poll com imagem.
 */
function readClipboardFilePaths(opts = {}) {
  const found = [];

  if (process.platform === 'darwin') {
    try {
      const p = fileUrlToPathSafe(clipboard.read('public.file-url'));
      if (p) found.push(p);
    } catch { /* ok */ }

    try {
      found.push(...parsePlistFilenames(clipboard.read('NSFilenamesPboardType')));
    } catch { /* ok */ }

    // osascript spawna processo — só quando ainda não achou path (evita travar o poll)
    if (!opts.skipOsascript && !found.length) {
      found.push(...readMacFilesViaOsascript());
    }
  }

  if (process.platform === 'linux') {
    for (const format of ['text/uri-list', 'text/x-moz-url', 'x-special/gnome-copied-files']) {
      try {
        const raw = clipboard.read(format);
        if (!raw) continue;
        for (const line of raw.split(/\r?\n/)) {
          const t = line.trim();
          if (!t || t.startsWith('#') || t === 'copy' || t === 'cut') continue;
          const p = fileUrlToPathSafe(t.split('\t')[0]);
          if (p) found.push(p);
        }
      } catch { /* ok */ }
    }
  }

  try {
    const text = clipboard.readText()?.trim();
    if (text && !text.includes('\n') && text.length < 1024) {
      if (text.startsWith('file:')) {
        const p = fileUrlToPathSafe(text);
        if (p) found.push(p);
      } else if (text.startsWith('/') || /^[A-Za-z]:[\\/]/.test(text)) {
        found.push(text);
      } else {
        const resolved = resolveNamedMediaFile(text);
        if (resolved) found.push(resolved);
      }
    }
  } catch { /* ok */ }

  return [...new Set(existingFiles(found))];
}

function writeViaProcess(bin, args, input) {
  return new Promise((resolve) => {
    try {
      const child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        resolve(ok);
      };
      child.on('error', () => finish(false));
      child.on('close', (code) => finish(code === 0));
      child.stdin.write(input);
      child.stdin.end();
      setTimeout(() => {
        try { child.kill(); } catch { /* ok */ }
        finish(false);
      }, 3000);
    } catch {
      resolve(false);
    }
  });
}

async function writeLinuxFileClipboard(paths) {
  const urls = paths.map(toFileUrl);
  const uriList = `${urls.join('\r\n')}\r\n`;
  const gnome = `copy\n${urls.join('\n')}\n`;

  if (commandExists('xclip-copyfile')) {
    try {
      execFileSync('xclip-copyfile', paths, { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch { /* next */ }
  }

  if (commandExists('python3')) {
    const py = `
import os, sys
try:
    import gi
    gi.require_version('Gtk', '3.0')
    from gi.repository import Gtk, Gdk, GLib
except Exception:
    sys.exit(2)

paths = sys.argv[1:]
uris = [GLib.filename_to_uri(os.path.abspath(p)) for p in paths]
gnome = ("copy\\n" + "\\n".join(uris) + "\\n").encode()
clip = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)

def get_func(clipboard, selection_data, info, _data):
    if info == 0:
        selection_data.set_uris(uris)
    elif info == 1:
        atom = Gdk.Atom.intern('x-special/gnome-copied-files', False)
        selection_data.set(atom, 8, gnome)

def clear_func(_clipboard, _data):
    pass

targets = [
    Gtk.TargetEntry.new('text/uri-list', 0, 0),
    Gtk.TargetEntry.new('x-special/gnome-copied-files', 0, 1),
]
ok = clip.set_with_data(targets, get_func, clear_func, None)
if not ok:
    sys.exit(3)
GLib.timeout_add_seconds(180, Gtk.main_quit)
Gtk.main()
`;
    try {
      const child = spawn('python3', ['-c', py, ...paths], {
        stdio: 'ignore',
        detached: true,
      });
      child.unref();
      await new Promise((r) => setTimeout(r, 250));
      return true;
    } catch { /* next */ }
  }

  if (commandExists('xclip')) {
    if (await writeViaProcess('xclip', ['-selection', 'clipboard', '-t', 'x-special/gnome-copied-files', '-i'], gnome)) {
      return true;
    }
    if (await writeViaProcess('xclip', ['-selection', 'clipboard', '-t', 'text/uri-list', '-i'], uriList)) {
      return true;
    }
  }

  if (commandExists('wl-copy')) {
    if (await writeViaProcess('wl-copy', ['--type', 'text/uri-list'], uriList)) return true;
  }

  try {
    clipboard.clear();
    clipboard.writeBuffer('text/uri-list', Buffer.from(uriList, 'utf8'));
    clipboard.writeBuffer('x-special/gnome-copied-files', Buffer.from(gnome, 'utf8'));
    return true;
  } catch {
    return false;
  }
}

/** Coloca arquivo(s) na clipboard como ARQUIVO (nunca path texto). */
async function writeClipboardFilePaths(filePaths) {
  const paths = existingFiles(filePaths);
  if (!paths.length) return false;

  if (process.platform === 'darwin') {
    const primary = paths[0];
    const fileUrl = toFileUrl(primary);
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
${paths.map((p) => `  <string>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>`).join('\n')}
</array>
</plist>
`;
    clipboard.clear();
    clipboard.writeBuffer('NSFilenamesPboardType', Buffer.from(plist, 'utf8'));
    clipboard.writeBuffer('public.file-url', Buffer.from(fileUrl, 'utf8'));
    return true;
  }

  if (process.platform === 'linux') {
    return writeLinuxFileClipboard(paths);
  }

  return false;
}

/** Pasta pública para o usuário achar o arquivo facilmente. */
function publicInboxDir() {
  const dir = path.join(os.homedir(), 'Downloads', 'SyncBoard');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function copyToPublicInbox(srcPath, preferredName) {
  const base = (preferredName || path.basename(srcPath)).replace(/[^\w.\- ()[\]]+/g, '_');
  const dest = path.join(publicInboxDir(), base);
  fs.copyFileSync(srcPath, dest);
  return dest;
}

/** Abre o gerenciador de arquivos com o arquivo selecionado (caminho confiável). */
function revealFileInFolder(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) return false;
  const fileUrl = toFileUrl(abs);

  try {
    if (process.platform === 'darwin') {
      execFile('open', ['-R', abs], { stdio: 'ignore' });
      return true;
    }
    if (process.platform === 'linux') {
      // Padrão FreeDesktop — funciona no Nautilus/Nemo/Dolphin/etc.
      try {
        execFileSync(
          'dbus-send',
          [
            '--session',
            '--print-reply',
            '--dest=org.freedesktop.FileManager1',
            '/org/freedesktop/FileManager1',
            'org.freedesktop.FileManager1.ShowItems',
            `array:string:${fileUrl}`,
            'string:',
          ],
          { stdio: 'ignore', timeout: 4000 }
        );
        return true;
      } catch { /* tenta apps */ }

      if (commandExists('nautilus')) {
        execFile('nautilus', ['--select', abs], { stdio: 'ignore', detached: true }).unref?.();
        return true;
      }
      if (commandExists('nemo')) {
        execFile('nemo', abs, { stdio: 'ignore', detached: true }).unref?.();
        return true;
      }
      if (commandExists('dolphin')) {
        execFile('dolphin', ['--select', abs], { stdio: 'ignore', detached: true }).unref?.();
        return true;
      }
      if (commandExists('xdg-open')) {
        execFile('xdg-open', [path.dirname(abs)], { stdio: 'ignore', detached: true }).unref?.();
        return true;
      }
    }
  } catch (err) {
    console.warn('[reveal]', err.message);
    return false;
  }
  return false;
}

module.exports = {
  readClipboardFilePaths,
  writeClipboardFilePaths,
  readLinuxClipboardNative,
  isLinuxWayland,
  mimeFromPath,
  pathToFileUrl: toFileUrl,
  resolveNamedMediaFile,
  copyToPublicInbox,
  revealFileInFolder,
  publicInboxDir,
};
