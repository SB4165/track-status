(() => {
  'use strict';
  const CFG = window.TRACK_CONFIG || {};
  const API = (CFG.API_URL || '').trim();
  const DEMO = !API;
  const LS = { get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} } };

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = { data: null, names: null, openProjectId: null, openSlot: null, openStep: null, busy: false };

  // ===================== API =====================
  async function apiGet(params) {
    if (DEMO) return Demo.get(params);
    const url = API + '?' + new URLSearchParams(params).toString();
    const r = await fetch(url, { redirect: 'follow' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '서버 오류');
    return j;
  }
  async function apiPost(body) {
    body.user = getUser();
    const key = LS.get('track.key');
    if (key) body.key = key;
    if (DEMO) return Demo.post(body);
    const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow' });
    const j = await r.json();
    if (!j.ok) {
      if (/권한 키/.test(j.error || '')) {
        const k = prompt('입력 권한 키를 입력하세요');
        if (k) { LS.set('track.key', k); return apiPost(body); }
      }
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
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), err ? 4000 : 2000);
  }

  function projectInfo(p) {
    const steps = p.steps || [];
    const done = steps.filter(s => s.status === '완료').length;
    const cur = steps.find(s => s.status !== '완료') || null;
    const fixing = steps.filter(s => s.status === '조치중');
    const openIssues = steps.filter(s => s.status !== '완료' && String(s.issue || '').trim());
    // summaries: manual first, otherwise auto from steps
    let prog = String(p.summaryProgress || '').trim();
    if (!prog) {
      const latest = steps.filter(s => String(s.progress || '').trim()).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
      if (latest) prog = `${latest.stepNo}. ${latest.progress}`;
    }
    let issue = String(p.summaryIssue || '').trim();
    if (!issue && openIssues.length) issue = openIssues.map(s => `${s.stepNo}. ${s.issue}`).join(' / ');
    return { done, total: steps.length || 14, cur, fixing, hasIssue: fixing.length > 0 || !!issue, prog, issue };
  }

  const pill = (s) => `<span class="pill s-${esc(s)}">${esc(s)}</span>`;

  // ===================== Render: board =====================
  function render() {
    const d = state.data; if (!d) return;
    const bySlot = {}; d.projects.forEach(p => (bySlot[Number(p.slot)] = p));
    const cols = Math.max(1, ...d.layout.map(l => l.col + (l.colSpan || 1) - 1));
    const board = $('#board');
    board.style.setProperty('--cols', cols);

    // legend
    $('#legend').innerHTML = d.statuses.map(s => `<span><i style="background:var(${cssVar(s)})"></i>${esc(s)}</span>`).join('')
      + `<span class="hint">· 칸을 누르면 전체 공정을 볼 수 있습니다</span>`;

    // stats
    const active = d.projects.length;
    const fixing = d.projects.filter(p => projectInfo(p).fixing.length).length;
    const issues = d.projects.filter(p => projectInfo(p).hasIssue).length;
    const avg = active ? Math.round(d.projects.reduce((a, p) => { const i = projectInfo(p); return a + i.done / i.total; }, 0) / active * 100) : 0;
    $('#stats').innerHTML = [
      ['진행 프로젝트', `${active}<small style="font-size:14px;color:var(--text-3);font-weight:600"> / ${d.layout.length}칸</small>`],
      ['평균 진척률', avg + '%'],
      ['조치중 프로젝트', fixing, fixing ? 'warn' : ''],
      ['이슈 있는 프로젝트', issues, issues ? 'warn' : ''],
    ].map(([k, v, c]) => `<div class="stat ${c || ''}"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');

    board.innerHTML = d.layout.slice().sort((a, b) => a.slot - b.slot).map(l => {
      const style = `--r:${l.row};--c:${l.col};--rs:${l.rowSpan || 1};--cs:${l.colSpan || 1};--order:${l.slot}`;
      const p = bySlot[l.slot];
      if (!p) {
        return `<div class="slot" style="${style}"><button class="card empty" data-slot="${l.slot}">
          <span class="no">${l.slot}</span><span class="add">+ 프로젝트 등록</span></button></div>`;
      }
      const i = projectInfo(p);
      const segs = (p.steps || []).map(s => `<i class="s-${esc(s.status)}" title="${esc(s.stepNo + '. ' + s.stepName + ' · ' + s.status)}"></i>`).join('');
      const curHtml = i.cur
        ? `<div class="step"><b>${i.cur.stepNo}. ${esc(i.cur.stepName)}</b>${pill(i.cur.status)}</div>`
        : `<div class="step"><b>전 공정 완료</b>${pill('완료')}</div>`;
      return `<div class="slot" style="${style}"><button class="card ${i.hasIssue ? 'has-issue' : ''}" data-pid="${esc(p.id)}">
        <div class="card-top"><span class="no">${l.slot}</span><span class="pname" title="${esc(p.projectName)}">${esc(p.projectName)}</span></div>
        <div class="cur"><div class="lbl">현재 공정</div>${curHtml}</div>
        <div class="segs">${segs}</div>
        <div class="pct">${i.done}/${i.total} 완료 · ${Math.round(i.done / i.total * 100)}%</div>
        <div class="sum">
          <div><span class="t">진행</span>${i.prog ? esc(i.prog) : '<span class="muted">-</span>'}</div>
          <div class="${i.issue ? 'issue' : ''}"><span class="t">이슈</span>${i.issue ? esc(i.issue) : '<span class="muted">없음</span>'}</div>
        </div>
      </button></div>`;
    }).join('');

    $('#lastSync').textContent = (DEMO ? '데모 모드 · ' : '') + '최종 동기화 ' + new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

    // refresh open modal
    if (state.openProjectId) {
      const p = d.projects.find(x => x.id === state.openProjectId);
      if (p) renderProject(p, true); else closeModal();
    }
  }
  function cssVar(s) { return { '대기': '--st-wait', '진행': '--st-run', '조치중': '--st-fix', '완료': '--st-done', '보류': '--st-hold' }[s] || '--st-wait'; }

  // ===================== Modal =====================
  function openModal() { $('#overlay').hidden = false; document.body.style.overflow = 'hidden'; }
  function closeModal() { $('#overlay').hidden = true; document.body.style.overflow = ''; state.openProjectId = null; state.openSlot = null; state.openStep = null; }

  function renderProject(p, keepScroll) {
    const body = $('#mBody');
    const scroll = keepScroll ? body.scrollTop : 0;
    const i = projectInfo(p);
    state.openProjectId = p.id;
    if (state.openStep == null && i.cur) state.openStep = Number(i.cur.stepNo);
    $('#mSlot').textContent = `${p.slot}번 · ${i.done}/${i.total} 완료`;
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
          <div class="seg-ctl" data-seg="${no}">${state.data.statuses.map(x => `<button type="button" class="s-${x} ${x === s.status ? 'on' : ''}" data-v="${x}">${x}</button>`).join('')}</div>
          <div class="grid3 dates">
            <label class="f">시작일<input type="date" name="startDate" value="${esc(s.startDate)}"></label>
            <label class="f">완료일<input type="date" name="endDate" value="${esc(s.endDate)}"></label>
            <label class="f">담당자<input type="text" name="owner" value="${esc(s.owner)}" placeholder="이름"></label>
          </div>
          <label class="f">세부 진행사항<textarea name="progress" rows="3" placeholder="진행 내용을 입력하세요">${esc(s.progress)}</textarea></label>
          <label class="f">이슈사항<textarea name="issue" rows="2" placeholder="이슈가 있으면 입력하세요">${esc(s.issue)}</textarea></label>
          ${isFile ? `<div class="filecheck"><span>NAS 폴더 파일 업로드 확인 <b>자동화 예정</b></span><span class="meta">${s.fileCheckedAt ? '확인 ' + esc(s.fileCheckedAt) + ' · ' + esc(s.fileCount) + '개' : '미연동'}</span></div>` : ''}
          <div class="row-end" style="align-items:center;justify-content:space-between">
            <span class="meta">${s.updatedAt ? '수정 ' + esc(s.updatedAt) + (s.updatedBy ? ' · ' + esc(s.updatedBy) : '') : ''}</span>
            <button class="btn primary" data-save="${no}">저장</button>
          </div>
        </div>
      </div>`;
    }).join('');

    body.innerHTML = `
      <div class="section-t">요약 <span class="hint">비워두면 공정 기록에서 자동 표시</span></div>
      <div class="box">
        <div class="grid2">
          <label class="f">진행사항 요약<textarea id="sumProg" rows="2" placeholder="${esc(i.prog && !p.summaryProgress ? '자동: ' + i.prog : '진행사항 요약')}">${esc(p.summaryProgress)}</textarea></label>
          <label class="f">이슈사항 요약<textarea id="sumIssue" rows="2" placeholder="${esc(i.issue && !p.summaryIssue ? '자동: ' + i.issue : '이슈사항 요약')}">${esc(p.summaryIssue)}</textarea></label>
        </div>
        <div class="row-end"><button class="btn" id="saveSum">요약 저장</button></div>
      </div>
      <div class="section-t">전체 공정 <span class="hint">공정을 눌러 상세 입력</span></div>
      <div class="steps">${steps}</div>
      <div class="foot-actions">
        <button class="btn danger" id="removeBtn">잘못 등록 · 삭제</button>
        <button class="btn" id="shipBtn">출하 완료 · 칸 비우기</button>
      </div>`;
    if (!keepScroll) openModal();
    body.scrollTop = scroll;
  }

  async function renderAssign(slot) {
    state.openSlot = slot; state.openProjectId = null;
    $('#mSlot').textContent = `${slot}번 칸`;
    $('#mTitle').textContent = '프로젝트 등록';
    const body = $('#mBody');
    body.innerHTML = `
      <label class="f">프로젝트명 검색<input type="text" id="q" placeholder="참조 시트(TRACK) 프로젝트 검색" autocomplete="off"></label>
      <div class="search-list" id="list"><div class="none">프로젝트 목록 불러오는 중…</div></div>
      <div class="row-end" style="justify-content:space-between;align-items:center">
        <button class="btn ghost" id="reloadNames">목록 새로고침</button>
        <button class="btn primary" id="assignBtn" disabled>등록</button>
      </div>`;
    openModal();
    let selected = null;
    const draw = () => {
      const q = $('#q').value.trim().toLowerCase();
      const used = new Set(state.data.projects.map(p => p.projectName));
      const list = (state.names || []).filter(n => !q || n.toLowerCase().includes(q));
      $('#list').innerHTML = list.length
        ? list.map(n => `<button type="button" data-n="${esc(n)}" class="${n === selected ? 'sel' : ''}" ${used.has(n) ? 'disabled' : ''}>${esc(n)}${used.has(n) ? ' · 등록됨' : ''}</button>`).join('')
        : `<div class="none">${state.names ? '검색 결과가 없습니다' : '불러오는 중…'}</div>`;
      $('#assignBtn').disabled = !selected;
    };
    const load = async (refresh) => {
      try { state.names = (await apiGet({ action: 'projectNames', refresh: refresh ? '1' : '0' })).names; draw(); }
      catch (e) { $('#list').innerHTML = `<div class="none">목록을 불러오지 못했습니다: ${esc(e.message)}</div>`; }
    };
    $('#q').addEventListener('input', draw);
    $('#list').addEventListener('click', e => { const b = e.target.closest('button[data-n]'); if (!b || b.disabled) return; selected = b.dataset.n; draw(); });
    $('#reloadNames').addEventListener('click', () => { state.names = null; draw(); load(true); });
    $('#assignBtn').addEventListener('click', async () => {
      if (!selected) return;
      await mutate({ action: 'assign', slot, projectName: selected }, '등록되었습니다');
      const p = state.data.projects.find(x => x.projectName === selected);
      state.openStep = null;
      if (p) renderProject(p); else closeModal();
    });
    if (state.names) draw(); else load(false);
    setTimeout(() => $('#q').focus(), 50);
  }

  async function mutate(body, okMsg) {
    if (state.busy) return;
    state.busy = true;
    document.querySelectorAll('#mBody .btn').forEach(b => (b.disabled = true));
    try {
      const j = await apiPost(body);
      state.data = j; render(); toast(okMsg || '저장되었습니다');
    } catch (e) { toast(e.message, true); document.querySelectorAll('#mBody .btn').forEach(b => (b.disabled = false)); }
    finally { state.busy = false; }
  }

  // ===================== Events =====================
  $('#board').addEventListener('click', e => {
    const c = e.target.closest('.card'); if (!c) return;
    if (c.dataset.pid) { const p = state.data.projects.find(x => x.id === c.dataset.pid); state.openStep = null; renderProject(p); }
    else renderAssign(Number(c.dataset.slot));
  });
  $('#mClose').addEventListener('click', closeModal);
  $('#overlay').addEventListener('click', e => { if (e.target.id === 'overlay') closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#overlay').hidden) closeModal(); });

  $('#mBody').addEventListener('click', e => {
    const t = e.target;
    const tog = t.closest('[data-toggle]');
    if (tog) { const n = Number(tog.dataset.toggle); const el = tog.closest('.st'); const open = !el.classList.contains('open'); document.querySelectorAll('.st.open').forEach(x => x.classList.remove('open')); if (open) el.classList.add('open'); state.openStep = open ? n : -1; return; }
    const segBtn = t.closest('.seg-ctl button');
    if (segBtn) { segBtn.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === segBtn)); return; }
    const save = t.closest('[data-save]');
    if (save) {
      const no = Number(save.dataset.save); const el = save.closest('.st');
      const v = n => el.querySelector(`[name=${n}]`).value;
      const status = (el.querySelector('.seg-ctl button.on') || {}).dataset?.v || '대기';
      mutate({ action: 'saveStep', projectId: state.openProjectId, stepNo: no, status, startDate: v('startDate'), endDate: v('endDate'), owner: v('owner'), progress: v('progress'), issue: v('issue') });
      return;
    }
    if (t.id === 'saveSum') { mutate({ action: 'saveSummary', projectId: state.openProjectId, summaryProgress: $('#sumProg').value, summaryIssue: $('#sumIssue').value }); return; }
    if (t.id === 'shipBtn') { if (confirm('출하 완료 처리하고 칸을 비울까요?\n(기록은 시트에 보관됩니다)')) mutate({ action: 'release', projectId: state.openProjectId, state: 'shipped' }, '출하 완료 처리되었습니다'); return; }
    if (t.id === 'removeBtn') { if (confirm('잘못 등록된 프로젝트를 칸에서 삭제할까요?\n(기록은 시트에 보관됩니다)')) mutate({ action: 'release', projectId: state.openProjectId, state: 'removed' }, '삭제되었습니다'); return; }
  });

  // auto-fill dates when status changes (convenience)
  $('#mBody').addEventListener('click', e => {
    const b = e.target.closest('.seg-ctl button'); if (!b) return;
    const el = b.closest('.st'); const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const sd = el.querySelector('[name=startDate]'), ed = el.querySelector('[name=endDate]');
    if (b.dataset.v !== '대기' && !sd.value) sd.value = today;
    if (b.dataset.v === '완료' && !ed.value) ed.value = today;
  });

  $('#refreshBtn').addEventListener('click', () => load(true));
  $('#userBtn').addEventListener('click', () => { const u = prompt('작성자 이름', LS.get('track.user') || ''); if (u !== null) { LS.set('track.user', u.trim()); renderUser(); } });

  async function load(manual) {
    if (state.busy) return;
    // do not overwrite while user is typing in an open step
    if (!manual && !$('#overlay').hidden) return;
    try { state.data = await apiGet({ action: 'bootstrap' }); render(); $('#banner').hidden = !DEMO; if (DEMO) $('#banner').textContent = '데모 모드입니다. config.js에 Apps Script URL을 설정하면 실제 데이터가 연동됩니다.'; if (manual) toast('새로고침 완료'); }
    catch (e) { toast('불러오기 실패: ' + e.message, true); $('#lastSync').textContent = '연결 오류'; }
  }

  function skeleton() {
    $('#board').innerHTML = Array.from({ length: 8 }, () => '<div class="skeleton" style="min-height:200px"></div>').join('');
    $('#board').style.setProperty('--cols', 4);
  }

  // ===================== Demo backend =====================
  const Demo = (() => {
    const STEPS = ['QC검수', 'QC검수 조치확인', 'FAT 셋업', 'FAT 측정(진동)', 'FAT 측정(반복정밀도)', 'FAT 측정(AWC)', '반복Cycle 촬영', 'Full Cycle 촬영', 'X1/X2 핸드레벨 촬영', '물방울 JIG 레벨 촬영', '패킹리스트 확인', '출하사진 촬영', '패킹 서류 스캔 및 인쇄', '패킹(서류 동봉)'];
    const FILE = [4, 5, 6, 7, 8, 9, 10, 12, 13];
    const layout = [[3, 1, 1], [4, 1, 2], [5, 1, 3], [6, 1, 4], [7, 1, 5], [8, 1, 6], [2, 2, 1], [1, 3, 1]].map(([slot, row, col]) => ({ slot, row, col, rowSpan: 1, colSpan: 1 }));
    const names = ['MISC-MPR7 #1', 'MISC-MPR9 #1', 'MISC-MPR4 #1', 'MISC-ITR12 #1', 'MISC-EMR1 #1', 'MISC-ESR2 #1', 'MISC-ESR3 #1', 'MISC-MPR8 #1'];
    const mk = (id, slot, name, doneN, extra = {}) => ({
      id, slot, projectName: name, state: 'active', summaryProgress: '', summaryIssue: '',
      steps: STEPS.map((n, i) => {
        const no = i + 1; let status = no <= doneN ? '완료' : no === doneN + 1 ? '진행' : '대기';
        const s = { stepNo: no, stepName: n, status, startDate: no <= doneN + 1 ? '2026-10-1' + Math.min(9, no % 10) : '', endDate: no <= doneN ? '2026-10-2' + (no % 2) : '', owner: no <= doneN + 1 ? '곽승범' : '', progress: no === doneN + 1 ? '측정 진행 중, 오후 완료 예정' : '', issue: '', fileRequired: FILE.includes(no), fileCount: '', fileCheckedAt: '', updatedAt: no <= doneN + 1 ? '2026-10-21 0' + (no % 9) + ':00' : '', updatedBy: '곽승범' };
        return Object.assign(s, (extra[no] || {}));
      }),
    });
    const db = {
      projects: [
        mk('P1', 8, names[0], 13),
        mk('P2', 7, names[1], 6, { 7: { status: '조치중', issue: 'Cycle 중 Z축 이음 발생, 벨트 텐션 재조정 필요' } }),
        mk('P3', 6, names[2], 3),
        mk('P4', 4, names[3], 1, { 2: { status: '조치중', issue: 'QC 지적사항 3건 중 1건 미조치 (커버 도장)' } }),
        mk('P5', 3, names[4], 9),
        mk('P6', 2, names[5], 0, { 1: { status: '보류', issue: '자재 미입고' } }),
      ],
    };
    const snap = () => JSON.parse(JSON.stringify({ ok: true, layout, projects: db.projects.filter(p => p.state === 'active'), stepDefs: STEPS, statuses: ['대기', '진행', '조치중', '완료', '보류'] }));
    const now = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
    const wait = (v) => new Promise(r => setTimeout(() => r(v), 250));
    return {
      get(p) { return wait(p.action === 'projectNames' ? { ok: true, names } : snap()); },
      post(b) {
        if (b.action === 'assign') {
          if (db.projects.some(p => p.state === 'active' && Number(p.slot) === b.slot)) return Promise.reject(new Error('이미 프로젝트가 있습니다.'));
          db.projects.push(mk('P' + Date.now(), b.slot, b.projectName, -1));
        }
        const p = db.projects.find(x => x.id === b.projectId);
        if (b.action === 'saveStep' && p) { const s = p.steps.find(x => x.stepNo === b.stepNo); ['status', 'startDate', 'endDate', 'owner', 'progress', 'issue'].forEach(k => (s[k] = b[k])); s.updatedAt = now(); s.updatedBy = b.user; }
        if (b.action === 'saveSummary' && p) { p.summaryProgress = b.summaryProgress; p.summaryIssue = b.summaryIssue; }
        if (b.action === 'release' && p) p.state = b.state;
        return wait(snap());
      },
    };
  })();

  // ===================== Init =====================
  renderUser();
  skeleton();
  load(false);
  setInterval(() => { if (!document.hidden) load(false); }, Math.max(20, CFG.REFRESH_SEC || 60) * 1000);
})();
