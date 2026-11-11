// apps-script/Code.gs 를 Apps Script 서비스 모의 객체 위에서 돌려 본다.  실행: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(process.env.GS_SRC || path.join(root, "apps-script", "Code.gs"), "utf8");

class Sheet {
  constructor(name) {
    this.name = name;
    this.rows = []; // 0번이 1행
    this.frozen = 0;
    this.formats = {};
  }
  getLastRow() {
    for (let i = this.rows.length - 1; i >= 0; i--) if (this.rows[i].some((v) => v !== "" && v != null)) return i + 1;
    return 0;
  }
  getLastColumn() { return 4; }
  getMaxColumns() { return 26; }
  deleteColumns() {}
  appendRow(r) { this.rows[this.getLastRow()] = r.slice(); }
  setFrozenRows(n) { this.frozen = n; }
  setColumnWidth() {}
  deleteRows(start, n) {
    const nonFrozen = Math.max(this.rows.length, this.getLastRow()) - this.frozen;
    if (n >= nonFrozen) throw new Error("You can't delete all the rows that are not frozen.");
    this.rows.splice(start - 1, n);
  }
  getRange(a, col, nr, nc) {
    const sh = this;
    if (typeof a === "string") return { setNumberFormat: (f) => (sh.formats[a] = f) };
    if (a < 1 || nr < 1) throw new Error("The number of rows in the range must be at least 1.");
    return {
      setValues(vals) {
        assert.equal(vals.length, nr);
        vals.forEach((r, i) => { assert.equal(r.length, nc); sh.rows[a - 1 + i] = r.slice(); });
      },
      getValues() {
        const out = [];
        for (let i = 0; i < nr; i++) out.push((sh.rows[a - 1 + i] || []).slice(col - 1, col - 1 + nc).concat(Array(nc).fill("")).slice(0, nc));
        return out;
      },
      clearContent() {
        for (let i = 0; i < nr; i++) sh.rows[a - 1 + i] = Array(4).fill("");
      },
    };
  }
}

function setup({ activeUser = "", roster = [["s1@school.kr", "07 홍길동"]], token = "TOK", noLogSheet = false, lockOk = true } = {}) {
  const sheets = {};
  const ss = {
    tz: null,
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = new Sheet(n)),
    setSpreadsheetTimeZone(t) { this.tz = t; },
  };
  if (!noLogSheet) { sheets["기록"] = new Sheet("기록"); sheets["기록"].appendRow(["시간", "학생", "사이트", "제목"]); sheets["기록"].frozen = 1; }
  sheets["명단"] = new Sheet("명단");
  sheets["명단"].appendRow(["이메일", "표시 이름"]);
  roster.forEach((r) => sheets["명단"].appendRow(r));

  const store = new Map();
  const cache = {
    store,
    get: (k) => (store.has(k) ? store.get(k) : null),
    put: (k, v) => {
      if (k.length > 250) throw new Error("key too long");
      if (Buffer.byteLength(v) > 100 * 1024) throw new Error("Argument too large: value");
      store.set(k, v);
    },
  };
  const props = new Map(token ? [["TOKEN", token]] : []);
  const triggers = [];
  const lockState = { held: false, released: 0 };
  const g = {
    SpreadsheetApp: { getActive: () => ss, getUi: () => ({ alert() {}, createMenu() { return this; }, addItem() { return this; }, addToUi() {} }) },
    CacheService: { getScriptCache: () => cache },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props.get(k) || null, setProperty: (k, v) => props.set(k, v) }) },
    Session: { getActiveUser: () => ({ getEmail: () => activeUser }) },
    LockService: { getScriptLock: () => ({ tryLock: () => { if (!lockOk) return false; lockState.held = true; return true; }, releaseLock: () => { lockState.held = false; lockState.released++; } }) },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: (s) => ({ body: JSON.parse(s), setMimeType() { return this; } }) },
    Utilities: { getUuid: () => crypto.randomUUID() },
    ScriptApp: {
      getProjectTriggers: () => triggers,
      newTrigger: (fn) => {
        const t = { fn, tz: null };
        const b = { timeBased: () => b, everyDays: () => b, atHour: (h) => ((t.hour = h), b), inTimezone: (z) => ((t.tz = z), b), create: () => (triggers.push({ getHandlerFunction: () => fn, ...t }), t) };
        return b;
      },
    },
    console: { error() {}, log() {} },
    Date, JSON, Math, Number, String, Array, Object, isFinite,
  };
  const ctx = vm.createContext(g);
  vm.runInContext(SRC, ctx, { filename: "Code.gs" });
  const post = (body) => ctx.doPost({ postData: { contents: typeof body === "string" ? body : JSON.stringify(body) } }).body;
  return { ctx, sheets, cache, triggers, lockState, ss, post, log: () => sheets["기록"].rows.slice(1).filter((r) => r.some((v) => v !== "")) };
}

