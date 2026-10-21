/**
 * Track Status Board - Google Apps Script backend (v2)
 * Deploy as Web App: Execute as "Me", Access "Anyone".
 * After updating code: run setup() once (migrates sheets), then Deploy > Manage deployments > edit > New version.
 */

// ===== Config =====
const REF_SPREADSHEET_ID = '1hWRxLYkJfPEBfItSNKv7IFuSOFcLI35b9jCHnKVRBtE';
const REF_SHEET_GID = 664632288;
const REF_NAME_COL = 12;   // L
const REF_FILTER_TEXT = 'TRACK'; // checked in column M

const STATUSES = ['대기', '진행', '조치중', '완료', '보류'];

const STEPS = [
  { no: 1,  name: 'QC검수',                 file: false },
  { no: 2,  name: 'QC검수 조치확인',         file: false },
  { no: 3,  name: 'FAT 셋업',               file: false },
  { no: 4,  name: 'FAT 측정(진동)',          file: true },
  { no: 5,  name: 'FAT 측정(반복정밀도)',    file: true },
  { no: 6,  name: 'FAT 측정(AWC)',           file: true },
  { no: 7,  name: '반복Cycle 촬영',          file: true },
  { no: 8,  name: 'Full Cycle 촬영',         file: true },
  { no: 9,  name: 'X1/X2 핸드레벨 촬영',     file: true },
  { no: 10, name: '물방울 JIG 레벨 촬영',    file: true },
  { no: 11, name: '패킹리스트 확인',         file: false },
  { no: 12, name: '출하사진 촬영',           file: true },
  { no: 13, name: '패킹 서류 스캔 및 인쇄',  file: true },
  { no: 14, name: '패킹(서류 동봉)',         file: false },
];

// Floor plan on a 1000 x 700 canvas (same orientation as the CAD drawing).
// slot label = dedicated equipment types for that position (comma separated, shown for reference)
// type: slot (equipment) | pack (packing area, step>=11 only) | wall | fixture | label | note
// LAYOUT_VERSION: bump to rebuild the Layout sheet from DEFAULT_LAYOUT on next setup()
const LAYOUT_VERSION = '4';
const PACK_MIN_STEP = 11;
// Edit the "Layout" sheet to relocate; set active=FALSE to hide a row.
const LAYOUT_HEAD = ['id', 'type', 'slot', 'label', 'x', 'y', 'w', 'h', 'active'];
const DEFAULT_LAYOUT = [
  ['wall-top',  'wall',    '', '',                        90,   8, 865,  52, true],
  ['wall-left', 'wall',    '', '',                         8, 290,  52, 370, true],
  ['slot-3',    'slot',     3, 'MPR, EMR, ITR',                      95,  72, 132, 218, true],
  ['slot-4',    'slot',     4, 'STR, ESR',                     240,  72, 132, 218, true],
  ['slot-5',    'slot',     5, 'STR, ESR',                     385,  72, 132, 218, true],
  ['slot-6',    'slot',     6, 'MPR',                     530,  72, 132, 218, true],
  ['slot-7',    'slot',     7, 'ITR, EMR',                     675,  72, 132, 218, true],
  ['slot-8',    'slot',     8, 'FER',                     820,  72, 132, 218, true],
  ['slot-2',    'slot',     2, 'MPR, ITR',                      70, 302, 165, 172, true],
  ['slot-1',    'slot',     1, 'MPR',                      70, 486, 165, 172, true],
  ['fx-table1', 'fixture', '', '테이블',                 748, 605, 105,  61, true],
  ['fx-table2', 'fixture', '', '테이블',                 871, 605, 105,  61, true],
  ['lb-breaker','label',   '', '메인 전기 차단기 위치',  330, 575, 200,  20, true],
  ['lb-class',  'label',   '', 'class #1000',            400, 318, 230,  30, true],
  ['pack-1',    'pack',     9, '패킹 1',                 268, 368, 150, 192, true],
  ['pack-2',    'pack',    10, '패킹 2',                 428, 368, 150, 192, true],
  ['note-1',    'note',    '', '기타사항',               712, 395, 264, 195, true],
];

