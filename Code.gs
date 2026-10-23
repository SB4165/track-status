/**
 * Track Status Board - Google Apps Script backend (v2)
 * Deploy as Web App: Execute as "Me", Access "Anyone".
 * After updating code: run setup() once (migrates sheets), then Deploy > Manage deployments > edit > New version.
 */

// ===== Config =====
// Reference: BACKLOG STATUS > SYSTEM. Columns are located by header text (row 1), so moving columns is safe.
const REF_SPREADSHEET_ID = '1ez8RBOycLocLfoG9a0scsT6gZTJS-8ZSwmFm9AaV8Vo';
const REF_SHEET_NAME = 'SYSTEM';
const REF_SHEET_GID = 1125892369; // fallback if the tab is renamed
const REF_HEAD = { name: 'PROJECT NO.', type: 'TYPE', ship: 'Factory Out Date' };
const REF_FILTER_TEXT = 'TRACK'; // checked in the TYPE column
// nonconformance (부적합) source: one-way sheet -> web; only rows whose 발주 프로젝트명 matches a track project
const NCR_SPREADSHEET_ID = '1hWRxLYkJfPEBfItSNKv7IFuSOFcLI35b9jCHnKVRBtE';
const NCR_SHEET_NAME = '부적합 처리현황';
const NCR_SHEET_GID = 1615742909;
// header text (normalized, contains) -> field ; qty has no header (column right after 품번)
const NCR_HEAD = [['no', 'NO'], ['done', '처리완료'], ['action', '조치사항'], ['date', '발생일'], ['due', '재납일'], ['project', '발주프로젝트'], ['item', '품명'], ['partNo', '품번'], ['vendor', '귀책업체'], ['defect', '불량(소분류)'], ['finder', '발견자'], ['owner', '담당자'], ['content', '불량내용'], ['note', '비고']];
const NCR_FIELDS = ['action', 'date', 'due', 'project', 'item', 'partNo', 'qty', 'vendor', 'defect', 'finder', 'owner', 'content', 'note'];

const STATUSES = ['대기', '진행', '조치중', '완료', '보류', '생략'];
const DONE_LIKE = ['완료', '생략'];

const STEPS = [
  { no: 1,  name: 'QC검수',                 file: false },
  { no: 2,  name: 'QC검수 조치확인',         file: false },
  { no: 3,  name: 'FAT 셋업',               file: false },
  { no: 4,  name: 'FAT 측정(진동)',          file: true, measure: true },
  { no: 5,  name: 'FAT 측정(반복정밀도)',    file: true, measure: true },
  { no: 6,  name: 'FAT 측정(AWC)',           file: true, measure: true },
  { no: 7,  name: '반복Cycle 촬영',          file: true },
  { no: 8,  name: 'Full Cycle 촬영',         file: true },
  { no: 9,  name: 'X1/X2 핸드레벨 촬영',     file: true },
  { no: 10, name: '물방울 JIG 레벨 촬영',    file: true },
  { no: 11, name: '로봇 배선 해체(제조)',    file: false },
  { no: 12, name: '클리닝(제조)',            file: false },
  { no: 13, name: '패킹리스트 확인',         file: false },
  { no: 14, name: '출하사진 촬영',           file: true },
  { no: 15, name: '패킹 서류 스캔 및 인쇄',  file: true },
  { no: 16, name: '패킹(서류 동봉)',         file: false },
  { no: 17, name: '출하',                   file: false },
];
// STEPS_VERSION history (existing Steps rows migrate automatically, Steps sheet backed up first)
//  v2: inserted 11 (로봇 배선 해체), added 출하완료 at the end
//  v3: inserted 12 (클리닝)
const STEPS_VERSION = '4'; // v4: step 17 renamed 출하완료 -> 출하 (names refreshed by migration)

