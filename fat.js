/* FAT 테스트 (XY repeatability) — same rules as 「트랙 FTA 양식_최종.xlsx」 결과값 sheet.
   Everything runs in the browser; the pasted/selected log is never sent or stored. */
(function (root) {
  'use strict';

  // ===================== core (pure, also used by node tests) =====================
  const NUM_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
  const num = (s) => { const t = String(s == null ? '' : s).trim(); return NUM_RE.test(t) ? Number(t) : null; };
  const afterColon = (s) => { const m = String(s).split(':'); return m.length > 1 ? num(m.slice(1).join(':')) : null; };

  // last FirstPoint line (4th field) .. end; X/Y = 5th/6th field, both numeric
  function parseLog(text) {
    const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
    let start = -1, target = null, resolution = null;
    for (let i = 0; i < lines.length; i++) {
      const f = lines[i].split(',');
      const d = (f[3] || '').trim();
      if (d === 'FirstPoint') start = i;
      if (d.startsWith('TargetArear')) { const v = afterColon(d); if (v !== null) target = v; }
      if (d.startsWith('Resolution')) { const v = afterColon(d); if (v !== null) resolution = v; }
    }
    const points = [];
    if (start >= 0) {
      for (let i = start; i < lines.length; i++) {
        const f = lines[i].split(',');
        const x = num(f[4]), y = num(f[5]);
        if (x !== null && y !== null) points.push({ x, y, line: i + 1 });
      }
    }
    return { lineCount: lines.length, startLine: start >= 0 ? start + 1 : null, target, resolution, points };
  }

  // convex hull (monotone chain); the farthest point from any point is always a hull vertex
  function hull(pts) {
    const p = pts.map((q, i) => [q.x, q.y, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    lo.pop(); up.pop();
    return lo.concat(up);
  }

  function compute(pts, radius) {
    const n = pts.length;
    if (!n) return null;
    let sx = 0, sy = 0, xmax = -Infinity, xmin = Infinity, ymax = -Infinity, ymin = Infinity;
    for (const p of pts) { sx += p.x; sy += p.y; if (p.x > xmax) xmax = p.x; if (p.x < xmin) xmin = p.x; if (p.y > ymax) ymax = p.y; if (p.y < ymin) ymin = p.y; }
    const mx = sx / n, my = sy / n;
    const H = hull(pts);
    const cx = (xmax + xmin) / 2, cy = (ymax + ymin) / 2;
    let vmin = Infinity, vmax = -Infinity, pp = 0;
    const rows = pts.map((p, i) => {
      const vec = Math.sqrt(p.x * p.x + p.y * p.y);
      let md = 0;
      for (const h of H) { const dx = p.x - h[0], dy = p.y - h[1]; const d = Math.sqrt(dx * dx + dy * dy); if (d > md) md = d; }
      const dxc = p.x - cx, dyc = p.y - cy;
      const cd = Math.sqrt(dxc * dxc + dyc * dyc);
      if (vec < vmin) vmin = vec; if (vec > vmax) vmax = vec; if (md > pp) pp = md;
      return { idx: i + 1, x: p.x, y: p.y, vec, maxd: md, cdist: cd, out: cd > radius };
    });
    const outs = rows.filter(r => r.out);
    // chart axis (same for X and Y)
    const lo = Math.min(0, xmin, ymin, cx - radius, cy - radius), hi = Math.max(0, xmax, ymax, cx + radius, cy + radius);
    const axMin = lo < 0 ? lo - 0.05 * (hi - lo) : 0, axMax = hi > 0 ? hi + 0.05 * (hi - lo) : 0;
    const circle = [];
    for (let a = 5; a <= 360; a += 5) circle.push([cx + radius * Math.cos(a * Math.PI / 180), cy + radius * Math.sin(a * Math.PI / 180)]);
    circle.push(circle[0]); // 73 points
    return {
      n, avg: Math.sqrt(mx * mx + my * my), vmin, vmax, pp,
      xmax, xmin, xpp: xmax - xmin, ymax, ymin, ypp: ymax - ymin, cx, cy, radius,
      rows, outs, axMin, axMax, circle,
    };
  }

  const core = { parseLog, compute, hull };
  if (typeof module !== 'undefined' && module.exports) { module.exports = core; return; }
  root.FatCore = core;

  // ===================== UI =====================
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const f6 = (v) => (v == null || !isFinite(v) ? '-' : (Math.round(v * 1e6) / 1e6).toFixed(6));
  const f2 = (v) => (v == null || !isFinite(v) ? '-' : (Math.round(v * 100) / 100).toFixed(2));
  const LSK = 'track.fat.cond';
  const COND = [['xs', 'X-axis', '2400', 'mm/s'], ['ts', 'T-axis', '450', 'deg/s'], ['zs', 'Z-axis', '1200', 'mm/s'], ['ys', 'Y-axis', '2000', 'mm/s']];
  const S = { meta: null, orig: [], pts: [], undo: [], res: null, sel: new Set(), sort: { k: 'idx', d: 1 }, outOnly: false, radius: 50, cond: {}, name: '' };
  try { const c = JSON.parse(localStorage.getItem(LSK) || '{}'); S.cond = c; if (c.radius) S.radius = Number(c.radius) || 50; S.excelAxis = !!c.excelAxis; } catch (_) { /* storage blocked */ }
  const saveCond = () => { try { localStorage.setItem(LSK, JSON.stringify(Object.assign({}, S.cond, { radius: S.radius, excelAxis: !!S.excelAxis }))); } catch (_) { /* ignore */ } };
  const toast = (m, err) => { const t = $('#toast'); if (!t) return; t.textContent = m; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2600); };

  function view() { return $('#viewFat'); }
  function build() {
    const v = view(); if (!v || v.dataset.built) return; v.dataset.built = '1';
    v.innerHTML = `
      <div class="fat-grid">
        <section class="fat-card fat-in">
          <div class="fat-h"><h3>로그 입력</h3>
            <label class="btn fat-file" title="파일은 이 브라우저 안에서만 읽습니다 (서버 전송 없음)"><input type="file" id="fatFile" accept=".log,.txt,.csv,text/plain" hidden>파일 선택</label>
            <button class="btn ghost" id="fatReset">데이터 초기화</button></div>
          <textarea id="fatText" class="fat-ta" spellcheck="false" placeholder="측정 로그(.log) 내용을 여기에 붙여넣으세요.&#10;마지막 FirstPoint 줄부터 끝까지 자동으로 계산합니다.&#10;로그는 이 브라우저 안에서만 계산되고 저장·전송되지 않습니다."></textarea>
          <div class="fat-meta" id="fatMeta"></div>
          <div class="fat-cond">
            <div class="fat-sub">TEST CONDITION</div>
            <div class="fat-cg">${COND.map(([k, l, d, u]) => `<label><span>${l}</span><input class="in" data-cond="${k}" value="${esc(S.cond[k] ?? d)}"><em>${u}</em></label>`).join('')}
              <label><span>기준원 반경</span><input class="in" id="fatRadius" type="number" step="any" min="0" value="${S.radius}"><em>um</em></label></div>
          </div>
        </section>
        <section class="fat-card fat-chart">
          <div class="fat-h"><h3>XY Repeatability</h3><span class="fat-name" id="fatName"></span>
            <label class="fat-chk fat-ax" title="엑셀 결과값 시트와 같은 축 범위(0 포함)로 보기"><input type="checkbox" id="fatExcelAx" ${S.excelAxis ? 'checked' : ''}> 엑셀 축</label><button class="btn" id="fatPng" disabled>그래프 PNG</button><button class="btn" id="fatXlsx" disabled>엑셀</button></div>
          <div class="fat-cv"><canvas id="fatCanvas" aria-label="XY Repeatability 산점도 — 점을 누르면 Index 표시"></canvas><div class="fat-empty" id="fatEmpty">로그를 붙여넣으면 그래프가 표시됩니다</div></div>
          <div class="fat-pick" id="fatPick" hidden></div>
          <div class="fat-lg"><span><i class="d b"></i>Measured</span><span><i class="l"></i>Reference circle</span><span><i class="d r"></i>Outside circle</span><span><i class="d s"></i>선택(체크)</span></div>
        </section>
        <section class="fat-card fat-res"><div class="fat-h"><h3>결과</h3></div><div class="fat-sum" id="fatSum"></div></section>
      <section class="fat-card fat-meas">
        <div class="fat-h"><h3>측정값</h3>
          <label class="fat-chk"><input type="checkbox" id="fatOutOnly"> OUT만 보기</label>
          <span class="fat-sp"></span>
          <button class="btn" id="fatDelSel" disabled>선택 삭제</button>
          <button class="btn danger-o" id="fatDelOut" disabled>OUT 전체 삭제</button>
          <button class="btn ghost" id="fatUndo" disabled>되돌리기</button>
          <button class="btn ghost" id="fatRestore" disabled>원본으로 복원</button></div>
        <div class="fat-warn">OUT을 삭제하면 기준원 중심이 바뀌어 새로운 OUT이 생길 수 있습니다. 삭제 후 결과를 다시 확인하세요.</div>
        <div class="fat-tbl" id="fatTbl"><div class="fat-th" id="fatTh"></div><div class="fat-vp" id="fatVp"><div class="fat-sz" id="fatSz"></div><div class="fat-rows" id="fatRows"></div></div></div>
      </section>
      </div>`;
    bind();
    renderAll();
  }

  // ---------- calculation ----------
  function loadText(text, name) {
    const m = parseLog(text);
    S.meta = m; S.name = name || '';
    S.orig = m.points.map(p => ({ x: p.x, y: p.y }));
    S.pts = S.orig.slice(); S.undo = []; S.sel.clear();
    recalc();
  }
  function recalc() { S.res = S.pts.length ? compute(S.pts, S.radius) : null; if (S.focus && S.focus > S.pts.length) S.focus = null; S.sel.forEach(i => { if (i > S.pts.length) S.sel.delete(i); }); renderAll(); }
  function mutatePts(keepIdx, msg) { // keepIdx: Set of 1-based indexes to remove
    if (!keepIdx.size) return;
    S.undo.push(S.pts); if (S.undo.length > 50) S.undo.shift();
    S.pts = S.pts.filter((p, i) => !keepIdx.has(i + 1));
    S.sel.clear(); S.focus = null; recalc(); toast(msg);
  }

  // ---------- render ----------
  function renderAll() { renderMeta(); renderSum(); drawChart(); renderTable(); renderButtons(); }
  function renderMeta() {
    const m = S.meta;
    $('#fatMeta').innerHTML = !m ? '' : !m.startLine ? '<div class="fat-bad">FirstPoint 줄을 찾지 못했습니다. 로그 전체를 붙여넣었는지 확인하세요.</div>'
      : [['TargetArear', m.target ?? '-'], ['Resolution', m.resolution ?? '-'], ['시작 줄 (FirstPoint)', m.startLine + '번째 줄'], ['RAW 데이터 수', m.points.length], ['사용 데이터 수', S.pts.length]]
        .map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('');
    $('#fatName').textContent = S.name;
  }
  function renderSum() {
    const r = S.res;
    if (!r) { $('#fatSum').innerHTML = '<div class="fat-none">결과가 여기에 표시됩니다</div>'; return; }
    const card = (k, v, cls) => `<div class="fs ${cls || ''}"><span>${k}</span><b>${v}</b></div>`;
    $('#fatSum').innerHTML = `
      <div class="fs-row">${card('Average Vector', f6(r.avg))}${card('Min Vector', f6(r.vmin))}${card('Max Vector', f6(r.vmax))}${card('P-P Diameter', f6(r.pp), 'key')}${card('OUT Count', r.outs.length, r.outs.length ? 'bad' : 'ok')}</div>
      <div class="fs-grid">
        <table class="fs-t"><thead><tr><th></th><th>MAX</th><th>MIN</th><th>P-P</th></tr></thead><tbody>
          <tr><th>X</th><td>${f2(r.xmax)}</td><td>${f2(r.xmin)}</td><td>${f6(r.xpp)}</td></tr>
          <tr><th>Y</th><td>${f2(r.ymax)}</td><td>${f2(r.ymin)}</td><td>${f6(r.ypp)}</td></tr></tbody></table>
        <table class="fs-t"><tbody><tr><th>기준원 중심 X</th><td>${f6(r.cx)}</td></tr><tr><th>기준원 중심 Y</th><td>${f6(r.cy)}</td></tr><tr><th>반경</th><td>${esc(r.radius)} um</td></tr></tbody></table>
        <div class="fs-out"><div class="fat-sub">OUT 목록 (${r.outs.length})</div>${r.outs.length ? `<table class="fs-t"><thead><tr><th>Index</th><th>X</th><th>Y</th><th>Center dist</th></tr></thead><tbody>${r.outs.map(o => `<tr><td>${o.idx}</td><td>${f2(o.x)}</td><td>${f2(o.y)}</td><td>${f6(o.cdist)}</td></tr>`).join('')}</tbody></table>` : '<div class="fat-none">기준원 밖 점 없음</div>'}</div>
      </div>`;
  }
  function renderButtons() {
    const r = S.res;
    $('#fatPng').disabled = !r; $('#fatXlsx').disabled = !r;
    $('#fatDelSel').disabled = !S.sel.size; $('#fatDelSel').textContent = S.sel.size ? `선택 삭제 (${S.sel.size})` : '선택 삭제';
    $('#fatDelOut').disabled = !(r && r.outs.length);
    $('#fatUndo').disabled = !S.undo.length; $('#fatRestore').disabled = !(S.meta && S.pts.length !== S.orig.length) && !S.undo.length;
  }

  // ---------- chart (canvas) ----------
  function niceStep(span, target) { const raw = span / target; const p = Math.pow(10, Math.floor(Math.log10(raw))); const m = raw / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p; }
  function drawTo(ctx, W, Hh, r, opt) {
    const css = getComputedStyle(document.documentElement);
    const col = (k, d) => (css.getPropertyValue(k) || '').trim() || d;
    const fg = opt.print ? '#1b1f27' : col('--text', '#1b1f27'), fg2 = opt.print ? '#5b6372' : col('--text-2', '#5b6372'), grid = opt.print ? '#e3e6ec' : col('--line', '#e3e6ec');
    const font = '"Pretendard Variable", Pretendard, system-ui, sans-serif';
    ctx.fillStyle = opt.print ? '#fff' : 'transparent'; if (opt.print) ctx.fillRect(0, 0, W, Hh);
    const padL = 64, padB = 48, padT = opt.title ? 46 : 14, padR = 18;
    const side = Math.min(W - padL - padR, Hh - padT - padB);
    const ox = padL + Math.max(0, (W - padL - padR - side) / 2), oy = padT;
    // axes: 'fit' = zoomed to points + reference circle (equal scale), 'excel' = 결과값 sheet range (incl. 0)
    let x0, y0, span;
    if (opt.excel) { x0 = y0 = r.axMin; span = (r.axMax - r.axMin) || 1; }
    else {
      const xl = Math.min(r.xmin, r.cx - r.radius), xh = Math.max(r.xmax, r.cx + r.radius), yl = Math.min(r.ymin, r.cy - r.radius), yh = Math.max(r.ymax, r.cy + r.radius);
      span = (Math.max(xh - xl, yh - yl) || 1) * 1.08; x0 = (xl + xh) / 2 - span / 2; y0 = (yl + yh) / 2 - span / 2;
    }
    const sx = v => ox + (v - x0) / span * side, sy = v => oy + side - (v - y0) / span * side;
    if (opt.title) { ctx.fillStyle = fg; ctx.font = `700 17px ${font}`; ctx.textAlign = 'center'; ctx.fillText(opt.title, ox + side / 2, 28); }
    const step = niceStep(span, side < 420 ? 5 : 8);
    ctx.font = `12px ${font}`; ctx.lineWidth = 1;
    for (let t = Math.ceil(x0 / step) * step; t <= x0 + span + 1e-9; t += step) {
      const X = sx(t); ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(X, oy); ctx.lineTo(X, oy + side); ctx.stroke();
      ctx.fillStyle = fg2; ctx.textAlign = 'center'; ctx.fillText(t.toFixed(1), X, oy + side + 16);
    }
    for (let t = Math.ceil(y0 / step) * step; t <= y0 + span + 1e-9; t += step) {
      const Y = sy(t); ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(ox, Y); ctx.lineTo(ox + side, Y); ctx.stroke();
      ctx.fillStyle = fg2; ctx.textAlign = 'right'; ctx.fillText(t.toFixed(1), ox - 6, Y + 4);
    }
    ctx.strokeStyle = fg2; ctx.strokeRect(ox, oy, side, side);
    ctx.fillStyle = fg; ctx.font = `600 13px ${font}`; ctx.textAlign = 'center'; ctx.fillText('X (um)', ox + side / 2, oy + side + 38);
    ctx.save(); ctx.translate(16, oy + side / 2); ctx.rotate(-Math.PI / 2); ctx.fillText('Y (um)', 0, 0); ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.rect(ox, oy, side, side); ctx.clip();
    const dot = Math.max(2.2, Math.min(opt.excel ? 4 : 5, side / 150));
    ctx.fillStyle = '#2f6bff'; ctx.globalAlpha = r.n > 2000 ? 0.55 : 0.85;
    for (const p of r.rows) { ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), dot, 0, Math.PI * 2); ctx.fill(); }
    ctx.globalAlpha = 1; ctx.strokeStyle = '#16a34a'; ctx.lineWidth = 2; ctx.beginPath();
    r.circle.forEach(([x, y], i) => (i ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y)))); ctx.stroke();
    ctx.fillStyle = '#e5484d'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
    for (const p of r.outs) { ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), dot + 1.4, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    // checked rows (table) → orange rings
    if (opt.sel && opt.sel.size) {
      ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 2.2;
      for (const p of r.rows) if (opt.sel.has(p.idx)) { ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), dot + 4, 0, Math.PI * 2); ctx.stroke(); }
    }
    ctx.restore();
    // focused point (row click / chart click) → crosshair ring + index label
    const f = opt.focus ? r.rows[opt.focus - 1] : null;
    if (f) {
      const X = sx(f.x), Y = sy(f.y);
      ctx.strokeStyle = fg; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(X, Y, dot + 6, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = fg2; ctx.globalAlpha = .5; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(ox, Y); ctx.lineTo(ox + side, Y); ctx.moveTo(X, oy); ctx.lineTo(X, oy + side); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
      const t = `#${f.idx}`; ctx.font = `800 12px ${font}`; const tw = ctx.measureText(t).width + 12;
      let lx = X + dot + 8, ly = Y - 22; if (lx + tw > ox + side) lx = X - dot - 8 - tw; if (ly < oy) ly = Y + 8;
      ctx.fillStyle = f.out ? '#e5484d' : '#2f6bff'; ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(lx, ly, tw, 18, 5); else ctx.rect(lx, ly, tw, 18); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.fillText(t, lx + 6, ly + 13);
    }
    return { ox, oy, side, sx, sy };
  }
  function drawChart() {
    const cv = $('#fatCanvas'); if (!cv) return;
    const box = cv.parentElement; const w = box.clientWidth; if (!w) return;
    const h = Math.min(w, Math.max(300, Math.min(440, window.innerHeight - 330)));
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.width = w + 'px'; cv.style.height = h + 'px';
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    $('#fatEmpty').hidden = !!S.res;
    S.view = S.res ? drawTo(ctx, w, h, S.res, { excel: S.excelAxis, sel: S.sel, focus: S.focus }) : null;
    renderPick();
  }
  // chart ↔ table link
  function renderPick() {
    const el = $('#fatPick'); if (!el) return;
    const f = S.res && S.focus ? S.res.rows[S.focus - 1] : null;
    el.hidden = !f;
    if (f) el.innerHTML = `<b>선택한 점 · Index ${f.idx}</b><span>X ${f2(f.x)}</span><span>Y ${f2(f.y)}</span><span>Center dist ${f6(f.cdist)}</span><span class="${f.out ? 'rb' : 'rg'}">${f.out ? 'OUT' : 'OK'}</span><button type="button" class="fp-x" aria-label="선택 해제">✕</button>`;
  }
  function nearest(ev) {
    if (!S.view || !S.res) return null;
    const rc = $('#fatCanvas').getBoundingClientRect(); const mx = ev.clientX - rc.left, my = ev.clientY - rc.top;
    let best = null, bd = 12 * 12;
    for (const p of S.res.rows) { const dx = S.view.sx(p.x) - mx, dy = S.view.sy(p.y) - my, d = dx * dx + dy * dy; if (d <= bd) { bd = d; best = p; } }
    return best;
  }
  function focusPoint(idx, scroll) {
    S.focus = idx || null; drawChart();
    if (!idx) { paintRows(); return; }
    let pos = viewRows.findIndex(x => x.idx === idx);
    if (pos < 0 && S.outOnly) { S.outOnly = false; $('#fatOutOnly').checked = false; renderTable(); pos = viewRows.findIndex(x => x.idx === idx); }
    if (scroll && pos >= 0) { const vp = $('#fatVp'); vp.scrollTop = Math.max(0, pos * RH - vp.clientHeight / 2 + RH / 2); }
    paintRows();
  }

  // ---------- virtual table ----------
  const COLS = [['idx', 'Index'], ['x', 'X'], ['y', 'Y'], ['vec', 'Vector'], ['maxd', 'Max distance'], ['cdist', 'Center dist'], ['out', 'Result']];
  const RH = 30;
  let viewRows = [];
  function renderTable() {
    const r = S.res;
    const rows = r ? (S.outOnly ? r.outs.slice() : r.rows.slice()) : [];
    const { k, d } = S.sort;
    rows.sort((a, b) => ((k === 'out' ? (a.out - b.out) : (a[k] - b[k])) || (a.idx - b.idx)) * d);
    viewRows = rows;
    const allOn = rows.length > 0 && rows.every(x => S.sel.has(x.idx));
    $('#fatTh').innerHTML = `<div class="c ck"><input type="checkbox" id="fatAll" ${allOn ? 'checked' : ''} aria-label="전체 선택"></div>` + COLS.map(([kk, l]) => `<button class="c s" data-sort="${kk}">${l}${S.sort.k === kk ? (S.sort.d > 0 ? ' ▲' : ' ▼') : ''}</button>`).join('');
    $('#fatSz').style.height = (rows.length * RH) + 'px';
    if (!rows.length) { $('#fatRows').innerHTML = `<div class="fat-none" style="padding:18px">${r ? 'OUT 데이터가 없습니다' : '데이터가 없습니다'}</div>`; return; }
    paintRows();
  }
  function paintRows() {
    const vp = $('#fatVp'); const top = vp.scrollTop; const h = vp.clientHeight || 420;
    const a = Math.max(0, Math.floor(top / RH) - 10), b = Math.min(viewRows.length, Math.ceil((top + h) / RH) + 10);
    const box = $('#fatRows'); box.style.transform = `translateY(${a * RH}px)`;
    box.innerHTML = viewRows.slice(a, b).map(x => `<div class="fr ${x.out ? 'o' : ''} ${S.sel.has(x.idx) ? 'on' : ''} ${S.focus === x.idx ? 'fx' : ''}" data-row="${x.idx}"><div class="c ck"><input type="checkbox" data-i="${x.idx}" ${S.sel.has(x.idx) ? 'checked' : ''}></div><div class="c">${x.idx}</div><div class="c">${f2(x.x)}</div><div class="c">${f2(x.y)}</div><div class="c">${f6(x.vec)}</div><div class="c">${f6(x.maxd)}</div><div class="c">${f6(x.cdist)}</div><div class="c"><span class="${x.out ? 'rb' : 'rg'}">${x.out ? 'OUT' : 'OK'}</span></div></div>`).join('');
  }

  // ---------- export ----------
  const stamp = () => { const d = new Date(); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; };
  const baseName = () => (S.name ? S.name.replace(/\.[^.]+$/, '') : 'FAT_TEST');
  function download(blob, name) { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000); }
  function exportPng() {
    const r = S.res; if (!r) return;
    const W = 1400, H = 960, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    drawTo(ctx, 920, H, r, { print: true, excel: S.excelAxis, title: 'XY Repeatability' + (S.name ? ' — ' + S.name : '') });
    const font = '"Pretendard Variable", Pretendard, system-ui, sans-serif';
    let y = 70; const x0 = 950;
    const line = (k, v, b) => { ctx.fillStyle = '#5b6372'; ctx.font = `13px ${font}`; ctx.textAlign = 'left'; ctx.fillText(k, x0, y); ctx.fillStyle = '#1b1f27'; ctx.font = `${b ? 800 : 600} 15px ${font}`; ctx.textAlign = 'right'; ctx.fillText(String(v), W - 40, y); y += 28; };
    ctx.fillStyle = '#1b1f27'; ctx.font = `800 16px ${font}`; ctx.textAlign = 'left'; ctx.fillText('RESULT', x0, 44);
    line('Average Vector', f6(r.avg)); line('Min Vector', f6(r.vmin)); line('Max Vector', f6(r.vmax)); line('P-P Diameter', f6(r.pp), true);
    line('X MAX / MIN', `${f2(r.xmax)} / ${f2(r.xmin)}`); line('X P-P', f6(r.xpp)); line('Y MAX / MIN', `${f2(r.ymax)} / ${f2(r.ymin)}`); line('Y P-P', f6(r.ypp));
    line('Center (X, Y)', `${f6(r.cx)}, ${f6(r.cy)}`); line('Radius (um)', r.radius); line('OUT Count', r.outs.length, true);
    line('Used / RAW points', `${S.pts.length} / ${S.meta ? S.meta.points.length : '-'}`);
    if (S.meta) { line('TargetArear', S.meta.target ?? '-'); line('Resolution', S.meta.resolution ?? '-'); }
    y += 10; ctx.fillStyle = '#1b1f27'; ctx.font = `800 16px ${font}`; ctx.textAlign = 'left'; ctx.fillText('TEST CONDITION', x0, y); y += 28;
    COND.forEach(([k, l, d, u]) => line(l, `${S.cond[k] ?? d} ${u}`));
    cv.toBlob(b => { download(b, `${baseName()}_XY_${stamp()}.png`); toast('그래프 이미지를 저장했습니다'); }, 'image/png');
  }
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'; s.onload = () => res(window.XLSX); s.onerror = () => rej(new Error('엑셀 모듈을 불러오지 못했습니다')); document.head.appendChild(s); });
  }
  async function exportXlsx() {
    const r = S.res; if (!r) return;
    const btn = $('#fatXlsx'); btn.disabled = true; btn.textContent = '생성 중…';
    try {
      const X = await loadXlsx();
      const R6 = v => Math.round(v * 1e6) / 1e6;
      const sum = [
        ['XY Repeatability 결과', S.name || ''], [],
        ['Average Vector', R6(r.avg)], ['Min Vector', R6(r.vmin)], ['Max Vector', R6(r.vmax)], ['P-P Diameter', R6(r.pp)], [],
        ['', 'MAX', 'MIN', 'P-P'], ['X', r.xmax, r.xmin, R6(r.xpp)], ['Y', r.ymax, r.ymin, R6(r.ypp)], [],
        ['기준원 중심 X', R6(r.cx)], ['기준원 중심 Y', R6(r.cy)], ['반경 (um)', r.radius], ['OUT Count', r.outs.length], [],
        ['TargetArear', S.meta ? S.meta.target : ''], ['Resolution', S.meta ? S.meta.resolution : ''], ['Data Start Row (마지막 FirstPoint)', S.meta ? S.meta.startLine : ''], ['RAW Points', S.meta ? S.meta.points.length : ''], ['Used Points', S.pts.length], [],
        ['TEST CONDITION'], ...COND.map(([k, l, d, u]) => [l, `${S.cond[k] ?? d} ${u}`]), [],
        ['OUT 목록'], ['Index', 'X', 'Y', 'Center dist'], ...r.outs.map(o => [o.idx, o.x, o.y, R6(o.cdist)]),
      ];
      const meas = [['Index', 'X', 'Y', 'Vector', 'Max distance', 'Center dist', 'Result'], ...r.rows.map(x => [x.idx, x.x, x.y, R6(x.vec), R6(x.maxd), R6(x.cdist), x.out ? 'OUT' : 'OK'])];
      const circ = [['Angle', 'X', 'Y'], ...r.circle.map(([x, y], i) => [i < 72 ? (i + 1) * 5 : 5, R6(x), R6(y)])];
      const wb = X.utils.book_new();
      const add = (aoa, name, w) => { const ws = X.utils.aoa_to_sheet(aoa); ws['!cols'] = w.map(c => ({ wch: c })); X.utils.book_append_sheet(wb, ws, name); };
      add(sum, '결과값', [34, 16, 16, 16]); add(meas, '측정값', [8, 10, 10, 14, 14, 14, 8]); add(circ, '기준원', [8, 14, 14]);
      const out = X.write(wb, { bookType: 'xlsx', type: 'array' });
      download(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${baseName()}_결과_${stamp()}.xlsx`);
      toast('엑셀 파일을 저장했습니다');
    } catch (e) { toast(e.message, true); }
    btn.disabled = false; btn.textContent = '엑셀';
  }

  // ---------- dialogs ----------
  function confirmBox(title, msg) {
    return new Promise(res => {
      const ov = document.createElement('div'); ov.className = 'overlay'; ov.style.zIndex = '90';
      ov.innerHTML = `<div class="sheet narrow" role="dialog" aria-modal="true"><div class="sheet-head"><div><h2>${esc(title)}</h2></div></div><div class="sheet-body"><p style="margin:0 0 4px;line-height:1.6">${esc(msg)}</p><div class="row-end"><button class="btn" data-v="0">아니오</button><button class="btn primary" data-v="1">예</button></div></div></div>`;
      document.body.appendChild(ov);
      ov.addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (!b) return; ov.remove(); res(b.dataset.v === '1'); });
    });
  }

  // ---------- events ----------
  function bind() {
    let t;
    $('#fatText').addEventListener('input', e => { clearTimeout(t); const v = e.target.value; t = setTimeout(() => { if (v.trim()) loadText(v, S.name && S.fromFile ? S.name : ''); else { S.meta = null; S.orig = []; S.pts = []; S.undo = []; S.res = null; renderAll(); } S.fromFile = false; }, 250); });
    $('#fatFile').addEventListener('change', e => {
      const f = e.target.files && e.target.files[0]; if (!f) return;
      const rd = new FileReader();
      rd.onload = () => { const txt = String(rd.result || ''); $('#fatText').value = txt; S.fromFile = true; loadText(txt, f.name); toast(`${f.name} 불러옴 (브라우저 안에서만 처리)`); };
      rd.onerror = () => toast('파일을 읽지 못했습니다. 내용을 복사해 붙여넣어 주세요.', true);
      rd.readAsText(f, 'utf-8'); e.target.value = '';
    });
    $('#fatReset').addEventListener('click', async () => {
      if (!(await confirmBox('데이터 초기화', '입력한 로그, 결과, 표, 그래프를 모두 비울까요?'))) return;
      $('#fatText').value = ''; Object.assign(S, { meta: null, orig: [], pts: [], undo: [], res: null, name: '', outOnly: false }); S.sel.clear(); $('#fatOutOnly').checked = false; renderAll(); toast('초기화했습니다');
    });
    $('#fatRadius').addEventListener('input', e => { const v = Number(e.target.value); if (!(v >= 0)) return; S.radius = v; saveCond(); if (S.pts.length) recalc(); });
    document.querySelectorAll('#viewFat [data-cond]').forEach(i => i.addEventListener('input', () => { S.cond[i.dataset.cond] = i.value; saveCond(); }));
    $('#fatOutOnly').addEventListener('change', e => { S.outOnly = e.target.checked; $('#fatVp').scrollTop = 0; renderTable(); });
    $('#fatTh').addEventListener('click', e => {
      if (e.target.id === 'fatAll') { if (e.target.checked) viewRows.forEach(x => S.sel.add(x.idx)); else viewRows.forEach(x => S.sel.delete(x.idx)); paintRows(); renderButtons(); drawChart(); return; }
      const b = e.target.closest('[data-sort]'); if (!b) return;
      S.sort = { k: b.dataset.sort, d: S.sort.k === b.dataset.sort ? -S.sort.d : (b.dataset.sort === 'idx' ? 1 : -1) }; renderTable();
    });
    $('#fatRows').addEventListener('change', e => { const c = e.target.closest('[data-i]'); if (!c) return; const i = Number(c.dataset.i); if (c.checked) S.sel.add(i); else S.sel.delete(i); c.closest('.fr').classList.toggle('on', c.checked); renderButtons(); drawChart(); const all = $('#fatAll'); if (all) all.checked = viewRows.length > 0 && viewRows.every(x => S.sel.has(x.idx)); });
    $('#fatVp').addEventListener('scroll', () => { if (viewRows.length) requestAnimationFrame(paintRows); }, { passive: true });
    $('#fatDelSel').addEventListener('click', async () => { const n = S.sel.size; if (!n || !(await confirmBox('선택 삭제', `선택한 ${n}개 점을 삭제할까요? 삭제 후 Index를 다시 매기고 모든 결과를 다시 계산합니다.`))) return; mutatePts(new Set(S.sel), `${n}개 점 삭제 · 재계산 완료`); });
    $('#fatDelOut').addEventListener('click', async () => { const o = S.res ? S.res.outs.map(x => x.idx) : []; if (!o.length || !(await confirmBox('OUT 전체 삭제', `OUT ${o.length}개 점을 삭제할까요? 중심이 바뀌어 새로운 OUT이 생길 수 있습니다.`))) return; mutatePts(new Set(o), `OUT ${o.length}개 삭제 · 재계산 완료${''}`); if (S.res && S.res.outs.length) toast(`OUT ${o.length}개 삭제 · 중심 이동으로 새 OUT ${S.res.outs.length}개`); });
    $('#fatUndo').addEventListener('click', () => { if (!S.undo.length) return; S.pts = S.undo.pop(); S.sel.clear(); recalc(); toast('되돌렸습니다'); });
    $('#fatRestore').addEventListener('click', () => { if (!S.meta) return; S.undo.push(S.pts); S.pts = S.orig.slice(); S.sel.clear(); recalc(); toast('원본 데이터로 복원했습니다'); });
    $('#fatExcelAx').addEventListener('change', e => { S.excelAxis = e.target.checked; saveCond(); drawChart(); });
    $('#fatPng').addEventListener('click', exportPng);
    // row click (not the checkbox) → show the point on the chart; chart click → index + scroll to the row
    $('#fatRows').addEventListener('click', e => { if (e.target.closest('input')) return; const r = e.target.closest('[data-row]'); if (!r) return; const i = Number(r.dataset.row); focusPoint(S.focus === i ? null : i, false); });
    const cv = $('#fatCanvas');
    cv.addEventListener('click', e => { const p = nearest(e); focusPoint(p ? p.idx : null, true); });
    cv.addEventListener('mousemove', e => { const p = nearest(e); cv.style.cursor = p ? 'pointer' : 'default'; cv.title = p ? `Index ${p.idx} (${f2(p.x)}, ${f2(p.y)})${p.out ? ' · OUT' : ''}` : ''; });
    $('#fatPick').addEventListener('click', e => { if (e.target.closest('.fp-x')) focusPoint(null); });
    $('#fatXlsx').addEventListener('click', exportXlsx);
    let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (!view().hidden) drawChart(); }, 120); });
    if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!view().hidden) drawChart(); });
  }

  // show hook (called by app.js when the tab opens)
  root.FatTab = { show() { build(); requestAnimationFrame(() => { drawChart(); if (viewRows.length) paintRows(); }); } };
})(typeof window !== 'undefined' ? window : globalThis);
