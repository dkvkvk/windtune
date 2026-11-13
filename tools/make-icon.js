#!/usr/bin/env node
'use strict';

// 听风音乐舫 · 图标生成器（纯 Node、零依赖，只用 fs / path / zlib）
//
// 用法：
//   node tools/make-icon.js                生成 assets/logo.svg、assets/icon.png、assets/icon.ico
//   node tools/make-icon.js --dump-small   额外导出 16/24/32/48/64/128/256 预览 PNG 到 _shots/
//
// 构成（全是构造性几何，统一在 1024×1024 设计坐标系里描述）：
//   底板：圆角 22% 的圆角矩形，#4f8df7 → #7c5cf7 对角渐变 + 极轻的左上柔光
//   主体：白色「八分音符 + 向下箭头」
//     · 符头  斜置椭圆（音符头该有的倾角）
//     · 符干  圆头粗线段
//     · 符尾  二次贝塞尔中线 + 由粗到细的法向偏移，生成一条平滑的叶片（多边形）
//     · 箭头  圆头箭杆 + 钝三角箭头（顶点收圆）
//   音符略偏上、箭头略偏下，形成斜向动势；两者之间留出负空间，16×16 也不会糊成一块。
//
// 抗锯齿：逐像素 8×8（≤128px）/ 4×4（更大）超采样，全部是构造性几何命中测试。
// PNG：手写 IHDR/IDAT/IEND + 自算 CRC32；ICO：手写 ICONDIR + ICONDIRENTRY，条目统一用 PNG。

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------- 基础小工具

function r2(n) {
  return Math.round(n * 100) / 100;
}

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

// ---------------------------------------------------------------- 设计参数

const TILE = 1024;                            // 设计坐标系边长
const TILE_RADIUS = Math.round(TILE * 0.22);  // 圆角 = 边长的 22%
const COLOR_FROM = [0x4f, 0x8d, 0xf7];        // 起点 = 界面主色
const COLOR_TO = [0x7c, 0x5c, 0xf7];          // 终点（紫）
// 左上柔光：让渐变不发死；白色主体不依赖它（始终是画面里最高亮的部分）
const GLOW = { x: 340, y: 116, r: 660, a: 0.15 };

// 主体原始几何（未归一化）
const RAW = {
  // 圆头粗线段
  caps: [
    { x1: 444, y1: 640, x2: 444, y2: 240, r: 56 }, // 符干
    { x1: 722, y1: 350, x2: 722, y2: 626, r: 60 }  // 箭杆（比符干长一截，箭头才有“箭头感”）
  ],
  // 符头
  ellipses: [
    { cx: 330, cy: 664, rx: 136, ry: 106, rot: -22 }
  ],
  // 多边形（箭头三角，顶点收圆）
  polys: [
    { pts: [[722, 826], [618, 624], [826, 624]], round: 12 }
  ],
  // 符尾叶片：中线二次贝塞尔 + 半宽由粗到细（长而缓的扫掠，才像音符的符尾）
  blades: [
    { x0: 444, y0: 240, cx: 588, cy: 262, x1: 566, y1: 404, w0: 54, w1: 12, segs: 22 }
  ]
};

// 叶片 → 多边形（中线两侧法向偏移，端头补一个小圆让尾尖收圆）
function expandBlades(list) {
  const out = [];
  list.forEach(function (b) {
    const n = b.segs;
    const left = [];
    const right = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const mt = 1 - t;
      const x = mt * mt * b.x0 + 2 * mt * t * b.cx + t * t * b.x1;
      const y = mt * mt * b.y0 + 2 * mt * t * b.cy + t * t * b.y1;
      let dx = 2 * mt * (b.cx - b.x0) + 2 * t * (b.x1 - b.cx);
      let dy = 2 * mt * (b.cy - b.y0) + 2 * t * (b.y1 - b.cy);
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      dx /= len;
      dy /= len;
      const w = b.w1 + (b.w0 - b.w1) * Math.pow(1 - t, 0.85);
      left.push([x - dy * w, y + dx * w]);
      right.push([x + dy * w, y - dx * w]);
    }
    out.push({
      pts: left.concat(right.reverse()),
      round: 0,
      circles: [{ x: b.x1, y: b.y1, r: b.w1 }]
    });
  });
  return out;
}

