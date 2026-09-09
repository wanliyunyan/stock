const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const response = (body, status = 200, retryAfter = null) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => retryAfter }, text: async () => JSON.stringify(body)
});
const payload = (code = "600001") => ({ data: { result: {
  columns: [{ key: "SECURITY_CODE", title: "代码" }], dataList: [{ SECURITY_CODE: code }]
} } });
const limited = () => response({ code: "307", msg: "查询过快，请稍后重试" });

function loadPage(fetch, storage = new Map()) {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const elements = new Map();
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) elements.set(id, {
    value: "", style: { setProperty() {} }, setAttribute() {}, addEventListener() {},
    querySelectorAll: () => [], querySelector: () => null
  });
  let now = Date.parse("2026-09-09T06:00:00Z");
  let timerId = 0;
  const timers = new Map();
  const document = { hidden: false, getElementById: id => elements.get(id), querySelectorAll: () => [] };
  const context = vm.createContext({
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } },
    document, location: { protocol: "http:", hostname: "localhost", search: "" },
    window: {
      localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
      setTimeout(fn, delay) { timers.set(++timerId, { fn, at: now + delay }); return timerId; },
      clearTimeout: id => timers.delete(id)
    },
    URLSearchParams, AbortController, fetch, console: { warn() {} }
  });
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(
    '      applyData(emptySource, { type: "loading", error: "" });',
    `      globalThis.page = {
      requestEastmoney, fetchLiveSource, refreshLiveData, refreshLiveQuotes, scheduleLiveUpdate,
      buildLiveQuery, buildSupplementalMetricQueries, applyData, normalizeEastmoneyResponse,
      restoreSavedSource, writeStoredData, fundamentalsRefreshMs,
      get source() { return activeSource; }, get status() { return dataStatus; }
    }; return;`
  );
  vm.runInContext(script, context);
  const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
  const advance = async ms => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    await flush();
  };
  return { page: context.page, storage, elements, document, timers, advance, flush, now: () => now };
}

test("HTTP 200 code 307 stops new queries and persists increasing cooldown across reloads", async () => {
  let calls = 0;
  const fetch = async () => { calls++; return limited(); };
  const app = loadPage(fetch);
  await assert.rejects(app.page.requestEastmoney("a"), error => error.retryAt === app.now() + 300000);
  await assert.rejects(app.page.requestEastmoney("b"), /查询频率受限/);
  const reloaded = loadPage(fetch, app.storage);
  await assert.rejects(reloaded.page.requestEastmoney("c"), /查询频率受限/);
  assert.equal(calls, 1);
  await app.advance(300000);
  await assert.rejects(app.page.requestEastmoney("a"), error => error.retryAt === app.now() + 600000);
  assert.equal(calls, 2);
});

test("HTTP 429 respects a longer Retry-After", async () => {
  const app = loadPage(async () => response({}, 429, "900"));
  await assert.rejects(app.page.requestEastmoney("a"), error => error.retryAt === app.now() + 900000);
});

test("duplicate concurrent searches share cached results; different queries are spaced", async () => {
  let calls = 0;
  const app = loadPage(async () => { calls++; return response(payload()); });
  const first = app.page.requestEastmoney("a");
  const duplicate = app.page.requestEastmoney("a");
  const other = app.page.requestEastmoney("b");
  await app.flush();
  assert.equal(calls, 1);
  await first;
  await duplicate;
  await app.advance(1999);
  assert.equal(calls, 1);
  await app.advance(1);
  await other;
  assert.equal(calls, 2);
  const reloaded = loadPage(async () => { throw new Error("must use cache"); }, app.storage);
  assert.ok(await reloaded.page.requestEastmoney("a"));
  await app.advance(300000);
  await app.page.requestEastmoney("a");
  assert.equal(calls, 3);
});

test("a supplemental rate limit stops the remaining metrics and keeps the base rows", async () => {
  let calls = 0;
  const app = loadPage(async () => ++calls === 1 ? response(payload()) : limited());
  const pending = app.page.fetchLiveSource("a", ["b", "c"]);
  await app.flush();
  await app.advance(2000);
  const source = await pending;
  assert.equal(calls, 2);
  assert.equal(source.rows.length, 1);
  assert.ok(source.refreshError.retryAt);
  assert.equal(source.rows[0].cashConversionDetails.status, "加载失败");
});

