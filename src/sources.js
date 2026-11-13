'use strict';
/* 平台适配器：每个源实现 search / url / lyric / pic / playlist / album 里它能做到的那几项。
 *
 * 能力矩阵（2026-11 实测，✅可用 ✖不可用 △不稳定/已失效）：
 *   网易云  search✅ url✅(128~FLAC) lyric✅ pic✅ playlist✅              ← GD 音乐台
 *   酷我    search✅ url✅(仅 mp3)   lyric✅ pic✅ playlist△(接口已废)      ← 官方直连
 *   QQ音乐  search✅ url✖(需登录)   lyric✅ pic✖ playlist✅ album✅        ← 搜索前端，下载靠补链
 *   酷狗    search✅ url✖(需签名)   lyric✅ pic✅ playlist✅               ← 搜索前端，下载靠补链
 *   JOOX    search✅ url✖           lyric✅ pic✅ playlist✖               ← GD 音乐台
 *   咪咕    search△ url✖           lyric✖ pic✖ playlist✖               ← 尽力而为
 *
 * ⚠️ 所有接口地址集中在 src/endpoints.js —— 平台改版导致失效时只改那个文件。
 *    自检：npm run check-api
 */
const crypto = require('crypto');
const { getText, getJson } = require('./http');
const { EP } = require('./endpoints');

const GD = EP.gd;

/* ---------------- 工具 ---------------- */