// 小尺寸专用（≤24px）的简化几何：去掉符尾、加大箭头、加粗笔画。
// 16/24 只有十几个像素，符尾会退化成噪点；这套只服务于“小图标一眼认得出”。
const RAW_SMALL = {
  caps: [
    { x1: 434, y1: 660, x2: 434, y2: 252, r: 58 }, // 符干
    { x1: 726, y1: 384, x2: 726, y2: 644, r: 64 }  // 箭杆
  ],
  ellipses: [
    { cx: 318, cy: 688, rx: 134, ry: 104, rot: -22 }
  ],
  polys: [
    { pts: [[726, 846], [584, 640], [868, 640]], round: 10 }
  ],
  blades: []
};

const RAW_ALL = normalizeRaw(RAW);
const RAW_ALL_SMALL = normalizeRaw(RAW_SMALL);

function normalizeRaw(raw) {
  return {
    caps: raw.caps,
    ellipses: raw.ellipses,
    paths: (raw.polys || []).map(function (p) {
      return { pts: p.pts, round: p.round, circles: [] };
    }).concat(expandBlades(raw.blades || []))
  };
}

// ---------------------------------------------------------------- 包围盒归一化

function rawBBox(raw) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  function add(x0, y0, x1, y1) {
    if (x0 < minX) minX = x0;
    if (y0 < minY) minY = y0;
    if (x1 > maxX) maxX = x1;
    if (y1 > maxY) maxY = y1;
  }
  raw.caps.forEach(function (c) {
    add(Math.min(c.x1, c.x2) - c.r, Math.min(c.y1, c.y2) - c.r,
      Math.max(c.x1, c.x2) + c.r, Math.max(c.y1, c.y2) + c.r);
  });
  raw.ellipses.forEach(function (e) {
    const rad = e.rot * Math.PI / 180;
    const dx = Math.sqrt(Math.pow(e.rx * Math.cos(rad), 2) + Math.pow(e.ry * Math.sin(rad), 2));
    const dy = Math.sqrt(Math.pow(e.rx * Math.sin(rad), 2) + Math.pow(e.ry * Math.cos(rad), 2));
    add(e.cx - dx, e.cy - dy, e.cx + dx, e.cy + dy);
  });
  raw.paths.forEach(function (p) {
    p.pts.forEach(function (pt) {
      add(pt[0] - p.round, pt[1] - p.round, pt[0] + p.round, pt[1] + p.round);
    });
    (p.circles || []).forEach(function (c) {
      add(c.x - c.r, c.y - c.r, c.x + c.r, c.y + c.r);
    });
  });
  return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
}

// 按包围盒等比缩放并居中：主体长边占据边长的 fit。
// fit 随目标尺寸变化（光学尺寸补偿）：16/24 这类小图标留白更少、主体更大，才看得清。
const PIVOT = TILE / 2;

function fitFor(size) {
  if (size <= 24) return 0.72;
  if (size <= 40) return 0.655;
  return 0.615;
}

// 每套几何预先算好包围盒与中心
function prepGeom(all) {
  const box = rawBBox(all);
  return {
    all: all,
    w: box.maxX - box.minX,
    h: box.maxY - box.minY,
    cx: (box.minX + box.maxX) / 2,
    cy: (box.minY + box.maxY) / 2
  };
}

const GEOM_BIG = prepGeom(RAW_ALL);
const GEOM_SMALL = prepGeom(RAW_ALL_SMALL);

// 当前正在渲染的主体（每次渲染前重建，避免为每个尺寸存一份）
let GLYPH = null;

