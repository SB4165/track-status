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
  // workspace: 트랙 (default) | 개발 — ?ws=dev or remembered on this PC; the server keeps a separate DB per workspace
  const WSS = { track: '트랙(Track)', dev: '개발' };
  const WS = (() => { let q = null; try { q = new URLSearchParams(location.search).get('ws'); } catch (_) { /* ignore */ } const v = q || LS.get('track.ws'); return WSS[v] ? v : 'track'; })();
  const DEV = WS === 'dev'; // 개발: 품질 dashboard + 프로젝트 관리 only, 8 slots, 장비 위치 instead of 전용 타입
  const wsKey = (k) => (DEV ? k.replace(/^track\./, 'dev.') : k);
  const PACK_MIN_STEP = DEV ? 99 : 12;

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    data: null,
    names: (() => { try { return JSON.parse(LS.get(wsKey('track.names')) || 'null'); } catch (_) { return null; } })(),
    tab: (DEV ? ['projects', 'sync', 'ncr'] : ['projects', 'sync', 'ncr', 'fat', 'etc']).includes(LS.get(wsKey('track.tab'))) ? LS.get(wsKey('track.tab')) : 'board',
    fatSub: LS.get('track.fatSub') === 'res' ? 'res' : 'fat', // FAT 테스트: FAT | Resolution 계산
    etcSub: ['agree', 'minutes', 'refs', 'misc'].includes(LS.get('track.etcSub')) ? LS.get('track.etcSub') : 'agree',
    filter: 'active', q: '', group: '',
    openProjectId: null, openStep: null, openTrack: 'qa',
    dash: DEV ? 'qa' : 'all', // dashboard view: 'all' (통합, read-only) | 'mfg' (제조) | 'qa' (품질)
    pending: 0, queue: Promise.resolve(), idMap: {}, psel: new Set(),
  };

  // ===================== API =====================
  async function apiGet(params) {
    if (DEV) params = Object.assign({ ws: 'dev' }, params);
    if (DEMO) return Demo.get(params);
    const r = await fetch(API + '?' + new URLSearchParams(params).toString(), { redirect: 'follow' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '서버 오류');
    return j;
  }
  async function apiPost(body) {
    if (DEV) body.ws = 'dev';
    const key = SS.get(keyName(body.scope));
    if (key) body.key = key;
    const j = DEMO ? await Demo.post(body) : await (await fetch(API, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow',
    })).json();
    if (!j.ok) {
      if (/비밀번호|권한 키/.test(j.error || '')) SS.del(keyName(body.scope));
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
  const locOf = (n) => String((((state.data && state.data.notes) || {})['loc:' + n] || {}).content || '').trim();
  const typesHTML = (n) => { if (DEV) { const l = locOf(n); return `<div class="types loc" data-loc="${esc(n)}" title="눌러서 장비 위치 입력"><span class="lk">장비 위치</span><span class="lv">${l ? esc(l) : '<span class="muted">미입력</span>'}</span></div>`; } const t = slotTypes(n); return t.length ? `<div class="types">${t.map(x => `<i>${esc(x)}</i>`).join('')}</div>` : ''; };
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
  // 제조 track: same project, steps = p.mfg (no manual summaries); placement is shared with 품질
  const mfgDefs = () => (state.data && state.data.mfgStepDefs) || [];
  const vpM = (p) => Object.assign({}, p, { steps: p.mfg || [], summaryProgress: '', summaryIssue: '', _mfg: true });
  const vp = (p) => (state.dash === 'mfg' ? vpM(p) : p);
  const ALL = () => state.dash === 'all';
  // projects shown on the current dashboard (제조: equipment slots only — pack slots exist only in 품질)
  const boardMap = () => { const m = bySlot(); if (state.dash === 'mfg') Object.keys(m).forEach(k => { if (isPack(k)) delete m[k]; }); return m; };
  const notStarted = (c) => !c || (Number(c.stepNo) === 1 && c.status === '대기');
  // 통합: one track per project — 제조 until 품질 has begun (품질 follows 제조); 제조 finished or pack slot -> 품질
  const liveTrack = (p) => { const qStarted = (p.steps || []).some(s => s.status !== '대기'); const mOpen = (p.mfg || []).some(s => s.status !== '완료' && s.status !== '생략');
    return !qStarted && mOpen && !isPack(p.slot) ? 'mfg' : 'qa'; };
  // 통합 진척률 = (제조 완료 단계 + 품질 완료 단계) / (제조 + 품질 단계 수); 패킹 칸 프로젝트는 제조 완료로 간주
  function comboInfo(p) {
    const q = projectInfo(p);
    const mt = (p.mfg || []).length || mfgDefs().length || 10;
    const m = isPack(p.slot) ? { done: mt, total: mt, pct: 100 } : (p.mfg || []).length ? projectInfo(vpM(p)) : { done: 0, total: mt, pct: 0 };
    const done = m.done + q.done, total = m.total + q.total;
    return { done, total, pct: total ? Math.round(done / total * 100) : 0, m, q };
  }

  function projectInfo(p) {
    const steps = p.steps || [];
    const isDone = s => s.status === '완료' || s.status === '생략';
    const skipped = steps.filter(s => s.status === '생략').length;
    // 품질: 출하(마지막, 17번)는 공정 수·진척률에서 제외 (총 16단계로 표시; 패킹(서류 동봉) 완료 = 100%)
    const shipLast = !p._mfg && steps.length > 1 && /출하/.test(String(steps[steps.length - 1].stepName || '')) && !/촬영/.test(String(steps[steps.length - 1].stepName || ''));
    const countSteps = shipLast ? steps.slice(0, -1) : steps;
    const done = countSteps.filter(isDone).length;
    const total = countSteps.length || 14;
    const cur = steps.find(s => !isDone(s)) || null;
    // parallel group: every open step of the current step's group is "current"
    const defs = p._mfg ? mfgDefs() : undefined; // 제조 view uses the 제조 parallel groups
    const curGroup = cur && parOf(cur.stepNo, defs) ? steps.filter(s => !isDone(s) && parOf(s.stepNo, defs) === parOf(cur.stepNo, defs)) : (cur ? [cur] : []);
    const curNo = cur ? Number(cur.stepNo) : steps.length + 1;
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
    return { countSteps, done, skipped, total, pct, cur, curGroup, curNo, fixing, hasIssue: fixing.length > 0 || !!issue, prog, issue, progTip: manualProg || progFull, issueTip: manualIssue || issueFull, autoProg, autoIssue, manualProg, manualIssue, curStatus: cur ? cur.status : '완료', packOk: curNo >= PACK_MIN_STEP };
  }
  // compress free text into a short summary: split numbered/line items, drop numbering and
  // non-numeric (…) notes, one item per line
  // put each numbered item ('2. ', '3) ') on its own line
  // **bold** markup (Ctrl+B in 진행사항/이슈사항) — stored as plain text, rendered as <b>
  const MD_B = /\*\*([^*\n]+?)\*\*/g;
  const mdView = (t) => esc(t).replace(MD_B, '<b>$1</b>');
  const stripMd = (t) => String(t ?? '').replace(MD_B, '$1');
  const md2html = (t) => mdView(t).replace(/\n/g, '<br>');
  function html2md(root) {
    let out = '';
    const walk = (n, bold) => {
      if (n.nodeType === 3) { out += bold ? n.nodeValue.split('\n').map(l => (l ? '\u0001' + l + '\u0002' : l)).join('\n') : n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName;
      if (tag === 'BR') { out += '\n'; return; }
      const block = tag === 'DIV' || tag === 'P';
      if (block && out && !out.endsWith('\n')) out += '\n';
      const fw = n.style && n.style.fontWeight;
      const b = bold || tag === 'B' || tag === 'STRONG' || fw === 'bold' || Number(fw) >= 600;
      n.childNodes.forEach(c => walk(c, b));
      if (block && n.nextSibling && !out.endsWith('\n')) out += '\n';
    };
    root.childNodes.forEach(c => walk(c, false));
    // merge adjacent bold runs, then turn markers into ** (skip whitespace-only runs)
    return out.replace(/\u0002\u0001/g, '').replace(/\u0001(\s*)([^\u0002]*?)(\s*)\u0002/g, (m, a, x, z) => (x ? `${a}**${x}**${z}` : a + z)).replace(/\u00a0/g, ' ').replace(/\n+$/, '');
  }
  const fieldVal = (el) => (el && el.isContentEditable ? html2md(el) : (el ? el.value : ''));
  const lineBreaks = (t) => String(t || '').replace(/[ \t]+(?=\d{1,2}[.)]\s+\S)/g, '\n').trim();
  function summarize(text) {
    const t = String(text || '').replace(/\r/g, '').trim();
    if (!t) return '';
    const items = t.split(/\n+|\s*\/\s+|(?:^|\s)(?=\d{1,2}[.)]\s*\S)/)
      .map(x => x.replace(/^\s*\d{1,2}[.)]\s*/, '').replace(/^(?:[-·•]|\*(?!\*))\s*/, '')
        .replace(/\s*[(（][^()（）]*[)）]/g, m => (/\d/.test(m) ? m : ''))
        .replace(/\s+/g, ' ').replace(/[\s,.;:]+$/, '').trim())
      .filter(Boolean);
    if (!items.length) return '';
    // one line per item (numbered when there are several); sentences are kept whole (no truncation)
    return items.length > 1 ? items.map((x, k) => `${k + 1}. ${x}`).join('\n') : items[0];
  }
  function cssVar(s) { return { '대기': '--st-wait', '진행': '--st-run', '조치중': '--st-fix', '완료': '--st-done', '보류': '--st-hold', '생략': '--st-skip' }[s] || '--st-wait'; }
  // pseudo project for a new registration starting at step `start` (for pack rule / options)
  // done-before-start rule; starting at the last step (출하완료) = every step done
  // parallel groups (stepDefs[].par): starting at a grouped step keeps the whole group open
  // defs: step definitions (default 품질 stepDefs; 제조 passes mfgDefs())
  const parOf = (no, defs) => { const d = (defs || (state.data && state.data.stepDefs) || [])[Number(no) - 1]; return d && d.par ? d.par : ''; };
  const groupStart = (n, defs) => { const g = parOf(n, defs); return g ? Math.min(...(defs || state.data.stepDefs).filter(s => s.par === g).map(s => s.no)) : n; };
  // 품질: last step = 출하 (everything done); 제조: start = total + 1 means 제조 전 공정 완료
  const startDone = (no, start, total, defs, mfg) => no < groupStart(start, defs) || (!mfg && start >= total);
  // starting at the last step (출하완료) also ships the project (moves to 출하완료, slot cleared)
  const applySkipLocal = (p, n, mfg) => { if (mfg) { (p.mfg || []).forEach(s => { const no = Number(s.stepNo); const dn = startDone(no, n, 0, mfgDefs(), true); if (dn && !['완료', '생략'].includes(s.status)) s.status = '완료'; if (!dn && s.status === '생략') s.status = '대기'; }); return; }
    const total = (p.steps || []).length; p.steps.forEach(s => { const no = Number(s.stepNo); if (startDone(no, n, total) && !['완료', '생략'].includes(s.status)) s.status = '완료'; if (!startDone(no, n, total) && s.status === '생략') s.status = '대기'; }); if (n >= total && p.state === 'active') { p.state = 'shipped'; p.slot = null; } };
  const fakeProj = (start) => { const defs = (state.data && state.data.stepDefs) || []; return { id: null, steps: defs.map(s => ({ stepNo: s.no, status: startDone(s.no, start, defs.length) ? '완료' : '대기' })) }; };
  const startOptions = (sel, mfg) => (mfg ? mfgDefs() : ((state.data && state.data.stepDefs) || [])).map(s => `<option value="${s.no}" ${Number(sel) === s.no ? 'selected' : ''}>${s.no}. ${esc(s.name)}</option>`).join('')
    + (mfg ? `<option value="${mfgDefs().length + 1}" ${Number(sel) > mfgDefs().length ? 'selected' : ''}>제조 전 공정 완료</option>` : '');
  const packMsg = () => `패킹 칸에는 현재 공정이 ${PACK_MIN_STEP}번(${esc(((state.data && state.data.stepDefs) || [])[PACK_MIN_STEP - 1]?.name || '')}) 이상인 프로젝트만 배치할 수 있습니다.`;

  // ===================== Optimistic mutations =====================
  // apply(data) changes local data immediately; the request is queued and synced in the background.
  // password dialog (once per tab session)
  // passwords per dashboard: 'mfg' = 제조 (step saves + placement from 제조), default = 통합·품질·프로젝트 관리·FAT 업로드
  const keyName = (scope) => (scope === 'mfg' ? 'track.key.mfg' : 'track.key');
  const needKey = (scope) => !!(state.data && (scope === 'mfg' ? (state.data.keyRequiredMfg ?? state.data.keyRequired) : state.data.keyRequired)) && !SS.get(keyName(scope));
  function askKey(scope) {
    return new Promise(resolve => {
      const ov = document.createElement('div');
      ov.className = 'overlay'; ov.style.zIndex = '90';
      ov.innerHTML = `<div class="sheet narrow" role="dialog" aria-modal="true"><div class="sheet-head"><div><div class="eyebrow">입력·수정·삭제 권한 · ${scope === 'mfg' ? '제조 대시보드' : '품질·프로젝트 관리'}</div><h2>비밀번호 입력</h2></div></div>
        <div class="sheet-body"><label class="f">비밀번호<input type="password" id="pwIn" autocomplete="current-password"></label>
        <div class="hint" id="pwMsg" style="margin-top:6px">이 창(탭)을 닫기 전까지는 다시 묻지 않습니다.</div>
        <div class="row-end"><button class="btn" id="pwNo">취소</button><button class="btn primary" id="pwOk">확인</button></div></div></div>`;
      document.body.appendChild(ov);
      const inp = ov.querySelector('#pwIn'); const msg = ov.querySelector('#pwMsg'); const okB = ov.querySelector('#pwOk');
      const done = (v) => { ov.remove(); resolve(v); };
      const submit = async () => {
        const v = inp.value.trim(); if (!v) { inp.focus(); return; }
        okB.disabled = true; msg.textContent = '확인 중…'; msg.style.color = '';
        SS.set(keyName(scope), v);
        try { await apiPost({ action: 'checkKey', scope: scope || '' }); done(true); }
        catch (e) { SS.del(keyName(scope)); msg.textContent = e.message; msg.style.color = 'var(--danger)'; okB.disabled = false; inp.select(); }
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
        <div class="sheet-body"><div class="hint" style="font-size:14px;white-space:pre-line">${esc(msg)}</div>
        <div class="row-end"><button class="btn" data-a="0">아니오</button><button class="btn primary" data-a="1">예</button></div></div></div>`;
      document.body.appendChild(ov);
      ov.addEventListener('click', e => { const b = e.target.closest('[data-a]'); if (!b) return; ov.remove(); resolve(b.dataset.a === '1'); });
      setTimeout(() => ov.querySelector('[data-a="1"]').focus(), 30);
    });
  }

  function mutate(body, okMsg, apply, after) {
    if (!body.scope && (body.track === 'mfg' || (body.action === 'saveNote' && /^mfg:/.test(body.id)) || (body.action === 'setSlot' && state.tab === 'board' && state.dash === 'mfg'))) body.scope = 'mfg';
    if (needKey(body.scope)) { askKey(body.scope).then(ok => { if (ok) mutate(body, okMsg, apply, after); }); return false; }
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
    renderNcr();
    $('#projCnt').textContent = activeProjects().length || '';
    let dl = $('#userList'); if (!dl) { dl = document.createElement('datalist'); dl.id = 'userList'; document.body.appendChild(dl); }
    dl.innerHTML = ((state.data && state.data.users) || []).map(n => `<option value="${esc(n)}">`).join('');
    if (!$('#overlay').hidden && $('#mTitle').textContent === '사용자 선택') openUsers();
    // FAT test project list: placed projects whose current step is 3~6 (FAT 셋업 ~ FAT 측정(AWC))
    if (window.FatTab) window.FatTab.setProjects(Object.values(bySlot()).map(p => ({ p, i: projectInfo(p) })).filter(x => x.i.curNo >= 3 && x.i.curNo <= 6)
      .sort((a, b) => a.p.slot - b.p.slot).map(({ p, i }) => ({ name: p.projectName, label: `${slotName(p.slot)} · ${p.projectName} · ${i.cur.stepNo}. ${i.cur.stepName}` })));
    syncLabel();
    // re-render the open project only for local changes (server syncs must not wipe what the user is typing)
    if (!fromServer && state.openProjectId && !$('#overlay').hidden) {
      const p = findProject(state.openProjectId);
      if (p) openProj(p, true); else closeModal();
    }
  }

  // top groups: 대시보드 | 프로젝트 관리 (projects · sync · ncr) | FAT 테스트
  const PM_TABS = ['projects', 'sync', 'ncr'];
  function renderTabs() {
    const pm = PM_TABS.includes(state.tab);
    if (pm) LS.set('track.pmTab', state.tab);
    $$('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === state.tab || (t.dataset.tab === 'pm' && pm)));
    $('#subTabs').hidden = !pm;
    $('#viewBoard').hidden = state.tab !== 'board';
    $('#viewProjects').hidden = state.tab !== 'projects';
    $('#viewSync').hidden = state.tab !== 'sync';
    $('#viewNcr').hidden = state.tab !== 'ncr';
    const fat = state.tab === 'fat', etc = state.tab === 'etc';
    $('#fatTabs').hidden = !fat; $$('#fatTabs [data-ftab]').forEach(b => b.classList.toggle('on', b.dataset.ftab === state.fatSub));
    $('#viewFat').hidden = !(fat && state.fatSub === 'fat');
    $('#viewRes').hidden = !(fat && state.fatSub === 'res');
    if (fat && state.fatSub === 'fat' && window.FatTab) window.FatTab.show();
    if (fat && state.fatSub === 'res' && window.ResTab) window.ResTab.show();
    $('#etcTabs').hidden = !etc; $$('#etcTabs [data-etab]').forEach(b => b.classList.toggle('on', b.dataset.etab === state.etcSub));
    $('#viewEtc').hidden = !etc;
    if (etc) renderEtc();
    fitPlan();
  }
  // canvas is 1000 wide; height follows the layout (lowest item + margin)
  const planH = () => Math.max(300, ...((state.data && state.data.layout) || []).map(l => Number(l.y) + Number(l.h) + 8));
  // floor plan always uses the full width (fit-to-screen shrinking removed on request); only re-fit card summaries
  function fitPlan() {
    if (state.tab === 'board') { fitCards(); placeProcSide(); }
  }
  // keep the process list in view while scrolling (stays within the floor plan's height)
  function followProcSide() {
    const side = $('#procSide'); if (!side || side.hidden) return;
    const wrap = $('.plan-wrap'); const r = wrap.getBoundingClientRect();
    const topbar = ($('.topbar') || {}).offsetHeight || 0;
    const max = Math.max(0, r.height - side.offsetHeight);
    const stick = Math.max(0, topbar + 12 - r.top);
    // reach the plan's bottom line when the page is scrolled to the end
    const s0 = window.scrollY + r.top - topbar - 12, s1 = document.documentElement.scrollHeight - window.innerHeight;
    const lerp = s1 > s0 ? max * Math.min(1, Math.max(0, (window.scrollY - s0) / (s1 - s0))) : (window.scrollY >= s1 - 1 ? max : 0);
    side.style.top = Math.min(max, Math.max(stick, lerp)) + 'px';
  }
  window.addEventListener('scroll', () => { if (state.tab === 'board') followProcSide(); }, { passive: true });
  // full process list in the free space left of the floor plan (plan size unchanged; hidden when there is no room)
  function placeProcSide() {
    const wrap = $('.plan-wrap'); if (!wrap || !state.data) return;
    let side = $('#procSide');
    if (!side) { side = document.createElement('aside'); side.id = 'procSide'; side.className = 'proc-side'; wrap.appendChild(side); }
    const free = wrap.getBoundingClientRect().left;
    if (window.innerWidth <= 900 || free < 112) { side.hidden = true; return; }
    const w = Math.min(250, free - (free < 196 ? 10 : 20));
    side.style.width = w + 'px'; side.hidden = false;
    side.classList.toggle('compact', w < 176);
    side.style.right = `calc(100% + ${free < 196 ? 6 : 14}px)`;
    side.style.maxHeight = $('#plan').getBoundingClientRect().height + 'px';
    // one list per track (통합 = 제조 + 품질); count = placed projects whose current step is it (not-started projects excluded)
    const sec = (defs, info, qa, title) => {
      const cnt = {}; Object.values(boardMap()).forEach(p => { if (state.dash === 'all' && liveTrack(p) !== (qa ? 'qa' : 'mfg')) return; const c = info(p).cur; if (notStarted(c)) return;
        const k = parOf(c.stepNo, defs) ? groupStart(c.stepNo, defs) : c.stepNo; cnt[k] = (cnt[k] || 0) + 1; });
      const parPos = (s) => { if (!s.par) return ''; const g = defs.filter(x => x.par === s.par); return g.length < 2 ? '' : s.no === g[0].no ? 'par par-s' : s.no === g[g.length - 1].no ? 'par par-e' : 'par'; };
      const nStep = qa && defs.length > 1 && /^출하$/.test(String(defs[defs.length - 1].name).trim()) ? defs.length - 1 : defs.length; // 출하 is not counted
      return `<div class="ps-h">${title} <span>${nStep}단계</span></div><ol>${defs.map(s => `<li class="${qa && s.no >= PACK_MIN_STEP ? 'pk' : ''} ${qa ? '' : 'mf'} ${parPos(s)}"><b>${s.no}</b><span class="nm">${esc(s.name)}</span>${cnt[s.no] ? `<em ${parPos(s) ? `style="--gn:${defs.filter(x => x.par === s.par).length}"` : ''} title="${parPos(s) ? '현재 이 병행 공정인 프로젝트 (합계)' : '현재 이 공정인 프로젝트'}">${cnt[s.no]}</em>` : ''}</li>`).join('')}</ol>`;
    };
    const qd = state.data.stepDefs || [];
    const qs = () => sec(qd, p => projectInfo(p), true, state.dash === 'all' ? '품질 공정' : '전체 공정');
    const ms = () => sec(mfgDefs(), p => projectInfo(vpM(p)), false, state.dash === 'all' ? '제조 공정' : '전체 공정');
    side.innerHTML = (state.dash === 'mfg' ? ms() : state.dash === 'all' ? ms() + '<div class="ps-gap"></div>' + qs() : qs())
      + `<div class="ps-f"><div class="ps-l"><em>n</em><span>배치·착수된 프로젝트 수 (현재 공정)</span></div>${(state.dash !== 'mfg' ? qd : []).concat(state.dash !== 'qa' ? mfgDefs() : []).some(s => s.par) ? '<div class="ps-l"><i class="parbar"></i><span>병행 공정</span></div>' : ''}</div>`;
    // whole list visible: tighten rows step by step until it fits the plan height (통합 = 제조 + 품질 lists)
    side.classList.remove('d1', 'd2', 'd3');
    for (const c of ['d1', 'd2', 'd3']) { if (side.scrollHeight <= side.clientHeight + 1) break; side.classList.add(c); }
    // parallel-group names stay on one line: shrink the font until they fit
    side.querySelectorAll('li.par .nm').forEach(n => { let f = parseFloat(getComputedStyle(n).fontSize); n.style.fontSize = ''; f = parseFloat(getComputedStyle(n).fontSize); while (n.scrollWidth > n.clientWidth + 0.5 && f > 8) { f -= 0.5; n.style.fontSize = f + 'px'; } });
    followProcSide();
  }
  // summaries use up to 3 lines, fewer when a card has no room (full text stays in the tooltip)
  // each of 진행/이슈 shows up to 6 lines (as space allows); when the card is full, the longer block gives up a line first (min 1 each).
  // Hidden text ends with '…', the full text is in the tooltip and the detail window.
  function fitCards() {
    $$('#plan .card[data-pid]').forEach(c => {
      const vs = $$('.sum .v', c); if (!vs.length) return;
      const lines = vs.map(() => 6);
      const apply = () => vs.forEach((v, k) => { v.style.webkitLineClamp = lines[k]; });
      apply();
      // first shrink the summary text a little so whole sentences fit, clamp lines only as a last resort
      const sum = $('.sum', c);
      for (const f of [1, .92, .85, .78]) { sum.style.fontSize = f === 1 ? '' : (0.82 * f) + 'em'; if (c.scrollHeight <= c.clientHeight + 1) break; }
      let guard = 8;
      while (c.scrollHeight > c.clientHeight + 1 && guard--) {
        const used = vs.map((v, k) => Math.min(lines[k], Math.round(v.scrollHeight / (parseFloat(getComputedStyle(v).lineHeight) || 14))));
        let k = used[0] >= used[1] ? 0 : 1; if (vs.length < 2) k = 0;
        if (lines[k] <= 1) k = 1 - k;
        if (!vs[k] || lines[k] <= 1) break;
        lines[k] = Math.min(lines[k], used[k]) - 1 || 1; apply();
      }
    });
  }
  window.addEventListener('resize', () => { clearTimeout(fitPlan._t); fitPlan._t = setTimeout(fitPlan, 80); });

  // 개발: TYPE (reference sheet column J) next to the project name
  const refTypeHTML = (name) => {
    if (!DEV || !SY.rows) return '';
    const r = SY.rows.find(x => x.name === name);
    return r && r.type ? ` <span class="ptype">${esc(r.type)}</span>` : '';
  };
  function cardHTML(slot, p) {
    const pack = isPack(slot);
    const tag = `<span class="no ${pack ? 'pk' : ''}">${esc(slotTag(slot))}</span>`;
    if (!p) {
      if (ALL()) return `<div class="card empty ro ${pack ? 'pack' : ''}">${typesHTML(slot)}<div class="card-top">${tag}</div><span class="add">${pack ? esc(slotName(slot)) : '비어 있음'}</span></div>`;
      return `<button class="card empty ${pack ? 'pack' : ''}" data-slot="${slot}">${typesHTML(slot)}<div class="card-top">${tag}</div><span class="add">${pack ? `${esc(slotName(slot))}<br><small>${PACK_MIN_STEP}번 공정 이상 배치</small>` : '+ 프로젝트 배치'}</span></button>`;
    }
    const i = projectInfo(p);
    const segs = i.countSteps.map(s => `<i class="s-${esc(s.status)}" title="${esc(s.stepNo + '. ' + s.stepName + ' · ' + s.status)}"></i>`).join('');
    // parallel group: list started steps (or the first one); big groups get a short "+n" note
    const gShow = i.curGroup.length > 2 ? (i.curGroup.filter(s => s.status !== '대기').slice(0, 2).concat().length ? i.curGroup.filter(s => s.status !== '대기').slice(0, 2) : i.curGroup.slice(0, 1)) : i.curGroup;
    const gMore = i.curGroup.length - gShow.length;
    const curHtml = i.cur
      ? gShow.map(s => `<div class="step ${i.curGroup.length > 1 ? 'g' : ''}"><b>${s.stepNo}. ${esc(s.stepName)}</b>${pill(s.status)}</div>`).join('') + (gMore > 0 ? `<div class="gmore" title="${esc(i.curGroup.map(s => `${s.stepNo}. ${s.stepName} (${s.status})`).join('\n'))}">병행 공정 ${gMore}개 더</div>` : '')
      : `<div class="step"><b>전 공정 완료</b>${pill('완료')}</div>`;
    return `<button class="card ${pack ? 'pack' : ''} ${i.hasIssue ? 'has-issue' : ''}" ${state.dash === 'qa' ? 'draggable="true"' : ''} data-pid="${esc(p.id)}" data-st="${esc(i.curStatus)}" title="${esc(p.projectName)}">
      ${typesHTML(slot)}
      <div class="card-top">${tag}<span class="pname">${esc(p.projectName)}${refTypeHTML(p.projectName)}</span></div>
      <div class="cur"><div class="lbl">${pack ? esc(slotName(slot)) + ' · ' : ''}현재 공정${i.curGroup.length > 1 ? '<span class="partag">병행</span>' : ''}</div>${curHtml}</div>
      <div class="segs">${segs}</div>
      <div class="pct">${i.done}/${i.total} 완료 · ${i.pct}%</div>
      <div class="sum">
        <div class="row" title="${esc(stripMd(i.progTip))}"><span class="t">진행</span><span class="v">${mdView(lineBreaks(i.prog))}</span></div>
        <div class="row ${i.issue ? 'issue' : ''}" title="${esc(stripMd(i.issueTip))}"><span class="t">이슈</span><span class="v">${i.issue ? mdView(lineBreaks(i.issue)) : '<span class="muted">없음</span>'}</span></div>
      </div>
    </button>`;
  }

  // 통합 card: 제조 + 품질 progress, combined issues (read-only)
  function allCardHTML(slot, p) {
    if (!p) return cardHTML(slot, null);
    const pack = isPack(slot);
    const m = projectInfo(vpM(p)), q = projectInfo(p);
    const trk = (lbl, i, cls) => `<div class="trk ${cls}"><div class="th"><span class="tl">${lbl}</span><span class="tp">${i.done}/${i.total} · ${i.pct}%</span></div>
      <div class="tc">${i.cur ? i.curGroup.slice(0, 2).map(s => `<span class="tn"><b>${s.stepNo}. ${esc(s.stepName)}</b>${pill(s.status)}</span>`).join('') : `<span class="tn"><b>전 공정 완료</b>${pill('완료')}</span>`}</div>
      <div class="bar"><i style="width:${i.pct}%"></i></div></div>`;
    const iss = [!pack && m.issue ? '[제조] ' + m.issue : '', q.issue ? (pack ? '' : '[품질] ') + q.issue : ''].filter(Boolean).join('\n');
    const tip = [!pack && m.issueTip ? '[제조] ' + stripMd(m.issueTip) : '', q.issueTip ? '[품질] ' + stripMd(q.issueTip) : ''].filter(Boolean).join('\n');
    const lv = liveTrack(p) === 'mfg' ? m : q; // 진행 = the live track's progress
    const st = !pack && m.cur && !notStarted(m.cur) && (m.fixing.length || !q.cur || notStarted(q.cur)) ? m.curStatus : q.curStatus;
    return `<button class="card all ${pack ? 'pack' : ''} ${(!pack && m.hasIssue) || q.hasIssue ? 'has-issue' : ''}" data-pid="${esc(p.id)}" data-st="${esc(st)}" title="${esc(p.projectName)}">
      ${typesHTML(slot)}
      <div class="card-top"><span class="no ${pack ? 'pk' : ''}">${esc(slotTag(slot))}</span><span class="pname">${esc(p.projectName)}</span></div>
      ${liveTrack(p) === 'mfg' ? trk('제조', m, 'mf') : trk('품질', q, 'qa')}
      <div class="sum"><div class="row" title="${esc(stripMd(lv.progTip))}"><span class="t">진행</span><span class="v">${lv.prog ? mdView(lineBreaks(lv.prog)) : '<span class="muted">없음</span>'}</span></div><div class="row ${iss ? 'issue' : ''}" title="${esc(tip)}"><span class="t">이슈</span><span class="v">${iss ? mdView(lineBreaks(iss)) : '<span class="muted">없음</span>'}</span></div></div>
    </button>`;
  }
  const DASH = [['all', '통합'], ['mfg', '제조'], ['qa', '품질']];
  function renderBoard() {
    const d = state.data;
    const map = boardMap();
    const placed = Object.values(map);
    const mode = state.dash;
    $('#dashTabs').hidden = DEV;
    $('#dashTabs').innerHTML = DEV ? '' : DASH.map(([k, l]) => `<button type="button" class="dtab ${mode === k ? 'on' : ''}" data-dash="${k}">${l}</button>`).join('');
    $('#legend').innerHTML = d.statuses.map(s => `<span><i style="background:var(${cssVar(s)})"></i>${esc(s)}</span>`).join('')
      + `<span class="hint">${mode === 'all' ? '통합 보기 (조회 전용) — 수정은 제조·품질 탭에서' : mode === 'mfg' ? '제조 공정 · 배치는 품질과 공유됩니다' : '장비 칸을 누르면 전체 공정을 볼 수 있습니다'}</span>`;
    $('#legend').insertAdjacentHTML('beforeend', `<button type="button" class="btn cap-btn" id="capBtn" title="공정 목록 + 배치도를 이미지로 클립보드에 복사"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>화면 복사</button>`);
    const avgOf = (f) => placed.length ? Math.round(placed.reduce((a, p) => a + f(p).pct, 0) / placed.length) : 0;
    const nSlots = slotItems().filter(l => mode !== 'mfg' || l.type !== 'pack').length;
    const unplaced = activeProjects().filter(p => !p.slot).length;
    let cards;
    if (mode === 'all') {
      const issues = placed.filter(p => projectInfo(p).hasIssue || (!isPack(p.slot) && projectInfo(vpM(p)).hasIssue)).length;
      cards = [
        ['placed', '배치 프로젝트', `${placed.length}<small> / ${nSlots}칸 · 대기 ${unplaced}</small>`],
        ['avgA', '통합 평균 진척률', avgOf(comboInfo) + '%'],
        ['avgM', '제조 평균 진척률', avgOf(p => projectInfo(vpM(p))) + '%'],
        ['avgQ', '품질 평균 진척률', avgOf(p => projectInfo(p)) + '%'],
        ['issue', '이슈 있음', issues, issues ? 'warn' : ''],
      ];
    } else {
      const inf = p => projectInfo(vp(p));
      const fixing = placed.filter(p => inf(p).fixing.length).length;
      const issues = placed.filter(p => inf(p).hasIssue).length;
      cards = [
        ['placed', '배치 프로젝트', `${placed.length}<small> / ${nSlots}칸 · 대기 ${unplaced}</small>`],
        ['avg', '평균 진척률', avgOf(inf) + '%'],
        ['fixing', '조치중', fixing, fixing ? 'warn' : ''],
        ['issue', '이슈 있음', issues, issues ? 'warn' : ''],
      ];
    }
    $('#stats').innerHTML = cards.map(([key, k, v, c]) => `<button type="button" class="stat ${c || ''}" data-stat="${key}" title="눌러서 프로젝트 목록 보기"><div class="k">${k}<span class="go">목록 ›</span></div><div class="v">${v}</div></button>`).join('');
    $('#stats').classList.toggle('c5', cards.length === 5);
    // 통합: 프로젝트 그룹별 진척률 (그룹 = 프로젝트 관리 탭의 그룹 기준)
    let gb = $('#grpProg');
    if (!gb) {
      $('#stats').insertAdjacentHTML('afterend', '<div class="grp-prog" id="grpProg" hidden></div>'); gb = $('#grpProg');
      gb.addEventListener('click', e => { const b = e.target.closest('[data-grp]'); if (b) openStatList('avgA', b.dataset.grp); });
    }
    gb.hidden = mode !== 'all' || !placed.length;
    if (mode === 'all' && placed.length) {
      const G = {}; placed.forEach(p => { const g = groupOf(p.projectName); (G[g] = G[g] || []).push(comboInfo(p)); });
      const av = (xs, f) => Math.round(xs.reduce((a, x) => a + f(x), 0) / xs.length);
      gb.innerHTML = '<span class="gp-h">그룹별 진척률</span>' + Object.keys(G).sort((a, b) => a.localeCompare(b)).map(g => {
        const xs = G[g]; const a = av(xs, x => x.pct), m = av(xs, x => x.m.pct), q = av(xs, x => x.q.pct);
        return `<button type="button" class="gp" data-grp="${esc(g)}" title="${esc(g)} · ${xs.length}건 — 눌러서 프로젝트 목록 보기"><span class="gp-n">${esc(g)}<small>${xs.length}건</small></span><span class="gp-bar"><i style="width:${a}%"></i></span><b>${a}%</b><span class="gp-s">제조 ${m}% · 품질 ${q}%</span></button>`;
      }).join('');
    }

    const card = (n) => (mode === 'all' ? allCardHTML(n, map[n]) : cardHTML(n, map[n] && vp(map[n])));
    $('#plan').classList.toggle('ro', mode === 'all');
    $('#plan').style.setProperty('--ch', planH());
    $('#plan').innerHTML = d.layout.map(it => {
      const st = `--x:${it.x};--y:${it.y};--w:${it.w};--h:${it.h}`;
      if (it.type === 'wall') return `<div class="pl wall" style="${st}"></div>`;
      if (it.type === 'fixture') return `<div class="pl fixture ${it.h > it.w * 2 ? 'tall' : ''}" style="${st}" title="${esc(it.label)}">${esc(it.label)}</div>`;
      if (it.type === 'label') return `<div class="pl label ${it.h >= 28 ? 'big' : ''}" style="${st}">${esc(it.label)}</div>`;
      if (it.type === 'door') return `<div class="pl door" style="${st}" title="${esc(it.label || '출입문')}"><svg viewBox="0 0 40 24" aria-hidden="true"><path d="M3 22h34"/><path d="M6 22V6"/><path d="M6 6a16 16 0 0 1 16 16"/></svg><span>${esc(it.label || '출입문')}</span></div>`;
      if (it.type === 'pack') return mode === 'mfg' ? '' : `<div class="pl" ${mode === 'qa' ? `data-pack="${it.slot}"` : ''} style="${st}">${card(it.slot)}</div>`;
      if (it.type === 'slot') return `<div class="pl" style="${st}">${card(it.slot)}</div>`;
      if (it.type === 'note') return `<div class="pl" style="${st}">${noteHTML(it)}</div>`;
      if (it.type === 'spec') return `<div class="pl" style="${st}">${specHTML(it)}</div>`;
      return '';
    }).join('');
    requestAnimationFrame(fitCards);

    const notes = d.layout.filter(l => l.type === 'note');
    const specs = d.layout.filter(l => l.type === 'spec');
    $('#slotList').innerHTML = (notes.length ? '<div class="sec-t" style="grid-column:1/-1">기타사항</div>' + notes.map(noteHTML).join('') : '')
      + specs.map(s => `<div style="grid-column:1/-1">${specHTML(s)}</div>`).join('')
      + '<div class="sec-t" style="grid-column:1/-1">배치 번호순</div>'
      + slotItems().filter(l => mode !== 'mfg' || l.type !== 'pack').map(l => card(Number(l.slot))).join('');
  }

  // robot specification table (layout type 'spec')
  const SPEC = [
    ['Wafer', '(Warpage, Thickness, Type etc.)', '0.775mm Si wafer, max warpage : 0.5mm\n1mm warpage in the future 0.5-1.2mm glass wafer, max warpage: 0.5mm'],
    ['Vibration', '', '≤ 0.3mm (end effector)'],
    ['Repeatablity + AWC', '', 'MPR ≤ 0.1mm\nMPR 외 ≤ 0.15mm', true],
    ['Noise', '', 'SEMI standard'],
    ['Particle', '', 'ISO Standard Class 1'],
    ['Leveling of robot', '', 'Y-axis ≤ 0.08°\nZ-axis ≤ 0.08°\nX-axis ≤ 0.03°'],
    ['WPH', '', 'more than 300WPH'],
  ];
  function specHTML(it) {
    return `<div class="spec"><div class="spec-h">${esc('TRACK Robot Specification')}</div>
      <table><thead><tr><th>NO</th><th>Item</th><th>Specification</th></tr></thead><tbody>${SPEC.map((r, k) => `<tr class="${r[3] ? 'hl' : ''}"><td class="sn">${k + 1}</td><td class="it">${esc(r[0])}${r[1] ? `<small>${esc(r[1])}</small>` : ''}</td><td class="sp">${esc(r[2])}</td></tr>`).join('')}</tbody></table></div>`;
  }
  // note text style: 'size|weight' (size s/m/l/xl, weight n/b)
  const NOTE_SIZES = [['s', '작게', '.78em'], ['m', '보통', '.88em'], ['l', '크게', '1em'], ['xl', '아주 크게', '1.15em']];
  const noteStyle = (st) => { const [sz, wt] = String(st || '').split('|'); const s = NOTE_SIZES.find(x => x[0] === sz) || NOTE_SIZES[1]; return { size: s[0], weight: wt === 'b' ? 'b' : 'n', css: `font-size:${s[2]};font-weight:${wt === 'b' ? 700 : 400}` }; };
  // 기타사항: 제조 dashboard keeps its own note ('mfg:' + id); 통합 shows the 품질 note
  const noteKey = (id) => (state.dash === 'mfg' && state.tab === 'board' ? 'mfg:' + id : id);
  function noteHTML(it) {
    const key = noteKey(it.id);
    const n = (state.data.notes || {})[key] || {};
    const has = String(n.content || '').trim();
    return `<button class="card note" data-note="${esc(key)}">
      <div class="note-h"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v12l-4 4H4z"/><path d="M16 20v-4h4"/><path d="M8 9h8M8 13h5"/></svg>${esc(it.label || '기타사항')}</div>
      <div class="note-c" style="${noteStyle(n.style).css}">${has ? noteBody(n.content) : '<span class="muted">눌러서 입력하세요</span>'}</div>
      ${n.updatedAt ? `<div class="note-m">${esc(n.updatedAt)}${n.updatedBy ? ' · ' + esc(n.updatedBy) : ''}</div>` : ''}
    </button>`;
  }

  function openNote(id) {
    state.openProjectId = null;
    const it = state.data.layout.find(l => l.id === String(id).replace(/^mfg:/, '')) || {};
    const n = (state.data.notes || {})[id] || {};
    $('#mSlot').textContent = n.updatedAt ? `최종 수정 ${n.updatedAt}${n.updatedBy ? ' · ' + n.updatedBy : ''}` : '프로젝트 외 공지, 설비, 일정 등';
    $('#mTitle').textContent = (/^mfg:/.test(id) ? '제조 · ' : '') + (it.label || '기타사항');
    // rich editor: select text, then 굵게 (Ctrl+B) / 크게 / 아주 크게; stored as sanitized HTML with a '<!--rt-->' marker
    $('#mBody').innerHTML = `
      <div class="note-tools">
        <button type="button" class="tb" data-cmd="bold" title="굵게 (Ctrl+B)"><b>B</b> 굵게</button>
        <button type="button" class="tb" data-size="l" title="선택한 글자 크게">가 크게</button>
        <button type="button" class="tb" data-size="xl" title="선택한 글자 아주 크게"><span style="font-size:1.15em">가</span> 아주 크게</button>
        <button type="button" class="tb" data-cmd="removeFormat" title="선택한 부분 서식 지우기">서식 지우기</button>
        <span class="hint">글자를 선택한 뒤 버튼을 누르세요 · Ctrl+B 굵게</span>
      </div>
      <div class="f"><span>내용</span><div id="noteText" class="note-ed" contenteditable="true" style="${noteStyle(n.style).css}" data-ph="예) 10/24 클린룸 점검 예정, 메인 전기 차단기 이전 작업 등">${noteBody(n.content)}</div></div>
      <div class="row-end"><button class="btn primary" id="noteSave">저장</button></div>`;
    openModal(true);
    const ed = $('#noteText');
    $('.note-tools').addEventListener('mousedown', e => { if (e.target.closest('.tb')) e.preventDefault(); }); // keep the selection
    $('.note-tools').addEventListener('click', e => {
      const b = e.target.closest('.tb'); if (!b) return;
      ed.focus();
      if (b.dataset.cmd) { document.execCommand(b.dataset.cmd, false, null); return; }
      document.execCommand('fontSize', false, '7');
      $$('font[size="7"]', ed).forEach(f => { const sp = document.createElement('span'); sp.className = 'fs-' + b.dataset.size; sp.innerHTML = f.innerHTML; f.replaceWith(sp); });
    });
    $('#noteSave').addEventListener('click', () => {
      const html = cleanNoteHTML(ed.innerHTML);
      const plain = ed.innerText.replace(/\n{3,}/g, '\n\n').trim();
      const rich = /<(b|strong|span)\b/i.test(html);
      const content = rich ? '<!--rt-->' + html : plain;
      const style = n.style || '';
      closeModal();
      mutate({ action: 'saveNote', id, content, style }, '기타사항이 저장되었습니다', (d, user) => {
        d.notes = d.notes || {}; d.notes[id] = { content, style, updatedAt: nowStr(), updatedBy: user };
      });
    });
    setTimeout(() => ed.focus(), 60);
  }
  // note content: plain text (escaped) or '<!--rt-->' + sanitized HTML (b/strong/br/div/p + span.fs-l/.fs-xl only)
  function cleanNoteHTML(html) {
    const box = document.createElement('div'); box.innerHTML = String(html || '');
    const walk = (node) => {
      [...node.childNodes].forEach(c => {
        if (c.nodeType === 3) return;
        if (c.nodeType !== 1) { c.remove(); return; }
        walk(c);
        const tag = c.tagName;
        if (tag === 'B' || tag === 'STRONG') { const b = document.createElement('b'); b.innerHTML = c.innerHTML; c.replaceWith(b); return; }
        if (tag === 'BR') return;
        if (tag === 'DIV' || tag === 'P') { const d = document.createElement('div'); d.innerHTML = c.innerHTML; c.replaceWith(d); return; }
        if (tag === 'SPAN' && /\bfs-(l|xl)\b/.test(c.className)) { const sp = document.createElement('span'); sp.className = (c.className.match(/fs-(xl|l)/) || [])[0]; sp.innerHTML = c.innerHTML; c.replaceWith(sp); return; }
        if (tag === 'SPAN' && /font-weight:\s*(bold|[6-9]00)/i.test(c.getAttribute('style') || '')) { const b = document.createElement('b'); b.innerHTML = c.innerHTML; c.replaceWith(b); return; }
        c.replaceWith(...c.childNodes); // unwrap anything else
      });
    };
    walk(box);
    return box.innerHTML;
  }
  const noteBody = (content) => { const c = String(content || ''); return c.startsWith('<!--rt-->') ? cleanNoteHTML(c.slice(9)) : esc(c); };

  function renderProjects() {
    const all = projects();
    const counts = {
      active: all.filter(p => p.state === 'active').length,
      placed: all.filter(p => p.state === 'active' && p.slot).length,
      unplaced: all.filter(p => p.state === 'active' && !p.slot).length,
      shipped: all.filter(p => p.state === 'shipped').length,
      all: all.length,
    };
    const F = [['all', '전체'], ['active', '진행중'], ['placed', '배치중'], ['unplaced', '미배치'], ['shipped', '출하완료']];
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
    const bulkMfg = !DEV && LS.get('track.bulkTrack') === 'mfg';
    const bar = state.psel.size ? `<div class="bulkbar"><span>선택 <b>${state.psel.size}</b>건</span>${DEV ? '' : `<select class="in" id="bulkTrack" style="width:auto"><option value="qa" ${bulkMfg ? '' : 'selected'}>품질</option><option value="mfg" ${bulkMfg ? 'selected' : ''}>제조</option></select>`}<span class="hint">현재 공정</span><select class="in" id="bulkStep">${startOptions(Number(LS.get(bulkMfg ? 'track.bulkStepM' : 'track.bulkStep')) || 1, bulkMfg)}</select><button class="btn primary" id="bulkApply">일괄 적용</button><button class="btn ghost" id="bulkClear">선택 해제</button><span class="hint">${bulkMfg ? '선택한 제조 공정 이전은 완료 처리 · \'제조 전 공정 완료\'를 고르면 제조 공정 전체 완료' : `선택한 공정 이전은 완료 처리 · 마지막 공정(${(state.data.stepDefs || []).length}. ${esc(((state.data.stepDefs || []).slice(-1)[0] || {}).name || '')})을 고르면 전 공정 완료 + 출하완료로 이동`}</span></div>` : '';
    const head = bar + '<div class="prow head"><div class="ck"><input type="checkbox" data-pall="1" ' + (allOn ? 'checked' : '') + ' aria-label="전체 선택"></div><div>배치</div><div>프로젝트명</div><div>현재 공정</div><div>진척률</div><div>이슈</div><div>최종 수정</div><div></div></div>';
    $('#pTable').innerHTML = head + list.map(p => {
      const i = projectInfo(p);
      const sel = p.state === 'active'
        ? `<select class="slotsel ${p.slot ? 'set' : ''}" data-pid="${esc(p.id)}" aria-label="배치">${slotOptions(p.slot, p, true)}</select>`
        : '<span class="shipbadge"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h11v9H3z"/><path d="M14 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/></svg>출하완료</span>';
      const cs = i.cur ? i.curGroup.map(s => `<span class="cs1">${i.curGroup.length > 1 ? '<span class="partag">병행</span>' : ''}<span class="t">${s.stepNo}. ${esc(s.stepName)}</span>${pill(s.status)}</span>`).join('') : `<span class="t">전 공정 완료</span>${pill('완료')}`;
      return `<div class="prow ${state.psel.has(p.id) ? 'picked' : ''}" data-pid="${esc(p.id)}">
        <div class="ck"><input type="checkbox" data-pck="${esc(p.id)}" ${state.psel.has(p.id) ? 'checked' : ''} aria-label="선택"></div>
        <div class="sl">${sel}</div>
        <div class="nm">${esc(p.projectName)}<small>${esc(groupOf(p.projectName))} · 등록 ${esc(String(p.createdAt || '').slice(0, 10))}${p.createdBy ? ' · ' + esc(p.createdBy) : ''}</small></div>
        <div class="cs">${cs}</div>
        <div class="pg"><div class="bar"><i style="width:${i.pct}%"></i></div><span>${i.done}/${i.total} · ${i.pct}%</span></div>
        <div class="is ${i.issue ? '' : 'none'}" title="${esc(stripMd(i.issueTip))}">${i.issue ? mdView(lineBreaks(i.issue)) : '이슈 없음'}</div>
        <div class="dt">${esc(p.updatedAt || '')}</div>
        <div class="act">
          <button class="ib" data-edit="${esc(p.id)}" title="프로젝트명 수정" aria-label="수정"><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg></button>
          <button class="ib del" data-del="${esc(p.id)}" title="삭제" aria-label="삭제"><svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/></svg></button>
        </div>
      </div>`;
    }).join('');
  }

  // ===================== Modal =====================
  // dashboard card → project list (placed projects; row opens the project)
  const STAT_DEF = {
    placed: ['배치 프로젝트', '배치된 프로젝트 · 배치 칸 순', () => true],
    avg: ['평균 진척률', '배치된 프로젝트 · 진척률 높은 순', () => true],
    fixing: ['조치중', '조치중 공정이 있는 프로젝트', i => i.fixing.length > 0],
    issue: ['이슈 있음', '이슈·조치중·보류가 있는 프로젝트', i => i.hasIssue],
    avgA: ['통합 평균 진척률', '배치된 프로젝트 · 통합 진척률 높은 순', () => true],
    avgM: ['제조 평균 진척률', '배치된 프로젝트 · 제조 진척률 높은 순', () => true],
    avgQ: ['품질 평균 진척률', '배치된 프로젝트 · 품질 진척률 높은 순', () => true],
  };
  function openStatList(key, grp) {
    const def = STAT_DEF[key]; if (!def) return;
    state.openProjectId = null;
    const all = ALL();
    // 통합: rows carry both tracks (m = 제조, i = 품질); the list is read-only like the board
    let list = Object.values(boardMap()).map(p => { const i = projectInfo(vp(p)); const m = all && !isPack(p.slot) ? projectInfo(vpM(p)) : null; return { p, i, m }; })
      .filter(x => all && key === 'issue' ? x.i.hasIssue || (x.m && x.m.hasIssue) : def[2](x.i))
      .filter(x => !grp || groupOf(x.p.projectName) === grp);
    const pctOf = (x) => (key === 'avgA' ? comboInfo(x.p).pct : key === 'avgM' ? (x.m ? x.m.pct : 101) : x.i.pct);
    list.sort(/^avg/.test(key) ? (a, b) => pctOf(b) - pctOf(a) || a.p.slot - b.p.slot : (a, b) => a.p.slot - b.p.slot);
    $('#mSlot').textContent = (all ? '통합 · ' : state.dash === 'mfg' ? '제조 · ' : state.dash === 'qa' ? '품질 · ' : '') + def[1];
    $('#mTitle').textContent = grp ? `${grp} · 통합 진척률 ${list.length ? Math.round(list.reduce((a, x) => a + comboInfo(x.p).pct, 0) / list.length) : 0}% · ${list.length}건` : `${def[0]} · ${list.length}건`;
    if (grp) $('#mSlot').textContent = '통합 · 프로젝트 그룹 · 통합 진척률 높은 순';
    const fixTxt = i => i.fixing.map(s => `${s.stepNo}. ${s.stepName}${String(s.issue || '').trim() ? ' — ' + String(s.issue).trim() : ''}`).join('\n');
    const curOf = (i) => i.cur ? i.curGroup.map(s => `<span class="cs1"><span class="t">${s.stepNo}. ${esc(s.stepName)}</span>${pill(s.status)}</span>`).join('') : `<span class="t">전 공정 완료</span>${pill('완료')}`;
    const prog = (i, lb) => `<span class="stl-p">${lb ? `<em class="stl-k">${lb}</em>` : ''}<span class="bar"><i style="width:${i.pct}%"></i></span>${i.done}/${i.total} · ${i.pct}%</span>`;
    $('#mBody').innerHTML = list.length ? `<div class="stl">${list.map(({ p, i, m }) => {
      const lt = all && m && liveTrack(p) === 'mfg';
      const cur = all ? (lt ? `<span class="stl-tr"><em class="stl-k">제조</em>${curOf(m)}</span>` : `<span class="stl-tr"><em class="stl-k">품질</em>${curOf(i)}</span>`) : curOf(i);
      const issAll = () => [m && m.hasIssue ? '[제조] ' + (m.issueTip || fixTxt(m)) : '', i.hasIssue ? '[품질] ' + (i.issueTip || fixTxt(i)) : ''].filter(Boolean).join('\n');
      const extra = key === 'fixing' ? fixTxt(i) : (key === 'issue' ? (all ? issAll() : (i.issueTip || fixTxt(i))) : (all ? '' : (i.prog || '')));
      const lbl = key === 'fixing' ? '조치중' : key === 'issue' ? '이슈' : '진행';
      return `<button type="button" class="stl-r" data-open="${esc(p.id)}">
        <span class="stl-s">${esc(slotName(p.slot))}</span>
        <span class="stl-m"><b>${esc(p.projectName)}</b><span class="stl-c">${cur}</span>
          ${key === 'avgA' ? prog(comboInfo(p), '통합') : ''}${all ? (lt ? prog(m, '제조') : prog(i, '품질')) : prog(i)}
          ${extra ? `<span class="stl-x ${key === 'fixing' || key === 'issue' ? 'warn' : ''}"><em>${lbl}</em>${mdView(lineBreaks(extra))}</span>` : ''}</span>
        <span class="stl-go">›</span></button>`;
    }).join('')}</div>` : '<div class="empty-msg">해당하는 프로젝트가 없습니다.</div>';
    openModal(false);
  }
  // ===== 화면 복사: 공정 목록 + 배치도 -> PNG -> clipboard (fallback: download) =====
  const H2I_URL = 'https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/dist/html-to-image.js';
  function loadH2I() {
    if (window.htmlToImage) return Promise.resolve();
    return loadH2I._p || (loadH2I._p = new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = H2I_URL; sc.onload = res; sc.onerror = () => { loadH2I._p = null; rej(new Error('캡처 기능을 불러오지 못했습니다')); }; document.head.appendChild(sc); }));
  }
  // Pretendard is split into ~90 unicode-range files: embed only the ones the browser already loaded
  async function pageFontCSS() {
    const link = [...document.styleSheets].find(s => s.href && /pretendard/i.test(s.href)); if (!link) return '';
    const key = (ur) => String(ur || '').split(',')[0].trim().replace(/^U\+/i, '').split('-')[0].toLowerCase().replace(/^0+/, '');
    const loaded = new Set([...document.fonts].filter(f => f.status === 'loaded' && /pretendard/i.test(f.family)).map(f => key(f.unicodeRange)));
    const css = await fetch(link.href).then(r => r.text());
    const b64 = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
    const out = await Promise.all((css.match(/@font-face\s*{[^}]*}/g) || []).map(async b => {
      const ur = (b.match(/unicode-range:\s*([^;}]+)/) || [])[1]; if (!ur || !loaded.has(key(ur))) return '';
      const m = b.match(/url\(([^)]+)\)/); if (!m) return '';
      const buf = await fetch(new URL(m[1].replace(/["']/g, ''), link.href).href).then(r => r.arrayBuffer());
      return b.replace(/src:[^;}]+/, `src:url(data:font/woff2;base64,${b64(buf)}) format('woff2')`);
    }));
    return out.filter(Boolean).join('\n');
  }
  async function boardBlob() {
    await loadH2I();
    const bg = getComputedStyle(document.body).backgroundColor || '#fff';
    const opt = { pixelRatio: 2, backgroundColor: bg, filter: n => !(n.classList && n.classList.contains('cap-skip')) };
    if (!loadH2I._font) { try { loadH2I._font = await pageFontCSS(); } catch (_) { loadH2I._font = ''; } }
    opt.fontEmbedCSS = loadH2I._font;
    const plan = $('#plan'), side = $('#procSide');
    const pc = await htmlToImage.toCanvas(plan, opt);
    let sc = null;
    // the list is absolutely positioned left of the plan: render its clone in normal flow
    if (side && !side.hidden) sc = await htmlToImage.toCanvas(side, Object.assign({}, opt, { width: side.offsetWidth, height: side.scrollHeight, style: { position: 'static', top: '0', right: 'auto', left: 'auto', margin: '0', transition: 'none', overflow: 'visible', maxHeight: 'none' } }));
    const k = 2, pad = 16 * k, gap = 14 * k, headH = 34 * k;
    const W = pad * 2 + (sc ? sc.width + gap : 0) + pc.width, Hh = pad * 2 + headH + Math.max(pc.height, sc ? sc.height : 0);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = Hh;
    const c = cv.getContext('2d'); c.fillStyle = bg; c.fillRect(0, 0, W, Hh);
    const txt = getComputedStyle(document.body).color || '#111';
    c.fillStyle = txt; c.font = `700 ${16 * k}px Pretendard, 'Malgun Gothic', sans-serif`; c.textBaseline = 'middle';
    const label = { all: '통합', mfg: '제조', qa: '품질' }[state.dash] || '';
    c.fillText(`${WSS[WS]} · ${label} 대시보드`, pad, pad + headH / 2 - 4 * k);
    c.font = `500 ${12 * k}px Pretendard, 'Malgun Gothic', sans-serif`; c.globalAlpha = 0.6; c.textAlign = 'right';
    c.fillText(nowStr(), W - pad, pad + headH / 2 - 4 * k); c.globalAlpha = 1; c.textAlign = 'left';
    let x = pad; const y = pad + headH;
    if (sc) { c.drawImage(sc, x, y); x += sc.width + gap; }
    c.drawImage(pc, x, y);
    return new Promise((res, rej) => cv.toBlob(b => (b ? res(b) : rej(new Error('이미지 생성 실패'))), 'image/png'));
  }
  $('#legend').addEventListener('click', e => {
    const btn = e.target.closest('#capBtn'); if (!btn || btn.disabled) return;
    btn.disabled = true; toast('화면을 이미지로 만드는 중…');
    const blobP = boardBlob();
    const done = () => { btn.disabled = false; };
    const download = (b) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `${DEV ? '개발' : '트랙'}_${({ all: '통합', mfg: '제조', qa: '품질' })[state.dash]}_${nowStr().replace(/[-: ]/g, '').slice(2, 12)}.png`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); };
    // the clipboard write starts inside the click (blob promise) so the browser keeps the user gesture
    let p;
    try { p = (navigator.clipboard && window.ClipboardItem) ? navigator.clipboard.write([new ClipboardItem({ 'image/png': blobP })]) : Promise.reject(new Error('no clipboard')); } catch (err) { p = Promise.reject(err); }
    p.then(() => toast('화면이 클립보드에 복사되었습니다 (Ctrl+V로 붙여넣기)'))
      .catch(() => blobP.then(b => { download(b); toast('클립보드 복사가 막혀 PNG 파일로 저장했습니다'); }).catch(err => toast('화면 복사 실패: ' + err.message, true)))
      .finally(done);
  });
  $('#stats').addEventListener('click', e => { const b = e.target.closest('[data-stat]'); if (b) openStatList(b.dataset.stat); });

  function openModal(narrow) {
    $('.sheet').classList.toggle('narrow', !!narrow);
    $('#mSave').hidden = true; // only the project detail shows the top save button
    $('#overlay').hidden = false; document.body.style.overflow = 'hidden';
  }
  function closeModal() { $('#overlay').hidden = true; document.body.style.overflow = ''; state.openProjectId = null; state.openStep = null; }

  // p: project for which options are built (null = new project)
  function slotOptions(cur, p, short, noPack) {
    const map = bySlot();
    const okPack = p ? projectInfo(p).packOk : false;
    return `<option value="">미배치</option>` + slotItems().filter(it => !noPack || it.type !== 'pack' || Number(cur) === Number(it.slot)).map(it => {
      const n = Number(it.slot); const o = map[n]; const other = o && (!p || o.id !== p.id);
      const pack = it.type === 'pack';
      const dis = pack && !okPack && Number(cur) !== n;
      const extra = dis ? ` (${PACK_MIN_STEP}번 공정 이상)` : other ? (short ? ' · 사용중' : ' · ' + esc(o.projectName)) : '';
      const ty = slotTypes(n);
      return `<option value="${n}" ${Number(cur) === n ? 'selected' : ''} ${dis ? 'disabled' : ''}>${esc(slotName(n))}${ty.length ? ' [' + esc(ty.join('/')) + ']' : ''}${extra}</option>`;
    }).join('');
  }

  // FAT measurement steps (stepDefs.measure): X1/X2 values per step, same inputs in the summary box and the step panel
  const measDefs = () => ((state.data && state.data.stepDefs) || []).filter(d => d.measure);
  const isMeasureQ = (no) => measDefs().some(d => d.no === Number(no));
  const isMeasure = isMeasureQ;
  const measInputs = (no, s) => ['x1', 'x2'].map(k => `<label class="mx"><span>${k.toUpperCase()}</span><input type="text" inputmode="decimal" data-mx="${no}" data-k="${k}" value="${esc(s[k] || '')}" placeholder="값"></label>`).join('');
  // changed measurement values in the open project window -> [{stepNo, x1, x2}]
  function measChanges(p, onlyNo) {
    return measDefs().filter(d => !onlyNo || d.no === onlyNo).map(d => {
      const s = (p.steps || []).find(x => Number(x.stepNo) === d.no) || {};
      const get = k => { const el = $(`#mBody [data-mx="${d.no}"][data-k="${k}"]`); return el ? el.value.trim() : String(s[k] || ''); };
      return { stepNo: d.no, x1: get('x1'), x2: get('x2'), old: [String(s.x1 || ''), String(s.x2 || '')] };
    }).filter(m => m.x1 !== m.old[0] || m.x2 !== m.old[1]).map(m => ({ stepNo: m.stepNo, x1: m.x1, x2: m.x2 }));
  }
  function saveMeas(pid, items, msg) {
    return mutate({ action: 'saveMeasure', projectId: pid, items }, msg, (d, user) => {
      const p = byId(d, pid); if (!p) return;
      items.forEach(it => { const s = p.steps.find(x => Number(x.stepNo) === it.stepNo); if (s) Object.assign(s, { x1: it.x1, x2: it.x2 }); });
      p.updatedAt = nowStr();
    });
  }
  // nonconformance history of one project (compact = per 불량(소분류) chips, detail list on demand)
  const NX = { pid: null, open: false, defect: '' };
  function ncrBoxHTML(p) {
    if (NX.pid !== p.id) { NX.pid = p.id; NX.open = false; NX.defect = ''; }
    const key = ncNorm(p.projectName);
    const rows = ncrRows().filter(r => ncNorm(r.project) === key).sort((a, b) => (Number(b.no) || 0) - (Number(a.no) || 0));
    const open = rows.filter(r => !r.done).length;
    const g = {}; rows.forEach(r => { const k = String(r.defect || '').trim() || '(미분류)'; (g[k] = g[k] || { n: 0, o: 0 }).n++; if (!r.done) g[k].o++; });
    const keys = Object.keys(g).sort((a, b) => g[b].n - g[a].n || a.localeCompare(b, 'ko'));
    if (NX.defect && !g[NX.defect]) NX.defect = '';
    const synced = state.data.ncrSyncedAt ? ` · 동기화 ${esc(state.data.ncrSyncedAt)}` : '';
    if (!rows.length) return `<div class="ncrbox"><div class="mh"><b>부적합 이력</b><span class="hint">등록된 부적합 없음${synced || ' · 부적합 처리현황 탭에서 동기화'}</span></div></div>`;
    const list = rows.filter(r => !NX.defect || (String(r.defect || '').trim() || '(미분류)') === NX.defect);
    const detail = NX.open ? `<div class="nb-list"><div class="nb-lh"><span>${NX.defect ? `<b>${esc(NX.defect)}</b> ${list.length}건` : `전체 ${list.length}건`}</span><button class="btn ghost" data-nx="tab">부적합 탭에서 보기</button></div>
      <div class="nb-tw"><table><thead><tr><th>처리</th><th>NO</th><th>조치사항</th><th>발생일</th><th>품명 또는 위치</th><th>불량 (소분류)</th><th>불량내용</th><th>비고 / 세부 조치내용</th><th>귀책업체</th></tr></thead><tbody>${list.map(r => `<tr class="${r.done ? 'done' : ''}"><td>${r.done ? '<span class="nb-ok">처리완료</span>' : '<span class="nb-open">미처리</span>'}</td><td class="nc-no">${esc(r.no)}</td><td>${r.action ? `<span class="nc-act a-${esc(r.action)}">${esc(r.action)}</span>` : ''}</td><td>${esc(r.date)}</td><td>${esc(r.item)}</td><td>${esc(r.defect)}</td><td class="tx">${esc(r.content)}</td><td class="tx">${esc(r.note)}</td><td>${esc(r.vendor)}</td></tr>`).join('')}</tbody></table></div></div>` : '';
    return `<div class="ncrbox"><div class="mh"><b>부적합 이력</b><span class="nb-sum">총 <b>${rows.length}</b>건 · 미처리 <b class="${open ? 'o' : ''}">${open}</b>건</span><span class="hint">${synced.replace(/^ · /, '')}</span><button class="btn" data-nx="toggle">${NX.open ? '세부 조회 닫기 ▴' : '세부 조회 ▾'}</button></div>
      <div class="nb-chips">${keys.length > 1 ? `<button class="nb-chip ${!NX.defect ? 'on' : ''}" data-nxd="">전체 <b>${rows.length}</b></button>` : ''}${keys.map(k => `<button class="nb-chip ${NX.defect === k ? 'on' : ''}" data-nxd="${esc(k)}" title="${esc(k)} ${g[k].n}건 (미처리 ${g[k].o})">${esc(k)} <b>${g[k].n}</b>${g[k].o ? `<em>미처리 ${g[k].o}</em>` : ''}</button>`).join('')}</div>${detail}</div>`;
  }
  function refreshNcrBox() { const p = findProject(state.openProjectId); const box = $('#mBody .ncrbox'); if (p && box) box.outerHTML = ncrBoxHTML(p); }
  // per-step confirmation checkboxes (stepDefs[].checks) — value stored as comma-joined keys
  const stepChecksQ = (no) => (((state.data && state.data.stepDefs) || [])[Number(no) - 1] || {}).checks || [];
  const ckSet = (s) => new Set(String((s && s.checks) || '').split(',').map(x => x.trim()).filter(Boolean));
  const ckVal = (el) => { const r = el.querySelector('[data-checks]'); return r ? [...r.querySelectorAll('input:checked')].map(x => x.value).join(',') : undefined; };
  // step panels (품질 + 제조 share the markup; 제조 has no file/measure/check fields)
  function stepsHTML(steps, i, mfg) {
    return (steps || []).map(s => {
      const no = Number(s.stepNo);
      const isFile = !mfg && (s.fileRequired === true || String(s.fileRequired).toUpperCase() === 'TRUE');
      const isMeasure = (n) => !mfg && isMeasureQ(n);
      const stepChecks = (n) => (mfg ? [] : stepChecksQ(n));
      const open = state.openStep === no;
      const sub = String(s.issue || '').trim() && s.status !== '완료'
        ? `<small class="issue">이슈: ${mdView(s.issue)}</small>`
        : (String(s.progress || '').trim() ? `<small>${mdView(s.progress)}</small>` : '');
      return `<div class="st ${open ? 'open' : ''} ${i.curGroup.some(s => Number(s.stepNo) === no) ? 'cur-step' : ''}" data-step="${no}">
        <button class="st-h" data-toggle="${no}">
          <span class="st-n">${no}</span>
          <span class="st-name">${esc(s.stepName)}${sub}</span>
          ${isFile ? '<span class="fbadge">파일확인</span>' : ''}
          ${stepChecks(no).length ? `<span class="ckbadge ${stepChecks(no).every(k => ckSet(s).has(k)) ? 'ok' : ''}">${stepChecks(no).map(k => `${esc(k.replace(/시트$/, ''))}${ckSet(s).has(k) ? '✓' : '·'}`).join(' ')}</span>` : ''}
          ${pill(s.status)}
          <svg class="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        <div class="st-b">
          <div class="seg-ctl">${state.data.statuses.map(x => `<button type="button" class="s-${x} ${x === s.status ? 'on' : ''}" data-v="${x}">${x}</button>`).join('')}</div>
          <div class="grid3 dates">
            <label class="f">시작일<input type="date" name="startDate" value="${esc(s.startDate)}"></label>
            <label class="f">완료일<input type="date" name="endDate" value="${esc(s.endDate)}"></label>
            <label class="f">담당자<input type="text" name="owner" value="${esc(s.owner)}" placeholder="이름" list="userList" autocomplete="off"></label>
          </div>
          ${isMeasure(no) ? `<div class="meas-row"><span class="hint">측정값</span>${measInputs(no, s)}</div>` : ''}
          ${stepChecks(no).length ? `<div class="chk-row" data-checks="1"><span class="hint">확인</span>${stepChecks(no).map(k => `<label class="chk"><input type="checkbox" value="${esc(k)}" ${ckSet(s).has(k) ? 'checked' : ''}> ${esc(k)} 확인</label>`).join('')}</div>` : ''}
          <div class="f"><span>세부 진행사항 <span class="rt-hint">Ctrl+B 굵게</span></span><div class="in rta r3" contenteditable="true" role="textbox" aria-multiline="true" aria-label="세부 진행사항" name="progress" data-ph="진행 내용을 입력하세요">${md2html(s.progress)}</div></div>
          <div class="f"><span>이슈사항 <span class="rt-hint">Ctrl+B 굵게</span></span><div class="in rta r2" contenteditable="true" role="textbox" aria-multiline="true" aria-label="이슈사항" name="issue" data-ph="이슈가 있으면 입력하세요">${md2html(s.issue)}</div></div>
          ${isFile ? `<div class="filecheck"><span>NAS 폴더 파일 업로드 확인 <b>자동화 예정</b></span><span class="meta">${s.fileCheckedAt ? '확인 ' + esc(s.fileCheckedAt) + ' · ' + esc(s.fileCount) + '개' : '미연동'}</span></div>` : ''}
          <div class="row-end between">
            <span class="meta">${s.updatedAt ? '수정 ' + esc(s.updatedAt) + (s.updatedBy ? ' · ' + esc(s.updatedBy) : '') : ''}</span>
            <button class="btn primary" data-save="${no}">저장</button>
          </div>
        </div>
      </div>`;
    }).join('');
  }
  function renderProject(p, keepScroll) {
    const body = $('#mBody');
    const scroll = keepScroll ? body.scrollTop : 0;
    const i = projectInfo(p);
    const active = p.state === 'active';
    state.openProjectId = p.id; state.openTrack = 'qa';
    if (state.openStep == null && i.cur) state.openStep = Number(i.cur.stepNo);
    $('#mSlot').textContent = `${active ? (p.slot ? slotName(p.slot) + ' 배치' : '미배치') : '출하완료'} · ${i.done}/${i.total} 완료`;
    $('#mTitle').textContent = p.projectName;
    const steps = stepsHTML(p.steps, i, false);

    body.innerHTML = `
      <div class="box">
        <div class="grid3 sumgrid">
          <label class="f">배치${active ? `<select class="in" id="mSlotSel">${slotOptions(p.slot, p)}</select>` : `<input type="text" value="출하완료" disabled>`}</label>
          <label class="f"><span>진행사항 요약 <span class="autotag ${i.manualProg ? 'man' : ''}">${i.manualProg ? '직접 작성' : '자동 초안'}</span></span><div class="in rta r3" contenteditable="true" role="textbox" aria-multiline="true" aria-label="진행사항 요약" id="sumProg" data-auto="${esc(i.autoProg)}" data-ph="진행 요약">${md2html(i.prog)}</div></label>
          <label class="f"><span>이슈사항 요약 <span class="autotag ${i.manualIssue ? 'man' : ''}">${i.manualIssue ? '직접 작성' : '자동 초안'}</span></span><div class="in rta r3" contenteditable="true" role="textbox" aria-multiline="true" aria-label="이슈사항 요약" id="sumIssue" data-ph="이슈 없음" data-auto="${esc(i.autoIssue)}">${md2html(i.issue)}</div></label>
        </div>
        ${measDefs().length ? `<div class="measbox">
          <div class="mh"><b>FAT 측정값</b><span class="hint">X1 · X2 직접 입력 가능 — 입력값은 각 공정의 측정값으로 함께 기록됩니다</span><button class="btn" id="saveMeas">측정값 저장</button></div>
          <div class="mgrid">${measDefs().map(dd => { const s = (p.steps || []).find(x => Number(x.stepNo) === dd.no) || {}; return `<div class="mi"><div class="mt"><span class="mn">${dd.no}</span>${esc(String(dd.name).replace(/^FAT 측정/, '').replace(/^\((.*)\)$/, '$1') || dd.name)}</div>${measInputs(dd.no, s)}</div>`; }).join('')}</div>
        </div>` : ''}
        ${ncrBoxHTML(p)}
        <div class="row-end between" style="flex-wrap:wrap">
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><span class="hint">시작 공정</span><select class="in" id="skipSel" style="width:auto;padding:6px 8px">${startOptions(Math.min(i.curNo, (p.steps || []).length))}</select><button class="btn" id="skipBtn" title="선택한 공정 이전의 미완료 공정을 완료 처리">이 공정부터 진행</button></div>
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

  // 제조 project window: shared placement (equipment slots only) + 제조 step panels
  function renderMfgProject(p, keepScroll) {
    const body = $('#mBody');
    const scroll = keepScroll ? body.scrollTop : 0;
    const v = vpM(p); const i = projectInfo(v);
    const active = p.state === 'active';
    state.openProjectId = p.id; state.openTrack = 'mfg';
    if (state.openStep == null && i.cur) state.openStep = Number(i.cur.stepNo);
    $('#mSlot').textContent = `제조 · ${active ? (p.slot ? slotName(p.slot) + ' 배치' : '미배치') : '출하완료'} · ${i.done}/${i.total} 완료`;
    $('#mTitle').textContent = p.projectName;
    body.innerHTML = `
      <div class="box">
        <div class="grid2 sumgrid">
          <label class="f">배치${active ? `<select class="in" id="mSlotSel">${slotOptions(p.slot, p, false, true)}</select>` : `<input type="text" value="출하완료" disabled>`}</label>
          <div class="f"><span>제조 진척률</span><div class="mfg-pg"><span class="bar"><i style="width:${i.pct}%"></i></span><b>${i.done}/${i.total} · ${i.pct}%</b></div></div>
        </div>
        ${active ? `<div class="row-end" style="justify-content:flex-start;flex-wrap:wrap;gap:6px;margin-top:10px"><span class="hint">시작 공정</span><select class="in" id="mSkipSel" style="width:auto;padding:6px 8px">${startOptions(i.curNo, true)}</select><button class="btn" id="mSkipBtn" title="선택한 공정 이전의 미완료 제조 공정을 완료 처리">이 공정부터 진행</button></div>` : ''}
        <div class="hint" style="margin-top:6px">배치는 품질 대시보드와 공유됩니다 (패킹 칸은 품질에서만 배치).</div>
      </div>
      ${ncrBoxHTML(p)}
      <div class="section-t">제조 공정 <span class="hint">공정을 눌러 상세 입력</span></div>
      <div class="steps">${stepsHTML(v.steps, i, true)}</div>`;
    if (!keepScroll) openModal(false);
    $('#mSave').hidden = !active;
    body.scrollTop = scroll;
  }
  // 통합 project window: 제조 + 품질 steps, read-only
  function renderAllProject(p, keepScroll) {
    const body = $('#mBody');
    const scroll = keepScroll ? body.scrollTop : 0;
    state.openProjectId = p.id; state.openTrack = 'all';
    const m = projectInfo(vpM(p)), q = projectInfo(p);
    $('#mSlot').textContent = `통합 (조회 전용) · ${p.slot ? slotName(p.slot) + ' 배치' : '미배치'}`;
    $('#mTitle').textContent = p.projectName;
    const col = (lbl, track, steps, i) => `<div class="ro-col"><div class="mh"><b>${lbl}</b><span class="ro-pg"><span class="bar"><i style="width:${i.pct}%"></i></span>${i.done}/${i.total} · ${i.pct}%</span><button class="btn" data-goto="${track}">${lbl}에서 수정</button></div>
      <ol class="ro-steps">${(steps || []).map(s => { const cur = i.curGroup.some(x => Number(x.stepNo) === Number(s.stepNo)); const iss = String(s.issue || '').trim() && s.status !== '완료' ? s.issue : ''; const pr = String(s.progress || '').trim();
        return `<li class="${cur ? 'cur' : ''}"><span class="st-n">${s.stepNo}</span><span class="nm">${esc(s.stepName)}${iss ? `<small class="issue">이슈: ${mdView(iss)}</small>` : pr ? `<small>${mdView(pr)}</small>` : ''}</span>${pill(s.status)}</li>`; }).join('')}</ol></div>`;
    body.innerHTML = `<div class="ro-grid">${(p.mfg || []).length ? col('제조', 'mfg', p.mfg, m) : ''}${col('품질', 'qa', p.steps, q)}</div>${ncrBoxHTML(p)}`;
    if (!keepScroll) openModal(false);
    $('#mSave').hidden = true;
    body.scrollTop = scroll;
  }
  // open a project in the window that matches the current dashboard
  function openProj(p, keepScroll) {
    if (!p) return;
    const t = keepScroll ? state.openTrack : (state.tab === 'board' ? state.dash : 'qa');
    if (t === 'mfg') renderMfgProject(p, keepScroll); else if (t === 'all') renderAllProject(p, keepScroll); else renderProject(p, keepScroll);
  }

  async function loadNames(refresh) {
    const n = (await apiGet({ action: 'projectNames', refresh: refresh ? '1' : '0' })).names;
    state.names = n; LS.set(wsKey('track.names'), JSON.stringify(n));
    return n;
  }

  // mode: { slot } for register, { edit: project } for rename
  function openPicker(mode) {
    const editP = mode.edit || null;
    state.openProjectId = null;
    $('#mSlot').textContent = editP ? `현재: ${editP.projectName}` : `참조 시트(${DEV ? '개발' : 'TRACK'})에서 선택`;
    $('#mTitle').textContent = editP ? '프로젝트명 수정' : '프로젝트 등록';
    $('#mBody').innerHTML = `
      <label class="f">프로젝트명 검색<input type="search" id="q" placeholder="프로젝트명 검색" autocomplete="off"></label>
      <div class="search-list" id="list"><div class="none">프로젝트 목록 불러오는 중…</div></div>
      ${editP ? '' : `<div class="grid2" style="margin-top:12px">
        <label class="f">시작 공정<select class="in" id="regStart">${startOptions(1)}</select></label>
        <label class="f">배치 (선택)<select class="in" id="regSlot">${slotOptions(mode.slot || '', fakeProj(1))}</select></label>
      </div>
      <div class="hint" style="margin-top:6px">시작 공정 이전 공정은 '완료'로 등록됩니다.${DEV ? '' : ` 패킹 칸은 ${PACK_MIN_STEP}번 공정 이상일 때 배치할 수 있습니다.`}</div>`}
      <div class="row-end between">
        <button class="btn ghost" id="reloadNames">목록 새로고침</button>
        <span class="row-end" style="gap:10px;margin:0"><span class="hint" id="regHint"></span><button class="btn primary" id="regBtn" disabled>${editP ? '변경' : '등록'}</button></span>
      </div>`;
    openModal(true);
    let selected = null;
    const draw = () => {
      const q = $('#q').value.trim().toLowerCase();
      const used = new Set(activeProjects().filter(p => !editP || p.id !== editP.id).map(p => p.projectName));
      const list = (state.names || []).filter(n => !q || n.toLowerCase().includes(q));
      // a single free search hit is selected automatically; a selection hidden by the search is dropped
      if (q && list.length === 1 && !used.has(list[0])) selected = list[0];
      else if (selected && !list.includes(selected)) selected = null;
      $('#list').innerHTML = list.length
        ? list.map(n => `<button type="button" data-n="${esc(n)}" class="${n === selected ? 'sel' : ''}" ${used.has(n) ? 'disabled' : ''}><span>${esc(n)}</span>${used.has(n) ? '<small>등록됨</small>' : (editP && n === editP.projectName ? '<small>현재</small>' : '')}</button>`).join('')
        : `<div class="none">${state.names ? '검색 결과가 없습니다' : '불러오는 중…'}</div>`;
      $('#regBtn').disabled = !selected || (editP && selected === editP.projectName);
      $('#regHint').textContent = selected ? '선택: ' + selected : '목록에서 프로젝트를 선택하세요';
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
          id: tmp, slot: slot && start < d.stepDefs.length ? Number(slot) : null, projectName: name, state: start >= d.stepDefs.length ? 'shipped' : 'active', summaryProgress: '', summaryIssue: '',
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
          '현재 공정': i.cur ? i.curGroup.map(s => `${s.stepNo}. ${s.stepName}`).join(' + ') : '전 공정 완료', '현재 공정 상태': i.curStatus,
          '완료 공정': `${i.done}/${i.total}`, '진척률(%)': i.pct, '진행 요약': stripMd(i.prog), '이슈 요약': stripMd(i.issue),
          '등록일': p.createdAt, '등록자': p.createdBy, '최종 수정': p.updatedAt, '수정자': p.updatedBy,
        }; });
        const sheet2 = [];
        ps.forEach(p => (p.steps || []).forEach(s => sheet2.push({
          '프로젝트명': p.projectName, '배치': p.slot ? slotName(p.slot) : '', '공정 번호': s.stepNo, '공정명': s.stepName, '상태': s.status,
          '시작일': s.startDate, '완료일': s.endDate, '담당자': s.owner, '세부 진행사항': stripMd(s.progress), '이슈사항': stripMd(s.issue),
          '파일확인 대상': (s.fileRequired === true || String(s.fileRequired).toUpperCase() === 'TRUE') ? 'O' : '',
          '최종 수정': s.updatedAt, '수정자': s.updatedBy,
        })));
        const sheet3 = (hist.rows || []).filter(r => !r.projectId || ids.has(r.projectId) || pid === r.projectId).map(r => ({
          '일시': r.at, '작성자': r.by, '구분': r.actionLabel || r.action, '프로젝트명': r.projectName, '배치': r.slot ? slotName(r.slot) : '',
          '공정 번호': r.stepNo, '공정명': r.stepName, '상태': r.status, '시작일': r.startDate, '완료일': r.endDate,
          '담당자': r.owner, '세부 진행사항': stripMd(r.progress), '이슈사항': stripMd(r.issue), '비고': r.detail,
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
    name: r => r.name, g: r => r.g, type: r => r.type || null, cat: r => r.cat || null,
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
    if (!DEV && SY.group && r.g !== SY.group) return false;
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
      if (DEV && state.data) { renderBoard(); fitPlan(); } // 개발 cards show TYPE from the reference sheet
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
      cur = `<button class="sy-link" data-open="${esc(p.id)}">${i.cur ? i.curGroup.map(s => `${pill(s.status)} ${s.stepNo}. ${esc(s.stepName)}`).join(' + ') : `${pill('완료')} 전 공정 완료`}</button>`;
    } else cur = '<span class="muted">관리 대상 아님</span>';
    return `<tr class="${k !== 'wait' ? 'done' : ''} ${on ? 'on' : ''}" data-name="${n}"><td class="ck"><input type="checkbox" data-ck="${n}" ${on ? 'checked' : ''} aria-label="선택"></td><td>${idx + 1}</td><td><span class="sy-st ${k}">${r.s.t}</span></td><td>${r.d ? r.d.replace(/-/g, '.') : (String(r.ship || '').trim() ? esc(r.ship) : '<span class="muted">미정</span>')}</td><td><b>${n}</b></td>${DEV ? `<td>${esc(r.type || '')}</td><td>${esc(r.cat || '')}</td>` : `<td>${esc(r.g)}</td><td>${esc(r.type)}</td>`}<td>${start}</td><td>${slot}</td><td>${cur}</td></tr>`;
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
    $('#syGroup').hidden = DEV;
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
    $('#syTable').innerHTML = `<table><thead><tr><th class="ck"><input type="checkbox" data-all="1" ${allOn ? 'checked' : ''} aria-label="전체 선택"></th>${syTh('', 'No.')}${syTh('st', '상태')}${syTh('ship', '출하일')}${syTh('name', '프로젝트명')}${DEV ? syTh('type', 'TYPE') + syTh('cat', '구분') : syTh('g', '프로젝트 그룹') + syTh('type', 'TYPE')}<th>시작 공정</th><th>배치</th>${syTh('cur', '사이트 현재 공정')}</tr></thead><tbody>${rows.map(syRow).join('') || '<tr><td colspan="10" class="sy-empty">조건에 맞는 프로젝트가 없습니다</td></tr>'}</tbody></table>`;
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
          id: 'T' + Date.now() + '_' + k, slot: it.startStep >= d.stepDefs.length ? null : slot, projectName: it.name, state: it.startStep >= d.stepDefs.length ? 'shipped' : 'active', summaryProgress: '', summaryIssue: '',
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

  // ===================== Nonconformance (부적합 처리현황) =====================
  const NC = { q: '', group: '', st: LS.get('track.ncrSt') || 'open', cf: {}, pop: null, busy: false };
  const NCOLS = [
    ['ship', '구분', 1], ['done', '처리완료', 1], ['no', 'NO', 0], ['action', '조치사항', 1], ['date', '발생일', 1], ['due', '재납일/조치일', 1],
    ['project', '발주 프로젝트명', 1], ['item', '품명 또는 위치', 1], ['partNo', '품번 (도번)', 0], ['qty', '수량', 0],
    ['vendor', '귀책업체', 1], ['defect', '불량 (소분류)', 1], ['finder', '발견자', 1], ['owner', '담당자', 1], ['content', '불량내용', 0], ['note', '비고 / 세부 조치내용', 0],
  ];
  const ncNorm = (v) => String(v || '').replace(/\s+/g, '').toUpperCase();
  function ncrRows() {
    const ship = {}; projects().forEach(p => { ship[ncNorm(p.projectName)] = p.state === 'shipped'; });
    return ((state.data && state.data.ncr) || []).map(r => Object.assign({}, r, { shipped: !!ship[ncNorm(r.project)], g: groupOf(r.project) }));
  }
  const ncVal = (r, f) => f === 'ship' ? (r.shipped ? '장비출하' : '진행중') : f === 'done' ? (r.done ? '처리완료' : '미처리') : (String(r[f] || '').trim() || '(빈 칸)');
  // rows passing search / group / status chip and every column filter except `skip`
  function ncPass(r, skip) {
    if (NC.st === 'open' && r.done) return false;
    if (NC.st === 'done' && !r.done) return false;
    if (NC.st === 'ship' && !r.shipped) return false;
    if (NC.group && r.g !== NC.group) return false;
    if (NC.q) { const q = NC.q.toLowerCase(); if (!['project', 'item', 'partNo', 'content', 'note', 'vendor', 'no'].some(f => String(r[f] || '').toLowerCase().includes(q))) return false; }
    for (const f in NC.cf) { if (f !== skip && NC.cf[f] && !NC.cf[f].has(ncVal(r, f))) return false; }
    return true;
  }
  function renderNcr() {
    const all = ncrRows();
    const open = all.filter(r => !r.done).length;
    $('#ncrCnt').textContent = open || '';
    if (state.tab !== 'ncr') return;
    const base = all.filter(r => { if (NC.group && r.g !== NC.group) return false; return true; });
    const cnt = { all: base.length, open: base.filter(r => !r.done).length, done: base.filter(r => r.done).length, ship: base.filter(r => r.shipped).length };
    $('#nFilter').innerHTML = [['all', '전체'], ['open', '미처리'], ['done', '처리완료'], ['ship', '장비출하']].map(([k, l]) => `<button class="chip ${NC.st === k ? 'on' : ''}" data-nf="${k}">${l}<b>${cnt[k]}</b></button>`).join('');
    const gc = {}; all.forEach(r => { gc[r.g] = (gc[r.g] || 0) + 1; });
    if (NC.group && !gc[NC.group]) NC.group = '';
    $('#nGroup').innerHTML = `<option value="">전체 프로젝트 그룹</option>` + Object.keys(gc).sort((a, b) => a.localeCompare(b)).map(g => `<option value="${esc(g)}" ${g === NC.group ? 'selected' : ''}>${esc(g)} (${gc[g]})</option>`).join('');
    $('#nGroup').classList.toggle('set', !!NC.group);
    const nf = Object.keys(NC.cf).filter(f => NC.cf[f]).length;
    $('#nReset').hidden = !(nf || NC.q || NC.group);
    $('#nMeta').textContent = state.data.ncrSyncedAt ? '최근 동기화 ' + state.data.ncrSyncedAt : '아직 동기화하지 않았습니다';
    const list = all.filter(r => ncPass(r)).sort((a, b) => (Number(b.no) || 0) - (Number(a.no) || 0));
    const th = NCOLS.map(([f, l, flt]) => `<th class="nh-${f} ${NC.cf[f] ? 'flt' : ''}">${flt ? `<button class="nc-th" data-ncf="${f}" title="${esc(l)} 필터">${esc(l)}<i>▾</i></button>` : esc(l)}</th>`).join('');
    const tr = (r) => `<tr class="nohover ${r.done ? 'done' : ''} ${r.shipped ? 'shipr' : ''}">
      <td class="nc-sh">${r.shipped ? '<span class="nc-ship">장비출하</span>' : ''}</td>
      <td class="nc-done"><label class="nc-ck"><input type="checkbox" data-ncdone="${esc(r.no)}" ${r.done ? 'checked' : ''} aria-label="처리완료"></label></td>
      <td class="nc-no">${esc(r.no)}</td><td>${r.action ? `<span class="nc-act a-${esc(r.action)}">${esc(r.action)}</span>` : ''}</td>
      <td>${esc(r.date)}</td><td>${esc(r.due)}</td><td class="nc-pj">${esc(r.project)}</td><td>${esc(r.item)}</td><td>${esc(r.partNo)}</td><td class="nc-q">${esc(r.qty)}</td>
      <td>${esc(r.vendor)}</td><td>${esc(r.defect)}</td><td>${esc(r.finder)}</td><td>${esc(r.owner)}</td>
      <td class="wrap nc-tx">${esc(r.content)}</td><td class="wrap nc-tx">${esc(r.note)}</td></tr>`;
    const emp = all.length ? '조건에 맞는 부적합 건이 없습니다' : '동기화된 부적합 건이 없습니다. 우측 상단 동기화를 눌러 주세요.';
    $('#nTable').innerHTML = `<table><thead><tr>${th}</tr></thead><tbody>${list.map(tr).join('') || `<tr class="nohover"><td colspan="${NCOLS.length}" class="sy-empty">${emp}</td></tr>`}</tbody></table>`;
  }
  function closeNcPop() { if (NC.pop) { NC.pop.remove(); NC.pop = null; } }
  function openNcPop(f, btn) {
    closeNcPop();
    const label = NCOLS.find(c => c[0] === f)[1];
    const cnt = {}; ncrRows().filter(r => ncPass(r, f)).forEach(r => { const v = ncVal(r, f); cnt[v] = (cnt[v] || 0) + 1; });
    if (NC.cf[f]) NC.cf[f].forEach(v => { if (!(v in cnt)) cnt[v] = 0; });
    const vals = Object.keys(cnt).sort((a, b) => (a === '(빈 칸)') - (b === '(빈 칸)') || a.localeCompare(b, 'ko', { numeric: true }));
    const sel = new Set(NC.cf[f] ? [...NC.cf[f]] : vals);
    const pop = document.createElement('div'); pop.className = 'nc-pop';
    pop.innerHTML = `<div class="np-h">${esc(label)}</div><input type="search" class="sy-in np-q" placeholder="값 검색"><label class="np-all"><input type="checkbox"> 모두 선택</label><div class="np-l"></div><div class="np-f"><button class="btn ghost np-clr">초기화</button><button class="btn primary np-ok">적용</button></div>`;
    document.body.appendChild(pop); NC.pop = pop;
    const r = btn.getBoundingClientRect();
    pop.style.top = (r.bottom + window.scrollY + 4) + 'px';
    pop.style.left = Math.max(8, Math.min(r.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - 268)) + 'px';
    const L = pop.querySelector('.np-l'), all = pop.querySelector('.np-all input'), q = pop.querySelector('.np-q');
    const draw = () => {
      const k = q.value.trim().toLowerCase(); const vis = vals.filter(v => !k || v.toLowerCase().includes(k));
      L.innerHTML = vis.map(v => `<label><input type="checkbox" value="${esc(v)}" ${sel.has(v) ? 'checked' : ''}><span>${esc(v)}</span><em>${cnt[v]}</em></label>`).join('') || '<div class="np-e">값 없음</div>';
      all.checked = vis.length > 0 && vis.every(v => sel.has(v));
    };
    draw();
    q.addEventListener('input', draw);
    L.addEventListener('change', e => { const v = e.target.value; if (e.target.checked) sel.add(v); else sel.delete(v); draw(); });
    all.addEventListener('change', () => { const k = q.value.trim().toLowerCase(); vals.filter(v => !k || v.toLowerCase().includes(k)).forEach(v => { if (all.checked) sel.add(v); else sel.delete(v); }); draw(); });
    pop.querySelector('.np-clr').addEventListener('click', () => { delete NC.cf[f]; closeNcPop(); renderNcr(); });
    pop.querySelector('.np-ok').addEventListener('click', () => { if (vals.every(v => sel.has(v))) delete NC.cf[f]; else NC.cf[f] = new Set(sel); closeNcPop(); renderNcr(); });
    q.focus();
  }
  document.addEventListener('mousedown', e => { if (NC.pop && !NC.pop.contains(e.target) && !e.target.closest('[data-ncf]')) closeNcPop(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && NC.pop) closeNcPop(); });
  $('#nTable').addEventListener('click', e => { const b = e.target.closest('[data-ncf]'); if (!b) return; if (NC.pop && NC.pop.dataset.f === b.dataset.ncf) { closeNcPop(); return; } openNcPop(b.dataset.ncf, b); NC.pop.dataset.f = b.dataset.ncf; });
  $('#nTable').addEventListener('change', e => {
    const c = e.target.closest('[data-ncdone]'); if (!c) return;
    const no = c.dataset.ncdone, on = c.checked;
    const ok = mutate({ action: 'setNcrDone', nos: [no], done: on }, on ? `NO ${no} 처리완료` : `NO ${no} 처리완료 해제`, d => { const r = (d.ncr || []).find(x => x.no === no); if (r) { r.done = on; r.updatedAt = nowStr(); } });
    if (!ok) c.checked = !on;
  });
  $('#nFilter').addEventListener('click', e => { const b = e.target.closest('[data-nf]'); if (!b) return; NC.st = b.dataset.nf; LS.set('track.ncrSt', NC.st); renderNcr(); });
  $('#nGroup').addEventListener('change', e => { NC.group = e.target.value; renderNcr(); });
  $('#nSearch').addEventListener('input', e => { NC.q = e.target.value.trim(); renderNcr(); });
  $('#nReset').addEventListener('click', () => { NC.cf = {}; NC.q = ''; NC.group = ''; $('#nSearch').value = ''; renderNcr(); });
  $('#nSync').addEventListener('click', async function ncSync() {
    if (NC.busy) return;
    if (needKey()) { if (await askKey()) ncSync(); return; }
    const btn = $('#nSync'); NC.busy = true; btn.disabled = true; btn.lastChild.textContent = '동기화 중…';
    const user = getUser();
    state.queue = state.queue.then(async () => {
      try {
        const j = await apiPost({ action: 'syncNcr', user });
        state.data = j; render(true);
        const r = j.ncrResult || {};
        toast(`부적합 동기화 완료 · 신규 ${r.added || 0}건${r.filled ? ` · 변경 반영 ${r.filled}건` : ''}`);
      } catch (e) { toast('동기화 실패: ' + e.message, true); }
      NC.busy = false; btn.disabled = false; btn.lastChild.textContent = '동기화';
    });
  });

  // ===================== Events =====================
  // workspace switch (full reload: every cache/state belongs to one workspace)
  function renderWs() {
    const el = $('#wsSw'); if (!el) return;
    el.innerHTML = Object.keys(WSS).map(k => `<button type="button" class="ws-b ${k === WS ? 'on' : ''}" data-ws="${k}">${esc(WSS[k])}</button>`).join('');
    document.title = WSS[WS];
    if (DEV) $$('.tab[data-tab="fat"],.tab[data-tab="etc"]').forEach(t => { t.hidden = true; });
  }
  renderWs();
  $('#wsSw') && $('#wsSw').addEventListener('click', e => {
    const b = e.target.closest('[data-ws]'); if (!b || b.dataset.ws === WS) return;
    if (state.pending) { toast('저장 중입니다. 잠시 후 다시 시도하세요', true); return; }
    LS.set('track.ws', b.dataset.ws);
    const u = new URL(location.href); if (b.dataset.ws === 'track') u.searchParams.delete('ws'); else u.searchParams.set('ws', b.dataset.ws);
    location.href = u.toString();
  });
  // 개발: 장비 위치 (Notes id 'loc:<slot>') — click the strip on a card
  function openLoc(n) {
    state.openProjectId = null;
    const cur = locOf(n);
    $('#mSlot').textContent = `${slotName(n)} · 장비 위치`;
    $('#mTitle').textContent = '장비 위치 입력';
    $('#mBody').innerHTML = `<label class="f"><span>장비 위치</span><input type="text" class="in" id="locIn" maxlength="40" placeholder="예) 2층 클린룸 A-3" value="${esc(cur)}"></label>
      <div class="row-end"><span class="hint" style="margin-right:auto">비우고 저장하면 지워집니다</span><button class="btn primary" id="locSave">저장</button></div>`;
    openModal(true);
    const inp = $('#locIn');
    const save = () => {
      const content = inp.value.trim(); const id = 'loc:' + n;
      closeModal();
      if (content === cur) return;
      mutate({ action: 'saveNote', id, content }, '장비 위치가 저장되었습니다', (d, user) => { d.notes = d.notes || {}; d.notes[id] = { content, style: '', updatedAt: nowStr(), updatedBy: user }; });
    };
    $('#locSave').addEventListener('click', save);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
    setTimeout(() => { inp.focus(); inp.select(); }, 60);
  }
  $('#plan').addEventListener('click', e => { const l = e.target.closest('[data-loc]'); if (!l) return; e.preventDefault(); e.stopImmediatePropagation(); openLoc(Number(l.dataset.loc)); }, true);
  $('#dashTabs').addEventListener('click', e => { const b = e.target.closest('[data-dash]'); if (!b || b.dataset.dash === state.dash) return; state.dash = b.dataset.dash; renderBoard(); fitPlan(); });
  $$('.tab').forEach(t => t.addEventListener('click', () => { if (!DEV && t.dataset.tab === 'board' && state.dash !== 'all') { state.dash = 'all'; if (state.data) renderBoard(); } state.tab = t.dataset.tab === 'pm' ? (PM_TABS.includes(LS.get('track.pmTab')) ? LS.get('track.pmTab') : 'projects') : t.dataset.tab; LS.set(wsKey('track.tab'), state.tab); renderTabs(); window.scrollTo(0, 0);
    if (state.tab === 'sync') { if (!SY.rows) loadSync(false); else renderSync(); }
    if (state.tab === 'ncr') renderNcr(); else closeNcPop();
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
    if (c.dataset.note) { if (!ALL()) openNote(c.dataset.note); return; }
    if (c.dataset.pid) { state.openStep = null; openProj(findProject(c.dataset.pid)); }
    else if (c.dataset.slot && !ALL()) openSlotPicker(Number(c.dataset.slot));
  };
  $('#plan').addEventListener('click', onCardClick);
  // drag a placed card onto a packing slot -> confirm -> move
  $('#plan').addEventListener('dragstart', e => {
    const c = e.target.closest && e.target.closest('.card[data-pid]'); if (!c || state.dash !== 'qa') return;
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
    if (t.id === 'bulkStep') { LS.set(!DEV && LS.get('track.bulkTrack') === 'mfg' ? 'track.bulkStepM' : 'track.bulkStep', t.value); return; }
    if (t.id === 'bulkTrack') { LS.set('track.bulkTrack', t.value); renderProjects(); return; }
    if (t.dataset.pall) { $$('#pTable [data-pck]').forEach(c => (t.checked ? state.psel.add(c.dataset.pck) : state.psel.delete(c.dataset.pck))); renderProjects(); return; }
    if (t.dataset.pck) { if (t.checked) state.psel.add(t.dataset.pck); else state.psel.delete(t.dataset.pck); renderProjects(); return; }
    const s = e.target.closest('select.slotsel'); if (!s) return;
    setSlot(findProject(s.dataset.pid), s.value);
  });

  function bulkApply() {
    const ids = [...state.psel]; if (!ids.length) return;
    const n = Number($('#bulkStep').value);
    if ($('#bulkTrack') && $('#bulkTrack').value === 'mfg') {
      const md = mfgDefs()[n - 1]; const all = n > mfgDefs().length;
      if (!confirm(`선택한 ${ids.length}건의 제조 공정을 '${all ? '제조 전 공정 완료' : n + '. ' + md.name}'(으)로 맞출까요?\n\n${all ? '제조 공정이 모두 완료 처리됩니다.' : n + '번 이전 제조 공정은 완료 처리되고, 기존 완료 기록은 유지됩니다.'}`)) return;
      mutate({ action: 'bulkSkipTo', projectIds: ids, stepNo: n, track: 'mfg' }, `${ids.length}건 제조 공정 적용되었습니다`, d => {
        ids.forEach(id => { const p = byId(d, id); if (p) { applySkipLocal(p, n, true); p.updatedAt = nowStr(); } });
        state.psel.clear();
      });
      return;
    }
    const def = (state.data.stepDefs || [])[n - 1] || {};
    const last = n >= (state.data.stepDefs || []).length;
    if (!confirm(`선택한 ${ids.length}건의 현재 공정을 '${n}. ${def.name}'(으)로 맞출까요?\n\n${last ? '출하완료: 전 공정이 완료 처리되고 출하완료 목록으로 이동합니다 (배치 해제).' : n + '번 이전 공정은 완료 처리되고, 기존 완료 기록은 유지됩니다.'}`)) return;
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
    const sc = state.openTrack === 'mfg' ? 'mfg' : '';
    if (needKey(sc)) { askKey(sc).then(ok => { if (ok) saveAll(); }); return; }
    const pid = state.openProjectId; const p = findProject(pid); if (!p) return;
    const mfg = state.openTrack === 'mfg';
    if (state.openTrack === 'all') return;
    const jobs = [];
    const keep = (el) => { const v = fieldVal(el).trim(); return v === String(el.dataset.auto || '').trim() ? '' : v; };
    const sp = mfg ? '' : keep($('#sumProg')), si = mfg ? '' : keep($('#sumIssue'));
    if (!mfg && (sp !== String(p.summaryProgress || '').trim() || si !== String(p.summaryIssue || '').trim())) {
      jobs.push(() => mutate({ action: 'saveSummary', projectId: pid, summaryProgress: sp, summaryIssue: si }, null, d => {
        const x = byId(d, pid); if (x) { x.summaryProgress = sp; x.summaryIssue = si; }
      }));
    }
    $$('#mBody .st[data-step]').forEach(el => {
      const no = Number(el.dataset.step); const s = ((mfg ? p.mfg : p.steps) || []).find(x => Number(x.stepNo) === no); if (!s) return;
      const v = n => fieldVal(el.querySelector(`[name=${n}]`));
      const on = el.querySelector('.seg-ctl button.on');
      const f = { status: on ? on.dataset.v : s.status, startDate: v('startDate'), endDate: v('endDate'), owner: v('owner'), progress: v('progress'), issue: v('issue') };
      const ck = mfg ? undefined : ckVal(el); if (ck !== undefined) f.checks = ck;
      if (!Object.keys(f).some(k => String(f[k] || '').trim() !== String(s[k] || '').trim())) return;
      if (!String(f.owner || '').trim()) f.owner = LS.get('track.user') || ''; // 담당자 비어 있으면 작성자
      jobs.push(() => mutate(Object.assign({ action: 'saveStep', projectId: pid, stepNo: no }, mfg ? { track: 'mfg' } : {}, f), null, (d, user) => {
        const x = byId(d, pid); if (!x) return;
        const st = (mfg ? x.mfg : x.steps).find(y => Number(y.stepNo) === no); if (!st) return; Object.assign(st, f, { updatedAt: nowStr(), updatedBy: user });
        x.updatedAt = nowStr();
      }));
    });
    const mi = mfg ? [] : measChanges(p); if (mi.length) jobs.push(() => saveMeas(pid, mi, null));
    if (!jobs.length) { toast('변경 사항이 없습니다'); return; }
    jobs.forEach(j => j());
    toast(`저장되었습니다 (${jobs.length}건)`);
  }

  // textareas grow with their text (CSS field-sizing where supported; JS fallback for older browsers)
  const FS_OK = window.CSS && CSS.supports && CSS.supports('field-sizing', 'content');
  const autoGrow = (ta) => { if (FS_OK || !ta || !ta.offsetParent) return; ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, Math.round(window.innerHeight * 0.6)) + 'px'; };
  $('#mBody').addEventListener('input', e => { if (e.target.tagName === 'TEXTAREA') autoGrow(e.target); });
  // rich fields: paste as plain text; Ctrl+B is the browser's own bold toggle in contenteditable
  $('#mBody').addEventListener('paste', e => { const t = e.target.closest && e.target.closest('.rta'); if (!t) return; e.preventDefault(); const txt = (e.clipboardData || window.clipboardData).getData('text/plain'); document.execCommand('insertText', false, txt); });
  $('#mBody').addEventListener('keydown', e => {
    const t = e.target.closest && e.target.closest('.rta'); if (!t) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B')) { e.preventDefault(); document.execCommand('bold'); }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'i' || e.key === 'I' || e.key === 'u' || e.key === 'U')) e.preventDefault(); // only bold is kept
  });
  $('#mBody').addEventListener('focusin', e => { if (e.target.tagName === 'TEXTAREA') autoGrow(e.target); });
  $('#mBody').addEventListener('click', e => {
    const so = e.target.closest('.stl-r[data-open]');
    if (so) { const p = findProject(so.dataset.open); if (p) { state.openStep = null; openProj(p, false); $('#mBody').scrollTop = 0; } return; }
    const go = e.target.closest('[data-goto]');
    if (go) { const p = findProject(state.openProjectId); state.dash = go.dataset.goto; state.tab = 'board'; renderTabs(); renderBoard(); fitPlan(); state.openStep = null; openProj(p, false); $('#mBody').scrollTop = 0; return; }
    const nx = e.target.closest('[data-nx],[data-nxd]');
    if (nx) {
      e.preventDefault();
      if (nx.dataset.nxd !== undefined) { NX.defect = nx.dataset.nxd; NX.open = true; refreshNcrBox(); return; }
      if (nx.dataset.nx === 'toggle') { NX.open = !NX.open; refreshNcrBox(); return; }
      if (nx.dataset.nx === 'tab') {
        const p = findProject(state.openProjectId); if (!p) return;
        NC.cf = { project: new Set([p.projectName]) }; if (NX.defect) NC.cf.defect = new Set([NX.defect]);
        NC.q = ''; NC.group = ''; NC.st = 'all'; $('#nSearch').value = '';
        closeModal(); state.tab = 'ncr'; LS.set(wsKey('track.tab'), 'ncr'); renderTabs(); renderNcr(); window.scrollTo(0, 0);
        return;
      }
    }
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
      const ow = el.querySelector('[name=owner]'); if (ow && !ow.value.trim() && segBtn.dataset.v !== '대기' && LS.get('track.user')) ow.value = LS.get('track.user');
      return;
    }
    const save = t.closest('[data-save]');
    if (save) {
      const no = Number(save.dataset.save); const el = save.closest('.st');
      const v = n => fieldVal(el.querySelector(`[name=${n}]`));
      const on = el.querySelector('.seg-ctl button.on');
      const f = { status: on ? on.dataset.v : '대기', startDate: v('startDate'), endDate: v('endDate'), owner: v('owner'), progress: v('progress'), issue: v('issue') };
      if (!String(f.owner || '').trim()) f.owner = getUser(); // 담당자 비어 있으면 작성자
      const mfg = state.openTrack === 'mfg';
      const ck = mfg ? undefined : ckVal(el); if (ck !== undefined) f.checks = ck;
      const pid = state.openProjectId;
      const mi = !mfg && isMeasure(no) ? measChanges(findProject(pid), no) : [];
      mutate(Object.assign({ action: 'saveStep', projectId: pid, stepNo: no }, mfg ? { track: 'mfg' } : {}, f), '저장되었습니다', (d, user) => {
        const p = byId(d, pid); if (!p) return;
        const s = (mfg ? p.mfg : p.steps).find(x => Number(x.stepNo) === no); if (!s) return; Object.assign(s, f, { updatedAt: nowStr(), updatedBy: user });
        p.updatedAt = nowStr();
      });
      if (mi.length) saveMeas(pid, mi, null);
      return;
    }
    const id = t.closest('button') && t.closest('button').id;
    const pid = state.openProjectId;
    if (id === 'saveMeas') { const mi = measChanges(findProject(pid)); if (!mi.length) toast('변경된 측정값이 없습니다'); else saveMeas(pid, mi, '측정값이 저장되었습니다'); return; }
    if (id === 'autoSum') {
      mutate({ action: 'saveSummary', projectId: pid, summaryProgress: '', summaryIssue: '' }, '자동 초안으로 바꿨습니다', d => {
        const p = byId(d, pid); if (p) { p.summaryProgress = ''; p.summaryIssue = ''; }
      });
    }
    if (id === 'saveSum') {
      // unchanged auto draft -> keep it automatic (store empty)
      const keep = (el) => { const v = fieldVal(el).trim(); return v === String(el.dataset.auto || '').trim() ? '' : v; };
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
    if (id === 'mSkipBtn') {
      const n = Number($('#mSkipSel').value);
      mutate({ action: 'skipTo', projectId: pid, stepNo: n, track: 'mfg' }, n > mfgDefs().length ? '제조 전 공정 완료 처리했습니다' : `제조 ${n}번 공정부터 진행합니다 (이전 공정 완료 처리)`, d => {
        const p = byId(d, pid); if (!p) return;
        applySkipLocal(p, n, true);
        state.openStep = n;
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
  // the same measurement shows in two places (summary box + step panel): keep them in sync while typing
  $('#mBody').addEventListener('input', e => {
    const t = e.target; if (!t.dataset || !t.dataset.mx) return;
    $$(`#mBody [data-mx="${t.dataset.mx}"][data-k="${t.dataset.k}"]`).forEach(x => { if (x !== t) x.value = t.value; });
  });
  $('#mBody').addEventListener('change', e => {
    if (e.target.id === 'mSlotSel') setSlot(findProject(state.openProjectId), e.target.value);
  });

  $('#refreshBtn').addEventListener('click', () => load(true));
  $('#userBtn').addEventListener('click', openUsers);
  // 사용자 선택: shared list (Users sheet) — pick = this PC's 작성자; add/remove = 품질 비밀번호
  function openUsers() {
    state.openProjectId = null;
    const cur = LS.get('track.user') || '';
    const list = (state.data && state.data.users) || [];
    $('#mSlot').textContent = '이 PC의 작성자 · 공정 담당자 자동 입력에 사용';
    $('#mTitle').textContent = '사용자 선택';
    $('#mBody').innerHTML = `
      <div class="ulist">${list.length ? list.map(n => `<div class="urow ${n === cur ? 'on' : ''}"><button type="button" class="upick" data-upick="${esc(n)}">${n === cur ? '✓ ' : ''}${esc(n)}</button><button type="button" class="ib del" data-udel="${esc(n)}" title="목록에서 삭제" aria-label="삭제"><svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/></svg></button></div>`).join('') : '<div class="hint">등록된 사용자가 없습니다. 아래에서 추가하세요.</div>'}</div>
      ${cur && !list.includes(cur) ? `<div class="hint" style="margin-top:8px">현재 작성자: <b>${esc(cur)}</b> (목록에 없음)</div>` : ''}
      <div class="uadd"><input class="in" id="uNew" placeholder="이름 추가 (예: 홍길동)" maxlength="30" autocomplete="off"><button class="btn primary" id="uAdd">추가</button></div>
      <div class="hint" style="margin-top:6px">목록은 모든 PC에서 공유됩니다. 추가·삭제는 품질 비밀번호가 필요합니다.</div>`;
    openModal(true);
  }
  $('#mBody').addEventListener('click', e => {
    const pk = e.target.closest('[data-upick]');
    if (pk) { LS.set('track.user', pk.dataset.upick); renderUser(); toast(`작성자: ${pk.dataset.upick}`); closeModal(); return; }
    const dl = e.target.closest('[data-udel]');
    if (dl) { const n = dl.dataset.udel; if (!confirm(`'${n}'을(를) 사용자 목록에서 삭제할까요?`)) return;
      mutate({ action: 'removeUser', name: n }, '삭제되었습니다', d => { d.users = (d.users || []).filter(x => x !== n); }, () => { if (state.data && !$('#overlay').hidden && $('#mTitle').textContent === '사용자 선택') openUsers(); }); return; }
    if (e.target.id === 'uAdd') {
      const n = ($('#uNew').value || '').trim(); if (!n) { $('#uNew').focus(); return; }
      if (((state.data && state.data.users) || []).includes(n)) { toast('이미 있는 이름입니다', true); return; }
      if (!LS.get('track.user')) { LS.set('track.user', n); renderUser(); } // first name added becomes this PC's 작성자
      mutate({ action: 'addUser', name: n }, `${n} 추가되었습니다`, d => { d.users = (d.users || []).concat(n); });
      setTimeout(() => { if (!$('#overlay').hidden && $('#mTitle').textContent === '사용자 선택') openUsers(); }, 50);
    }
  });
  $('#mBody').addEventListener('keydown', e => { if (e.target.id === 'uNew' && e.key === 'Enter') { e.preventDefault(); $('#uAdd').click(); } });

  async function load(manual) {
    if (state.pending) return;
    if (!manual && !$('#overlay').hidden) return; // don't disturb while editing
    try {
      state.data = await apiGet({ action: 'bootstrap' });
      render(true);
      if (DEV && !SY.rows && !SY.loading) loadSync(false);
      $('#banner').hidden = !DEMO;
      if (DEMO) $('#banner').textContent = '데모 모드입니다. config.js에 Apps Script URL을 설정하면 실제 데이터가 연동됩니다.';
      if (manual) toast('새로고침 완료');
    } catch (e) { toast('불러오기 실패: ' + e.message, true); $('#lastSync').textContent = '연결 오류'; }
  }

  // ===================== Demo backend =====================
  const Demo = (() => {
    const DSTEPS = ['DR', '제조', 'QC검수', 'QC검수 조치확인', '반복 Cycle 촬영', 'Full Cycle 촬영', '패킹 서류 스캔 및 인쇄', '클리닝(제조)', '패킹리스트(영업) 확인', '출하사진 촬영', '패킹(서류동봉)', '출하'];
    const STEPS = DEV ? DSTEPS : ['QC검수', 'QC검수 조치확인', 'FAT 셋업', 'FAT 측정(진동)', 'FAT 측정(반복정밀도)', 'FAT 측정(AWC)', '반복 Cycle 촬영', 'Full Cycle 촬영', 'X1/X2 핸드레벨 촬영', '물방울 JIG 레벨 촬영', '로봇 배선 해체(제조)', '패킹 서류 스캔 및 인쇄', '클리닝(제조)', '패킹리스트(영업) 확인', '출하사진 촬영', '패킹(서류 동봉)', '출하'];
    const FILE = DEV ? [5, 6, 7, 10] : [4, 5, 6, 7, 8, 9, 10, 12, 15];
    const MSTEPS = ['자재입고', '로봇 조립', '로봇 배선', '1차 레벨', '제어프로그램 삽입', 'I/O Check', 'DRY Cycle', 'FT (Final Test)', 'FULL Cycle', 'QC검수 전 점검'];
    const L = (id, type, slot, label, x, y, w, h) => ({ id, type, slot, label, x, y, w, h });
    const layout = DEV ? [
      ...[0, 1, 2, 3, 4, 5, 6, 7].map(i => L('slot-' + (i + 1), 'slot', i + 1, '', 8 + (i % 4) * 204, i < 4 ? 8 : 246, 196, 230)),
      L('note-1', 'note', null, '기타사항', 824, 8, 168, 468),
    ] : [
      L('wall-top', 'wall', null, '', 40, 6, 952, 18), L('wall-left', 'wall', null, '', 8, 235, 24, 402),
      ...['MPR, EMR, ITR', 'STR, ESR', 'STR, ESR', 'MPR', 'ITR, EMR', 'FER'].map((t, i) => L('slot-' + (i + 3), 'slot', i + 3, t, 40 + i * 160, 30, 152, 195)),
      L('slot-2', 'slot', 2, 'MPR, ITR', 40, 235, 192, 185), L('slot-1', 'slot', 1, 'MPR', 40, 426, 192, 185),
      L('door-1', 'door', null, '출입문', 40, 617, 192, 20),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map(i => L('pack-' + (i + 1), 'pack', 9 + i, '패킹 ' + (i + 1), 244 + (i % 4) * 148, i < 4 ? 235 : 433, 140, 190)),
      L('note-1', 'note', null, '기타사항', 840, 235, 152, 190), L('spec-1', 'spec', null, 'TRACK Robot Specification', 840, 433, 152, 190),
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
      // 제조: done once quality work started; otherwise partly done (demo)
      mfg: DEV ? [] : MSTEPS.map((n, i) => { const no = i + 1; const md = doneN >= 1 ? MSTEPS.length : (extra.m != null ? extra.m : 0); return Object.assign({ stepNo: no, stepName: n, status: no <= md ? '완료' : no === md + 1 && extra.m != null ? '진행' : '대기', startDate: '', endDate: '', owner: '', progress: no === md + 1 && extra.m != null ? '배선 작업 중' : '', issue: '', fileRequired: false }, (extra.mx || {})[no] || {}); }),
    });
    const db = [
      mk('P1', 9, names[0], 11, { 13: { status: '진행', owner: '곽승범' } }), mk('P2', 7, names[1], 6, { 7: { status: '조치중', issue: 'Cycle 중 Z축 이음 발생, 벨트 텐션 재조정 필요' } }),
      mk('P3', 6, names[2], 3), mk('P4', 4, names[3], 1, { 2: { status: '조치중', issue: 'QC 지적사항 1건 미조치 (커버 도장)' } }),
      mk('P5', 3, names[4], 10), mk('P6', 2, names[5], 0, { 1: { status: '보류', issue: '자재 미입고' }, m: 2, mx: { 3: { status: '조치중', issue: '커넥터 핀 불량 교체 대기' } } }),
      mk('P7', 1, names[6], 0, { 1: { status: '대기' }, m: 0 }), mk('P8', null, names[7], 2),
      Object.assign(mk('P9', null, names[8], 14), { state: 'shipped' }),
    ];
    if (DEV) db.forEach(p => { if (p.slot > 8) p.slot = 8; });
    const NR = (no, done, action, date, project, item, partNo, qty, vendor, defect, finder, owner, content, note = '') => ({ no: String(no), done, action, date, due: '', project, item, partNo, qty: String(qty), vendor, defect, finder, owner, content, note });
    const ncrSrc = [
      NR(2808, false, '입고요청', '08/03', 'RD-SH-13-013 MPR#4', 'Ionbar', 'I-09-020', 1, '키앤스', '오입고', '박제민', '김나현', '부속품 브라켓 미입고'),
      NR(2822, false, '재발주', '08/05', 'MISC-STR11 #1', 'Z MOVER', 'TM01S-Z110-M005-0', 1, '제조2팀', '외관손상', '조규완', '이현지', '로봇가동중 충격으로 인한 외관손상'),
      NR(2823, false, '재발주', '08/05', 'MISC-STR10 #1', 'Z BELT CLAMP', 'TM01S-Z110-A001-1', 4, '제조2팀', '외관손상', '조규완', '이현지', '조립불량으로 인한 외관손상'),
      NR(2830, true, '업체반출', '08/06', 'MISC-STR10 #1', 'Z CABLE COVER', 'TM01S-Z110-C002-0', 2, '아진물산', 'Hole', '한태경', '김수원', '도면과 홀 위치 상이', '재가공 후 입고 완료'),
      NR(2851, false, '방문조치', '08/07', 'RD-SH-13-013 ESR#2', 'BACK SIDE COVER', 'CC04-145-B01', 1, '기구설계', '치수', '이연우', '김나현', '커버 간섭 발생'),
      NR(2860, false, '현물수정', '08/08', 'RD-SH-13-013 EMR#1', 'LM GUIDE', 'CME00-LM00-M019-0', 1, '아진물산', 'Hole', '한태경', '김수원', '체결 불가'),
      NR(2902, false, '', '08/11', 'ECP352', 'MAGNET', 'B-05-002', 1, '기구', '외관손상', '최진혁', '김나현', '대상 외 프로젝트(필터됨)'),
    ];
    const ncr = []; let ncrAt = ''; const users = ['곽승범', '김나현'];
    const board = [{ id: 'B1', kind: 'agree', date: '2026-10-27', author: '곽승범', content: '본딩 파트 검사 기준: -28.0kPa 5초 이내 리크 0.3 이내', applyDate: '2026-11-01', createdAt: '2026-10-27 10:00' },
      { id: 'B2', kind: 'minutes', date: '2026-10-28', author: '곽승범', attendees: '곽승범, 김나현', content: '설계 개선 논의\n1) 대체품 검토', status: '검토', createdAt: '2026-10-28 13:00' }];
    const refs = [{ id: 'R1', title: 'FAT 체크리스트 양식', author: '곽승범', date: '2026-10-20', desc: '최신 양식', url: 'https://example.com', fileName: '', fileId: '', size: '', mime: '', createdAt: '2026-10-20 09:00' }];
    const snap = () => JSON.parse(JSON.stringify({ ok: true, layout, notes, ncr, ncrSyncedAt: ncrAt, projects: db.filter(p => p.state !== 'removed'), users, mfgStepDefs: DEV ? [] : MSTEPS.map((n, i) => ({ no: i + 1, name: n, file: false, par: [7, 8].includes(i + 1) ? 'M' : undefined })), stepDefs: DEV ? STEPS.map((n, i) => ({ no: i + 1, name: n, file: FILE.includes(i + 1), par: [7, 8, 9, 10].includes(i + 1) ? 'A' : [3, 4, 5, 6].includes(i + 1) ? 'B' : undefined, checks: i === 6 ? ['QC시트', 'IO시트'] : undefined })) : STEPS.map((n, i) => ({ no: i + 1, name: n, file: FILE.includes(i + 1), measure: [4, 5, 6].includes(i + 1), par: [12, 13, 14, 15].includes(i + 1) ? 'A' : [4, 5, 6].includes(i + 1) ? 'B' : undefined, checks: i === 11 ? ['QC시트', 'IO시트'] : undefined })), statuses: ['대기', '진행', '조치중', '완료', '보류', '생략'], syncExcluded: excluded }));
    const wait = (v) => new Promise(r => setTimeout(() => r(v), 600));
    const log = (b, action, p, s, detail) => history.push({ at: now(), by: b.user, action, actionLabel: ({ sync: '참조 동기화', unsync: '동기화 취소', exclude: '동기화 제외', include: '제외 해제' })[action] || action, projectId: p ? p.id : '', projectName: p ? p.projectName : '', slot: p ? (p.slot || '') : '', stepNo: s ? s.stepNo : '', stepName: s ? s.stepName : '', status: s ? s.status : '', startDate: s ? s.startDate : '', endDate: s ? s.endDate : '', owner: s ? s.owner : '', progress: s ? s.progress : '', issue: s ? s.issue : '', detail: detail || '' });
    const refRows = names.concat(['MISC-ITR12 #1', 'MISC-EMR3 #1', 'RD-SH-13-014 MPR#1', 'RD-SH-13-014 ITR#2']).map((n, i) => (DEV ? { no: i + 1, name: n, type: ['MPR', 'ITR', 'STR', 'EMR'][i % 4], cat: '개발', ship: i < 7 ? '' : '26-10-' + String(10 + i) } : { no: i + 1, name: n, type: 'IMMERSION TRACK', ship: i < 7 ? '' : i < 12 ? '26-12-31' : '26-10-' + String(10 + i) }));
    const excluded = ['MISC-FER0 #1'];
    const occupied = (slot, selfId) => db.find(p => p.state === 'active' && Number(p.slot) === Number(slot) && p.id !== selfId);
    const isPackD = (slot) => layout.some(l => l.type === 'pack' && l.slot === Number(slot));
    const curNo = (p) => { const c = p.steps.find(s => s.status !== '완료' && s.status !== '생략'); return c ? c.stepNo : 15; };
    return {
      get(p) {
        if (p.action === 'projectNames') return wait({ ok: true, names });
        if (p.action === 'history') { const acts = String(p.actions || '').split(',').filter(Boolean); return wait({ ok: true, rows: history.filter(r => (!p.projectId || r.projectId === p.projectId) && (!acts.length || acts.includes(r.action))) }); }
        if (p.action === 'refRows') return wait({ ok: true, rows: refRows });
        if (p.action === 'board') return wait({ ok: true, board: JSON.parse(JSON.stringify(board)), refs: JSON.parse(JSON.stringify(refs)) });
        if (p.action === 'refFile') { const r = refs.find(x => x.id === p.id); return r ? wait({ ok: true, name: r.fileName, mime: r.mime, data: r._data || '' }) : wait({ ok: false, error: '파일 없음' }); }
        return wait(snap());
      },
      post(b) {
        const fail = (msg) => wait({ ok: false, error: msg });
        if (b.action === 'saveNote') { notes[b.id] = { content: b.content, style: b.style || '', updatedAt: now(), updatedBy: b.user }; log(b, '기타사항 수정', null, null, b.content); return wait(snap()); }
        if (b.action === 'createProject') {
          if (db.some(p => p.state === 'active' && p.projectName === b.projectName)) return fail('이미 등록된 진행중 프로젝트입니다.');
          if (b.slot && isPackD(b.slot)) return fail('패킹 칸 조건 불충족');
          const occ = b.slot && occupied(b.slot);
          if (occ && !b.force) return fail('이미 배치됨');
          if (occ) occ.slot = null;
          const p = mk('P' + Date.now(), b.slot ? Number(b.slot) : null, b.projectName, -1); p.steps.forEach(s => { if (startDone(s.stepNo, b.startStep || 1, STEPS.length)) s.status = '완료'; }); if ((b.startStep || 1) >= STEPS.length) { p.state = 'shipped'; p.slot = null; } p.createdAt = now(); p.createdBy = b.user;
          db.push(p); log(b, '프로젝트 등록', p);
        }
        if (b.action === 'syncProjects') {
          (b.items || []).forEach((it, k) => {
            if (db.some(x => x.state !== 'removed' && x.projectName === it.name)) return;
            let slot = it.slot ? Number(it.slot) : null;
            if (slot && (occupied(slot) || (isPackD(slot) && it.startStep < PACK_MIN_STEP))) slot = null;
            const np = mk('S' + Date.now() + k, slot, it.name, -1); np.steps.forEach(s => { if (startDone(s.stepNo, it.startStep || 1, STEPS.length)) s.status = '완료'; }); if ((it.startStep || 1) >= STEPS.length) { np.state = 'shipped'; np.slot = null; }
            db.push(np); log(b, 'sync', np, null, '참조 시트 동기화 · ' + (slot ? slot + '번 배치' : '미배치'));
          });
          return wait(snap());
        }
        if (b.action === 'syncNcr') {
          const names = db.filter(x => x.state !== 'removed').map(x => x.projectName.replace(/\s+/g, '').toUpperCase());
          let added = 0;
          ncrSrc.filter(r => names.includes(r.project.replace(/\s+/g, '').toUpperCase())).forEach(r => { if (!ncr.some(x => x.no === r.no)) { ncr.push(Object.assign({}, r, { syncedAt: now(), updatedAt: '', updatedBy: '' })); added++; } });
          ncrAt = now(); const j = snap(); j.ncrResult = { added, filled: 0 }; return wait(j);
        }
        const bd = () => wait({ ok: true, board: JSON.parse(JSON.stringify(board)), refs: JSON.parse(JSON.stringify(refs)) });
        if (b.action === 'saveBoard') { const ex = board.find(x => x.id === b.id); const f = { kind: b.kind, date: b.date, author: b.author, attendees: b.attendees, content: b.content, applyDate: b.applyDate, status: b.status, note: b.note }; if (ex) Object.assign(ex, f, { updatedAt: now(), updatedBy: b.user }); else board.push(Object.assign({ id: 'B' + Date.now(), createdAt: now(), createdBy: b.user }, f)); return bd(); }
        if (b.action === 'deleteBoard') { const k = board.findIndex(x => x.id === b.id); if (k >= 0) board.splice(k, 1); return bd(); }
        if (b.action === 'saveRef') { refs.push({ id: 'R' + Date.now(), title: b.title, author: b.author, date: b.date, desc: b.desc, url: b.url || '', fileName: b.fileName || '', fileId: b.data ? 'F' + Date.now() : '', size: b.data ? String(Math.floor(b.data.length * 3 / 4)) : '', mime: b.mime || '', _data: b.data || '', createdAt: now(), createdBy: b.user }); return bd(); }
        if (b.action === 'deleteRef') { const k = refs.findIndex(x => x.id === b.id); if (k >= 0) refs.splice(k, 1); return bd(); }
        if (b.action === 'addUser') { if (!users.includes(b.name)) users.push(b.name); return wait(snap()); }
        if (b.action === 'removeUser') { const k = users.indexOf(b.name); if (k >= 0) users.splice(k, 1); return wait(snap()); }
        if (b.action === 'setNcrDone') { ncr.forEach(x => { if ((b.nos || []).includes(x.no)) { x.done = b.done !== false; x.updatedAt = now(); x.updatedBy = b.user; } }); return wait(snap()); }
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
        if (b.action === 'skipTo' && p) { applySkipLocal(p, b.stepNo, b.track === 'mfg'); log(b, '시작 공정 지정', p); }
        if (b.action === 'bulkSkipTo') { (b.projectIds || []).forEach(id => { const x = db.find(y => y.id === id); if (x) { applySkipLocal(x, b.stepNo, b.track === 'mfg'); log(b, '시작 공정 지정', x); } }); return wait(snap()); }
        if (b.action === 'updateProject' && p) { log(b, '프로젝트명 수정', p, null, p.projectName + ' → ' + b.projectName); p.projectName = b.projectName; }
        if (b.action === 'saveStep' && p) {
          const s = (b.track === 'mfg' ? p.mfg : p.steps).find(x => x.stepNo === b.stepNo);
          ['status', 'startDate', 'endDate', 'owner', 'progress', 'issue'].forEach(k => (s[k] = b[k])); if (b.checks !== undefined) s.checks = b.checks; s.updatedAt = now(); s.updatedBy = b.user;
          log(b, '공정 저장', p, s);
        }
        if (b.action === 'saveMeasure' && p) { (b.items || []).forEach(it => { const s = p.steps.find(x => x.stepNo === Number(it.stepNo)); if (s) { s.x1 = it.x1; s.x2 = it.x2; } }); log(b, 'measure', p, null, JSON.stringify(b.items)); }
        if (b.action === 'saveSummary' && p) { p.summaryProgress = b.summaryProgress; p.summaryIssue = b.summaryIssue; log(b, '요약 저장', p); }
        if (b.action === 'release' && p) { p.state = b.state; p.slot = null; log(b, b.state === 'shipped' ? '출하 완료' : '삭제', p); }
        if (b.action === 'restore' && p) { p.state = 'active'; log(b, '복원', p); }
        if (p) { p.updatedAt = now(); p.updatedBy = b.user; }
        return wait(snap());
      },
    };
  })();

  // FAT 탭 '측정값 업로드': P-P Diameter -> 반복정밀도(5번)/AWC(6번) 공정의 X1/X2 (other hand's value kept)
  if (window.FatTab) window.FatTab.upload = async (u) => {
    const p = activeProjects().find(x => x.projectName === u.proj);
    if (!p) { toast(`'${u.proj}'은(는) 등록된 진행중 프로젝트가 아니라 측정값을 업로드할 수 없습니다 (그래프·엑셀 내보내기는 가능)`, true); return; }
    const def = measDefs().find(d => (u.test === 'awc' ? /AWC/i : /반복정밀도/).test(d.name));
    if (!def) { toast('측정 공정을 찾을 수 없습니다', true); return; }
    const s = (p.steps || []).find(x => Number(x.stepNo) === def.no) || {};
    const k = u.hand === 'X2' ? 'x2' : 'x1';
    const old = String(s[k] || '').trim();
    const ok = await confirmBox('측정값 업로드', `${p.projectName}\n${def.no}. ${def.name} · ${u.hand} = ${u.value}${old ? `\n(기존 값 ${old} → 덮어쓰기)` : ''}`);
    if (!ok) return;
    if (needKey() && !(await askKey())) return;
    const item = { stepNo: def.no, x1: k === 'x1' ? u.value : String(s.x1 || ''), x2: k === 'x2' ? u.value : String(s.x2 || '') };
    saveMeas(p.id, [item], `측정값 업로드 완료 · ${p.projectName} ${def.no}번 ${u.hand} ${u.value}`);
  };

  // ===================== 기타 탭 (협의사항 · 회의록 · 참고자료 · 기타) =====================
  // data is loaded only when the tab opens (not part of bootstrap) so the dashboard stays fast; writes need the 품질 비밀번호
  const ETC = { data: null, loading: false, q: '' };
  const ETC_DEF = {
    agree: { label: '협의사항', cols: [['date', '날짜', 'd'], ['author', '작성자', 'a'], ['content', '내용', 'c'], ['applyDate', '적용일자', 'd']] },
    minutes: { label: '회의록', cols: [['date', '날짜', 'd'], ['author', '작성자', 'a'], ['attendees', '참석자', 'a2'], ['content', '내용', 'c'], ['status', '진행현황', 's']] },
    refs: { label: '참고자료' },
    misc: { label: '기타', cols: [['date', '날짜', 'd'], ['author', '작성자', 'a'], ['content', '내용', 'c'], ['note', '비고', 'n']] },
  };
  const MIN_ST = ['보류', '검토', '승인'];
  const REF_MAX = 20 * 1024 * 1024;
  const fmtSize = (n) => { n = Number(n) || 0; return n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : n >= 1024 ? Math.round(n / 1024) + 'KB' : n + 'B'; };
  async function withMainKey(fn) { if (needKey('') && !(await askKey(''))) return; return fn(); }
  async function loadEtc() {
    ETC.loading = true;
    try { const r = await apiGet({ action: 'board' }); ETC.data = { board: r.board || [], refs: r.refs || [] }; }
    catch (e) { toast('기타 탭을 불러오지 못했습니다: ' + e.message, true); if (!ETC.data) ETC.data = { board: [], refs: [] }; }
    ETC.loading = false; if (state.tab === 'etc') renderEtc();
  }
  function renderEtc() {
    const v = $('#viewEtc'); const kind = state.etcSub; const def = ETC_DEF[kind];
    if (!ETC.data) { v.innerHTML = '<div class="empty-msg">불러오는 중…</div>'; if (!ETC.loading) loadEtc(); return; }
    const q = ETC.q.trim().toLowerCase();
    const hit = (o) => !q || Object.values(o).some(x => String(x || '').toLowerCase().includes(q));
    const byDate = (a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    const rows = kind === 'refs' ? ETC.data.refs.filter(hit).sort(byDate) : ETC.data.board.filter(r => r.kind === kind).filter(hit).sort(byDate);
    const head = `<div class="toolbar etc-tb"><div class="tb-left"><div class="search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input type="search" id="etcQ" placeholder="${def.label} 검색" value="${esc(ETC.q)}"></div><span class="hint">${rows.length}건 · 보기는 누구나, 작성·수정·삭제는 품질 비밀번호</span></div>
      <div class="tb-right"><button class="btn ghost" id="etcReload">새로고침</button><button class="btn primary" id="etcNew">+ ${kind === 'refs' ? '자료 등록' : def.label + ' 작성'}</button></div></div>`;
    let body;
    if (!rows.length) body = `<div class="empty-msg">${q ? '검색 결과가 없습니다.' : `등록된 ${def.label}이(가) 없습니다.`}</div>`;
    else if (kind === 'refs') {
      body = `<div class="etc-wrap"><table class="etc-t"><thead><tr><th class="w-d">날짜</th><th>제목</th><th>첨부</th><th class="w-a">작성자</th><th>설명</th><th class="w-act"></th></tr></thead><tbody>${rows.map(r => `<tr>
        <td class="w-d">${esc(r.date)}</td><td class="etc-title">${esc(r.title)}</td>
        <td>${r.fileId ? `<button class="btn ghost etc-dl" data-dl="${esc(r.id)}" title="내려받기">⬇ ${esc(r.fileName)} <small>${fmtSize(r.size)}</small></button>` : ''}${r.url ? `<a class="etc-link" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">🔗 링크 열기</a>` : ''}</td>
        <td class="w-a">${esc(r.author)}</td><td class="etc-c">${esc(r.desc)}</td>
        <td class="w-act"><button class="ib del" data-rdel="${esc(r.id)}" title="삭제" aria-label="삭제"><svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/></svg></button></td></tr>`).join('')}</tbody></table></div>`;
    } else {
      body = `<div class="etc-wrap"><table class="etc-t"><thead><tr>${def.cols.map(([, l, t]) => `<th class="w-${t}">${l}</th>`).join('')}<th class="w-act"></th></tr></thead><tbody>${rows.map(r => `<tr data-bid="${esc(r.id)}">${def.cols.map(([k, , t]) => `<td class="w-${t} ${t === 'c' ? 'etc-c' : ''}">${t === 's' ? `<span class="mst mst-${esc(r[k] || '검토')}">${esc(r[k] || '검토')}</span>` : esc(r[k])}</td>`).join('')}
        <td class="w-act"><button class="ib" data-bedit="${esc(r.id)}" title="수정" aria-label="수정"><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg></button><button class="ib del" data-bdel="${esc(r.id)}" title="삭제" aria-label="삭제"><svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/></svg></button></td></tr>`).join('')}</tbody></table></div>`;
    }
    const focused = document.activeElement && document.activeElement.id === 'etcQ';
    v.innerHTML = head + body;
    if (focused) { const i = $('#etcQ'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
  }
  function openEtcForm(kind, row) {
    state.openProjectId = null;
    const r = row || {}; const def = ETC_DEF[kind];
    const me = LS.get('track.user') || '';
    $('#mSlot').textContent = '기타 · ' + def.label + (row ? ' 수정' : ' 작성');
    $('#mTitle').textContent = kind === 'refs' ? '참고자료 등록' : def.label;
    const f = (lbl, html, wide) => `<label class="f ${wide ? 'etc-wide' : ''}"><span>${lbl}</span>${html}</label>`;
    const date = (n, val) => `<input type="date" class="in" name="${n}" value="${esc(val || '')}">`;
    const txt = (n, val, ph) => `<input type="text" class="in" name="${n}" value="${esc(val || '')}" placeholder="${esc(ph || '')}" ${n === 'author' ? 'list="userList" autocomplete="off"' : ''}>`;
    const area = (n, val, ph, rows) => `<textarea class="in" name="${n}" rows="${rows || 6}" placeholder="${esc(ph || '')}">${esc(val || '')}</textarea>`;
    let fields;
    if (kind === 'refs') fields = f('제목', txt('title', '', '자료 제목'), true) + f('날짜', date('date', today())) + f('작성자', txt('author', me))
      + f('설명', area('desc', '', '자료 설명 (선택)', 3), true)
      + f(`파일 <small class="hint">20MB 이하 · 구글 드라이브에 저장</small>`, `<input type="file" class="in" name="file">`, true)
      + f('또는 링크', txt('url', '', 'https:// (큰 파일은 드라이브/NAS에 올리고 링크 등록)'), true);
    else {
      fields = f('날짜', date('date', r.date || today())) + f('작성자', txt('author', r.author || me));
      if (kind === 'minutes') fields += f('참석자', txt('attendees', r.attendees, '예) 곽승범, 김나현'), true);
      fields += f('내용', area('content', r.content, '내용을 입력하세요', 8), true);
      if (kind === 'agree') fields += f('적용일자', date('applyDate', r.applyDate));
      if (kind === 'minutes') fields += f('진행현황', `<select class="in" name="status">${MIN_ST.map(s => `<option ${((r.status || '검토') === s) ? 'selected' : ''}>${s}</option>`).join('')}</select>`);
      if (kind === 'misc') fields += f('비고', area('note', r.note, '비고 (선택)', 3), true);
    }
    $('#mBody').innerHTML = `<div class="etc-form" data-kind="${kind}" data-id="${esc(r.id || '')}">${fields}</div>
      <div class="row-end">${row ? '<button class="btn danger" id="etcFormDel">삭제</button>' : ''}<span style="flex:1"></span><button class="btn primary" id="etcSave">${row ? '수정 저장' : '등록'}</button></div>`;
    openModal(true);
  }
  const fileB64 = (file) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1] || ''); fr.onerror = () => rej(new Error('파일을 읽지 못했습니다')); fr.readAsDataURL(file); });
  async function etcPost(body, okMsg) {
    body.user = getUser();
    const j = await apiPost(body);
    ETC.data = { board: j.board || [], refs: j.refs || [] };
    toast(okMsg); renderEtc();
  }
  async function etcSave(btn) {
    const box = $('#mBody .etc-form'); const kind = box.dataset.kind; const id = box.dataset.id;
    const val = n => { const el = box.querySelector(`[name=${n}]`); return el ? el.value.trim() : ''; };
    let body;
    if (kind === 'refs') {
      const file = (box.querySelector('[name=file]').files || [])[0];
      if (!val('title')) { toast('제목을 입력하세요', true); return; }
      if (!file && !val('url')) { toast('파일을 선택하거나 링크를 입력하세요', true); return; }
      if (file && file.size > REF_MAX) { toast(`파일이 ${fmtSize(file.size)}입니다. 20MB 이하만 올릴 수 있습니다 — 드라이브/NAS에 올리고 링크로 등록하세요`, true); return; }
      body = { action: 'saveRef', title: val('title'), date: val('date'), author: val('author'), desc: val('desc'), url: val('url') };
      await withMainKey(async () => {
        btn.disabled = true; btn.textContent = file ? '업로드 중…' : '등록 중…';
        try {
          if (file) Object.assign(body, { fileName: file.name, mime: file.type, data: await fileB64(file) });
          await etcPost(body, '참고자료가 등록되었습니다'); closeModal();
        } catch (e) { toast('등록 실패: ' + e.message, true); btn.disabled = false; btn.textContent = '등록'; }
      });
      return;
    }
    if (!val('content')) { toast('내용을 입력하세요', true); return; }
    body = { action: 'saveBoard', id, kind, date: val('date'), author: val('author'), attendees: val('attendees'), content: val('content'), applyDate: val('applyDate'), status: val('status'), note: val('note') };
    await withMainKey(async () => {
      btn.disabled = true;
      try { await etcPost(body, id ? '수정되었습니다' : '등록되었습니다'); closeModal(); }
      catch (e) { toast('저장 실패: ' + e.message, true); btn.disabled = false; }
    });
  }
  async function etcDelete(action, id, label) {
    if (!confirm(`${label}을(를) 삭제할까요?${action === 'deleteRef' ? '\n첨부 파일은 구글 드라이브 휴지통으로 이동합니다 (30일 안에 복구 가능).' : ''}`)) return;
    await withMainKey(async () => { try { await etcPost({ action, id }, '삭제되었습니다'); if (!$('#overlay').hidden && $('#mBody .etc-form')) closeModal(); } catch (e) { toast('삭제 실패: ' + e.message, true); } });
  }
  async function refDownload(id, btn) {
    btn.disabled = true; toast('파일을 내려받는 중…');
    try {
      const r = await apiGet({ action: 'refFile', id });
      const bin = atob(r.data); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([u], { type: r.mime || 'application/octet-stream' })); a.download = r.name || 'file';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) { toast('내려받기 실패: ' + e.message, true); }
    btn.disabled = false;
  }
  $('#viewEtc').addEventListener('input', e => { if (e.target.id === 'etcQ') { ETC.q = e.target.value; renderEtc(); } });
  $('#viewEtc').addEventListener('click', e => {
    const t = e.target;
    if (t.closest('#etcNew')) { openEtcForm(state.etcSub); return; }
    if (t.closest('#etcReload')) { ETC.data = null; renderEtc(); return; }
    const dl = t.closest('[data-dl]'); if (dl) { refDownload(dl.dataset.dl, dl); return; }
    const rd = t.closest('[data-rdel]'); if (rd) { const r = ETC.data.refs.find(x => x.id === rd.dataset.rdel); etcDelete('deleteRef', rd.dataset.rdel, `'${r ? r.title : '자료'}'`); return; }
    const bd = t.closest('[data-bdel]'); if (bd) { etcDelete('deleteBoard', bd.dataset.bdel, ETC_DEF[state.etcSub].label + ' 글'); return; }
    const be = t.closest('[data-bedit]') || (!t.closest('a,button,input') && t.closest('tr[data-bid]'));
    if (be) { const id = be.dataset.bedit || be.dataset.bid; const r = ETC.data.board.find(x => x.id === id); if (r) openEtcForm(r.kind, r); }
  });
  $('#mBody').addEventListener('click', e => {
    if (e.target.id === 'etcSave') { etcSave(e.target); return; }
    if (e.target.id === 'etcFormDel') { const box = $('#mBody .etc-form'); etcDelete('deleteBoard', box.dataset.id, ETC_DEF[box.dataset.kind].label + ' 글'); }
  });
  $('#etcTabs').addEventListener('click', e => { const b = e.target.closest('[data-etab]'); if (!b) return; state.etcSub = b.dataset.etab; LS.set('track.etcSub', state.etcSub); ETC.q = ''; renderTabs(); });
  $('#fatTabs').addEventListener('click', e => { const b = e.target.closest('[data-ftab]'); if (!b) return; state.fatSub = b.dataset.ftab; LS.set('track.fatSub', state.fatSub); renderTabs(); });

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