test("failed refresh retains loaded rows and labels the old query and scheduled retry", async () => {
  const app = loadPage(async () => limited());
  const previous = app.page.normalizeEastmoneyResponse(payload(), "previous filters");
  app.page.applyData(previous, { type: "live", error: "" });
  await app.page.refreshLiveData();
  assert.equal(app.page.source.rows[0].SECURITY_CODE, "600001");
  assert.equal(app.page.status.type, "error");
  assert.match(app.elements.get("dataNotice").textContent, /上次查询结果/);
  assert.match(app.elements.get("dataNotice").textContent, /自动重试/);
  assert.ok([...app.timers.values()].every(timer => timer.at >= app.now() + 300000));
});

test("filter edits invalidate in-flight results immediately and skip their remaining requests", async () => {
  let resolveFetch;
  let calls = 0;
  const app = loadPage(() => { calls++; return new Promise(resolve => { resolveFetch = resolve; }); });
  const pending = app.page.refreshLiveData();
  await app.flush();
  await app.page.refreshLiveData();
  assert.equal(calls, 1);
  app.elements.get("yoyThresholdInput").value = "200";
  app.page.scheduleLiveUpdate(550, true);
  resolveFetch(response(payload("600002")));
  await pending;
  assert.equal(calls, 1);
  assert.equal(app.page.source.rows.length, 0);
});

test("quotes refresh independently and hidden pages do not request anything", async () => {
  const urls = [];
  const app = loadPage(async url => { urls.push(url); return response({ data: { diff: [] } }); });
  app.page.applyData(app.page.normalizeEastmoneyResponse(payload(), app.page.buildLiveQuery()), { type: "live", error: "" });
  await app.page.refreshLiveQuotes();
  assert.equal(urls.length, 1);
  assert.ok(urls[0].includes("/api/quotes"));
  await app.advance(60000);
  await app.page.refreshLiveQuotes();
  assert.equal(urls.length, 2);
  app.document.hidden = true;
  await app.advance(60000);
  await app.page.refreshLiveData();
  await app.page.refreshLiveQuotes();
  assert.equal(urls.length, 2);
});

test("snapshot restore requires the same filters and expires after 24 hours", () => {
  const app = loadPage(async () => { throw new Error("offline"); });
  const source = app.page.normalizeEastmoneyResponse(payload(), app.page.buildLiveQuery());
  app.page.writeStoredData("snapshot", { savedAt: app.now(), source });
  const restored = loadPage(null, app.storage);
  restored.page.restoreSavedSource();
  assert.equal(restored.page.source.rows.length, 1);
  assert.equal(restored.page.status.type, "cached");
  const other = loadPage(null, app.storage);
  other.elements.get("yoyThresholdInput").value = "500";
  other.page.restoreSavedSource();
  assert.equal(other.page.source.rows.length, 0);
  app.page.writeStoredData("snapshot", { savedAt: app.now() - 86400001, source });
  const expired = loadPage(null, app.storage);
  expired.page.restoreSavedSource();
  assert.equal(expired.page.source.rows.length, 0);
});

test("source ID and link track the returned query ID without a hard-coded fallback", () => {
  const app = loadPage(null);
  const data = payload();
  data.data.xcId = "xc13c0bbe520c2003c26";
  const source = app.page.normalizeEastmoneyResponse(data, "current filters");
  app.page.applyData({ ...source, originalXcId: "old-id" }, { type: "live", error: "" });
  assert.equal(app.elements.get("sourceId").textContent, data.data.xcId);
  assert.ok(app.elements.get("sourceLink").href.includes(`id=${data.data.xcId}&`));
  app.page.applyData(app.page.normalizeEastmoneyResponse(payload(), "new filters"), { type: "live", error: "" });
  assert.equal(app.elements.get("sourceId").textContent, "-");
  assert.equal(app.elements.get("sourceLink").href, "https://xuangu.eastmoney.com/");
});
