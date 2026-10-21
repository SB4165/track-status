(() => {
  'use strict';
  const CFG = window.TRACK_CONFIG || {};
  const API = (CFG.API_URL || '').trim();
  const DEMO = !API;
  const LS = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { return null; } },
  };
  const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    data: null, names: null,
    tab: LS.get('track.tab') === 'projects' ? 'projects' : 'board',
    filter: 'active', q: '',
    openProjectId: null, openStep: null, busy: false,
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
    body.user = getUser();
    const key = LS.get('track.key');
    if (key) body.key = key;
    const j = DEMO ? await Demo.post(body) : await (await fetch(API, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow',
    })).json();
    if (!j.ok) {
      if (/권한 키/.test(j.error || '')) {
        const k = prompt('입력 권한 키를 입력하세요');
        if (k) { LS.set('track.key', k.trim()); return apiPost(body); }
      }
      const e = new Error(j.error || '저장 실패'); e.code = j.code; throw e;
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
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), err ? 4500 : 2000);
  }
  const pill = (s) => `<span class="pill s-${esc(s)}">${esc(s)}</span>`;
  const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const projects = () => (state.data ? state.data.projects : []);
  const activeProjects = () => projects().filter(p => p.state === 'active');
  const slotNos = () => (state.data ? state.data.layout.filter(l => l.type === 'slot').map(l => Number(l.slot)).sort((a, b) => a - b) : []);
  const bySlot = () => { const m = {}; activeProjects().forEach(p => { if (p.slot) m[Number(p.slot)] = p; }); return m; };
  const findProject = (id) => projects().find(p => p.id === id);

  function projectInfo(p) {
    const steps = p.steps || [];
    const done = steps.filter(s => s.status === '완료').length;
    const total = steps.length || 14;
    const cur = steps.find(s => s.status !== '완료') || null;
    const fixing = steps.filter(s => s.status === '조치중');
    const openIssues = steps.filter(s => s.status !== '완료' && String(s.issue || '').trim());
    let prog = String(p.summaryProgress || '').trim();
    if (!prog) {
      const latest = steps.filter(s => String(s.progress || '').trim()).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
      if (latest) prog = `${latest.stepNo}. ${latest.progress}`;
    }
    let issue = String(p.summaryIssue || '').trim();
    if (!issue && openIssues.length) issue = openIssues.map(s => `${s.stepNo}. ${s.issue}`).join(' / ');
    const pct = Math.round(done / total * 100);
    return { done, total, pct, cur, fixing, hasIssue: fixing.length > 0 || !!issue, prog, issue, curStatus: cur ? cur.status : '완료' };
  }
  function cssVar(s) { return { '대기': '--st-wait', '진행': '--st-run', '조치중': '--st-fix', '완료': '--st-done', '보류': '--st-hold' }[s] || '--st-wait'; }

  // ===================== Mutations =====================
  async function mutate(body, okMsg) {
    if (state.busy) return false;
    state.busy = true;
    $$('#mBody .btn').forEach(b => (b.disabled = true));
    try {
      let j;
      try { j = await apiPost(body); }
      catch (e) {
        if (e.code !== 'OCCUPIED') throw e;
        if (!confirm(e.message + '\n\n기존 프로젝트를 미배치로 옮기고 이 프로젝트를 배치할까요?')) { render(); return false; }
        j = await apiPost(Object.assign({}, body, { force: true }));
      }
      state.data = j; render(); toast(okMsg || '저장되었습니다');
      return true;
    } catch (e) { toast(e.message, true); render(); return false; }
    finally { state.busy = false; $$('#mBody .btn').forEach(b => (b.disabled = false)); }
  }

  // ===================== Render =====================
  function render() {
    if (!state.data) return;
    renderTabs();
    renderBoard();
    renderProjects();
    $('#projCnt').textContent = activeProjects().length || '';
    $('#lastSync').textContent = (DEMO ? '데모 모드 · ' : '') + '최종 동기화 ' + new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    if (state.openProjectId && !$('#overlay').hidden) {
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
    if (!p) {
      return `<button class="card empty" data-slot="${slot}"><div class="card-top"><span class="no">${slot}</span></div><span class="add">+ 프로젝트 배치</span></button>`;
    }
    const i = projectInfo(p);
    const segs = (p.steps || []).map(s => `<i class="s-${esc(s.status)}" title="${esc(s.stepNo + '. ' + s.stepName + ' · ' + s.status)}"></i>`).join('');
    const curHtml = i.cur
      ? `<div class="step"><b>${i.cur.stepNo}. ${esc(i.cur.stepName)}</b>${pill(i.cur.status)}</div>`
      : `<div class="step"><b>전 공정 완료</b>${pill('완료')}</div>`;
    return `<button class="card ${i.hasIssue ? 'has-issue' : ''}" data-pid="${esc(p.id)}" data-st="${esc(i.curStatus)}" title="${esc(p.projectName)}">
      <div class="card-top"><span class="no">${slot}</span><span class="pname">${esc(p.projectName)}</span></div>
      <div class="cur"><div class="lbl">현재 공정</div>${curHtml}</div>
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
    // legend
    $('#legend').innerHTML = d.statuses.map(s => `<span><i style="background:var(${cssVar(s)})"></i>${esc(s)}</span>`).join('')
      + '<span class="hint">장비 칸을 누르면 전체 공정을 볼 수 있습니다</span>';
    // stats
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

    // floor plan
    $('#plan').innerHTML = d.layout.map(it => {
      const st = `--x:${it.x};--y:${it.y};--w:${it.w};--h:${it.h}`;
      if (it.type === 'wall') return `<div class="pl wall" style="${st}"></div>`;
      if (it.type === 'fixture') return `<div class="pl fixture ${it.h > it.w * 2 ? 'tall' : ''}" style="${st}" title="${esc(it.label)}">${esc(it.label)}</div>`;
      if (it.type === 'label') return `<div class="pl label ${it.h >= 28 ? 'big' : ''}" style="${st}">${esc(it.label)}</div>`;
      if (it.type === 'slot') return `<div class="pl" style="${st}">${cardHTML(it.slot, map[it.slot])}</div>`;
      if (it.type === 'note') return `<div class="pl" style="${st}">${noteHTML(it)}</div>`;
      return '';
    }).join('');

    // list (narrow screens)
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
    $('#noteSave').addEventListener('click', async () => {
      if (await mutate({ action: 'saveNote', id, content: $('#noteText').value }, '기타사항이 저장되었습니다')) closeModal();
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

    const q = state.q.trim().toLowerCase();
    const list = all.filter(p => {
      if (state.filter === 'active' && p.state !== 'active') return false;
      if (state.filter === 'placed' && !(p.state === 'active' && p.slot)) return false;
      if (state.filter === 'unplaced' && !(p.state === 'active' && !p.slot)) return false;
      if (state.filter === 'shipped' && p.state !== 'shipped') return false;
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
    const map = bySlot();
    const head = '<div class="prow head"><div>배치 번호</div><div>프로젝트명</div><div>현재 공정</div><div>진척률</div><div>이슈</div><div>최종 수정</div></div>';
    $('#pTable').innerHTML = head + list.map(p => {
      const i = projectInfo(p);
      const sel = p.state === 'active'
        ? `<select class="slotsel ${p.slot ? 'set' : ''}" data-pid="${esc(p.id)}" aria-label="배치 번호">
            <option value="">미배치</option>
            ${slotNos().map(n => { const o = map[n]; const other = o && o.id !== p.id; return `<option value="${n}" ${Number(p.slot) === n ? 'selected' : ''}>${n}번${other ? ' · 사용중' : ''}</option>`; }).join('')}
          </select>`
        : pill('출하완료');
      const cs = i.cur ? `<span class="t">${i.cur.stepNo}. ${esc(i.cur.stepName)}</span>${pill(i.cur.status)}` : `<span class="t">전 공정 완료</span>${pill('완료')}`;
      return `<div class="prow" data-pid="${esc(p.id)}">
        <div class="sl">${sel}</div>
        <div class="nm">${esc(p.projectName)}<small>등록 ${esc(String(p.createdAt || '').slice(0, 10))}${p.createdBy ? ' · ' + esc(p.createdBy) : ''}</small></div>
        <div class="cs">${cs}</div>
        <div class="pg"><div class="bar"><i style="width:${i.pct}%"></i></div><span>${i.done}/${i.total} · ${i.pct}%</span></div>
        <div class="is ${i.issue ? '' : 'none'}">${i.issue ? esc(i.issue) : '이슈 없음'}</div>
        <div class="dt">${esc(p.updatedAt || '')}</div>
      </div>`;
    }).join('');
  }

  // ===================== Modal =====================
  function openModal(narrow) {
    $('.sheet').classList.toggle('narrow', !!narrow);
    $('#overlay').hidden = false; document.body.style.overflow = 'hidden';
  }
  function closeModal() { $('#overlay').hidden = true; document.body.style.overflow = ''; state.openProjectId = null; state.openStep = null; }

  function slotOptions(cur, selfId) {
    const map = bySlot();
    return `<option value="">미배치</option>` + slotNos().map(n => {
      const o = map[n]; const other = o && o.id !== selfId;
      return `<option value="${n}" ${Number(cur) === n ? 'selected' : ''}>${n}번${other ? ' · ' + esc(o.projectName) : ''}</option>`;
    }).join('');
  }

  function renderProject(p, keepScroll) {
    const body = $('#mBody');
    const scroll = keepScroll ? body.scrollTop : 0;
    const i = projectInfo(p);
    const active = p.state === 'active';
    state.openProjectId = p.id;
    if (state.openStep == null && i.cur) state.openStep = Number(i.cur.stepNo);
    $('#mSlot').textContent = `${active ? (p.slot ? p.slot + '번 배치' : '미배치') : '출하완료'} · ${i.done}/${i.total} 완료`;
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
          <label class="f">배치 번호${active ? `<select class="in" id="mSlotSel">${slotOptions(p.slot, p.id)}</select>` : `<input type="text" value="출하완료" disabled>`}</label>
          <label class="f">진행사항 요약<textarea id="sumProg" rows="2" placeholder="${esc(i.prog && !p.summaryProgress ? '자동: ' + i.prog : '비워두면 공정 기록에서 자동 표시')}">${esc(p.summaryProgress)}</textarea></label>
          <label class="f">이슈사항 요약<textarea id="sumIssue" rows="2" placeholder="${esc(i.issue && !p.summaryIssue ? '자동: ' + i.issue : '비워두면 공정 기록에서 자동 표시')}">${esc(p.summaryIssue)}</textarea></label>
        </div>
        <div class="row-end"><button class="btn" id="saveSum">요약 저장</button></div>
      </div>
      <div class="section-t">전체 공정 <span class="hint">공정을 눌러 상세 입력</span></div>
      <div class="steps">${steps}</div>
      <div class="foot-actions">
        ${active
          ? '<button class="btn danger" id="removeBtn">잘못 등록 · 삭제</button><button class="btn" id="shipBtn">출하 완료</button>'
          : '<span class="hint">출하완료된 프로젝트입니다. 기록은 계속 수정할 수 있습니다.</span><button class="btn" id="restoreBtn">진행중으로 복원</button>'}
      </div>`;
    if (!keepScroll) openModal(false);
    body.scrollTop = scroll;
  }

  async function loadNames(refresh) {
    state.names = (await apiGet({ action: 'projectNames', refresh: refresh ? '1' : '0' })).names;
  }

  function openRegister(presetSlot) {
    state.openProjectId = null;
    $('#mSlot').textContent = '참조 시트(TRACK)에서 선택';
    $('#mTitle').textContent = '프로젝트 등록';
    $('#mBody').innerHTML = `
      <label class="f">프로젝트명 검색<input type="search" id="q" placeholder="프로젝트명 검색" autocomplete="off"></label>
      <div class="search-list" id="list"><div class="none">프로젝트 목록 불러오는 중…</div></div>
      <div class="grid2" style="margin-top:12px">
        <label class="f">배치 번호 (선택)<select class="in" id="regSlot">${slotOptions(presetSlot || '', null)}</select></label>
        <div class="hint" style="align-self:end;padding-bottom:6px">배치 번호는 나중에 프로젝트 관리 탭에서 바꿀 수 있습니다.</div>
      </div>
      <div class="row-end between">
        <button class="btn ghost" id="reloadNames">목록 새로고침</button>
        <button class="btn primary" id="regBtn" disabled>등록</button>
      </div>`;
    openModal(true);
    let selected = null;
    const draw = () => {
      const q = $('#q').value.trim().toLowerCase();
      const used = new Set(activeProjects().map(p => p.projectName));
      const list = (state.names || []).filter(n => !q || n.toLowerCase().includes(q));
      $('#list').innerHTML = list.length
        ? list.map(n => `<button type="button" data-n="${esc(n)}" class="${n === selected ? 'sel' : ''}" ${used.has(n) ? 'disabled' : ''}><span>${esc(n)}</span>${used.has(n) ? '<small>등록됨</small>' : ''}</button>`).join('')
        : `<div class="none">${state.names ? '검색 결과가 없습니다' : '불러오는 중…'}</div>`;
      $('#regBtn').disabled = !selected;
    };
    const load = async (refresh) => {
      try { await loadNames(refresh); draw(); }
      catch (e) { $('#list').innerHTML = `<div class="none">목록을 불러오지 못했습니다: ${esc(e.message)}</div>`; }
    };
    $('#q').addEventListener('input', draw);
    $('#list').addEventListener('click', e => { const b = e.target.closest('button[data-n]'); if (!b || b.disabled) return; selected = b.dataset.n; draw(); });
    $('#reloadNames').addEventListener('click', () => { state.names = null; draw(); load(true); });
    $('#regBtn').addEventListener('click', async () => {
      if (!selected) return;
      const name = selected;
      const ok = await mutate({ action: 'createProject', projectName: name, slot: $('#regSlot').value }, '등록되었습니다');
      if (!ok) return;
      const p = activeProjects().find(x => x.projectName === name);
      state.openStep = null;
      if (p) renderProject(p); else closeModal();
    });
    if (state.names) draw(); else load(false);
    setTimeout(() => $('#q').focus(), 60);
  }

  function openSlotPicker(slot) {
    state.openProjectId = null;
    const waiting = activeProjects().filter(p => !p.slot);
    $('#mSlot').textContent = `${slot}번 위치`;
    $('#mTitle').textContent = '배치할 프로젝트 선택';
    $('#mBody').innerHTML = `
      <div class="hint">미배치 상태의 진행중 프로젝트 ${waiting.length}건</div>
      <div class="search-list" id="wlist">${waiting.length
        ? waiting.map(p => { const i = projectInfo(p); return `<button type="button" data-pid="${esc(p.id)}"><span>${esc(p.projectName)}</span><small>${i.done}/${i.total} · ${i.cur ? esc(i.cur.stepName) : '완료'}</small></button>`; }).join('')
        : '<div class="none">미배치 프로젝트가 없습니다. 새로 등록해 주세요.</div>'}</div>
      <div class="row-end"><button class="btn primary" id="newHere">+ 새 프로젝트 등록</button></div>`;
    openModal(true);
    $('#wlist').addEventListener('click', async e => {
      const b = e.target.closest('button[data-pid]'); if (!b) return;
      if (await mutate({ action: 'setSlot', projectId: b.dataset.pid, slot }, `${slot}번에 배치되었습니다`)) closeModal();
    });
    $('#newHere').addEventListener('click', () => openRegister(slot));
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
          '배치 번호': p.slot || '', '프로젝트명': p.projectName, '상태': p.state === 'active' ? '진행중' : '출하완료',
          '현재 공정': i.cur ? `${i.cur.stepNo}. ${i.cur.stepName}` : '전 공정 완료', '현재 공정 상태': i.curStatus,
          '완료 공정': `${i.done}/${i.total}`, '진척률(%)': i.pct, '진행 요약': i.prog, '이슈 요약': i.issue,
          '등록일': p.createdAt, '등록자': p.createdBy, '최종 수정': p.updatedAt, '수정자': p.updatedBy,
        }; });
        const sheet2 = [];
        ps.forEach(p => (p.steps || []).forEach(s => sheet2.push({
          '프로젝트명': p.projectName, '배치 번호': p.slot || '', '공정 번호': s.stepNo, '공정명': s.stepName, '상태': s.status,
          '시작일': s.startDate, '완료일': s.endDate, '담당자': s.owner, '세부 진행사항': s.progress, '이슈사항': s.issue,
          '파일확인 대상': (s.fileRequired === true || String(s.fileRequired).toUpperCase() === 'TRUE') ? 'O' : '',
          '최종 수정': s.updatedAt, '수정자': s.updatedBy,
        })));
        const sheet3 = (hist.rows || []).filter(r => !r.projectId || ids.has(r.projectId) || pid === r.projectId).map(r => ({
          '일시': r.at, '작성자': r.by, '구분': r.actionLabel || r.action, '프로젝트명': r.projectName, '배치 번호': r.slot,
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
  $('#addBtn').addEventListener('click', () => openRegister(''));
  $('#exportBtn').addEventListener('click', openExport);
  $('#pTable').addEventListener('click', e => {
    if (e.target.closest('select')) return;
    if (e.target.closest('[data-act="add"]')) { openRegister(''); return; }
    const r = e.target.closest('.prow[data-pid]'); if (!r) return;
    state.openStep = null; renderProject(findProject(r.dataset.pid));
  });
  $('#pTable').addEventListener('change', e => {
    const s = e.target.closest('select.slotsel'); if (!s) return;
    const v = s.value;
    mutate({ action: 'setSlot', projectId: s.dataset.pid, slot: v }, v ? `${v}번에 배치되었습니다` : '미배치로 변경되었습니다');
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
      mutate({ action: 'saveStep', projectId: state.openProjectId, stepNo: no, status: on ? on.dataset.v : '대기', startDate: v('startDate'), endDate: v('endDate'), owner: v('owner'), progress: v('progress'), issue: v('issue') });
      return;
    }
    const id = t.closest('button') && t.closest('button').id;
    if (id === 'saveSum') mutate({ action: 'saveSummary', projectId: state.openProjectId, summaryProgress: $('#sumProg').value, summaryIssue: $('#sumIssue').value });
    if (id === 'shipBtn' && confirm('출하 완료 처리할까요?\n배치 칸은 비워지고, 기록은 프로젝트 관리 탭의 [출하완료]에 보관됩니다.')) mutate({ action: 'release', projectId: state.openProjectId, state: 'shipped' }, '출하 완료 처리되었습니다');
    if (id === 'removeBtn' && confirm('잘못 등록된 프로젝트를 삭제할까요?\n(DB 시트에는 기록이 남습니다)')) mutate({ action: 'release', projectId: state.openProjectId, state: 'removed' }, '삭제되었습니다');
    if (id === 'restoreBtn') mutate({ action: 'restore', projectId: state.openProjectId }, '진행중으로 복원되었습니다 (미배치)');
  });
  $('#mBody').addEventListener('change', e => {
    if (e.target.id === 'mSlotSel') {
      const v = e.target.value;
      mutate({ action: 'setSlot', projectId: state.openProjectId, slot: v }, v ? `${v}번에 배치되었습니다` : '미배치로 변경되었습니다');
    }
  });

  $('#refreshBtn').addEventListener('click', () => load(true));
  $('#userBtn').addEventListener('click', () => { const u = prompt('작성자 이름', LS.get('track.user') || ''); if (u !== null) { LS.set('track.user', u.trim()); renderUser(); } });

  async function load(manual) {
    if (state.busy) return;
    if (!manual && !$('#overlay').hidden) return; // don't disturb while editing
    try {
      state.data = await apiGet({ action: 'bootstrap' });
      render();
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
      L('slot-3', 'slot', 3, '', 95, 72, 132, 218), L('slot-4', 'slot', 4, '', 240, 72, 132, 218), L('slot-5', 'slot', 5, '', 385, 72, 132, 218),
      L('slot-6', 'slot', 6, '', 530, 72, 132, 218), L('slot-7', 'slot', 7, '', 675, 72, 132, 218), L('slot-8', 'slot', 8, '', 820, 72, 132, 218),
      L('slot-2', 'slot', 2, '', 70, 302, 165, 172), L('slot-1', 'slot', 1, '', 70, 486, 165, 172),
      L('fx-plate', 'fixture', null, '정반', 804, 441, 117, 66), L('fx-table1', 'fixture', null, '테이블', 748, 605, 105, 61), L('fx-table2', 'fixture', null, '테이블', 871, 605, 105, 61),
      L('fx-shelf1', 'fixture', null, '선반', 599, 460, 27, 103), L('fx-shelf2', 'fixture', null, '선반', 599, 563, 27, 103),
      L('lb-breaker', 'label', null, '메인 전기 차단기 위치', 330, 575, 200, 20), L('lb-class', 'label', null, 'class #1000', 400, 318, 230, 30),
      L('note-1', 'note', null, '기타사항', 268, 362, 305, 200),
    ];
    const notes = { 'note-1': { content: '10/24(금) 클린룸 정기 점검 예정\n메인 전기 차단기 위치 이동 작업 대기', updatedAt: '2026-10-21 09:00', updatedBy: '곽승범' } };
    const names = ['RD-SH-13-013 EMR#1', 'RD-SH-13-013 ESR#2', 'RD-SH-13-013 ESR#3', 'RD-SH-13-013 FER#0', 'RD-SH-13-013 MPR#4', 'RD-SH-13-013 MPR#5', 'RD-SH-13-013 MPR#6', 'MISC-STR10 #1', 'MISC-STR11 #1', 'MISC-FER0 #1', 'MISC-MPR7 #1', 'MISC-MPR9 #1'];
    const now = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
    const history = [];
    const mk = (id, slot, name, doneN, extra = {}) => ({
      id, slot, projectName: name, state: 'active', summaryProgress: '', summaryIssue: '', createdAt: '2026-10-1' + (doneN % 10) + ' 09:00', createdBy: '곽승범', updatedAt: now(), updatedBy: '곽승범',
      steps: STEPS.map((n, i) => {
        const no = i + 1; const status = no <= doneN ? '완료' : no === doneN + 1 ? '진행' : '대기';
        const s = { stepNo: no, stepName: n, status, startDate: no <= doneN + 1 ? '2026-10-1' + (no % 10) : '', endDate: no <= doneN ? '2026-10-2' + (no % 2) : '', owner: no <= doneN + 1 ? '곽승범' : '', progress: no === doneN + 1 ? '진행 중' : '', issue: '', fileRequired: FILE.includes(no), fileCount: '', fileCheckedAt: '', updatedAt: no <= doneN + 1 ? '2026-10-21 0' + (no % 9) + ':00' : '', updatedBy: '곽승범' };
        return Object.assign(s, extra[no] || {});
      }),
    });
    const db = [
      mk('P1', 8, names[0], 13), mk('P2', 7, names[1], 6, { 7: { status: '조치중', issue: 'Cycle 중 Z축 이음 발생, 벨트 텐션 재조정 필요' } }),
      mk('P3', 6, names[2], 3), mk('P4', 4, names[3], 1, { 2: { status: '조치중', issue: 'QC 지적사항 1건 미조치 (커버 도장)' } }),
      mk('P5', 3, names[4], 9), mk('P6', 2, names[5], 0, { 1: { status: '보류', issue: '자재 미입고' } }),
      mk('P7', null, names[6], 0), mk('P8', null, names[7], 2),
      Object.assign(mk('P9', null, names[8], 14), { state: 'shipped' }),
    ];
    const snap = () => JSON.parse(JSON.stringify({ ok: true, layout, notes, projects: db.filter(p => p.state !== 'removed'), stepDefs: STEPS, statuses: ['대기', '진행', '조치중', '완료', '보류'] }));
    const wait = (v) => new Promise(r => setTimeout(() => r(v), 200));
    const log = (b, action, p, s, detail) => history.push({ at: now(), by: b.user, action, actionLabel: action, projectId: p.id, projectName: p.projectName, slot: p.slot || '', stepNo: s ? s.stepNo : '', stepName: s ? s.stepName : '', status: s ? s.status : '', startDate: s ? s.startDate : '', endDate: s ? s.endDate : '', owner: s ? s.owner : '', progress: s ? s.progress : '', issue: s ? s.issue : '', detail: detail || '' });
    const occupied = (slot, selfId) => db.find(p => p.state === 'active' && Number(p.slot) === Number(slot) && p.id !== selfId);
    return {
      get(p) {
        if (p.action === 'projectNames') return wait({ ok: true, names });
        if (p.action === 'history') return wait({ ok: true, rows: history.filter(r => (!p.projectId || r.projectId === p.projectId)) });
        return wait(snap());
      },
      post(b) {
        const fail = (msg, code) => wait({ ok: false, error: msg, code });
        if (b.action === 'saveNote') { notes[b.id] = { content: b.content, updatedAt: now(), updatedBy: b.user }; return wait(snap()); }
        if (b.action === 'createProject') {
          if (db.some(p => p.state === 'active' && p.projectName === b.projectName)) return fail('이미 등록된 진행중 프로젝트입니다.');
          const occ = b.slot && occupied(b.slot);
          if (occ && !b.force) return fail(`${b.slot}번에는 이미 "${occ.projectName}" 프로젝트가 배치되어 있습니다.`, 'OCCUPIED');
          if (occ) occ.slot = null;
          const p = mk('P' + Date.now(), b.slot ? Number(b.slot) : null, b.projectName, -1); p.createdAt = now(); p.createdBy = b.user;
          db.push(p); log(b, '프로젝트 등록', p);
        }
        const p = db.find(x => x.id === b.projectId);
        if (b.action === 'setSlot' && p) {
          const occ = b.slot && occupied(b.slot, p.id);
          if (occ && !b.force) return fail(`${b.slot}번에는 이미 "${occ.projectName}" 프로젝트가 배치되어 있습니다.`, 'OCCUPIED');
          if (occ) occ.slot = null;
          p.slot = b.slot ? Number(b.slot) : null; log(b, '배치 변경', p);
        }
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
  $('#plan').innerHTML = '';
  $('#plan').classList.add('skeleton');
  load(false).then(() => $('#plan').classList.remove('skeleton'));
  setInterval(() => { if (!document.hidden) load(false); }, Math.max(20, CFG.REFRESH_SEC || 60) * 1000);
})();
