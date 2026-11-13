'use strict';
/**
 * 自定义音源宿主（兼容洛雪音乐 LX Music 的自定义源脚本格式）
 * ==================================================================
 * 为什么要有这个东西：QQ音乐 / 酷狗 的音频接口锁在登录态后面，
 * 而且各家接口平均几个月就改一次。硬编码在代码里意味着每次都要等发新版。
 * 洛雪音乐（lx-music-desktop）的做法是把「取音频地址」这一层交给可替换的 JS 脚本，
 * 本文件实现同一套契约，因此**社区现成的洛雪音源可以直接加载**。
 *
 * 支持的脚本 API（与 LX Music 桌面版一致）：
 *   globalThis.lx.version            自定义源 API 版本
 *   globalThis.lx.env                'desktop'
 *   globalThis.lx.currentScriptInfo  {name, description, version, author, homepage, rawScript}
 *   globalThis.lx.EVENT_NAMES        {request, inited, updateAlert}
 *   globalThis.lx.on(name, handler)  handler 必须返回 Promise
 *   globalThis.lx.send(name, data)   脚本用它发 inited 事件声明支持的平台
 *   globalThis.lx.request(url, opts, cb) → 取消函数；cb(err, resp, body)
 *   globalThis.lx.utils.buffer.from / bufToString
 *   globalThis.lx.utils.crypto.md5 / randomBytes / aesEncrypt / rsaEncrypt
 *   globalThis.lx.utils.zlib.inflate / deflate
 *
 * 平台 key 与主程序 source id 的对应：wy=网易云 tx=QQ kg=酷狗 kw=酷我 mg=咪咕
 *
 * ⚠️ 安全提示：音源脚本是**任意 JS**，与洛雪一样具有本程序同等的权限。
 *    只加载你信任的来源，别从陌生链接随便下载。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const zlib = require('zlib');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

/** 主程序 source id ↔ 洛雪音源 key */
const SOURCE_TO_LX = { netease: 'wy', tencent: 'tx', kugou: 'kg', kuwo: 'kw', migu: 'mg' };
const LX_TO_SOURCE = { wy: 'netease', tx: 'tencent', kg: 'kugou', kw: 'kuwo', mg: 'migu' };

const QUALITY_ORDER = ['flac24bit', 'flac', '320k', '128k'];

/** 音质档位：本程序用 kbps，音源用字符串 */
function brToQuality(br) {
  const n = Number(br) || 320;
  if (n >= 900) return 'flac';
  if (n >= 320) return '320k';
  return '128k';
}

/** 从脚本头部注解读取元信息（@name / @version / …） */
function parseScriptInfo(code) {
  const head = String(code).slice(0, 2000);
  const g = (tag) => {
    const m = head.match(new RegExp('@' + tag + '\\s+([^\\r\\n*]+)'));
    return m ? m[1].trim() : '';
  };
  return {
    name: g('name') || '(未命名音源)',
    description: g('description') || '',
    version: g('version') || '',
    author: g('author') || '',
    homepage: g('homepage') || '',
  };
}

