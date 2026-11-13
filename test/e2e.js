'use strict';
/* 端到端自测：搜索 / 歌单解析 / 真下载（含歌词封面） */
const path = require('path');
const fs = require('fs');
const os = require('os');
const engine = require('../src/engine');

const OUT = path.join(os.tmpdir(), 'nmd-e2e-' + Date.now());
const signal = { cancelled: false };
const ok = (c, m) => console.log((c ? '  PASS ' : '  FAIL ') + m);

(async () => {
  console.log('===== 1. 连通性自检 =====');
  const chk = await engine.checkSources(signal);
  for (const c of chk) console.log('  ' + c.label.padEnd(8), c.ok ? 'OK  ' : 'DEAD', String(c.ms + 'ms').padEnd(7), c.canDownload ? '可下载' : '仅搜索', c.note);
  ok(chk.filter((c) => c.ok).length >= 2, '至少 2 个平台可用');

  console.log('\n===== 2. 跨平台搜索 "周杰伦 晴天" =====');
  const s = await engine.searchAll({ keyword: '周杰伦 晴天', limit: 5 }, signal);
  for (const [k, v] of Object.entries(s.bySource)) console.log('  ' + k.padEnd(9), v.ok ? `n=${v.count} ${v.ms}ms` : 'ERR ' + v.error);
  ok(s.items.length > 0, `合并结果 ${s.items.length} 条`);
  console.log('  示例:', s.items.slice(0, 3).map((t) => `${t.source}:${t.name}/${t.artists.join(',')}`).join(' | '));

  console.log('\n===== 3. 歌单解析（网易云 3778678 热歌榜）=====');
  let pl = null;
  try {
    pl = await engine.resolveInput({ input: 'https://music.163.com/#/playlist?id=3778678' }, signal);
    console.log(`  「${pl.title}」 ${pl.subtitle} tracks=${pl.tracks.length}/${pl.total}`);
    console.log('  前3:', pl.tracks.slice(0, 3).map((t) => `${t.name}-${t.artists.join(',')}`).join(' | '));
    ok(pl.tracks.length > 0, '歌单有曲目');
  } catch (e) { ok(false, '歌单解析: ' + e.message); }

  console.log('\n===== 4. 关键词解析（走 search 分支）=====');
  try {
    const r = await engine.resolveInput({ input: '海阔天空 beyond' }, signal);
    console.log(`  kind=${r.kind} title=${r.title} n=${r.tracks.length}`);
    ok(r.kind === 'search' && r.tracks.length > 0, 'resolve 关键词可用');
  } catch (e) { ok(false, e.message); }

  console.log('\n===== 5. 真下载 3 首（含歌词+封面+补链）=====');
  if (s.items.length) {
    const pick = [];
    const bySource = {};
    for (const t of s.items) { (bySource[t.source] = bySource[t.source] || []).push(t); }
    // 尽量覆盖：一个网易云、一个酷我、一个 QQ（QQ 走补链）
    for (const sid of ['netease', 'kuwo', 'tencent', 'kugou']) if (bySource[sid] && bySource[sid][0]) pick.push(bySource[sid][0]);
    const tracks = pick.length ? pick : s.items.slice(0, 3);
    console.log('  选中:', tracks.map((t) => `${t.source}:${t.name}`).join(' | '));
    let last = 0;
    const summary = await engine.downloadTracks({
      tracks, outDir: OUT, title: 'e2e测试', br: 320, fallback: true,
      concurrency: 3, saveLyric: true, saveCover: true,
    }, (ev) => {
      if (ev.type === 'track') console.log(`  [${ev.done}/${ev.total}] ${ev.ok ? 'OK ' : 'SKIP'} 源=${ev.source}${ev.via && ev.via !== ev.source ? ' 下载源=' + ev.via + '(补链)' : ''} ${ev.br || ''}k ${ev.bytes ? (ev.bytes / 1048576).toFixed(1) + 'MB' : ''} ${ev.name}${ev.lyric ? ' [L]' : ''}${ev.cover ? '[C]' : ''} ${ev.reason ? '| ' + ev.reason : ''}`);
      if (ev.type === 'start') last = ev.total;
    }, signal);
    console.log(`  汇总: 成功 ${summary.success}/${summary.total} · ${summary.totalMB}MB · 歌词 ${summary.lyricCount} · 封面 ${summary.coverCount}`);
    console.log('  目录:', summary.outDir);
    const files = fs.readdirSync(summary.outDir);
    console.log('  文件:', files.join(' | '));
    ok(summary.success >= 1, '至少下到 1 首');
    const audio = files.filter((f) => /\.(mp3|flac|m4a|ogg)$/i.test(f));
    ok(audio.length >= 1, '音频文件落盘 ' + audio.length);
    for (const f of audio) {
      const st = fs.statSync(path.join(summary.outDir, f));
      console.log('   ', f, (st.size / 1048576).toFixed(1) + 'MB');
    }
    ok(summary.lyricCount >= 1, '歌词落盘');
    ok(summary.coverCount >= 1, '封面落盘');
  }

  console.log('\n===== 6. 取消机制 =====');
  const sig2 = { cancelled: true };
  try {
    const r = await engine.downloadTracks({ tracks: s.items.slice(0, 3), outDir: OUT, title: '取消测试', concurrency: 2 }, () => {}, sig2);
    ok(r.cancelled === true && r.success === 0, '取消后不下载');
  } catch (e) { ok(false, e.message); }

  console.log('\n输出目录:', OUT);
})();
