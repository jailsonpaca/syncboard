import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { setDeviceName, setServerUrl } from './api';

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function subscribeEvent<T>(eventName: string, cb: (payload: T) => void): () => void {
  let cancelled = false;
  let unlisten: UnlistenFn | null = null;
  void listen<T>(eventName, (ev) => {
    if (!cancelled) cb(ev.payload);
  }).then((fn) => {
    if (cancelled) fn();
    else unlisten = fn;
  });
  return () => {
    cancelled = true;
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  };
}

/**
 * Instala o objeto `window.syncboard` compatível com o Electron quando
 * rodando dentro do shell nativo Tauri v2.
 */
export function installDesktopBridge(): void {
  if (!isTauriRuntime()) return;
  if (window.syncboard?.isTauri) return;

  window.syncboard = {
    isElectron: true,
    isTauri: true,
    getConfig: () => invoke('get_config'),
    saveConfig: (cfg) => invoke('save_config', { cfg }),
    testHotkey: (hotkey) => invoke('test_hotkey', { hotkey }),
    pasteItem: (item) => invoke('paste_item', { item }),
    applyRemoteItem: (item) => invoke('apply_remote_item', { item }),
    joinWithCode: (code) => invoke('join_with_code', { code }),
    discoverServers: () => invoke('discover_servers'),
    checkUpdate: () => invoke('check_update'),
    downloadUpdate: () => invoke('download_update'),
    installUpdate: () => invoke('install_update'),
    getUpdateNotes: () => invoke('get_update_notes'),
    openExternal: (url) => invoke('open_external', { url }),
    getPathForFile: (file) => (file as File & { path?: string }).path || '',
    checkFfmpeg: () => invoke('video_check'),
    pickVideo: () => invoke('video_pick'),
    convertVideo: (opts) => invoke('video_convert', { opts }),
    cancelVideo: () => invoke('video_cancel'),
    revealVideo: (path) => invoke('video_reveal', { path }),
    sendVideoToHistory: (path) => invoke('video_send_to_history', { path }),
    recStatus: () => invoke('rec_status'),
    recOpenPrivacy: (kind) => invoke('rec_open_privacy', { kind }),
    recAskMic: () => invoke('rec_ask_mic'),
    recSources: () => invoke('rec_sources'),
    recStartNative: (opts) => invoke('rec_start_native', { opts }),
    recStopNative: (opts) => invoke('rec_stop_native', { discard: Boolean(opts?.discard) }),
    onFileDrop: (cb) =>
      subscribeEvent<{ paths?: string[] }>('tauri://drag-drop', (payload) => {
        if (Array.isArray(payload?.paths) && payload.paths.length > 0) {
          cb(payload.paths);
        }
      }),
    onVideoProgress: (cb) => subscribeEvent<{ percent: number }>('video-progress', cb),
    onUpdateStatus: (cb) => subscribeEvent('update-status', cb),
  };
}

/**
 * Sincroniza `serverUrl` e `deviceName` antes de montar o React para evitar
 * fetch inicial apontando para `tauri://localhost`.
 */
export async function bootstrapDesktopConfig(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const cfg = await window.syncboard?.getConfig?.();
    if (!cfg) return;
    if (typeof cfg.serverUrl === 'string' && cfg.serverUrl.trim()) {
      setServerUrl(cfg.serverUrl.trim());
    }
    if (typeof cfg.deviceName === 'string' && cfg.deviceName.trim()) {
      setDeviceName(cfg.deviceName.trim());
    }
  } catch {
    /* fallback para padrão 127.0.0.1:8787 */
  }
}
