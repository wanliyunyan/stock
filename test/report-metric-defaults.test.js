const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const page = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const functions = page.match(/^      (?:async )?function \w+\([^\n]*\) \{[\s\S]*?^      \}/gm).join("\n");
const constants = [
  "cashConversionKey", "realtimeQuoteKeys", "reportMetricPrefixes",
  "dividendMetricPrefixes", "valuationPercentilePrefixes", "intervalChangeDays", "hiddenKeys"
].map(name => page.match(new RegExp(`      const ${name} = [\\s\\S]*?;`))[0]).join("\n");

// Eastmoney returns an extra report-date column alongside each numeric metric.
// Its query date is newer than the actual reporting period in the numeric cell.
function reportSource(period = "2026半年报") {
  const periods = Array.isArray(period) ? period : [period];
  return {
    columns: [
      { title: "加权净资产收益率ROE", key: "ROE_WEIGHT{2026-10-09}", dateMsg: "截至2026.10.09最新", unit: "%" },
      { title: "加权净资产收益率ROE更新时间", key: "ROE_WEIGHT{2026-10-09}&&DATE", dateMsg: "截至2026.10.09最新", unit: "" },
      { title: "销售毛利率", key: "XSMLL{2026-10-09}", dateMsg: "截至2026.10.09最新", unit: "%" },
      { title: "销售毛利率更新时间", key: "XSMLL{2026-10-09}&&DATE", dateMsg: "截至2026.10.09最新", unit: "" },
      { title: "销售净利率", key: "XSJLL{2026-10-09}", dateMsg: "截至2026.10.09最新", unit: "%" },
      { title: "销售净利率更新时间", key: "XSJLL{2026-10-09}&&DATE", dateMsg: "截至2026.10.09最新", unit: "" }
    ],
    rows: periods.map(reportPeriod => ({
      "ROE_WEIGHT{2026-10-09}": `4.90|${reportPeriod}`,
      "ROE_WEIGHT{2026-10-09}&&DATE": reportPeriod,
      "XSMLL{2026-10-09}": `35.51|${reportPeriod}`,
      "XSMLL{2026-10-09}&&DATE": reportPeriod,
      "XSJLL{2026-10-09}": `22.56|${reportPeriod}`,
      "XSJLL{2026-10-09}&&DATE": reportPeriod
    }))
  };
}

function createContext(source = reportSource()) {
  const numericFilters = [
    { id: "roe", keyPrefix: "ROE_WEIGHT", scale: 1, minInput: { value: "" }, maxInput: { value: "" } }
  ];
  const context = vm.createContext({
    rows: source.rows,
    activeSource: source,
    numericFilters,
    localNumericFilters: numericFilters,
    lastDefaultRoeValue: null
  });
  vm.runInContext(`${constants}\n${functions}`, context);
  context.displayGroups = context.buildDisplayGroups(source.columns);
  context.leafColumns = context.displayGroups.flatMap(group => group.children || [group.column]);
  return context;
}

test("report columns display numeric metrics instead of update-date metadata", () => {
  const context = createContext();
  assert.deepEqual(Array.from(context.leafColumns, column => column.key), [
    "ROE_WEIGHT{2026-10-09}", "XSMLL{2026-10-09}", "XSJLL{2026-10-09}"
  ]);
  assert.equal(context.displayGroups[0].title, "2026.6.30");
  const row = context.rows[0];
  assert.deepEqual(Array.from(context.leafColumns, column => context.formatValue(row[column.key], column, row)), [
    '<span class="cell-main">4.90%</span>',
    '<span class="cell-main">35.51%</span>',
    '<span class="cell-main">22.56%</span>'
  ]);
});

test("ROE default follows the actual reporting period even with newer update-date columns", () => {
  for (const [period, expected] of [
    ["2026一季报", "2.5"], ["2026半年报", "5"], ["2026三季报", "7.5"], ["2025年报", "10"]
  ]) {
    const context = createContext(reportSource(period));
    context.setDefaultRoeFilter();
    assert.equal(context.numericFilters[0].minInput.value, expected, period);
  }
});

test("ROE filtering uses the numeric column even when date metadata is listed first", () => {
  const source = reportSource();
  source.columns.reverse();
  const context = createContext(source);
  const filter = context.numericFilters[0];
  filter.minInput.value = "5";
  const keys = { roe: context.findFilterColumnKey(filter, source) };
  assert.equal(context.passesNumericFilters(source.rows[0], keys), false);
  assert.equal(context.passesNumericFilters({ ...source.rows[0], "ROE_WEIGHT{2026-10-09}": "5.00|2026半年报" }, keys), true);
});

test("refresh preserves manually changed or cleared ROE defaults", () => {
  for (const value of ["6", ""]) {
    const context = createContext();
    context.setDefaultRoeFilter();
    context.numericFilters[0].minInput.value = value;
    context.setDefaultRoeFilter();
    assert.equal(context.numericFilters[0].minInput.value, value);
  }
});

test("untouched ROE defaults advance when a new reporting period arrives", () => {
  const context = createContext();
  context.setDefaultRoeFilter();
  context.rows = reportSource("2026三季报").rows;
  context.setDefaultRoeFilter();
  assert.equal(context.numericFilters[0].minInput.value, "7.5");
});

test("ROE default waits for every row to reach the current reporting period", () => {
  const mixedContext = createContext(reportSource(["2026三季报", "2026半年报"]));
  mixedContext.setDefaultRoeFilter();
  assert.equal(mixedContext.numericFilters[0].minInput.value, "5");

  const completeContext = createContext(reportSource(["2026三季报", "2026三季报"]));
  completeContext.setDefaultRoeFilter();
  assert.equal(completeContext.numericFilters[0].minInput.value, "7.5");
});