function buildMultipart(formData) {
  const boundary = '----WindTuneForm' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  for (const [k, v] of Object.entries(formData)) {
    if (v && typeof v === 'object' && v.buffer) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"; filename="${v.filename || 'file'}"\r\nContent-Type: ${v.contentType || 'application/octet-stream'}\r\n\r\n`));
      parts.push(Buffer.isBuffer(v.buffer) ? v.buffer : Buffer.from(v.buffer));
      parts.push(Buffer.from('\r\n'));
    } else {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

class SourceHost {
  constructor() {
    this.plugins = [];      // [{file, info:{name,...}, sources:{tx:{qualitys,actions}}, error}]
    this.pending = null;    // 最近一次 inited 未收到的插件（避免异步 send 丢失）
  }

  /* ---------------- 加载 ---------------- */

  loadDirs(dirs) {
    this.plugins = [];
    for (const dir of dirs.filter(Boolean)) {
      try {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir).filter((f) => /\.js$/i.test(f) && !f.startsWith('.'));
        for (const f of files) this.loadFile(path.join(dir, f));
      } catch (e) {
        this.plugins.push({ file: dir, info: { name: '(目录读取失败)' }, sources: {}, error: e.message });
      }
    }
    return this.plugins;
  }

  loadFile(file) {
    let record = { file, info: { name: path.basename(file) }, sources: {}, error: '' };
    let code = '';
    try {
      code = fs.readFileSync(file, 'utf8');
      record.info = { ...parseScriptInfo(code), file };
      const { listeners, inited } = this.runScript(code, record.info, file);
      if (!inited || !inited.sources || !Object.keys(inited.sources).length) {
        throw new Error('脚本没有发送有效的 inited 事件（没有声明任何音源）');
      }
      record.inited = inited;
      record.listeners = listeners;
      record.sources = {};
      for (const [key, def] of Object.entries(inited.sources)) {
        if (!LX_TO_SOURCE[key] && key !== 'local') continue; // 认不出的平台键忽略
        record.sources[key] = {
          name: (def && def.name) || key,
          actions: (def && def.actions) || ['musicUrl'],
          qualitys: (def && def.qualitys) || [],
        };
      }
      if (!Object.keys(record.sources).length) throw new Error('脚本声明的平台本程序都不支持');
    } catch (e) {
      record.error = e && e.message ? e.message : String(e);
    }
    this.plugins.push(record);
    return record;
  }

  /** 在 vm 沙箱里跑脚本，收集 on/send */
  runScript(code, info, file) {
    const listeners = {};
    const host = this;
    let inited = null;

    const lx = {
      version: '2.0.0',
      env: 'desktop',
      currentScriptInfo: { ...info, rawScript: code },
      EVENT_NAMES: { request: 'request', inited: 'inited', updateAlert: 'updateAlert' },
      on(name, handler) {
        (listeners[name] || (listeners[name] = [])).push(handler);
      },
      send(name, data) {
        if (name === 'inited') inited = data;
      },
      request(url, options, callback) {
        return host.doRequest(url, options || {}, callback);
      },
      utils: {
        buffer: {
          from: (v, enc) => Buffer.from(v, enc),
          bufToString: (buf, format) => {
            if (!Buffer.isBuffer(buf)) return String(buf);
            return buf.toString(typeof format === 'string' && Buffer.isEncoding(format) ? format : 'utf8');
          },
        },
        crypto: {
          md5: (str) => crypto.createHash('md5').update(typeof str === 'string' ? str : Buffer.from(str)).digest('hex'),
          randomBytes: (size) => crypto.randomBytes(Math.max(1, Number(size) || 8)).toString('hex'),
          aesEncrypt: (buffer, mode, key, iv) => {
            const c = crypto.createCipheriv(mode || 'aes-128-cbc', key, iv || null);
            return Buffer.concat([c.update(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)), c.final()]);
          },
          rsaEncrypt: (buffer, key) => crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)),
        },
        zlib: {
          inflate: (buf) => new Promise((res, rej) => zlib.inflate(buf, (e, r) => (e ? rej(e) : res(r)))),
          deflate: (buf) => new Promise((res, rej) => zlib.deflate(buf, (e, r) => (e ? rej(e) : res(r)))),
        },
      },
    };

    const quiet = (...args) => { /* 音源脚本的 console 不往界面刷，避免噪音 */ };
    const sandbox = {
      lx,
      console: { log: quiet, info: quiet, warn: quiet, error: quiet, debug: quiet },
      Buffer, URL, URLSearchParams, TextDecoder, TextEncoder,
      atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
      btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
      setTimeout, clearTimeout, setInterval, clearInterval,
      Promise, JSON, Math, Date, RegExp, Array, Object, String, Number, Boolean, Error, TypeError,
      encodeURIComponent, decodeURIComponent, encodeURI, decodeURI, parseInt, parseFloat, isNaN,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: file, timeout: 20000, displayErrors: true });
    return { listeners, inited };
  }

  /* ---------------- HTTP 桥 ---------------- */

  doRequest(url, options, callback) {
    const cb = typeof callback === 'function' ? callback : () => {};
    const ac = new AbortController();
    const timeout = Number(options.timeout) > 0 ? Number(options.timeout) : 20000;
    const timer = setTimeout(() => { try { ac.abort(); } catch { /* ignore */ } }, timeout);

    const headers = { 'User-Agent': UA, ...(options.headers || {}) };
    let body = options.body;
    if (options.form) {
      body = new URLSearchParams(options.form).toString();
      headers['Content-Type'] = headers['Content-Type'] || 'application/x-www-form-urlencoded';
    } else if (options.formData) {
      const mp = buildMultipart(options.formData);
      body = mp.body;
      headers['Content-Type'] = mp.contentType;
    }

    fetch(url, { method: (options.method || 'GET').toUpperCase(), headers, body, signal: ac.signal, redirect: 'follow' })
      .then(async (r) => {
        const buf = Buffer.from(await r.arrayBuffer());
        const hdrs = {};
        r.headers.forEach((v, k) => { hdrs[k] = v; });
        const asBinary = !!options.binary;
        const payload = asBinary ? buf : buf.toString('utf8');
        const resp = { statusCode: r.status, status: r.status, headers: hdrs, body: payload, raw: buf };
        cb(null, resp, payload);
      })
      .catch((e) => cb(e))
      .finally(() => clearTimeout(timer));

    return () => { try { ac.abort(); } catch { /* ignore */ } };
  }

  /* ---------------- 查询与调用 ---------------- */

  /** 某个洛雪平台 key 是否有可用音源 */
  supports(lxKey) {
    return this.plugins.some((p) => !p.error && p.sources && p.sources[lxKey]);
  }

  /** 列出某平台可用的音源（按加载顺序） */
  find(lxKey) {
    return this.plugins.filter((p) => !p.error && p.sources && p.sources[lxKey]);
  }

  /** 调用音源：action = musicUrl | lyric | pic */
  async call(lxKey, action, info) {
    for (const plugin of this.find(lxKey)) {
      const handlers = (plugin.listeners && plugin.listeners.request) || [];
      for (const handler of handlers) {
        try {
          const ret = handler({ source: lxKey, action, info });
          if (!ret || typeof ret.then !== 'function') continue; // 契约要求返回 Promise
          const value = await withTimeout(ret, 30000);
          if (value != null && value !== '') return { value, plugin: plugin.info.name };
        } catch { /* 换下一个音源 */ }
      }
    }
    return null;
  }

  /** 取音频地址；quality 会自动降级到音源支持的最好档位 */
  async getUrl(lxKey, musicInfo, br) {
    const wanted = brToQuality(br);
    const plugin = this.find(lxKey)[0];
    if (!plugin) return null;
    const supported = (plugin.sources[lxKey] && plugin.sources[lxKey].qualitys) || [];
    const order = [wanted, ...QUALITY_ORDER.filter((q) => q !== wanted)].filter((q) => !supported.length || supported.includes(q));
    for (const quality of order) {
      const r = await this.call(lxKey, 'musicUrl', { type: quality, musicInfo });
      if (r && typeof r.value === 'string' && /^https?:\/\//i.test(r.value)) return { url: r.value, quality, plugin: r.plugin };
    }
    return null;
  }

  /** 给界面/自检用的状态摘要 */
  status() {
    return this.plugins.map((p) => ({
      file: p.file,
      name: (p.info && p.info.name) || path.basename(p.file || ''),
      version: (p.info && p.info.version) || '',
      author: (p.info && p.info.author) || '',
      error: p.error || '',
      sources: Object.keys(p.sources || {}).map((k) => ({ key: k, source: LX_TO_SOURCE[k] || k, qualitys: p.sources[k].qualitys || [] })),
    }));
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('音源超时')), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/* ---------------- 把本程序的曲目转成洛雪 musicInfo ---------------- */

const pad2 = (n) => String(n).padStart(2, '0');

function toLxMusicInfo(tr) {
  const lxKey = SOURCE_TO_LX[tr.source] || tr.source;
  const dur = Number(tr.duration) || 0;
  const base = {
    name: tr.name,
    singer: (tr.artists || []).join('、'),
    albumName: tr.album || '',
    interval: dur ? `${pad2(Math.floor(dur / 60))}:${pad2(dur % 60)}` : '00:00',
    img: tr.picUrl || '',
    source: lxKey,
    songmid: String(tr.id),
    id: String(tr.id),
  };
  const ex = tr.extra || {};
  switch (lxKey) {
    case 'tx':
      return { ...base, songmid: String(tr.id), mid: String(tr.id), strMediaMid: ex.strMediaMid || String(tr.id), albumMid: ex.albumMid || '', songId: ex.songId || '', types: [], _types: {} };
    case 'kg':
      return { ...base, hash: String(tr.id).toLowerCase(), audioId: ex.mixsongid || '', albumId: ex.albumId || '' };
    case 'wy':
      return { ...base, id: String(tr.id) };
    case 'kw':
      return { ...base, songmid: String(tr.id), musicrid: `MUSIC_${tr.id}` };
    case 'mg':
      return { ...base, copyrightId: ex.copyrightId || '', songId: String(tr.id) };
    default:
      return base;
  }
}

/* ---------------- 单例 ---------------- */

const host = new SourceHost();

/** 供 engine / main 使用：加载音源目录（可多次调用） */
function loadSources(dirs) {
  return host.loadDirs(dirs);
}

module.exports = { host, loadSources, toLxMusicInfo, brToQuality, SOURCE_TO_LX, LX_TO_SOURCE, SourceHost };
