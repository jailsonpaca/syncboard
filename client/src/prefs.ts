import { installDesktopBridge } from './desktopBridge';

installDesktopBridge();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let recording = false;

async function load() {
  const cfg = (await window.syncboard?.getConfig?.()) as Record<string, unknown> | undefined;
  if (!cfg) return;

  const runLocal = Boolean(cfg.runLocalServer);
  $<HTMLInputElement>('runLocalServer').checked = runLocal;
  $<HTMLInputElement>('port').value = String(cfg.port ?? 8787);
  $<HTMLInputElement>('serverUrl').value = String(cfg.serverUrl ?? '');
  $<HTMLInputElement>('deviceName').value = String(cfg.deviceName ?? '');
  $<HTMLInputElement>('autoSync').checked = cfg.autoSync !== false;
  $<HTMLInputElement>('autoUpdate').checked = cfg.autoUpdate !== false;
  $<HTMLInputElement>('launchAtLogin').checked = cfg.launchAtLogin !== false;
  $<HTMLInputElement>('hotkey').value = String(cfg.hotkey ?? '');
  $<HTMLInputElement>('hotkey').placeholder = String(cfg.hotkeyDisplay ?? '⌥V');
  $('version-hint').textContent = `Versão ${String(cfg.appVersion ?? '')} — o app avisa no menu quando houver update.`;

  if (runLocal) {
    $('network-info').innerHTML = `Android/outros: <strong>http://${String(cfg.localIp ?? '127.0.0.1')}:${String(cfg.port ?? 8787)}</strong> · abra as configs da janela para ver o QR/código`;
  } else {
    $('network-info').innerHTML = `Conectado a: <strong>${String(cfg.serverUrl ?? '')}</strong>`;
  }

  const syncDisabled = () => {
    const local = $<HTMLInputElement>('runLocalServer').checked;
    $<HTMLInputElement>('serverUrl').disabled = local;
    $<HTMLInputElement>('port').disabled = !local;
  };
  $<HTMLInputElement>('runLocalServer').addEventListener('change', syncDisabled);
  syncDisabled();
}

$('recordHotkey').addEventListener('click', () => {
  recording = !recording;
  $('recordHotkey').textContent = recording ? 'Pressione…' : 'Gravar';
  $('recordHotkey').classList.toggle('recording', recording);
});

function keyFromEvent(e: KeyboardEvent): string | null {
  const ignore = ['Control', 'Shift', 'Alt', 'Meta', 'Command', 'AltGraph', 'OS'];
  if (ignore.includes(e.key)) return null;

  const code = e.code || '';
  const keyMatch = /^Key([A-Z])$/.exec(code);
  if (keyMatch) return keyMatch[1];
  const digitMatch = /^Digit([0-9])$/.exec(code);
  if (digitMatch) return digitMatch[1];
  const fMatch = /^F([0-9]{1,2})$/.exec(code);
  if (fMatch) return 'F' + fMatch[1];

  if (e.key === ' ' || code === 'Space') return 'Space';
  if (e.key === 'Dead') return null;
  if (e.key.startsWith('Arrow')) return e.key.replace('Arrow', '');
  if (e.key.length === 1) {
    if (/^[a-zA-Z0-9]$/.test(e.key)) return e.key.toUpperCase();
    if (e.altKey) return null;
    return e.key.toUpperCase();
  }
  return e.key;
}

document.addEventListener('keydown', (e) => {
  if (!recording) return;
  e.preventDefault();
  e.stopPropagation();

  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  const key = keyFromEvent(e);
  if (!key) return;

  parts.push(key);
  $<HTMLInputElement>('hotkey').value = parts.join('+');
  recording = false;
  $('recordHotkey').textContent = 'Gravar';
  $('recordHotkey').classList.remove('recording');
});

$('joinCode').addEventListener('click', async () => {
  const code = $<HTMLInputElement>('pairCode').value.trim();
  if (!code) {
    alert('Informe o código do servidor');
    return;
  }
  const btn = $<HTMLButtonElement>('joinCode');
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const result = await window.syncboard?.joinWithCode?.(code);
    if (!result?.ok) {
      alert(result?.error || 'Falha ao parear');
      return;
    }
    $<HTMLInputElement>('serverUrl').value = result.serverUrl || '';
    $<HTMLInputElement>('runLocalServer').checked = false;
    $<HTMLInputElement>('serverUrl').disabled = false;
    $<HTMLInputElement>('port').disabled = true;
    $('network-info').innerHTML = `Conectado a: <strong>${result.serverUrl || ''}</strong>`;
    alert(`Pareado com ${result.serverUrl || ''}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Parear';
  }
});

$('pairCode').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    if (!$<HTMLButtonElement>('joinCode').disabled) $('joinCode').click();
  }
});

$('save').addEventListener('click', async () => {
  const hotkey = $<HTMLInputElement>('hotkey').value.trim();
  if (hotkey && window.syncboard?.testHotkey) {
    const test = (await window.syncboard.testHotkey(hotkey)) as {
      ok?: boolean;
      hotkey?: string;
      error?: string;
    };
    if (!test.ok) {
      alert(test.error || 'Atalho inválido ou em uso');
      return;
    }
    if (test.hotkey) $<HTMLInputElement>('hotkey').value = test.hotkey;
  }

  await window.syncboard?.saveConfig?.({
    runLocalServer: $<HTMLInputElement>('runLocalServer').checked,
    port: parseInt($<HTMLInputElement>('port').value, 10) || 8787,
    serverUrl: $<HTMLInputElement>('serverUrl').value.trim(),
    deviceName: $<HTMLInputElement>('deviceName').value.trim(),
    autoSync: $<HTMLInputElement>('autoSync').checked,
    autoUpdate: $<HTMLInputElement>('autoUpdate').checked,
    launchAtLogin: $<HTMLInputElement>('launchAtLogin').checked,
    hotkey: $<HTMLInputElement>('hotkey').value.trim() || undefined,
  });
  window.close();
});

$('cancel').addEventListener('click', () => window.close());
void load();