function makeGlyph(geom, fit) {
  const s = (fit * TILE) / Math.max(geom.w, geom.h);
  function tx(x) { return (x - geom.cx) * s + PIVOT; }
  function ty(y) { return (y - geom.cy) * s + PIVOT; }
  const g = {
    caps: geom.all.caps.map(function (c) {
      return { x1: tx(c.x1), y1: ty(c.y1), x2: tx(c.x2), y2: ty(c.y2), r: c.r * s };
    }),
    ellipses: geom.all.ellipses.map(function (e) {
      return { cx: tx(e.cx), cy: ty(e.cy), rx: e.rx * s, ry: e.ry * s, rot: e.rot };
    }),
    paths: geom.all.paths.map(function (p) {
      return {
        pts: p.pts.map(function (pt) { return [tx(pt[0]), ty(pt[1])]; }),
        round: p.round * s,
        circles: (p.circles || []).map(function (c) {
          return { x: tx(c.x), y: ty(c.y), r: c.r * s };
        })
      };
    })
  };
  prepBBox(g.caps, 'cap');
  prepBBox(g.ellipses, 'ellipse');
  prepBBox(g.paths, 'path');
  GLYPH = g;
  return g;
}

// ---------------------------------------------------------------- 命中测试

// 点到粗线段的距离平方
function segDist2(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = 0;
  if (l2 > 0) t = clamp(((px - x1) * dx + (py - y1) * dy) / l2, 0, 1);
  const qx = px - (x1 + dx * t);
  const qy = py - (y1 + dy * t);
  return qx * qx + qy * qy;
}

function inEllipse(px, py, e) {
  const rad = e.rot * Math.PI / 180;
  const cos = Math.cos(-rad);
  const sin = Math.sin(-rad);
  const dx = px - e.cx;
  const dy = py - e.cy;
  const u = dx * cos - dy * sin;
  const v = dx * sin + dy * cos;
  return (u * u) / (e.rx * e.rx) + (v * v) / (e.ry * e.ry) <= 1;
}

// 奇偶规则点是否在多边形内
function inPolygon(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0];
    const yi = pts[i][1];
    const xj = pts[j][0];
    const yj = pts[j][1];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPath(px, py, p) {
  if (inPolygon(px, py, p.pts)) return true;
  if (p.round > 0) {
    const pts = p.pts;
    const rr = p.round * p.round;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      if (segDist2(px, py, pts[j][0], pts[j][1], pts[i][0], pts[i][1]) <= rr) return true;
    }
  }
  for (let i = 0; i < p.circles.length; i++) {
    const c = p.circles[i];
    const dx = px - c.x;
    const dy = py - c.y;
    if (dx * dx + dy * dy <= c.r * c.r) return true;
  }
  return false;
}

// 每个图元的外接盒（用于提前排除）
function prepBBox(list, kind) {
  list.forEach(function (it) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    function add(a, b, c, d) {
      if (a < x0) x0 = a;
      if (b < y0) y0 = b;
      if (c > x1) x1 = c;
      if (d > y1) y1 = d;
    }
    if (kind === 'cap') {
      add(Math.min(it.x1, it.x2) - it.r, Math.min(it.y1, it.y2) - it.r,
        Math.max(it.x1, it.x2) + it.r, Math.max(it.y1, it.y2) + it.r);
    } else if (kind === 'ellipse') {
      const rad = it.rot * Math.PI / 180;
      const dx = Math.sqrt(Math.pow(it.rx * Math.cos(rad), 2) + Math.pow(it.ry * Math.sin(rad), 2));
      const dy = Math.sqrt(Math.pow(it.rx * Math.sin(rad), 2) + Math.pow(it.ry * Math.cos(rad), 2));
      add(it.cx - dx, it.cy - dy, it.cx + dx, it.cy + dy);
    } else {
      it.pts.forEach(function (p) { add(p[0] - it.round, p[1] - it.round, p[0] + it.round, p[1] + it.round); });
      it.circles.forEach(function (c) { add(c.x - c.r, c.y - c.r, c.x + c.r, c.y + c.r); });
    }
    it._bbox = [x0 - 1, y0 - 1, x1 + 1, y1 + 1];
  });
}
function inGlyph(px, py) {
  let i;
  let it;
  for (i = 0; i < GLYPH.caps.length; i++) {
    it = GLYPH.caps[i];
    const b = it._bbox;
    if (px < b[0] || px > b[2] || py < b[1] || py > b[3]) continue;
    if (segDist2(px, py, it.x1, it.y1, it.x2, it.y2) <= it.r * it.r) return true;
  }
  for (i = 0; i < GLYPH.ellipses.length; i++) {
    it = GLYPH.ellipses[i];
    const b = it._bbox;
    if (px < b[0] || px > b[2] || py < b[1] || py > b[3]) continue;
    if (inEllipse(px, py, it)) return true;
  }
  for (i = 0; i < GLYPH.paths.length; i++) {
    it = GLYPH.paths[i];
    const b = it._bbox;
    if (px < b[0] || px > b[2] || py < b[1] || py > b[3]) continue;
    if (inPath(px, py, it)) return true;
  }
  return false;
}

