const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function loadPage(fetch = async () => { throw new Error("offline"); }) {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const elements = new Map();
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) elements.set(id, { value: "" });
  const context = vm.createContext({
    document: { getElementById: id => elements.get(id), querySelectorAll: () => [] },
    location: { protocol: "http:", hostname: "localhost", search: "" },
    window: { localStorage: { getItem: () => null }, setTimeout, clearTimeout },
    URLSearchParams, AbortController, fetch, console: { warn() {} }
  });
  // Expose page functions before startup; no DOM or network side effects in unit tests.
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(
    '      applyData(emptySource, { type: "loading", error: "" });',
    `      globalThis.page = {
      cashConversionKey, cashConversionYears, buildCashConversionQuery,
      calculateCashConversion, annualCashConversionValue, addCashConversionMetric,
      fetchCashConversionData, formatValue, renderHeaderCell, buildDisplayGroups,
      normalizeEastmoneyResponse, getFilteredRows, clearNumericFilters,
      setSource(source) {
        activeSource = source;
        rows = source.rows;
        filterKeys = Object.fromEntries(numericFilters.map(filter => [filter.id, findFilterColumnKey(filter)]));
      },
      setSort(direction) { sortState = { key: cashConversionKey, direction }; }
    }; return;`
  );
  vm.runInContext(script, context);
  return { page: context.page, elements };
}

const years = [2023, 2024, 2025];
function annualRow(cash = [100, 200, 300], profit = [50, 100, 150], code = "600001") {
  const row = { SECURITY_CODE: code };
  years.forEach((year, i) => {
    row[`NETOPERATECASHFLOW{${year}-12-31}`] = cash[i];
    row[`NETPROFIT{${year}-12-31}`] = profit[i];
  });
  return row;
}

test("divides cumulative amounts, not the average of annual ratios", () => {
  const { page } = loadPage();
  const result = page.calculateCashConversion(annualRow([100, 100, 100], [10, 20, 70]), years);
  assert.equal(result.value, 3);
  assert.equal(result.cashFlow, 300);
  assert.equal(result.netProfit, 100);
});

test("uses consolidated net profit and never substitutes parent profit", () => {
  const { page } = loadPage();
  const row = annualRow();
  years.forEach(year => { row[`PARENT_NETPROFIT{${year}-12-31}`] = 1; });
  assert.equal(page.calculateCashConversion(row, years).value, 2);
  delete row["NETPROFIT{2024-12-31}"];
  assert.equal(page.calculateCashConversion(row, years).value, null);
});

test("requires all six annual amounts and does not substitute interim or older reports", () => {
  const { page } = loadPage();
  const row = annualRow();
  delete row["NETOPERATECASHFLOW{2025-12-31}"];
  row["NETOPERATECASHFLOW{2025-06-30}"] = 300;
  row["NETOPERATECASHFLOW{2022-12-31}"] = 300;
  const result = page.calculateCashConversion(row, years);
  assert.equal(result.value, null);
  assert.equal(result.status, "数据不全");
  assert.match(result.detail, /2025/);
});

test("parses provider amount units and validates the report period", () => {
  const { page } = loadPage();
  const read = value => page.annualCashConversionValue({ "NETPROFIT{2025-12-31}": value }, "NETPROFIT", 2025);
  assert.equal(read("1.20亿|2025年报"), 120000000);
  assert.equal(read("1,234.50万元|2025年报"), 12345000);
  assert.equal(read("-1.2万亿|2025年报"), -1.2e12);
  assert.equal(read("1e8"), 1e8);
  assert.equal(read("0|2025年报"), 0);
  for (const value of [null, "-", "", "未披露2025年报", "1亿|2025半年报", "1亿|2024年报", Infinity]) {
    assert.ok(Number.isNaN(read(value)), String(value));
  }
});

test("nonpositive cumulative profit is inapplicable; negative and zero cash flow remain valid", () => {
  const { page } = loadPage();
  for (const profit of [[-100, 0, 100], [-10, -20, -30]]) {
    const result = page.calculateCashConversion(annualRow(undefined, profit), years);
    assert.equal(result.value, null);
    assert.equal(result.status, "不适用");
  }
  assert.equal(page.calculateCashConversion(annualRow([-100, -200, -300]), years).value, -2);
  assert.equal(page.calculateCashConversion(annualRow([0, 0, 0]), years).value, 0);
  assert.equal(page.calculateCashConversion(annualRow([100, 100, 100], [-100, 100, 100]), years).value, 3);
});

test("year window follows Shanghai calendar and requests only complete annual periods", () => {
  const { page } = loadPage();
  assert.equal(JSON.stringify(page.cashConversionYears(new Date("2026-09-09T00:00:00Z"))), "[2023,2024,2025]");
  assert.equal(JSON.stringify(page.cashConversionYears(new Date("2026-12-31T16:00:00Z"))), "[2024,2025,2026]");
  const query = page.buildCashConversionQuery("不要ST股;", years);
  assert.ok(query.startsWith("不要ST股;"));
  for (const year of years) {
    assert.ok(query.includes(`${year}年年报经营活动产生的现金流量净额;`));
    assert.ok(query.includes(`${year}年年报净利润;`));
  }
  assert.ok(!query.includes(";;"));
});

