/// <reference types="vite/client" />

interface SyncboardDesktop {
  isElectron?: boolean;
  pasteItem?: (item: import('./types').ClipItem) => Promise<{
    ok?: boolean;
    pasted?: boolean;
    revealed?: boolean;
    localPath?: string;
  }>;
  applyRemoteItem?: (item: import('./types').ClipItem) => Promise<{ ok?: boolean; error?: string }>;
  getConfig?: () => Promise<Record<string, unknown>>;
  saveConfig?: (cfg: Record<string, unknown>) => Promise<unknown>;
  testHotkey?: (hotkey: string) => Promise<unknown>;
  joinWithCode?: (code: string) => Promise<{ ok?: boolean; serverUrl?: string; error?: string }>;
  discoverServers?: () => Promise<{
    ok?: boolean;
    error?: string;
    servers?: Array<{
      serverUrl: string;
      code?: string;
      hostname?: string;
      urls?: string[];
    }>;
  }>;
  checkUpdate?: () => Promise<{
    ok?: boolean;
    updateAvailable?: boolean;
    version?: string | null;
    releaseNotes?: string;
    downloaded?: boolean;
    fallbackUrl?: string;
  }>;
  downloadUpdate?: () => Promise<{ ok?: boolean; error?: string; fallbackUrl?: string }>;
  installUpdate?: () => Promise<{ ok?: boolean; error?: string; fallbackUrl?: string }>;
  getUpdateNotes?: () => Promise<{
    ok?: boolean;
    version?: string | null;
    releaseNotes?: string;
  }>;
  openExternal?: (url: string) => Promise<{ ok?: boolean; error?: string; url?: string }>;
  onUpdateStatus?: (cb: (data: {
    updateAvailable?: boolean;
    version?: string | null;
    downloaded?: boolean;
    appVersion?: string;
    downloadPage?: string | null;
    releaseNotes?: string;
    phase?: 'idle' | 'downloading' | 'installing' | 'ready' | 'error' | string;
    progress?: number;
    error?: string | null;
  }) => void) => () => void;
}

interface Window {
  syncboard?: SyncboardDesktop;
}
