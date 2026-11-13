'use strict';
/* 主进程：窗口 / 单实例 / IPC（解析、选目录、下载、取消、打开目录） */
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const downloader = require('./downloader');

let win = null;
let currentSignal = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 780,
    minWidth: 860,
    minHeight: 600,
    backgroundColor: '#0f1115',
    title: '网易云音乐下载器',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
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

ipcMain.handle('parse-playlist', async (e, input) => {
  try { return { ok: true, data: await downloader.parsePlaylist(input) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('choose-dir', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择下载输出目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

ipcMain.handle('default-dir', () => path.join(app.getPath('music'), '网易云歌单'));

ipcMain.handle('start-download', async (e, opts) => {
  if (currentSignal) return { ok: false, error: '已有下载任务在进行' };
  currentSignal = { cancelled: false };
  const send = (ev) => { if (win && !win.isDestroyed()) win.webContents.send('download-progress', ev); };
  try {
    const summary = await downloader.downloadPlaylist(opts, send, currentSignal);
    return { ok: true, summary };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    currentSignal = null;
  }
});

ipcMain.handle('cancel-download', () => {
  if (currentSignal) currentSignal.cancelled = true;
  return true;
});

ipcMain.handle('open-dir', async (e, dir) => {
  if (dir && fs.existsSync(dir)) { await shell.openPath(dir); return true; }
  return false;
});