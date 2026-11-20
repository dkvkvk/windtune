'use strict';
/* 统一 HTTP：超时、重试、UA、Referer、取消信号、二进制/JSON 解析 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeout] 毫秒
 * @param {number} [opts.retries]
 * @param {object} [opts.headers]
 * @param {string} [opts.referer]
 * @param {'text'|'json'|'buffer'} [opts.as]
 * @param {object} [opts.signal] { cancelled: boolean, abortSignal?: AbortSignal }
 */
async function request(url, opts = {}) {
  const tries = Math.max(1, opts.retries == null ? 2 : opts.retries);
  const timeout = opts.timeout || 20000;
  const headers = {
    'User-Agent': opts.ua || UA,
    Accept: opts.accept || '*/*',
    ...(opts.referer ? { Referer: opts.referer } : {}),
    ...(opts.headers || {}),
  };
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    if (opts.signal && opts.signal.cancelled) throw new HttpError('已取消', 0);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    const signal = opts.signal?.abortSignal ? AbortSignal.any([ac.signal, opts.signal.abortSignal]) : ac.signal;
    try {
      const res = await fetch(url, { headers, signal, redirect: 'follow', method: opts.method || 'GET', body: opts.body });
      if (!res.ok) throw new HttpError('HTTP ' + res.status, res.status);
      if (opts.as === 'buffer') return { buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') || '' };
      const txt = await res.text();
      if (opts.as === 'json') {
        try { return JSON.parse(txt); } catch { throw new HttpError('返回不是 JSON', res.status); }
      }
      return txt;
    } catch (e) {
      lastErr = e;
      if (opts.signal && opts.signal.cancelled) throw new HttpError('已取消', 0);
      if (i < tries - 1) await sleep(600 * (i + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new HttpError('请求失败', 0);
}

const getText = (url, opts) => request(url, { ...opts, as: 'text' });
const getJson = (url, opts) => request(url, { ...opts, as: 'json' });
const getBuffer = (url, opts) => request(url, { ...opts, as: 'buffer' });

/** 并发限流映射，保持结果顺序 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (idx < items.length) {
      const my = idx++;
      out[my] = await fn(items[my], my);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 音频/图片真实格式嗅探（接口给的扩展名不一定可信） */
function sniff(head) {
  if (!head || head.length < 4) return '';
  const h = head;
  if (h.slice(0, 3).toString('latin1') === 'ID3') return 'mp3';
  if (h[0] === 0xff && (h[1] & 0xe0) === 0xe0) return 'mp3';
  if (h.slice(0, 4).toString('latin1') === 'fLaC') return 'flac';
  if (h.slice(0, 4).toString('latin1') === 'OggS') return 'ogg';
  if (h.slice(4, 8).toString('latin1') === 'ftyp') return 'm4a';
  if (h[0] === 0x49 && h[1] === 0x48 && h[2] === 0x44 && h[3] === 0x52) return 'mp3';
  if (h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46) return 'wav';
  if (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47) return 'png';
  if (h[0] === 0xff && h[1] === 0xd8) return 'jpg';
  return '';
}

const isAudioExt = (ext) => ['mp3', 'flac', 'm4a', 'ogg', 'wav'].includes(ext);

module.exports = { request, getText, getJson, getBuffer, mapLimit, sniff, isAudioExt, sleep, UA, HttpError };