// 圆角矩形底板
function inTile(px, py) {
  const hw = TILE / 2;
  const rr = TILE_RADIUS;
  const qx = Math.abs(px - hw) - (hw - rr);
  const qy = Math.abs(py - hw) - (hw - rr);
  if (qx <= 0 && qy <= 0) return true;
  const ax = qx > 0 ? qx : 0;
  const ay = qy > 0 ? qy : 0;
  return ax * ax + ay * ay <= rr * rr;
}

// ---------------------------------------------------------------- 上色

const scratch = [0, 0, 0];

function tileColor(px, py, out) {
  const t = clamp((px + py) / (2 * TILE), 0, 1);
  let r = COLOR_FROM[0] + (COLOR_TO[0] - COLOR_FROM[0]) * t;
  let g = COLOR_FROM[1] + (COLOR_TO[1] - COLOR_FROM[1]) * t;
  let b = COLOR_FROM[2] + (COLOR_TO[2] - COLOR_FROM[2]) * t;
  const dx = px - GLOW.x;
  const dy = py - GLOW.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < GLOW.r) {
    const a = GLOW.a * (1 - d / GLOW.r);
    r = r + (255 - r) * a;
    g = g + (255 - g) * a;
    b = b + (255 - b) * a;
  }
  out[0] = r;
  out[1] = g;
  out[2] = b;
}

// ---------------------------------------------------------------- 光栅化（超采样）

function renderRGBA(size) {
  // 小尺寸换用简化几何（去符尾、加大箭头），其余尺寸用完整几何
  makeGlyph(size <= 24 ? GEOM_SMALL : GEOM_BIG, fitFor(size));
  const ss = size <= 128 ? 8 : 4;   // 小尺寸超采样更狠，边缘更干净
  const total = ss * ss;
  const step = 1 / ss;
  const scale = size / TILE;
  const buf = Buffer.alloc(size * size * 4);
  const col = scratch;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let cov = 0;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      for (let j = 0; j < ss; j++) {
        const sy = (py + (j + 0.5) * step) / scale;
        for (let i = 0; i < ss; i++) {
          const sx = (px + (i + 0.5) * step) / scale;
          if (!inTile(sx, sy)) continue;
          cov++;
          if (inGlyph(sx, sy)) {
            sr += 255;
            sg += 255;
            sb += 255;
          } else {
            tileColor(sx, sy, col);
            sr += col[0];
            sg += col[1];
            sb += col[2];
          }
        }
      }
      const o = (py * size + px) * 4;
      if (cov === 0) continue;   // 底板之外：全透明
      buf[o] = Math.round(sr / cov);
      buf[o + 1] = Math.round(sg / cov);
      buf[o + 2] = Math.round(sb / cov);
      buf[o + 3] = Math.round((cov / total) * 255);
    }
  }
  return buf;
}

// 最近邻放大（只为人工检查小尺寸像素，不参与产物）
function zoomRGBA(rgba, size, k) {
  const w = size * k;
  const out = Buffer.alloc(w * w * 4);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const s = ((y / k | 0) * size + (x / k | 0)) * 4;
      const d = (y * w + x) * 4;
      out[d] = rgba[s];
      out[d + 1] = rgba[s + 1];
      out[d + 2] = rgba[s + 2];
      out[d + 3] = rgba[s + 3];
    }
  }
  return out;
}

// ---------------------------------------------------------------- PNG 编码
const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const tb = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
  return Buffer.concat([len, tb, data, crc]);
}

