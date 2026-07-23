const { globalShortcut } = require('electron');

const DEFAULT_HOTKEY = 'Alt+V';
const MODIFIERS = new Set(['CommandOrControl', 'CmdOrCtrl', 'Control', 'Command', 'Alt', 'Option', 'Shift', 'Super']);
const IGNORE_KEYS = new Set([
  'Control', 'Shift', 'Alt', 'Meta', 'Command', 'AltGraph', 'OS', 'Hyper', 'Super',
]);

function normalizeHotkey(raw) {
  if (!raw || typeof raw !== 'string') return DEFAULT_HOTKEY;
  const parts = raw.split('+').map((p) => p.trim()).filter(Boolean);
  const normalized = parts.map((p) => {
    if (p === 'CmdOrCtrl' || p === 'Control' || p === 'Command') return 'CommandOrControl';
    if (p === 'Option') return 'Alt';
    if (p.length === 1) return p.toUpperCase();
    return p;
  });
  const mods = normalized.filter((p) => MODIFIERS.has(p));
  const keys = normalized.filter((p) => !MODIFIERS.has(p));
  if (keys.length === 0) return DEFAULT_HOTKEY;
  // Descarta símbolos tipográficos gerados por Alt/Option (√, ®, etc.)
  const key = keys[keys.length - 1];
  if (/[^\x20-\x7E]/.test(key) || key === 'Dead') return DEFAULT_HOTKEY;
  return [...mods, key].join('+');
}

function formatHotkeyDisplay(accelerator) {
  const isMac = process.platform === 'darwin';
  return accelerator
    .replace(/CommandOrControl/g, isMac ? '⌘' : 'Ctrl')
    .replace(/Command/g, '⌘')
    .replace(/Control/g, 'Ctrl')
    .replace(/Shift/g, isMac ? '⇧' : 'Shift')
    .replace(/Alt|Option/g, isMac ? '⌥' : 'Alt')
    .replace(/\+/g, isMac ? '' : '+');
}

/** Resolve a tecla física (e.code) para não pegar √/® do Option no Mac. */
function keyFromKeyboardEvent(event) {
  if (IGNORE_KEYS.has(event.key)) return null;

  const code = event.code || '';
  const keyMatch = /^Key([A-Z])$/.exec(code);
  if (keyMatch) return keyMatch[1];
  const digitMatch = /^Digit([0-9])$/.exec(code);
  if (digitMatch) return digitMatch[1];
  const fMatch = /^F([0-9]{1,2})$/.exec(code);
  if (fMatch) return `F${fMatch[1]}`;

  if (event.key === ' ' || code === 'Space') return 'Space';
  if (event.key === 'Dead') return null;
  if (event.key.startsWith('Arrow')) return event.key.replace('Arrow', '');

  if (event.key.length === 1) {
    if (/^[a-zA-Z0-9]$/.test(event.key)) return event.key.toUpperCase();
    // Alt/Option muda o caractere tipado — ignora e evita "√" no atalho
    if (event.altKey) return null;
    return event.key.toUpperCase();
  }

  return event.key;
}

function registerHotkey(accelerator, callback) {
  const hotkey = normalizeHotkey(accelerator);
  if (!globalShortcut.register(hotkey, callback)) {
    return { ok: false, hotkey, error: 'Atalho em uso por outro app ou inválido' };
  }
  return { ok: true, hotkey };
}

function unregisterHotkey(accelerator) {
  if (!accelerator) return;
  try {
    globalShortcut.unregister(normalizeHotkey(accelerator));
  } catch { /* ok */ }
}

function keyEventToHotkey(event) {
  const parts = [];
  if (event.metaKey || event.ctrlKey) parts.push('CommandOrControl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');

  const key = keyFromKeyboardEvent(event);
  if (!key) return null;

  parts.push(key);
  return normalizeHotkey(parts.join('+'));
}

module.exports = {
  DEFAULT_HOTKEY,
  normalizeHotkey,
  formatHotkeyDisplay,
  registerHotkey,
  unregisterHotkey,
  keyEventToHotkey,
  keyFromKeyboardEvent,
};
