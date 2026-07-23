import { execSync, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

const SERVER = process.env.SYNCBOARD_URL || 'http://localhost:8787';
const DEVICE = process.env.SYNCBOARD_DEVICE || os.hostname();
const POLL_MS = parseInt(process.env.SYNCBOARD_POLL || '1500', 10);
const PLATFORM = process.platform;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, '..', '.daemon-state.json');

let lastHash = loadState().lastHash || '';
let ws = null;
let reconnectTimer = null;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(hash) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastHash: hash }));
}

function apiUrl(path) {
  return `${SERVER.replace(/\/$/, '')}/api${path}`;
}

function wsUrl() {
  const u = new URL(SERVER);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws';
  return u.toString();
}

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: opts.encoding ?? 'buffer', maxBuffer: 50 * 1024 * 1024 });
}

function readClipboard() {
  try {
    if (PLATFORM === 'darwin') {
      const img = run('python3 -c "\nimport sys\ntry:\n  from AppKit import NSPasteboard\n  pb = NSPasteboard.generalPasteboard()\n  data = pb.dataForType_(\\"public.png\\")\n  if data:\n    sys.stdout.buffer.write(bytes(data))\n    sys.exit(0)\nexcept ImportError:\n  pass\n"');
      if (img && img.length > 100) {
        return { type: 'image', data: img, mime: 'image/png' };
      }
      const text = run('pbpaste', { encoding: 'utf8' }).trim();
      if (text) return { type: 'text', data: text };
      return null;
    }

    if (PLATFORM === 'linux') {
      if (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland') {
        try {
          const img = run('wl-paste -t image/png');
          if (img && img.length > 100) {
            return { type: 'image', data: img, mime: 'image/png' };
          }
        } catch { /* no image */ }
        try {
          const text = run('wl-paste', { encoding: 'utf8' }).trim();
          if (text) return { type: 'text', data: text };
        } catch { /* empty */ }
        return null;
      }

      try {
        const img = run('xclip -selection clipboard -t image/png -o 2>/dev/null');
        if (img && img.length > 100) {
          return { type: 'image', data: img, mime: 'image/png' };
        }
      } catch { /* no image */ }

      try {
        const text = run('xclip -selection clipboard -o 2>/dev/null', { encoding: 'utf8' }).trim();
        if (text) return { type: 'text', data: text };
      } catch { /* empty */ }
      return null;
    }

    return null;
  } catch {
    return null;
  }
}

function hashClipboard(clip) {
  if (clip.type === 'text') {
    return crypto.createHash('sha256').update(`text:${clip.data}`).digest('hex');
  }
  return crypto.createHash('sha256').update(clip.data).digest('hex');
}

async function pushToServer(clip) {
  if (clip.type === 'text') {
    const res = await fetch(apiUrl('/items/text'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: clip.data, deviceName: DEVICE }),
    });
    return res.ok;
  }

  const base64 = clip.data.toString('base64');
  const res = await fetch(apiUrl('/items/upload-base64'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: base64,
      mimeType: clip.mime,
      filename: 'clipboard.png',
      deviceName: DEVICE,
    }),
  });
  return res.ok;
}

function writeClipboardText(text) {
  if (PLATFORM === 'darwin') {
    spawn('pbcopy').stdin.end(text);
  } else if (PLATFORM === 'linux') {
    if (process.env.WAYLAND_DISPLAY) {
      spawn('wl-copy').stdin.end(text);
    } else {
      spawn('xclip', ['-selection', 'clipboard']).stdin.end(text);
    }
  }
}

function writeClipboardImage(buffer) {
  const tmp = path.join(os.tmpdir(), `syncboard-${Date.now()}.png`);
  fs.writeFileSync(tmp, buffer);

  try {
    if (PLATFORM === 'darwin') {
      run(`osascript -e 'set the clipboard to (read (POSIX file "${tmp}") as «class PNGf»)'`);
    } else if (PLATFORM === 'linux') {
      if (process.env.WAYLAND_DISPLAY) {
        spawn('wl-copy', ['--type', 'image/png'], { stdio: ['pipe'] }).stdin.end(buffer);
      } else {
        spawn('xclip', ['-selection', 'clipboard', '-t', 'image/png'], { stdio: ['pipe'] }).stdin.end(buffer);
      }
    }
  } finally {
    setTimeout(() => fs.unlink(tmp, () => {}), 2000);
  }
}

async function pullFromServer(item) {
  if (item.deviceName === DEVICE) return;

  if (item.type === 'text' && item.content) {
    writeClipboardText(item.content);
    lastHash = hashClipboard({ type: 'text', data: item.content });
    saveState(lastHash);
    console.log(`[sync] Texto recebido de ${item.deviceName || 'outro dispositivo'}`);
    return;
  }

  if (item.type === 'image') {
    const res = await fetch(apiUrl(`/items/${item.id}/blob`));
    if (!res.ok) return;
    const buf = Buffer.from(await res.arrayBuffer());
    writeClipboardImage(buf);
    lastHash = hashClipboard({ type: 'image', data: buf, mime: 'image/png' });
    saveState(lastHash);
    console.log(`[sync] Imagem recebida de ${item.deviceName || 'outro dispositivo'}`);
  }
}

async function pollClipboard() {
  const clip = readClipboard();
  if (!clip) return;

  const hash = hashClipboard(clip);
  if (hash === lastHash) return;

  const ok = await pushToServer(clip);
  if (ok) {
    lastHash = hash;
    saveState(lastHash);
    console.log(`[sync] ${clip.type === 'text' ? 'Texto' : 'Imagem'} enviado ao servidor`);
  }
}

function connectWs() {
  ws = new WebSocket(wsUrl());

  ws.on('open', () => console.log('[ws] Conectado'));

  ws.on('message', async (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'item_created' && msg.item) {
      await pullFromServer(msg.item);
    }
  });

  ws.on('close', () => {
    console.log('[ws] Desconectado, reconectando em 3s...');
    reconnectTimer = setTimeout(connectWs, 3000);
  });

  ws.on('error', () => ws?.close());
}

console.log('');
console.log('  SyncBoard Daemon');
console.log(`  Servidor: ${SERVER}`);
console.log(`  Dispositivo: ${DEVICE}`);
console.log(`  Plataforma: ${PLATFORM}`);
console.log('');

if (PLATFORM === 'darwin') {
  try {
    run('python3 -c "from AppKit import NSPasteboard"');
  } catch {
    console.warn('  AVISO: Instale pyobjc para sync de imagens no Mac:');
    console.warn('  pip3 install pyobjc-framework-Cocoa');
    console.warn('  (Texto funciona sem isso)\n');
  }
}

if (PLATFORM === 'linux') {
  const hasXclip = (() => { try { run('which xclip', { encoding: 'utf8' }); return true; } catch { return false; } })();
  const hasWl = (() => { try { run('which wl-paste', { encoding: 'utf8' }); return true; } catch { return false; } })();
  if (!hasXclip && !hasWl) {
    console.warn('  AVISO: Instale xclip (X11) ou wl-clipboard (Wayland)\n');
  }
}

connectWs();
setInterval(pollClipboard, POLL_MS);

process.on('SIGINT', () => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  ws?.close();
  process.exit(0);
});