function encodePNG(rgba, w, h) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;   // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // 位深
  ihdr[9] = 6;    // 颜色类型：RGBA
  ihdr[10] = 0;   // deflate
  ihdr[11] = 0;   // 自适应滤波
  ihdr[12] = 0;   // 不隔行
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- ICO 编码

function encodeICO(items) {
  // items: [{ size, png }]，条目统一用 PNG（Windows Vista+ 支持）
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // type = 1（图标）
  header.writeUInt16LE(items.length, 4);
  const dir = Buffer.alloc(16 * items.length);
  let offset = 6 + 16 * items.length;
  items.forEach(function (it, i) {
    const o = i * 16;
    const dim = it.size >= 256 ? 0 : it.size;   // 256 在目录里记 0
    dir[o] = dim;
    dir[o + 1] = dim;
    dir[o + 2] = 0;                          // 调色板颜色数：0 = 真彩
    dir[o + 3] = 0;                          // reserved
    dir.writeUInt16LE(1, o + 4);             // planes
    dir.writeUInt16LE(32, o + 6);            // 每像素位数
    dir.writeUInt32LE(it.png.length, o + 8); // 数据长度
    dir.writeUInt32LE(offset, o + 12);       // 数据偏移
    offset += it.png.length;
  });
  return Buffer.concat([header, dir].concat(items.map(function (it) { return it.png; })));
}

// ---------------------------------------------------------------- SVG 输出

function buildSVG() {
  makeGlyph(GEOM_BIG, fitFor(32));   // logo.svg 在界面里就是 32×32 显示，按 32 的补偿来画
  const a = [];
  a.push('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 1024 1024"');
  a.push('     role="img" aria-label="听风音乐舫">');
  a.push('  <defs>');
  a.push('    <linearGradient id="nmd-base" x1="0" y1="0" x2="1024" y2="1024" gradientUnits="userSpaceOnUse">');
  a.push('      <stop offset="0" stop-color="#4f8df7"/>');
  a.push('      <stop offset="1" stop-color="#7c5cf7"/>');
  a.push('    </linearGradient>');
  a.push('    <radialGradient id="nmd-glow" cx="' + GLOW.x + '" cy="' + GLOW.y + '" r="' + GLOW.r + '" gradientUnits="userSpaceOnUse">');
  a.push('      <stop offset="0" stop-color="#ffffff" stop-opacity="' + GLOW.a + '"/>');
  a.push('      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>');
  a.push('    </radialGradient>');
  a.push('  </defs>');
  a.push('  <rect width="1024" height="1024" rx="' + TILE_RADIUS + '" fill="url(#nmd-base)"/>');
  a.push('  <rect width="1024" height="1024" rx="' + TILE_RADIUS + '" fill="url(#nmd-glow)"/>');
  a.push('  <g stroke="#ffffff" stroke-linecap="round" fill="none">');
  GLYPH.caps.forEach(function (c) {
    a.push('    <line x1="' + r2(c.x1) + '" y1="' + r2(c.y1) + '" x2="' + r2(c.x2) + '" y2="' + r2(c.y2) +
      '" stroke-width="' + r2(c.r * 2) + '"/>');
  });
  a.push('  </g>');
  a.push('  <g fill="#ffffff" stroke="none">');
  GLYPH.ellipses.forEach(function (e) {
    a.push('    <ellipse cx="' + r2(e.cx) + '" cy="' + r2(e.cy) + '" rx="' + r2(e.rx) + '" ry="' + r2(e.ry) +
      '" transform="rotate(' + r2(e.rot) + ' ' + r2(e.cx) + ' ' + r2(e.cy) + ')"/>');
  });
  GLYPH.paths.forEach(function (p) {
    if (p.round <= 0) {
      const pts = p.pts.map(function (pt) { return r2(pt[0]) + ',' + r2(pt[1]); }).join(' ');
      a.push('    <polygon points="' + pts + '"/>');
    }
    p.circles.forEach(function (c) {
      a.push('    <circle cx="' + r2(c.x) + '" cy="' + r2(c.y) + '" r="' + r2(c.r) + '"/>');
    });
  });
  a.push('  </g>');
  // 三角形用 fill + 圆角描边来收圆顶点（描边宽度 = 2×圆角半径）
  a.push('  <g fill="#ffffff" stroke="#ffffff" stroke-linejoin="round">');
  GLYPH.paths.forEach(function (p) {
    if (p.round <= 0) return;
    const pts = p.pts.map(function (pt) { return r2(pt[0]) + ',' + r2(pt[1]); }).join(' ');
    a.push('    <polygon points="' + pts + '" stroke-width="' + r2(p.round * 2) + '"/>');
  });
  a.push('  </g>');
  a.push('</svg>');
  return a.join('\n') + '\n';
}

