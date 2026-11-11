// background.js를 chrome.* 모의 객체 위에서 돌려 본다.  실행: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(process.env.BG_SRC || path.join(root, "extension", "background.js"), "utf8");

function makeArea(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      if (keys === null || keys === undefined) return structuredClone(data);
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(obj) {
      Object.assign(data, structuredClone(obj));
    },
  };
}

function makeEvent() {
  const fns = [];
  return { fns, addListener: (f) => fns.push(f), fire: (...a) => fns.forEach((f) => f(...a)) };
}

const ALL_DAY = {};

function setup({ managed = {}, tab, focused = true, email = "s1@school.kr", fetchImpl, DateImpl } = {}) {
  const env = {
    tab: tab || { id: 1, windowId: 9, active: true, url: "https://www.youtube.com/watch?v=a", title: "(2) 영상 A - YouTube", status: "complete" },
    focused,
    requests: [],
  };
  const ev = {
    onActivated: makeEvent(),
    onUpdated: makeEvent(),
    onFocusChanged: makeEvent(),
    onAlarm: makeEvent(),
    onInstalled: makeEvent(),
    onStartup: makeEvent(),
    onChanged: makeEvent(),
  };
  const alarms = new Map();
  const chrome = {
    storage: {
      local: makeArea(),
      session: makeArea(),
      managed: managed === "throw"
        ? { get: async () => { throw new Error("no policy"); } }
        : makeArea({ endpoint: "https://script.google.com/macros/s/X/exec", token: "T", ...ALL_DAY, ...managed }),
      onChanged: ev.onChanged,
    },
    tabs: {
      query: async () => (env.tab ? [{ ...env.tab }] : []),
      onActivated: ev.onActivated,
      onUpdated: ev.onUpdated,
    },
    windows: {
      WINDOW_ID_NONE: -1,
      get: async (id) => ({ id, focused: env.focused }),
      onFocusChanged: ev.onFocusChanged,
    },
    action: { badge: "", setBadgeText: async ({ text }) => (chrome.action.badge = text), setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    alarms: {
      map: alarms,
      get: async (n) => alarms.get(n),
      clear: async (n) => alarms.delete(n),
      create: async (n, o) => alarms.set(n, { name: n, ...o }),
      onAlarm: ev.onAlarm,
    },
    identity: { getProfileUserInfo: async () => ({ email }) },
    runtime: { onInstalled: ev.onInstalled, onStartup: ev.onStartup },
  };
  const fetch = async (url, opts) => {
    env.requests.push({ url, opts, body: JSON.parse(opts.body) });
    return fetchImpl ? fetchImpl(url, opts, env) : { text: async () => JSON.stringify({ ok: true }) };
  };
  const ctx = vm.createContext({
    chrome, fetch, console, crypto: globalThis.crypto, AbortController, setTimeout, clearTimeout,
    URL, Date: DateImpl || Date, Promise, Map, Set, JSON, Math, Number, String, Array, Object,
  });
  vm.runInContext(SRC, ctx, { filename: "background.js" });
  return { ctx, chrome, env, ev };
}

const tick = () => new Promise((r) => setTimeout(r, 20));
const buf = (chrome) => chrome.storage.local.data.buffer || [];

test("기록: 제목 정리, 같은 탭 중복 제거", async () => {
  const { ctx, chrome, env } = setup();
  await ctx.record();
  await ctx.record();
  assert.equal(buf(chrome).length, 1);
  assert.deepEqual([buf(chrome)[0].d, buf(chrome)[0].ti], ["youtube.com", "영상 A"]);

  env.tab = { ...env.tab, url: "https://docs.google.com/document/d/1", title: "비밀 문서" };
  await ctx.record();
  assert.equal(buf(chrome)[1].ti, "", "허용 목록 밖 사이트는 제목을 남기지 않는다");
});

test("기록 안 함: 창 포커스 없음 / chrome:// / 로딩 중 유튜브 / 설정 없음 / 정책 읽기 실패", async () => {
  let s = setup({ focused: false });
  await s.ctx.record();
  assert.equal(buf(s.chrome).length, 0);

  s = setup({ tab: { windowId: 1, active: true, url: "chrome://newtab/", title: "새 탭", status: "complete" } });
  await s.ctx.record();
  assert.equal(buf(s.chrome).length, 0);

  s = setup({ tab: { windowId: 1, active: true, url: "https://www.youtube.com/watch?v=b", title: "옛 제목", status: "loading" } });
  await s.ctx.record();
  assert.equal(buf(s.chrome).length, 0);

  s = setup({ managed: { endpoint: "" } });
  await s.ctx.record();
  assert.equal(buf(s.chrome).length, 0);

  s = setup({ managed: "throw" });
  await s.ctx.record();
  assert.equal(buf(s.chrome).length, 0);
});

test("시간·요일 제한 없이 기록 (밤·주말 포함)", async () => {
  const fixed = (iso) => class extends Date { constructor(...a) { super(...(a.length ? a : [iso])); } static now() { return new Date(iso).getTime(); } };
  for (const iso of ["2026-11-11T21:30:00", "2026-11-14T10:00:00", "2026-11-11T06:00:00"]) {
    const s = setup({ DateImpl: fixed(iso) });
    await s.ctx.record();
    assert.equal(buf(s.chrome).length, 1, iso);
  }
});

test("다음 날 같은 탭이면 다시 기록된다 (lastKey에 날짜 포함)", async () => {
  let iso = "2026-11-11T14:00:00";
  const D = class extends Date { constructor(...a) { super(...(a.length ? a : [iso])); } static now() { return new Date(iso).getTime(); } };
  const { ctx, chrome } = setup({ DateImpl: D });
  await ctx.record();
  iso = "2026-11-12T09:00:00";
  await ctx.record();
  assert.equal(buf(chrome).length, 2);
});

test("유튜브 SPA: 로딩 중 제목 이벤트는 건너뛰고, 제목 변경 이벤트로 새 영상이 잡힌다", async () => {
  const { chrome, env, ev } = setup();
  ev.onActivated.fire({});
  await tick();
  // 다른 영상 클릭: status=complete인데 제목은 아직 옛 것 -> 중복 제거
  env.tab = { ...env.tab, url: "https://www.youtube.com/watch?v=b", title: "(2) 영상 A - YouTube", status: "complete" };
  ev.onUpdated.fire(1, { status: "complete" }, env.tab);
  // 연달아 오는 이벤트 (경합)
  env.tab = { ...env.tab, title: "영상 B - YouTube", status: "loading" };
  ev.onUpdated.fire(1, { title: env.tab.title }, env.tab);
  env.tab = { ...env.tab, status: "complete" };
  ev.onUpdated.fire(1, { status: "complete" }, env.tab);
  ev.onUpdated.fire(1, { title: "영상 B - YouTube" }, env.tab);
  await tick();
  assert.deepEqual(buf(chrome).map((e) => e.ti), ["영상 A", "영상 B"]);
});

test("유튜브 홈 제목 'YouTube'는 빈 제목으로", async () => {
  const s = setup({ tab: { windowId: 1, active: true, url: "https://www.youtube.com/", title: "YouTube", status: "complete" } });
  await s.ctx.record();
  assert.equal(buf(s.chrome)[0].ti, "");
});

test("버퍼 상한 300", async () => {
  const { ctx, chrome, env } = setup();
  for (let i = 0; i < 305; i++) {
    env.tab = { ...env.tab, url: `https://s${i}.example.com/` };
    await ctx.record();
  }
  assert.equal(buf(chrome).length, 300);
  assert.equal(buf(chrome)[0].d, "s5.example.com");
});

test("전송 성공: 100건씩 보내고 지운다, 이메일·토큰 포함", async () => {
  const { ctx, chrome, env } = setup();
  for (let i = 0; i < 130; i++) {
    env.tab = { ...env.tab, url: `https://s${i}.example.com/` };
    await ctx.record();
  }
  await ctx.flush();
  assert.equal(env.requests.length, 1);
  const b = env.requests[0].body;
  assert.equal(b.events.length, 100);
  assert.equal(b.email, "s1@school.kr");
  assert.equal(b.token, "T");
  assert.ok(!("id" in b.events[0]), "내부 id는 보내지 않는다");
  assert.equal(env.requests[0].opts.headers["Content-Type"], "text/plain;charset=utf-8");
  assert.equal(buf(chrome).length, 30);
  assert.equal(chrome.storage.local.data.pending, null);
  await ctx.flush();
  assert.equal(buf(chrome).length, 0);
});

test("응답이 HTML(로그인 페이지)이거나 네트워크 오류면 같은 batchId로 재전송", async () => {
  let mode = "html";
  const { ctx, chrome, env } = setup({
    fetchImpl: async () => {
      if (mode === "html") return { text: async () => "<html>login</html>" };
      if (mode === "neterr") throw new TypeError("Failed to fetch");
      return { text: async () => JSON.stringify({ ok: true }) };
    },
  });
  await ctx.record();
  await ctx.flush();
  mode = "neterr";
  await ctx.flush();
  // 그사이 새 기록이 생겨도 재전송 묶음에는 끼지 않는다
  env.tab = { ...env.tab, url: "https://new.example.com/" };
  await ctx.record();
  mode = "ok";
  await ctx.flush();
  const ids = env.requests.map((r) => r.body.batchId);
  assert.equal(new Set(ids).size, 1);
  assert.equal(env.requests[2].body.events.length, 1);
  assert.equal(buf(chrome).length, 1);
  await ctx.flush();
  assert.notEqual(env.requests[3].body.batchId, ids[0]);
  assert.equal(buf(chrome).length, 0);
});

test("버퍼가 넘쳐 pending 일부가 잘려도 남은 것은 같은 batchId로", async () => {
  let fail = true;
  const { ctx, chrome, env } = setup({ fetchImpl: async () => (fail ? { text: async () => "x" } : { text: async () => '{"ok":true}' }) });
  for (let i = 0; i < 300; i++) { env.tab = { ...env.tab, url: `https://a${i}.example.com/` }; await ctx.record(); }
  await ctx.flush(); // pending = 앞 100건
  for (let i = 0; i < 40; i++) { env.tab = { ...env.tab, url: `https://b${i}.example.com/` }; await ctx.record(); }
  fail = false;
  await ctx.flush();
  assert.equal(env.requests[1].body.batchId, env.requests[0].body.batchId);
  assert.equal(env.requests[1].body.events.length, 60);
  assert.equal(buf(chrome).length, 240);
});

test("서버가 drop이면 버리고, auth/rate 등은 남긴다", async () => {
  let resp = { ok: false, error: "auth" };
  const { ctx, chrome } = setup({ fetchImpl: async () => ({ text: async () => JSON.stringify(resp) }) });
  await ctx.record();
  await ctx.flush();
  assert.equal(buf(chrome).length, 1);
  resp = { ok: false, drop: true, error: "not_in_roster" };
  await ctx.flush();
  assert.equal(buf(chrome).length, 0);
});

test("이메일 없음·설정 없음이면 보내지 않음", async () => {
  let s = setup({ email: "" });
  await s.ctx.record();
  await s.ctx.flush();
  assert.equal(s.env.requests.length, 0);
  s = setup({ managed: "throw" });
  await s.ctx.flush();
  assert.equal(s.env.requests.length, 0);
});

test("flush가 겹쳐 불려도 요청은 한 번", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { ctx, env } = setup({ fetchImpl: async () => { await gate; return { text: async () => '{"ok":true}' }; } });
  await ctx.record();
  const a = ctx.flush();
  const b = ctx.flush();
  await tick();
  release();
  await Promise.all([a, b]);
  assert.equal(env.requests.length, 1);
});

test("알람: 생성·주기 범위·재생성, 알람 때 기록 후 전송", async () => {
  const { chrome, env, ev } = setup({ managed: { intervalMinutes: 2 } });
  await tick();
  const a = chrome.alarms.map.get("flush");
  assert.equal(a.periodInMinutes, 5, "5분 미만은 5분으로");
  assert.ok(a.delayInMinutes >= 1 && a.delayInMinutes <= 5);

  chrome.storage.managed.data.intervalMinutes = 30;
  ev.onChanged.fire({ intervalMinutes: {} }, "managed");
  await tick();
  assert.equal(chrome.alarms.map.get("flush").periodInMinutes, 30);

  ev.onAlarm.fire({ name: "flush" });
  await tick();
  assert.equal(env.requests.length, 1, "알람만으로도 현재 탭이 기록되어 전송된다");
});
