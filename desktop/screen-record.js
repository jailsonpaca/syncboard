'use strict';
/**
 * Gravador de tela (Electron): lista telas/janelas (desktopCapturer), o renderer grava com
 * getDisplayMedia + MediaRecorder e envia os chunks ao main, que grava direto em disco
 * (gravações longas não ficam na memória).
 */
const fs = require('fs');
const path = require('path');

const SELECTION_TTL_MS = 15000;

function pad(n) {
  return String(n).padStart(2, '0');
}

function defaultOutputDir(app) {
  return path.join(app.getPath('videos'), 'SyncBoard');
}

function register({ ipcMain, session, desktopCapturer, systemPreferences, shell, app, allowedOutputs }) {
  let selection = null; // { sourceId, at }
  let rec = null; // { stream, filePath, bytes, failed }

  // O renderer chama getDisplayMedia; aqui devolvemos a fonte escolhida no nosso seletor.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sel = selection;
        selection = null; // uso único, vale só por alguns segundos após o clique em "Gravar"
        if (!sel || Date.now() - sel.at > SELECTION_TTL_MS) return callback({});
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
        const source = sources.find((s) => s.id === sel.sourceId);
        if (!source) return callback({});
        const grant = { video: source };
        if (sel.systemAudio) grant.audio = 'loopback';
        callback(grant);
      } catch {
        callback({});
      }
    },
    { useSystemPicker: false }
  );

  ipcMain.handle('rec-status', () => {
    const platform = process.platform;
    let screen = 'granted';
    let microphone = 'granted';
    if (platform === 'darwin') {
      screen = systemPreferences.getMediaAccessStatus('screen');
      microphone = systemPreferences.getMediaAccessStatus('microphone');
    }
    return { platform, screen, microphone, outputDir: defaultOutputDir(app) };
  });

  ipcMain.handle('rec-open-privacy', async (_e, kind) => {
    if (process.platform !== 'darwin') return { ok: false };
    const pane = kind === 'microphone' ? 'Privacy_Microphone' : 'Privacy_ScreenCapture';
    await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
    return { ok: true };
  });

  ipcMain.handle('rec-ask-mic', async () => {
    if (process.platform !== 'darwin') return { ok: true };
    return { ok: await systemPreferences.askForMediaAccess('microphone') };
  });

  ipcMain.handle('rec-sources', async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 200 },
        fetchWindowIcons: false,
      });
      return {
        ok: true,
        sources: sources
          .filter((s) => !s.thumbnail.isEmpty())
          .map((s) => ({
            id: s.id,
            name: s.name,
            kind: s.id.startsWith('screen:') ? 'screen' : 'window',
            thumbnail: s.thumbnail.toDataURL(),
          })),
      };
    } catch (err) {
      return { ok: false, error: err?.message || String(err), sources: [] };
    }
  });

  ipcMain.handle('rec-select', (_e, { sourceId, systemAudio } = {}) => {
    if (typeof sourceId !== 'string') return { ok: false };
    selection = { sourceId, systemAudio: !!systemAudio, at: Date.now() };
    return { ok: true };
  });

  ipcMain.handle('rec-begin', (_e, { ext } = {}) => {
    if (rec) return { ok: false, error: 'Já existe uma gravação em andamento' };
    try {
      const dir = defaultOutputDir(app);
      fs.mkdirSync(dir, { recursive: true });
      const d = new Date();
      const base = `gravacao-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      const safeExt = ext === 'webm' ? 'webm' : 'mp4';
      const filePath = path.join(dir, `${base}.${safeExt}`);
      const stream = fs.createWriteStream(filePath);
      rec = { stream, filePath, bytes: 0, failed: null };
      stream.on('error', (err) => {
        if (rec) rec.failed = err;
      });
      return { ok: true, filePath };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('rec-chunk', (_e, data) => {
    if (!rec) return { ok: false, error: 'Sem gravação ativa' };
    if (rec.failed) return { ok: false, error: rec.failed.message };
    const buf = Buffer.from(data);
    rec.bytes += buf.length;
    rec.stream.write(buf);
    return { ok: true };
  });

  ipcMain.handle('rec-end', async (_e, { discard } = {}) => {
    if (!rec) return { ok: false, error: 'Sem gravação ativa' };
    const cur = rec;
    rec = null;
    await new Promise((resolve) => cur.stream.end(resolve));
    if (discard || cur.bytes === 0) {
      fs.rmSync(cur.filePath, { force: true });
      return { ok: false, error: discard ? 'Gravação descartada' : 'Gravação vazia' };
    }
    if (cur.failed) return { ok: false, error: cur.failed.message };
    allowedOutputs.add(cur.filePath);
    return { ok: true, outputPath: cur.filePath, sizeBytes: cur.bytes };
  });
}

module.exports = { register, defaultOutputDir };