const decodeEntities = (s) => String(s || '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));

const stripTags = (s) => decodeEntities(String(s || '').replace(/<[^>]*>/g, ''));

const toArr = (v) => {
  if (Array.isArray(v)) return v.filter(Boolean).map((x) => (typeof x === 'string' ? x : (x && (x.name || x.singerName)) || '')).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return v.split(/[\/、,&]/).map((s) => s.trim()).filter(Boolean);
  return [];
};

const secToMs = (v) => {
  const n = Number(v) || 0;
  if (!n) return 0;
  return n > 100000 ? n : Math.round(n * 1000); // 有的源给毫秒，有的给秒
};

const track = (o) => ({
  key: `${o.source}:${o.id}`,
  source: o.source,
  id: String(o.id),
  name: String(o.name || '').trim(),
  artists: toArr(o.artists),
  album: String(o.album || '').trim(),
  duration: Math.round((o.durationMs || 0) / 1000),
  picUrl: o.picUrl || '',
  extra: o.extra || {},
});

/* ---------------- 网易云 / JOOX（GD 音乐台） ---------------- */

async function gdSearch(source, keyword, limit, signal) {
  const arr = await getJson(`${GD}?types=search&source=${source}&name=${encodeURIComponent(keyword)}&count=${Math.min(50, limit || 20)}&pages=1`, { signal, timeout: 20000 });
  if (!Array.isArray(arr)) return [];
  return arr.map((x) => track({
    source,
    id: x.id,
    name: stripTags(x.name),
    artists: toArr(x.artist),
    album: stripTags(x.album),
    durationMs: secToMs(x.duration || x.interval ? (typeof x.interval === 'number' ? x.interval : 0) : 0),
    extra: { urlId: x.url_id || x.id, lyricId: x.lyric_id || x.id, picId: x.pic_id || '' },
  }));
}

async function gdUrl(source, tr, br, signal) {
  const id = (tr.extra && tr.extra.urlId) || tr.id;
  const order = [...new Set([br || 320, 320, 192, 128])].filter((b) => b > 0);
  for (const b of order) {
    try {
      const j = await getJson(`${GD}?types=url&source=${source}&id=${encodeURIComponent(id)}&br=${b}`, { signal, timeout: 20000, retries: 1 });
      if (j && typeof j.url === 'string' && /^https?:\/\//.test(j.url)) {
        const ext = (j.url.split('?')[0].split('.').pop() || '').toLowerCase();
        return { url: j.url, br: j.br || b, size: j.size || 0, ext: ext.length <= 4 ? ext : '' };
      }
    } catch { /* 换档位 */ }
  }
  return null;
}

async function gdLyric(source, tr, signal) {
  const id = (tr.extra && tr.extra.lyricId) || tr.id;
  try {
    const j = await getJson(`${GD}?types=lyric&source=${source}&id=${encodeURIComponent(id)}`, { signal, timeout: 20000, retries: 1 });
    if (!j) return '';
    const raw = String(j.lyric || '');
    if (!raw.trim()) return '';
    const tl = String(j.tlyric || '');
    return tl.trim() ? `${raw}\n\n/* 中文翻译 */\n${tl}` : raw;
  } catch { return ''; }
}

async function gdPic(source, tr, signal) {
  if (tr.picUrl) return tr.picUrl;
  const id = (tr.extra && tr.extra.picId) || tr.id;
  try {
    const j = await getJson(`${GD}?types=pic&source=${source}&id=${encodeURIComponent(id)}`, { signal, timeout: 20000, retries: 1 });
    return (j && j.url) || '';
  } catch { return ''; }
}

async function gdPlaylist(source, id, signal) {
  const r = await getJson(`${GD}?types=playlist&source=${source}&id=${encodeURIComponent(id)}`, { signal, timeout: 25000 });
  if (!r || r.code !== 200 || !r.playlist) throw new Error('歌单解析失败（可能 ID 无效或该歌单未公开）');
  const p = r.playlist;
  const tracks = (p.tracks || []).map((t) => track({
    source,
    id: t.id,
    name: stripTags(t.name),
    artists: toArr(t.ar || t.artists),
    album: stripTags((t.al && t.al.name) || (t.album && t.album.name) || ''),
    durationMs: Number(t.dt) || 0,
    extra: { urlId: t.id, lyricId: t.id, picId: '' },
  }));
  return {
    kind: 'playlist',
    title: p.name || String(id),
    subtitle: [p.creator && p.creator.nickname, `${p.trackCount || tracks.length} 首`].filter(Boolean).join(' · '),
    source,
    total: p.trackCount || tracks.length,
    tracks,
  };
}

/* ---------------- 酷我（官方直连接口） ---------------- */

function kuwoItems(text) {
  const out = [];
  const chunks = String(text || '').split(/\}\s*,\s*\{/);
  for (const c of chunks) {
    const rid = (c.match(/'MUSICRID'\s*:\s*'(?:MUSIC_)?(\d+)'/) || [])[1];
    if (!rid) continue;
    const g = (k) => {
      const m = c.match(new RegExp(`'${k}'\\s*:\\s*'([^']*)'`));
      return m ? decodeEntities(m[1]) : '';
    };
    out.push({
      rid,
      name: stripTags(g('SONGNAME')),
      artist: stripTags(g('ARTIST')),
      album: stripTags(g('ALBUM')),
      durationMs: secToMs(g('DURATION')),
    });
  }
  return out;
}

function kuwoToTrack(x) {
  return track({
    source: 'kuwo',
    id: x.rid,
    name: x.name,
    artists: toArr(String(x.artist || '').replace(/&/g, '/')),
    album: x.album,
    durationMs: x.durationMs,
    extra: { rid: x.rid },
  });
}

async function kuwoSearch(keyword, limit, signal) {
  const txt = await getText(`${EP.kuwoSearch}?all=${encodeURIComponent(keyword)}&ft=music&itemset=web_2013&client=kt&pn=0&rn=${Math.min(60, limit || 20)}&rformat=json&encoding=utf8`, { signal, timeout: 20000 });
  return kuwoItems(txt).map(kuwoToTrack);
}

async function kuwoUrl(tr, signal) {
  const rid = (tr.extra && tr.extra.rid) || tr.id;
  const j = await getJson(`${EP.kuwoUrl}?type=convert_url3&rid=${encodeURIComponent(rid)}&format=mp3&response=url`, { signal, timeout: 20000, referer: 'http://www.kuwo.cn/' });
  const url = j && j.url;
  if (!url || !/^https?:/.test(url)) return null;
  return { url, br: 128, size: 0, ext: 'mp3' };
}

function lrcFromKuwo(list) {
  return (list || []).map((x) => {
    const t = Number(x.time) || 0;
    const mm = String(Math.floor(t / 60)).padStart(2, '0');
    const ss = (t % 60).toFixed(2).padStart(5, '0');
    return `[${mm}:${ss}]${x.lineLyric || ''}`;
  }).join('\n');
}

async function kuwoLyric(tr, signal) {
  const rid = (tr.extra && tr.extra.rid) || tr.id;
  try {
    const j = await getJson(`${EP.kuwoInfo}?musicId=${encodeURIComponent(rid)}&httpsStatus=1`, { signal, timeout: 20000, referer: 'http://m.kuwo.cn/', retries: 1 });
    if (j && j.data && Array.isArray(j.data.lrclist) && j.data.lrclist.length) return lrcFromKuwo(j.data.lrclist);
  } catch { /* 落到备用 */ }
  try {
    const j = await getJson(`${EP.kuwoInfoSsl}?musicId=${encodeURIComponent(rid)}&httpsStatus=1`, { signal, timeout: 20000, referer: 'https://m.kuwo.cn/', retries: 1 });
    if (j && j.data && Array.isArray(j.data.lrclist)) return lrcFromKuwo(j.data.lrclist);
  } catch { /* 无歌词 */ }
  return '';
}

async function kuwoPic(tr, signal) {
  if (tr.picUrl) return tr.picUrl;
  const rid = (tr.extra && tr.extra.rid) || tr.id;
  try {
    const j = await getJson(`${EP.kuwoInfo}?musicId=${encodeURIComponent(rid)}&httpsStatus=1`, { signal, timeout: 20000, referer: 'http://m.kuwo.cn/', retries: 1 });
    const pic = j && j.data && j.data.songinfo && j.data.songinfo.pic;
    if (pic) return pic;
  } catch { /* ignore */ }
  return '';
}

async function kuwoPlaylist(id, signal) {
  const j = await getJson(`${EP.kuwoPlaylist}?op=getlistinfo&pid=${encodeURIComponent(id)}&pn=0&rn=300&encode=utf8&keyset=pl2012&identity=pl2012&vipver=1&pcjson=1`, { signal, timeout: 25000 });
  const musiclist = (j && (j.musiclist || j.musicList)) || [];
  if (!musiclist.length) throw new Error('酷我歌单解析失败（ID 无效或歌单已失效）');
  const tracks = musiclist.map((x) => kuwoToTrack({
    rid: String(x.rid || x.id || '').replace('MUSIC_', ''),
    name: stripTags(x.name || x.songname),
    artist: stripTags(x.artist || x.artname || ''),
    album: stripTags(x.album || ''),
    durationMs: secToMs(x.duration || 0),
  })).filter((t) => t.id && t.name);
  return {
    kind: 'playlist',
    title: j.title || j.name || String(id),
    subtitle: [`${j.total || tracks.length} 首`, j.uname || j.nickname].filter(Boolean).join(' · '),
    source: 'kuwo',
    total: j.total || tracks.length,
    tracks,
  };
}

/* ---------------- QQ 音乐（搜索 + 歌词） ---------------- */

const QQ_REF = { referer: 'https://y.qq.com/' };

async function qqSearch(keyword, limit, signal) {
  const j = await getJson(`${EP.qqSearch}?format=json&key=${encodeURIComponent(keyword)}&g_tk=5381&loginUin=0&hostUin=0&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq&needNewCode=0`, { signal, timeout: 20000, ...QQ_REF });
  const list = (j && j.data && j.data.song && j.data.song.itemlist) || [];
  return list.slice(0, limit || 20).map((x) => track({
    source: 'tencent',
    id: x.mid,
    name: stripTags(x.name),
    artists: toArr(x.singer),
    album: '',
    durationMs: 0,
    extra: { mid: x.mid, docid: x.docid },
  }));
}

async function qqLyric(tr, signal) {
  const mid = (tr.extra && tr.extra.mid) || tr.id;
  try {
    const j = await getJson(`${EP.qqLyric}?songmid=${encodeURIComponent(mid)}&format=json&nobase64=0&g_tk=5381`, { signal, timeout: 20000, referer: 'https://y.qq.com/portal/player.html', retries: 1 });
    let lrc = (j && j.lyric) || '';
    if (lrc && !/\[/.test(lrc)) {
      try { lrc = Buffer.from(lrc, 'base64').toString('utf8'); } catch { /* 原样 */ }
    }
    return decodeEntities(lrc).replace(/<[^>]*>/g, '');
  } catch { return ''; }
}

async function qqPlaylist(id, signal) {
  const j = await getJson(`${EP.qqPlaylist}?type=1&json=1&utf8=1&onlysong=0&new_format=1&disstid=${encodeURIComponent(id)}&format=json&g_tk=5381&loginUin=0&hostUin=0&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq&needNewCode=0`, {
    signal, timeout: 25000, referer: 'https://y.qq.com/n/ryqq/playlist/' + id,
  });
  const cd = (j && j.cdlist && j.cdlist[0]) || null;
  if (!cd) throw new Error('QQ 音乐歌单解析失败（ID 无效、歌单私密，或接口已变更）');
  const tracks = (cd.songlist || []).map((s) => track({
    source: 'tencent',
    id: s.mid || s.songmid,
    name: stripTags(s.name || s.songname || s.title),
    artists: toArr(s.singer || s.singerList),
    album: stripTags((s.album && (s.album.name || s.album.title)) || s.albumname || ''),
    durationMs: Number(s.interval || 0) * 1000,
    extra: { mid: s.mid || s.songmid },
  })).filter((t) => t.id);
  return {
    kind: 'playlist', source: 'tencent',
    title: stripTags(cd.dissname || cd.diss_name || String(id)),
    subtitle: [cd.nickname, cd.songnum ? `${cd.songnum} 首` : `${tracks.length} 首`].filter(Boolean).join(' · '),
    total: Number(cd.songnum) || tracks.length,
    tracks,
  };
}

async function qqAlbum(albumMid, signal) {
  const j = await getJson(`${EP.qqAlbum}?albummid=${encodeURIComponent(albumMid)}&g_tk=5381&format=json&platform=yqq`, {
    signal, timeout: 25000, referer: 'https://y.qq.com/',
  });
  const d = j && j.data;
  if (!d) throw new Error('QQ 音乐专辑解析失败（albummid 无效或接口已变更）');
  const tracks = (d.list || []).map((s) => track({
    source: 'tencent',
    id: s.songmid,
    name: stripTags(s.songname),
    artists: toArr(s.singer),
    album: stripTags(d.name || ''),
    durationMs: Number(s.interval || 0) * 1000,
    extra: { mid: s.songmid },
  })).filter((t) => t.id);
  return {
    kind: 'album', source: 'tencent',
    title: stripTags(d.name || albumMid),
    subtitle: [stripTags(d.singername || (d.singer && d.singer[0] && d.singer[0].name) || ''), `${tracks.length} 首`].filter(Boolean).join(' · '),
    total: tracks.length,
    tracks,
  };
}

/* QQ 直链。
 * 实测结论（2026-11）：**没有登录态拿不到全曲**。所有正片音质（M800/C600/F000…）
 * 都返回 errtype=104003；唯一能给 purl 的 RS01/RS02 前缀是 **60 秒试听**
 * （不同歌曲返回等长文件，见测试记录），绝不能当正片保存。
 * 所以：只接受正片前缀 + 有 purl，否则返回 null 交给「跨平台补链」。 */
const QQ_FULL_PREFIX = { M800: ['.mp3', 320], C600: ['.m4a', 320], M500: ['.mp3', 128], C400: ['.m4a', 128], F000: ['.flac', 900] };
const QQ_PREVIEW_PREFIX = ['RS01', 'RS02', 'A000', 'Q000', 'O800']; // 试听/占位，直接拒绝

async function qqUrl(tr, signal) {
  const mid = (tr.extra && tr.extra.mid) || tr.id;
  const uin = (tr.extra && tr.extra.uin) || '0';
  for (const [prefix, [ext, br]] of Object.entries(QQ_FULL_PREFIX)) {
    try {
      const body = {
        loginUin: uin,
        comm: { uin, format: 'json', ct: 24, cv: 0, platform: 'yqq' },
        req_1: {
          module: 'vkey.GetVkeyServer', method: 'CgiGetVkey',
          param: { filename: [`${prefix}${mid}${ext}`], guid: '10000', songmid: [mid], songtype: [0], uin, loginflag: 1, platform: '20' },
        },
      };
      const j = await getJson(EP.qqVkey, {
        signal, timeout: 20000, retries: 1, method: 'POST', body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', Origin: 'https://y.qq.com' }, referer: 'https://y.qq.com/',
      });
      const sip = (j && j.req_1 && j.req_1.data && j.req_1.data.sip && j.req_1.data.sip[0]) || '';
      const purl = (j && j.req_1 && j.req_1.data && j.req_1.data.midurlinfo && j.req_1.data.midurlinfo[0] && j.req_1.data.midurlinfo[0].purl) || '';
      if (!purl) continue;
      /* 二次保险：purl 前缀落在试听名单里就丢掉 */
      if (QQ_PREVIEW_PREFIX.some((p) => purl.startsWith(p))) continue;
      return { url: sip + purl, br, size: 0, ext: ext.slice(1) };
    } catch { /* 试下一个音质 */ }
  }
  return null;
}

/* ---------------- 酷狗（搜索 + 歌词 + 封面） ---------------- */

async function kugouSearch(keyword, limit, signal) {
  const n = Math.min(30, limit || 20);
  const j = await getJson(`${EP.kugouSearch}?keyword=${encodeURIComponent(keyword)}&page=1&pagesize=${n}&platform=WebFilter&userid=-1&clientver=2000&iscorrection=1&privilege_filter=0&filter=10`, { signal, timeout: 20000 });
  const list = (j && j.data && (j.data.lists || j.data.info)) || [];
  return list.map((x) => {
    const hash = String(x.FileHash || x.hash || '').toUpperCase();
    const img = x.Image || x.image || '';
    return track({
      source: 'kugou',
      id: hash,
      name: stripTags(x.SongName || x.songname),
      artists: toArr(x.SingerName || x.singername),
      album: stripTags(x.AlbumName || x.album_name || ''),
      durationMs: Number(x.Duration || x.duration) || 0,
      picUrl: img ? String(img).replace('{size}', '480') : '',
      extra: { hash, albumId: x.AlbumID || x.album_id, mixsongid: x.MixSongID },
    });
  }).filter((t) => t.id);
}

async function kugouUrl(tr, signal) {
  const hash = ((tr.extra && tr.extra.hash) || tr.id || '').toLowerCase();
  const albumId = (tr.extra && tr.extra.albumId) || '';
  if (!hash) return null;
  try {
    const key = crypto.createHash('md5').update(hash + 'kgcloudv2').digest('hex');
    const j = await getJson(`${EP.kugouTrackercdn}?appid=1005&pid=2&cmd=25&behavior=play&hash=${hash}&key=${key}&br=hq`, { signal, timeout: 20000, retries: 1 });
    const urls = (j && (j.url || j.urls)) || [];
    const first = Array.isArray(urls) ? urls[0] : urls;
    if (first) return { url: first, br: 320, size: 0, ext: '' };
  } catch { /* 试 web 接口 */ }
  /* 方案二：m.kugou 移动端接口（社区通用做法，社区里 Listen1 用的就是它）。
   * 它是活的——对免费歌直接返回 url；对付费歌返回 errcode「需要付费」，
   * 这时我们如实返回 null，交给「跨平台补链」，绝不拿残缺音频充数。 */
  try {
    const j = await getJson(`${EP.kugouSongInfo}?cmd=playInfo&hash=${hash}&appid=1005`, {
      signal, timeout: 20000, retries: 1, referer: 'https://m.kugou.com/',
      ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
    const u = (j && (j.url || j.play_url)) || '';
    if (/^https?:\/\//.test(u)) return { url: u, br: Number(j.bitRate) || 128, size: Number(j.fileSize) || 0, ext: String(j.extName || '').replace('.', '') || 'mp3' };
  } catch { /* 试 web 接口 */ }
  try {
    const mid = crypto.createHash('md5').update(String(Date.now())).digest('hex');
    const j = await getJson(`${EP.kugouApi}?r=play/getdata&hash=${hash}&album_id=${albumId}&mid=${mid}&platid=4&_=${Date.now()}`, { signal, timeout: 20000, retries: 1, referer: 'https://www.kugou.com/', headers: { Cookie: `kg_mid=${mid}` } });
    const u = j && j.data && j.data.play_url;
    if (u) return { url: u, br: 128, size: 0, ext: '' };
  } catch { /* 放弃 */ }
  return null;
}

async function kugouLyric(tr, signal) {
  const hash = ((tr.extra && tr.extra.hash) || tr.id || '').toLowerCase();
  if (!hash) return '';
  try {
    const dur = (tr.duration ? tr.duration * 1000 : 0) + '';
    const s = await getJson(`${EP.kugouLyricSearch}?ver=1&man=yes&client=mobi&keyword=&duration=${dur}&hash=${hash}`, { signal, timeout: 20000, retries: 1 });
    const c = s && s.candidates && s.candidates[0];
    if (!c) return '';
    const d = await getJson(`${EP.kugouLyricDown}?ver=1&client=pc&id=${c.id}&accesskey=${encodeURIComponent(c.accesskey)}&fmt=lrc&charset=utf8`, { signal, timeout: 20000, retries: 1 });
    if (d && d.content) return Buffer.from(d.content, 'base64').toString('utf8');
  } catch { /* 无 */ }
  return '';
}

async function kugouPlaylist(id, signal) {
  const j = await getJson(`${EP.kugouPlaylist}?specialid=${encodeURIComponent(id)}&page=1&pagesize=100&version=8000`, { signal, timeout: 25000 });
  const info = (j && j.data && j.data.info) || [];
  if (!info.length) throw new Error('酷狗歌单解析失败（ID 无效、歌单为空，或接口已变更）');
  const tracks = info.map((x) => {
    const hash = String(x.hash || '').toUpperCase();
    const rawName = stripTags(x.songname || x.filename || '');
    const parts = rawName.split(' - ');
    const name = parts.length > 1 ? parts.slice(1).join(' - ') : rawName;
    const singer = stripTags(x.singername || (parts.length > 1 ? parts[0] : ''));
    return track({
      source: 'kugou',
      id: hash,
      name,
      artists: toArr(singer),
      album: stripTags(x.album_name || ''),
      durationMs: Number(x.duration || 0) * 1000,
      extra: { hash, albumId: x.album_id },
    });
  }).filter((t) => t.id);
  return {
    kind: 'playlist', source: 'kugou',
    title: stripTags((j.data && (j.data.specialname || j.data.special_name)) || String(id)),
    subtitle: [`${(j.data && j.data.total) || tracks.length} 首`, stripTags((j.data && j.data.nickname) || '')].filter(Boolean).join(' · '),
    total: (j.data && j.data.total) || tracks.length,
    tracks,
  };
}

/* ---------------- 咪咕（尽力而为） ---------------- */

async function miguSearch(keyword, limit, signal) {
  const j = await getJson(`${EP.miguSearch}?text=${encodeURIComponent(keyword)}&pageNo=1&pageSize=${Math.min(30, limit || 20)}&searchSwitch=${encodeURIComponent('{"song":1}')}`, { signal, timeout: 20000, referer: 'https://app.c.nf.migu.cn/' });
  const list = (j && j.songResultData && j.songResultData.resultList) || [];
  return list.map((x) => track({
    source: 'migu',
    id: x.copyrightId || x.id,
    name: stripTags(x.name || x.songName),
    artists: toArr((x.singerList || []).map((s) => s.name)),
    album: stripTags((x.album || x.albums && x.albums[0] && x.albums[0].name) || ''),
    durationMs: secToMs(x.duration || 0),
    picUrl: (x.img3 || x.img2 || x.img1 || '') ? String(x.img3 || x.img2 || x.img1).replace(/^http:/, 'https:') : '',
    extra: { copyrightId: x.copyrightId || x.id },
  })).filter((t) => t.id);
}

/* 网易云直链：**官方免登录接口优先**，GD 音乐台只作备用。
 * 这样 GD 抽风（实测会间歇性 aborted / fetch timeout）不会拖垮网易云下载。 */
async function neteaseUrl(tr, br, signal) {
  const id = tr.id;
  const order = [...new Set([(br || 320) * 1000, 320000, 192000, 128000])].filter((b) => b >= 128000);
  for (const bps of order) {
    try {
      const j = await getJson(`${EP.neteaseUrl}?ids=[${encodeURIComponent(id)}]&br=${bps}`, {
        signal, timeout: 20000, retries: 1, referer: 'https://music.163.com/',
        headers: { Cookie: 'os=pc; appver=9.0.0' },
      });
      const d = j && j.data && j.data[0];
      /* code=200 且有 url 才算成功；code=404 表示这首歌这一档拿不到 */
      if (d && d.code === 200 && /^https?:\/\//.test(d.url || '')) {
        return {
          url: d.url,
          br: Math.round((Number(d.br) || bps) / 1000),
          size: Number(d.size) || 0,
          ext: (String(d.type || '').toLowerCase().replace('mp3', 'mp3')) || 'mp3',
        };
      }
    } catch { /* 换下一档 */ }
  }
  /* 备用：走 GD 音乐台 */
  return gdUrl('netease', tr, br, signal);
}

/* ---------------- 网易云：官方接口（不依赖任何第三方中转） ---------------- */
/* 这是一套**完全独立**的通路：搜索、直链、歌词、封面、歌单全走 music.163.com，
 * 只要网易云自己不挂，它就不受 GD 音乐台抽风影响。 */

const NETEASE_HDR = { Cookie: 'os=pc; appver=9.0.0; deviceId=windtune' };

async function neteaseSearch(keyword, limit, signal) {
  const n = Math.min(50, limit || 20);
  const j = await getJson(`${EP.neteaseSearch}?csrf_token=&s=${encodeURIComponent(keyword)}&type=1&offset=0&total=true&limit=${n}`, {
    signal, timeout: 20000, retries: 1, referer: 'https://music.163.com/', headers: NETEASE_HDR,
  });
  const songs = (j && j.result && j.result.songs) || [];
  return songs.map((x) => track({
    source: 'netease',
    id: x.id,
    name: stripTags(x.name),
    artists: toArr((x.artists || x.ar || []).map((a) => a.name)),
    album: stripTags((x.album && x.album.name) || (x.al && x.al.name) || ''),
    durationMs: Number(x.duration || x.dt) || 0,
    picUrl: (x.album && x.album.picUrl) || (x.al && x.al.picUrl) || '',
    extra: {},
  })).filter((t) => t.id);
}

async function neteaseLyric(tr, signal) {
  try {
    const j = await getJson(`${EP.neteaseLyric}?id=${encodeURIComponent(tr.id)}&lv=-1&kv=-1&tv=-1`, {
      signal, timeout: 20000, retries: 1, referer: 'https://music.163.com/', headers: NETEASE_HDR,
    });
    const raw = String((j && j.lrc && j.lrc.lyric) || '');
    const tl = String((j && j.tlyric && j.tlyric.lyric) || '');
    if (!raw.trim()) return '';
    return tl.trim() ? `${raw}\n\n/* 中文翻译 */\n${tl}` : raw;
  } catch { return ''; }
}

async function neteasePic(tr, signal) {
  if (tr.picUrl) return tr.picUrl;
  try {
    const j = await getJson(`${EP.neteaseDetail}?ids=[${encodeURIComponent(tr.id)}]`, {
      signal, timeout: 20000, retries: 1, referer: 'https://music.163.com/', headers: NETEASE_HDR,
    });
    const s = j && j.songs && j.songs[0];
    return (s && s.album && s.album.picUrl) || '';
  } catch { return ''; }
}

async function neteasePlaylist(id, signal) {
  const j = await getJson(`${EP.neteasePlaylist}?id=${encodeURIComponent(id)}&n=1000`, {
    signal, timeout: 25000, referer: 'https://music.163.com/', headers: NETEASE_HDR,
  });
  const p = j && j.playlist;
  if (!p) throw new Error('歌单解析失败（可能 ID 无效或该歌单未公开）');
  const tracks = (p.tracks || []).map((t) => track({
    source: 'netease',
    id: t.id,
    name: stripTags(t.name),
    artists: toArr((t.ar || t.artists || []).map((a) => a.name)),
    album: stripTags((t.al && t.al.name) || (t.album && t.album.name) || ''),
    durationMs: Number(t.dt) || 0,
    picUrl: (t.al && t.al.picUrl) || (t.album && t.album.picUrl) || '',
    extra: {},
  })).filter((t) => t.id);
  return {
    kind: 'playlist',
    source: 'netease',
    title: p.name || String(id),
    subtitle: [(p.creator && p.creator.nickname) || '', `${p.trackCount || tracks.length} 首`].filter(Boolean).join(' · '),
    total: p.trackCount || tracks.length,
    tracks,
  };
}

/* ---------------- 源注册表 ---------------- */

const SOURCES = {
  netease: {
    id: 'netease', label: '网易云', color: '#e93b3b', canDownload: true,
    search: neteaseSearch,
    url: neteaseUrl,
    lyric: neteaseLyric,
    pic: neteasePic,
    playlist: neteasePlaylist,
    matchUrl: (id, sig) => `https://music.163.com/#/playlist?id=${id}`,
  },
  kuwo: {
    id: 'kuwo', label: '酷我', color: '#f5a623', canDownload: true,
    search: kuwoSearch, url: kuwoUrl, lyric: kuwoLyric, pic: kuwoPic, playlist: kuwoPlaylist,
    matchUrl: (id, sig) => `https://www.kuwo.cn/playlist_detail/${id}`,
  },
  tencent: {
    id: 'tencent', label: 'QQ音乐', color: '#31c27c', canDownload: false,
    search: qqSearch, url: qqUrl, lyric: qqLyric,
    playlist: qqPlaylist, album: qqAlbum,
    matchUrl: (id) => `https://y.qq.com/n/ryqq/playlist/${id}`,
  },
  kugou: {
    id: 'kugou', label: '酷狗', color: '#2ba8f0', canDownload: false,
    search: kugouSearch, url: kugouUrl, lyric: kugouLyric, playlist: kugouPlaylist,
    matchUrl: (id) => `https://www.kugou.com/yy/special/single/${id}.html`,
  },
  joox: {
    id: 'joox', label: 'JOOX', color: '#00b26b', canDownload: false,
    search: (kw, n, sig) => gdSearch('joox', kw, n, sig),
    lyric: (tr, sig) => gdLyric('joox', tr, sig),
    pic: (tr, sig) => gdPic('joox', tr, sig),
    url: async () => null,
  },
  migu: {
    id: 'migu', label: '咪咕', color: '#ff6a00', canDownload: false,
    search: miguSearch,
    url: async () => null,
  },
};

const SOURCE_IDS = Object.keys(SOURCES);
const SOURCE_LIST = SOURCE_IDS.map((id) => ({ id, label: SOURCES[id].label, color: SOURCES[id].color, canDownload: !!SOURCES[id].canDownload }));

module.exports = { SOURCES, SOURCE_IDS, SOURCE_LIST, track, decodeEntities, stripTags, toArr };
