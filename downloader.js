'use strict';
/* 兼容层：保留 1.x 的 parsePlaylist / downloadPlaylist 入口（老的调用方式仍能用），
 * 内部全部转到 src/engine.js 的多平台引擎。新代码直接用 src/engine.js。 */
const engine = require('./src/engine');

const BASE = 'https://music-api.gdstudio.xyz/api.php';

/** 从链接/纯数字里抠出 ID（旧版行为：网易云歌单 ID） */
function extractId(input) {
  const link = engine.parseLink(input);
  if (link) return link.id;
  const m = String(input || '').trim().match(/(\d{5,})/);
  return m ? m[1] : null;
}

/** 旧接口：解析歌单 -> { id, name, trackCount, returned, creator, tracks:[{id,name,artists,fee}] } */
async function parsePlaylist(input) {
  const col = await engine.resolveInput({ input: String(input || '') }, null);
  if (col.kind !== 'playlist') throw new Error('这不是一个可解析的歌单链接');
  return {
    id: engine.parseLink(input) ? engine.parseLink(input).id : '',
    name: col.title,
    trackCount: col.total,
    returned: col.tracks.length,
    creator: (col.subtitle || '').split(' · ')[0] || '',
    tracks: col.tracks.map((t) => ({ id: t.id, name: t.name, artists: t.artists.join(','), fee: 0, __track: t })),
  };
}

/** 旧接口：下载整个歌单 */
async function downloadPlaylist(opts, onProgress, signal) {
  const col = await engine.resolveInput({ input: opts.id || opts.input }, signal);
  if (!col.tracks.length) throw new Error('歌单里没有可下载的歌曲');
  return engine.downloadTracks({
    tracks: col.tracks,
    outDir: opts.outDir,
    title: col.title,
    br: opts.br,
    fallback: opts.fallback !== false,
    concurrency: opts.concurrency,
    saveLyric: opts.saveLyric !== false,
    saveCover: opts.saveCover !== false,
  }, onProgress, signal);
}

module.exports = { parsePlaylist, downloadPlaylist, extractId, BASE, engine };
