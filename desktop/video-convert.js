'use strict';
/**
 * Conversão de vídeo (qualquer formato) -> MP4 compatível com WhatsApp
 * (H.264 Main + AAC, yuv420p, faststart) usando o ffmpeg DO SISTEMA.
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PRESETS = {
  light: { height: 480, crf: 28, audioKbps: 96 },
  balanced: { height: 720, crf: 23, audioKbps: 128 },
  high: { height: 1080, crf: 21, audioKbps: 128 },
};

const EXTRA_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/snap/bin', '/opt/local/bin'];

/** Apps GUI no macOS não herdam o PATH do shell — procura nos diretórios usuais. */
function findBinary(name) {
  const envPath = process.env.FFMPEG_PATH;
  if (envPath) {
    try {
      if (fs.statSync(envPath).isDirectory()) {
        const p = path.join(envPath, name);
        if (fs.existsSync(p)) return p;
      } else if (path.basename(envPath).startsWith('ffmpeg') && name === 'ffmpeg') {
        return envPath;
      } else if (name === 'ffprobe') {
        const p = path.join(path.dirname(envPath), 'ffprobe');
        if (fs.existsSync(p)) return p;
      }
    } catch {
      /* ignora FFMPEG_PATH inválido e segue procurando */
    }
  }
  const dirs = [...EXTRA_DIRS, ...(process.env.PATH || '').split(path.delimiter)].filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* próximo */
    }
  }
  return null;
}

function installHint() {
  return process.platform === 'darwin'
    ? 'Instale o ffmpeg: brew install ffmpeg'
    : 'Instale o ffmpeg: sudo apt install ffmpeg';
}

function checkFfmpeg() {
  const ffmpeg = findBinary('ffmpeg');
  if (!ffmpeg) return { ok: false, error: `ffmpeg não encontrado. ${installHint()}` };
  let version = '';
  try {
    version = execFileSync(ffmpeg, ['-version'], { encoding: 'utf8', timeout: 5000 }).split('\n')[0];
  } catch {
    /* só informativo */
  }
  return { ok: true, path: ffmpeg, version };
}

function probeDuration(ffmpeg, input) {
  const ffprobe = findBinary('ffprobe');
  if (ffprobe) {
    try {
      const out = execFileSync(
        ffprobe,
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', input],
        { encoding: 'utf8', timeout: 20000 }
      );
      const d = parseFloat(out);
      if (Number.isFinite(d) && d > 0) return d;
    } catch {
      /* cai no fallback */
    }
  }
  try {
    // ffmpeg -i sem saída sai com erro, mas imprime "Duration: HH:MM:SS.xx" no stderr
    execFileSync(ffmpeg, ['-hide_banner', '-i', input], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(e.stderr || ''));
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  return null;
}

function uniqueOutputPath(input) {
  const dir = path.dirname(input);
  const base = path.basename(input, path.extname(input));
  let out = path.join(dir, `${base}-whatsapp.mp4`);
  for (let i = 2; fs.existsSync(out); i++) out = path.join(dir, `${base}-whatsapp-${i}.mp4`);
  return out;
}

let current = null; // { child, cancelled }

function isBusy() {
  return current !== null;
}

function cancel() {
  if (!current) return false;
  current.cancelled = true;
  try {
    current.child?.kill('SIGTERM');
  } catch {
    /* já terminou */
  }
  return true;
}

function runFfmpeg(ffmpeg, args, duration, onPercent) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    current.child = child;
    let stderrTail = '';
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line.trim());
        if (m && duration) onPercent(Math.min(1, Number(m[1]) / 1e6 / duration));
      }
    });
    child.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (current?.cancelled) return reject(new Error('Conversão cancelada'));
      if (code === 0) return resolve();
      const lastLine = stderrTail.trim().split('\n').pop() || `ffmpeg saiu com código ${code}`;
      reject(new Error(lastLine));
    });
  });
}

/**
 * @param {{input:string, preset?:'light'|'balanced'|'high', maxMB?:number|null}} opts
 * @param {(percent:number)=>void} onProgress  0..100
 */
async function convertToWhatsApp(opts, onProgress = () => {}) {
  if (current) throw new Error('Já existe uma conversão em andamento');
  const { input } = opts;
  if (!input || !fs.existsSync(input)) throw new Error('Arquivo não encontrado');
  const ffmpeg = findBinary('ffmpeg');
  if (!ffmpeg) throw new Error(`ffmpeg não encontrado. ${installHint()}`);

  const preset = PRESETS[opts.preset] || PRESETS.balanced;
  const maxMB = Number(opts.maxMB) > 0 ? Number(opts.maxMB) : null;
  const duration = probeDuration(ffmpeg, input);
  if (maxMB && !duration) throw new Error('Não foi possível ler a duração do vídeo para respeitar o limite de tamanho');

  current = { child: null, cancelled: false };
  const output = uniqueOutputPath(input);
  const partial = `${output}.part`;
  const passLog = path.join(os.tmpdir(), `syncboard-ffpass-${process.pid}-${Date.now()}`);

  const vf = `scale=-2:'min(${preset.height},ih)',format=yuv420p`;
  const common = ['-hide_banner', '-nostdin', '-y', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-vf', vf];
  const video = ['-c:v', 'libx264', '-profile:v', 'main', '-preset', 'medium', '-pix_fmt', 'yuv420p'];
  const audio = ['-c:a', 'aac', '-b:a', `${preset.audioKbps}k`, '-ac', '2'];
  const progress = ['-progress', 'pipe:1', '-nostats'];

  try {
    if (maxMB) {
      // Bitrate alvo (kbit/s) = tamanho_alvo / duração - áudio, com ~5% de folga para o contêiner.
      const total = (maxMB * 8192 * 0.95) / duration;
      const videoKbps = Math.floor(total - preset.audioKbps);
      if (videoKbps < 80) throw new Error(`Vídeo longo demais para ${maxMB} MB (bitrate inviável). Aumente o limite.`);
      const rate = ['-b:v', `${videoKbps}k`, '-maxrate', `${Math.floor(videoKbps * 1.5)}k`, '-bufsize', `${videoKbps * 2}k`];
      await runFfmpeg(
        ffmpeg,
        [...common, ...video, ...rate, '-pass', '1', '-passlogfile', passLog, '-an', '-f', 'null', '/dev/null', ...progress],
        duration,
        (p) => onProgress(Math.round(p * 50))
      );
      await runFfmpeg(
        ffmpeg,
        [...common, ...video, ...rate, '-pass', '2', '-passlogfile', passLog, ...audio, '-movflags', '+faststart', '-f', 'mp4', partial, ...progress],
        duration,
        (p) => onProgress(50 + Math.round(p * 50))
      );
    } else {
      await runFfmpeg(
        ffmpeg,
        [...common, ...video, '-crf', String(preset.crf), ...audio, '-movflags', '+faststart', '-f', 'mp4', partial, ...progress],
        duration,
        (p) => onProgress(Math.round(p * 100))
      );
    }
    fs.renameSync(partial, output);
    onProgress(100);
    return { ok: true, outputPath: output, sizeBytes: fs.statSync(output).size };
  } finally {
    current = null;
    for (const f of [partial]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* ok */
      }
    }
    try {
      for (const f of fs.readdirSync(os.tmpdir())) {
        if (f.startsWith(path.basename(passLog))) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
      }
    } catch {
      /* ok */
    }
  }
}

module.exports = { checkFfmpeg, convertToWhatsApp, cancel, isBusy, PRESETS, findBinary };