// Floor plan on a 1000-wide canvas (height = lowest item + margin) (same orientation as the CAD drawing).
// slot label = dedicated equipment types for that position (comma separated, shown for reference)
// type: slot (equipment) | pack (packing area, step>=PACK_MIN_STEP only) | wall | fixture | label | door | note | spec (robot spec table)
// LAYOUT_VERSION: bump to rebuild the Layout sheet from DEFAULT_LAYOUT on next setup()
const LAYOUT_VERSION = '9';
const PACK_MIN_STEP = 12; // 클리닝(제조)
// Edit the "Layout" sheet to relocate; set active=FALSE to hide a row.
const LAYOUT_HEAD = ['id', 'type', 'slot', 'label', 'x', 'y', 'w', 'h', 'active'];
const DEFAULT_LAYOUT = [
  ['wall-top',  'wall',    '', '',                         40,   6, 952,  18, true],
  ['wall-left', 'wall',    '', '',                           8, 235,  24, 402, true],
  ['slot-3',    'slot',     3, 'MPR, EMR, ITR',            40,  30, 152, 195, true],
  ['slot-4',    'slot',     4, 'STR, ESR',               200,  30, 152, 195, true],
  ['slot-5',    'slot',     5, 'STR, ESR',               360,  30, 152, 195, true],
  ['slot-6',    'slot',     6, 'MPR',                    520,  30, 152, 195, true],
  ['slot-7',    'slot',     7, 'ITR, EMR',               680,  30, 152, 195, true],
  ['slot-8',    'slot',     8, 'FER',                    840,  30, 152, 195, true],
  ['slot-2',    'slot',     2, 'MPR, ITR',                 40, 235, 192, 185, true],
  ['slot-1',    'slot',     1, 'MPR',                      40, 426, 192, 185, true],
  ['door-1',    'door',    '', '출입문',                   40, 617, 192,  20, true],
  ['pack-1',    'pack',     9, '패킹 1',                 244, 235, 140, 190, true],
  ['pack-2',    'pack',    10, '패킹 2',                 392, 235, 140, 190, true],
  ['pack-3',    'pack',    11, '패킹 3',                 540, 235, 140, 190, true],
  ['pack-4',    'pack',    12, '패킹 4',                 688, 235, 140, 190, true],
  ['pack-5',    'pack',    13, '패킹 5',                 244, 433, 140, 190, true],
  ['pack-6',    'pack',    14, '패킹 6',                 392, 433, 140, 190, true],
  ['pack-7',    'pack',    15, '패킹 7',                 540, 433, 140, 190, true],
  ['pack-8',    'pack',    16, '패킹 8',                 688, 433, 140, 190, true],
  ['note-1',    'note',    '', '기타사항',               840, 235, 152, 190, true],
  ['spec-1',    'spec',    '', 'TRACK IMMERSION robot specification', 840, 433, 152, 190, true],
];

