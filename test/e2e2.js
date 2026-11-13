'use strict';
/* 场景测试：QQ 歌单 / 酷狗歌单 -> 跨平台补链下载 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const engine = require('../src/engine');

const OUT = path.join(os.tmpdir(), 'nmd-cover-' + Date.now());
const sig = { cancelled: false };

(async () => {
  const cases = [
    ['QQ音乐歌单', 'https://y.qq.com/n/ryqq/playlist/7138573358'],
    ['酷狗歌单', 'https://www.kugou.com/yy/special/single/2338764.html'],
    ['QQ音乐专辑', 'https://y.qq.com/n/ryqq/albumDetail/002mGsM62gHnX9'],
  ];
  for (const [label, link] of cases) {
    console.log(`\n########## ${label} ##########`);
    let col;
    try {
      col = await engine.resolveInput({ input: link }, sig);
    } catch (e) {
      console.log('  解析失败:', e.message);
      continue;
    }
    console.log(`  「${col.title}」${col.subtitle} -> ${col.tracks.length}/${col.total} 首`);
    const pick = col.tracks.slice(0, 3);
    console.log('  取前3首下载:', pick.map((t) => t.name).join(' / '));
    const sums = [];
    const sum = await engine.downloadTracks({
      tracks: pick, outDir: OUT, title: label, br: 320, fallback: true,
      concurrency: 3, saveLyric: true, saveCover: true,
    }, (ev) => {
      if (ev.type === 'track') {
        console.log(`    [${ev.done}/${ev.total}] ${ev.ok ? 'OK' : 'SKIP'} 源=${ev.source}${ev.via && ev.via !== ev.source ? ' 下载源=' + ev.via : ''} ${ev.br || ''}k ${ev.bytes ? (ev.bytes / 1048576).toFixed(1) + 'MB' : ''} ${ev.name}${ev.reason ? ' | ' + ev.reason : ''}`);
      }
    }, sig);
    sums.push(sum);
    console.log(`  => 成功 ${sum.success}/${sum.total}, ${sum.totalMB}MB, 歌词 ${sum.lyricCount}, 封面 ${sum.coverCount}, 来源 ${JSON.stringify(sum.sourceDistribution)}`);
    const files = fs.readdirSync(sum.outDir);
    console.log('  文件数:', files.length, '音频:', files.filter((f) => /\.(mp3|flac|m4a|ogg)$/i.test(f)).length);
  }
  console.log('\n输出:', OUT);
})();
