// Resolution 계산 (FAT 테스트 > Resolution 계산) — browser only, no server
// 보정값 = SQRT((Xn - Xn-1)^2 + (Yn - Yn-1)^2)  (엑셀 F열, 1번은 기준좌표와 비교)
// 평균 100.00 ~ 100.25 = 적합, 아니면 새 Resolution = Resolution / 평균 × 100  (엑셀 I열)
(function (root) {
  'use strict';
  const ROWS = 10, LO = 100, HI = 100.25, LSK = 'track.res';
  // "16:29:48:ManualGet,0,0" -> {x:0,y:0}; also "0,0", "0 0", tab separated
  function parsePt(s) {
    const t = String(s || '').trim(); if (!t) return null;
    let parts = t.split(/[,\t;]/).map(x => x.trim()).filter(x => x !== '');
    if (parts.length < 2) parts = t.split(/\s+/);
    const nums = parts.map(Number).filter((v, i) => parts[i] !== '' && isFinite(v));
    const tail = parts.slice(-2).map(Number);
    if (tail.length === 2 && tail.every(isFinite)) return { x: tail[0], y: tail[1] };
    if (nums.length >= 2) return { x: nums[nums.length - 2], y: nums[nums.length - 1] };
    return false; // not parseable
  }
  function calc(base, res, rows) {
    const b = parsePt(base);
    const out = rows.map(() => ({ pt: null, d: null }));
    let prev = b || null;
    rows.forEach((r, i) => {
      const p = parsePt(r); out[i].pt = p;
      if (p && prev) { out[i].d = Math.hypot(p.x - prev.x, p.y - prev.y); }
      if (p) prev = p;
    });
    const ds = out.map(o => o.d).filter(v => v != null);
    const avg = ds.length ? ds.reduce((a, v) => a + v, 0) / ds.length : null;
    const r = Number(res);
    const ok = avg != null ? avg >= LO && avg <= HI : null;
    const next = avg != null && r > 0 ? r / avg * 100 : null;
    return { base: b, out, n: ds.length, avg, ok, next, res: r > 0 ? r : null };
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { parsePt, calc }; return; }

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fx = (v, d) => (v == null || !isFinite(v) ? '-' : v.toFixed(d));
  const S = { base: '', res: '', rows: Array(ROWS).fill('') };
  try { const j = JSON.parse(localStorage.getItem(LSK) || '{}'); if (j.rows) Object.assign(S, j); S.rows = (S.rows || []).concat(Array(ROWS).fill('')).slice(0, ROWS); } catch (_) { /* storage blocked */ }
  const save = () => { try { localStorage.setItem(LSK, JSON.stringify(S)); } catch (_) { /* ignore */ } };
  const toast = (m, err) => { const t = $('#toast'); if (!t) return; t.textContent = m; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2200); };

  function build() {
    const v = $('#viewRes'); if (!v || v.dataset.built) return; v.dataset.built = '1';
    v.innerHTML = `
      <div class="rs-grid">
        <section class="fat-card rs-in">
          <div class="fat-h"><h3>Resolution 계산</h3><span class="fat-hint">좌표 로그 한 줄씩 입력 (예: 16:29:48:ManualGet,0,0)</span><button class="btn ghost" id="rsReset">초기화</button></div>
          <div class="rs-top">
            <label class="rs-f rs-base"><span>기준 좌표</span><input class="in" id="rsBase" placeholder="예) 16:29:48:ManualGet,0,0" autocomplete="off" value="${esc(S.base)}"><em class="rs-xy" id="rsBaseXY"></em></label>
            <label class="rs-f rs-resin"><span>Resolution</span><input class="in" id="rsRes" type="number" step="any" placeholder="예) 2.705848719" value="${esc(S.res)}"></label>
          </div>
          <div class="rs-tbl">
            <div class="rs-th"><span>No</span><span>좌표 입력</span><span>X</span><span>Y</span><span>보정값</span></div>
            ${S.rows.map((r, i) => `<div class="rs-tr" data-i="${i}"><b class="rs-no">${i + 1}.</b><input class="in" data-row="${i}" placeholder="${i ? '' : '예) 16:29:55:ManualGet,72,-74'}" autocomplete="off" value="${esc(r)}"><span class="rs-x"></span><span class="rs-y"></span><span class="rs-d"></span></div>`).join('')}
          </div>
          <div class="rs-hint">여러 줄을 한 번에 붙여넣으면 아래 칸으로 차례대로 들어갑니다. 10번까지 모두 입력하지 않아도 됩니다.</div>
        </section>
        <section class="fat-card rs-out">
          <div class="fat-h"><h3>결과</h3></div>
          <div id="rsSum"></div>
          <div class="rs-form">
            <div><b>보정값</b> = √((Xn − Xn−1)² + (Yn − Yn−1)²) · 1번은 기준 좌표와 비교</div>
            <div><b>판정</b> 평균 보정값 ${LO.toFixed(2)} ~ ${HI.toFixed(2)} → 적합</div>
            <div><b>새 Resolution</b> = Resolution ÷ 평균 보정값 × 100</div>
          </div>
        </section>
      </div>`;
    v.addEventListener('input', e => {
      const t = e.target;
      if (t.id === 'rsBase') S.base = t.value; else if (t.id === 'rsRes') S.res = t.value; else if (t.dataset.row != null) S.rows[Number(t.dataset.row)] = t.value; else return;
      save(); paint();
    });
    v.addEventListener('paste', e => {
      const t = e.target; const isRow = t.dataset && t.dataset.row != null; if (!isRow && t.id !== 'rsBase') return;
      const lines = (e.clipboardData || window.clipboardData).getData('text/plain').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      if (lines.length < 2) return;
      e.preventDefault();
      let k = isRow ? Number(t.dataset.row) : -1;
      lines.forEach(line => { if (k === -1) S.base = line; else if (k < ROWS) S.rows[k] = line; k++; });
      if (k > ROWS) toast(`10행을 넘는 ${k - ROWS}줄은 제외했습니다`, true);
      $('#rsBase').value = S.base; S.rows.forEach((r, i) => { $(`#viewRes [data-row="${i}"]`).value = r; });
      save(); paint();
    });
    v.addEventListener('keydown', e => { const t = e.target; if (e.key !== 'Enter' || (t.dataset.row == null && t.id !== 'rsBase')) return; e.preventDefault(); const n = t.id === 'rsBase' ? $('#viewRes [data-row="0"]') : $(`#viewRes [data-row="${Number(t.dataset.row) + 1}"]`); if (n) n.focus(); });
    v.addEventListener('click', e => {
      if (e.target.id === 'rsReset') { if (!confirm('입력한 기준 좌표와 1~10번 좌표를 모두 지울까요? (Resolution 값은 유지)')) return; S.base = ''; S.rows = Array(ROWS).fill(''); save(); v.dataset.built = ''; v.innerHTML = ''; build(); return; }
      const cp = e.target.closest('[data-copy]'); if (cp) { const val = cp.dataset.copy; (navigator.clipboard ? navigator.clipboard.writeText(val) : Promise.reject()).then(() => toast(`복사했습니다: ${val}`)).catch(() => toast('복사하지 못했습니다', true)); }
    });
    paint();
  }
  function paint() {
    const r = calc(S.base, S.res, S.rows);
    const bxy = $('#rsBaseXY'); const bi = $('#rsBase');
    bi.classList.toggle('bad', r.base === false);
    bxy.textContent = r.base ? `X ${r.base.x} · Y ${r.base.y}` : r.base === false ? '좌표를 읽을 수 없음' : '';
    r.out.forEach((o, i) => {
      const tr = $(`#viewRes .rs-tr[data-i="${i}"]`);
      tr.querySelector('input').classList.toggle('bad', o.pt === false);
      tr.querySelector('.rs-x').textContent = o.pt ? o.pt.x : '';
      tr.querySelector('.rs-y').textContent = o.pt ? o.pt.y : '';
      const d = tr.querySelector('.rs-d');
      d.textContent = o.d != null ? fx(o.d, 6) : (o.pt === false ? '형식 오류' : o.pt && !r.base ? '기준 좌표 필요' : '');
      d.className = 'rs-d' + (o.d != null ? (o.d >= LO && o.d <= HI ? ' ok' : ' ng') : ' muted');
    });
    const card = (k, v, cls, copy) => `<div class="fs ${cls || ''}"><span>${k}</span><b>${v}</b>${copy ? `<button type="button" class="btn ghost rs-copy" data-copy="${esc(copy)}">복사</button>` : ''}</div>`;
    let html;
    if (r.avg == null) html = `<div class="fat-none">기준 좌표와 1번 좌표를 입력하면 보정값과 평균이 표시됩니다</div>`;
    else {
      const verdict = r.ok ? '<span class="rs-v ok">적합</span>' : '<span class="rs-v ng">부적합</span>';
      html = `<div class="rs-cards">
        ${card('입력 개수', r.n + '개')}
        ${card('평균 보정값', fx(r.avg, 6), 'key')}
        ${card('판정', verdict, r.ok ? 'ok' : 'bad')}
        ${card('현재 Resolution', r.res != null ? String(S.res) : '<span class="muted">미입력</span>')}
      </div>
      ${r.ok ? `<div class="rs-res ok">평균 보정값이 기준(${LO.toFixed(2)} ~ ${HI.toFixed(2)}) 안에 있습니다. Resolution을 바꾸지 않아도 됩니다.</div>`
        : r.next != null ? `<div class="rs-res ng"><span>새 Resolution</span><b>${fx(r.next, 9)}</b><button type="button" class="btn primary" data-copy="${fx(r.next, 9)}">값 복사</button><small>${esc(S.res)} ÷ ${fx(r.avg, 6)} × 100</small></div>`
        : `<div class="rs-res ng">새 Resolution을 구하려면 위의 Resolution 값을 입력하세요.</div>`}`;
    }
    $('#rsSum').innerHTML = html;
  }
  root.ResTab = { show() { build(); } };
})(typeof window !== 'undefined' ? window : globalThis);