test("joins annual data by stock code and preserves the original stock universe", () => {
  const { page } = loadPage();
  const source = { columns: [], rows: [{ SECURITY_CODE: "600001" }, { SECURITY_CODE: "600002" }] };
  const data = { rows: [annualRow(undefined, undefined, "600002"), annualRow(undefined, undefined, "600003")], failed: false };
  const result = page.addCashConversionMetric(source, data, years);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0][page.cashConversionKey], null);
  assert.equal(result.rows[1][page.cashConversionKey], 2);
  assert.equal(result.columns.length, 4);
  assert.equal(source.columns.length, 0);
  assert.equal(source.rows[1][page.cashConversionKey], undefined);
});

test("range filters use multiples, exclude unavailable values, and reset", () => {
  const { page, elements } = loadPage();
  const source = { columns: [{ key: page.cashConversionKey }], rows: [
    { SECURITY_CODE: "600001", [page.cashConversionKey]: 0.8 },
    { SECURITY_CODE: "600002", [page.cashConversionKey]: 1 },
    { SECURITY_CODE: "600003", [page.cashConversionKey]: 1.5 },
    { SECURITY_CODE: "600004", [page.cashConversionKey]: null }
  ] };
  page.setSource(source);
  assert.equal(page.getFilteredRows().length, 4);
  elements.get("cashConversionMinInput").value = "1";
  elements.get("cashConversionMaxInput").value = "1.5";
  assert.equal(page.getFilteredRows().map(row => row.SECURITY_CODE).join(","), "600002,600003");
  page.clearNumericFilters();
  assert.equal(page.getFilteredRows().length, 4);
});

test("unavailable ratios sort last in both directions, including zero and negative ratios", () => {
  const { page } = loadPage();
  page.setSource({ columns: [{ key: page.cashConversionKey }], rows: [null, 2, -1, 0].map(value => ({ [page.cashConversionKey]: value })) });
  page.setSort("asc");
  assert.equal(JSON.stringify(page.getFilteredRows().map(row => row[page.cashConversionKey])), "[-1,0,2,null]");
  page.setSort("desc");
  assert.equal(JSON.stringify(page.getFilteredRows().map(row => row[page.cashConversionKey])), "[2,0,-1,null]");
});

test("shows annual period, ratio units, calculation details and explicit missing states", () => {
  const { page } = loadPage();
  const result = page.addCashConversionMetric({ columns: [], rows: [{ SECURITY_CODE: "600001" }] }, { rows: [annualRow()], failed: false }, years);
  const column = result.columns.find(item => item.key === page.cashConversionKey);
  const row = result.rows[0];
  assert.match(page.renderHeaderCell(column, true, ""), /2023—2025年报/);
  assert.match(page.formatValue(row[page.cashConversionKey], column, row), /2\.00倍/);
  assert.match(page.formatValue(row[page.cashConversionKey], column, row), /合并净利润合计/);
  const failed = page.addCashConversionMetric(result, { rows: [], failed: true }, years);
  assert.equal(failed.columns.length, 4);
  assert.match(page.formatValue(null, column, failed.rows[0]), /加载失败/);
  const groups = page.buildDisplayGroups(result.columns);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, "经营活动现金流");
  assert.equal(groups[0].children.map(item => item.title).join(","), "2023,2024,2025,累计净现比");
  assert.match(page.formatValue(row[result.columns[0].key], result.columns[0], row), />100元</);
  assert.match(page.formatValue(-120000000, result.columns[0], row), />-1\.2亿元</);
  assert.match(page.formatValue(0, result.columns[0], row), />0元</);
  assert.equal(page.formatValue(null, result.columns[0], row), "数据不全");
  assert.equal(page.formatValue(null, failed.columns[0], failed.rows[0]), "加载失败");
});

test("annual-data request failures do not fail the stock table", async () => {
  const { page } = loadPage();
  const result = await page.fetchCashConversionData({ query: "测试;", rows: [{ SECURITY_CODE: "600001" }] }, years);
  assert.equal(result.failed, true);
  assert.equal(result.rows.length, 0);
});

test("live provider annual records calculate without a new Worker route", { skip: !process.env.STOCK_CASH_CONVERSION_FIXTURE }, () => {
  const { page } = loadPage();
  const response = JSON.parse(fs.readFileSync(process.env.STOCK_CASH_CONVERSION_FIXTURE, "utf8").replace(/^\uFEFF/, ""));
  const source = page.normalizeEastmoneyResponse(response, "live verification");
  const result = page.addCashConversionMetric({ ...source, columns: [] }, { rows: source.rows, failed: false }, years);
  assert.ok(result.rows.length > 0);
  assert.ok(result.rows.some(row => Number.isFinite(row[page.cashConversionKey])));
  for (const row of result.rows) {
    assert.ok(row.cashConversionDetails);
    if (row[page.cashConversionKey] !== null) {
      assert.ok(row.cashConversionDetails.netProfit > 0);
      assert.equal(row[page.cashConversionKey], row.cashConversionDetails.cashFlow / row.cashConversionDetails.netProfit);
    }
  }
});
