/// <reference types="vite/client" />

interface SyncboardDesktop {
  isElectron?: boolean;
  pasteItem?: (item: import('./types').ClipItem) => Promise<{
    ok?: boolean;
    pasted?: boolean;
    revealed?: boolean;
    localPath?: string;
  }>;
  getConfig?: () => Promise<Record<string, unknown>>;
  saveConfig?: (cfg: Record<string, unknown>) => Promise<unknown>;
  testHotkey?: (hotkey: string) => Promise<unknown>;
  joinWithCode?: (code: string) => Promise<{ ok?: boolean; serverUrl?: string; error?: string }>;
  checkUpdate?: () => Promise<unknown>;
  downloadUpdate?: () => Promise<unknown>;
  installUpdate?: () => Promise<unknown>;
  onUpdateStatus?: (cb: (data: {
    updateAvailable?: boolean;
    version?: string | null;
    downloaded?: boolean;
    appVersion?: string;
    downloadPage?: string | null;
  }) => void) => () => void;
}

interface Window {
  syncboard?: SyncboardDesktop;
}
