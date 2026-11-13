'use strict';
/* 主进程：浅色窗口 / 单实例 / IPC（搜索、解析、自检、下载、取消、打开目录） */
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const engine = require('./src/engine');

app.setAppUserModelId('com.dkvkvk.windtune');

let win = null;
let currentSignal = null;

function iconPath() {
  const ico = path.join(__dirname, 'assets', 'icon.ico');
  const png = path.join(__dirname, 'assets', 'icon.png');
  if (process.platform === 'win32' && fs.existsSync(ico)) return ico;
  return fs.existsSync(png) ? png : undefined;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 900,
    minWidth: 980,
    minHeight: 700,
    backgroundColor: '#f5f7fb',
    title: '听风音乐舫',
    icon: iconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  win.on('closed', () => { win = null; });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}

/* ---------------- IPC ---------------- */

const wrap = (fn) => async (e, ...args) => {
  try { return { ok: true, data: await fn(...args) }; }
  catch (err) { return { ok: false, error: err && err.message ? err.message : String(err) }; }
};

ipcMain.handle('app:search', wrap(async (opts) => engine.searchAll(opts || {}, null)));
ipcMain.handle('app:resolve', wrap(async (opts) => engine.resolveInput(opts || {}, null)));
ipcMain.handle('app:check-sources', wrap(async () => engine.checkSources(null)));

ipcMain.handle('app:choose-dir', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择下载保存目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

ipcMain.handle('app:default-dir', () => path.join(app.getPath('music'), '全平台音乐'));

ipcMain.handle('app:start-download', async (e, opts) => {
  if (currentSignal) return { ok: false, error: '已有下载任务在进行，请先等待或取消' };
  currentSignal = { cancelled: false };
  const send = (ev) => { if (win && !win.isDestroyed()) win.webContents.send('download-progress', ev); };
  try {
    const summary = await engine.downloadTracks(opts || {}, send, currentSignal);
    return { ok: true, summary };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  } finally {
    currentSignal = null;
  }
});

ipcMain.handle('app:cancel-download', () => {
  if (currentSignal) currentSignal.cancelled = true;
  return true;
});

ipcMain.handle('app:open-dir', async (e, dir) => {
  if (dir && fs.existsSync(dir)) { await shell.openPath(dir); return true; }
  return false;
});

ipcMain.handle('app:open-url', async (e, url) => {
  if (/^https?:\/\//i.test(String(url || ''))) { await shell.openExternal(url); return true; }
  return false;
});
