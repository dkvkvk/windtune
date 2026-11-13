'use strict';

/*
 * 听风音乐舫 · renderer
 *
 * 业务逻辑只通过 `api` 访问主进程（preload 注入的 window.api）。
 * window.api 不存在时（例如直接用 Chrome 打开本页面）使用文件末尾的 demo mock，
 * 因此这个页面在没有 Electron 的环境里也能完整展示界面。
 */

(function () {

  const api = window.api || createDemoApi();

  const SOURCES = [
    { id: 'netease', label: '网易云' },
    { id: 'tencent', label: 'QQ音乐' },
    { id: 'kugou', label: '酷狗' },
    { id: 'kuwo', label: '酷我' },
    { id: 'migu', label: '咪咕' },
    { id: 'joox', label: 'JOOX' }
  ];

  const SRC = {};
  SOURCES.forEach(function (s) {
    SRC[s.id] = s;
  });

  const NOTE_SVG =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M9 18V6.4l9-1.9v11.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />' +
    '<circle cx="6.6" cy="18" r="2.4" stroke="currentColor" stroke-width="1.8" />' +
    '<circle cx="15.6" cy="15.8" r="2.4" stroke="currentColor" stroke-width="1.8" />' +
    '</svg>';

  const CHECK_SVG =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />' +
    '</svg>';

  const state = {
    phase: 'empty',
    error: '',
    items: [],
    trackMap: new Map(),
    selected: new Set(),
    collection: null,
    enabled: new Set(SOURCES.map(function (s) { return s.id; })),
    health: null,
    checking: false,
    running: false,
    dir: '',
    summary: null,
    run: { total: 0, done: 0, ok: 0, skip: 0, selected: 0, title: '' },
    rowEls: new Map(),
    nameIndex: new Map(),
    logCount: 0,
    lastQuery: ''
  };

  let els = {};

  /* ------------------------------------------------------------------ *
   * 小工具
   * ------------------------------------------------------------------ */

  function $(id) {
    return document.getElementById(id);
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function errText(err) {
    if (!err) return '未知错误';
    if (typeof err === 'string') return err;
    return err.message ? String(err.message) : String(err);
  }

  function keyOf(track) {
    if (!track) return '';
    return track.key || (String(track.source) + ':' + String(track.id));
  }

  function srcLabel(id) {
    return SRC[id] ? SRC[id].label : (id || '未知');
  }

  function fmtDuration(sec) {
    const n = Number(sec);
    if (!n || n < 0) return '--:--';
    const m = Math.floor(n / 60);
    const s = Math.floor(n % 60);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function fmtMB(value) {
    const n = Number(value);
    return isNaN(n) ? '—' : n.toFixed(1) + ' MB';
  }

  function fmtBytes(bytes) {
    const n = Number(bytes);
    if (!n || n < 0) return '';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + 'MB';
    return Math.round(n / 1024) + 'KB';
  }

  function shortPath(p) {
    const s = String(p || '');
    if (!s) return '';
    if (s.length <= 48) return s;
    return '…' + s.slice(s.length - 47);
  }

  /* 任务标题会用作输出子目录名，去掉 Windows 不允许的字符 */
  function sanitizeName(name) {
    const s = String(name || '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    return s || '未命名任务';
  }

  function kindLabel(kind) {
    return { playlist: '歌单', album: '专辑', track: '单曲', search: '搜索' }[kind] || '集合';
  }

  function avgBitrate(dist) {
    const keys = Object.keys(dist || {});
    if (!keys.length) return '—';
    let sum = 0;
    let count = 0;
    keys.forEach(function (k) {
      const br = Number(k) || 0;
      const n = Number(dist[k]) || 0;
      sum += br * n;
      count += n;
    });
    if (!count) return '—';
    return Math.round(sum / count) + 'k';
  }

  function toast(message, kind) {
    if (!els.toasts || !message) return;
    /* 同时只显示一条：新的直接替换旧的 */
    els.toasts.innerHTML = '';
    const node = document.createElement('div');
    node.className = 'toast toast--' + (kind || 'info');
    node.textContent = String(message);
    els.toasts.appendChild(node);
    setTimeout(function () {
      node.classList.add('is-out');
      setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 200);
    }, 2200);
  }

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  function renderChips() {
    els.chips.innerHTML = SOURCES.map(function (s) {
      const on = state.enabled.has(s.id);
      return '<button type="button" class="pl' + (on ? ' is-on' : '') + '" data-id="' + esc(s.id) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
        '<i class="pl-dot" data-source="' + esc(s.id) + '"></i>' + esc(s.label) +
        '</button>';
    }).join('');
  }

  function renderHealth() {
    const map = state.health;
    const dots = SOURCES.map(function (s) {
      const item = map && map[s.id];
      let cls = 'health-dot';
      let title = s.label + ' · 未检测';
      if (item) {
        cls += item.ok ? ' is-ok' : ' is-bad';
        title = s.label + ' · ' + (item.ok ? '正常' : '异常');
        if (item.ms != null) title += ' · ' + item.ms + 'ms';
        if (item.note) title += ' · ' + item.note;
      }
      return '<span class="' + cls + '" title="' + esc(title) + '"></span>';
    }).join('');

    let text = '未检测';
    if (state.checking) {
      text = '检测中…';
    } else if (map) {
      let ok = 0;
      SOURCES.forEach(function (s) {
        if (map[s.id] && map[s.id].ok) ok += 1;
      });
      text = ok + '/' + SOURCES.length;
    }

    els.health.innerHTML = dots + '<span class="health-text">' + esc(text) + '</span>';
    els.health.title = '平台可用性：' + text;
  }

  function skeletonRows(count) {
    const rows = [];
    for (let i = 0; i < count; i += 1) {
      rows.push(
        '<div class="tr tr--sk">' +
        '<span class="sk sk--cb"></span>' +
        '<span class="sk sk--cover"></span>' +
        '<span class="sk-block"><span class="sk sk--title sk--w' + (i % 3) + '"></span><span class="sk sk--w2"></span></span>' +
        '<span class="sk sk--album"></span>' +
        '<span class="sk sk--badge"></span>' +
        '<span class="sk sk--dur"></span>' +
        '<span class="sk sk--status"></span>' +
        '</div>'
      );
    }
    return rows.join('');
  }

  function emptyBlock() {
    return '<div class="state">' +
      '<div class="state-icon">' + NOTE_SVG + '</div>' +
      '<h3>还没有曲目</h3>' +
      '<p>在上方输入关键词搜索，或粘贴任意平台的歌单 / 专辑链接解析。结果会显示在这里，可勾选后批量下载。</p>' +
      '</div>';
  }

  function errorBlock(message) {
    return '<div class="state state--error">' +
      '<div class="state-icon">' +
      '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M12 8.4v5.2" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" />' +
      '<circle cx="12" cy="16.9" r="1.1" fill="currentColor" />' +
      '<path d="M12 3.4 21 20H3L12 3.4z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />' +
      '</svg>' +
      '</div>' +
      '<h3>加载失败</h3>' +
      '<p>' + esc(message || '请求失败，请稍后重试') + '</p>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-act="retry">重试</button>' +
      '</div>';
  }

  function rowHtml(track) {
    const key = keyOf(track);
    const checked = state.selected.has(key);
    const src = SRC[track.source] || { id: 'unknown', label: track.source || '未知' };
    const artists = (track.artists && track.artists.length) ? track.artists.join(' / ') : '未知歌手';
    const album = track.album || '—';
    const cover = track.picUrl
      ? '<img class="cover-img" src="' + esc(track.picUrl) + '" alt="" referrerpolicy="no-referrer" loading="lazy" />'
      : '';

    return '<div class="tr tr--row' + (checked ? ' is-sel' : '') + '" data-key="' + esc(key) + '" role="row" tabindex="0" aria-selected="' + (checked ? 'true' : 'false') + '">' +
      '<label class="cb"><input type="checkbox" data-act="pick"' + (checked ? ' checked' : '') + ' aria-label="选择 ' + esc(track.name) + '" />' +
      '<span class="cb-box">' + CHECK_SVG + '</span></label>' +
      '<div class="cover" data-source="' + esc(src.id) + '"><span class="cover-ph">' + NOTE_SVG + '</span>' + cover + '</div>' +
      '<div class="col-song"><div class="song" title="' + esc(track.name) + '">' + esc(track.name) + '</div>' +
      '<div class="artists" title="' + esc(artists) + '">' + esc(artists) + '</div></div>' +
      '<div class="col-album" title="' + esc(album) + '">' + esc(album) + '</div>' +
      '<div class="col-src"><span class="badge badge--' + esc(src.id) + '">' + esc(src.label) + '</span></div>' +
      '<div class="col-dur">' + fmtDuration(track.duration) + '</div>' +
      '<div class="col-status"><span class="st st--wait">待下载</span></div>' +
      '</div>';
  }

  function renderResults() {
    const collection = state.collection;

    els.resultTitle.textContent = collection && collection.title ? collection.title : '结果列表';
    if (collection) {
      const total = state.items.length || collection.total || 0;
      els.resultSub.textContent = [collection.subtitle, total + ' 首'].filter(Boolean).join(' · ');
    } else {
      els.resultSub.textContent = '搜索或解析后在此显示曲目';
    }

    let html = '';
    if (state.phase === 'loading') {
      els.table.classList.remove('is-quiet');
      html = skeletonRows(5);
    } else if (state.phase === 'error') {
      els.table.classList.add('is-quiet');
      html = errorBlock(state.error);
    } else if (!state.items.length) {
      els.table.classList.add('is-quiet');
      html = emptyBlock();
    } else {
      els.table.classList.remove('is-quiet');
      html = state.items.map(rowHtml).join('');
    }

    els.tbody.innerHTML = html;
    indexRows();
    bindCoverFallbacks();
    els.table.classList.toggle('is-scrollable', els.tbody.scrollHeight > els.tbody.clientHeight + 2);
    updateSelectionUI();
  }

  function indexRows() {
    state.rowEls = new Map();
    state.nameIndex = new Map();
    const rows = els.tbody.querySelectorAll('.tr--row');
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const key = row.getAttribute('data-key');
      state.rowEls.set(key, row);
      const track = state.trackMap.get(key);
      if (track) state.nameIndex.set(String(track.source) + ':' + String(track.name), key);
    }
  }

  function bindCoverFallbacks() {
    const images = els.tbody.querySelectorAll('.cover-img');
    for (let i = 0; i < images.length; i += 1) {
      const img = images[i];
      img.addEventListener('error', function () {
        img.classList.add('is-hidden');
      });
      if (img.complete && img.naturalWidth === 0) img.classList.add('is-hidden');
    }
  }

  function updateSelectionUI() {
    const count = state.selected.size;
    const total = state.items.length;
    els.selPill.textContent = '已选 ' + count + ' 首';
    els.totalPill.textContent = '共 ' + total + ' 首';

    const all = total > 0 && count >= total;
    els.chkAll.checked = all;
    els.chkAll.indeterminate = count > 0 && count < total;

    els.btnAll.disabled = total === 0 || all;
    els.btnNone.disabled = count === 0;
    els.btnStart.disabled = count === 0 || state.running;
    els.btnStart.textContent = count > 0 ? '开始下载 · ' + count + ' 首' : '开始下载';
  }

  function renderDir() {
    els.dirPath.textContent = state.dir || '未选择';
    els.dirPath.title = state.dir || '未选择';
  }

  function setDlState(kind, text) {
    els.dlState.className = 'chip chip--' + kind;
    els.dlState.textContent = text;
  }

  function renderProgress() {
    const total = state.run.total || 0;
    const done = state.run.done || 0;
    const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;

    els.progFill.style.width = pct + '%';
    els.progress.setAttribute('aria-valuenow', String(pct));
    els.mSel.textContent = String(state.run.selected || 0);
    els.mDone.textContent = String(state.run.ok || 0);
    els.mSkip.textContent = String(state.run.skip || 0);
    els.mPct.textContent = pct + '%';
  }

  function resetLog() {
    state.logCount = 0;
    els.logCount.textContent = '0 条';
    els.logList.innerHTML = '<div class="log-empty">下载开始后，这里逐条显示每个曲目的结果</div>';
  }

  function pushLog(kind, name, note, flags) {
    if (state.logCount === 0) els.logList.innerHTML = '';
    state.logCount += 1;
    els.logCount.textContent = state.logCount + ' 条';

    const tag = { ok: 'OK', skip: 'SKIP', fail: 'FAIL', info: 'INFO' }[kind] || 'INFO';
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const line = document.createElement('div');
    line.className = 'log-line';
    line.innerHTML = '<span class="log-time">' + esc(time) + '</span>' +
      '<span class="log-tag log-tag--' + esc(kind) + '">' + tag + '</span>' +
      '<b class="log-name">' + esc(name) + '</b>' +
      '<span class="log-note">' + esc(note || '') + '</span>' +
      flagHtml(flags);
    els.logList.appendChild(line);

    while (els.logList.children.length > 200) {
      els.logList.removeChild(els.logList.firstChild);
    }
    els.logList.scrollTop = els.logList.scrollHeight;
  }

  /* 歌词 / 封面是否拿到，用小标记点亮 */
  function flagHtml(flags) {
    if (!flags) return '';
    const items = [
      { key: 'L', on: !!flags.lyric, label: '歌词' },
      { key: 'C', on: !!flags.cover, label: '封面' }
    ];
    return '<span class="log-flags">' + items.map(function (item) {
      return '<i class="flag' + (item.on ? ' is-on' : '') + '" title="' + item.label +
        (item.on ? ' 已保存' : ' 未保存') + '">' + item.key + '</i>';
    }).join('') + '</span>';
  }

  function markRow(key, kind) {
    const row = state.rowEls.get(key);
    if (!row) return;
    row.classList.remove('is-done', 'is-skip');
    if (kind === 'done') row.classList.add('is-done');
    if (kind === 'skip') row.classList.add('is-skip');
    const cell = row.querySelector('.col-status');
    if (cell) {
      const text = { done: '完成', skip: '跳过', fail: '失败', run: '下载中' }[kind] || '待下载';
      cell.innerHTML = '<span class="st st--' + esc(kind) + '">' + text + '</span>';
    }
  }

  /* 这首实际是从哪个平台下到的（跨平台补链时两个平台都写出来） */
  function viaLabel(evt) {
    if (evt.via && evt.via !== evt.source) {
      return '源 ' + srcLabel(evt.source) + ' → 补链' + srcLabel(evt.via);
    }
    return srcLabel(evt.source);
  }

  function trackNote(evt) {
    const bits = [];
    if (evt.via && evt.via !== evt.source) {
      bits.push('源 ' + srcLabel(evt.source) + ' → 补链' + srcLabel(evt.via));
    } else {
      bits.push(srcLabel(evt.source));
    }
    if (evt.br) bits.push(evt.br + 'k');
    const size = fmtBytes(evt.bytes);
    if (size) bits.push(size);
    if (evt.ext) bits.push(String(evt.ext).replace(/^\./, ''));
    if (!evt.ok && evt.reason) bits.push('原因：' + evt.reason);
    return bits.join(' · ');
  }

  function statTile(label, value, cls) {
    return '<div class="stat ' + (cls || '') + '">' +
      '<div class="k">' + esc(label) + '</div>' +
      '<div class="v">' + esc(value) + '</div>' +
      '</div>';
  }

  /* 分布一行：● 网易云 4 · ● 酷我 2（用平台色点替代宽徽章，一行放得下） */
  function distRow(label, dist, withDot) {
    const keys = Object.keys(dist || {});
    if (!keys.length) return '';
    const items = keys.map(function (key) {
      const src = SRC[key] || { id: 'unknown', label: key };
      const dot = withDot ? '<i class="pl-dot" data-source="' + esc(src.id) + '"></i>' : '';
      return '<span class="src">' + dot + esc(src.label) + '<b>' + esc(dist[key]) + '</b></span>';
    }).join('');
    return '<div class="dist-row"><span class="dist-label">' + esc(label) + '</span>' + items + '</div>';
  }

  function sameDist(a, b) {
    const ka = Object.keys(a || {}).sort();
    const kb = Object.keys(b || {}).sort();
    if (ka.length !== kb.length) return false;
    for (let i = 0; i < ka.length; i += 1) {
      if (ka[i] !== kb[i]) return false;
      if (Number(a[ka[i]]) !== Number(b[kb[i]])) return false;
    }
    return true;
  }

  function distHtml(summary, skips) {
    const srcDist = summary.sourceDistribution || {};
    const viaDist = summary.viaDistribution || {};
    const brDist = summary.bitrateDistribution || {};
    const rows = [];
    const tail = skips || '';

    if (Object.keys(srcDist).length) rows.push(distRow('结果来源', srcDist, true));
    /* 发生跨平台补链时，「结果来源」和「下载源」不是一回事，两个都写出来 */
    if (Object.keys(viaDist).length && !sameDist(srcDist, viaDist)) {
      rows.push(distRow('下载源', viaDist, true));
    }

    if (Object.keys(brDist).length) {
      const brItems = Object.keys(brDist).map(function (key) {
        return '<span class="src">' + esc(key) + 'k<b>×' + esc(brDist[key]) + '</b></span>';
      }).join('');
      rows.push('<div class="dist-row"><span class="dist-label">音质</span>' + brItems + tail + '</div>');
      return rows.join('');
    }

    if (rows.length) {
      rows[rows.length - 1] = rows[rows.length - 1].replace(/<\/div>$/, tail + '</div>');
    } else if (tail) {
      rows.push('<div class="dist-row">' + tail + '</div>');
    }
    return rows.join('');
  }

  function renderSummary(summary) {
    if (!summary) return;
    state.summary = summary;
    els.summary.hidden = false;
    els.dlCard.classList.add('is-done');

    const cancelled = !!summary.cancelled;
    const skippedList = summary.skippedList || [];

    const skips = skippedList.length
      ? '<details class="skips"><summary>跳过清单 · ' + skippedList.length + ' 首</summary><ul>' +
        skippedList.map(function (item) {
          const src = SRC[item.source] || { id: 'unknown', label: item.source || '未知' };
          return '<li><span class="badge badge--' + esc(src.id) + '">' + esc(src.label) + '</span>' +
            '<span class="nm">' + esc(item.name) + '</span>' +
            '<span class="r">' + esc(item.reason || '未知原因') + '</span></li>';
        }).join('') +
        '</ul></details>'
      : '';

    els.summary.innerHTML =
      '<div class="sum-head">' +
      '<h3>' + (cancelled ? '下载已取消' : '下载完成') + '</h3>' +
      '<span class="sum-meta">' + esc(summary.title || '') + ' · 共 ' + (summary.total || 0) +
      ' 首 · ' + esc(shortPath(summary.outDir)) + '</span>' +
      '<button type="button" class="btn btn-ghost btn-sm" id="btnOpenSum">打开目录</button>' +
      '<span class="chip ' + (cancelled ? 'chip--warn' : 'chip--ok') + '">' + (cancelled ? '已取消' : '已完成') + '</span>' +
      '</div>' +
      '<div class="stats">' +
      statTile('成功', summary.success || 0, '') +
      statTile('跳过', summary.skipped || 0, 'stat--warn') +
      statTile('歌词', summary.lyricCount || 0, 'stat--neutral') +
      statTile('封面', summary.coverCount || 0, 'stat--neutral') +
      statTile('总大小', fmtMB(summary.totalMB), 'stat--neutral') +
      statTile('平均音质', avgBitrate(summary.bitrateDistribution), 'stat--neutral') +
      '</div>' +
      '<div class="sum-foot">' + distHtml(summary, skips) + '</div>';
  }

  function hideSummary() {
    state.summary = null;
    els.summary.hidden = true;
    els.summary.innerHTML = '';
    if (els.dlCard) els.dlCard.classList.remove('is-done');
  }

  function renderCollectionSlot(collection) {
    if (!collection || !collection.title) {
      els.resolveSlot.innerHTML = '<p class="hint">支持网易云 / QQ音乐 / 酷狗 / 酷我 / 咪咕 / JOOX 的歌单、专辑与单曲页面，也可直接粘贴数字 ID。</p>';
      return;
    }
    const src = SRC[collection.source] || { id: 'unknown', label: collection.source || '未知' };
    els.resolveSlot.innerHTML = '<div class="collection">' +
      '<span class="cover collection-cover" data-source="' + esc(src.id) + '">' + NOTE_SVG + '</span>' +
      '<div class="collection-text">' +
      '<div class="collection-title" title="' + esc(collection.title) + '">' + esc(collection.title) + '</div>' +
      '<div class="collection-sub">' + esc(src.label) + ' · ' + esc(kindLabel(collection.kind)) + ' · ' + (collection.total || 0) + ' 首</div>' +
      '</div>' +
      '<span class="badge badge--' + esc(src.id) + '">' + esc(src.label) + '</span>' +
      '</div>';
  }

  /* ------------------------------------------------------------------ *
   * 进度事件
   * ------------------------------------------------------------------ */

  function handleProgress(evt) {
    if (!evt || typeof evt !== 'object') return;

    if (evt.type === 'start') {
      state.running = true;
      state.run.total = Number(evt.total) || 0;
      state.run.selected = state.run.selected || state.run.total;
      state.run.title = evt.title || '';
      setDlState('run', '下载中');
      els.dlSub.textContent = '正在下载：' + (evt.title || '') + ' · 共 ' + state.run.total + ' 首';
      els.btnCancel.disabled = false;
      els.btnOpen.disabled = !state.dir;
      pushLog('info', '开始下载', (evt.title || '') + ' · ' + state.run.total + ' 首 · ' + shortPath(evt.outDir));
      renderProgress();
      updateSelectionUI();
      return;
    }

    if (evt.type === 'track') {
      const done = Number(evt.done) || (state.run.done + 1);
      state.run.done = done;
      if (evt.ok) state.run.ok += 1;
      else state.run.skip += 1;

      const key = state.nameIndex.get(String(evt.source) + ':' + String(evt.name));
      if (key) markRow(key, evt.ok ? 'done' : 'skip');

      pushLog(evt.ok ? 'ok' : 'skip', evt.name, trackNote(evt), evt.ok ? { lyric: evt.lyric, cover: evt.cover } : null);
      els.dlNote.textContent = evt.ok
        ? '正在处理：' + evt.name + '（' + viaLabel(evt) + '）'
        : '跳过：' + evt.name + '（' + (evt.reason || '无法获取直链') + '）';
      renderProgress();
      return;
    }

    if (evt.type === 'done') {
      const summary = evt.summary || {};
      state.running = false;
      if (summary.total) state.run.total = summary.total;
      state.run.done = (summary.success || 0) + (summary.skipped || 0) || state.run.done;

      setDlState(summary.cancelled ? 'warn' : 'ok', summary.cancelled ? '已取消' : '已完成');
      els.dlSub.textContent = '任务结束：成功 ' + (summary.success || 0) + ' 首 · 跳过 ' + (summary.skipped || 0) + ' 首';
      els.btnCancel.disabled = true;
      els.btnOpen.disabled = !summary.outDir;
      pushLog('info', '结束', '成功 ' + (summary.success || 0) + ' · 跳过 ' + (summary.skipped || 0) + ' · ' + fmtMB(summary.totalMB));
      els.dlNote.textContent = '已完成。可在输出目录中查看下载的音频、歌词与封面。';
      renderProgress();
      renderSummary(summary);
      updateSelectionUI();
    }
  }

  /* ------------------------------------------------------------------ *
   * 交互
   * ------------------------------------------------------------------ */

  function selectedSources() {
    return SOURCES.filter(function (s) {
      return state.enabled.has(s.id);
    }).map(function (s) {
      return s.id;
    });
  }

  async function doSearch() {
    const keyword = els.q.value.trim();
    if (!keyword) {
      els.q.focus();
      toast('请输入搜索关键词', 'warn');
      return;
    }
    const sources = selectedSources();
    if (!sources.length) {
      toast('至少选择一个平台', 'warn');
      return;
    }

    state.lastQuery = keyword;
    state.phase = 'loading';
    state.error = '';
    state.items = [];
    state.trackMap = new Map();
    state.selected.clear();
    state.collection = null;
    renderCollectionSlot(null);
    hideSummary();
    renderResults();

    els.btnSearch.disabled = true;
    els.btnSearch.textContent = '搜索中…';

    try {
      const res = await api.search({ keyword: keyword, sources: sources, limit: 20 });
      if (!res || res.ok === false) {
        state.phase = 'error';
        state.error = (res && res.error) || '搜索失败，请稍后重试';
        renderResults();
        return;
      }
      const data = res.data || {};
      const items = Array.isArray(data.items) ? data.items : [];
      state.items = items;
      state.trackMap = new Map(items.map(function (t) { return [keyOf(t), t]; }));
      state.collection = {
        kind: 'search',
        title: '「' + keyword + '」的搜索结果',
        subtitle: sources.length + ' 个平台',
        source: sources[0],
        total: items.length
      };
      state.selected = new Set(items.map(keyOf));
      state.phase = 'ready';
      renderResults();

      if (!items.length) toast('没有找到结果，换个关键词或平台试试', 'warn');
      else toast('找到 ' + items.length + ' 首，已默认全选', 'ok');
    } catch (err) {
      state.phase = 'error';
      state.error = '搜索请求出错：' + errText(err);
      renderResults();
    } finally {
      els.btnSearch.disabled = false;
      els.btnSearch.textContent = '搜索';
    }
  }

  async function doResolve() {
    const input = els.link.value.trim();
    if (!input) {
      els.link.focus();
      toast('请粘贴歌单 / 专辑 / 单曲链接或 ID', 'warn');
      return;
    }

    state.phase = 'loading';
    state.error = '';
    state.items = [];
    state.trackMap = new Map();
    state.selected.clear();
    state.collection = null;
    renderResults();
    hideSummary();

    els.btnResolve.disabled = true;
    els.btnResolve.textContent = '解析中…';

    try {
      const res = await api.resolve({ input: input, source: 'auto' });
      if (!res || res.ok === false) {
        state.phase = 'error';
        state.error = (res && res.error) || '链接解析失败，请检查链接是否正确';
        renderResults();
        return;
      }
      const collection = res.data || {};
      const items = Array.isArray(collection.tracks) ? collection.tracks : [];
      state.items = items;
      state.trackMap = new Map(items.map(function (t) { return [keyOf(t), t]; }));
      state.collection = collection;
      state.selected = new Set(items.map(keyOf));
      state.phase = 'ready';
      renderResults();
      renderCollectionSlot(collection);
      toast('已解析：' + (collection.title || '集合') + ' · ' + items.length + ' 首', 'ok');
    } catch (err) {
      state.phase = 'error';
      state.error = '解析出错：' + errText(err);
      renderResults();
    } finally {
      els.btnResolve.disabled = false;
      els.btnResolve.textContent = '解析';
    }
  }

  async function doCheckSources() {
    if (state.checking) return;
    state.checking = true;
    els.btnCheck.disabled = true;
    els.btnCheck.classList.add('is-loading');
    renderHealth();

    try {
      const res = await api.checkSources();
      if (!res || res.ok === false) throw new Error((res && res.error) || '检测失败');
      const list = Array.isArray(res.data) ? res.data : [];
      const map = {};
      list.forEach(function (item) {
        if (item && item.source) map[item.source] = item;
      });
      state.health = map;

      let bad = 0;
      SOURCES.forEach(function (s) {
        if (!map[s.id] || !map[s.id].ok) bad += 1;
      });
      const pl = (state.plugins && state.plugins.list || []).filter(function (x) { return !x.error; });
      const tail = pl.length ? ' · 音源 ' + pl.length + ' 个' : ' · 未装音源（QQ/酷狗的整首要靠它）';
      if (bad) toast('有 ' + bad + ' 个平台不可用，已标记为红点' + tail, 'warn');
      else toast('6 个平台全部可用' + tail, 'ok');
    } catch (err) {
      state.health = null;
      toast('平台检测失败：' + errText(err), 'error');
    } finally {
      state.checking = false;
      els.btnCheck.disabled = false;
      els.btnCheck.classList.remove('is-loading');
      renderHealth();
    }
  }

  /* ---------------- 自定义音源 ---------------- */

  async function openSourcesDir() {
    try {
      const dir = await api.openSourcesDir();
      toast('已打开音源目录：' + shortPath(String(dir || '')), 'ok');
    } catch (err) {
      toast('打开音源目录失败：' + errText(err), 'error');
    }
  }

  async function initPlugins() {
    if (!api.plugins) return;
    try {
      const res = await api.plugins();
      if (!res || res.ok === false) return;
      const list = (res.data && res.data.list) || [];
      const good = list.filter(function (p) { return !p.error; });
      const plats = [];
      good.forEach(function (p) {
        (p.sources || []).forEach(function (x) {
          if (plats.indexOf(x.source) < 0) plats.push(x.source);
        });
      });
      state.plugins = { list: list, dir: (res.data && res.data.dir) || '' };
      if (els.srcBtnLabel) {
        els.srcBtnLabel.textContent = good.length ? '音源 ' + good.length : '音源';
      }
      if (els.btnSources) {
        els.btnSources.title = good.length
          ? '已加载 ' + good.length + ' 个自定义音源' + (plats.length ? '（' + plats.join('、') + '）' : '') + '\n点击打开目录'
          : '自定义音源：放一个洛雪格式的 .js 进去就能多支持一个平台';
      }
      const bad = list.filter(function (p) { return p.error; });
      if (good.length) toast('已加载 ' + good.length + ' 个自定义音源' + (plats.length ? '：' + plats.join('、') : ''), 'ok');
      if (bad.length) {
        toast('有 ' + bad.length + ' 个音源加载失败：' + bad[0].name + ' → ' + bad[0].error, 'warn');
      }
    } catch (err) { /* 音源是增强项，失败不影响主流程 */ }
  }

  async function chooseDir() {
    try {
      const dir = await api.chooseDir();
      if (typeof dir === 'string' && dir) {
        state.dir = dir;
        renderDir();
        toast('输出目录：' + shortPath(dir), 'ok');
      }
    } catch (err) {
      toast('选择目录失败：' + errText(err), 'error');
    }
  }

  function resetDownloadUI() {
    state.run = { total: 0, done: 0, ok: 0, skip: 0, selected: state.selected.size, title: '' };
    resetLog();
    hideSummary();
    els.dlNote.textContent = '正在准备下载…';
    els.dlSub.textContent = '准备中';
    renderProgress();

    const rows = els.tbody.querySelectorAll('.tr--row');
    for (let i = 0; i < rows.length; i += 1) {
      rows[i].classList.remove('is-done', 'is-skip');
      const cell = rows[i].querySelector('.col-status');
      if (cell) cell.innerHTML = '<span class="st st--wait">待下载</span>';
    }
  }

  async function startDownload() {
    if (state.running) return;
    const picked = state.items.filter(function (t) {
      return state.selected.has(keyOf(t));
    });
    if (!picked.length) {
      toast('请先勾选要下载的歌曲', 'warn');
      return;
    }
    if (!state.dir) {
      toast('请先选择输出目录', 'warn');
      els.btnDir.focus();
      return;
    }

    const opts = {
      title: sanitizeName(
        (state.collection && state.collection.title) || state.lastQuery || '未命名任务'
      ),
      tracks: picked,
      outDir: state.dir,
      br: Number(els.br.value),
      fallback: els.fallback.checked,
      concurrency: Number(els.concurrency.value),
      saveLyric: els.saveLyric.checked,
      saveCover: els.saveCover.checked
    };

    resetDownloadUI();
    state.running = true;
    state.run.total = picked.length;
    state.run.selected = picked.length;
    setDlState('run', '下载中');
    els.dlSub.textContent = '正在下载 · 共 ' + picked.length + ' 首';
    els.btnCancel.disabled = false;
    els.btnOpen.disabled = false;
    updateSelectionUI();
    renderProgress();

    try {
      const res = await api.startDownload(opts);
      if (res && res.ok === false) {
        state.running = false;
        setDlState('err', '失败');
        els.dlSub.textContent = '下载失败';
        els.dlNote.textContent = res.error || '下载失败';
        pushLog('fail', '任务失败', res.error || '未知错误');
        toast('下载失败：' + (res.error || '未知错误'), 'error');
      } else if (res && res.summary && !state.summary) {
        renderSummary(res.summary);
      }
    } catch (err) {
      state.running = false;
      setDlState('err', '失败');
      els.dlSub.textContent = '下载失败';
      pushLog('fail', '任务失败', errText(err));
      toast('下载失败：' + errText(err), 'error');
    } finally {
      state.running = false;
      els.btnCancel.disabled = true;
      updateSelectionUI();
    }
  }

  async function cancelDownload() {
    try {
      await api.cancelDownload();
      state.running = false;
      setDlState('warn', '已取消');
      els.dlSub.textContent = '已取消，已完成的部分会保留';
      els.dlNote.textContent = '任务已取消。';
      els.btnCancel.disabled = true;
      pushLog('info', '已取消', '用户中止了当前下载任务');
      updateSelectionUI();
    } catch (err) {
      toast('取消失败：' + errText(err), 'error');
    }
  }

  async function openDir() {
    const dir = state.dir || (state.summary && state.summary.outDir) || '';
    if (!dir) return;
    try {
      const ok = await api.openDir(dir);
      if (!ok) toast('打开目录失败：' + shortPath(dir), 'error');
    } catch (err) {
      toast('打开目录失败：' + errText(err), 'error');
    }
  }

  function selectAllRows(on) {
    state.selected.clear();
    if (on) {
      state.items.forEach(function (t) {
        state.selected.add(keyOf(t));
      });
    }
    const rows = els.tbody.querySelectorAll('.tr--row');
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const key = row.getAttribute('data-key');
      const checked = state.selected.has(key);
      row.classList.toggle('is-sel', checked);
      row.setAttribute('aria-selected', checked ? 'true' : 'false');
      const input = row.querySelector('input[data-act="pick"]');
      if (input) input.checked = checked;
    }
    updateSelectionUI();
  }

  function toggleKey(key, on, row) {
    if (!key) return;
    if (on) state.selected.add(key);
    else state.selected.delete(key);

    const target = row || state.rowEls.get(key);
    if (target) {
      target.classList.toggle('is-sel', on);
      target.setAttribute('aria-selected', on ? 'true' : 'false');
      const input = target.querySelector('input[data-act="pick"]');
      if (input) input.checked = on;
    }
    updateSelectionUI();
  }

  /* ------------------------------------------------------------------ *
   * 绑定
   * ------------------------------------------------------------------ */

  function cacheEls() {
    els = {
      toasts: $('toasts'),
      health: $('health'),
      btnCheck: $('btnCheck'),
      btnSources: $('btnSources'),
      srcBtnLabel: $('srcBtnLabel'),
      brandLogo: $('brandLogo'),
      version: $('version'),
      q: $('q'),
      btnSearch: $('btnSearch'),
      chips: $('chips'),
      link: $('link'),
      btnResolve: $('btnResolve'),
      resolveSlot: $('resolveSlot'),
      resultTitle: $('hResults'),
      resultSub: $('resultSub'),
      totalPill: $('totalPill'),
      selPill: $('selPill'),
      btnAll: $('btnAll'),
      btnNone: $('btnNone'),
      table: $('table'),
      tbody: $('tbody'),
      chkAll: $('chkAll'),
      br: $('br'),
      concurrency: $('concurrency'),
      saveLyric: $('saveLyric'),
      saveCover: $('saveCover'),
      fallback: $('fallback'),
      dirPath: $('dirPath'),
      btnDir: $('btnDir'),
      btnStart: $('btnStart'),
      dlState: $('dlState'),
      dlSub: $('dlSub'),
      dlNote: $('dlNote'),
      progress: $('progress'),
      progFill: $('progFill'),
      mSel: $('mSel'),
      mDone: $('mDone'),
      mSkip: $('mSkip'),
      mPct: $('mPct'),
      btnCancel: $('btnCancel'),
      btnOpen: $('btnOpen'),
      logList: $('logList'),
      logCount: $('logCount'),
      summary: $('summary'),
      dlCard: $('dlCard')
    };
  }

  function bindEvents() {
    els.btnSearch.addEventListener('click', doSearch);
    els.q.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') doSearch();
    });

    els.btnResolve.addEventListener('click', doResolve);
    els.link.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') doResolve();
    });

    els.chips.addEventListener('click', function (ev) {
      const chip = ev.target.closest('.pl');
      if (!chip) return;
      const id = chip.getAttribute('data-id');
      if (!id) return;
      if (state.enabled.has(id)) {
        if (state.enabled.size === 1) {
          toast('至少保留一个平台', 'warn');
          return;
        }
        state.enabled.delete(id);
      } else {
        state.enabled.add(id);
      }
      chip.classList.toggle('is-on', state.enabled.has(id));
      chip.setAttribute('aria-pressed', state.enabled.has(id) ? 'true' : 'false');
    });

    els.btnCheck.addEventListener('click', doCheckSources);
    if (els.btnSources) els.btnSources.addEventListener('click', openSourcesDir);
    els.btnDir.addEventListener('click', chooseDir);
    els.btnStart.addEventListener('click', startDownload);
    els.btnCancel.addEventListener('click', cancelDownload);
    els.btnOpen.addEventListener('click', openDir);

    /* 完成态下「打开目录」移进汇总卡头部，用事件委托绑定（innerHTML 会被重写） */
    els.summary.addEventListener('click', function (ev) {
      if (ev.target.closest('#btnOpenSum')) openDir();
    });

    els.chkAll.addEventListener('change', function () {
      selectAllRows(els.chkAll.checked);
    });
    els.btnAll.addEventListener('click', function () {
      selectAllRows(true);
    });
    els.btnNone.addEventListener('click', function () {
      selectAllRows(false);
    });

    els.tbody.addEventListener('click', function (ev) {
      const retry = ev.target.closest('[data-act="retry"]');
      if (retry) {
        doSearch();
        return;
      }
      const row = ev.target.closest('.tr--row');
      if (!row) return;
      if (ev.target.closest('.cb')) return;
      const key = row.getAttribute('data-key');
      toggleKey(key, !state.selected.has(key), row);
    });

    els.tbody.addEventListener('change', function (ev) {
      const input = ev.target.closest('input[data-act="pick"]');
      if (!input) return;
      const row = input.closest('.tr--row');
      if (!row) return;
      toggleKey(row.getAttribute('data-key'), input.checked, row);
    });

    els.tbody.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const row = ev.target.closest('.tr--row');
      if (!row || ev.target.closest('input, label, button')) return;
      ev.preventDefault();
      const key = row.getAttribute('data-key');
      toggleKey(key, !state.selected.has(key), row);
    });
  }

  function initVersion() {
    let version = '1.0.0';
    try {
      if (api && typeof api.version === 'string' && api.version) version = api.version;
    } catch (err) {
      version = '1.0.0';
    }
    els.version.textContent = /^[vV]/.test(version) ? version : 'v' + version;
  }

  function initDir() {
    if (typeof api.defaultDir !== 'function') return;
    Promise.resolve()
      .then(function () {
        return api.defaultDir();
      })
      .then(function (dir) {
        if (typeof dir === 'string' && dir && !state.dir) {
          state.dir = dir;
          renderDir();
        }
      })
      .catch(function () {
        /* 目录信息拿不到时留空，由用户点「选择」 */
      });
  }

  function initLogo() {
    const img = els.brandLogo;
    if (!img) return;
    const hide = function () {
      img.classList.add('is-hidden');
    };
    img.addEventListener('error', hide);
    if (img.complete && img.naturalWidth === 0) hide();
  }

  function init() {
    cacheEls();
    renderChips();
    renderHealth();
    bindEvents();
    renderResults();
    renderDir();
    renderProgress();
    resetLog();
    updateSelectionUI();
    initVersion();
    initDir();
    initLogo();
    initPlugins();
    setDlState('idle', '未开始');

    try {
      const off = api.onProgress(handleProgress);
      window.addEventListener('beforeunload', function () {
        if (typeof off === 'function') off();
      });
    } catch (err) {
      toast('进度监听注册失败：' + errText(err), 'error');
    }
  }

  init();

  /* ================================================================== *
   * DEMO MOCK
   * 仅在 window.api 不存在时启用（例如用 Chrome 直接打开 index.html）。
   * 业务逻辑不依赖以下任何内容，删掉这一段也不影响 Electron 内的运行。
   * URL hash 可切换演示状态：#loading / #error / #empty / #run / #done
   * ================================================================== */

  const demoMode = String((window.location && window.location.hash) || '').replace(/^#/, '').toLowerCase();

  const DEMO_TRACKS = [
    { source: 'netease', id: '1901371647', name: '晴天', artists: ['周杰伦'], album: '叶惠美', duration: 269, picUrl: '' },
    { source: 'tencent', id: '0039MnYb0qxYhV', name: '后来', artists: ['刘若英'], album: '我等你', duration: 341, picUrl: '' },
    { source: 'kugou', id: 'kugou_88f2', name: '海阔天空', artists: ['Beyond'], album: '乐与怒', duration: 326, picUrl: '' },
    { source: 'kuwo', id: 'kuwo_71c4', name: '起风了', artists: ['买辣椒也用券'], album: '起风了', duration: 325, picUrl: '' },
    { source: 'migu', id: 'migu_6009', name: '孤勇者', artists: ['陈奕迅'], album: '孤勇者', duration: 256, picUrl: '' },
    { source: 'joox', id: 'joox_20a1', name: '七里香', artists: ['周杰伦'], album: '七里香', duration: 299, picUrl: '' },
    { source: 'netease', id: '1901371648', name: '平凡之路', artists: ['朴树'], album: '猎户星座', duration: 302, picUrl: '' },
    { source: 'tencent', id: '0039MnYb0qxYhW', name: '稻香', artists: ['周杰伦'], album: '魔杰座', duration: 223, picUrl: '' },
    { source: 'netease', id: '1901371649', name: '夜曲', artists: ['周杰伦'], album: '十一月的萧邦', duration: 226, picUrl: '' },
    { source: 'kugou', id: 'kugou_88f3', name: '光年之外', artists: ['邓紫棋'], album: '光年之外', duration: 235, picUrl: '' },
    { source: 'kuwo', id: 'kuwo_71c5', name: '演员', artists: ['薛之谦'], album: '绅士', duration: 255, picUrl: '' },
    { source: 'migu', id: 'migu_6010', name: '岁月神偷', artists: ['金玟岐'], album: '岁月神偷', duration: 251, picUrl: '' },
    { source: 'joox', id: 'joox_20a2', name: '说散就散', artists: ['袁娅维'], album: '说散就散', duration: 218, picUrl: '' },
    { source: 'netease', id: '1901371650', name: '童话', artists: ['光良'], album: '童话', duration: 246, picUrl: '' }
  ];

  const DEMO_PLAYLIST = {
    kind: 'playlist',
    title: '华语流行 · 私人收藏',
    subtitle: '歌单 · 网易云音乐',
    source: 'netease',
    total: DEMO_TRACKS.length
  };

  let demoTimer = null;
  let demoCancelled = false;

  function demoItems() {
    return DEMO_TRACKS.map(function (t) {
      return {
        key: t.source + ':' + t.id,
        source: t.source,
        id: t.id,
        name: t.name,
        artists: t.artists.slice(),
        album: t.album,
        duration: t.duration,
        picUrl: t.picUrl
      };
    });
  }

  function demoHealth() {
    return [
      { source: 'netease', label: '网易云', ok: true, ms: 128, note: '搜索 / 直链正常' },
      { source: 'tencent', label: 'QQ音乐', ok: true, ms: 214, note: '搜索 / 直链正常' },
      { source: 'kugou', label: '酷狗', ok: true, ms: 96, note: '搜索 / 直链正常' },
      { source: 'kuwo', label: '酷我', ok: true, ms: 173, note: '搜索 / 直链正常' },
      { source: 'migu', label: '咪咕', ok: true, ms: 351, note: '搜索正常，部分曲目需补链' },
      { source: 'joox', label: 'JOOX', ok: false, ms: 0, note: '需要登录 Cookie' }
    ];
  }

  function createDemoApi() {
    const listeners = new Set();

    function emit(evt) {
      listeners.forEach(function (cb) {
        try {
          cb(evt);
        } catch (err) {
          /* 演示环境忽略渲染异常 */
        }
      });
    }

    const demoApi = {
      version: '2.3.0-demo',

      onProgress: function (cb) {
        if (typeof cb !== 'function') return function () {};
        listeners.add(cb);
        return function () {
          listeners.delete(cb);
        };
      },

      search: function () {
        if (demoMode === 'loading') return new Promise(function () {});
        if (demoMode === 'error') {
          return Promise.resolve({ ok: false, error: '网易云接口连接超时（ETIMEDOUT，已重试 3 次），其余 5 个平台正常' });
        }
        if (demoMode === 'empty') {
          return Promise.resolve({ ok: true, data: { items: [], bySource: {} } });
        }
        const items = demoItems();
        const bySource = {};
        items.forEach(function (t) {
          bySource[t.source] = (bySource[t.source] || 0) + 1;
        });
        return Promise.resolve({ ok: true, data: { items: items, bySource: bySource } });
      },

      resolve: function () {
        return Promise.resolve({
          ok: true,
          data: {
            kind: DEMO_PLAYLIST.kind,
            title: DEMO_PLAYLIST.title,
            subtitle: DEMO_PLAYLIST.subtitle,
            source: DEMO_PLAYLIST.source,
            total: DEMO_PLAYLIST.total,
            tracks: demoItems()
          }
        });
      },

      checkSources: function () {
        return Promise.resolve({ ok: true, data: demoHealth() });
      },

      plugins: function () {
        return Promise.resolve({ ok: true, data: { list: [], dir: 'C:D\\Users\\你\\AppData\\Roaming\\windtune\\sources' } });
      },

      openSourcesDir: function () {
        return Promise.resolve('(demo) 音源目录');
      },

      chooseDir: function () {
        return Promise.resolve('D:\\Music\\全平台下载');
      },

      defaultDir: function () {
        return 'D:\\Music\\全平台下载';
      },

      startDownload: function (opts) {
        const tracks = (opts && opts.tracks) || [];
        const total = tracks.length;
        const outDir = (opts && opts.outDir) || 'D:\\Music\\全平台下载';
        const title = (opts && opts.title) || DEMO_PLAYLIST.title;

        demoCancelled = false;
        emit({ type: 'start', title: title, total: total, outDir: outDir });

        const plan = tracks.map(function (track, index) {
          const skip = demoMode === 'done' ? (index === 3 || index === 9) : (index % 7 === 6);
          const br = index % 6 === 0 ? 999 : (index % 5 === 4 ? 192 : 320);
          /* QQ / 酷狗 / JOOX 多数取不到直链，演示跨平台补链到网易云或酷我 */
          const needFallback = track.source === 'tencent' || track.source === 'kugou' || track.source === 'joox';
          return {
            track: track,
            skip: skip,
            br: skip ? 0 : br,
            via: skip ? '' : (needFallback ? (index % 2 === 0 ? 'netease' : 'kuwo') : track.source),
            lyric: !skip && index % 5 !== 3,
            cover: !skip && index % 4 !== 2,
            bytes: skip ? 0 : Math.round((5.2 + (index % 5) * 0.9) * 1048576),
            reason: track.source === 'joox' ? '需要登录 Cookie，无法获取直链' : '版权受限，本平台取不到直链'
          };
        });

        const results = [];

        function emitOne(index) {
          const item = plan[index];
          const evt = {
            type: 'track',
            done: index + 1,
            total: total,
            ok: !item.skip,
            name: item.track.name,
            source: item.track.source,
            via: item.via,
            br: item.br,
            bytes: item.bytes,
            ext: 'mp3',
            lyric: item.lyric,
            cover: item.cover,
            reason: item.skip ? item.reason : ''
          };
          results.push({
            ok: evt.ok,
            br: evt.br,
            bytes: evt.bytes,
            source: evt.source,
            via: evt.via,
            name: evt.name,
            reason: evt.reason,
            lyric: evt.lyric,
            cover: evt.cover
          });
          emit(evt);
        }

        function buildSummary(cancelled) {
          const done = results.slice();
          const okItems = done.filter(function (r) { return r.ok; });
          const skipItems = done.filter(function (r) { return !r.ok; });
          const bytes = okItems.reduce(function (sum, r) { return sum + (r.bytes || 0); }, 0);
          const bitrate = {};
          const sources = {};
          const vias = {};
          okItems.forEach(function (r) {
            const key = String(r.br || 0);
            bitrate[key] = (bitrate[key] || 0) + 1;
            sources[r.source] = (sources[r.source] || 0) + 1;
            const viaKey = r.via || r.source;
            vias[viaKey] = (vias[viaKey] || 0) + 1;
          });
          return {
            title: title,
            total: total,
            success: okItems.length,
            skipped: skipItems.length,
            lyricCount: okItems.filter(function (r) { return r.lyric; }).length,
            coverCount: okItems.filter(function (r) { return r.cover; }).length,
            totalMB: Math.round((bytes / 1048576) * 10) / 10,
            outDir: outDir,
            cancelled: !!cancelled,
            bitrateDistribution: bitrate,
            sourceDistribution: sources,
            viaDistribution: vias,
            skippedList: skipItems.map(function (r) {
              return { name: r.name, source: r.source, reason: r.reason };
            })
          };
        }

        if (demoMode === 'run') {
          for (let i = 0; i < Math.min(6, plan.length); i += 1) emitOne(i);
          /* 停在中途，方便截图查看进行中的状态 */
          return new Promise(function () {});
        }

        if (demoMode === 'done') {
          for (let i = 0; i < plan.length; i += 1) emitOne(i);
          const summary = buildSummary(false);
          emit({ type: 'done', summary: summary });
          return Promise.resolve({ ok: true, summary: summary });
        }

        return new Promise(function (resolve) {
          let index = 0;
          const step = function () {
            demoTimer = null;
            if (demoCancelled) {
              const summary = buildSummary(true);
              emit({ type: 'done', summary: summary });
              resolve({ ok: true, summary: summary });
              return;
            }
            if (index >= plan.length) {
              const summary = buildSummary(false);
              emit({ type: 'done', summary: summary });
              resolve({ ok: true, summary: summary });
              return;
            }
            emitOne(index);
            index += 1;
            demoTimer = setTimeout(step, 260 + Math.random() * 220);
          };
          demoTimer = setTimeout(step, 220);
        });
      },

      cancelDownload: function () {
        demoCancelled = true;
        if (demoTimer) {
          clearTimeout(demoTimer);
          demoTimer = null;
        }
        return Promise.resolve(true);
      },

      openDir: function () {
        return Promise.resolve(true);
      }
    };

    return demoApi;
  }

  function bootDemo() {
    Promise.resolve().then(function () {
      const dir = demoApiDir();
      if (dir) {
        state.dir = dir;
        renderDir();
      }

      if (demoMode !== 'loading' && demoMode !== 'error') doCheckSources();

      els.q.value = demoMode === 'empty' ? '不存在的歌曲' : '华语流行';
      doSearch().then(function () {
        /* 演示时留两首不勾选，便于一眼看出「选中 / 未选中」两种行样式 */
        if (demoMode !== 'empty') {
          [5, 12].forEach(function (index) {
            const rows = els.tbody.querySelectorAll('.tr--row');
            if (rows[index]) rows[index].click();
          });
        }
        if (demoMode === 'run' || demoMode === 'done') {
          if (!els.btnStart.disabled) els.btnStart.click();
        }
      }).catch(function () {
        /* 演示环境忽略 */
      });
    });
  }

  function demoApiDir() {
    try {
      const dir = api.defaultDir && api.defaultDir();
      return typeof dir === 'string' ? dir : '';
    } catch (err) {
      return '';
    }
  }

  if (!window.api) bootDemo();

})();
