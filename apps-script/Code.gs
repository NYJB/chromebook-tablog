/**
 * 탭 기록 - 구글 시트 수신용 Apps Script
 * 이 스크립트는 기록을 받을 구글 시트의 [확장 프로그램 > Apps Script]에 붙여 넣는다.
 *
 * 시트 구성
 *  - "기록": 시간 | 학생 | 사이트 | 제목   (자동 생성)
 *  - "명단": 이메일 | 표시 이름(예: 07 홍길동)   (선생님이 채움. 여기 있는 학생만 받음)
 */

const LOG_SHEET = '기록';
const ROSTER_SHEET = '명단';
const KEEP_DAYS = 14;               // 이 기간이 지난 기록은 매일 지움
const MAX_EVENTS = 150;             // 한 번에 받는 최대 건수
const MAX_REQ_PER_10MIN = 6;        // 학생 한 명이 10분에 보낼 수 있는 요청 수
const TZ = 'Asia/Seoul';

// ---------- 메뉴 ----------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('탭 기록')
    .addItem('처음 설정하기', 'setup')
    .addItem('토큰 보기', 'showToken')
    .addItem('토큰 새로 만들기', 'resetToken')
    .addItem('오래된 기록 지금 지우기', 'cleanup')
    .addToUi();
}

function setup() {
  const ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone(TZ);

  let log = ss.getSheetByName(LOG_SHEET);
  if (!log) log = ss.insertSheet(LOG_SHEET);
  if (log.getLastRow() === 0) {
    log.appendRow(['시간', '학생', '사이트', '제목']);
    log.setFrozenRows(1);
    log.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm');
    // 제목이 "1/2", "2024" 같아도 날짜·숫자로 바뀌지 않게 일반 텍스트로 둔다
    log.getRange('B:D').setNumberFormat('@');
    log.setColumnWidth(1, 140);
    log.setColumnWidth(2, 120);
    log.setColumnWidth(3, 160);
    log.setColumnWidth(4, 480);
  }
  // 빈 열은 셀 수 한도에 포함되므로 지운다
  if (log.getMaxColumns() > 4) log.deleteColumns(5, log.getMaxColumns() - 4);

  let roster = ss.getSheetByName(ROSTER_SHEET);
  if (!roster) roster = ss.insertSheet(ROSTER_SHEET);
  if (roster.getLastRow() === 0) {
    roster.appendRow(['이메일', '표시 이름']);
    roster.setFrozenRows(1);
    roster.setColumnWidth(1, 260);
  }

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TOKEN')) props.setProperty('TOKEN', newToken_());

  // 매일 오래된 기록 지우기 트리거 (중복 생성 방지)
  const has = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'cleanup';
  });
  // 스크립트 프로젝트 시간대가 서울이 아니어도 18시(서울)에 돌게 한다
  if (!has) ScriptApp.newTrigger('cleanup').timeBased().everyDays(1).atHour(18).inTimezone(TZ).create();

  SpreadsheetApp.getUi().alert(
    '설정 완료\n\n' +
    '1) "명단" 시트에 반 학생의 학교 이메일과 표시 이름을 적으세요.\n' +
    '2) 배포 > 새 배포 > 웹 앱 으로 배포하세요.\n' +
    '3) 메뉴 "탭 기록 > 토큰 보기"의 값을 관리 콘솔 설정에 넣으세요.'
  );
}

function showToken() {
  const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  SpreadsheetApp.getUi().alert(token ? '토큰:\n\n' + token : '먼저 "처음 설정하기"를 실행하세요.');
}

