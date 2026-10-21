/**
 * Track Status Board - Google Apps Script backend
 * Deploy as Web App: Execute as "Me", Access "Anyone".
 * First run: execute setup() once from the editor (grants permissions + creates DB spreadsheet).
 */

// ===== Config =====
const REF_SPREADSHEET_ID = '1hWRxLYkJfPEBfItSNKv7IFuSOFcLI35b9jCHnKVRBtE';
const REF_SHEET_GID = 664632288;
const REF_NAME_COL = 12;   // L
const REF_FILTER_COL = 13; // M
const REF_FILTER_TEXT = 'TRACK';

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

// Default layout (current building). Edit the "Layout" sheet to relocate.
// Grid: 6 columns x 3 rows. Original drawing #1..#8 renumbered in reverse (old1->8 ... old8->1).
const DEFAULT_LAYOUT = [
  // slot, row, col, rowSpan, colSpan, active
  [3, 1, 1, 1, 1, true],
  [4, 1, 2, 1, 1, true],
  [5, 1, 3, 1, 1, true],
  [6, 1, 4, 1, 1, true],
  [7, 1, 5, 1, 1, true],
  [8, 1, 6, 1, 1, true],
  [2, 2, 1, 1, 1, true],
  [1, 3, 1, 1, 1, true],
];

const SHEETS = {
  Layout:   ['slot', 'row', 'col', 'rowSpan', 'colSpan', 'active'],
  Projects: ['id', 'slot', 'projectName', 'state', 'summaryProgress', 'summaryIssue', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy'],
  Steps:    ['projectId', 'stepNo', 'stepName', 'status', 'startDate', 'endDate', 'owner', 'progress', 'issue', 'fileRequired', 'fileCount', 'fileCheckedAt', 'updatedAt', 'updatedBy'],
  History:  ['at', 'by', 'action', 'projectId', 'stepNo', 'detail'],
};

// ===== Setup =====
function setup() {
  const ss = getDb_();
  Object.keys(SHEETS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    // keep values as plain text (prevents auto date/number conversion)
    if (name !== 'Layout') sh.getRange(1, 1, sh.getMaxRows(), SHEETS[name].length).setNumberFormat('@');
  });
  const layout = ss.getSheetByName('Layout');
  if (layout.getLastRow() === 1) {
    layout.getRange(2, 1, DEFAULT_LAYOUT.length, 6).setValues(DEFAULT_LAYOUT);
  }
  const def = ss.getSheetByName('Sheet1') || ss.getSheetByName('시트1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);
  // touch reference sheet to request permission
  getProjectNames_(true);
  Logger.log('DB: ' + ss.getUrl());
}

function getDb_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('DB_ID');
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (e) { /* recreate below */ }
  }
  const ss = SpreadsheetApp.create('트랙 업무 진행현황 DB');
  props.setProperty('DB_ID', ss.getId());
  return ss;
}

// ===== HTTP =====
function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    switch (p.action) {
      case 'projectNames': return json_({ ok: true, names: getProjectNames_(p.refresh === '1') });
      case 'bootstrap':
      default: return json_(Object.assign({ ok: true }, bootstrap_()));
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

// Frontend posts with Content-Type text/plain to avoid CORS preflight.
function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents || '{}'); } catch (_) {}
  const lock = LockService.getScriptLock();
  try {
    checkKey_(body.key);
    lock.waitLock(20000);
    let result;
    switch (body.action) {
      case 'assign':      result = assign_(body); break;
      case 'saveStep':    result = saveStep_(body); break;
      case 'saveSummary': result = saveSummary_(body); break;
      case 'release':     result = release_(body); break;
      default: throw new Error('Unknown action');
    }
    return json_(Object.assign({ ok: true }, result));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Optional write key: set Script Property WRITE_KEY to require it.
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
    if (name && flag.indexOf(REF_FILTER_TEXT) !== -1 && !seen[name]) {
      seen[name] = true;
      names.push(name);
    }
  });
  try { cache.put('projectNames', JSON.stringify(names), 600); } catch (_) {}
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
  return Utilities.formatDate(d, Session.getScriptTimeZone() || 'Asia/Seoul', 'yyyy-MM-dd');
}
function now_() {
  return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
}

