'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let parsed = null;
let lastOutDir = null;

function setStatus(t) { $('status').textContent = t; }

function showInfo(text, isErr) {
  const el = $('playlistInfo');
  el.textContent = text;
  el.classList.remove('hidden');
  el.classList.toggle('err', !!isErr);
}

async function init() {
  try { $('outDir').value = await window.api.defaultDir(); } catch {}
}
init();

$('parseBtn').onclick = async () => {
  const input = $('input').value.trim();
  if (!input) { setStatus('请先输入歌单链接或 ID'); return; }
  $('parseBtn').disabled = true;
  $('parseBtn').textContent = '解析中…';
  $('playlistInfo').classList.add('hidden');
  $('startBtn').disabled = true;
  const r = await window.api.parsePlaylist(input);
  $('parseBtn').disabled = false;
  $('parseBtn').textContent = '解析歌单';
  if (!r.ok) { showInfo('解析失败：' + r.error, true); return; }
  parsed = r.data;
  const cap = parsed.trackCount > 1000 ? '（API 最多返回 1000 首）' : '';
  showInfo(`「${parsed.name}」${parsed.creator ? ' · ' + parsed.creator : ''} · 共 ${parsed.trackCount} 首，返回 ${parsed.returned} 首${cap}`);
  $('startBtn').disabled = false;
  setStatus('解析成功，可开始下载');
};

$('chooseBtn').onclick = async () => {
  const d = await window.api.chooseDir();
  if (d) $('outDir').value = d;
};

$('startBtn').onclick = async () => {
  if (!parsed) return;
  const outDir = $('outDir').value.trim();
  if (!outDir) { setStatus('请先选择输出目录'); return; }
  const opts = {
    id: parsed.id,
    outDir,
    br: parseInt($('br').value, 10),
    concurrency: parseInt($('concurrency').value, 10),
  };
  $('startBtn').disabled = true;
  $('cancelBtn').classList.remove('hidden');
  $('openBtn').disabled = true;
  $('log').innerHTML = '';
  $('summary').classList.add('hidden');
  $('bar').style.width = '0%';
  $('stats').textContent = '';
  setStatus('下载中…');
  const r = await window.api.startDownload(opts);
  $('cancelBtn').classList.add('hidden');
  $('startBtn').disabled = false;
  if (!r.ok) { setStatus('下载失败：' + r.error); return; }
  lastOutDir = r.summary.outDir;
  $('openBtn').disabled = false;
};

$('cancelBtn').onclick = () => { window.api.cancelDownload(); setStatus('正在取消…'); };
$('openBtn').onclick = () => { if (lastOutDir) window.api.openDir(lastOutDir); };

window.api.onProgress((ev) => {
  if (ev.type === 'start') {
    setStatus(`开始下载「${ev.playlist}」`);
  } else if (ev.type === 'track') {
    const pct = (ev.done / ev.total * 100).toFixed(1);
    $('bar').style.width = pct + '%';
    $('stats').textContent = `${ev.done} / ${ev.total} · ${pct}%`;
    appendLog(ev);
  } else if (ev.type === 'done') {
    $('bar').style.width = '100%';
    renderSummary(ev.summary);
    setStatus(ev.summary.cancelled ? '已取消' : '下载完成');
  }
});

function appendLog(ev) {
  const div = document.createElement('div');
  div.className = 'log-line ' + (ev.ok ? 'ok' : 'skip');
  const tag = ev.ok ? `OK ${ev.br}k ${(ev.bytes / 1048576).toFixed(1)}MB` : `SKIP ${ev.reason || ''}`;
  div.textContent = `[${ev.done}/${ev.total}] ${tag} | ${ev.label}`;
  const log = $('log');
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function renderSummary(s) {
  const el = $('summary');
  el.classList.remove('hidden');
  const br = Object.entries(s.bitrateDistribution || {}).map(([k, v]) => `${k}k×${v}`).join(' / ') || '无';
  let html = `<label class="lbl">汇总${s.cancelled ? '（已取消）' : ''}</label>
    <div class="sum-grid">
      <div><b>${s.success}</b><span>成功</span></div>
      <div><b>${s.skipped}</b><span>跳过</span></div>
      <div><b>${s.totalMB}</b><span>MB</span></div>
      <div><b>${s.total}</b><span>总数</span></div>
    </div>
    <p class="sum-line">音质：${esc(br)} · 输出：${esc(s.outDir)}</p>`;
  if (s.skippedList && s.skippedList.length) {
    html += `<label class="lbl">跳过清单（${s.skippedList.length}）</label><div class="skiplist">` +
      s.skippedList.map((x) => `<div class="log-line skip">${esc(x.name)} — ${esc(x.reason)}</div>`).join('') + '</div>';
  }
  el.innerHTML = html;
}