const now = Date.now();
const ev = (o = {}) => ({ t: now - 60000, d: "youtube.com", ti: "영상", ...o });

test("정상 수신: 명단 이름으로 기록, 토큰 검사", () => {
  const s = setup();
  const r = s.post({ v: 1, token: "TOK", email: "S1@School.kr ", batchId: "b1", events: [ev(), ev({ d: "docs.google.com", ti: "" })] });
  assert.deepEqual(r, { ok: true, n: 2 });
  assert.equal(s.log().length, 2);
  assert.equal(s.log()[0][1], "07 홍길동");
  assert.ok(s.log()[0][0] instanceof Date);
  assert.equal(s.lockState.held, false);

  assert.equal(s.post({ token: "bad", email: "s1@school.kr", events: [ev()] }).error, "auth");
  assert.equal(s.post({ email: "s1@school.kr", events: [ev()] }).error, "auth");
  const nt = setup({ token: "" });
  assert.equal(nt.post({ token: "", email: "s1@school.kr", events: [ev()] }).error, "auth", "토큰이 아직 없으면 빈 토큰도 거절");
});

test("명단 밖·형식 오류는 drop", () => {
  const s = setup();
  assert.deepEqual(s.post({ token: "TOK", email: "x@school.kr", events: [ev()] }), { ok: false, drop: true, error: "not_in_roster" });
  assert.equal(s.post("{bad").error, "bad_json");
  assert.equal(s.post("{bad").drop, true);
  assert.equal(s.ctx.doPost({}).body.error, "bad_request");
  assert.equal(s.post("x".repeat(60001)).error, "bad_request");
});

test("getActiveUser가 있으면(도메인 배포) 토큰·본문 이메일을 보지 않는다", () => {
  const s = setup({ activeUser: "s1@school.kr" });
  const r = s.post({ token: "wrong", email: "someone-else@school.kr", batchId: "b", events: [ev()] });
  assert.equal(r.ok, true);
  assert.equal(s.log()[0][1], "07 홍길동");
});

test("getActiveUser가 빈 값이면(Anyone 배포) 토큰이 맞을 때만 본문 이메일을 믿는다", () => {
  const s = setup({ activeUser: "" });
  assert.equal(s.post({ token: "TOK", email: "s1@school.kr", events: [ev()] }).ok, true);
});

test("batchId 중복 제거", () => {
  const s = setup();
  const body = { token: "TOK", email: "s1@school.kr", batchId: "same", events: [ev(), ev()] };
  assert.equal(s.post(body).n, 2);
  assert.deepEqual(s.post(body), { ok: true, dup: true });
  assert.equal(s.log().length, 2);
});

test("레이트 리밋: 10분에 6번", () => {
  const s = setup();
  for (let i = 0; i < 6; i++) assert.equal(s.post({ token: "TOK", email: "s1@school.kr", batchId: "r" + i, events: [ev()] }).ok, true);
  assert.equal(s.post({ token: "TOK", email: "s1@school.kr", batchId: "r6", events: [ev()] }).error, "rate");
});

