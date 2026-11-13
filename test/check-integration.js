'use strict';
/* 跨文件一致性检查：IPC 通道、资源路径、打包清单、CSP 约束 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const exists = (f) => fs.existsSync(path.join(ROOT, f));

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };

/* 1. preload 调的通道，主进程必须都注册了 */
console.log('===== 1. IPC 通道对齐 =====');
const preload = read('preload.js');
const main = read('main.js');
const called = new Set([...preload.matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)].map((m) => m[1]));
const handled = new Set([...main.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map((m) => m[1]));
console.log('  preload 调用:', [...called].join(', '));
console.log('  main  注册:', [...handled].join(', '));
for (const ch of called) ok(handled.has(ch), `通道 ${ch} 有对应 handler`);
for (const ch of handled) ok(called.has(ch) || ch === 'app:version', `handler ${ch} 被用到`);

const PROGRESS = 'download-progress';
ok(preload.includes(`'${PROGRESS}'`), 'preload 监听 progress 通道');
ok(main.includes(`'${PROGRESS}'`), 'main 发送 progress 通道');

/* 2. renderer 不能 require */
console.log('\n===== 2. 渲染层隔离 =====');
const appJs = read('ui/app.js');
ok(!/\brequire\s*\(/.test(appJs), 'ui/app.js 不直接 require');
ok(!/\bprocess\./.test(appJs), 'ui/app.js 不碰 process');
ok(/window\.api/.test(appJs), 'ui/app.js 通过 window.api 通信');

/* 3. 资源路径 */
console.log('\n===== 3. 资源与入口路径 =====');
const html = read('ui/index.html');
for (const f of ['ui/index.html', 'ui/app.js', 'ui/style.css', 'assets/logo.svg', 'assets/icon.ico', 'assets/icon.png', 'main.js', 'preload.js']) {
  ok(exists(f), f + ' 存在');
}
ok(main.includes("path.join(__dirname, 'ui', 'index.html')"), 'main 加载 ui/index.html');
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !u.startsWith('#'));
console.log('  index.html 引用:', refs.join(', '));
for (const r of refs) {
  ok(!/^https?:|^\/\//.test(r), `引用 ${r} 是本地资源`);
  ok(exists(path.join('ui', r.replace(/^\.\.\//, '../').replace(/^\.\//, ''))), `引用 ${r} 文件存在`);
}

/* 4. CSP 与内联 */
console.log('\n===== 4. CSP / 内联违规 =====');
ok(/Content-Security-Policy/.test(html), '有 CSP meta');
ok(/script-src 'self'/.test(html), "script-src 'self'");
const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(html);
ok(!inlineScript, '没有内联 <script> 代码块');
ok(!/\son(click|change|input|submit|load|error|keydown)\s*=/i.test(html), '没有内联事件属性');
ok(!/\.cssText/.test(appJs) && !/setAttribute\(\s*['"]style['"]/.test(appJs), 'JS 没有用被 CSP 拦的写样式方式');
ok(!/@import/.test(read('ui/style.css')), 'CSS 没有 @import');

/* 5. package.json 与打包清单 */
console.log('\n===== 5. package.json / 打包清单 =====');
const pkg = JSON.parse(read('package.json'));
ok(pkg.main === 'main.js', 'main 入口正确');
ok(!!pkg.build.win.icon && exists(pkg.build.win.icon), 'build.win.icon 指向存在的文件: ' + pkg.build.win.icon);
const files = pkg.build.files || [];
for (const need of ['main.js', 'preload.js', 'src/**/*', 'ui/**/*', 'assets/**/*', 'package.json']) {
  ok(files.includes(need), '打包包含 ' + need);
}
ok(pkg.productName === '全平台音乐下载器', 'productName 已更名');
ok(/^2\.\d+\.\d+/.test(pkg.version), 'version 是 2.x: ' + pkg.version);
ok(!!pkg.scripts.test && !!pkg.scripts.icon, 'scripts 有 test / icon');
ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, '运行时零第三方依赖');

/* 6. 引擎导出的函数都被 main 用到 */
console.log('\n===== 6. 引擎接线 =====');
const engine = require('../src/engine');
for (const fn of ['searchAll', 'resolveInput', 'downloadTracks', 'checkSources', 'parseLink']) {
  ok(typeof engine[fn] === 'function', 'engine.' + fn + ' 已导出');
}
/* 7. 源码目录里没有误留的调试开关 */
console.log('\n===== 7. 源码卫生 =====');
for (const f of ['main.js', 'preload.js', 'src/http.js', 'src/sources.js', 'src/engine.js', 'downloader.js']) {
  const s = read(f);
  ok(!/console\.log\(/.test(s), f + ' 没有遗留 console.log');
  ok(s.startsWith("'use strict';"), f + ' 有 use strict');
}

console.log('\n' + (fail ? `!!! ${fail} 项未通过` : '=== 全部通过 ==='));
process.exit(fail ? 1 : 0);
