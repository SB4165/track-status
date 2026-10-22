(() => {
  'use strict';
  const CFG = window.TRACK_CONFIG || {};
  const API = (CFG.API_URL || '').trim();
  const DEMO = !API;
  const LS = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { return null; } },
  };
  // write password: remembered only while this tab is open (sessionStorage)
  const SS = {
    get(k) { try { return sessionStorage.getItem(k); } catch (_) { return SS._m[k] || null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch (_) { SS._m[k] = v; } },
    del(k) { try { sessionStorage.removeItem(k); } catch (_) { delete SS._m[k]; } },
    _m: {},
  };
  const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  const PACK_MIN_STEP = 12;

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    data: null,
    names: (() => { try { return JSON.parse(LS.get('track.names') || 'null'); } catch (_) { return null; } })(),
    tab: ['projects', 'sync'].includes(LS.get('track.tab')) ? LS.get('track.tab') : 'board',
    filter: 'active', q: '', group: '',
    openProjectId: null, openStep: null,
    pending: 0, queue: Promise.resolve(), idMap: {}, psel: new Set(),
  };

  // ===================== API =====================
  async function apiGet(params) {
    if (DEMO) return Demo.get(params);
    const r = await fetch(API + '?' + new URLSearchParams(params).toString(), { redirect: 'follow' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '서버 오류');
    return j;
  }
  async function apiPost(body) {
    const key = SS.get('track.key');
    if (key) body.key = key;
    const j = DEMO ? await Demo.post(body) : await (await fetch(API, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow',
    })).json();
    if (!j.ok) {
      if (/비밀번호|권한 키/.test(j.error || '')) SS.del('track.key');
      throw new Error(j.error || '저장 실패');
    }
    return j;
  }

  // ===================== Helpers =====================
  function getUser() {
    let u = LS.get('track.user');
    if (!u) { u = (prompt('작성자 이름을 입력하세요 (이 기기에 저장됩니다)') || '').trim(); if (u) LS.set('track.user', u); renderUser(); }
    return u || '';
  }
  function renderUser() { $('#userName').textContent = LS.get('track.user') || '이름 설정'; }
  function toast(msg, err) {
    const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), err ? 4500 : 1800);
  }
  const pill = (s) => `<span class="pill s-${esc(s)}">${esc(s)}</span>`;
  const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const nowStr = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
  const projects = () => (state.data ? state.data.projects : []);
  const activeProjects = () => projects().filter(p => p.state === 'active');
  const slotItems = () => (state.data ? state.data.layout.filter(l => l.type === 'slot' || l.type === 'pack').sort((a, b) => a.slot - b.slot) : []);
  const slotNos = () => slotItems().map(l => Number(l.slot));
  const slotItem = (n) => slotItems().find(l => Number(l.slot) === Number(n));
  const isPack = (n) => { const it = slotItem(n); return !!it && it.type === 'pack'; };
  const slotName = (n) => { const it = slotItem(n); return it && it.type === 'pack' ? (it.label || '패킹') : `${n}번`; };
  const slotTag = (n) => { const it = slotItem(n); return it && it.type === 'pack' ? 'P' + String(it.label || '').replace(/[^0-9]/g, '') : String(n); };
  const slotTypes = (n) => { const it = slotItem(n); return it && it.type === 'slot' && it.label ? String(it.label).split(/[,/]/).map(s => s.trim()).filter(Boolean) : []; };
  const typeMatch = (n, p) => slotTypes(n).some(t => String(p.projectName).toUpperCase().includes(t.toUpperCase()));
  const typesHTML = (n) => { const t = slotTypes(n); return t.length ? `<div class="types">${t.map(x => `<i>${esc(x)}</i>`).join('')}</div>` : ''; };
  const bySlot = () => { const m = {}; activeProjects().forEach(p => { if (p.slot) m[Number(p.slot)] = p; }); return m; };
  const byId = (d, id) => d.projects.find(x => x.id === id || x.id === state.idMap[id]);
  // project set: 'MISC-MPR7 #1' -> 'MISC-#1', 'RD-SH-13-013 EMR#1' -> 'RD-SH-13-013'
  const groupOf = (name) => {
    const n = String(name || '').trim();
    let m = n.match(/^(\S+)\s+[A-Za-z]+\d*\s*#\d+$/); if (m) return m[1];
    m = n.match(/^([A-Za-z]+)-[A-Za-z]+\d*\s*(#\d+)$/); if (m) return m[1] + '-' + m[2];
    m = n.match(/^(.+?)\s*#\d+$/); return m ? m[1] : n;
  };
  const findProject = (id) => projects().find(p => p.id === id || p.id === state.idMap[id]);

  function projectInfo(p) {
    const steps = p.steps || [];
    const isDone = s => s.status === '완료' || s.status === '생략';
    const skipped = steps.filter(s => s.status === '생략').length;
    const done = steps.filter(isDone).length;
    const total = steps.length || 14;
    const cur = steps.find(s => !isDone(s)) || null;
    const curNo = cur ? Number(cur.stepNo) : total + 1;
    const fixing = steps.filter(s => s.status === '조치중');
    const openIssues = steps.filter(s => !isDone(s) && String(s.issue || '').trim());
    const pct = Math.round(done / total * 100);
    // auto drafts (used when no manual summary is saved)
    // content only: current step's progress text; blank when nothing was entered
    const progFull = cur ? String(cur.progress || '').trim() : '';
    const autoProg = summarize(progFull);
    const issueSteps = steps.filter(s => !isDone(s) && (String(s.issue || '').trim() || s.status === '조치중' || s.status === '보류'));
    // content only (no 'step(status):' prefix); a held/fixing step without text falls back to its name
    const issueFull = issueSteps.map(s => String(s.issue || '').trim() || `${s.stepNo}. ${s.stepName}(${s.status})`).join(' / ');
    const autoIssue = summarize(issueSteps.map(s => String(s.issue || '').trim() || `${s.stepName}(${s.status})`).join('\n'));
    const manualProg = String(p.summaryProgress || '').trim();
    const manualIssue = String(p.summaryIssue || '').trim();
    const prog = manualProg || autoProg;
    const issue = manualIssue || autoIssue;
    return { done, skipped, total, pct, cur, curNo, fixing, hasIssue: fixing.length > 0 || !!issue, prog, issue, progTip: manualProg || progFull, issueTip: manualIssue || issueFull, autoProg, autoIssue, manualProg, manualIssue, curStatus: cur ? cur.status : '완료', packOk: curNo >= PACK_MIN_STEP };
  }
  // compress free text into a short summary: split numbered/line items, drop numbering and
  // non-numeric (…) notes, shorten each item to fit a ~32-char budget, join with ' · '
  function summarize(text) {
    const t = String(text || '').replace(/\r/g, '').trim();
    if (!t) return '';
    const items = t.split(/\n+|\s*\/\s+|(?:^|\s)(?=\d{1,2}[.)]\s*\S)/)
      .map(x => x.replace(/^\s*\d{1,2}[.)]\s*/, '').replace(/^[-·•*]\s*/, '')
        .replace(/\s*[(（][^()（）]*[)）]/g, m => (/\d/.test(m) ? m : ''))
        .replace(/\s+/g, ' ').replace(/[\s,.;:]+$/, '').trim())
      .filter(Boolean);
    if (!items.length) return '';
    const limit = Math.max(12, Math.floor(32 / items.length));
    const cut = (x) => {
      if (x.length <= limit) return x;
      const s = x.slice(0, limit); const sp = s.lastIndexOf(' ');
      return (sp >= limit * 0.6 ? s.slice(0, sp) : s).replace(/[\s,.(]+$/, '').replace(/\s+(및|와|과|그리고|or|and)$/i, '') + '…';
    };
    return items.map(cut).join(' · ');
  }
  function cssVar(s) { return { '대기': '--st-wait', '진행': '--st-run', '조치중': '--st-fix', '완료': '--st-done', '보류': '--st-hold', '생략': '--st-skip' }[s] || '--st-wait'; }
  // pseudo project for a new registration starting at step `start` (for pack rule / options)
  // done-before-start rule; starting at the last step (출하완료) = every step done
  const startDone = (no, start, total) => no < start || start >= total;
  const applySkipLocal = (p, n) => { const total = (p.steps || []).length; p.steps.forEach(s => { const no = Number(s.stepNo); if (startDone(no, n, total) && !['완료', '생략'].includes(s.status)) s.status = '완료'; if (!startDone(no, n, total) && s.status === '생략') s.status = '대기'; }); };
  const fakeProj = (start) => { const defs = (state.data && state.data.stepDefs) || []; return { id: null, steps: defs.map(s => ({ stepNo: s.no, status: startDone(s.no, start, defs.length) ? '완료' : '대기' })) }; };
  const startOptions = (sel) => ((state.data && state.data.stepDefs) || []).map(s => `<option value="${s.no}" ${Number(sel) === s.no ? 'selected' : ''}>${s.no}. ${esc(s.name)}</option>`).join('');
  const packMsg = () => `패킹 칸에는 현재 공정이 ${PACK_MIN_STEP}번(${esc(((state.data && state.data.stepDefs) || [])[PACK_MIN_STEP - 1]?.name || '')}) 이상인 프로젝트만 배치할 수 있습니다.`;

  // ===================== Optimistic mutations =====================
  // apply(data) changes local data immediately; the request is queued and synced in the background.
  // password dialog (once per tab session)
  const needKey = () => !!(state.data && state.data.keyRequired) && !SS.get('track.key');
  function askKey() {
    return new Promise(resolve => {
      const ov = document.createElement('div');
      ov.className = 'overlay'; ov.style.zIndex = '90';
      ov.innerHTML = `<div class="sheet narrow" role="dialog" aria-modal="true"><div class="sheet-head"><div><div class="eyebrow">입력·수정·삭제 권한</div><h2>비밀번호 입력</h2></div></div>
        <div class="sheet-body"><label class="f">비밀번호<input type="password" id="pwIn" autocomplete="current-password"></label>
        <div class="hint" id="pwMsg" style="margin-top:6px">이 창(탭)을 닫기 전까지는 다시 묻지 않습니다.</div>
        <div class="row-end"><button class="btn" id="pwNo">취소</button><button class="btn primary" id="pwOk">확인</button></div></div></div>`;
      document.body.appendChild(ov);
      const inp = ov.querySelector('#pwIn'); const msg = ov.querySelector('#pwMsg'); const okB = ov.querySelector('#pwOk');
      const done = (v) => { ov.remove(); resolve(v); };
      const submit = async () => {
        const v = inp.value.trim(); if (!v) { inp.focus(); return; }
        okB.disabled = true; msg.textContent = '확인 중…'; msg.style.color = '';
        SS.set('track.key', v);
        try { await apiPost({ action: 'checkKey' }); done(true); }
        catch (e) { SS.del('track.key'); msg.textContent = e.message; msg.style.color = 'var(--danger)'; okB.disabled = false; inp.select(); }
      };
      okB.addEventListener('click', submit);
      ov.querySelector('#pwNo').addEventListener('click', () => { done(false); render(); });
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { done(false); render(); } });
      setTimeout(() => inp.focus(), 50);
    });
  }

  // yes/no dialog
  function confirmBox(title, msg) {
    return new Promise(resolve => {
      const ov = document.createElement('div');
      ov.className = 'overlay'; ov.style.zIndex = '90';
      ov.innerHTML = `<div class="sheet narrow" role="dialog" aria-modal="true"><div class="sheet-head"><div><h2>${esc(title)}</h2></div></div>
        <div class="sheet-body"><div class="hint" style="font-size:14px">${esc(msg)}</div>
        <div class="row-end"><button class="btn" data-a="0">아니오</button><button class="btn primary" data-a="1">예</button></div></div></div>`;
      document.body.appendChild(ov);
      ov.addEventListener('click', e => { const b = e.target.closest('[data-a]'); if (!b) return; ov.remove(); resolve(b.dataset.a === '1'); });
      setTimeout(() => ov.querySelector('[data-a="1"]').focus(), 30);
    });
  }

  function mutate(body, okMsg, apply, after) {
    if (needKey()) { askKey().then(ok => { if (ok) mutate(body, okMsg, apply, after); }); return false; }
    const user = getUser();
    if (apply) {
      try { apply(state.data, user); } catch (e) { toast(e.message, true); render(); return false; }
    }
    render();
    if (after) after();
    if (okMsg) toast(okMsg);
    state.pending++; syncLabel();
    const sent = Object.assign({}, body, { user });
    const tmp = sent._tmp; delete sent._tmp;
    state.queue = state.queue.then(async () => {
      if (sent.projectId && state.idMap[sent.projectId]) sent.projectId = state.idMap[sent.projectId];
      if (sent.projectIds) sent.projectIds = sent.projectIds.map(x => state.idMap[x] || x);
      try {
        const j = await apiPost(sent);
        if (tmp) {
          const real = j.projects.find(p => p.state === 'active' && p.projectName === sent.projectName);
          if (real) { state.idMap[tmp] = real.id; if (state.openProjectId === tmp) state.openProjectId = real.id; }
        }
        state.pending--;
        if (state.pending === 0) { state.data = j; render(true); }
      } catch (e) {
        state.pending--;
        toast('저장 실패: ' + e.message, true);
        if (/비밀번호/.test(e.message)) state.queue = Promise.resolve();
        try { state.data = await apiGet({ action: 'bootstrap' }); render(true); } catch (_) { render(); }
      }
      syncLabel();
    });
    return true;
  }
  function syncLabel() {
    $('#lastSync').textContent = state.pending
      ? `저장 중… (${state.pending})`
      : (DEMO ? '데모 모드 · ' : '') + '최종 동기화 ' + new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  }

  // local appliers
  function applySlot(d, projectId, slot) {
    const p = d.projects.find(x => x.id === projectId);
    if (!p) return;
    if (slot) {
      d.projects.forEach(x => { if (x !== p && x.state === 'active' && Number(x.slot) === Number(slot)) x.slot = null; });
      p.slot = Number(slot);
    } else p.slot = null;
    p.updatedAt = nowStr();
  }
  // confirm occupied / pack rules locally (no round trip)
  function checkSlot(slot, p) {
    if (!slot) return { ok: true };
    if (isPack(slot) && !(p ? projectInfo(p).packOk : false)) { toast(packMsg(), true); return { ok: false }; }
    const occ = bySlot()[Number(slot)];
    if (occ && (!p || occ.id !== p.id)) {
      if (!confirm(`${slotName(slot)}에는 이미 "${occ.projectName}" 프로젝트가 배치되어 있습니다.\n\n기존 프로젝트를 미배치로 옮기고 배치할까요?`)) return { ok: false };
      return { ok: true, force: true };
    }
    return { ok: true };
  }
  function setSlot(p, slot, after) {
    const c = checkSlot(slot, p);
    if (!c.ok) { render(); return false; }
    mutate({ action: 'setSlot', projectId: p.id, slot: slot || '', force: !!c.force }, slot ? `${slotName(slot)}에 배치되었습니다` : '미배치로 변경되었습니다', d => applySlot(d, p.id, slot), after);
    return true;
  }

  // ===================== Render =====================
  function render(fromServer) {
    if (!state.data) return;
    renderTabs();
    renderBoard();
    fitPlan(); // after stats are drawn (they move the plan down)
    renderProjects();
    renderSync();
    $('#projCnt').textContent = activeProjects().length || '';
    syncLabel();
    // re-render the open project only for local changes (server syncs must not wipe what the user is typing)
    if (!fromServer && state.openProjectId && !$('#overlay').hidden) {
      const p = findProject(state.openProjectId);
      if (p) renderProject(p, true); else closeModal();
    }
  }

  function renderTabs() {
    $$('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === state.tab));
    $('#viewBoard').hidden = state.tab !== 'board';
    $('#viewProjects').hidden = state.tab !== 'projects';
    $('#viewSync').hidden = state.tab !== 'sync';
    fitPlan();
  }
  // canvas is 1000 wide; height follows the layout (lowest item + margin)
  const planH = () => Math.max(300, ...((state.data && state.data.layout) || []).map(l => Number(l.y) + Number(l.h) + 8));
  // floor plan always uses the full width (fit-to-screen shrinking removed on request); only re-fit card summaries
  function fitPlan() {
    if (state.tab === 'board') fitCards();
  }
  // summaries use up to 3 lines, fewer when a card has no room (full text stays in the tooltip)
  function fitCards() {
    $$('#plan .card[data-pid]').forEach(c => {
      const ds = $$('.sum > div', c); if (!ds.length) return;
      for (let n = 3; n >= 1; n--) {
        ds.forEach(d => { d.style.webkitLineClamp = n; });
        if (c.scrollHeight <= c.clientHeight + 1) break;
      }
    });
  }
  window.addEventListener('resize', () => { clearTimeout(fitPlan._t); fitPlan._t = setTimeout(fitPlan, 80); });

  function cardHTML(slot, p) {
    const pack = isPack(slot);
    const tag = `<span class="no ${pack ? 'pk' : ''}">${esc(slotTag(slot))}</span>`;
    if (!p) {
      return `<button class="card empty ${pack ? 'pack' : ''}" data-slot="${slot}">${typesHTML(slot)}<div class="card-top">${tag}</div><span class="add">${pack ? `${esc(slotName(slot))}<br><small>${PACK_MIN_STEP}번 공정 이상 배치</small>` : '+ 프로젝트 배치'}</span></button>`;
    }
    const i = projectInfo(p);
    const segs = (p.steps || []).map(s => `<i class="s-${esc(s.status)}" title="${esc(s.stepNo + '. ' + s.stepName + ' · ' + s.status)}"></i>`).join('');
    const curHtml = i.cur
      ? `<div class="step"><b>${i.cur.stepNo}. ${esc(i.cur.stepName)}</b>${pill(i.cur.status)}</div>`
      : `<div class="step"><b>전 공정 완료</b>${pill('완료')}</div>`;
    return `<button class="card ${pack ? 'pack' : ''} ${i.hasIssue ? 'has-issue' : ''}" draggable="true" data-pid="${esc(p.id)}" data-st="${esc(i.curStatus)}" title="${esc(p.projectName)}">
      ${typesHTML(slot)}
      <div class="card-top">${tag}<span class="pname">${esc(p.projectName)}</span></div>
      <div class="cur"><div class="lbl">${pack ? esc(slotName(slot)) + ' · ' : ''}현재 공정</div>${curHtml}</div>
      <div class="segs">${segs}</div>
      <div class="pct">${i.done}/${i.total} 완료 · ${i.pct}%</div>
      <div class="sum">
        <div title="${esc(i.progTip)}"><span class="t">진행</span>${esc(i.prog)}</div>
        <div class="${i.issue ? 'issue' : ''}" title="${esc(i.issueTip)}"><span class="t">이슈</span>${i.issue ? esc(i.issue) : '<span class="muted">없음</span>'}</div>
      </div>
    </button>`;
  }

  function renderBoard() {
    const d = state.data;
    const map = bySlot();
    const placed = Object.values(map);
    $('#legend').innerHTML = d.statuses.map(s => `<span><i style="background:var(${cssVar(s)})"></i>${esc(s)}</span>`).join('')
      + '<span class="hint">장비 칸을 누르면 전체 공정을 볼 수 있습니다</span>';
    const fixing = placed.filter(p => projectInfo(p).fixing.length).length;
    const issues = placed.filter(p => projectInfo(p).hasIssue).length;
    const avg = placed.length ? Math.round(placed.reduce((a, p) => a + projectInfo(p).pct, 0) / placed.length) : 0;
    const unplaced = activeProjects().filter(p => !p.slot).length;
    $('#stats').innerHTML = [
      ['배치 프로젝트', `${placed.length}<small> / ${slotNos().length}칸 · 대기 ${unplaced}</small>`],
      ['평균 진척률', avg + '%'],
      ['조치중', fixing, fixing ? 'warn' : ''],
      ['이슈 있음', issues, issues ? 'warn' : ''],
    ].map(([k, v, c]) => `<div class="stat ${c || ''}"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');

    $('#plan').style.setProperty('--ch', planH());
    $('#plan').innerHTML = d.layout.map(it => {
      const st = `--x:${it.x};--y:${it.y};--w:${it.w};--h:${it.h}`;
      if (it.type === 'wall') return `<div class="pl wall" style="${st}"></div>`;
      if (it.type === 'fixture') return `<div class="pl fixture ${it.h > it.w * 2 ? 'tall' : ''}" style="${st}" title="${esc(it.label)}">${esc(it.label)}</div>`;
      if (it.type === 'label') return `<div class="pl label ${it.h >= 28 ? 'big' : ''}" style="${st}">${esc(it.label)}</div>`;
      if (it.type === 'door') return `<div class="pl door" style="${st}" title="${esc(it.label || '출입문')}"><svg viewBox="0 0 40 24" aria-hidden="true"><path d="M3 22h34"/><path d="M6 22V6"/><path d="M6 6a16 16 0 0 1 16 16"/></svg><span>${esc(it.label || '출입문')}</span></div>`;
      if (it.type === 'pack') return `<div class="pl" data-pack="${it.slot}" style="${st}">${cardHTML(it.slot, map[it.slot])}</div>`;
      if (it.type === 'slot') return `<div class="pl" style="${st}">${cardHTML(it.slot, map[it.slot])}</div>`;
      if (it.type === 'note') return `<div class="pl" style="${st}">${noteHTML(it)}</div>`;
      return '';
    }).join('');
    requestAnimationFrame(fitCards);

    const notes = d.layout.filter(l => l.type === 'note');
    $('#slotList').innerHTML = (notes.length ? '<div class="sec-t" style="grid-column:1/-1">기타사항</div>' + notes.map(noteHTML).join('') : '')
      + '<div class="sec-t" style="grid-column:1/-1">배치 번호순</div>'
      + slotNos().map(n => cardHTML(n, map[n])).join('');
  }

  function noteHTML(it) {
    const n = (state.data.notes || {})[it.id] || {};
    const has = String(n.content || '').trim();
    return `<button class="card note" data-note="${esc(it.id)}">
      <div class="note-h"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v12l-4 4H4z"/><path d="M16 20v-4h4"/><path d="M8 9h8M8 13h5"/></svg>${esc(it.label || '기타사항')}</div>
      <div class="note-c">${has ? esc(n.content) : '<span class="muted">눌러서 입력하세요</span>'}</div>
      ${n.updatedAt ? `<div class="note-m">${esc(n.updatedAt)}${n.updatedBy ? ' · ' + esc(n.updatedBy) : ''}</div>` : ''}
    </button>`;
  }

  function openNote(id) {
    state.openProjectId = null;
    const it = state.data.layout.find(l => l.id === id) || {};
    const n = (state.data.notes || {})[id] || {};
    $('#mSlot').textContent = n.updatedAt ? `최종 수정 ${n.updatedAt}${n.updatedBy ? ' · ' + n.updatedBy : ''}` : '프로젝트 외 공지, 설비, 일정 등';
    $('#mTitle').textContent = it.label || '기타사항';
    $('#mBody').innerHTML = `
      <label class="f">내용<textarea id="noteText" rows="10" placeholder="예) 10/24 클린룸 점검 예정, 메인 전기 차단기 이전 작업 등">${esc(n.content || '')}</textarea></label>
      <div class="row-end"><button class="btn primary" id="noteSave">저장</button></div>`;
    openModal(true);
    $('#noteSave').addEventListener('click', () => {
      const content = $('#noteText').value;
      closeModal();
      mutate({ action: 'saveNote', id, content }, '기타사항이 저장되었습니다', (d, user) => {
        d.notes = d.notes || {}; d.notes[id] = { content, updatedAt: nowStr(), updatedBy: user };
      });
    });
    setTimeout(() => $('#noteText').focus(), 60);
  }

  function renderProjects() {
    const all = projects();
    const counts = {
      active: all.filter(p => p.state === 'active').length,
      placed: all.filter(p => p.state === 'active' && p.slot).length,
      unplaced: all.filter(p => p.state === 'active' && !p.slot).length,
      shipped: all.filter(p => p.state === 'shipped').length,
      all: all.length,
    };
    const F = [['active', '진행중'], ['placed', '배치중'], ['unplaced', '미배치'], ['shipped', '출하완료'], ['all', '전체']];
    $('#pFilter').innerHTML = F.map(([k, l]) => `<button class="chip ${state.filter === k ? 'on' : ''}" data-f="${k}">${l}<b>${counts[k]}</b></button>`).join('');
    // project-set filter
    let gs = $('#pGroup');
    if (!gs) {
      gs = document.createElement('select'); gs.id = 'pGroup'; gs.className = 'slotsel grpsel'; gs.setAttribute('aria-label', '프로젝트 그룹');
      $('#pFilter').parentNode.insertBefore(gs, $('#pFilter'));
      gs.addEventListener('change', () => { state.group = gs.value; renderProjects(); });
    }
    const gc = {}; all.forEach(p => { const g = groupOf(p.projectName); gc[g] = (gc[g] || 0) + 1; });
    const gk = Object.keys(gc).sort((a, b) => a.localeCompare(b));
    if (state.group && !gc[state.group]) state.group = '';
    gs.innerHTML = `<option value="">전체 프로젝트 그룹</option>` + gk.map(g => `<option value="${esc(g)}" ${g === state.group ? 'selected' : ''}>${esc(g)} (${gc[g]})</option>`).join('');
    gs.classList.toggle('set', !!state.group);

    const q = state.q.trim().toLowerCase();
    const list = all.filter(p => {
      if (state.filter === 'active' && p.state !== 'active') return false;
      if (state.filter === 'placed' && !(p.state === 'active' && p.slot)) return false;
      if (state.filter === 'unplaced' && !(p.state === 'active' && !p.slot)) return false;
      if (state.filter === 'shipped' && p.state !== 'shipped') return false;
      if (state.group && groupOf(p.projectName) !== state.group) return false;
      return !q || String(p.projectName).toLowerCase().includes(q);
    }).sort((a, b) => {
      if (a.state !== b.state) return a.state === 'active' ? -1 : 1;
      if (a.state === 'active') {
        if (!!a.slot !== !!b.slot) return a.slot ? -1 : 1;
        if (a.slot && b.slot) return a.slot - b.slot;
      }
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });

    if (!list.length) {
      $('#pTable').innerHTML = `<div class="empty-msg">${all.length ? '조건에 맞는 프로젝트가 없습니다.' : '등록된 프로젝트가 없습니다.'}<br><button class="btn primary" data-act="add">프로젝트 등록</button></div>`;
      return;
    }
    const ids = list.map(p => p.id);
    [...state.psel].forEach(id => { if (!ids.includes(id)) state.psel.delete(id); });
    const allOn = ids.length > 0 && ids.every(id => state.psel.has(id));
    const bar = state.psel.size ? `<div class="bulkbar"><span>선택 <b>${state.psel.size}</b>건</span><span class="hint">현재 공정</span><select class="in" id="bulkStep">${startOptions(Number(LS.get('track.bulkStep')) || 1)}</select><button class="btn primary" id="bulkApply">일괄 적용</button><button class="btn ghost" id="bulkClear">선택 해제</button><span class="hint">선택한 공정 이전은 완료 처리 · 17. 출하완료를 고르면 전 공정 완료</span></div>` : '';
    const head = bar + '<div class="prow head"><div class="ck"><input type="checkbox" data-pall="1" ' + (allOn ? 'checked' : '') + ' aria-label="전체 선택"></div><div>배치</div><div>프로젝트명</div><div>현재 공정</div><div>진척률</div><div>이슈</div><div>최종 수정</div><div></div></div>';
    $('#pTable').innerHTML = head + list.map(p => {
      const i = projectInfo(p);
      const sel = p.state === 'active'
        ? `<select class="slotsel ${p.slot ? 'set' : ''}" data-pid="${esc(p.id)}" aria-label="배치">${slotOptions(p.slot, p, true)}</select>`
        : '<span class="shipbadge"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h11v9H3z"/><path d="M14 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/></svg>출하완료</span>';
      const cs = i.cur ? `<span class="t">${i.cur.stepNo}. ${esc(i.cur.stepName)}</span>${pill(i.cur.status)}` : `<span class="t">전 공정 완료</span>${pill('완료')}`;
      return `<div class="prow ${state.psel.has(p.id) ? 'picked' : ''}" data-pid="${esc(p.id)}">
        <div class="ck"><input type="checkbox" data-pck="${esc(p.id)}" ${state.psel.has(p.id) ? 'checked' : ''} aria-label="선택"></div>
        <div class="sl">${sel}</div>
        <div class="nm">${esc(p.projectName)}<small>${esc(groupOf(p.projectName))} · 등록 ${esc(String(p.createdAt || '').slice(0, 10))}${p.createdBy ? ' · ' + esc(p.createdBy) : ''}</small></div>
        <div class="cs">${cs}</div>
        <div class="pg"><div class="bar"><i style="width:${i.pct}%"></i></div><span>${i.done}/${i.total} · ${i.pct}%</span></div>
        <div class="is ${i.issue ? '' : 'none'}">${i.issue ? esc(i.issue) : '이슈 없음'}</div>
        <div class="dt">${esc(p.updatedAt || '')}</div>
        <div class="act">
          <button class="ib" data-edit="${esc(p.id)}" title="프로젝트명 수정" aria-label="수정"><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg></button>
          <button class="ib del" data-del="${esc(p.id)}" title="삭제" aria-label="삭제"><svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/></svg></button>
        </div>
      </div>`;
    }).join('');
  }

  // ===================== Modal =====================
  function openModal(narrow) {
    $('.sheet').classList.toggle('narrow', !!narrow);
    $('#mSave').hidden = true; // only the project detail shows the top save button
    $('#overlay').hidden = false; document.body.style.overflow = 'hidden';
  }
  function closeModal() { $('#overlay').hidden = true; document.body.style.overflow = ''; state.openProjectId = null; state.openStep = null; }

  // p: project for which options are built (null = new project)
  function slotOptions(cur, p, short) {
    const map = bySlot();
    const okPack = p ? projectInfo(p).packOk : false;
    return `<option value="">미배치</option>` + slotItems().map(it => {
      const n = Number(it.slot); const o = map[n]; const other = o && (!p || o.id !== p.id);
      const pack = it.type === 'pack';
      const dis = pack && !okPack && Number(cur) !== n;
      const extra = dis ? ` (${PACK_MIN_STEP}번 공정 이상)` : other ? (short ? ' · 사용중' : ' · ' + esc(o.projectName)) : '';
      const ty = slotTypes(n);
      return `<option value="${n}" ${Number(cur) === n ? 'selected' : ''} ${dis ? 'disabled' : ''}>${esc(slotName(n))}${ty.length ? ' [' + esc(ty.join('/')) + ']' : ''}${extra}</option>`;
    }).join('');
  }

  function renderProject(p, keepScroll) {
    const body = $('#mBody');
    const scroll = keepScroll ? body.scrollTop : 0;
    const i = projectInfo(p);
    const active = p.state === 'active';
    state.openProjectId = p.id;
    if (state.openStep == null && i.cur) state.openStep = Number(i.cur.stepNo);
    $('#mSlot').textContent = `${active ? (p.slot ? slotName(p.slot) + ' 배치' : '미배치') : '출하완료'} · ${i.done}/${i.total} 완료`;
    $('#mTitle').textContent = p.projectName;

    const steps = (p.steps || []).map(s => {
      const no = Number(s.stepNo);
      const isFile = s.fileRequired === true || String(s.fileRequired).toUpperCase() === 'TRUE';
      const open = state.openStep === no;
      const sub = String(s.issue || '').trim() && s.status !== '완료'
        ? `<small class="issue">이슈: ${esc(s.issue)}</small>`
        : (String(s.progress || '').trim() ? `<small>${esc(s.progress)}</small>` : '');
      return `<div class="st ${open ? 'open' : ''} ${i.cur && Number(i.cur.stepNo) === no ? 'cur-step' : ''}" data-step="${no}">
        <button class="st-h" data-toggle="${no}">
          <span class="st-n">${no}</span>
          <span class="st-name">${esc(s.stepName)}${sub}</span>
          ${isFile ? '<span class="fbadge">파일확인</span>' : ''}
          ${pill(s.status)}
          <svg class="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        <div class="st-b">
          <div class="seg-ctl">${state.data.statuses.map(x => `<button type="button" class="s-${x} ${x === s.status ? 'on' : ''}" data-v="${x}">${x}</button>`).join('')}</div>
          <div class="grid3 dates">
            <label class="f">시작일<input type="date" name="startDate" value="${esc(s.startDate)}"></label>
            <label class="f">완료일<input type="date" name="endDate" value="${esc(s.endDate)}"></label>
            <label class="f">담당자<input type="text" name="owner" value="${esc(s.owner)}" placeholder="이름"></label>
          </div>
          <label class="f">세부 진행사항<textarea name="progress" rows="3" placeholder="진행 내용을 입력하세요">${esc(s.progress)}</textarea></label>
          <label class="f">이슈사항<textarea name="issue" rows="2" placeholder="이슈가 있으면 입력하세요">${esc(s.issue)}</textarea></label>
          ${isFile ? `<div class="filecheck"><span>NAS 폴더 파일 업로드 확인 <b>자동화 예정</b></span><span class="meta">${s.fileCheckedAt ? '확인 ' + esc(s.fileCheckedAt) + ' · ' + esc(s.fileCount) + '개' : '미연동'}</span></div>` : ''}
          <div class="row-end between">
            <span class="meta">${s.updatedAt ? '수정 ' + esc(s.updatedAt) + (s.updatedBy ? ' · ' + esc(s.updatedBy) : '') : ''}</span>
            <button class="btn primary" data-save="${no}">저장</button>
          </div>
        </div>
      </div>`;
    }).join('');

    body.innerHTML = `
      <div class="box">
        <div class="grid3 sumgrid">
          <label class="f">배치${active ? `<select class="in" id="mSlotSel">${slotOptions(p.slot, p)}</select>` : `<input type="text" value="출하완료" disabled>`}</label>
          <label class="f"><span>진행사항 요약 <span class="autotag ${i.manualProg ? 'man' : ''}">${i.manualProg ? '직접 작성' : '자동 초안'}</span></span><textarea id="sumProg" rows="3" data-auto="${esc(i.autoProg)}">${esc(i.prog)}</textarea></label>
          <label class="f"><span>이슈사항 요약 <span class="autotag ${i.manualIssue ? 'man' : ''}">${i.manualIssue ? '직접 작성' : '자동 초안'}</span></span><textarea id="sumIssue" rows="3" placeholder="이슈 없음" data-auto="${esc(i.autoIssue)}">${esc(i.issue)}</textarea></label>
        </div>
        <div class="row-end between" style="flex-wrap:wrap">
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><span class="hint">시작 공정</span><select class="in" id="skipSel" style="width:auto;padding:6px 8px">${startOptions(i.curNo > i.total ? i.total : i.curNo)}</select><button class="btn" id="skipBtn" title="선택한 공정 이전의 미완료 공정을 완료 처리">이 공정부터 진행</button></div>
          <div style="display:flex;gap:6px">${i.manualProg || i.manualIssue ? '<button class="btn ghost" id="autoSum" title="직접 작성한 요약을 지우고 자동 초안으로 표시">자동 초안으로</button>' : ''}<button class="btn" id="saveSum">요약 저장</button></div>
        </div>
        <div class="hint" style="margin-top:6px">자동 초안은 공정 기록이 바뀔 때마다 새로 작성됩니다. 내용을 고쳐 저장하면 '직접 작성'으로 고정됩니다.</div>
      </div>
      <div class="section-t">전체 공정 <span class="hint">공정을 눌러 상세 입력</span></div>
      <div class="steps">${steps}</div>
      <div class="foot-actions">
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn danger" id="removeBtn">삭제</button>
          <button class="btn" id="editBtn">프로젝트명 수정</button>
        </div>
        ${active ? '<button class="btn" id="shipBtn">출하 완료</button>' : '<button class="btn" id="restoreBtn">진행중으로 복원</button>'}
      </div>`;
    if (!keepScroll) openModal(false);
    $('#mSave').hidden = false;
    body.scrollTop = scroll;
  }

  async function loadNames(refresh) {
    const n = (await apiGet({ action: 'projectNames', refresh: refresh ? '1' : '0' })).names;
    state.names = n; LS.set('track.names', JSON.stringify(n));
    return n;
  }

  // mode: { slot } for register, { edit: project } for rename
  function openPicker(mode) {
    const editP = mode.edit || null;
    state.openProjectId = null;
    $('#mSlot').textContent = editP ? `현재: ${editP.projectName}` : '참조 시트(TRACK)에서 선택';
    $('#mTitle').textContent = editP ? '프로젝트명 수정' : '프로젝트 등록';
    $('#mBody').innerHTML = `
      <label class="f">프로젝트명 검색<input type="search" id="q" placeholder="프로젝트명 검색" autocomplete="off"></label>
      <div class="search-list" id="list"><div class="none">프로젝트 목록 불러오는 중…</div></div>
      ${editP ? '' : `<div class="grid2" style="margin-top:12px">
        <label class="f">시작 공정<select class="in" id="regStart">${startOptions(1)}</select></label>
        <label class="f">배치 (선택)<select class="in" id="regSlot">${slotOptions(mode.slot || '', fakeProj(1))}</select></label>
      </div>
      <div class="hint" style="margin-top:6px">시작 공정 이전 공정은 '완료'로 등록됩니다. 패킹 칸은 ${PACK_MIN_STEP}번 공정 이상일 때 배치할 수 있습니다.</div>`}
      <div class="row-end between">
        <button class="btn ghost" id="reloadNames">목록 새로고침</button>
        <button class="btn primary" id="regBtn" disabled>${editP ? '변경' : '등록'}</button>
      </div>`;
    openModal(true);
    let selected = null;
    const draw = () => {
      const q = $('#q').value.trim().toLowerCase();
      const used = new Set(activeProjects().filter(p => !editP || p.id !== editP.id).map(p => p.projectName));
      const list = (state.names || []).filter(n => !q || n.toLowerCase().includes(q));
      $('#list').innerHTML = list.length
        ? list.map(n => `<button type="button" data-n="${esc(n)}" class="${n === selected ? 'sel' : ''}" ${used.has(n) ? 'disabled' : ''}><span>${esc(n)}</span>${used.has(n) ? '<small>등록됨</small>' : (editP && n === editP.projectName ? '<small>현재</small>' : '')}</button>`).join('')
        : `<div class="none">${state.names ? '검색 결과가 없습니다' : '불러오는 중…'}</div>`;
      $('#regBtn').disabled = !selected || (editP && selected === editP.projectName);
    };
    $('#q').addEventListener('input', draw);
    if (!editP) $('#regStart').addEventListener('change', () => { const cur = $('#regSlot').value; $('#regSlot').innerHTML = slotOptions(cur, fakeProj(Number($('#regStart').value))); if ($('#regSlot').selectedOptions[0] && $('#regSlot').selectedOptions[0].disabled) $('#regSlot').value = ''; });
    $('#list').addEventListener('click', e => { const b = e.target.closest('button[data-n]'); if (!b || b.disabled) return; selected = b.dataset.n; draw(); });
    $('#list').addEventListener('dblclick', e => { const b = e.target.closest('button[data-n]'); if (b && !b.disabled) $('#regBtn').click(); });
    $('#reloadNames').addEventListener('click', () => { state.names = null; draw(); loadNames(true).then(draw).catch(err => toast(err.message, true)); });
    $('#regBtn').addEventListener('click', () => {
      if (!selected) return;
      const name = selected;
      if (editP) {
        const pid = editP.id;
        mutate({ action: 'updateProject', projectId: pid, projectName: name }, '프로젝트명이 변경되었습니다', d => {
          const p = byId(d, pid); if (p) { p.projectName = name; p.updatedAt = nowStr(); }
        }, () => { state.openStep = null; renderProject(findProject(pid)); });
        return;
      }
      const slot = $('#regSlot').value;
      const start = Number($('#regStart').value) || 1;
      const c = checkSlot(slot, fakeProj(start));
      if (!c.ok) return;
      const tmp = 'tmp-' + Date.now();
      mutate({ action: 'createProject', projectName: name, slot, startStep: start, force: !!c.force, _tmp: tmp }, '등록되었습니다', (d, user) => {
        if (slot) d.projects.forEach(x => { if (x.state === 'active' && Number(x.slot) === Number(slot)) x.slot = null; });
        d.projects.push({
          id: tmp, slot: slot ? Number(slot) : null, projectName: name, state: 'active', summaryProgress: '', summaryIssue: '',
          createdAt: nowStr(), createdBy: user, updatedAt: nowStr(), updatedBy: user,
          steps: (d.stepDefs || []).map(s => ({ stepNo: s.no, stepName: s.name, status: startDone(s.no, start, d.stepDefs.length) ? '완료' : '대기', startDate: '', endDate: '', owner: '', progress: '', issue: '', fileRequired: s.file, fileCount: '', fileCheckedAt: '', updatedAt: '', updatedBy: '' })),
        });
      }, () => { state.openStep = null; renderProject(findProject(tmp)); });
    });
    draw();
    loadNames(false).then(draw).catch(err => { if (!state.names) $('#list').innerHTML = `<div class="none">목록을 불러오지 못했습니다: ${esc(err.message)}</div>`; });
    setTimeout(() => $('#q').focus(), 60);
  }

  function openSlotPicker(slot) {
    state.openProjectId = null;
    const pack = isPack(slot);
    // equipment slot: unplaced projects / pack slot: any active project at step >= 11 not already in a pack
    const cands = activeProjects().filter(p => pack ? (projectInfo(p).packOk && !(p.slot && isPack(p.slot))) : !p.slot)
      .sort((a, b) => Number(typeMatch(slot, b)) - Number(typeMatch(slot, a)));
    const ty = slotTypes(slot);
    $('#mSlot').textContent = pack ? `${slotName(slot)} · ${PACK_MIN_STEP}번 공정 이상 프로젝트` : `${slotName(slot)} 위치${ty.length ? ' · 전용 타입 ' + ty.join(', ') : ''}`;
    $('#mTitle').textContent = '배치할 프로젝트 선택';
    $('#mBody').innerHTML = `
      <div class="hint">${pack ? '패킹 단계 프로젝트' : '미배치 진행중 프로젝트'} ${cands.length}건${pack ? ' · 장비 칸에 있던 프로젝트는 옮겨지면서 그 칸이 비워집니다' : ''}</div>
      <div class="search-list" id="wlist">${cands.length
        ? cands.map(p => { const i = projectInfo(p); return `<button type="button" data-pid="${esc(p.id)}"><span>${esc(p.projectName)}${p.slot ? ` <small>(${esc(slotName(p.slot))})</small>` : ''}${typeMatch(slot, p) ? ' <small class="fit">전용 타입</small>' : ''}</span><small>${i.done}/${i.total} · ${i.cur ? esc(i.cur.stepName) : '완료'}</small></button>`; }).join('')
        : `<div class="none">${pack ? `${PACK_MIN_STEP}번 공정 이상인 프로젝트가 없습니다.` : '미배치 프로젝트가 없습니다. 새로 등록해 주세요.'}</div>`}</div>
      ${pack ? '' : '<div class="row-end"><button class="btn primary" id="newHere">+ 새 프로젝트 등록</button></div>'}`;
    openModal(true);
    $('#wlist').addEventListener('click', e => {
      const b = e.target.closest('button[data-pid]'); if (!b) return;
      setSlot(findProject(b.dataset.pid), slot, closeModal);
    });
    if (!pack) $('#newHere').addEventListener('click', () => openPicker({ slot }));
  }

  function removeProject(p) {
    if (!p || !confirm(`"${p.projectName}" 프로젝트를 삭제할까요?\n(목록에서 사라지며, DB 시트에는 기록이 남습니다)`)) return;
    const pid = p.id;
    if (state.openProjectId === pid) closeModal();
    mutate({ action: 'release', projectId: pid, state: 'removed' }, '삭제되었습니다', d => {
      const x = byId(d, pid); if (x) { x.state = 'removed'; x.slot = null; }
      d.projects = d.projects.filter(y => y.state !== 'removed');
    });
  }

  // ===================== Excel export =====================
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = XLSX_URL; s.onload = () => res(window.XLSX); s.onerror = () => rej(new Error('엑셀 모듈을 불러오지 못했습니다'));
      document.head.appendChild(s);
    });
  }

  function openExport() {
    state.openProjectId = null;
    const list = projects().slice().sort((a, b) => String(a.projectName).localeCompare(String(b.projectName)));
    $('#mSlot').textContent = '.xlsx · 시트 3개 (프로젝트 현황 / 공정별 현재값 / 변경 이력)';
    $('#mTitle').textContent = '엑셀 다운로드';
    $('#mBody').innerHTML = `
      <label class="f">프로젝트<select class="in" id="xProj"><option value="">전체 프로젝트</option>${list.map(p => `<option value="${esc(p.id)}">${esc(p.projectName)}${p.state === 'shipped' ? ' (출하완료)' : ''}</option>`).join('')}</select></label>
      <label class="f" style="margin-top:10px"><span><input type="checkbox" id="xShipped" checked> 출하완료 프로젝트 포함</span></label>
      <div class="grid2" style="margin-top:10px">
        <label class="f">이력 시작일<input type="date" id="xFrom"></label>
        <label class="f">이력 종료일<input type="date" id="xTo" value="${today()}"></label>
      </div>
      <div class="hint" style="margin-top:6px">기간은 변경 이력 시트에만 적용됩니다. 시작일을 비우면 전체 기간입니다.</div>
      <div class="row-end"><button class="btn primary" id="xGo">다운로드</button></div>`;
    openModal(true);
    $('#xGo').addEventListener('click', async () => {
      const btn = $('#xGo'); btn.disabled = true; btn.textContent = '생성 중…';
      try {
        const pid = $('#xProj').value;
        const incShipped = $('#xShipped').checked;
        const [XLSX, hist] = await Promise.all([loadXlsx(), apiGet({ action: 'history', from: $('#xFrom').value, to: $('#xTo').value, projectId: pid })]);
        const ps = projects().filter(p => (!pid || p.id === pid) && (incShipped || p.state === 'active'));
        const ids = new Set(ps.map(p => p.id));
        const sheet1 = ps.map(p => { const i = projectInfo(p); return {
          '배치': p.slot ? slotName(p.slot) : '', '프로젝트명': p.projectName, '상태': p.state === 'active' ? '진행중' : '출하완료',
          '현재 공정': i.cur ? `${i.cur.stepNo}. ${i.cur.stepName}` : '전 공정 완료', '현재 공정 상태': i.curStatus,
          '완료 공정': `${i.done}/${i.total}`, '진척률(%)': i.pct, '진행 요약': i.prog, '이슈 요약': i.issue,
          '등록일': p.createdAt, '등록자': p.createdBy, '최종 수정': p.updatedAt, '수정자': p.updatedBy,
        }; });
        const sheet2 = [];
        ps.forEach(p => (p.steps || []).forEach(s => sheet2.push({
          '프로젝트명': p.projectName, '배치': p.slot ? slotName(p.slot) : '', '공정 번호': s.stepNo, '공정명': s.stepName, '상태': s.status,
          '시작일': s.startDate, '완료일': s.endDate, '담당자': s.owner, '세부 진행사항': s.progress, '이슈사항': s.issue,
          '파일확인 대상': (s.fileRequired === true || String(s.fileRequired).toUpperCase() === 'TRUE') ? 'O' : '',
          '최종 수정': s.updatedAt, '수정자': s.updatedBy,
        })));
        const sheet3 = (hist.rows || []).filter(r => !r.projectId || ids.has(r.projectId) || pid === r.projectId).map(r => ({
          '일시': r.at, '작성자': r.by, '구분': r.actionLabel || r.action, '프로젝트명': r.projectName, '배치': r.slot ? slotName(r.slot) : '',
          '공정 번호': r.stepNo, '공정명': r.stepName, '상태': r.status, '시작일': r.startDate, '완료일': r.endDate,
          '담당자': r.owner, '세부 진행사항': r.progress, '이슈사항': r.issue, '비고': r.detail,
        }));
        const wb = XLSX.utils.book_new();
        const add = (rows, name, widths) => {
          const ws = rows.length ? XLSX.utils.json_to_sheet(rows) : XLSX.utils.aoa_to_sheet([['데이터 없음']]);
          ws['!cols'] = widths.map(w => ({ wch: w }));
          XLSX.utils.book_append_sheet(wb, ws, name);
        };
        add(sheet1, '프로젝트 현황', [9, 28, 9, 24, 12, 10, 10, 40, 40, 17, 10, 17, 10]);
        add(sheet2, '공정별 현재값', [28, 9, 9, 22, 8, 12, 12, 10, 50, 50, 12, 17, 10]);
        add(sheet3, '변경 이력', [17, 10, 12, 28, 9, 9, 22, 8, 12, 12, 10, 50, 50, 30]);
        const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
        const url = URL.createObjectURL(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
        const a = document.createElement('a');
        a.href = url; a.download = `TRACK_status_${today().replace(/-/g, '')}.xlsx`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        toast('다운로드를 시작했습니다');
        closeModal();
      } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = '다운로드'; }
    });
  }

  // ===================== Sync tab (reference sheet) =====================
  const SY = { rows: null, at: '', loading: false, view: 'list', from: '', to: '', quick: 'all', st: '', group: '', q: '', hide: LS.get('track.syncHide') === '1', sel: new Set(), start: {}, slot: {}, hist: null, histLoading: false, sort: (() => { try { return JSON.parse(LS.get('track.sySort') || 'null') || { k: '', d: 1 }; } catch (_) { return { k: '', d: 1 }; } })() };
  // sorting (k: '' = sheet order). No. column always shows the on-screen order 1..n
  const SY_SORT = {
    st: r => ({ wait: 0, ok: 1, ex: 2 })[r.s.k],
    ship: r => r.d || null,
    name: r => r.name, g: r => r.g, type: r => r.type,
    cur: r => (r.s.k === 'ok' ? (projectInfo(r.s.p).cur ? Number(projectInfo(r.s.p).cur.stepNo) : 99) : null),
  };
  const sySorted = (rows) => {
    const f = SY_SORT[SY.sort.k]; if (!f) return rows;
    // empty values (미정 / not synced) always stay at the bottom
    return rows.slice().sort((a, b) => { const x = f(a), y = f(b); if (x == null || y == null) return x == null && y == null ? a.no - b.no : (x == null ? 1 : -1); const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'ko', { numeric: true }); return (c || (a.no - b.no)) * SY.sort.d; });
  };
  const syTh = (k, label) => `<th data-sort="${k}" class="${SY.sort.k === k ? 'sorted' : ''}">${label}<span class="ar">${SY.sort.k === k ? (SY.sort.d > 0 ? '▲' : '▼') : ''}</span></th>`;
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const refDate = (s) => { const m = String(s || '').match(/(\d{2,4})\D+(\d{1,2})\D+(\d{1,2})/); return m ? `${m[1].length === 2 ? '20' + m[1] : m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : ''; };
  function quickRange(k) {
    const d = new Date(today() + 'T00:00:00');
    if (k === 'week') { const a = new Date(d); a.setDate(d.getDate() - (d.getDay() + 6) % 7); const b = new Date(a); b.setDate(a.getDate() + 6); return [ymd(a), ymd(b)]; }
    if (k === 'month') return [ymd(new Date(d.getFullYear(), d.getMonth(), 1)), ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0))];
    if (k === 'year') return [d.getFullYear() + '-01-01', d.getFullYear() + '-12-31'];
    return ['', ''];
  }
  function syncStatus(r) {
    const ps = projects().filter(p => p.state !== 'removed' && p.projectName === r.name);
    if (ps.length) return { k: 'ok', t: '동기화 완료', p: ps.find(p => p.state === 'active') || ps[0] };
    if (((state.data && state.data.syncExcluded) || []).includes(r.name)) return { k: 'ex', t: '제외' };
    return { k: 'wait', t: '대기' };
  }
  const syAll = () => (SY.rows || []).map(r => Object.assign({}, r, { d: refDate(r.ship), g: groupOf(r.name), s: syncStatus(r) }));
  const syFiltered = () => syAll().filter(r => {
    if (SY.from && (!r.d || r.d < SY.from)) return false;
    if (SY.to && (!r.d || r.d > SY.to)) return false;
    if (SY.st && r.s.k !== SY.st) return false;
    if (SY.group && r.g !== SY.group) return false;
    if (SY.q && !r.name.toLowerCase().includes(SY.q.toLowerCase())) return false;
    if (SY.hide && r.s.k === 'ok') return false;
    return true;
  });
  const sySel = () => syFiltered().filter(r => SY.sel.has(r.name));
  async function loadSync(manual) {
    if (SY.loading) return;
    SY.loading = true; renderSync();
    try {
      const j = await apiGet({ action: 'refRows', refresh: manual ? '1' : '0' });
      SY.rows = j.rows; SY.at = new Date().toTimeString().slice(0, 8);
      if (manual) toast('참조 시트를 다시 불러왔습니다');
    } catch (e) { toast('참조 시트 불러오기 실패: ' + e.message, true); }
    SY.loading = false; renderSync();
  }
  async function loadSyncHist() {
    if (SY.histLoading) return;
    SY.histLoading = true;
    try { SY.hist = (await apiGet({ action: 'history', actions: 'sync,unsync,exclude,include' })).rows.slice().reverse(); }
    catch (e) { SY.hist = []; toast('이력 불러오기 실패: ' + e.message, true); }
    SY.histLoading = false; renderSync();
  }
  function syRow(r, idx) {
    const k = r.s.k; const n = esc(r.name); const on = SY.sel.has(r.name);
    let start = '<span class="muted">-</span>', slot = '<span class="muted">-</span>', cur = '<span class="muted">-</span>';
    if (k === 'wait') {
      const st = Number(SY.start[r.name] || 1);
      start = `<select class="sy-mini" data-start="${n}">${startOptions(st)}</select>`;
      slot = `<select class="sy-mini" data-slot="${n}">${slotOptions(SY.slot[r.name] || '', fakeProj(st), true)}</select>`;
    } else if (k === 'ok') {
      const p = r.s.p; const i = projectInfo(p); const ty = p.slot ? slotTypes(p.slot) : [];
      slot = p.state !== 'active' ? '출하완료' : p.slot ? esc(slotName(p.slot)) + (ty.length ? ' [' + esc(ty.join('/')) + ']' : '') : '미배치';
      cur = `<button class="sy-link" data-open="${esc(p.id)}">${i.cur ? `${pill(i.cur.status)} ${i.cur.stepNo}. ${esc(i.cur.stepName)}` : `${pill('완료')} 전 공정 완료`}</button>`;
    } else cur = '<span class="muted">관리 대상 아님</span>';
    return `<tr class="${k !== 'wait' ? 'done' : ''} ${on ? 'on' : ''}" data-name="${n}"><td class="ck"><input type="checkbox" data-ck="${n}" ${on ? 'checked' : ''} aria-label="선택"></td><td>${idx + 1}</td><td><span class="sy-st ${k}">${r.s.t}</span></td><td>${r.d ? r.d.replace(/-/g, '.') : (String(r.ship || '').trim() ? esc(r.ship) : '<span class="muted">미정</span>')}</td><td><b>${n}</b></td><td>${esc(r.g)}</td><td>${esc(r.type)}</td><td>${start}</td><td>${slot}</td><td>${cur}</td></tr>`;
  }
  function renderSync() {
    const all = syAll();
    const c = k => all.filter(r => r.s.k === k).length;
    $('#syncCnt').textContent = SY.rows ? (c('wait') || '') : '';
    if (state.tab !== 'sync' || !state.data) return;
    $('#syList').hidden = SY.view !== 'list'; $('#syHist').hidden = SY.view !== 'hist';
    $$('#syView button').forEach(b => b.classList.toggle('on', b.dataset.v === SY.view));
    if (SY.view === 'hist') {
      $('#syMeta').textContent = SY.hist ? `동기화·취소·제외 이력 ${SY.hist.length}건` : '이력 불러오는 중…';
      if (!SY.hist) { $('#syHistTable').innerHTML = '<div class="sy-empty">불러오는 중…</div>'; loadSyncHist(); return; }
      $('#syHistTable').innerHTML = `<table><thead><tr><th>일시</th><th>작업</th><th>프로젝트명</th><th>배치</th><th>작업자</th><th>내용</th></tr></thead><tbody>${SY.hist.map(h => `<tr class="nohover"><td>${esc(h.at)}</td><td><b>${esc(h.actionLabel || h.action)}</b></td><td>${esc(h.projectName)}</td><td>${h.slot !== '' && h.slot != null ? esc(slotName(h.slot)) : '-'}</td><td>${esc(h.by)}</td><td class="wrap">${esc(h.detail)}</td></tr>`).join('') || '<tr><td colspan="6" class="sy-empty">이력이 없습니다</td></tr>'}</tbody></table>`;
      return;
    }
    $('#syMeta').textContent = SY.rows ? `${all.length}건 · 대기 ${c('wait')} · 동기화 완료 ${c('ok')} · 제외 ${c('ex')}${SY.at ? ' · ' + SY.at + ' 갱신' : ''}` : (SY.loading ? '참조 시트 불러오는 중…' : '');
    const groups = [...new Set(all.map(r => r.g))].sort();
    if (SY.group && !groups.includes(SY.group)) SY.group = '';
    $('#syGroup').innerHTML = '<option value="">프로젝트 그룹 전체</option>' + groups.map(g => `<option value="${esc(g)}" ${g === SY.group ? 'selected' : ''}>${esc(g)}</option>`).join('');
    $('#syFrom').value = SY.from; $('#syTo').value = SY.to; $('#syStatus').value = SY.st;
    $$('#syQuick button').forEach(b => b.classList.toggle('on', b.dataset.q === SY.quick));
    $('#syHide').classList.toggle('on', SY.hide); $('#syHide').textContent = SY.hide ? '동기화 완료건 보이기' : '동기화 완료건 숨기기';
    const rows = sySorted(syFiltered());
    const vis = new Set(rows.map(r => r.name)); [...SY.sel].forEach(n => { if (!vis.has(n)) SY.sel.delete(n); });
    const sel = rows.filter(r => SY.sel.has(r.name));
    const sw = sel.filter(r => r.s.k === 'wait'), so = sel.filter(r => r.s.k === 'ok' && r.s.p.state === 'active'), sx = sel.filter(r => r.s.k === 'ex');
    const fw = rows.filter(r => r.s.k === 'wait').length;
    $('#syCond').textContent = `조건부 동기화 (${fw})`; $('#syCond').disabled = !fw;
    $('#syAll').textContent = `일괄 동기화 (${c('wait')})`; $('#syAll').disabled = !c('wait');
    $('#sySel').textContent = `선택 동기화 (${sw.length})`; $('#sySel').disabled = !sw.length;
    $('#syUnsync').textContent = '동기화 취소' + (so.length ? ` (${so.length})` : ''); $('#syUnsync').disabled = !so.length;
    $('#syEx').textContent = !sw.length && sx.length ? `제외 해제 (${sx.length})` : '선택 제외' + (sw.length ? ` (${sw.length})` : ''); $('#syEx').disabled = !(sw.length || sx.length);
    if (!SY.rows) { $('#syTable').innerHTML = `<div class="sy-empty">${SY.loading ? '참조 시트를 불러오는 중…' : '목록을 불러오지 못했습니다. 새로고침을 눌러 주세요.'}</div>`; return; }
    const allOn = rows.length > 0 && rows.every(r => SY.sel.has(r.name));
    const sc = $('#syTable').scrollTop;
    $('#syTable').innerHTML = `<table><thead><tr><th class="ck"><input type="checkbox" data-all="1" ${allOn ? 'checked' : ''} aria-label="전체 선택"></th>${syTh('', 'No.')}${syTh('st', '상태')}${syTh('ship', '출하일')}${syTh('name', '프로젝트명')}${syTh('g', '프로젝트 그룹')}${syTh('type', 'TYPE')}<th>시작 공정</th><th>배치</th>${syTh('cur', '사이트 현재 공정')}</tr></thead><tbody>${rows.map(syRow).join('') || '<tr><td colspan="10" class="sy-empty">조건에 맞는 프로젝트가 없습니다</td></tr>'}</tbody></table>`;
    $('#syTable').scrollTop = sc;
  }
  function doSync(list, label) {
    list = list.filter(r => r.s.k === 'wait');
    if (!list.length) { toast('동기화할 대기 건이 없습니다', true); return; }
    if ((label !== '선택 동기화' || list.length > 1) && !confirm(`${label}: 대기 ${list.length}건을 프로젝트 관리 탭에 등록할까요?`)) return;
    const items = list.map(r => ({ name: r.name, startStep: Number(SY.start[r.name] || 1), slot: SY.slot[r.name] || '' }));
    mutate({ action: 'syncProjects', items }, `${items.length}건 동기화되었습니다`, (d, user) => {
      const occ = {}; d.projects.forEach(x => { if (x.state === 'active' && x.slot) occ[Number(x.slot)] = true; });
      items.forEach((it, k) => {
        if (d.projects.some(x => x.state !== 'removed' && x.projectName === it.name)) return;
        let slot = it.slot ? Number(it.slot) : null;
        if (slot && (occ[slot] || (isPack(slot) && it.startStep < PACK_MIN_STEP))) slot = null;
        if (slot) occ[slot] = true;
        d.projects.push({
          id: 'T' + Date.now() + '_' + k, slot, projectName: it.name, state: 'active', summaryProgress: '', summaryIssue: '',
          createdAt: nowStr(), createdBy: user, updatedAt: nowStr(), updatedBy: user,
          steps: (d.stepDefs || []).map(s => ({ stepNo: s.no, stepName: s.name, status: startDone(s.no, it.startStep, d.stepDefs.length) ? '완료' : '대기', startDate: '', endDate: '', owner: '', progress: '', issue: '', fileRequired: s.file, fileCount: '', fileCheckedAt: '', updatedAt: '', updatedBy: '' })),
        });
        delete SY.start[it.name]; delete SY.slot[it.name]; SY.sel.delete(it.name);
      });
      SY.hist = null;
    });
  }
  function doUnsync(list) {
    const ps = list.filter(r => r.s.k === 'ok' && r.s.p.state === 'active').map(r => r.s.p);
    if (!ps.length) return;
    if (!confirm(`선택한 ${ps.length}건의 동기화를 취소할까요?\n\n프로젝트 관리 탭·진행현황에서 삭제되고(배치 해제) 목록은 '대기'로 돌아갑니다.\n입력한 공정 기록은 DB 시트와 변경 이력에 남습니다.`)) return;
    const ids = ps.map(p => p.id);
    mutate({ action: 'unsync', projectIds: ids }, `${ids.length}건 동기화를 취소했습니다`, d => {
      d.projects = d.projects.filter(p => !ids.includes(p.id));
      SY.sel.clear(); SY.hist = null;
    });
  }
  function doExclude(list, on) {
    const names = list.filter(r => r.s.k === (on ? 'wait' : 'ex')).map(r => r.name);
    if (!names.length) return;
    mutate({ action: 'exclude', names, on }, on ? `${names.length}건을 제외했습니다` : `${names.length}건 제외를 해제했습니다`, d => {
      const s = new Set(d.syncExcluded || []); names.forEach(n => (on ? s.add(n) : s.delete(n))); d.syncExcluded = [...s];
      SY.sel.clear(); SY.hist = null;
    });
  }

  // ===================== Events =====================
  $$('.tab').forEach(t => t.addEventListener('click', () => { state.tab = t.dataset.tab; LS.set('track.tab', state.tab); renderTabs(); window.scrollTo(0, 0);
    if (state.tab === 'sync') { if (!SY.rows) loadSync(false); else renderSync(); }
  }));
  $('#syView').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (!b) return; SY.view = b.dataset.v; if (SY.view === 'hist') SY.hist = null; renderSync(); });
  $('#syRefresh').addEventListener('click', () => { if (SY.view === 'hist') { SY.hist = null; renderSync(); } else loadSync(true); });
  $('#syFrom').addEventListener('change', e => { SY.from = e.target.value; SY.quick = ''; renderSync(); });
  $('#syTo').addEventListener('change', e => { SY.to = e.target.value; SY.quick = ''; renderSync(); });
  $('#syQuick').addEventListener('click', e => { const b = e.target.closest('[data-q]'); if (!b) return; SY.quick = b.dataset.q; [SY.from, SY.to] = quickRange(SY.quick); renderSync(); });
  $('#syStatus').addEventListener('change', e => { SY.st = e.target.value; renderSync(); });
  $('#syGroup').addEventListener('change', e => { SY.group = e.target.value; renderSync(); });
  $('#syQ').addEventListener('input', e => { SY.q = e.target.value.trim(); renderSync(); });
  $('#syHide').addEventListener('click', () => { SY.hide = !SY.hide; LS.set('track.syncHide', SY.hide ? '1' : '0'); renderSync(); });
  $('#syCond').addEventListener('click', () => doSync(syFiltered(), '조건부 동기화'));
  $('#syAll').addEventListener('click', () => doSync(syAll(), '일괄 동기화'));
  $('#sySel').addEventListener('click', () => doSync(sySel(), '선택 동기화'));
  $('#syUnsync').addEventListener('click', () => doUnsync(sySel()));
  $('#syEx').addEventListener('click', () => { const s = sySel(); if (s.some(r => r.s.k === 'wait')) doExclude(s, true); else doExclude(s, false); });
  $('#syTable').addEventListener('change', e => {
    const t = e.target; const d = t.dataset;
    if (d.all) { syFiltered().forEach(r => (t.checked ? SY.sel.add(r.name) : SY.sel.delete(r.name))); }
    else if (d.ck != null) { if (t.checked) SY.sel.add(d.ck); else SY.sel.delete(d.ck); }
    else if (d.start != null) { SY.start[d.start] = Number(t.value); const sl = SY.slot[d.start]; if (sl && isPack(sl) && Number(t.value) < PACK_MIN_STEP) delete SY.slot[d.start]; SY.sel.add(d.start); }
    else if (d.slot != null) { SY.slot[d.slot] = t.value; SY.sel.add(d.slot); }
    renderSync();
  });
  $('#syTable').addEventListener('click', e => {
    const th = e.target.closest('th[data-sort]');
    if (th) { const k = th.dataset.sort; SY.sort = k === '' ? { k: '', d: 1 } : { k, d: SY.sort.k === k ? -SY.sort.d : 1 }; LS.set('track.sySort', JSON.stringify(SY.sort)); renderSync(); return; }
    const o = e.target.closest('[data-open]'); if (o) { const p = findProject(o.dataset.open); if (p) { state.openStep = null; renderProject(p); } return; }
    if (e.target.closest('input,select,button,label')) return;
    const tr = e.target.closest('tr[data-name]'); if (!tr) return;
    const n = tr.dataset.name; if (SY.sel.has(n)) SY.sel.delete(n); else SY.sel.add(n);
    renderSync();
  });

  const onCardClick = e => {
    const c = e.target.closest('.card'); if (!c) return;
    if (c.dataset.note) { openNote(c.dataset.note); return; }
    if (c.dataset.pid) { state.openStep = null; renderProject(findProject(c.dataset.pid)); }
    else openSlotPicker(Number(c.dataset.slot));
  };
  $('#plan').addEventListener('click', onCardClick);
  // drag a placed card onto a packing slot -> confirm -> move
  $('#plan').addEventListener('dragstart', e => {
    const c = e.target.closest && e.target.closest('.card[data-pid]'); if (!c) return;
    e.dataTransfer.setData('text/plain', c.dataset.pid); e.dataTransfer.effectAllowed = 'move';
    state.dragPid = c.dataset.pid; c.classList.add('dragging'); $('#plan').classList.add('dragmode');
  });
  $('#plan').addEventListener('dragend', () => { state.dragPid = null; $$('#plan .dragging,#plan .drop-on').forEach(x => x.classList.remove('dragging', 'drop-on')); $('#plan').classList.remove('dragmode'); });
  $('#plan').addEventListener('dragover', e => {
    const t = e.target.closest('[data-pack]'); if (!t || !state.dragPid) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    $$('#plan .drop-on').forEach(x => { if (x !== t) x.classList.remove('drop-on'); }); t.classList.add('drop-on');
  });
  $('#plan').addEventListener('dragleave', e => { const t = e.target.closest('[data-pack]'); if (t && !t.contains(e.relatedTarget)) t.classList.remove('drop-on'); });
  $('#plan').addEventListener('drop', e => {
    const t = e.target.closest('[data-pack]'); if (!t) return;
    e.preventDefault();
    const pid = e.dataTransfer.getData('text/plain') || state.dragPid; const slot = Number(t.dataset.pack);
    $$('#plan .drop-on').forEach(x => x.classList.remove('drop-on'));
    const p = findProject(pid); if (!p || Number(p.slot) === slot) return;
    if (!projectInfo(p).packOk) { toast(packMsg(), true); return; }
    confirmBox('패킹존으로 이동하시겠습니까?', `${p.projectName} : ${p.slot ? slotName(p.slot) : '미배치'} → ${slotName(slot)}`).then(ok => { if (ok) setSlot(p, slot); });
  });
  $('#slotList').addEventListener('click', onCardClick);

  $('#pSearch').addEventListener('input', e => { state.q = e.target.value; renderProjects(); });
  $('#pFilter').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (!b) return; state.filter = b.dataset.f; renderProjects(); });
  $('#addBtn').addEventListener('click', () => openPicker({ slot: '' }));
  $('#exportBtn').addEventListener('click', openExport);
  $('#pTable').addEventListener('click', e => {
    if (e.target.id === 'bulkClear') { state.psel.clear(); renderProjects(); return; }
    if (e.target.id === 'bulkApply') { bulkApply(); return; }
    if (e.target.closest('.ck, .bulkbar')) return;
    if (e.target.closest('select')) return;
    if (e.target.closest('[data-act="add"]')) { openPicker({ slot: '' }); return; }
    const ed = e.target.closest('[data-edit]'); if (ed) { openPicker({ edit: findProject(ed.dataset.edit) }); return; }
    const dl = e.target.closest('[data-del]'); if (dl) { removeProject(findProject(dl.dataset.del)); return; }
    const r = e.target.closest('.prow[data-pid]'); if (!r) return;
    state.openStep = null; renderProject(findProject(r.dataset.pid));
  });
  $('#pTable').addEventListener('change', e => {
    const t = e.target;
    if (t.id === 'bulkStep') { LS.set('track.bulkStep', t.value); return; }
    if (t.dataset.pall) { $$('#pTable [data-pck]').forEach(c => (t.checked ? state.psel.add(c.dataset.pck) : state.psel.delete(c.dataset.pck))); renderProjects(); return; }
    if (t.dataset.pck) { if (t.checked) state.psel.add(t.dataset.pck); else state.psel.delete(t.dataset.pck); renderProjects(); return; }
    const s = e.target.closest('select.slotsel'); if (!s) return;
    setSlot(findProject(s.dataset.pid), s.value);
  });

  function bulkApply() {
    const ids = [...state.psel]; if (!ids.length) return;
    const n = Number($('#bulkStep').value); const def = (state.data.stepDefs || [])[n - 1] || {};
    const last = n >= (state.data.stepDefs || []).length;
    if (!confirm(`선택한 ${ids.length}건의 현재 공정을 '${n}. ${def.name}'(으)로 맞출까요?\n\n${last ? '출하완료: 전 공정이 완료 처리됩니다.' : n + '번 이전 공정은 완료 처리되고, 기존 완료 기록은 유지됩니다.'}`)) return;
    mutate({ action: 'bulkSkipTo', projectIds: ids, stepNo: n }, `${ids.length}건 적용되었습니다`, d => {
      ids.forEach(id => { const p = byId(d, id); if (p) { applySkipLocal(p, n); p.updatedAt = nowStr(); } });
      state.psel.clear();
    });
  }

  $('#mClose').addEventListener('click', closeModal);
  // modals close only with the X button (no backdrop click / Escape)
  $('#mSave').addEventListener('click', saveAll);
  // top save: collect every changed field first (a mutation re-renders the modal), then queue the saves
  function saveAll() {
    if (needKey()) { askKey().then(ok => { if (ok) saveAll(); }); return; }
    const pid = state.openProjectId; const p = findProject(pid); if (!p) return;
    const jobs = [];
    const keep = (el) => { const v = el.value.trim(); return v === String(el.dataset.auto || '').trim() ? '' : v; };
    const sp = keep($('#sumProg')), si = keep($('#sumIssue'));
    if (sp !== String(p.summaryProgress || '').trim() || si !== String(p.summaryIssue || '').trim()) {
      jobs.push(() => mutate({ action: 'saveSummary', projectId: pid, summaryProgress: sp, summaryIssue: si }, null, d => {
        const x = byId(d, pid); if (x) { x.summaryProgress = sp; x.summaryIssue = si; }
      }));
    }
    $$('#mBody .st[data-step]').forEach(el => {
      const no = Number(el.dataset.step); const s = (p.steps || []).find(x => Number(x.stepNo) === no); if (!s) return;
      const v = n => el.querySelector(`[name=${n}]`).value;
      const on = el.querySelector('.seg-ctl button.on');
      const f = { status: on ? on.dataset.v : s.status, startDate: v('startDate'), endDate: v('endDate'), owner: v('owner'), progress: v('progress'), issue: v('issue') };
      if (!Object.keys(f).some(k => String(f[k] || '').trim() !== String(s[k] || '').trim())) return;
      jobs.push(() => mutate(Object.assign({ action: 'saveStep', projectId: pid, stepNo: no }, f), null, (d, user) => {
        const x = byId(d, pid); if (!x) return;
        const st = x.steps.find(y => Number(y.stepNo) === no); Object.assign(st, f, { updatedAt: nowStr(), updatedBy: user });
        x.updatedAt = nowStr();
      }));
    });
    if (!jobs.length) { toast('변경 사항이 없습니다'); return; }
    jobs.forEach(j => j());
    toast(`저장되었습니다 (${jobs.length}건)`);
  }

  $('#mBody').addEventListener('click', e => {
    const t = e.target;
    const tog = t.closest('[data-toggle]');
    if (tog) {
      const n = Number(tog.dataset.toggle); const el = tog.closest('.st'); const open = !el.classList.contains('open');
      $$('.st.open').forEach(x => x.classList.remove('open')); if (open) el.classList.add('open');
      state.openStep = open ? n : -1; return;
    }
    const segBtn = t.closest('.seg-ctl button');
    if (segBtn) {
      segBtn.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === segBtn));
      const el = segBtn.closest('.st');
      const sd = el.querySelector('[name=startDate]'), ed = el.querySelector('[name=endDate]');
      if (segBtn.dataset.v !== '대기' && !sd.value) sd.value = today();
      if (segBtn.dataset.v === '완료' && !ed.value) ed.value = today();
      return;
    }
    const save = t.closest('[data-save]');
    if (save) {
      const no = Number(save.dataset.save); const el = save.closest('.st');
      const v = n => el.querySelector(`[name=${n}]`).value;
      const on = el.querySelector('.seg-ctl button.on');
      const f = { status: on ? on.dataset.v : '대기', startDate: v('startDate'), endDate: v('endDate'), owner: v('owner'), progress: v('progress'), issue: v('issue') };
      const pid = state.openProjectId;
      mutate(Object.assign({ action: 'saveStep', projectId: pid, stepNo: no }, f), '저장되었습니다', (d, user) => {
        const p = byId(d, pid); if (!p) return;
        const s = p.steps.find(x => Number(x.stepNo) === no); Object.assign(s, f, { updatedAt: nowStr(), updatedBy: user });
        p.updatedAt = nowStr();
      });
      return;
    }
    const id = t.closest('button') && t.closest('button').id;
    const pid = state.openProjectId;
    if (id === 'autoSum') {
      mutate({ action: 'saveSummary', projectId: pid, summaryProgress: '', summaryIssue: '' }, '자동 초안으로 바꿨습니다', d => {
        const p = byId(d, pid); if (p) { p.summaryProgress = ''; p.summaryIssue = ''; }
      });
    }
    if (id === 'saveSum') {
      // unchanged auto draft -> keep it automatic (store empty)
      const keep = (el) => { const v = el.value.trim(); return v === String(el.dataset.auto || '').trim() ? '' : v; };
      const sp = keep($('#sumProg')), si = keep($('#sumIssue'));
      mutate({ action: 'saveSummary', projectId: pid, summaryProgress: sp, summaryIssue: si }, '요약이 저장되었습니다', d => {
        const p = byId(d, pid); if (p) { p.summaryProgress = sp; p.summaryIssue = si; }
      });
    }
    if (id === 'shipBtn' && confirm('출하 완료 처리할까요?\n배치 칸은 비워지고, 기록은 프로젝트 관리 탭의 [출하완료]에 보관됩니다.')) {
      mutate({ action: 'release', projectId: pid, state: 'shipped' }, '출하 완료 처리되었습니다', d => {
        const p = byId(d, pid); if (p) { p.state = 'shipped'; p.slot = null; }
      });
    }
    if (id === 'skipBtn') {
      const n = Number($('#skipSel').value);
      mutate({ action: 'skipTo', projectId: pid, stepNo: n }, `${n}번 공정부터 진행합니다 (이전 공정 완료 처리)`, d => {
        const p = byId(d, pid); if (!p) return;
        applySkipLocal(p, n);
        state.openStep = n;
      });
    }
    if (id === 'removeBtn') removeProject(findProject(pid));
    if (id === 'editBtn') openPicker({ edit: findProject(pid) });
    if (id === 'restoreBtn') {
      mutate({ action: 'restore', projectId: pid }, '진행중으로 복원되었습니다 (미배치)', d => {
        const p = byId(d, pid); if (p) p.state = 'active';
      });
    }
  });
  $('#mBody').addEventListener('change', e => {
    if (e.target.id === 'mSlotSel') setSlot(findProject(state.openProjectId), e.target.value);
  });

  $('#refreshBtn').addEventListener('click', () => load(true));
  $('#userBtn').addEventListener('click', () => { const u = prompt('작성자 이름', LS.get('track.user') || ''); if (u !== null) { LS.set('track.user', u.trim()); renderUser(); } });

  async function load(manual) {
    if (state.pending) return;
    if (!manual && !$('#overlay').hidden) return; // don't disturb while editing
    try {
      state.data = await apiGet({ action: 'bootstrap' });
      render(true);
      $('#banner').hidden = !DEMO;
      if (DEMO) $('#banner').textContent = '데모 모드입니다. config.js에 Apps Script URL을 설정하면 실제 데이터가 연동됩니다.';
      if (manual) toast('새로고침 완료');
    } catch (e) { toast('불러오기 실패: ' + e.message, true); $('#lastSync').textContent = '연결 오류'; }
  }

  // ===================== Demo backend =====================
  const Demo = (() => {
    const STEPS = ['QC검수', 'QC검수 조치확인', 'FAT 셋업', 'FAT 측정(진동)', 'FAT 측정(반복정밀도)', 'FAT 측정(AWC)', '반복Cycle 촬영', 'Full Cycle 촬영', 'X1/X2 핸드레벨 촬영', '물방울 JIG 레벨 촬영', '로봇 배선 해체(제조)', '클리닝(제조)', '패킹리스트 확인', '출하사진 촬영', '패킹 서류 스캔 및 인쇄', '패킹(서류 동봉)', '출하완료'];
    const FILE = [4, 5, 6, 7, 8, 9, 10, 14, 15];
    const L = (id, type, slot, label, x, y, w, h) => ({ id, type, slot, label, x, y, w, h });
    const layout = [
      L('wall-top', 'wall', null, '', 40, 6, 952, 18), L('wall-left', 'wall', null, '', 8, 235, 24, 402),
      ...['MPR, EMR, ITR', 'STR, ESR', 'STR, ESR', 'MPR', 'ITR, EMR', 'FER'].map((t, i) => L('slot-' + (i + 3), 'slot', i + 3, t, 40 + i * 160, 30, 152, 195)),
      L('slot-2', 'slot', 2, 'MPR, ITR', 40, 235, 192, 185), L('slot-1', 'slot', 1, 'MPR', 40, 426, 192, 185),
      L('door-1', 'door', null, '출입문', 40, 617, 192, 20),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map(i => L('pack-' + (i + 1), 'pack', 9 + i, '패킹 ' + (i + 1), 244 + (i % 4) * 148, i < 4 ? 235 : 433, 140, 190)),
      L('note-1', 'note', null, '기타사항', 840, 235, 152, 388),
    ];
    const notes = { 'note-1': { content: '10/24(금) 클린룸 정기 점검 예정\n메인 전기 차단기 위치 이동 작업 대기', updatedAt: '2026-10-21 09:00', updatedBy: '곽승범' } };
    const names = ['RD-SH-13-013 EMR#1', 'RD-SH-13-013 ESR#2', 'RD-SH-13-013 ESR#3', 'RD-SH-13-013 FER#0', 'RD-SH-13-013 MPR#4', 'RD-SH-13-013 MPR#5', 'RD-SH-13-013 MPR#6', 'MISC-STR10 #1', 'MISC-STR11 #1', 'MISC-FER0 #1', 'MISC-MPR7 #1', 'MISC-MPR9 #1'];
    const now = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
    const history = [];
    const mk = (id, slot, name, doneN, extra = {}) => ({
      id, slot, projectName: name, state: 'active', summaryProgress: '', summaryIssue: '', createdAt: '2026-10-15 09:00', createdBy: '곽승범', updatedAt: now(), updatedBy: '곽승범',
      steps: STEPS.map((n, i) => {
        const no = i + 1; const status = no <= doneN ? '완료' : no === doneN + 1 ? '진행' : '대기';
        const s = { stepNo: no, stepName: n, status, startDate: no <= doneN + 1 ? '2026-10-1' + (no % 10) : '', endDate: no <= doneN ? '2026-10-2' + (no % 2) : '', owner: no <= doneN + 1 ? '곽승범' : '', progress: no === doneN + 1 ? '진행 중' : '', issue: '', fileRequired: FILE.includes(no), fileCount: '', fileCheckedAt: '', updatedAt: no <= doneN + 1 ? '2026-10-21 0' + (no % 9) + ':00' : '', updatedBy: '곽승범' };
        return Object.assign(s, extra[no] || {});
      }),
    });
    const db = [
      mk('P1', 9, names[0], 12), mk('P2', 7, names[1], 6, { 7: { status: '조치중', issue: 'Cycle 중 Z축 이음 발생, 벨트 텐션 재조정 필요' } }),
      mk('P3', 6, names[2], 3), mk('P4', 4, names[3], 1, { 2: { status: '조치중', issue: 'QC 지적사항 1건 미조치 (커버 도장)' } }),
      mk('P5', 3, names[4], 10), mk('P6', 2, names[5], 0, { 1: { status: '보류', issue: '자재 미입고' } }),
      mk('P7', null, names[6], 0), mk('P8', null, names[7], 2),
      Object.assign(mk('P9', null, names[8], 14), { state: 'shipped' }),
    ];
    const snap = () => JSON.parse(JSON.stringify({ ok: true, layout, notes, projects: db.filter(p => p.state !== 'removed'), stepDefs: STEPS.map((n, i) => ({ no: i + 1, name: n, file: FILE.includes(i + 1) })), statuses: ['대기', '진행', '조치중', '완료', '보류', '생략'], syncExcluded: excluded }));
    const wait = (v) => new Promise(r => setTimeout(() => r(v), 600));
    const log = (b, action, p, s, detail) => history.push({ at: now(), by: b.user, action, actionLabel: ({ sync: '참조 동기화', unsync: '동기화 취소', exclude: '동기화 제외', include: '제외 해제' })[action] || action, projectId: p ? p.id : '', projectName: p ? p.projectName : '', slot: p ? (p.slot || '') : '', stepNo: s ? s.stepNo : '', stepName: s ? s.stepName : '', status: s ? s.status : '', startDate: s ? s.startDate : '', endDate: s ? s.endDate : '', owner: s ? s.owner : '', progress: s ? s.progress : '', issue: s ? s.issue : '', detail: detail || '' });
    const refRows = names.concat(['MISC-ITR12 #1', 'MISC-EMR3 #1', 'RD-SH-13-014 MPR#1', 'RD-SH-13-014 ITR#2']).map((n, i) => ({ no: i + 1, name: n, type: 'IMMERSION TRACK', ship: i < 7 ? '' : i < 12 ? '26-12-31' : '26-10-' + String(10 + i) }));
    const excluded = ['MISC-FER0 #1'];
    const occupied = (slot, selfId) => db.find(p => p.state === 'active' && Number(p.slot) === Number(slot) && p.id !== selfId);
    const isPackD = (slot) => layout.some(l => l.type === 'pack' && l.slot === Number(slot));
    const curNo = (p) => { const c = p.steps.find(s => s.status !== '완료' && s.status !== '생략'); return c ? c.stepNo : 15; };
    return {
      get(p) {
        if (p.action === 'projectNames') return wait({ ok: true, names });
        if (p.action === 'history') { const acts = String(p.actions || '').split(',').filter(Boolean); return wait({ ok: true, rows: history.filter(r => (!p.projectId || r.projectId === p.projectId) && (!acts.length || acts.includes(r.action))) }); }
        if (p.action === 'refRows') return wait({ ok: true, rows: refRows });
        return wait(snap());
      },
      post(b) {
        const fail = (msg) => wait({ ok: false, error: msg });
        if (b.action === 'saveNote') { notes[b.id] = { content: b.content, updatedAt: now(), updatedBy: b.user }; log(b, '기타사항 수정', null, null, b.content); return wait(snap()); }
        if (b.action === 'createProject') {
          if (db.some(p => p.state === 'active' && p.projectName === b.projectName)) return fail('이미 등록된 진행중 프로젝트입니다.');
          if (b.slot && isPackD(b.slot)) return fail('패킹 칸 조건 불충족');
          const occ = b.slot && occupied(b.slot);
          if (occ && !b.force) return fail('이미 배치됨');
          if (occ) occ.slot = null;
          const p = mk('P' + Date.now(), b.slot ? Number(b.slot) : null, b.projectName, -1); p.steps.forEach(s => { if (startDone(s.stepNo, b.startStep || 1, STEPS.length)) s.status = '완료'; }); p.createdAt = now(); p.createdBy = b.user;
          db.push(p); log(b, '프로젝트 등록', p);
        }
        if (b.action === 'syncProjects') {
          (b.items || []).forEach((it, k) => {
            if (db.some(x => x.state !== 'removed' && x.projectName === it.name)) return;
            let slot = it.slot ? Number(it.slot) : null;
            if (slot && (occupied(slot) || (isPackD(slot) && it.startStep < PACK_MIN_STEP))) slot = null;
            const np = mk('S' + Date.now() + k, slot, it.name, -1); np.steps.forEach(s => { if (startDone(s.stepNo, it.startStep || 1, STEPS.length)) s.status = '완료'; });
            db.push(np); log(b, 'sync', np, null, '참조 시트 동기화 · ' + (slot ? slot + '번 배치' : '미배치'));
          });
          return wait(snap());
        }
        if (b.action === 'unsync') { db.forEach(x => { if ((b.projectIds || []).includes(x.id) && x.state === 'active') { log(b, 'unsync', x); x.state = 'removed'; x.slot = null; } }); return wait(snap()); }
        if (b.action === 'exclude') { (b.names || []).forEach(n => { const i = excluded.indexOf(n); if (b.on && i < 0) excluded.push(n); if (!b.on && i >= 0) excluded.splice(i, 1); log(b, b.on ? 'exclude' : 'include', { id: '', projectName: n, slot: '' }); }); return wait(snap()); }
        const p = db.find(x => x.id === b.projectId);
        if (b.action === 'setSlot' && p) {
          if (b.slot && isPackD(b.slot) && curNo(p) < PACK_MIN_STEP) return fail('패킹 칸에는 ' + PACK_MIN_STEP + '번 공정 이상만 배치할 수 있습니다.');
          const occ = b.slot && occupied(b.slot, p.id);
          if (occ && !b.force) return fail('이미 배치됨');
          if (occ) occ.slot = null;
          p.slot = b.slot ? Number(b.slot) : null; log(b, '배치 변경', p);
        }
        if (b.action === 'skipTo' && p) { applySkipLocal(p, b.stepNo); log(b, '시작 공정 지정', p); }
        if (b.action === 'bulkSkipTo') { (b.projectIds || []).forEach(id => { const x = db.find(y => y.id === id); if (x) { applySkipLocal(x, b.stepNo); log(b, '시작 공정 지정', x); } }); return wait(snap()); }
        if (b.action === 'updateProject' && p) { log(b, '프로젝트명 수정', p, null, p.projectName + ' → ' + b.projectName); p.projectName = b.projectName; }
        if (b.action === 'saveStep' && p) {
          const s = p.steps.find(x => x.stepNo === b.stepNo);
          ['status', 'startDate', 'endDate', 'owner', 'progress', 'issue'].forEach(k => (s[k] = b[k])); s.updatedAt = now(); s.updatedBy = b.user;
          log(b, '공정 저장', p, s);
        }
        if (b.action === 'saveSummary' && p) { p.summaryProgress = b.summaryProgress; p.summaryIssue = b.summaryIssue; log(b, '요약 저장', p); }
        if (b.action === 'release' && p) { p.state = b.state; p.slot = null; log(b, b.state === 'shipped' ? '출하 완료' : '삭제', p); }
        if (b.action === 'restore' && p) { p.state = 'active'; log(b, '복원', p); }
        if (p) { p.updatedAt = now(); p.updatedBy = b.user; }
        return wait(snap());
      },
    };
  })();

  // ===================== Init =====================
  renderUser();
  renderTabs();
  $('#plan').classList.add('skeleton');
  load(false).then(() => {
    $('#plan').classList.remove('skeleton');
    loadNames(false).catch(() => null); // prefetch for instant registration
    loadSync(false); // sync tab badge
  });
  setInterval(() => { if (!document.hidden && !state.pending) loadSync(false); }, 600e3);
  setInterval(() => { if (!document.hidden) load(false); }, Math.max(20, CFG.REFRESH_SEC || 60) * 1000);
})();
