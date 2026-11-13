'use strict';
/* 聚合引擎：跨平台搜索 / 链接解析 / 直链瀑布（含跨平台补链）/ 批量下载 */
const fs = require('fs');
const path = require('path');
const { getBuffer, getJson, mapLimit, sniff, isAudioExt, sleep } = require('./http');
const { SOURCES, SOURCE_IDS, SOURCE_LIST, track } = require('./sources');

/* 下载后端优先级：先本平台，再这两个真正能出音频的源 */
const DOWNLOAD_ORDER = ['netease', 'kuwo', 'kugou', 'tencent'];

const sanitize = (s) => String(s).replace(/[\\/:*?"<>|\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || '未命名';

/* ---------------- 搜索 ---------------- */

async function searchAll({ keyword, sources, limit }, signal) {
  const kw = String(keyword || '').trim();
  if (!kw) throw new Error('请输入搜索关键词');
  const use = (Array.isArray(sources) && sources.length ? sources : SOURCE_IDS).filter((s) => SOURCES[s]);
  const n = Math.max(5, Math.min(50, limit || 20));
  const bySource = {};
  const settled = await Promise.all(use.map(async (sid) => {
    const t0 = Date.now();
    try {
      const items = (await SOURCES[sid].search(kw, n, signal)) || [];
      bySource[sid] = { count: items.length, ms: Date.now() - t0, ok: true };
      return items;
    } catch (e) {
      bySource[sid] = { count: 0, ms: Date.now() - t0, ok: false, error: e.message };
      return [];
    }
  }));
  const items = [];
  const seen = new Set();
  for (const list of settled) {
    for (const t of list) {
      if (seen.has(t.key)) continue;
      seen.add(t.key);
      items.push(t);
    }
  }
  return { items, bySource };
}

/* ---------------- 输入识别 ---------------- */

function parseLink(input) {
  const s = String(input || '').trim();
  const hit = (source, kind, id) => ({ source, kind, id: String(id) });

  let m;
  if ((m = s.match(/music\.163\.com.*?[?#&]id=(\d+)/)) || (m = s.match(/^(\d{5,})$/))) return hit('netease', 'playlist', m[1]);
  if ((m = s.match(/y\.qq\.com\/n\/ryqq\/playlist\/(\w+)/))) return hit('tencent', 'playlist', m[1]);
  if ((m = s.match(/y\.qq\.com\/n\/ryqq\/albumDetail\/(\w+)/))) return hit('tencent', 'album', m[1]);
  if ((m = s.match(/y\.qq\.com.*songDetail\/(\w+)/)) || (m = s.match(/y\.qq\.com.*songmid=(\w+)/))) return hit('tencent', 'song', m[1]);
  if ((m = s.match(/kugou\.com.*special\/single\/(\d+)/))) return hit('kugou', 'playlist', m[1]);
  if ((m = s.match(/kugou\.com.*[#&]hash=([0-9a-fA-F]{32})/))) return hit('kugou', 'song', m[1]);
  if ((m = s.match(/kuwo\.cn\/playlist_detail\/(\d+)/))) return hit('kuwo', 'playlist', m[1]);
  if ((m = s.match(/kuwo\.cn\/play_detail\/(\d+)/))) return hit('kuwo', 'song', m[1]);
  if ((m = s.match(/joox\.com.*\/([A-Za-z0-9+/=_-]{10,})/))) return hit('joox', 'song', m[1]);
  if (/^https?:\/\//.test(s)) return null;
  return null;
}

/* 网易云单曲详情（补名字/歌手/封面用，接口未放行则静默失败） */
async function neteaseSongDetail(id, signal) {
  try {
    const j = await getJson(`https://music.163.com/api/song/detail?ids=[${encodeURIComponent(id)}]`, { signal, timeout: 15000, retries: 1, referer: 'https://music.163.com/' });
    const s = j && j.songs && j.songs[0];
    if (!s) return null;
    return track({
      source: 'netease',
      id,
      name: s.name,
      artists: (s.artists || []).map((a) => a.name),
      album: (s.album && s.album.name) || '',
      durationMs: s.duration || 0,
      picUrl: (s.album && s.album.picUrl) || '',
      extra: { urlId: id, lyricId: id, picId: '' },
    });
  } catch { return null; }
}

async function resolveInput({ input, source }, signal) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('请输入关键词或链接');

  const link = parseLink(raw);

  if (link) {
    const src = SOURCES[link.source];
    if (link.kind === 'playlist' || link.kind === 'album') {
      const fn = link.kind === 'album' ? (src && src.album) : (src && src.playlist);
      if (!fn) {
        throw new Error(`${src ? src.label : link.source} 的${link.kind === 'album' ? '专辑' : '歌单'}暂不支持解析（该平台未开放对应接口）。可以改用关键词搜索，或在网易云 / 酷我 / QQ音乐 / 酷狗 的歌单里下载。`);
      }
      return await fn(link.id, signal);
    }
    // 单曲链接
    if (link.source === 'netease') {
      const t = await neteaseSongDetail(link.id, signal);
      if (t) return { kind: 'track', title: t.name, subtitle: t.artists.join(', '), source: 'netease', total: 1, tracks: [t] };
    }
    const t = track({
      source: link.source, id: link.id, name: `单曲 ${link.id}`,
      artists: [], album: '', picUrl: '', extra: { urlId: link.id, mid: link.id, rid: link.id, hash: link.id },
    });
    return { kind: 'track', title: t.name, subtitle: src ? src.label : '', source: link.source, total: 1, tracks: [t] };
  }

  // 不是链接 -> 跨平台搜索
  const r = await searchAll({ keyword: raw, sources: source ? [source] : undefined, limit: 30 }, signal);
  if (!r.items.length) throw new Error('没有搜到结果，换个关键词试试');
  return { kind: 'search', title: raw, subtitle: `${r.items.length} 条结果`, source: 'all', total: r.items.length, tracks: r.items };
}

/* ---------------- 匹配与补链 ---------------- */

const norm = (s) => String(s || '').toLowerCase()
  .replace(/[（(【\[].*?[)）】\]]/g, '')      // 去掉 (Live)、(remix) 之类
  .replace(/[\s\-_.,!?·、'"“”‘’]/g, '')
  .replace(/[^\p{L}\p{N}]/gu, '');

function score(cand, tr) {
  const a = norm(cand.name);
  const b = norm(tr.name);
  if (!a || !b) return 0;
  let s = 0;
  if (a === b) s += 70;
  else if (a.includes(b) || b.includes(a)) s += 40;
  else return 0;
  const ca = cand.artists.map(norm).filter(Boolean);
  const ta = tr.artists.map(norm).filter(Boolean);
  if (ca.length && ta.length) {
    const overlap = ca.some((x) => ta.some((y) => x === y || x.includes(y) || y.includes(x)));
    s += overlap ? 30 : 0;
  } else s += 10;
  if (cand.album && tr.album && norm(cand.album) === norm(tr.album)) s += 15;
  if (cand.duration && tr.duration && Math.abs(cand.duration - tr.duration) <= 3) s += 15;
  return s;
}

function pickBest(cands, tr) {
  let best = null;
  let bestScore = 0;
  for (const c of cands) {
    const sc = score(c, tr);
    if (sc > bestScore) { bestScore = sc; best = c; }
  }
  return bestScore >= 70 ? best : null; // 必须歌名对得上
}

/**
 * 跨平台找同一首歌：返回目标平台上可下载的 track
 * @param {object} tr 源 track
 * @param {string[]} order 目标源顺序
 */
async function crossFind(tr, order, signal, cache) {
  const q = `${tr.name} ${tr.artists[0] || ''}`.trim();
  for (const sid of order) {
    if (!SOURCES[sid] || sid === tr.source) continue;
    const ck = `${sid}|${norm(q)}`;
    let cands = cache.get(ck);
    if (!cands) {
      try { cands = (await SOURCES[sid].search(q, 8, signal)) || []; } catch { cands = []; }
      cache.set(ck, cands);
    }
    const best = pickBest(cands, tr);
    if (best) return best;
  }
  return null;
}

/** 解析可下载直链：本平台 -> 跨平台补链 */
async function resolveUrl(tr, br, fallback, signal, cache) {
  const own = SOURCES[tr.source];
  if (own && typeof own.url === 'function') {
    try {
      const r = await own.url(tr, br, signal);
      if (r && r.url) return { ...r, from: tr.source, matched: null };
    } catch { /* 落到补链 */ }
  }
  if (!fallback) return null;
  const alt = await crossFind(tr, DOWNLOAD_ORDER, signal, cache);
  if (!alt) return null;
  const altSrc = SOURCES[alt.source];
  if (!altSrc || typeof altSrc.url !== 'function') return null;
  try {
    const r = await altSrc.url(alt, br, signal);
    if (r && r.url) return { ...r, from: alt.source, matched: alt };
  } catch { /* 全部失败 */ }
  return null;
}

/** 歌词/封面：本平台优先，空了就跨平台找 */
async function resolveMeta(tr, signal, cache, wantLyric, wantCover) {
  const out = { lyric: '', cover: '' };
  const own = SOURCES[tr.source];
  if (wantLyric && own && typeof own.lyric === 'function') {
    try { out.lyric = (await own.lyric(tr, signal)) || ''; } catch { /* ignore */ }
  }
  if (wantCover && own && typeof own.pic === 'function') {
    try { out.cover = tr.picUrl || (await own.pic(tr, signal)) || ''; } catch { /* ignore */ }
  }
  if ((wantLyric && !out.lyric) || (wantCover && !out.cover)) {
    const alt = await crossFind(tr, DOWNLOAD_ORDER, signal, cache);
    if (alt) {
      const s = SOURCES[alt.source];
      if (wantLyric && !out.lyric && typeof s.lyric === 'function') {
        try { out.lyric = (await s.lyric(alt, signal)) || ''; } catch { /* ignore */ }
      }
      if (wantCover && !out.cover && typeof s.pic === 'function') {
        try { out.cover = (await s.pic(alt, signal)) || ''; } catch { /* ignore */ }
      }
    }
  }
  return out;
}

/* ---------------- 下载 ---------------- */

async function fetchAudio(url, signal, tries = 3) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const { buf, type } = await getBuffer(url, { signal, timeout: 120000, retries: 1, referer: 'https://music.163.com/' });
      if (!buf || buf.length < 20 * 1024) throw new Error('文件过小（' + (buf ? buf.length : 0) + 'B），可能是试听片段或空响应');
      if (/text\/html/i.test(type)) throw new Error('返回的是网页而不是音频');
      const ext = sniff(buf.slice(0, 16));
      if (!isAudioExt(ext)) throw new Error('不是音频格式（' + (ext || '未知') + '）');
      return { buf, ext };
    } catch (e) {
      lastErr = e;
      if (signal && signal.cancelled) throw e;
      if (i < tries - 1) await sleep(800 * (i + 1));
    }
  }
  throw lastErr;
}

async function downloadTracks(opts, onProgress, signal) {
  const tracks = (opts && opts.tracks) || [];
  if (!tracks.length) throw new Error('没有要下载的歌曲');
  const outDir = opts.outDir;
  if (!outDir) throw new Error('请先选择输出目录');
  const br = Number(opts.br) || 320;
  const fallback = opts.fallback !== false;
  const concurrency = Math.max(1, Math.min(8, Number(opts.concurrency) || 3));
  const wantLyric = !!opts.saveLyric;
  const wantCover = !!opts.saveCover;
  const cancelled = () => !!(signal && signal.cancelled);

  const title = opts.title || '音乐下载';
  const targetDir = path.join(outDir, sanitize(title));
  fs.mkdirSync(targetDir, { recursive: true });

  const cache = new Map();
  const usedNames = new Set();
  const results = new Array(tracks.length);
  let idx = 0;
  let done = 0;
  let okCount = 0;
  let skipCount = 0;
  let totalBytes = 0;

  onProgress({ type: 'start', title, total: tracks.length, outDir: targetDir });

  const emit = (ev) => { try { onProgress(ev); } catch { /* renderer 已关闭 */ } };

  async function one(tr) {
    const label = `${tr.artists.length ? tr.artists.join(', ') + ' - ' : ''}${tr.name}`;
    try {
      const meta = await resolveUrl(tr, br, fallback, signal, cache);
      if (!meta) {
        return { ok: false, name: label, source: tr.source, reason: '取不到可下载地址（版权/VIP 限制，或跨平台也没找到）' };
      }
      const audio = await fetchAudio(meta.url, signal);
      const ext = audio.ext || meta.ext || 'mp3';

      let base = sanitize(label);
      let fname = `${base}.${ext}`;
      let n = 1;
      while (usedNames.has(fname.toLowerCase())) fname = `${base} (${n++}).${ext}`;
      usedNames.add(fname.toLowerCase());
      fs.writeFileSync(path.join(targetDir, fname), audio.buf);

      const extras = await resolveMeta(tr, signal, cache, wantLyric, wantCover).catch(() => ({ lyric: '', cover: '' }));
      let extraFiles = 0;
      if (wantLyric && extras.lyric) {
        try { fs.writeFileSync(path.join(targetDir, `${base}.lrc`), extras.lyric, 'utf8'); extraFiles++; } catch { /* ignore */ }
      }
      if (wantCover && extras.cover) {
        try {
          const c = await getBuffer(extras.cover, { signal, timeout: 30000, retries: 1, referer: 'https://music.163.com/' });
          if (c.buf && c.buf.length > 4096) { fs.writeFileSync(path.join(targetDir, `${base}.jpg`), c.buf); extraFiles++; }
        } catch { /* ignore */ }
      }

      return {
        ok: true, name: label, source: tr.source, via: meta.from, br: meta.br || 0,
        bytes: audio.buf.length, ext, file: fname, extraFiles,
        matched: meta.matched && meta.matched.source !== tr.source ? meta.matched.source : '',
        lyric: !!extras.lyric, cover: !!extras.cover,
      };
    } catch (e) {
      return { ok: false, name: label, source: tr.source, reason: e.message };
    }
  }

  async function worker() {
    while (idx < tracks.length && !cancelled()) {
      const my = idx++;
      const tr = tracks[my];
      const res = await one(tr);
      results[my] = res;
      done++;
      if (res.ok) { okCount++; totalBytes += res.bytes; } else skipCount++;
      emit({
        type: 'track', done, total: tracks.length, ok: res.ok, name: res.name,
        source: res.source, via: res.via || '', br: res.br, bytes: res.bytes, ext: res.ext,
        reason: res.reason, matched: res.matched || '', lyric: !!res.lyric, cover: !!res.cover,
      });
      await sleep(120);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tracks.length) }, worker));

  const bitrateDistribution = {};
  const sourceDistribution = {};
  const viaDistribution = {};
  let lyricCount = 0;
  let coverCount = 0;
  for (const r of results) {
    if (!r || !r.ok) continue;
    const k = String(r.br || 0);
    bitrateDistribution[k] = (bitrateDistribution[k] || 0) + 1;
    sourceDistribution[r.source] = (sourceDistribution[r.source] || 0) + 1;
    viaDistribution[r.via || r.source] = (viaDistribution[r.via || r.source] || 0) + 1;
    if (r.lyric) lyricCount++;
    if (r.cover) coverCount++;
  }

  const summary = {
    title,
    total: tracks.length,
    success: okCount,
    skipped: skipCount,
    totalMB: +(totalBytes / 1048576).toFixed(1),
    outDir: targetDir,
    cancelled: cancelled(),
    bitrateDistribution,
    sourceDistribution,
    viaDistribution,
    lyricCount,
    coverCount,
    skippedList: results.filter((r) => r && !r.ok).map((r) => ({ name: r.name, source: r.source, reason: r.reason })),
  };

  try { fs.writeFileSync(path.join(targetDir, '_下载报告.json'), JSON.stringify(summary, null, 2), 'utf8'); } catch { /* ignore */ }
  if (summary.skippedList.length) {
    try {
      fs.writeFileSync(path.join(targetDir, '_跳过清单.txt'), summary.skippedList.map((x) => `${x.name}\t${x.reason}`).join('\n'), 'utf8');
    } catch { /* ignore */ }
  }
  emit({ type: 'done', summary });
  return summary;
}

/* ---------------- 连通性自检 ---------------- */

async function checkSources(signal) {
  const probe = { netease: '周杰伦', kuwo: '周杰伦', tencent: '晴天', kugou: '晴天', joox: 'adele', migu: '晴天' };
  return await mapLimit(SOURCE_IDS, 6, async (sid) => {
    const t0 = Date.now();
    try {
      const items = (await SOURCES[sid].search(probe[sid] || 'test', 3, signal)) || [];
      return {
        source: sid, label: SOURCES[sid].label, ok: items.length > 0, ms: Date.now() - t0,
        canDownload: !!SOURCES[sid].canDownload,
        note: items.length ? '' : '无结果（接口可能已失效）',
      };
    } catch (e) {
      return { source: sid, label: SOURCES[sid].label, ok: false, ms: Date.now() - t0, canDownload: !!SOURCES[sid].canDownload, note: e.message };
    }
  });
}

module.exports = { searchAll, resolveInput, downloadTracks, checkSources, resolveUrl, parseLink, SOURCE_LIST };