function bootstrap_() {
  const layout = readTable_('Layout')
    .filter(r => r.slot !== '' && String(r.active).toUpperCase() !== 'FALSE')
    .map(r => ({ slot: Number(r.slot), row: Number(r.row), col: Number(r.col), rowSpan: Number(r.rowSpan) || 1, colSpan: Number(r.colSpan) || 1 }));
  const projects = readTable_('Projects').filter(p => p.state === 'active');
  const steps = readTable_('Steps');
  const byProj = {};
  steps.forEach(s => { (byProj[s.projectId] = byProj[s.projectId] || []).push(s); });
  projects.forEach(p => {
    p.steps = (byProj[p.id] || []).sort((a, b) => a.stepNo - b.stepNo).map(s => {
      delete s._row; delete s.projectId; return s;
    });
    delete p._row;
  });
  return { layout, projects, stepDefs: STEPS, statuses: STATUSES, serverTime: now_() };
}

// ===== Write =====
function findRow_(sh, predicate) {
  const vals = sh.getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) if (predicate(vals[i])) return i + 1;
  return -1;
}

function history_(by, action, projectId, stepNo, detail) {
  getDb_().getSheetByName('History').appendRow([now_(), by || '', action, projectId || '', stepNo || '', detail || '']);
}

function assign_(b) {
  const slot = Number(b.slot);
  const name = String(b.projectName || '').trim();
  if (!slot || !name) throw new Error('칸 번호와 프로젝트명이 필요합니다.');
  const ss = getDb_();
  const ps = ss.getSheetByName('Projects');
  const active = readTable_('Projects').filter(p => p.state === 'active');
  if (active.some(p => Number(p.slot) === slot)) throw new Error(slot + '번 칸에 이미 프로젝트가 있습니다.');
  if (active.some(p => p.projectName === name)) throw new Error('이미 다른 칸에 등록된 프로젝트입니다.');
  const id = 'P' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyMMddHHmmss') + Math.floor(Math.random() * 90 + 10);
  const t = now_();
  ps.appendRow([id, slot, name, 'active', '', '', t, b.user || '', t, b.user || '']);
  const rows = STEPS.map(s => [id, s.no, s.name, '대기', '', '', '', '', '', s.file, '', '', '', '']);
  const st = ss.getSheetByName('Steps');
  st.getRange(st.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  history_(b.user, 'assign', id, '', slot + '번 / ' + name);
  return bootstrap_();
}

function saveStep_(b) {
  const ss = getDb_();
  const st = ss.getSheetByName('Steps');
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
  touchProject_(b.projectId, b.user);
  history_(b.user, 'saveStep', b.projectId, b.stepNo, b.status || '');
  return bootstrap_();
}

function saveSummary_(b) {
  const ps = getDb_().getSheetByName('Projects');
  const row = findRow_(ps, r => r[0] === b.projectId);
  if (row < 0) throw new Error('프로젝트를 찾을 수 없습니다.');
  const h = SHEETS.Projects;
  ps.getRange(row, h.indexOf('summaryProgress') + 1, 1, 2).setValues([[b.summaryProgress || '', b.summaryIssue || '']]);
  touchProject_(b.projectId, b.user);
  history_(b.user, 'saveSummary', b.projectId, '', '');
  return bootstrap_();
}

function release_(b) {
  const ps = getDb_().getSheetByName('Projects');
  const row = findRow_(ps, r => r[0] === b.projectId);
  if (row < 0) throw new Error('프로젝트를 찾을 수 없습니다.');
  ps.getRange(row, SHEETS.Projects.indexOf('state') + 1).setValue(b.state === 'removed' ? 'removed' : 'shipped');
  touchProject_(b.projectId, b.user);
  history_(b.user, 'release', b.projectId, '', b.state || 'shipped');
  return bootstrap_();
}

function touchProject_(id, user) {
  const ps = getDb_().getSheetByName('Projects');
  const row = findRow_(ps, r => r[0] === id);
  if (row < 0) return;
  const h = SHEETS.Projects;
  ps.getRange(row, h.indexOf('updatedAt') + 1, 1, 2).setValues([[now_(), user || '']]);
}