const SHEETS = {
  Layout:   LAYOUT_HEAD,
  Projects: ['id', 'slot', 'projectName', 'state', 'summaryProgress', 'summaryIssue', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy'],
  Steps:    ['projectId', 'stepNo', 'stepName', 'status', 'startDate', 'endDate', 'owner', 'progress', 'issue', 'fileRequired', 'fileCount', 'fileCheckedAt', 'updatedAt', 'updatedBy'],
  Notes:    ['id', 'content', 'updatedAt', 'updatedBy'],
  History:  ['at', 'by', 'action', 'projectId', 'projectName', 'slot', 'stepNo', 'stepName', 'status', 'startDate', 'endDate', 'owner', 'progress', 'issue', 'detail'],
};

const ACTION_LABEL = {
  create: '프로젝트 등록', setSlot: '배치 변경', saveStep: '공정 저장', saveSummary: '요약 저장',
  shipped: '출하 완료', removed: '삭제', restore: '복원', note: '기타사항 수정', edit: '프로젝트명 수정',
};

// ===== Setup / migration (safe to run repeatedly) =====
function setup() {
  const ss = getDb_();
  Object.keys(SHEETS).forEach(name => {
    let sh = ss.getSheetByName(name);
    const head = SHEETS[name];
    if (sh && sh.getLastRow() > 0) {
      const cur = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
      if (cur.slice(0, head.length).join('|') !== head.join('|')) {
        // schema changed: keep old data under a backup name
        if (name === 'Layout') { ss.deleteSheet(sh); }
        else { sh.setName(name + '_old_' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyMMddHHmm')); }
        sh = null;
      }
    }
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    if (name !== 'Layout') sh.getRange(1, 1, sh.getMaxRows(), head.length).setNumberFormat('@');
  });
  let layout = ss.getSheetByName('Layout');
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('LAYOUT_VERSION') !== LAYOUT_VERSION) {
    layout.getRange(2, 1, Math.max(layout.getMaxRows() - 1, 1), LAYOUT_HEAD.length).clearContent();
    props.setProperty('LAYOUT_VERSION', LAYOUT_VERSION);
  }
  if (layout.getLastRow() <= 1) {
    layout.getRange(2, 1, DEFAULT_LAYOUT.length, LAYOUT_HEAD.length).setValues(DEFAULT_LAYOUT);
  } else if (layout.getDataRange().getValues().every(r => r[1] !== 'note')) {
    // add default note box to an existing layout
    layout.appendRow(DEFAULT_LAYOUT.find(r => r[1] === 'note'));
  }
  const def = ss.getSheetByName('Sheet1') || ss.getSheetByName('시트1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);
  getProjectNames_(true);
  Logger.log('DB: ' + ss.getUrl());
}

let DB_ = null; // memoized per request (openById is slow)
function getDb_() {
  if (DB_) return DB_;
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('DB_ID');
  if (id) {
    try { DB_ = SpreadsheetApp.openById(id); return DB_; } catch (e) { Logger.log('DB open failed, recreating'); }
  }
  DB_ = SpreadsheetApp.create('트랙 업무 진행현황 DB');
  props.setProperty('DB_ID', DB_.getId());
  return DB_;
}

// ===== HTTP =====
function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    switch (p.action) {
      case 'projectNames': return json_({ ok: true, names: getProjectNames_(p.refresh === '1') });
      case 'history':      return json_({ ok: true, rows: getHistory_(p) });
      default:             return json_(Object.assign({ ok: true }, bootstrap_()));
    }
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

// Frontend posts with Content-Type text/plain to avoid CORS preflight.
function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents || '{}'); } catch (_) { body = {}; }
  const lock = LockService.getScriptLock();
  try {
    checkKey_(body.key);
    lock.waitLock(20000);
    let result;
    switch (body.action) {
      case 'createProject': result = createProject_(body); break;
      case 'setSlot':       result = setSlot_(body); break;
      case 'saveStep':      result = saveStep_(body); break;
      case 'saveSummary':   result = saveSummary_(body); break;
      case 'release':       result = release_(body); break;
      case 'restore':       result = restore_(body); break;
      case 'saveNote':      result = saveNote_(body); break;
      case 'updateProject': result = updateProject_(body); break;
      default: throw new Error('Unknown action');
    }
    return json_(Object.assign({ ok: true }, result));
  } catch (err) {
    const out = { ok: false, error: String((err && err.message) || err) };
    if (err && err.code) { out.code = err.code; out.occupant = err.occupant; }
    return json_(out);
  } finally {
    try { lock.releaseLock(); } catch (_) { /* not held */ }
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function checkKey_(key) {
  const k = PropertiesService.getScriptProperties().getProperty('WRITE_KEY');
  if (k && key !== k) throw new Error('입력 권한 키가 올바르지 않습니다.');
}

// ===== Reference: project names =====
function getProjectNames_(refresh) {
  const cache = CacheService.getScriptCache();
  if (!refresh) {
    const hit = cache.get('projectNames');
    if (hit) return JSON.parse(hit);
  }
  const ref = SpreadsheetApp.openById(REF_SPREADSHEET_ID);
  const sh = ref.getSheets().find(s => s.getSheetId() === REF_SHEET_GID);
  if (!sh) throw new Error('참조 시트 탭(gid=' + REF_SHEET_GID + ')을 찾을 수 없습니다.');
  const last = sh.getLastRow();
  if (last < 1) return [];
  const vals = sh.getRange(1, REF_NAME_COL, last, 2).getDisplayValues();
  const seen = {};
  const names = [];
  vals.forEach(r => {
    const name = String(r[0] || '').trim();
    const flag = String(r[1] || '').toUpperCase();
    if (name && flag.indexOf(REF_FILTER_TEXT) !== -1 && !seen[name]) { seen[name] = true; names.push(name); }
  });
  try { cache.put('projectNames', JSON.stringify(names), 600); } catch (_) { /* too large */ }
  return names;
}

// ===== Read =====
function readTable_(name) {
  const sh = getDb_().getSheetByName(name);
  const vals = sh.getDataRange().getValues();
  const head = vals.shift() || [];
  return vals.map((r, i) => {
    const o = { _row: i + 2 };
    head.forEach((h, j) => { o[h] = r[j] instanceof Date ? fmtDate_(r[j]) : r[j]; });
    return o;
  });
}
function fmtDate_(d) {
  const t = Utilities.formatDate(d, 'Asia/Seoul', 'HH:mm');
  return Utilities.formatDate(d, 'Asia/Seoul', t === '00:00' ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm');
}
// append as plain text (appendRow would auto-convert date-like strings)
function appendText_(sh, arr) {
  sh.getRange(sh.getLastRow() + 1, 1, 1, arr.length).setNumberFormat('@').setValues([arr.map(v => (v === null || v === undefined) ? '' : String(v))]);
}
function now_() { return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm'); }
function isActiveRow_(v) { return String(v).toUpperCase() !== 'FALSE'; }

function bootstrap_() {
  const layout = readTable_('Layout').filter(r => r.type && isActiveRow_(r.active)).map(r => ({
    id: String(r.id), type: String(r.type), slot: r.slot === '' ? null : Number(r.slot), label: String(r.label || ''),
    x: Number(r.x) || 0, y: Number(r.y) || 0, w: Number(r.w) || 0, h: Number(r.h) || 0,
  }));
  const projects = readTable_('Projects').filter(p => p.state === 'active' || p.state === 'shipped');
  const byProj = {};
  readTable_('Steps').forEach(s => { (byProj[s.projectId] = byProj[s.projectId] || []).push(s); });
  projects.forEach(p => {
    p.slot = p.slot === '' ? null : Number(p.slot);
    p.steps = (byProj[p.id] || []).sort((a, b) => Number(a.stepNo) - Number(b.stepNo)).map(s => {
      delete s._row; delete s.projectId; s.stepNo = Number(s.stepNo); return s;
    });
    delete p._row;
  });
  const notes = {};
  readTable_('Notes').forEach(n => { notes[n.id] = { content: String(n.content || ''), updatedAt: n.updatedAt, updatedBy: n.updatedBy }; });
  return { layout, projects, notes, stepDefs: STEPS, statuses: STATUSES, serverTime: now_() };
}

function getHistory_(p) {
  const from = String(p.from || '');
  const to = String(p.to || '');
  const pid = String(p.projectId || '');
  return readTable_('History').filter(r => {
    const d = String(r.at).slice(0, 10);
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (pid && r.projectId !== pid) return false;
    return true;
  }).map(r => {
    delete r._row;
    r.actionLabel = ACTION_LABEL[r.action] || r.action;
    return r;
  });
}

// ===== Write helpers =====
function findRow_(sh, predicate) {
  const vals = sh.getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) if (predicate(vals[i])) return i + 1;
  return -1;
}
function rowObj_(sheetName, row) {
  const sh = getDb_().getSheetByName(sheetName);
  const h = SHEETS[sheetName];
  const v = sh.getRange(row, 1, 1, h.length).getValues()[0];
  const o = {};
  h.forEach((k, i) => { o[k] = v[i] instanceof Date ? fmtDate_(v[i]) : v[i]; });
  return o;
}
function projectRow_(id) {
  const row = findRow_(getDb_().getSheetByName('Projects'), r => r[0] === id);
  if (row < 0) throw new Error('프로젝트를 찾을 수 없습니다.');
  return row;
}

// Full snapshot per change (for Excel export)
function history_(by, action, proj, step, detail) {
  const h = SHEETS.History;
  const o = {
    at: now_(), by: by || '', action: action,
    projectId: proj ? proj.id : '', projectName: proj ? proj.projectName : '', slot: proj ? proj.slot : '',
    stepNo: step ? step.stepNo : '', stepName: step ? step.stepName : '', status: step ? step.status : '',
    startDate: step ? step.startDate : '', endDate: step ? step.endDate : '', owner: step ? step.owner : '',
    progress: step ? step.progress : '', issue: step ? step.issue : '', detail: detail || '',
  };
  appendText_(getDb_().getSheetByName('History'), h.map(k => (o[k] === undefined || o[k] === null) ? '' : o[k]));
}

function touchProject_(row, user) {
  const ps = getDb_().getSheetByName('Projects');
  const h = SHEETS.Projects;
  ps.getRange(row, h.indexOf('updatedAt') + 1, 1, 2).setNumberFormat('@').setValues([[now_(), user || '']]);
}

function isPackSlot_(slot) {
  return readTable_('Layout').some(r => String(r.type) === 'pack' && Number(r.slot) === Number(slot) && isActiveRow_(r.active));
}
function currentStepNo_(projectId) {
  const steps = readTable_('Steps').filter(s => s.projectId === projectId).sort((a, b) => Number(a.stepNo) - Number(b.stepNo));
  const cur = steps.find(s => s.status !== '완료');
  return cur ? Number(cur.stepNo) : STEPS.length + 1;
}
function packError_() {
  return new Error('패킹 칸에는 현재 공정이 ' + PACK_MIN_STEP + '번(' + STEPS[PACK_MIN_STEP - 1].name + ') 이상인 프로젝트만 배치할 수 있습니다.');
}

function slotError_(slot, occupant) {
  const e = new Error(slot + '번에는 이미 "' + occupant + '" 프로젝트가 배치되어 있습니다.');
  e.code = 'OCCUPIED'; e.occupant = occupant;
  return e;
}

// ===== Actions =====
function createProject_(b) {
  const name = String(b.projectName || '').trim();
  if (!name) throw new Error('프로젝트명이 필요합니다.');
  const slot = b.slot ? Number(b.slot) : '';
  const ss = getDb_();
  const ps = ss.getSheetByName('Projects');
  const active = readTable_('Projects').filter(p => p.state === 'active');
  if (active.some(p => p.projectName === name)) throw new Error('이미 등록된 진행중 프로젝트입니다.');
  if (slot && isPackSlot_(slot)) throw packError_();
  if (slot) {
    const occ = active.find(p => Number(p.slot) === slot);
    if (occ && !b.force) throw slotError_(slot, occ.projectName);
    if (occ) {
      ps.getRange(occ._row, 2).setValue('');
      history_(b.user, 'setSlot', occ, null, slot + '번 → 미배치 (자리 교체)');
    }
  }
  const id = 'P' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyMMddHHmmss') + Math.floor(Math.random() * 90 + 10);
  const t = now_();
  appendText_(ps, [id, slot, name, 'active', '', '', t, b.user || '', t, b.user || '']);
  const rows = STEPS.map(s => [id, s.no, s.name, '대기', '', '', '', '', '', s.file, '', '', '', '']);
  const st = ss.getSheetByName('Steps');
  st.getRange(st.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  history_(b.user, 'create', { id: id, projectName: name, slot: slot }, null, slot ? slot + '번 배치' : '미배치');
  return bootstrap_();
}

function setSlot_(b) {
  const ps = getDb_().getSheetByName('Projects');
  const row = projectRow_(b.projectId);
  const proj = rowObj_('Projects', row);
  const slot = b.slot ? Number(b.slot) : '';
  if (slot && isPackSlot_(slot) && currentStepNo_(proj.id) < PACK_MIN_STEP) throw packError_();
  if (slot) {
    const occ = readTable_('Projects').find(p => p.state === 'active' && Number(p.slot) === slot && p.id !== proj.id);
    if (occ && !b.force) throw slotError_(slot, occ.projectName);
    if (occ) {
      ps.getRange(occ._row, 2).setValue('');
      history_(b.user, 'setSlot', occ, null, slot + '번 → 미배치 (자리 교체)');
    }
  }
  ps.getRange(row, 2).setValue(slot);
  touchProject_(row, b.user);
  history_(b.user, 'setSlot', { id: proj.id, projectName: proj.projectName, slot: slot }, null, (proj.slot || '미배치') + ' → ' + (slot || '미배치'));
  return bootstrap_();
}

function saveStep_(b) {
  const st = getDb_().getSheetByName('Steps');
  const row = findRow_(st, r => r[0] === b.projectId && Number(r[1]) === Number(b.stepNo));
  if (row < 0) throw new Error('공정을 찾을 수 없습니다.');
  if (b.status && STATUSES.indexOf(b.status) === -1) throw new Error('잘못된 상태값');
  const h = SHEETS.Steps;
  const cur = st.getRange(row, 1, 1, h.length).getValues()[0];
  ['status', 'startDate', 'endDate', 'owner', 'progress', 'issue'].forEach(k => {
    if (b[k] !== undefined) cur[h.indexOf(k)] = b[k];
  });
  cur[h.indexOf('updatedAt')] = now_();
  cur[h.indexOf('updatedBy')] = b.user || '';
  st.getRange(row, 1, 1, h.length).setValues([cur]);
  const prow = projectRow_(b.projectId);
  touchProject_(prow, b.user);
  history_(b.user, 'saveStep', rowObj_('Projects', prow), rowObj_('Steps', row), '');
  return bootstrap_();
}

function saveSummary_(b) {
  const ps = getDb_().getSheetByName('Projects');
  const row = projectRow_(b.projectId);
  const h = SHEETS.Projects;
  ps.getRange(row, h.indexOf('summaryProgress') + 1, 1, 2).setValues([[b.summaryProgress || '', b.summaryIssue || '']]);
  touchProject_(row, b.user);
  history_(b.user, 'saveSummary', rowObj_('Projects', row), null, '진행: ' + (b.summaryProgress || '-') + ' / 이슈: ' + (b.summaryIssue || '-'));
  return bootstrap_();
}

function release_(b) {
  const ps = getDb_().getSheetByName('Projects');
  const row = projectRow_(b.projectId);
  const proj = rowObj_('Projects', row);
  const state = b.state === 'removed' ? 'removed' : 'shipped';
  ps.getRange(row, 2).setValue('');
  ps.getRange(row, SHEETS.Projects.indexOf('state') + 1).setValue(state);
  touchProject_(row, b.user);
  history_(b.user, state, proj, null, proj.slot ? proj.slot + '번 비움' : '');
  return bootstrap_();
}

function saveNote_(b) {
  const id = String(b.id || '').trim();
  if (!id) throw new Error('기타사항 칸 ID가 필요합니다.');
  const sh = getDb_().getSheetByName('Notes');
  const row = findRow_(sh, r => r[0] === id);
  const vals = [[id, String(b.content || ''), now_(), b.user || '']];
  if (row < 0) appendText_(sh, vals[0]); else sh.getRange(row, 1, 1, 4).setNumberFormat('@').setValues(vals);
  history_(b.user, 'note', null, null, id + ': ' + String(b.content || ''));
  return bootstrap_();
}

function updateProject_(b) {
  const ps = getDb_().getSheetByName('Projects');
  const row = projectRow_(b.projectId);
  const proj = rowObj_('Projects', row);
  const name = String(b.projectName || '').trim();
  if (!name) throw new Error('프로젝트명이 필요합니다.');
  if (name !== proj.projectName && readTable_('Projects').some(p => p.state === 'active' && p.projectName === name && p.id !== proj.id)) {
    throw new Error('이미 등록된 진행중 프로젝트입니다.');
  }
  ps.getRange(row, SHEETS.Projects.indexOf('projectName') + 1).setNumberFormat('@').setValue(name);
  touchProject_(row, b.user);
  history_(b.user, 'edit', { id: proj.id, projectName: name, slot: proj.slot }, null, proj.projectName + ' → ' + name);
  return bootstrap_();
}

function restore_(b) {
  const ps = getDb_().getSheetByName('Projects');
  const row = projectRow_(b.projectId);
  const proj = rowObj_('Projects', row);
  if (readTable_('Projects').some(p => p.state === 'active' && p.projectName === proj.projectName && p.id !== proj.id)) {
    throw new Error('같은 이름의 진행중 프로젝트가 있습니다.');
  }
  ps.getRange(row, SHEETS.Projects.indexOf('state') + 1).setValue('active');
  touchProject_(row, b.user);
  history_(b.user, 'restore', proj, null, '진행중으로 복원 (미배치)');
  return bootstrap_();
}