test("이벤트 검사: 시간 범위, 도메인 형식, 최대 건수, 수식 막기", () => {
  const s = setup({ roster: [["s1@school.kr", "=HYPERLINK(\"x\")"]] });
  const events = [
    ev({ t: now - 4 * 86400000 }), // 너무 오래됨
    ev({ t: now + 60 * 60000 }), // 미래
    ev({ t: "abc" }),
    ev({ d: "bad domain" }),
    ev({ d: "-1" }),
    ev({ ti: "=IMPORTXML(\"http://evil\",\"//a\")" }),
    ev({ ti: "  +1 " }),
    ev({ ti: "x".repeat(500) }),
    null,
  ];
  const r = s.post({ token: "TOK", email: "s1@school.kr", events });
  assert.equal(r.n, 3);
  const titles = s.log().map((x) => x[3]);
  assert.equal(titles[0], "'=IMPORTXML(\"http://evil\",\"//a\")");
  assert.equal(titles[1], "'+1");
  assert.equal(titles[2].length, 150);
  assert.ok(s.log().every((x) => x[1].startsWith("'=")), "명단 이름도 수식으로 해석되지 않게");

  const many = Array.from({ length: 200 }, () => ev());
  const s2 = setup();
  assert.equal(s2.post({ token: "TOK", email: "s1@school.kr", events: many }).n, 150);
});

test("잠금 실패면 busy, 쓰지 않음, batchId 표시 안 함", () => {
  const s = setup({ lockOk: false });
  assert.equal(s.post({ token: "TOK", email: "s1@school.kr", batchId: "z", events: [ev()] }).error, "busy");
  assert.equal(s.cache.get("b:z"), null);
});

test("기록 시트가 없으면 no_sheet, 잠금은 풀린다", () => {
  const s = setup({ noLogSheet: true });
  assert.equal(s.post({ token: "TOK", email: "s1@school.kr", events: [ev()] }).error, "no_sheet");
  assert.equal(s.lockState.held, false);
});

test("명단이 커서 캐시 100KB를 넘어도 수신은 된다", () => {
  const roster = Array.from({ length: 3000 }, (_, i) => [`student${i}@school.kr`, `학생 이름 ${i} `.repeat(3)]);
  roster.push(["s1@school.kr", "07 홍길동"]);
  const s = setup({ roster });
  assert.equal(s.post({ token: "TOK", email: "s1@school.kr", events: [ev()] }).ok, true);
});

test("cleanup: 앞쪽 오래된 구간, 중간에 낀 오래된 줄, 빈 칸 유지", () => {
  const s = setup();
  const day = 86400000;
  const rows = [
    [new Date(now - 20 * day), "a", "x.com", ""],
    [new Date(now - 15 * day), "a", "x.com", ""],
    [new Date(now - 1 * day), "b", "y.com", ""],
    [new Date(now - 14.5 * day), "c", "late.com", ""], // 늦게 도착한 오래된 줄
    ["", "", "", ""], // 빈 줄은 건드리지 않음
    [new Date(now - 2 * day), "d", "z.com", ""],
    [new Date(now - 16 * day), "e", "late2.com", ""],
  ];
  s.sheets["기록"].rows.push(...rows);
  s.ctx.cleanup();
  const left = s.sheets["기록"].rows.slice(1).map((r) => r[2]);
  assert.deepEqual(left, ["y.com", "", "z.com"]);
  assert.equal(s.lockState.held, false);
});

test("cleanup: 전부 오래되면 내용만 비우고 다음 수신은 2행부터", () => {
  const s = setup();
  for (let i = 0; i < 5; i++) s.sheets["기록"].appendRow([new Date(now - 30 * 86400000), "a", "x.com", "t"]);
  s.ctx.cleanup();
  assert.equal(s.sheets["기록"].getLastRow(), 1);
  s.post({ token: "TOK", email: "s1@school.kr", events: [ev()] });
  assert.equal(s.sheets["기록"].getLastRow(), 2);
  s.ctx.cleanup(); // 지울 것 없음
  assert.equal(s.sheets["기록"].getLastRow(), 2);
  const empty = setup();
  empty.ctx.cleanup(); // 머리글만 있음
});

test("setup: 시트·토큰·트리거(서울 시간) 한 번만", () => {
  const s = setup({ token: "", noLogSheet: true });
  s.ctx.setup();
  s.ctx.setup();
  assert.equal(s.triggers.length, 1);
  assert.equal(s.triggers[0].tz, "Asia/Seoul");
  assert.equal(s.ss.tz, "Asia/Seoul");
  assert.equal(s.sheets["기록"].formats["B:D"], "@");
});