function resetToken() {
  const ui = SpreadsheetApp.getUi();
  const ok = ui.alert('토큰을 새로 만들면 관리 콘솔 설정도 바꿔야 합니다. 계속할까요?', ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;
  PropertiesService.getScriptProperties().setProperty('TOKEN', newToken_());
  showToken();
}

function newToken_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

// ---------- 받기 ----------

function doGet() {
  return json_({ ok: true, service: 'tablog' });
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents || e.postData.contents.length > 60000) {
      return json_({ ok: false, drop: true, error: 'bad_request' });
    }
    let body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (err) {
      return json_({ ok: false, drop: true, error: 'bad_json' });
    }

    // 1) 누가 보냈는지 정한다.
    //    'Anyone within 도메인'으로 배포했다면 구글이 확인한 이메일을 쓰고,
    //    'Anyone'으로 배포했다면 토큰이 맞을 때만 확장 프로그램이 보낸 이메일을 믿는다.
    let email = '';
    try { email = Session.getActiveUser().getEmail() || ''; } catch (err) { email = ''; }
    if (!email) {
      const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
      if (!token || body.token !== token) return json_({ ok: false, error: 'auth' });
      email = String(body.email || '');
    }
    email = email.toLowerCase().trim();

    // 2) 명단에 있는 학생만 받는다
    const label = rosterLabel_(email);
    if (!label) return json_({ ok: false, drop: true, error: 'not_in_roster' });

    // 3) 지나치게 잦은 요청은 거절
    const cache = CacheService.getScriptCache();
    const rk = 'r:' + email;
    const count = Number(cache.get(rk) || 0);
    if (count >= MAX_REQ_PER_10MIN) return json_({ ok: false, error: 'rate' });
    cache.put(rk, String(count + 1), 600);

    // 4) 같은 묶음을 두 번 받으면 무시 (응답이 끊겨 다시 보낸 경우)
    const batchId = String(body.batchId || '').slice(0, 64);
    if (batchId && cache.get('b:' + batchId)) return json_({ ok: true, dup: true });

    // 5) 내용 검사
    const events = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS) : [];
    const now = Date.now();
    const rows = [];
    events.forEach(function (ev) {
      const t = Number(ev && ev.t);
      const d = String((ev && ev.d) || '').toLowerCase().slice(0, 100);
      const ti = String((ev && ev.ti) || '').trim().slice(0, 150);
      if (!isFinite(t) || t < now - 3 * 86400000 || t > now + 10 * 60000) return;
      if (!/^[a-z0-9][a-z0-9.-]*$/.test(d)) return;
      rows.push([new Date(t), safeText_(label), d, safeText_(ti)]);
    });

    if (rows.length) {
      const lock = LockService.getScriptLock();
      if (!lock.tryLock(20000)) return json_({ ok: false, error: 'busy' });
      try {
        // 같은 묶음이 거의 동시에 두 번 오면 위의 검사를 둘 다 통과할 수 있으므로 잠근 뒤 한 번 더 본다
        if (batchId && cache.get('b:' + batchId)) return json_({ ok: true, dup: true });
        const sh = SpreadsheetApp.getActive().getSheetByName(LOG_SHEET);
        if (!sh) return json_({ ok: false, error: 'no_sheet' });
        sh.getRange(sh.getLastRow() + 1, 1, rows.length, 4).setValues(rows);
        if (batchId) cache.put('b:' + batchId, '1', 21600);
      } finally {
        lock.releaseLock();
      }
    } else if (batchId) {
      cache.put('b:' + batchId, '1', 21600);
    }
    return json_({ ok: true, n: rows.length });
  } catch (err) {
    // 받은 내용은 로그에 남기지 않는다 (개인정보 보관 기간을 지키기 위해)
    console.error('doPost error: ' + (err && err.message));
    return json_({ ok: false, error: 'server' });
  }
}

// 명단: 5분간 캐시
function rosterLabel_(email) {
  if (!email) return '';
  const cache = CacheService.getScriptCache();
  let map = null;
  const cached = cache.get('roster');
  if (cached) {
    map = JSON.parse(cached);
  } else {
    map = {};
    const sh = SpreadsheetApp.getActive().getSheetByName(ROSTER_SHEET);
    if (sh && sh.getLastRow() > 1) {
      sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
        const em = String(r[0] || '').toLowerCase().trim();
        if (em) map[em] = String(r[1] || '').trim() || em;
      });
    }
    // 캐시 값 한도(100KB)를 넘으면 put이 예외를 던진다. 캐시 없이 계속 진행한다.
    try { cache.put('roster', JSON.stringify(map), 300); } catch (err) { /* 캐시 생략 */ }
  }
  return map[email] || '';
}

// 시트 수식으로 해석되지 않게 막는다 (=, +, -, @ 로 시작하는 제목)
function safeText_(s) {
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- 정리 ----------

function cleanup() {
  const sh = SpreadsheetApp.getActive().getSheetByName(LOG_SHEET);
  if (!sh || sh.getLastRow() < 2) return;
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    const n = sh.getLastRow() - 1;
    if (n < 1) return;
    const times = sh.getRange(2, 1, n, 1).getValues();
    const isOld = function (v) {
      return v instanceof Date && v.getTime() < cutoff;
    };
    // 기록은 대체로 시간순이지만, 늦게 도착한 묶음 때문에 중간에도 오래된 줄이 있을 수 있다.
    // 오래된 줄을 연속 구간으로 묶어 아래쪽부터 지운다 (위에서부터 지우면 줄 번호가 밀린다).
    const runs = [];
    for (let i = 0; i < n; i++) {
      if (!isOld(times[i][0])) continue;
      const last = runs[runs.length - 1];
      if (last && last.start + last.len === i) last.len++;
      else runs.push({ start: i, len: 1 });
    }
    const total = runs.reduce(function (s, r) { return s + r.len; }, 0);
    if (total === 0) return;
    if (total === n) {
      // 고정 행을 뺀 모든 행을 지우면 오류가 나므로 내용만 비운다
      sh.getRange(2, 1, n, sh.getLastColumn()).clearContent();
      return;
    }
    for (let k = runs.length - 1; k >= 0; k--) {
      sh.deleteRows(runs[k].start + 2, runs[k].len);
    }
  } finally {
    lock.releaseLock();
  }
}
