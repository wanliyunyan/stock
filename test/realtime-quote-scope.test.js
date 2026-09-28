const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const page = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const refreshLiveData = page.match(/async function refreshLiveData\(\) \{[\s\S]*?\n      \}\n\n      function showRefreshFailure/);

test("local filter note tells users to refresh realtime quotes manually", () => {
  assert.match(page, /修改条件后，请手动点击刷新以获取筛选结果的最新行情/);
});

test("realtime quotes are requested only after filtering the completed source", () => {
  assert.ok(refreshLiveData, "refreshLiveData should remain a named function");
  const source = refreshLiveData[0];

  assert.match(source, /applyData\(markPreviousPriceData\(liveSource\)/);
  assert.match(source, /getFilteredRowsForSource\(liveSource\)/);
  assert.match(source, /loadQuotes\(quoteRows\)/);
  assert.doesNotMatch(source, /const previousQuotes = loadQuotes\(activeSource\)/);
  assert.doesNotMatch(source, /fetchLiveSource\(query, supplementalQueries, isCurrent, loadQuotes\)/);
});

test("refresh sends only filtered rows to the realtime quote request", async () => {
  assert.ok(refreshLiveData, "refreshLiveData should remain a named function");
  const allRows = [
    { SECURITY_CODE: "000001", MARKET_NUM: "0", selected: false },
    { SECURITY_CODE: "000002", MARKET_NUM: "0", selected: true },
    { SECURITY_CODE: "600001", MARKET_NUM: "1", selected: false }
  ];
  const quoteRequests = [];
  const context = {
    liveInFlight: false,
    livePending: false,
    liveRequestId: 0,
    activeSource: { query: "old", rows: [] },
    dataStatus: { type: "loading", error: "" },
    refreshButton: { disabled: false, textContent: "刷新" },
    buildLiveQuery: () => "query",
    buildSupplementalMetricQueries: () => [],
    markPreviousPriceData: source => source,
    fetchLiveSource: async () => ({ query: "query", rows: allRows }),
    getFilteredRowsForSource: source => source.rows.filter(row => row.selected),
    uniqueSecurities: sourceRows => sourceRows.map(row => ({
      code: row.SECURITY_CODE,
      market: row.MARKET_NUM
    })),
    fetchRealtimeQuotes: async sourceRows => {
      quoteRequests.push(sourceRows.map(row => row.SECURITY_CODE));
      return { rows: [], errors: [] };
    },
    mergeRealtimeQuoteData: source => source,
    applyData: source => { context.activeSource = source; },
    showRefreshFailure: error => { throw error; },
    cleanError: error => String(error),
    console
  };
  vm.createContext(context);
  vm.runInContext(`${refreshLiveData[0].replace(/\n\n      function showRefreshFailure$/, "")}\nthis.runRefresh = refreshLiveData;`, context);

  await context.runRefresh();

  assert.deepEqual(quoteRequests, [["000002"]]);
});
