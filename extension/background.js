// 수업 탭 기록 - 서비스 워커
// 하는 일: 수업 시간에 활성 탭의 사이트 이름(과 허용된 사이트의 제목)을 모아 두었다가
// 몇 분마다 한 번에 묶어 선생님의 Apps Script 웹 앱으로 보낸다.
// 서비스 워커는 언제든 꺼질 수 있으므로 상태는 모두 chrome.storage에 둔다.

const DEFAULTS = {
  endpoint: "",
  token: "",
  titleDomains: ["youtube.com"],
  days: [1, 2, 3, 4, 5],
  start: "08:30",
  end: "15:00",
  intervalMinutes: 10,
};

const MAX_BUFFER = 300; // 보내지 못하고 쌓아 둘 최대 건수
const MAX_PER_SEND = 100; // 한 번에 보낼 최대 건수
const TITLE_MAX = 150;
const FETCH_TIMEOUT_MS = 25000; // 서비스 워커 30초 제한보다 짧게
const ALARM = "flush";

// ---------- 설정 ----------

async function getConfig() {
  let managed = {};
  try {
    managed = await chrome.storage.managed.get(null);
  } catch (e) {
    managed = {};
  }
  const c = { ...DEFAULTS, ...managed };
  const n = Number(c.intervalMinutes);
  c.intervalMinutes = Number.isFinite(n) ? Math.min(60, Math.max(5, Math.round(n))) : 10;
  c.titleDomains = Array.isArray(c.titleDomains)
    ? c.titleDomains.map((d) => String(d).toLowerCase().replace(/^www\./, "").trim()).filter(Boolean)
    : DEFAULTS.titleDomains;
  c.days = Array.isArray(c.days) ? c.days.map(Number) : DEFAULTS.days;
  return c;
}

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function inSchedule(c, now = new Date()) {
  if (!c.days.includes(now.getDay())) return false;
  const s = toMinutes(c.start);
  const e = toMinutes(c.end);
  if (s === null || e === null) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return cur >= s && cur < e;
}

// ---------- 저장소 쓰기는 한 줄로 차례대로 ----------

let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn);
  chain = run.catch((e) => console.warn("[탭기록]", e));
  return run;
}

// ---------- 표시(배지) ----------

async function updateBadge(c) {
  const on = inSchedule(c) && c.endpoint && c.token;
  await chrome.action.setBadgeText({ text: on ? "기록" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#c62828" });
  await chrome.action.setTitle({
    title: on
      ? "수업 시간이라 기록 중: 유튜브 영상 제목과 사이트 이름이 선생님께 전달됩니다."
      : "수업 탭 기록 (지금은 기록하지 않음)",
  });
}

// ---------- 기록 ----------

function cleanTitle(t) {
  return String(t || "")
    .replace(/^\(\d+\+?\)\s*/, "") // 유튜브 알림 숫자 "(3) "
    .replace(/\s*[-–]\s*YouTube$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^YouTube$/i, "") // 유튜브 홈 등 영상이 아닌 화면
    .slice(0, TITLE_MAX);
}

function domainOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch (e) {
    return null;
  }
}

function titleAllowed(domain, list) {
  return list.some((d) => domain === d || domain.endsWith("." + d));
}

function record() {
  return serial(async () => {
    const c = await getConfig();
    // 배지와 같은 조건: 설정이 없으면(관리 정책을 못 읽은 경우 포함) 기기에 쌓지도 않는다
    if (!inSchedule(c) || !c.endpoint || !c.token) return;

    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !tab.url) return;

    const win = await chrome.windows.get(tab.windowId).catch(() => null);
    if (!win || !win.focused) return; // 크롬 창이 앞에 없으면 기록 안 함

    const domain = domainOf(tab.url);
    if (!domain) return; // 새 탭, chrome:// 등

    let title = "";
    if (titleAllowed(domain, c.titleDomains)) {
      if (tab.status !== "complete") return; // 제목이 아직 바뀌는 중
      title = cleanTitle(tab.title);
      if (!title || title.toLowerCase() === domain) title = "";
      // 유튜브 검색 결과 화면은 제목이 검색어이므로 영상 제목과 구분한다
      if (title && /(^|\.)youtube\.com$/.test(domain) && /^\/results/.test(new URL(tab.url).pathname)) {
        title = ("[검색] " + title).slice(0, TITLE_MAX);
      }
    }

    // 날짜를 넣어, 전날 마지막으로 본 탭을 다음 날 그대로 열어 두어도 첫 기록이 빠지지 않게 한다
    const now = new Date();
    const key = now.toDateString() + "|" + domain + "|" + title;
    const { lastKey } = await chrome.storage.session.get("lastKey");
    if (lastKey === key) return;
    await chrome.storage.session.set({ lastKey: key });

    const { buffer = [] } = await chrome.storage.local.get("buffer");
    buffer.push({ id: crypto.randomUUID(), t: now.getTime(), d: domain, ti: title });
    if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
    await chrome.storage.local.set({ buffer });
  });
}

