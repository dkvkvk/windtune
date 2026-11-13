'use strict';
/* 资源与兼容层校验：ICO 结构 / PNG 尺寸 / 图标可重现性 / 1.x 兼容入口 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const A = (f) => path.join(ROOT, 'assets', f);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };

/* ---- PNG 尺寸 ---- */
function pngSize(buf) {
  if (buf.slice(1, 4).toString('latin1') !== 'PNG') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), bit: buf[24], color: buf[25] };
}

console.log('===== 1. PNG =====');
for (const f of ['icon.png', 'logo.svg']) {
  const p = A(f);
  if (!fs.existsSync(p)) { ok(false, f + ' 不存在'); continue; }
  ok(true, f + ' ' + fs.statSync(p).size + 'B');
}
const png = pngSize(fs.readFileSync(A('icon.png')));
console.log('  icon.png', png);
ok(png && png.w === 1024 && png.h === 1024, 'icon.png 是 1024×1024');

/* ---- ICO 结构 ---- */
console.log('\n===== 2. ICO 结构 =====');
const ico = fs.readFileSync(A('icon.ico'));
const reserved = ico.readUInt16LE(0);
const type = ico.readUInt16LE(2);
const count = ico.readUInt16LE(4);
ok(reserved === 0 && type === 1, `ICONDIR 头合法 (reserved=${reserved} type=${type})`);
console.log('  条目数:', count);
const entries = [];
for (let i = 0; i < count; i++) {
  const o = 6 + i * 16;
  const w = ico[o] === 0 ? 256 : ico[o];
  const h = ico[o + 1] === 0 ? 256 : ico[o + 1];
  const colors = ico[o + 2];
  const planes = ico.readUInt16LE(o + 4);
  const bpp = ico.readUInt16LE(o + 6);
  const bytes = ico.readUInt32LE(o + 8);
  const offset = ico.readUInt32LE(o + 12);
  entries.push({ w, h, bpp, bytes, offset });
  const sub = ico.slice(offset, offset + 8);
  const isPng = sub.slice(1, 4).toString('latin1') === 'PNG';
  const isBmp = sub.readUInt32LE(0) === 40;
  console.log(`   ${String(w).padStart(3)}×${String(h).padEnd(3)} bpp=${bpp} ${String(bytes).padStart(6)}B @${offset} ${isPng ? 'PNG' : isBmp ? 'BMP(DIB)' : '未知?'}`);
}
const sizes = entries.map((e) => e.w).sort((a, b) => a - b);
const need = [16, 24, 32, 48, 64, 128, 256];
ok(need.every((n) => sizes.includes(n)), '包含 16/24/32/48/64/128/256 → ' + sizes.join(','));
ok(entries.every((e) => e.offset + e.bytes <= ico.length), '每个条目偏移+长度不越界');
ok(entries.every((e) => e.w === e.h), '条目都是正方形');
ok(ico.length < 200 * 1024, 'ICO 体积合理 ' + (ico.length / 1024).toFixed(1) + 'KB');

/* ---- 可重现性 ---- */
console.log('\n===== 3. 图标可重现 =====');
console.log('  当前 sha16  icon.ico=' + sha(ico) + '  icon.png=' + sha(fs.readFileSync(A('icon.png'))) + '  logo.svg=' + sha(Buffer.from(fs.readFileSync(A('logo.svg'), 'utf8'))));
if (process.argv.includes('--regen')) {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'make-icon.js')], { encoding: 'utf8' });
    console.log('  脚本输出:', out.trim().split('\n').slice(-3).join(' | '));
  } catch (e) {
    ok(false, '脚本执行失败（沙箱禁止子进程时用 npm run icon 手动跑）: ' + e.message);
  }
} else {
  console.log('  （跳过重新生成；带 --regen 才会真跑一遍 tools/make-icon.js）');
}

/* ---- 1.x 兼容层 ---- */
console.log('\n===== 4. downloader.js 兼容层 =====');
const dl = require('../downloader');
ok(typeof dl.extractId === 'function' && typeof dl.parsePlaylist === 'function', '导出旧接口');
ok(dl.extractId('https://music.163.com/#/playlist?id=3778678') === '3778678', 'extractId 从链接取 ID');
ok(dl.extractId('3778678') === '3778678', 'extractId 支持纯数字');
ok(dl.extractId('随便一句话') === null, 'extractId 对无效输入返回 null');
ok(dl.BASE.includes('gdstudio'), 'BASE 保留');

(async () => {
  try {
    const p = await dl.parsePlaylist('3778678');
    console.log('  parsePlaylist:', p.name, p.trackCount + '首', 'returned=' + p.returned, 'creator=' + p.creator);
    ok(p.tracks.length > 0 && p.tracks[0].id, 'parsePlaylist 返回曲目');
  } catch (e) { ok(false, 'parsePlaylist: ' + e.message); }

  console.log('\n' + (fail ? `!!! ${fail} 项未通过` : '=== 全部通过 ==='));
  process.exit(fail ? 1 : 0);
})();
