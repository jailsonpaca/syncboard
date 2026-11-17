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
  getPathForFile?: (file: File) => string;
  checkFfmpeg?: () => Promise<{ ok: boolean; path?: string; version?: string; error?: string }>;
  pickVideo?: () => Promise<string | null>;
  convertVideo?: (opts: {
    input: string;
    preset?: 'light' | 'balanced' | 'high';
    maxMB?: number | null;
  }) => Promise<{ ok: boolean; outputPath?: string; sizeBytes?: number; error?: string; cancelled?: boolean }>;
  cancelVideo?: () => Promise<{ ok: boolean }>;
  revealVideo?: (path: string) => Promise<{ ok: boolean }>;
  sendVideoToHistory?: (path: string) => Promise<{ ok: boolean; error?: string }>;
  recStatus?: () => Promise<{ platform: string; screen: string; microphone: string; outputDir: string }>;
  recOpenPrivacy?: (kind: 'screen' | 'microphone') => Promise<{ ok: boolean }>;
  recAskMic?: () => Promise<{ ok: boolean }>;
  recSources?: () => Promise<{
    ok: boolean;
    error?: string;
    sources: Array<{ id: string; name: string; kind: 'screen' | 'window'; thumbnail: string }>;
  }>;
  recSelect?: (sel: { sourceId: string; systemAudio?: boolean }) => Promise<{ ok: boolean }>;
  recBegin?: (opts: { ext: 'mp4' | 'webm' }) => Promise<{ ok: boolean; filePath?: string; error?: string }>;
  recChunk?: (data: ArrayBuffer) => Promise<{ ok: boolean; error?: string }>;
  recEnd?: (opts?: { discard?: boolean }) => Promise<{ ok: boolean; outputPath?: string; sizeBytes?: number; error?: string }>;
  onVideoProgress?: (cb: (data: { percent: number }) => void) => () => void;
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
