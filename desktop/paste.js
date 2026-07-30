const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function commandExists(bin) {
  try {
    await execFileAsync('which', [bin]);
    return true;
  } catch {
    return false;
  }
}

async function simulatePaste() {
  if (process.platform === 'darwin') {
    try {
      // delay interno: o app anterior precisa estar frontmost após app.hide()
      await execFileAsync('osascript', [
        '-e',
        'delay 0.12',
        '-e',
        'tell application "System Events" to keystroke "v" using command down',
      ]);
      return true;
    } catch (err) {
      console.warn('[paste] macOS (precisa de Acessibilidade):', err.message);
      return false;
    }
  }

  if (process.platform === 'linux') {
    if (await commandExists('xdotool')) {
      try {
        await execFileAsync('xdotool', ['key', '--clearmodifiers', 'ctrl+v']);
        return true;
      } catch (err) {
        console.warn('[paste] xdotool:', err.message);
      }
    }

    if (await commandExists('wtype')) {
      try {
        await execFileAsync('wtype', ['-M', 'ctrl', 'v', '-m', 'ctrl']);
        return true;
      } catch (err) {
        console.warn('[paste] wtype:', err.message);
      }
    }

    if (await commandExists('ydotool')) {
      try {
        // LeftCtrl down, V down/up, LeftCtrl up
        await execFileAsync('ydotool', ['key', '29:1', '47:1', '47:0', '29:0']);
        return true;
      } catch (err) {
        console.warn('[paste] ydotool:', err.message);
      }
    }

    console.warn('[paste] Instale xdotool (X11) ou wtype (Wayland) para colar automaticamente');
    return false;
  }

  return false;
}

module.exports = { simulatePaste, sleep };
