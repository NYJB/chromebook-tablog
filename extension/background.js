const DEFAULTS = {
  endpoint: "",
  token: "",
  titleDomains: ["youtube.com"],
  intervalMinutes: 10,
};

const MAX_BUFFER = 300;
const MAX_PER_SEND = 100;
const TITLE_MAX = 150;
const FETCH_TIMEOUT_MS = 25000;
const ALARM = "flush";

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
  return c;
}

let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

function cleanTitle(t) {
  return String(t || "")
    .replace(/^\(\d+\+?\)\s*/, "")
    .replace(/\s*[-–]\s*YouTube$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^YouTube$/i, "")
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
    if (!c.endpoint || !c.token) return;

    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !tab.url) return;

    const win = await chrome.windows.get(tab.windowId).catch(() => null);
    if (!win || !win.focused) return;

    const domain = domainOf(tab.url);
    if (!domain) return;

    let title = "";
    if (titleAllowed(domain, c.titleDomains)) {
      if (tab.status !== "complete") return;
      title = cleanTitle(tab.title);
      if (!title || title.toLowerCase() === domain) title = "";
      if (title && /(^|\.)youtube\.com$/.test(domain) && /^\/results/.test(new URL(tab.url).pathname)) {
        title = ("[검색] " + title).slice(0, TITLE_MAX);
      }
    }

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

async function getEmail() {
  try {
    const info = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" });
    return (info && info.email) || "";
  } catch (e) {
    return "";
  }
}

function takeBatch() {
  return serial(async () => {
    const { buffer = [], pending = null } = await chrome.storage.local.get(["buffer", "pending"]);
    if (!buffer.length) return null;
    const byId = new Map(buffer.map((e) => [e.id, e]));
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

let flushing = null;
function flush() {
  if (!flushing) flushing = flushOnce().finally(() => (flushing = null));
  return flushing;
}

async function flushOnce() {
  const c = await getConfig();
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
      data = null;
    }
    if (data && (data.ok || data.drop)) {
      await removeSent(batch.events.map((e) => e.id));
    }
  } catch (e) {
  } finally {
    clearTimeout(timer);
  }
}

async function ensureAlarm(reset = false) {
  const c = await getConfig();
  const existing = await chrome.alarms.get(ALARM);
  if (existing && !reset && existing.periodInMinutes === c.intervalMinutes) return;
  await chrome.alarms.clear(ALARM);
  const delay = 1 + Math.random() * (c.intervalMinutes - 1);
  await chrome.alarms.create(ALARM, { delayInMinutes: delay, periodInMinutes: c.intervalMinutes });
}

chrome.tabs.onActivated.addListener(() => record());
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (tab.active && (info.title !== undefined || info.status === "complete")) record();
});
chrome.windows.onFocusChanged.addListener((winId) => {
  if (winId !== chrome.windows.WINDOW_ID_NONE) record();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== ALARM) return;
  record()
    .catch(() => {})
    .then(() => flush())
    .catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => ensureAlarm(true));
chrome.runtime.onStartup.addListener(() => ensureAlarm());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "managed") ensureAlarm(true);
});

ensureAlarm();