const SHEETS = {
  Layout:   LAYOUT_HEAD,
  Projects: ['id', 'slot', 'projectName', 'state', 'summaryProgress', 'summaryIssue', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy'],
  Steps:    ['projectId', 'stepNo', 'stepName', 'status', 'startDate', 'endDate', 'owner', 'progress', 'issue', 'fileRequired', 'fileCount', 'fileCheckedAt', 'updatedAt', 'updatedBy'],
  Notes:    ['id', 'content', 'updatedAt', 'updatedBy', 'style'],
  Measures: ['projectId', 'stepNo', 'x1', 'x2', 'updatedAt', 'updatedBy'],
  History:  ['at', 'by', 'action', 'projectId', 'projectName', 'slot', 'stepNo', 'stepName', 'status', 'startDate', 'endDate', 'owner', 'progress', 'issue', 'detail'],
  SyncState: ['name', 'state', 'at', 'by'],
  Ncr:      ['no', 'done', 'action', 'date', 'due', 'project', 'item', 'partNo', 'qty', 'vendor', 'defect', 'finder', 'owner', 'content', 'note', 'syncedAt', 'updatedAt', 'updatedBy'],
};

const ACTION_LABEL = {
  create: '프로젝트 등록', setSlot: '배치 변경', saveStep: '공정 저장', saveSummary: '요약 저장',
  shipped: '출하 완료', removed: '삭제', restore: '복원', note: '기타사항 수정', edit: '프로젝트명 수정', skip: '시작 공정 지정',
  sync: '참조 동기화', unsync: '동기화 취소', exclude: '동기화 제외', include: '제외 해제', steps: '공정 목록 변경', layout: '배치도 변경', measure: '측정값 저장', ncrSync: '부적합 동기화', ncrDone: '부적합 처리완료', ncrUndone: '부적합 처리완료 해제',
};

// ===== Setup / migration (safe to run repeatedly) =====
function setup() {
  const ss = getDb_();
  Object.keys(SHEETS).forEach(name => {
    let sh = ss.getSheetByName(name);
    const head = SHEETS[name];
    if (name === 'Notes' && sh && sh.getLastRow() > 0 && String(sh.getRange(1, 5).getValue()) === '') sh.getRange(1, 5).setValue('style');
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
    migrate_();
    switch (p.action) {
      case 'projectNames': return json_({ ok: true, names: getProjectNames_(p.refresh === '1') });
      case 'history':      return json_({ ok: true, rows: getHistory_(p) });
      case 'refRows':      return json_({ ok: true, rows: getRefRows_(p.refresh === '1'), serverTime: now_() });
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
    migrate_();
    checkKey_(body.key);
    if (body.action === 'checkKey') return json_({ ok: true });
    lock.waitLock(20000);
    let result;
    switch (body.action) {
      case 'createProject': result = createProject_(body); break;
      case 'setSlot':       result = setSlot_(body); break;
      case 'saveStep':      result = saveStep_(body); break;
      case 'saveMeasure':   result = saveMeasure_(body); break;
      case 'saveSummary':   result = saveSummary_(body); break;
      case 'release':       result = release_(body); break;
      case 'restore':       result = restore_(body); break;
      case 'saveNote':      result = saveNote_(body); break;
      case 'updateProject': result = updateProject_(body); break;
      case 'skipTo':        result = skipTo_(body); break;
      case 'bulkSkipTo':    result = bulkSkipTo_(body); break;
      case 'syncProjects':  result = syncProjects_(body); break;
      case 'unsync':        result = unsync_(body); break;
      case 'exclude':       result = exclude_(body); break;
      case 'syncNcr':       result = syncNcr_(body); break;
      case 'setNcrDone':    result = setNcrDone_(body); break;
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
  if (k && key !== k) throw new Error('비밀번호가 올바르지 않습니다.');
}

// ===== Reference: project names =====
function getProjectNames_(refresh) {
  return getRefRows_(refresh).map(r => r.name);
}

// Reference rows: { no (sheet order), name, type, ship } where TYPE contains TRACK
function getRefRows_(refresh) {
  const cache = CacheService.getScriptCache();
  if (!refresh) {
    const hit = cache.get('refRows3');
    if (hit) return JSON.parse(hit);
  }
  const ref = SpreadsheetApp.openById(REF_SPREADSHEET_ID);
  const sh = ref.getSheetByName(REF_SHEET_NAME) || ref.getSheets().find(s => s.getSheetId() === REF_SHEET_GID);
  if (!sh) throw new Error('참조 시트(' + REF_SHEET_NAME + ')를 찾을 수 없습니다.');
  const last = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (last < 2) return [];
  // find the header row (first 10 rows) and the columns by header text
  const norm = v => String(v || '').replace(/\s+/g, ' ').trim().toUpperCase();
  const top = sh.getRange(1, 1, Math.min(10, last), lastCol).getDisplayValues();
  let hr = -1, col = {};
  for (let i = 0; i < top.length && hr < 0; i++) {
    const row = top[i].map(norm);
    const c = {};
    Object.keys(REF_HEAD).forEach(k => { c[k] = row.indexOf(norm(REF_HEAD[k])); });
    if (c.name >= 0 && c.type >= 0) { hr = i; col = c; }
  }
  if (hr < 0) throw new Error('참조 시트에서 "' + REF_HEAD.name + '" / "' + REF_HEAD.type + '" 헤더를 찾을 수 없습니다.');
  const n = last - (hr + 1);
  if (n < 1) return [];
  const read = c => c >= 0 ? sh.getRange(hr + 2, c + 1, n, 1).getDisplayValues().map(r => String(r[0] || '').trim()) : [];
  const names = read(col.name), types = read(col.type), ships = read(col.ship);
  const seen = {};
  const rows = [];
  names.forEach((name, i) => {
    const type = types[i] || '';
    if (!name || type.toUpperCase().indexOf(REF_FILTER_TEXT) === -1 || seen[name]) return;
    seen[name] = true;
    rows.push({ no: rows.length + 1, name: name, type: type, ship: ships[i] || '' });
  });
  try { cache.put('refRows3', JSON.stringify(rows), 600); } catch (_) { /* too large */ }
  return rows;
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
  const meas = {};
  if (getDb_().getSheetByName('Measures')) readTable_('Measures').forEach(m => { meas[m.projectId + '|' + Number(m.stepNo)] = m; });
  readTable_('Steps').forEach(s => {
    const m = meas[s.projectId + '|' + Number(s.stepNo)];
    if (m) { s.x1 = String(m.x1 === undefined ? '' : m.x1); s.x2 = String(m.x2 === undefined ? '' : m.x2); }
    (byProj[s.projectId] = byProj[s.projectId] || []).push(s);
  });
  projects.forEach(p => {
    p.slot = p.slot === '' ? null : Number(p.slot);
    p.steps = (byProj[p.id] || []).sort((a, b) => Number(a.stepNo) - Number(b.stepNo)).map(s => {
      delete s._row; delete s.projectId; s.stepNo = Number(s.stepNo); return s;
    });
    delete p._row;
  });
  const notes = {};
  readTable_('Notes').forEach(n => { notes[n.id] = { content: String(n.content || ''), updatedAt: n.updatedAt, updatedBy: n.updatedBy, style: String(n.style || '') }; });
  const keyRequired = !!PropertiesService.getScriptProperties().getProperty('WRITE_KEY');
  const syncExcluded = getDb_().getSheetByName('SyncState') ? readTable_('SyncState').filter(r => r.state === 'excluded').map(r => String(r.name)) : [];
  const ncr = getDb_().getSheetByName('Ncr') ? readTable_('Ncr').filter(r => String(r.no) !== '').map(r => {
    const o = { no: String(r.no), done: r.done === true || String(r.done).toUpperCase() === 'TRUE' };
    NCR_FIELDS.concat(['syncedAt', 'updatedAt', 'updatedBy']).forEach(f => { o[f] = String(r[f] === undefined ? '' : r[f]); });
    return o;
  }) : [];
  const ncrSyncedAt = PropertiesService.getScriptProperties().getProperty('NCR_SYNCED_AT') || '';
  return { layout, projects, notes, keyRequired, syncExcluded, ncr, ncrSyncedAt, stepDefs: STEPS, statuses: STATUSES, serverTime: now_() };
}

function getHistory_(p) {
  const from = String(p.from || '');
  const to = String(p.to || '');
  const pid = String(p.projectId || '');
  const acts = String(p.actions || '').split(',').filter(String);
  return readTable_('History').filter(r => {
    if (acts.length && acts.indexOf(String(r.action)) === -1) return false;
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
  appendText_(getDb_().getSheetByName('History'), histArr_(by, action, proj, step, detail));
}
function histArr_(by, action, proj, step, detail) {
  const h = SHEETS.History;
  const o = {
    at: now_(), by: by || '', action: action,
    projectId: proj ? proj.id : '', projectName: proj ? proj.projectName : '', slot: proj ? proj.slot : '',
    stepNo: step ? step.stepNo : '', stepName: step ? step.stepName : '', status: step ? step.status : '',
    startDate: step ? step.startDate : '', endDate: step ? step.endDate : '', owner: step ? step.owner : '',
    progress: step ? step.progress : '', issue: step ? step.issue : '', detail: detail || '',
  };
  return h.map(k => (o[k] === undefined || o[k] === null) ? '' : String(o[k]));
}
function appendRowsText_(sh, rows) {
  if (!rows.length) return;
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setNumberFormat('@').setValues(rows);
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
  const cur = steps.find(s => DONE_LIKE.indexOf(s.status) === -1);
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
  const ss = getDb_();
  const ps = ss.getSheetByName('Projects');
  const active = readTable_('Projects').filter(p => p.state === 'active');
  if (active.some(p => p.projectName === name)) throw new Error('이미 등록된 진행중 프로젝트입니다.');
  const start = Math.min(Math.max(Number(b.startStep) || 1, 1), STEPS.length);
  const ship = start >= STEPS.length; // 출하완료 = shipped right away (not placed)
  const slot = b.slot && !ship ? Number(b.slot) : '';
  if (slot && isPackSlot_(slot) && start < PACK_MIN_STEP) throw packError_();
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
  appendText_(ps, [id, slot, name, ship ? 'shipped' : 'active', '', '', t, b.user || '', t, b.user || '']);
  const rows = STEPS.map(s => [id, s.no, s.name, startDone_(s.no, start) ? '완료' : '대기', '', '', '', '', '', s.file, '', '', '', '']);
  const st = ss.getSheetByName('Steps');
  st.getRange(st.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  history_(b.user, 'create', { id: id, projectName: name, slot: slot }, null, (slot ? slot + '번 배치' : '미배치') + (ship ? ' / 출하완료로 등록' : start > 1 ? ' / ' + start + '번 공정부터 시작 (이전 공정 완료 처리)' : ''));
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

// FAT measurement values (X1/X2) per project step — Measures sheet (created on first save)
function saveMeasure_(b) {
  const items = Array.isArray(b.items) ? b.items : [];
  if (!b.projectId || !items.length) throw new Error('측정값이 없습니다.');
  const ss = getDb_();
  let sh = ss.getSheetByName('Measures');
  if (!sh) {
    sh = ss.insertSheet('Measures');
    sh.getRange(1, 1, 1, SHEETS.Measures.length).setValues([SHEETS.Measures]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  const t = now_();
  const prow = projectRow_(b.projectId);
  const proj = rowObj_('Projects', prow);
  const det = [];
  items.forEach(it => {
    const no = Number(it.stepNo); const def = STEPS[no - 1];
    if (!def || !def.measure) return;
    const vals = [String(b.projectId), String(no), String(it.x1 == null ? '' : it.x1).trim(), String(it.x2 == null ? '' : it.x2).trim(), t, b.user || ''];
    const row = findRow_(sh, r => String(r[0]) === String(b.projectId) && Number(r[1]) === no);
    if (row < 0) appendText_(sh, vals); else sh.getRange(row, 1, 1, vals.length).setNumberFormat('@').setValues([vals]);
    det.push(no + '. ' + def.name + ' X1=' + (vals[2] || '-') + ', X2=' + (vals[3] || '-'));
  });
  touchProject_(prow, b.user);
  history_(b.user, 'measure', proj, null, det.join(' / '));
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

// mark an active project as shipped (slot cleared) — used when its current step is set to 출하완료
function shipRow_(row, user) {
  const ps = getDb_().getSheetByName('Projects');
  const proj = rowObj_('Projects', row);
  if (proj.state !== 'active') return;
  ps.getRange(row, 2).setValue('');
  ps.getRange(row, SHEETS.Projects.indexOf('state') + 1).setValue('shipped');
  history_(user, 'shipped', proj, null, '출하완료 공정 지정' + (proj.slot ? ' / ' + proj.slot + '번 비움' : ''));
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
  if (String(sh.getRange(1, 5).getValue()) !== 'style') sh.getRange(1, 5).setValue('style'); // text size/weight column
  const row = findRow_(sh, r => r[0] === id);
  const vals = [[id, String(b.content || ''), now_(), b.user || '', String(b.style || '')]];
  if (row < 0) appendText_(sh, vals[0]); else sh.getRange(row, 1, 1, 5).setNumberFormat('@').setValues(vals);
  history_(b.user, 'note', null, null, id + ': ' + String(b.content || '').replace(/^<!--rt-->/, '').replace(/<br\s*\/?>|<\/div>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  return bootstrap_();
}

// steps before stepNo: not completed -> 완료 (work done, records just not entered) ; steps from stepNo: 생략 -> 대기
// a step counts as done when it is before the start step; starting at the last step (출하완료) means everything is done
function startDone_(no, start) { return no < start || start >= STEPS.length; }
function skipDetail_(n) { return n >= STEPS.length ? n + '. ' + STEPS[STEPS.length - 1].name + ' (전 공정 완료 처리, 출하완료로 이동)' : n + '번 공정부터 진행 (이전 공정 완료 처리)'; }
function applySkip_(st, vals, pid, n) {
  const si = SHEETS.Steps.indexOf('status');
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][0]) !== String(pid)) continue;
    const no = Number(vals[i][1]); const s = vals[i][si];
    let ns = s;
    if (startDone_(no, n) && s !== '완료' && s !== '생략') ns = '완료';
    if (!startDone_(no, n) && s === '생략') ns = '대기';
    if (ns !== s) { st.getRange(i + 1, si + 1, 1, 1).setNumberFormat('@').setValue(ns); vals[i][si] = ns; }
  }
}
function skipTo_(b) {
  const n = Number(b.stepNo);
  if (!n) throw new Error('시작 공정이 필요합니다.');
  const st = getDb_().getSheetByName('Steps');
  applySkip_(st, st.getDataRange().getValues(), b.projectId, n);
  const prow = projectRow_(b.projectId);
  touchProject_(prow, b.user);
  history_(b.user, 'skip', rowObj_('Projects', prow), null, skipDetail_(n));
  if (n >= STEPS.length) shipRow_(prow, b.user);
  return bootstrap_();
}
// apply the same current step to several projects at once
function bulkSkipTo_(b) {
  const n = Number(b.stepNo);
  const ids = Array.isArray(b.projectIds) ? b.projectIds.map(String) : [];
  if (!n || !ids.length) throw new Error('대상과 공정이 필요합니다.');
  const st = getDb_().getSheetByName('Steps');
  const vals = st.getDataRange().getValues();
  ids.forEach(pid => {
    let prow;
    try { prow = projectRow_(pid); } catch (_) { return; }
    applySkip_(st, vals, pid, n);
    touchProject_(prow, b.user);
    history_(b.user, 'skip', rowObj_('Projects', prow), null, '일괄 지정: ' + skipDetail_(n));
    if (n >= STEPS.length) shipRow_(prow, b.user);
  });
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

// ===== Sync tab (reference sheet -> Projects) =====
function syncSheet_() {
  const ss = getDb_();
  let sh = ss.getSheetByName('SyncState');
  if (!sh) {
    sh = ss.insertSheet('SyncState');
    sh.getRange(1, 1, 1, SHEETS.SyncState.length).setValues([SHEETS.SyncState]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

// items: [{ name, startStep, slot }] ; existing names are skipped, unusable slots fall back to 미배치
function syncProjects_(b) {
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) throw new Error('동기화할 프로젝트가 없습니다.');
  const ss = getDb_();
  const all = readTable_('Projects').filter(p => p.state === 'active' || p.state === 'shipped');
  const taken = {};
  const occ = {};
  all.forEach(p => { taken[p.projectName] = true; if (p.state === 'active' && p.slot !== '') occ[Number(p.slot)] = true; });
  const user = b.user || '';
  const t = now_();
  const base = 'P' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyMMddHHmmss');
  const pRows = [], sRows = [], hRows = [], skipped = [];
  items.forEach((it, k) => {
    const name = String(it.name || '').trim();
    if (!name) return;
    if (taken[name]) { skipped.push(name); return; }
    taken[name] = true;
    const start = Math.min(Math.max(Number(it.startStep) || 1, 1), STEPS.length);
    const ship = start >= STEPS.length;
    let slot = it.slot && !ship ? Number(it.slot) : '';
    let note = ship ? ' / 출하완료로 등록' : '';
    if (slot && (occ[slot] || (isPackSlot_(slot) && start < PACK_MIN_STEP))) { note = ' (' + slot + '번 배치 불가 → 미배치)'; slot = ''; }
    if (slot) occ[slot] = true;
    const id = base + ('00' + k).slice(-3) + Math.floor(Math.random() * 90 + 10);
    pRows.push([id, String(slot), name, ship ? 'shipped' : 'active', '', '', t, user, t, user]);
    STEPS.forEach(s => sRows.push([id, s.no, s.name, startDone_(s.no, start) ? '완료' : '대기', '', '', '', '', '', s.file, '', '', '', '']));
    hRows.push(histArr_(user, 'sync', { id: id, projectName: name, slot: slot }, null,
      '참조 시트 동기화 · ' + (slot ? slot + '번 배치' : '미배치') + (start > 1 ? ' / ' + start + '번 공정부터 시작 (이전 공정 완료 처리)' : '') + note));
  });
  if (pRows.length) {
    appendRowsText_(ss.getSheetByName('Projects'), pRows);
    const st = ss.getSheetByName('Steps');
    st.getRange(st.getLastRow() + 1, 1, sRows.length, sRows[0].length).setValues(sRows);
    appendRowsText_(ss.getSheetByName('History'), hRows);
  }
  return Object.assign(bootstrap_(), { syncResult: { created: pRows.length, skipped: skipped } });
}

// cancel sync = remove the (active) projects from the board/management list; history is kept
function unsync_(b) {
  const ids = Array.isArray(b.projectIds) ? b.projectIds.map(String) : [];
  if (!ids.length) throw new Error('취소할 프로젝트가 없습니다.');
  const ss = getDb_();
  const ps = ss.getSheetByName('Projects');
  const si = SHEETS.Projects.indexOf('state') + 1;
  const hRows = [];
  readTable_('Projects').forEach(p => {
    if (ids.indexOf(String(p.id)) === -1 || p.state !== 'active') return;
    ps.getRange(p._row, 2).setValue('');
    ps.getRange(p._row, si).setValue('removed');
    touchProject_(p._row, b.user);
    hRows.push(histArr_(b.user, 'unsync', p, null, p.slot !== '' ? p.slot + '번 비움' : ''));
  });
  appendRowsText_(ss.getSheetByName('History'), hRows);
  return bootstrap_();
}

// exclude (on=true) / include (on=false) reference rows from the sync list
function exclude_(b) {
  const names = Array.isArray(b.names) ? b.names.map(n => String(n).trim()).filter(String) : [];
  if (!names.length) throw new Error('대상이 없습니다.');
  const on = b.on !== false;
  const sh = syncSheet_();
  const cur = {};
  readTable_('SyncState').forEach(r => { cur[String(r.name)] = r._row; });
  const t = now_();
  const add = [], del = [], hRows = [];
  names.forEach(n => {
    if (on) {
      if (cur[n]) sh.getRange(cur[n], 2, 1, 3).setValues([['excluded', t, b.user || '']]);
      else add.push([n, 'excluded', t, b.user || '']);
    } else if (cur[n]) del.push(cur[n]);
    hRows.push(histArr_(b.user, on ? 'exclude' : 'include', { id: '', projectName: n, slot: '' }, null, ''));
  });
  appendRowsText_(sh, add);
  del.sort((x, y) => y - x).forEach(r => sh.deleteRow(r));
  appendRowsText_(getDb_().getSheetByName('History'), hRows);
  return bootstrap_();
}

// ===== Nonconformance (부적합 처리현황) =====
function ncrSheet_() {
  const ss = getDb_();
  let sh = ss.getSheetByName('Ncr');
  if (!sh) {
    sh = ss.insertSheet('Ncr');
    sh.getRange(1, 1, 1, SHEETS.Ncr.length).setValues([SHEETS.Ncr]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
const ncrNorm_ = (v) => String(v || '').replace(/\s+/g, '').toUpperCase();
// read the source tab (hidden rows included: getValues ignores row visibility); header row found by text
function readNcrSource_() {
  const src = SpreadsheetApp.openById(NCR_SPREADSHEET_ID);
  const sh = src.getSheetByName(NCR_SHEET_NAME) || src.getSheets().filter(x => x.getSheetId() === NCR_SHEET_GID)[0];
  if (!sh) throw new Error('부적합 시트(' + NCR_SHEET_NAME + ')를 찾을 수 없습니다.');
  const vals = sh.getDataRange().getDisplayValues();
  let hr = -1;
  for (let i = 0; i < Math.min(vals.length, 10); i++) { if (vals[i].some(c => ncrNorm_(c).indexOf('발주프로젝트') !== -1)) { hr = i; break; } }
  if (hr < 0) throw new Error('부적합 시트에서 "발주 프로젝트 명" 헤더를 찾을 수 없습니다.');
  const head = vals[hr].map(ncrNorm_);
  const col = {};
  NCR_HEAD.forEach(([f, t]) => { const k = head.findIndex(h => h.indexOf(ncrNorm_(t)) !== -1); if (k !== -1) col[f] = k; });
  if (col.no === undefined) col.no = 0;
  if (col.done === undefined) col.done = col.no + 1;
  if (col.partNo !== undefined) col.qty = col.partNo + 1;
  if (col.project === undefined) throw new Error('발주 프로젝트 명 열을 찾을 수 없습니다.');
  return vals.slice(hr + 1).map(r => {
    const o = {};
    Object.keys(col).forEach(f => { o[f] = String(r[col[f]] === undefined ? '' : r[col[f]]).trim(); });
    return o;
  }).filter(o => o.no && o.project);
}
// one-way sync: new NO -> append; existing NO -> keep web values, only fill blank fields (done is never overwritten)
function syncNcr_(b) {
  const names = {};
  readTable_('Projects').filter(p => p.state === 'active' || p.state === 'shipped').forEach(p => { names[ncrNorm_(p.projectName)] = true; });
  const rows = readNcrSource_().filter(o => names[ncrNorm_(o.project)]);
  const sh = ncrSheet_();
  const cur = {};
  readTable_('Ncr').forEach(r => { cur[String(r.no)] = r; });
  const t = now_();
  const user = b.user || '';
  const add = [];
  let filled = 0;
  rows.forEach(o => {
    const ex = cur[o.no];
    if (!ex) {
      add.push(SHEETS.Ncr.map(h => h === 'done' ? (String(o.done).toUpperCase() === 'TRUE' ? 'TRUE' : 'FALSE') : h === 'syncedAt' ? t : (h === 'updatedAt' || h === 'updatedBy') ? '' : (o[h] || '')));
      cur[o.no] = true;
      return;
    }
    if (ex === true) return;
    const patch = NCR_FIELDS.filter(f => String(ex[f] === undefined ? '' : ex[f]) === '' && o[f]);
    if (!patch.length) return;
    patch.forEach(f => sh.getRange(ex._row, SHEETS.Ncr.indexOf(f) + 1).setNumberFormat('@').setValue(o[f]));
    filled++;
  });
  appendRowsText_(sh, add);
  PropertiesService.getScriptProperties().setProperty('NCR_SYNCED_AT', t);
  appendRowsText_(getDb_().getSheetByName('History'), [histArr_(user, 'ncrSync', { id: '', projectName: '', slot: '' }, null, '신규 ' + add.length + '건 / 빈 칸 보완 ' + filled + '건')]);
  return Object.assign(bootstrap_(), { ncrResult: { added: add.length, filled: filled, matched: rows.length } });
}
function setNcrDone_(b) {
  const nos = Array.isArray(b.nos) ? b.nos.map(String) : [];
  if (!nos.length) throw new Error('대상이 없습니다.');
  const on = b.done !== false;
  const sh = ncrSheet_();
  const t = now_();
  const hRows = [];
  readTable_('Ncr').forEach(r => {
    if (nos.indexOf(String(r.no)) === -1) return;
    sh.getRange(r._row, 2).setValue(on ? 'TRUE' : 'FALSE');
    sh.getRange(r._row, SHEETS.Ncr.indexOf('updatedAt') + 1, 1, 2).setNumberFormat('@').setValues([[t, b.user || '']]);
    hRows.push(histArr_(b.user, on ? 'ncrDone' : 'ncrUndone', { id: '', projectName: r.project, slot: '' }, null, 'NO ' + r.no + ' · ' + (r.item || '') + ' · ' + (r.content || '')));
  });
  appendRowsText_(getDb_().getSheetByName('History'), hRows);
  return bootstrap_();
}

// ===== Migrations (run once per version, lazily from doGet/doPost; sheets backed up first) =====
function migrate_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('STEPS_VERSION') === STEPS_VERSION && props.getProperty('LAYOUT_VERSION') === LAYOUT_VERSION) return;
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const stamp = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyMMddHHmm');
    if (props.getProperty('STEPS_VERSION') !== STEPS_VERSION) { migrateSteps_(stamp); props.setProperty('STEPS_VERSION', STEPS_VERSION); }
    if (props.getProperty('LAYOUT_VERSION') !== LAYOUT_VERSION) { migrateLayout_(stamp); props.setProperty('LAYOUT_VERSION', LAYOUT_VERSION); }
  } finally {
    lock.releaseLock();
  }
}

// rebuild the Layout sheet from DEFAULT_LAYOUT (project slots are kept: they are stored on Projects)
function migrateLayout_(stamp) {
  const ss = getDb_();
  const sh = ss.getSheetByName('Layout');
  if (!sh) return;
  if (sh.getLastRow() > 1) sh.copyTo(ss).setName('Layout_bak_' + stamp);
  sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), LAYOUT_HEAD.length).clearContent();
  sh.getRange(2, 1, DEFAULT_LAYOUT.length, LAYOUT_HEAD.length).setValues(DEFAULT_LAYOUT);
  history_('system', 'layout', null, null, '배치도 변경 (LAYOUT_VERSION ' + LAYOUT_VERSION + ', 백업 시트 생성)');
}

// step-list migration by row count: 14 (v1) -> 16 (v2) -> 17 (v3); every run also refreshes step names/file flags (v4 rename)
function migrateSteps_(stamp) {
  const ss = getDb_();
  const sh = ss.getSheetByName('Steps');
  const h = SHEETS.Steps;
  const I = k => h.indexOf(k);
  const vals = sh.getDataRange().getValues();
  vals.shift();
  if (!vals.length) return;
  sh.copyTo(ss).setName('Steps_bak_' + stamp);
  const pState = {};
  readTable_('Projects').forEach(p => { pState[String(p.id)] = p.state; });
  const byP = {}, order = [];
  vals.forEach(r => {
    const id = String(r[0] || '');
    if (!id) return;
    if (!byP[id]) { byP[id] = []; order.push(id); }
    byP[id].push(r.slice(0, h.length));
  });
  const blank = (id, no, status) => { const r = h.map(() => ''); r[0] = id; r[I('stepNo')] = no; r[I('status')] = status; return r; };
  // insert a new step at position k: later steps shift by one; new step is 완료 if any later step already started
  const insertAt = (id, rows, k) => {
    let after = pState[id] === 'shipped';
    rows.forEach(r => {
      const no = Number(r[I('stepNo')]);
      if (no >= k) { r[I('stepNo')] = no + 1; if (String(r[I('status')]) !== '대기') after = true; }
    });
    rows.push(blank(id, k, after ? '완료' : '대기'));
  };
  const out = [];
  order.forEach(id => {
    const rows = byP[id];
    if (rows.length === 14) { // v1 -> v2
      insertAt(id, rows, 11);
      rows.push(blank(id, 16, pState[id] === 'shipped' ? '완료' : '대기'));
    }
    if (rows.length === 16) insertAt(id, rows, 12); // v2 -> v3
    rows.sort((a, b) => Number(a[I('stepNo')]) - Number(b[I('stepNo')]));
    rows.forEach(r => {
      const d = STEPS[Number(r[I('stepNo')]) - 1];
      if (d) { r[I('stepName')] = d.name; r[I('fileRequired')] = d.file; }
      out.push(r.map(v => v instanceof Date ? fmtDate_(v) : (v === null || v === undefined ? '' : String(v))));
    });
  });
  sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), h.length).clearContent();
  sh.getRange(2, 1, out.length, h.length).setNumberFormat('@').setValues(out);
  history_('system', 'steps', null, null, '공정 목록 갱신 (STEPS_VERSION ' + STEPS_VERSION + ', 백업 시트 생성)');
}
