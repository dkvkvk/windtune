'use strict';
/**
 * 接口体检：把 src/endpoints.js 里每条接口真跑一遍。
 *
 *   npm run check-api            普通体检
 *   npm run check-api -- --json  机器可读输出
 *
 * 退出码：0 = 至少有一条下载链路可用；1 = 两条下载链路都死了（软件等于下不了歌）
 *
 * 状态含义：
 *   OK         正常
 *   EMPTY      接口活着但返回空（可能被风控/地区限制）
 *   DEAD       接口失效（连接失败 / 结构变了 / 明确报错）
 *   KNOWN      已知不可用（不是故障，是本项目的已知限制，比如 VIP 直链要登录）
 */

const { EP } = require('../src/endpoints');
const { getJson } = require('../src/http');

const SIG = { cancelled: false };
const log = [];
const C = process.stdout.isTTY
  ? { ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
  : { ok: '', bad: '', warn: '', dim: '', b: '', x: '' };

function pick(arr) {
  return Array.isArray(arr) && arr.length ? arr[0] : null;
}

/* ------------------------------------------------------------------ */
/* 每个检查项：{ name, ep, impact, run() -> {status, detail} }          */
/* ------------------------------------------------------------------ */

const CHECKS = [
  /* ---------------- 网易云：官方接口（不依赖 GD） ---------------- */
  {
    group: '网易云', ep: 'neteaseSearch', impact: '网易云搜索',
    async run() {
      const { SOURCES } = require('../src/sources');
      const l = await SOURCES.netease.search('起风了', 10, SIG);
      return l.length ? { status: 'OK', detail: `${l.length} 条 · ${l[0].name}/${l[0].artists[0]}` } : { status: 'EMPTY', detail: '返回空' };
    },
  },
  {
    group: '网易云', ep: 'neteaseUrl', impact: '★下载（主后端，免登录）', critical: true,
    async run() {
      const { SOURCES } = require('../src/sources');
      const l = await SOURCES.netease.search('起风了', 5, SIG);
      const t = l[0];
      if (!t) return { status: 'EMPTY', detail: '搜不到歌，无法测直链' };
      for (const bps of [320000, 192000, 128000]) {
        try {
          const j = await getJson(`${EP.neteaseUrl}?ids=[${t.id}]&br=${bps}`, { signal: SIG, timeout: 20000, referer: 'https://music.163.com/', headers: { Cookie: 'os=pc; appver=9.0.0; deviceId=windtune' } });
          const d = j && j.data && j.data[0];
          if (d && d.code === 200 && /^https?:\/\//.test(d.url || '')) return { status: 'OK', detail: `${Math.round(d.br / 1000)}k · ${Math.round((d.size || 0) / 1048576 * 10) / 10}MB` };
        } catch { /* 试下一档 */ }
      }
      return { status: 'DEAD', detail: '三档音质都取不到直链' };
    },
  },
  {
    group: '网易云', ep: 'neteaseLyric', impact: '歌词 / 封面',
    async run() {
      const { SOURCES } = require('../src/sources');
      const l = await SOURCES.netease.search('起风了', 5, SIG);
      const t = l[0];
      if (!t) return { status: 'EMPTY', detail: '搜不到歌' };
      const hdr = { Cookie: 'os=pc; appver=9.0.0; deviceId=windtune' };
      const lyr = await getJson(`${EP.neteaseLyric}?id=${t.id}&lv=-1&kv=-1&tv=-1`, { signal: SIG, timeout: 20000, referer: 'https://music.163.com/', headers: hdr });
      const det = await getJson(`${EP.neteaseDetail}?ids=[${t.id}]`, { signal: SIG, timeout: 20000, referer: 'https://music.163.com/', headers: hdr });
      const hasL = !!(lyr && lyr.lrc && String(lyr.lrc.lyric || '').trim());
      const hasP = !!(det && det.songs && det.songs[0] && det.songs[0].album && det.songs[0].album.picUrl);
      if (hasL && hasP) return { status: 'OK', detail: '歌词 + 封面都有' };
      return { status: 'EMPTY', detail: `歌词${hasL ? '有' : '无'} / 封面${hasP ? '有' : '无'}` };
    },
  },
  {
    group: '网易云', ep: 'neteasePlaylist', impact: '歌单解析',
    async run() {
      /* 走真正的解析函数（以前只验接口原始返回，软件里解析挂了照样显示绿灯） */
      const { SOURCES } = require('../src/sources');
      const r = await SOURCES.netease.playlist('3778678', SIG);
      const n = (r && r.tracks || []).length;
      return n > 0 ? { status: 'OK', detail: `${n} 首 · ${r.title || ''}` } : { status: 'EMPTY', detail: '解析出 0 首' };
    },
  },

  /* ---------------- GD 音乐台（现在只剩 JOOX 依赖它） ---------------- */
  {
    group: 'GD 音乐台', ep: 'gd', impact: 'JOOX 歌词 / 歌单', known: true,
    async run() {
      const j = await getJson(`${EP.gd}?types=search&source=joox&name=${encodeURIComponent('晴天')}&count=3&pages=1`, { signal: SIG, timeout: 20000 });
      const n = Array.isArray(j) ? j.length : 0;
      return n ? { status: 'OK', detail: `${n} 条（JOOX 歌词/歌单可用）` } : { status: 'EMPTY', detail: '返回空（只影响 JOOX 歌词与歌单，搜索/下载全都不受影响）' };
    },
  },
  {
    group: 'JOOX', ep: 'jooxSearch', impact: 'JOOX 搜索 / 封面',
    async run() {
      const j = await getJson(`${EP.jooxSearch}?country=hk&lang=zh_TW&key=${encodeURIComponent('晴天 周杰伦')}&type=0`, {
        signal: SIG, timeout: 20000, retries: 1,
        headers: { origin: 'http://www.joox.com', referer: 'http://www.joox.com', cookie: 'wmid=142420656; user_type=1; country=hk; session_key=2a5d97d05dc8fe238150184eaf3519ad; uid=142420656; backendCountry=hk' },
      });
      const list = (j && j.tracks) || [];
      return list.length ? { status: 'OK', detail: `${list.length} 条（官方接口，不依赖 GD）` } : { status: 'EMPTY', detail: '返回空' };
    },
  },

  /* ---------------- 酷我 ---------------- */
  {
    group: '酷我', ep: 'kuwoSearch', impact: '酷我搜索',
    async run() {
      const txt = await require('../src/http').getText(`${EP.kuwoSearch}?all=${encodeURIComponent('晴天')}&ft=music&itemset=web_2013&client=kt&pn=0&rn=3&rformat=json&encoding=utf8`, { signal: SIG, timeout: 20000 });
      const n = (String(txt).match(/'MUSICRID'/g) || []).length;
      return n ? { status: 'OK', detail: `${n} 条` } : { status: 'EMPTY', detail: '解析不到曲目（结构可能变了）' };
    },
  },
  {
    group: '酷我', ep: 'bodianUrl', impact: '★下载（320k / FLAC）', critical: true,
    async run() {
      /* 波点音乐：先领「看广告」豁免，再按 FLAC → 320k → 128k 取流 */
      const { bodianSign } = require('../src/sources');
      const H = {
        'user-agent': 'Dart/2.19 (dart:io)', plat: 'ar', channel: 'aliopen',
        devid: String(Math.floor(Math.random() * 1e11)), ver: '3.9.0', host: 'bd-api.kuwo.cn',
      };
      try {
        await getJson(`${EP.bodianAd}?uid=-1&token=&timestamp=1724306124436&sign=15a676d66285117ad714e8c8371691da`, {
          signal: SIG, timeout: 15000, method: 'POST',
          headers: { ...H, qimei36: '1e9970cbcdc20a031dee9f37100017e1840e', 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ type: 5, subType: 5, musicId: 0, adToken: '' }),
        });
      } catch { /* 豁免失败也要继续测 */ }
      for (const [br, kbps] of [['2000kflac', 'FLAC'], ['320kmp3', '320k'], ['128kmp3', '128k']]) {
        try {
          const j = await getJson(bodianSign(`${EP.bodianUrl}?&br=${br}&musicId=440614`), {
            signal: SIG, timeout: 20000, retries: 1,
            headers: { ...H, 'X-Forwarded-For': '1.0.1.114' },
          });
          const url = j && j.data && j.data.audioUrl;
          if (url) return { status: 'OK', detail: `${kbps} 直链 · ${(url.split('?')[0].split('.').pop() || '').slice(0, 4)}` };
        } catch { /* 试下一档 */ }
      }
      return { status: 'DEAD', detail: '三档都取不到（可能豁免没领到或被风控）' };
    },
  },
  {
    group: '酷我', ep: 'kuwoUrl', impact: '酷我备用直链（anti.s）',
    async run() {
      const j = await getJson(`${EP.kuwoUrl}?type=convert_url3&rid=440614&format=mp3&response=url`, { signal: SIG, timeout: 20000, referer: 'http://www.kuwo.cn/' });
      return (j && /^https?:/.test(j.url || '')) ? { status: 'OK', detail: 'mp3 直链（128k，比波点低两档）' } : { status: 'DEAD', detail: '没返回 url' };
    },
  },
  {
    group: '酷我', ep: 'kuwoInfo', impact: '酷我歌词 / 封面',
    async run() {
      const j = await getJson(`${EP.kuwoInfo}?musicId=440614&httpsStatus=1`, { signal: SIG, timeout: 20000, referer: 'http://m.kuwo.cn/' });
      const lrc = j && j.data && j.data.lrclist;
      const pic = j && j.data && j.data.songinfo && j.data.songinfo.pic;
      if (Array.isArray(lrc) && lrc.length) return { status: 'OK', detail: `${lrc.length} 行歌词${pic ? ' + 封面' : ''}` };
      return { status: 'EMPTY', detail: '无歌词结构' };
    },
  },
  {
    group: '酷我', ep: 'kuwoPlaylist', impact: '酷我歌单', known: true,
    async run() {
      const j = await getJson(`${EP.kuwoPlaylist}?op=getlistinfo&pid=2847082672&pn=0&rn=300&encode=utf8&keyset=pl2012&identity=pl2012&vipver=1&pcjson=1`, { signal: SIG, timeout: 20000 });
      const n = (j && (j.musiclist || j.musicList) || []).length;
      return n ? { status: 'OK', detail: `${n} 首（已恢复！）` } : { status: 'KNOWN', detail: '仍返回 total:0（本版已知限制）' };
    },
  },

  /* ---------------- QQ 音乐 ---------------- */
  {
    group: 'QQ音乐', ep: 'qqSearch', impact: 'QQ 搜索',
    async run() {
      const { SOURCES } = require('../src/sources');
      const l = await SOURCES.tencent.search('晴天 周杰伦', 10, SIG);
      if (!l.length) return { status: 'EMPTY', detail: '返回空（可能被限流，code=2001）' };
      const degraded = !l[0].album;   // 降级到联想接口时没有专辑/时长
      return { status: 'OK', detail: `${l.length} 条 · ${l[0].name}/${l[0].artists[0]}${degraded ? '（被限流，已降级联想接口）' : ''}` };
    },
  },
  {
    group: 'QQ音乐', ep: 'qqPlaylist', impact: 'QQ 歌单解析',
    async run() {
      const { SOURCES } = require('../src/sources');
      const r = await SOURCES.tencent.playlist('7138573358', SIG);
      const n = (r && r.tracks || []).length;
      return n > 0 ? { status: 'OK', detail: `${n} 首 · ${r.title || ''}` } : { status: 'EMPTY', detail: '解析出 0 首' };
    },
  },
  {
    group: 'QQ音乐', ep: 'qqAlbum', impact: 'QQ 专辑解析',
    async run() {
      const j = await getJson(`${EP.qqAlbum}?albummid=002mGsM62gHnX9&g_tk=5381&format=json&platform=yqq`, { signal: SIG, timeout: 25000, referer: 'https://y.qq.com/' });
      const n = (j && j.data && (j.data.list || []).length) || 0;
      return n ? { status: 'OK', detail: `${n} 首 · ${(j.data && j.data.name) || ''}` } : { status: 'DEAD', detail: 'data.list 为空' };
    },
  },
  {
    group: 'QQ音乐', ep: 'qqLyric', impact: 'QQ 歌词',
    async run() {
      const j = await getJson(`${EP.qqLyric}?songmid=0039MnYb0qxYhV&format=json&nobase64=0&g_tk=5381`, { signal: SIG, timeout: 20000, referer: 'https://y.qq.com/portal/player.html' });
      const lyr = j && (j.lyric || '');
      return lyr ? { status: 'OK', detail: `${String(lyr).length} 字符` } : { status: 'EMPTY', detail: '无歌词' };
    },
  },
  {
    group: 'QQ音乐', ep: 'qqVkey', impact: 'QQ 直链', known: true,
    async run() {
      const mid = '0039MnYb0qxYhV';
      const body = {
        comm: { uin: '0', format: 'json', ct: 19, cv: 1859, platform: 'yqq', needNewCode: 1 },
        req_1: { module: 'vkey.GetVkeyServer', method: 'CgiGetVkey', param: { filename: [`C400${mid}.m4a`], guid: '10000', songmid: [mid], songtype: [0], uin: '0', loginflag: 1, platform: '20' } },
      };
      const j = await getJson(EP.qqVkey, { signal: SIG, timeout: 20000, method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', Origin: 'https://y.qq.com' }, referer: 'https://y.qq.com/' });
      const purl = j && j.req_1 && j.req_1.data && j.req_1.data.midurlinfo && j.req_1.data.midurlinfo[0] && j.req_1.data.midurlinfo[0].purl;
      return purl ? { status: 'OK', detail: '拿到 purl（可直连下载！）' } : { status: 'KNOWN', detail: 'purl 为空 = 需登录（实测唯一能拿到 purl 的 RS02 前缀是 60 秒试听，已主动拒绝），走补链（设计如此）' };
    },
  },

  /* ---------------- 酷狗 ---------------- */
  {
    group: '酷狗', ep: 'kugouSearch', impact: '酷狗搜索',
    async run() {
      const j = await getJson(`${EP.kugouSearch}?keyword=${encodeURIComponent('晴天')}&page=1&pagesize=3&platform=WebFilter&userid=-1&clientver=2000&iscorrection=1&privilege_filter=0&filter=10`, { signal: SIG, timeout: 20000 });
      const list = (j && j.data && (j.data.lists || j.data.info)) || [];
      return list.length ? { status: 'OK', detail: `${list.length} 条` } : { status: 'EMPTY', detail: '返回空' };
    },
  },
  {
    group: '酷狗', ep: 'kugouPlaylist', impact: '酷狗歌单解析',
    async run() {
      const { SOURCES } = require('../src/sources');
      const r = await SOURCES.kugou.playlist('2338764', SIG);
      const n = (r && r.tracks || []).length;
      return n > 0 ? { status: 'OK', detail: `${n} 首 · ${r.title || ''}` } : { status: 'EMPTY', detail: '解析出 0 首' };
    },
  },
  {
    group: '酷狗', ep: 'kugouLyricSearch', impact: '酷狗歌词',
    async run() {
      const j = await getJson(`${EP.kugouLyricSearch}?ver=1&man=yes&client=mobi&keyword=&duration=269000&hash=9C4D3E8D9AE39C2B5F5F8E7A2B1C0D3E`, { signal: SIG, timeout: 20000 });
      const c = j && j.candidates && j.candidates[0];
      if (!c) return { status: 'EMPTY', detail: '无候选（hash 可能已过期）' };
      const d = await getJson(`${EP.kugouLyricDown}?ver=1&client=pc&id=${c.id}&accesskey=${encodeURIComponent(c.accesskey)}&fmt=lrc&charset=utf8`, { signal: SIG, timeout: 20000 });
      return (d && d.content) ? { status: 'OK', detail: '歌词可取' } : { status: 'EMPTY', detail: '下载为空' };
    },
  },
  {
    group: '酷狗', ep: 'kugouSongInfo', impact: '酷狗直链', known: true,
    async run() {
      /* 用社区通用接口（Listen1 同款）取一首，看能否拿到 url */
      const j = await getJson(`${EP.kugouSongInfo}?cmd=playInfo&hash=B3A52A7A958BF0AED0EBFBA2E9A818B7&appid=1005`, {
        signal: SIG, timeout: 20000, referer: 'https://m.kugou.com/',
        ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      });
      const u = j && (j.url || j.play_url);
      if (u) return { status: 'OK', detail: '免费歌可直接下（付费歌仍需登录）' };
      return { status: 'KNOWN', detail: '接口活着但返回「' + (j && (j.error || j.errcode) || '需付费') + '」= 要登录态，走补链（设计如此）' };
    },
  },
  /* ---------------- 咪咕 ---------------- */
  {
    group: '咪咕', ep: 'miguSearch', impact: '咪咕搜索', known: true,
    async run() {
      const j = await getJson(`${EP.miguSearch}?text=${encodeURIComponent('晴天')}&pageNo=1&pageSize=3&searchSwitch=${encodeURIComponent('{"song":1}')}`, { signal: SIG, timeout: 20000, referer: 'https://app.c.nf.migu.cn/' });
      const list = (j && j.songResultData && j.songResultData.resultList) || [];
      return list.length ? { status: 'OK', detail: `${list.length} 条（已恢复！）` } : { status: 'KNOWN', detail: '返回 0 条（地区/风控限制，本版已知）' };
    },
  },
];

/* ------------------------------------------------------------------ */

const MARK = { OK: `${C.ok}✓ 可用${C.x}`, EMPTY: `${C.warn}○ 空${C.x}`, DEAD: `${C.bad}✗ 失效${C.x}`, KNOWN: `${C.dim}— 已知${C.x}` };

/* ---------------- 自定义音源 ---------------- */

function checkPlugins() {
  const os = require('os');
  const path = require('path');
  const { loadSources } = require('../src/plugin');
  const dirs = [
    path.join(process.env.APPDATA || os.homedir(), 'windtune', 'sources'),
    path.join(__dirname, '..', 'sources'),
  ];
  return { loaded: loadSources(dirs), dirs };
}

(async () => {
  const json = process.argv.includes('--json');
  if (!json) {
    console.log(`${C.b}听风音乐舫 · 接口体检${C.x}  ${C.dim}(${new Date().toLocaleString('zh-CN')})${C.x}`);
    console.log(`${C.dim}接口定义：src/endpoints.js   共 ${CHECKS.length} 项${C.x}\n`);
  }

  let lastGroup = '';
  const results = [];
  for (const c of CHECKS) {
    if (!json && c.group !== lastGroup) { console.log(`${C.b}${c.group}${C.x}`); lastGroup = c.group; }
    let r;
    try {
      r = await c.run();
    } catch (e) {
      r = { status: 'DEAD', detail: (e && e.message ? e.message : String(e)).slice(0, 60) };
    }
    /* known 项如果恢复成 OK，就是好消息，照实报 */
    if (c.known && r.status === 'DEAD') r.status = 'KNOWN';
    results.push({ group: c.group, ep: c.ep, impact: c.impact, critical: !!c.critical, known: !!c.known, ...r });
    if (!json) {
      const url = EP[c.ep] || '';
      const tail = r.status === 'DEAD' ? `${C.bad}${r.detail}${C.x}` : `${C.dim}${r.detail}${C.x}`;
      console.log(`  ${MARK[r.status]}  ${c.impact.padEnd(18)} ${tail}`);
      if (r.status === 'DEAD') console.log(`      ${C.dim}→ 改 src/endpoints.js 里的 ${c.ep}${C.x}\n      ${C.dim}  当前值：${url}${C.x}`);
    }
  }

  if (!json) {
    const { loaded, dirs } = checkPlugins();
    const good = loaded.filter((p) => !p.error);
    const plats = [];
    for (const p of good) for (const k of Object.keys(p.sources || {})) if (!plats.includes(k)) plats.push(k);
    console.log();
    console.log(`${C.b}自定义音源${C.x}`);
    if (!good.length) {
      console.log(`  ${C.dim}· 未安装${C.x}  ${C.dim}(放一个洛雪格式的 .js 到 ${dirs[0]})${C.x}`);
      console.log(`  ${C.dim}  QQ/酷狗的整首音频要靠音源；内置示例在 ${dirs[1]}${C.x}`);
    } else {
      for (const p of loaded) {
        const meta = p.info || {};
        if (p.error) {
          console.log(`  ${C.bad}✗ 加载失败${C.x}  ${meta.name || p.file}  ${C.dim}→ ${p.error}${C.x}`);
        } else {
          const src = Object.entries(p.sources).map(([k, v]) => `${k}(${(v.qualitys || []).join('/') || '默认'})`).join(' ');
          console.log(`  ${C.ok}✓ 已加载${C.x}  ${meta.name}${meta.version ? ' v' + meta.version : ''}  ${C.dim}${src}${C.x}`);
        }
      }
      const over = plats.filter((k) => ['tx', 'kg'].includes(k));
      if (over.length) console.log(`  ${C.ok}→ QQ/酷狗的整首音频走音源取流（已覆盖：${over.join(', ')}）${C.x}`);
      else console.log(`  ${C.dim}→ 目前没有 tx(QQ) / kg(酷狗) 音源${C.x}`);
    }
    console.log(`${C.dim}  音源目录：${dirs[0]}${C.x}`);
  }

  const dl = results.filter((r) => r.critical);
  const alive = dl.filter((r) => r.status === 'OK');
  const dead = results.filter((r) => r.status === 'DEAD');
  const verdict = alive.length === dl.length ? '两条下载链路都正常'
    : alive.length ? `仅 ${alive.map((r) => r.group).join(' / ')} 可下载（补链能力减半，但仍能下歌）`
      : '⚠ 两条下载链路全失效 —— 现在下不了任何歌';
  const code = alive.length ? 0 : 1;

  if (json) {
    console.log(JSON.stringify({ at: new Date().toISOString(), verdict, exitCode: code, checks: results }, null, 2));
  } else {
    console.log();
    console.log(`${C.b}结论${C.x}  ${alive.length ? C.ok : C.bad}${verdict}${C.x}`);
    if (dead.length) console.log(`${C.warn}${dead.length} 项失效：${dead.map((r) => r.group + '/' + r.ep).join(', ')}${C.x}`);
    else console.log(`${C.dim}没有失效项${C.x}`);
    console.log(`${C.dim}下载链路：${dl.map((r) => `${r.group}=${r.status}`).join('  ')}${C.x}`);
  }
  process.exit(code);
})();
