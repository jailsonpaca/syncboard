const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('syncboard', {
  isElectron: true,
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  testHotkey: (hotkey) => ipcRenderer.invoke('test-hotkey', hotkey),
  /** Copia o item e cola no app que estava focado (atalho / popup). */
  pasteItem: (item) => ipcRenderer.invoke('paste-item', item),
  /** Aplica item remoto na clipboard do SO (backup do WS do main). */
  applyRemoteItem: (item) => ipcRenderer.invoke('apply-remote-item', item),
  joinWithCode: (code) => ipcRenderer.invoke('join-with-code', code),
  discoverServers: () => ipcRenderer.invoke('discover-servers'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  getUpdateNotes: () => ipcRenderer.invoke('get-update-notes'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  // Conversor de vídeo -> MP4 (WhatsApp)
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  checkFfmpeg: () => ipcRenderer.invoke('video-check'),
  pickVideo: () => ipcRenderer.invoke('video-pick'),
  convertVideo: (opts) => ipcRenderer.invoke('video-convert', opts),
  cancelVideo: () => ipcRenderer.invoke('video-cancel'),
  revealVideo: (p) => ipcRenderer.invoke('video-reveal', p),
  sendVideoToHistory: (p) => ipcRenderer.invoke('video-send-to-history', p),
  // Gravador de tela
  recStatus: () => ipcRenderer.invoke('rec-status'),
  recOpenPrivacy: (kind) => ipcRenderer.invoke('rec-open-privacy', kind),
  recAskMic: () => ipcRenderer.invoke('rec-ask-mic'),
  recSources: () => ipcRenderer.invoke('rec-sources'),
  recSelect: (sel) => ipcRenderer.invoke('rec-select', sel),
  recBegin: (opts) => ipcRenderer.invoke('rec-begin', opts),
  recChunk: (data) => ipcRenderer.invoke('rec-chunk', data),
  recEnd: (opts) => ipcRenderer.invoke('rec-end', opts),
  onVideoProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('video-progress', handler);
    return () => ipcRenderer.removeListener('video-progress', handler);
  },
  onUpdateStatus: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('update-status', handler);
    return () => ipcRenderer.removeListener('update-status', handler);
  },
});