// ---------- 전송 ----------

async function getEmail() {
  try {
    const info = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" });
    return (info && info.email) || "";
  } catch (e) {
    return "";
  }
}

// 보낼 묶음을 정한다. 지난번에 보내다 실패한 묶음이 있으면 같은 batchId로 다시 보낸다
// (서버가 이미 받았는데 응답만 끊긴 경우 중복 기록을 막기 위해).
function takeBatch() {
  return serial(async () => {
    const { buffer = [], pending = null } = await chrome.storage.local.get(["buffer", "pending"]);
    if (!buffer.length) return null;
    const byId = new Map(buffer.map((e) => [e.id, e]));
    // 버퍼가 넘쳐 일부가 잘려 나갔어도 남은 것은 같은 batchId로 보낸다
    // (새 batchId로 보내면 서버가 이미 받은 묶음인지 알 수 없어 중복될 수 있다)
    const left = pending && Array.isArray(pending.ids) ? pending.ids.filter((id) => byId.has(id)) : [];
    if (left.length) {
      return { batchId: pending.batchId, events: left.map((id) => byId.get(id)) };
    }
    const events = buffer.slice(0, MAX_PER_SEND);
    const next = { batchId: crypto.randomUUID(), ids: events.map((e) => e.id) };
    await chrome.storage.local.set({ pending: next });
    return { batchId: next.batchId, events };
  });
}

function removeSent(ids) {
  return serial(async () => {
    const sent = new Set(ids);
    const { buffer = [] } = await chrome.storage.local.get("buffer");
    await chrome.storage.local.set({ buffer: buffer.filter((e) => !sent.has(e.id)), pending: null });
  });
}

// 알람이 겹쳐 와도(밀린 알람 등) 같은 묶음을 동시에 두 번 보내지 않게 한다
let flushing = null;
function flush() {
  if (!flushing) flushing = flushOnce().finally(() => (flushing = null));
  return flushing;
}

async function flushOnce() {
  const c = await getConfig();
  await updateBadge(c).catch(() => {});
  if (!c.endpoint || !c.token) return;

  const email = await getEmail();
  if (!email) return;

  const batch = await takeBatch();
  if (!batch) return;

  const body = JSON.stringify({
    v: 1,
    token: c.token,
    email,
    batchId: batch.batchId,
    sentAt: Date.now(),
    events: batch.events.map(({ t, d, ti }) => ({ t, d, ti })),
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(c.endpoint, {
      method: "POST",
      // text/plain 이어야 Apps Script가 받을 수 있다 (preflight 없음)
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body,
      credentials: "include",
      redirect: "follow",
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = null; // 로그인 페이지 같은 HTML이 오면 실패로 본다
    }
    if (data && data.ok) {
      await removeSent(batch.events.map((e) => e.id));
    } else if (data && data.drop) {
      // 서버가 영구적으로 거절한 묶음(형식 오류 등)은 버려서 계속 재시도하지 않게 한다
      await removeSent(batch.events.map((e) => e.id));
    }
  } catch (e) {
    // 네트워크 오류: 버퍼에 남겨 두고 다음 주기에 다시 보낸다
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 알람 (전송 주기) ----------

async function ensureAlarm(reset = false) {
  const c = await getConfig();
  const existing = await chrome.alarms.get(ALARM);
  if (existing && !reset && existing.periodInMinutes === c.intervalMinutes) return;
  await chrome.alarms.clear(ALARM);
  // 기기마다 시작 시점을 흩뜨려 요청이 한꺼번에 몰리지 않게 한다
  const delay = 1 + Math.random() * (c.intervalMinutes - 1);
  await chrome.alarms.create(ALARM, { delayInMinutes: delay, periodInMinutes: c.intervalMinutes });
}

// ---------- 이벤트 (최상위에서 동기로 등록) ----------

chrome.tabs.onActivated.addListener(() => record());
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (tab.active && (info.title !== undefined || info.status === "complete")) record();
});
chrome.windows.onFocusChanged.addListener((winId) => {
  if (winId !== chrome.windows.WINDOW_ID_NONE) record();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== ALARM) return;
  // 수업 시작 시각에 이미 열려 있던 탭도 잡히도록 주기마다 한 번 기록을 시도한다 (같은 탭이면 중복 방지로 걸러짐)
  record()
    .catch(() => {})
    .then(() => flush())
    .catch((e) => console.warn("[탭기록]", e));
});
chrome.runtime.onInstalled.addListener(() => ensureAlarm(true));
chrome.runtime.onStartup.addListener(() => ensureAlarm());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "managed") {
    ensureAlarm(true);
    getConfig().then(updateBadge).catch(() => {});
  }
});

ensureAlarm();
getConfig().then(updateBadge).catch(() => {});
