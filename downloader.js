'use strict';
/* 下载核心：GD 音乐台 API（music-api.gdstudio.xyz）解析网易云歌单并批量下载。 */
const fs = require('fs');
const path = require('path');

const BASE = 'https://music-api.gdstudio.xyz/api.php';
const SOURCE = 'netease';
const BR_ORDER = [320, 192, 128];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sanitize = (s) => String(s).replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

function fetchT(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

function extractId(input) {
  const s = String(input || '').trim();
  const m = s.match(/[?&]id=(\d+)/);
  if (m) return m[1];
  if (/^\d+$/.test(s)) return s;
  const m2 = s.match(/(\d{6,})/);
  return m2 ? m2[1] : null;
}

async function getJson(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetchT(url, 20000);
      if (!res.ok) throw new Error('http ' + res.status);
      const txt = await res.text();
      try { return JSON.parse(txt); } catch { throw new Error('non-json'); }
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1000 * (i + 1));
    }
  }
}

async function getSongUrl(id, brList) {
  for (const br of brList) {
    try {
      const j = await getJson(`${BASE}?types=url&source=${SOURCE}&id=${id}&br=${br}`);
      if (j && typeof j.url === 'string' && /^https?:\/\//.test(j.url)) {
        return { url: j.url, br: j.br || br, size: j.size || 0 };
      }
    } catch (e) { /* try next bitrate */ }
    await sleep(120);
  }
  return null;
}

async function fetchBytes(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetchT(url, 60000);
      if (!res.ok) throw new Error('http ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 50 * 1024) throw new Error('too-small ' + buf.length);
      return buf;
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1000 * (i + 1));
    }
  }
}

async function fetchPlaylist(id) {
  const r = await getJson(`${BASE}?types=playlist&source=${SOURCE}&id=${id}`);
  if (r.code !== 200 || !r.playlist) throw new Error('歌单解析失败: code ' + r.code);
  return r.playlist;
}

async function parsePlaylist(input) {
  const id = extractId(input);
  if (!id) throw new Error('无法从输入中解析歌单 ID（请粘贴歌单链接或纯数字 ID）');
  const p = await fetchPlaylist(id);
  return {
    id,
    name: p.name,
    trackCount: p.trackCount,
    returned: (p.tracks || []).length,
    creator: p.creator && p.creator.nickname,
    tracks: (p.tracks || []).map((t) => ({
      id: t.id, name: t.name, artists: (t.ar || []).map((a) => a.name).join(','), fee: t.fee,
    })),
  };
}

async function downloadPlaylist(opts, onProgress, signal) {
  const id = extractId(opts.id || opts.input);
  if (!id) throw new Error('无效的歌单 ID');
  const outDir = opts.outDir;
  if (!outDir) throw new Error('请先选择输出目录');
  const concurrency = Math.max(1, Math.min(8, opts.concurrency || 3));
  const brList = opts.br ? [opts.br, ...BR_ORDER.filter((b) => b !== opts.br)] : BR_ORDER;
  const cancelled = () => !!(signal && signal.cancelled);

  const p = await fetchPlaylist(id);
  const tracks = p.tracks || [];
  const dirName = sanitize(p.name) || id;
  const targetDir = path.join(outDir, dirName);
  fs.mkdirSync(targetDir, { recursive: true });
  onProgress({ type: 'start', playlist: p.name, total: tracks.length, outDir: targetDir });

  const usedNames = new Set();
  const results = [];
  let idx = 0, done = 0, okCount = 0, skipCount = 0, totalBytes = 0;

  async function worker() {
    while (idx < tracks.length && !cancelled()) {
      const my = idx++;
      const song = tracks[my];
      const label = `${(song.ar || []).map((a) => a.name).join(',')} - ${song.name}`;
      let res;
      try {
        const meta = await getSongUrl(song.id, brList);
        if (!meta) {
          res = { ok: false, id: song.id, label, reason: 'no-url（VIP/无版权）' };
        } else {
          let buf = null;
          try { buf = await fetchBytes(meta.url); }
          catch (e) { res = { ok: false, id: song.id, label, reason: 'download-fail: ' + e.message }; }
          if (buf) {
            let base = sanitize(label) || String(song.id);
            let fname = base + '.mp3', n = 1;
            while (usedNames.has(fname.toLowerCase())) fname = `${base} (${n++}).mp3`;
            usedNames.add(fname.toLowerCase());
            fs.writeFileSync(path.join(targetDir, fname), buf);
            res = { ok: true, id: song.id, label, br: meta.br, bytes: buf.length, file: fname };
          }
        }
      } catch (e) {
        res = { ok: false, id: song.id, label, reason: 'error: ' + e.message };
      }
      results[my] = res;
      done++;
      if (res.ok) { okCount++; totalBytes += res.bytes; } else { skipCount++; }
      onProgress({ type: 'track', done, total: tracks.length, ok: res.ok, label: res.label, br: res.br, bytes: res.bytes, reason: res.reason });
      await sleep(150);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const brDist = {};
  results.filter((x) => x && x.ok).forEach((x) => { brDist[x.br] = (brDist[x.br] || 0) + 1; });
  const summary = {
    playlist: p.name, id, total: tracks.length, success: okCount, skipped: skipCount,
    totalMB: +(totalBytes / 1048576).toFixed(1), bitrateDistribution: brDist, outDir: targetDir,
    cancelled: cancelled(),
    skippedList: results.filter((x) => x && !x.ok).map((x) => ({ id: x.id, name: x.label, reason: x.reason })),
  };
  try { fs.writeFileSync(path.join(targetDir, '_下载报告.json'), JSON.stringify(summary, null, 2), 'utf8'); } catch {}
  if (summary.skippedList.length) {
    try { fs.writeFileSync(path.join(targetDir, '_跳过清单.txt'), summary.skippedList.map((x) => `${x.id}\t${x.name}\t${x.reason}`).join('\n'), 'utf8'); } catch {}
  }
  onProgress({ type: 'done', summary });
  return summary;
}

module.exports = { parsePlaylist, downloadPlaylist, extractId, BASE };