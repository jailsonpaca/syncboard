const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('syncboard', {
  isElectron: true,
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  testHotkey: (hotkey) => ipcRenderer.invoke('test-hotkey', hotkey),
  /** Copia o item e cola no app que estava focado (atalho / popup). */
  pasteItem: (item) => ipcRenderer.invoke('paste-item', item),
  joinWithCode: (code) => ipcRenderer.invoke('join-with-code', code),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateStatus: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('update-status', handler);
    return () => ipcRenderer.removeListener('update-status', handler);
  },
});
