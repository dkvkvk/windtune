'use strict';
/* 安全桥：渲染层通过 window.api 调用主进程，contextIsolation 开启 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  parsePlaylist: (input) => ipcRenderer.invoke('parse-playlist', input),
  chooseDir: () => ipcRenderer.invoke('choose-dir'),
  defaultDir: () => ipcRenderer.invoke('default-dir'),
  startDownload: (opts) => ipcRenderer.invoke('start-download', opts),
  cancelDownload: () => ipcRenderer.invoke('cancel-download'),
  openDir: (dir) => ipcRenderer.invoke('open-dir', dir),
  onProgress: (cb) => {
    const listener = (e, data) => cb(data);
    ipcRenderer.on('download-progress', listener);
    return () => ipcRenderer.removeListener('download-progress', listener);
  },
});