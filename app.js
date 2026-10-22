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
  const PACK_MIN_STEP = 11;

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    data: null,
    names: (() => { try { return JSON.parse(LS.get('track.names') || 'null'); } catch (_) { return null; } })(),
    tab: LS.get('track.tab') === 'projects' ? 'projects' : 'board',
    filter: 'active', q: '', group: '',
    openProjectId: null, openStep: null,
    pending: 0, queue: Promise.resolve(), idMap: {},
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
    let autoProg;
    if (!cur) autoProg = `전 공정 완료 (${total}/${total})`;
    else {
      autoProg = `${cur.stepNo}. ${cur.stepName} ${cur.status}` + (String(cur.progress || '').trim() ? ` – ${String(cur.progress).trim()}` : '') + ` · ${done}/${total} 완료(${pct}%)`;
      const lastDone = steps.filter(s => s.status === '완료' && Number(s.stepNo) < Number(cur.stepNo)).pop();
      if (lastDone) autoProg += ` · 직전 완료: ${lastDone.stepNo}. ${lastDone.stepName}${lastDone.endDate ? ' (' + String(lastDone.endDate).slice(5) + ')' : ''}`;
    }
    const issueSteps = steps.filter(s => !isDone(s) && (String(s.issue || '').trim() || s.status === '조치중' || s.status === '보류'));
    const autoIssue = issueSteps.map(s => `${s.stepNo}. ${s.stepName}${s.status === '조치중' || s.status === '보류' ? '(' + s.status + ')' : ''}${String(s.issue || '').trim() ? ': ' + String(s.issue).trim() : ''}`).join(' / ');
    const manualProg = String(p.summaryProgress || '').trim();
    const manualIssue = String(p.summaryIssue || '').trim();
    const prog = manualProg || autoProg;
    const issue = manualIssue || autoIssue;
    return { done, skipped, total, pct, cur, curNo, fixing, hasIssue: fixing.length > 0 || !!issue, prog, issue, autoProg, autoIssue, manualProg, manualIssue, curStatus: cur ? cur.status : '완료', packOk: curNo >= PACK_MIN_STEP };
  }
  function cssVar(s) { return { '대기': '--st-wait', '진행': '--st-run', '조치중': '--st-fix', '완료': '--st-done', '보류': '--st-hold', '생략': '--st-skip' }[s] || '--st-wait'; }
  // pseudo project for a new registration starting at step `start` (for pack rule / options)
  const fakeProj = (start) => ({ id: null, steps: ((state.data && state.data.stepDefs) || []).map(s => ({ stepNo: s.no, status: s.no < start ? '완료' : '대기' })) });
  const startOptions = (sel) => ((state.data && state.data.stepDefs) || []).map(s => `<option value="${s.no}" ${Number(sel) === s.no ? 'selected' : ''}>${s.no}. ${esc(s.name)}</option>`).join('');
  const packMsg = () => `패킹 칸에는 현재 공정이 ${PACK_MIN_STEP}번(패킹리스트 확인) 이상인 프로젝트만 배치할 수 있습니다.`;

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
    renderProjects();
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
  }

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
    return `<button class="card ${pack ? 'pack' : ''} ${i.hasIssue ? 'has-issue' : ''}" data-pid="${esc(p.id)}" data-st="${esc(i.curStatus)}" title="${esc(p.projectName)}">
      ${typesHTML(slot)}
      <div class="card-top">${tag}<span class="pname">${esc(p.projectName)}</span></div>
      <div class="cur"><div class="lbl">${pack ? esc(slotName(slot)) + ' · ' : ''}현재 공정</div>${curHtml}</div>
      <div class="segs">${segs}</div>
      <div class="pct">${i.done}/${i.total} 완료 · ${i.pct}%</div>
      <div class="sum">
        <div><span class="t">진행</span>${i.prog ? esc(i.prog) : '<span class="muted">-</span>'}</div>
        <div class="${i.issue ? 'issue' : ''}"><span class="t">이슈</span>${i.issue ? esc(i.issue) : '<span class="muted">없음</span>'}</div>
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

    $('#plan').innerHTML = d.layout.map(it => {
      const st = `--x:${it.x};--y:${it.y};--w:${it.w};--h:${it.h}`;
      if (it.type === 'wall') return `<div class="pl wall" style="${st}"></div>`;
      if (it.type === 'fixture') return `<div class="pl fixture ${it.h > it.w * 2 ? 'tall' : ''}" style="${st}" title="${esc(it.label)}">${esc(it.label)}</div>`;
      if (it.type === 'label') return `<div class="pl label ${it.h >= 28 ? 'big' : ''}" style="${st}">${esc(it.label)}</div>`;
      if (it.type === 'slot' || it.type === 'pack') return `<div class="pl" style="${st}">${cardHTML(it.slot, map[it.slot])}</div>`;
      if (it.type === 'note') return `<div class="pl" style="${st}">${noteHTML(it)}</div>`;
      return '';
    }).join('');

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
    const head = '<div class="prow head"><div>배치</div><div>프로젝트명</div><div>현재 공정</div><div>진척률</div><div>이슈</div><div>최종 수정</div><div></div></div>';
    $('#pTable').innerHTML = head + list.map(p => {
      const i = projectInfo(p);
      const sel = p.state === 'active'
        ? `<select class="slotsel ${p.slot ? 'set' : ''}" data-pid="${esc(p.id)}" aria-label="배치">${slotOptions(p.slot, p, true)}</select>`
        : pill('출하완료');
      const cs = i.cur ? `<span class="t">${i.cur.stepNo}. ${esc(i.cur.stepName)}</span>${pill(i.cur.status)}` : `<span class="t">전 공정 완료</span>${pill('완료')}`;
      return `<div class="prow" data-pid="${esc(p.id)}">
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
          steps: (d.stepDefs || []).map(s => ({ stepNo: s.no, stepName: s.name, status: s.no < start ? '완료' : '대기', startDate: '', endDate: '', owner: '', progress: '', issue: '', fileRequired: s.file, fileCount: '', fileCheckedAt: '', updatedAt: '', updatedBy: '' })),
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

  // ===================== Events =====================
  $$('.tab').forEach(t => t.addEventListener('click', () => { state.tab = t.dataset.tab; LS.set('track.tab', state.tab); renderTabs(); window.scrollTo(0, 0); }));

  const onCardClick = e => {
    const c = e.target.closest('.card'); if (!c) return;
    if (c.dataset.note) { openNote(c.dataset.note); return; }
    if (c.dataset.pid) { state.openStep = null; renderProject(findProject(c.dataset.pid)); }
    else openSlotPicker(Number(c.dataset.slot));
  };
  $('#plan').addEventListener('click', onCardClick);
  $('#slotList').addEventListener('click', onCardClick);

  $('#pSearch').addEventListener('input', e => { state.q = e.target.value; renderProjects(); });
  $('#pFilter').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (!b) return; state.filter = b.dataset.f; renderProjects(); });
  $('#addBtn').addEventListener('click', () => openPicker({ slot: '' }));
  $('#exportBtn').addEventListener('click', openExport);
  $('#pTable').addEventListener('click', e => {
    if (e.target.closest('select')) return;
    if (e.target.closest('[data-act="add"]')) { openPicker({ slot: '' }); return; }
    const ed = e.target.closest('[data-edit]'); if (ed) { openPicker({ edit: findProject(ed.dataset.edit) }); return; }
    const dl = e.target.closest('[data-del]'); if (dl) { removeProject(findProject(dl.dataset.del)); return; }
    const r = e.target.closest('.prow[data-pid]'); if (!r) return;
    state.openStep = null; renderProject(findProject(r.dataset.pid));
  });
  $('#pTable').addEventListener('change', e => {
    const s = e.target.closest('select.slotsel'); if (!s) return;
    setSlot(findProject(s.dataset.pid), s.value);
  });

  $('#mClose').addEventListener('click', closeModal);
  $('#overlay').addEventListener('click', e => { if (e.target.id === 'overlay') closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#overlay').hidden) closeModal(); });

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
        p.steps.forEach(s => { const no = Number(s.stepNo); if (no < n && !['완료', '생략'].includes(s.status)) s.status = '완료'; if (no >= n && s.status === '생략') s.status = '대기'; });
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
    const STEPS = ['QC검수', 'QC검수 조치확인', 'FAT 셋업', 'FAT 측정(진동)', 'FAT 측정(반복정밀도)', 'FAT 측정(AWC)', '반복Cycle 촬영', 'Full Cycle 촬영', 'X1/X2 핸드레벨 촬영', '물방울 JIG 레벨 촬영', '패킹리스트 확인', '출하사진 촬영', '패킹 서류 스캔 및 인쇄', '패킹(서류 동봉)'];
    const FILE = [4, 5, 6, 7, 8, 9, 10, 12, 13];
    const L = (id, type, slot, label, x, y, w, h) => ({ id, type, slot, label, x, y, w, h });
    const layout = [
      L('wall-top', 'wall', null, '', 90, 8, 865, 52), L('wall-left', 'wall', null, '', 8, 290, 52, 370),
      L('slot-3', 'slot', 3, 'MPR, EMR, ITR', 95, 72, 132, 218), L('slot-4', 'slot', 4, 'STR, ESR', 240, 72, 132, 218), L('slot-5', 'slot', 5, 'STR, ESR', 385, 72, 132, 218),
      L('slot-6', 'slot', 6, 'MPR', 530, 72, 132, 218), L('slot-7', 'slot', 7, 'ITR, EMR', 675, 72, 132, 218), L('slot-8', 'slot', 8, 'FER', 820, 72, 132, 218),
      L('slot-2', 'slot', 2, 'MPR, ITR', 70, 302, 165, 172), L('slot-1', 'slot', 1, 'MPR', 70, 486, 165, 172),
      L('fx-table1', 'fixture', null, '테이블', 748, 605, 105, 61), L('fx-table2', 'fixture', null, '테이블', 871, 605, 105, 61),
      L('lb-class', 'label', null, 'class #1000', 400, 318, 230, 30),
      L('pack-1', 'pack', 9, '패킹 1', 268, 368, 150, 192), L('pack-2', 'pack', 10, '패킹 2', 428, 368, 150, 192),
      L('note-1', 'note', null, '기타사항', 712, 395, 264, 195),
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
    const snap = () => JSON.parse(JSON.stringify({ ok: true, layout, notes, projects: db.filter(p => p.state !== 'removed'), stepDefs: STEPS.map((n, i) => ({ no: i + 1, name: n, file: FILE.includes(i + 1) })), statuses: ['대기', '진행', '조치중', '완료', '보류', '생략'] }));
    const wait = (v) => new Promise(r => setTimeout(() => r(v), 600));
    const log = (b, action, p, s, detail) => history.push({ at: now(), by: b.user, action, actionLabel: action, projectId: p ? p.id : '', projectName: p ? p.projectName : '', slot: p ? (p.slot || '') : '', stepNo: s ? s.stepNo : '', stepName: s ? s.stepName : '', status: s ? s.status : '', startDate: s ? s.startDate : '', endDate: s ? s.endDate : '', owner: s ? s.owner : '', progress: s ? s.progress : '', issue: s ? s.issue : '', detail: detail || '' });
    const occupied = (slot, selfId) => db.find(p => p.state === 'active' && Number(p.slot) === Number(slot) && p.id !== selfId);
    const isPackD = (slot) => layout.some(l => l.type === 'pack' && l.slot === Number(slot));
    const curNo = (p) => { const c = p.steps.find(s => s.status !== '완료' && s.status !== '생략'); return c ? c.stepNo : 15; };
    return {
      get(p) {
        if (p.action === 'projectNames') return wait({ ok: true, names });
        if (p.action === 'history') return wait({ ok: true, rows: history.filter(r => (!p.projectId || r.projectId === p.projectId)) });
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
          const p = mk('P' + Date.now(), b.slot ? Number(b.slot) : null, b.projectName, -1); p.steps.forEach(s => { if (s.stepNo < (b.startStep || 1)) s.status = '완료'; }); p.createdAt = now(); p.createdBy = b.user;
          db.push(p); log(b, '프로젝트 등록', p);
        }
        const p = db.find(x => x.id === b.projectId);
        if (b.action === 'setSlot' && p) {
          if (b.slot && isPackD(b.slot) && curNo(p) < 11) return fail('패킹 칸에는 11번 공정 이상만 배치할 수 있습니다.');
          const occ = b.slot && occupied(b.slot, p.id);
          if (occ && !b.force) return fail('이미 배치됨');
          if (occ) occ.slot = null;
          p.slot = b.slot ? Number(b.slot) : null; log(b, '배치 변경', p);
        }
        if (b.action === 'skipTo' && p) { p.steps.forEach(s => { if (s.stepNo < b.stepNo && !['완료', '생략'].includes(s.status)) s.status = '완료'; if (s.stepNo >= b.stepNo && s.status === '생략') s.status = '대기'; }); log(b, '시작 공정 지정', p); }
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
  });
  setInterval(() => { if (!document.hidden) load(false); }, Math.max(20, CFG.REFRESH_SEC || 60) * 1000);
})();
