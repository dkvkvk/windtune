'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

async function waitFor(check, description) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail('等待超时：' + description);
}

async function checkRetry(root) {
  const { app, BrowserWindow, dialog, shell } = require('electron');
  const { SOURCES } = require('../src/sources');
  const engine = require('../src/engine');
  app.setPath('userData', root);
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-background-networking');
  app.on('browser-window-created', (_event, win) => win.hide());

  const originalDir = path.join(root, 'original');
  const otherDir = path.join(root, 'other');
  let pickDir = originalDir;
  let openedDir;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pickDir] });
  shell.openPath = async (dir) => { openedDir = dir; return ''; };

  const tracks = [
    { id: 'original', name: '同名曲' },
    { id: 'retry-first', name: '同名曲' },
    { id: 'retry-second', name: '另一首' }
  ].map((item) => ({ ...item, source: 'joox', key: 'joox:' + item.id, artists: ['测试歌手'] }));
  const retryGate = Promise.withResolvers();
  const cancelGate = Promise.withResolvers();
  let pendingRequest;
  const attempts = new Map();
  const batches = [];
  const downloadTracks = engine.downloadTracks;
  engine.downloadTracks = async (options, progress, signal) => {
    const batch = { options, signal };
    batches.push(batch);
    batch.summary = await downloadTracks(options, progress, signal);
    return batch.summary;
  };

  SOURCES.joox.search = async () => tracks;
  SOURCES.joox.url = async (track, br) => {
    const count = (attempts.get(track.id) || 0) + 1;
    attempts.set(track.id, count);
    if (track.id === 'retry-first' && count === 1) return null;
    if (track.id === 'retry-second' && count === 1) return null;
    if (track.id === 'retry-second' && count === 2) {
      await retryGate.promise;
      return null;
    }
    return { url: 'https://fixture.invalid/audio/' + track.id, br };
  };
  SOURCES.joox.lyric = async (track) => '[00:00.00]' + track.id;
  SOURCES.joox.pic = async (track) => 'https://fixture.invalid/cover/' + track.id;
  global.fetch = async (input, { signal }) => {
    const url = new URL(input);
    assert.equal(url.hostname, 'fixture.invalid');
    if (batches.length === 4 && url.pathname === '/audio/retry-first') {
      pendingRequest = signal;
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      await cancelGate.promise;
      throw signal.reason;
    }
    const audio = url.pathname.startsWith('/audio/');
    const data = Buffer.alloc(audio ? 24 * 1024 : 5 * 1024);
    data.write(audio ? 'ID3' : 'cover');
    data.write(url.pathname, 8);
    return new Response(data, { headers: { 'Content-Type': audio ? 'audio/mpeg' : 'image/jpeg' } });
  };

  require('../main');
  await app.whenReady();
  await waitFor(() => BrowserWindow.getAllWindows().length, '主窗口');
  const web = BrowserWindow.getAllWindows()[0].webContents;
  const evaluate = (code) => web.executeJavaScript(code);
  const click = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  const complete = () => evaluate("!document.querySelector('#summary').hidden && !document.querySelector('#btnStart').disabled");
  const ids = (batch) => batch.options.tracks.map((track) => track.id);

  await waitFor(() => evaluate("!!window.api && document.querySelector('#brandLogo').naturalWidth > 0"), '界面与 preload');
  await click('btnDir');
  await waitFor(() => evaluate(`document.querySelector('#dirPath').textContent === ${JSON.stringify(originalDir)}`), '原始目录');
  await evaluate(`
    for (const button of document.querySelectorAll('#chips button')) {
      if (button.dataset.id !== 'joox') button.click();
    }
    document.querySelector('#q').value = '离线重试';
    document.querySelector('#fallback').checked = false;
    document.querySelector('#concurrency').value = '1';
    document.querySelector('#br').value = '740';
    document.querySelector('#btnSearch').click();
  `);
  await waitFor(() => evaluate("document.querySelectorAll('.tr--row').length === 3"), '搜索结果');
  await click('btnStart');
  await waitFor(complete, '首轮下载结果');
  assert.deepEqual(ids(batches[0]), ['original', 'retry-first', 'retry-second']);
  assert.deepEqual([batches[0].summary.success, batches[0].summary.skipped], [1, 2]);
  assert.equal(await evaluate("document.querySelector('#btnRetryFailed').textContent"), '重试失败项');
  const target = batches[0].summary.outDir;
  const base = '测试歌手 - 同名曲';
  const snapshot = ['mp3', 'lrc', 'jpg'].map((ext) => fs.readFileSync(path.join(target, base + '.' + ext)));

  pickDir = otherDir;
  await click('btnDir');
  await waitFor(() => evaluate(`document.querySelector('#dirPath').textContent === ${JSON.stringify(otherDir)}`), '更改后的目录');
  await click('btnOpenSum');
  await waitFor(() => openedDir === target, '打开本次任务的实际目录');
  await evaluate(`
    document.querySelector('#br').value = '128';
    document.querySelector('#concurrency').value = '2';
    document.querySelector('#fallback').checked = true;
    document.querySelector('#saveLyric').checked = false;
    document.querySelector('#saveCover').checked = false;
    const retry = document.querySelector('#btnRetryFailed');
    retry.click();
    retry.click();
    document.querySelector('#btnStart').click();
  `);
  await waitFor(() => attempts.get('retry-second') === 2, '第一次重试进行中');
  assert.equal(batches.length, 2);
  assert.equal(await evaluate("document.querySelector('#btnStart').disabled"), true);
  assert.equal(await evaluate("document.querySelector('[data-key=\"joox:original\"] .col-status').textContent"), '完成');
  retryGate.resolve();
  await waitFor(complete, '第一次重试结果');
  assert.deepEqual(ids(batches[1]), ['retry-first', 'retry-second']);
  assert.deepEqual([batches[1].summary.success, batches[1].summary.skipped], [1, 1]);

  await click('btnRetryFailed');
  await waitFor(complete, '第二次重试结果');
  assert.deepEqual(ids(batches[2]), ['retry-second']);
  assert.deepEqual([batches[2].summary.success, batches[2].summary.skipped], [1, 0]);
  for (const batch of batches.slice(1)) {
    const { tracks: _tracks, retry, ...options } = batch.options;
    const { tracks: _originalTracks, ...originalOptions } = batches[0].options;
    assert.equal(retry, true);
    assert.deepEqual(options, originalOptions);
    assert.equal(batch.summary.outDir, target);
  }
  assert.equal(attempts.get('original'), 1);
  assert.equal(await evaluate("document.querySelector('#btnRetryFailed') === null"), true);
  assert.equal(fs.existsSync(otherDir), false);
  for (const [index, ext] of ['mp3', 'lrc', 'jpg'].entries()) {
    assert.deepEqual(fs.readFileSync(path.join(target, base + '.' + ext)), snapshot[index]);
    assert.ok(fs.existsSync(path.join(target, base + ' (1).' + ext)));
  }
  assert.equal(fs.readFileSync(path.join(target, '_跳过清单.txt'), 'utf8'), '');
  console.log('PASS 混合结果、连续重试、原任务设置、重复触发和同名文件保护');

  await evaluate(`
    document.querySelector('#fallback').checked = false;
    document.querySelector('#concurrency').value = '1';
    document.querySelector('#btnStart').click();
  `);
  await waitFor(() => pendingRequest, '待取消的下载请求');
  await click('btnCancel');
  await waitFor(() => pendingRequest.aborted, '取消信号已到达当前下载请求');
  assert.equal(await evaluate("document.querySelector('#dlState').textContent"), '正在取消');
  await click('btnStart');
  assert.equal(batches.length, 4);
  cancelGate.resolve();
  await waitFor(complete, '取消结果');
  assert.deepEqual([batches[3].summary.cancelled, batches[3].summary.success, batches[3].summary.skipped], [true, 1, 0]);
  assert.equal(await evaluate("document.querySelector('#summary h3').textContent"), '下载已取消');
  assert.ok(await evaluate("document.querySelector('.sum-meta').textContent.includes('未完成 2 首')"));
  assert.equal(await evaluate("document.querySelector('#btnRetryFailed') === null"), true);
  assert.equal(attempts.get('retry-second'), 3);
  console.log('PASS 手动取消保留成功项，未完成曲目与失败项分开统计');
}

if (process.versions.electron) {
  const { app } = require('electron');
  checkRetry(process.argv[2]).then(() => app.exit(0), (err) => {
    console.error(err);
    app.exit(1);
  });
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'windtune-retry-'));
  try {
    const result = spawnSync(require('electron'), [__filename, root], { stdio: 'inherit', timeout: 90000, windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      console.error('Electron 测试进程退出：' + (result.status ?? result.signal));
      process.exitCode = 1;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
}