// ---------------------------------------------------------------- 入口

function glyphBBox() {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  [GLYPH.caps, GLYPH.ellipses, GLYPH.paths].forEach(function (list) {
    list.forEach(function (it) {
      minX = Math.min(minX, it._bbox[0] + 1);
      minY = Math.min(minY, it._bbox[1] + 1);
      maxX = Math.max(maxX, it._bbox[2] - 1);
      maxY = Math.max(maxY, it._bbox[3] - 1);
    });
  });
  return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
}

function main() {
  const here = path.resolve(__dirname, '..');
  const assetsDir = path.join(here, 'assets');
  const shotsDir = path.join(here, '_shots');
  const dumpSmall = process.argv.indexOf('--dump-small') !== -1;

  fs.mkdirSync(assetsDir, { recursive: true });

  const t0 = Date.now();

  // 1) 矢量版（界面顶部 32×32）
  const svgPath = path.join(assetsDir, 'logo.svg');
  fs.writeFileSync(svgPath, buildSVG(), 'utf8');

  // 2) 1024 主图
  const png1024 = encodePNG(renderRGBA(1024), 1024, 1024);
  const pngPath = path.join(assetsDir, 'icon.png');
  fs.writeFileSync(pngPath, png1024);

  // 3) ICO：16/24/32/48/64/128/256 一个不缺
  const SIZES = [16, 24, 32, 48, 64, 128, 256];
  const items = SIZES.map(function (size) {
    return { size: size, png: encodePNG(renderRGBA(size), size, size) };
  });
  const icoPath = path.join(assetsDir, 'icon.ico');
  const icoBuf = encodeICO(items);
  fs.writeFileSync(icoPath, icoBuf);

  const bb = glyphBBox();
  console.log('生成完毕（' + (Date.now() - t0) + 'ms）');
  console.log('  ' + svgPath);
  console.log('  ' + pngPath + '  ' + png1024.length + ' B');
  console.log('  ' + icoPath + '  ' + icoBuf.length + ' B  ' + SIZES.length + ' 个尺寸');
  console.log('主体包围盒: x ' + r2(bb.minX) + '..' + r2(bb.maxX) + '  y ' + r2(bb.minY) + '..' + r2(bb.maxY));
  console.log('主体占比: 宽 ' + r2((bb.maxX - bb.minX) / TILE * 100) + '%  高 ' +
    r2((bb.maxY - bb.minY) / TILE * 100) + '%  中心 (' +
    r2((bb.minX + bb.maxX) / 2) + ', ' + r2((bb.minY + bb.maxY) / 2) + ')');
  console.log('ICO 条目: ' + items.map(function (it) { return it.size + 'px/' + it.png.length + 'B'; }).join('  '));

  if (dumpSmall) {
    fs.mkdirSync(shotsDir, { recursive: true });
    [16, 24, 32, 48, 64, 128, 256].forEach(function (size) {
      const out = path.join(shotsDir, 'icon-' + size + '.png');
      fs.writeFileSync(out, encodePNG(renderRGBA(size), size, size));
      console.log('  预览 ' + out);
    });
    // 小尺寸放大（最近邻），便于肉眼检查实际像素
    [[16, 14], [24, 10], [32, 8], [48, 6]].forEach(function (pair) {
      const size = pair[0];
      const k = pair[1];
      const out = path.join(shotsDir, 'zoom-' + size + '.png');
      fs.writeFileSync(out, encodePNG(zoomRGBA(renderRGBA(size), size, k), size * k, size * k));
      console.log('  放大 ' + out);
    });
  }
}

main();
