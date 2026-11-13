'use strict';
/* 安全桥：渲染层只能通过 window.api 调主进程（contextIsolation 开启） */
const { contextBridge, ipcRenderer } = require('electron');
const { version } = require('./package.json');

const unwrap = async (p) => {
  const r = await p;
  if (r && r.ok) return { ok: true, data: r.data };
  return { ok: false, error: (r && r.error) || '未知错误' };
};

contextBridge.exposeInMainWorld('api', {
  version,

  /** 跨平台搜索 -> { ok, data: { items, bySource } } */
  search: (opts) => unwrap(ipcRenderer.invoke('app:search', opts)),

  /** 链接/ID/关键词 -> { ok, data: Collection } */
  resolve: (opts) => unwrap(ipcRenderer.invoke('app:resolve', opts)),

  /** 平台连通性自检 -> { ok, data: [...] } */
  checkSources: () => unwrap(ipcRenderer.invoke('app:check-sources')),

  /** 已加载的自定义音源 -> { ok, data: { list, dir } } */
  plugins: () => unwrap(ipcRenderer.invoke('app:plugins')),
  openSourcesDir: () => ipcRenderer.invoke('app:open-sources-dir'),

  chooseDir: () => ipcRenderer.invoke('app:choose-dir'),
  defaultDir: () => ipcRenderer.invoke('app:default-dir'),
  startDownload: (opts) => ipcRenderer.invoke('app:start-download', opts),
  cancelDownload: () => ipcRenderer.invoke('app:cancel-download'),
  openDir: (dir) => ipcRenderer.invoke('app:open-dir', dir),
  openUrl: (url) => ipcRenderer.invoke('app:open-url', url),

  onProgress: (cb) => {
    const listener = (e, data) => cb(data);
    ipcRenderer.on('download-progress', listener);
    return () => ipcRenderer.removeListener('download-progress', listener);
  },
});
