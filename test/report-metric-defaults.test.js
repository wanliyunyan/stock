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

function reportSourceWithDateMetadataOnly(period = "2026半年报") {
  const source = reportSource(period);
  source.rows = source.rows.map(row => ({
    ...row,
    "ROE_WEIGHT{2026-10-09}": "4.90",
    "XSMLL{2026-10-09}": "35.51",
    "XSJLL{2026-10-09}": "22.56"
  }));
  return source;
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

test("operating cash flow uses the current year and previous two years in Beijing time", () => {
  const context = createContext();
  const beijingNewYear = new Date("2025-12-31T16:00:00.000Z");

  assert.deepEqual(Array.from(context.cashConversionYears(beijingNewYear)), [2024, 2025, 2026]);
});

test("operating cash flow uses annual reports for prior years and the current report for this year", () => {
  const context = createContext(reportSource("2026三季报"));
  const periods = context.cashConversionPeriods(context.activeSource, new Date("2026-11-04T01:30:00.000Z"));

  assert.deepEqual(Array.from(periods, period => ({
    year: period.year,
    date: period.date,
    reportName: period.reportName
  })), [
    { year: 2024, date: "2024-12-31", reportName: "年报" },
    { year: 2025, date: "2025-12-31", reportName: "年报" },
    { year: 2026, date: "2026-09-30", reportName: "三季报" }
  ]);

  const query = context.buildCashConversionQuery("不要ST股;", periods);
  assert.match(query, /2024年年报经营活动产生的现金流量净额/);
  assert.match(query, /2025年年报经营活动产生的现金流量净额/);
  assert.match(query, /2026年三季报经营活动产生的现金流量净额/);
  assert.doesNotMatch(query, /2026年年报经营活动产生的现金流量净额/);
});

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

test("contract liability group keeps only the five most recent reporting periods", () => {
  const source = reportSource();
  source.columns.push(...[
    "2025-06-30", "2026-03-31", "2025-12-31",
    "2026-09-30", "2025-09-30", "2026-06-30"
  ].map(date => ({
    title: "合同负债",
    key: `CONTRACTLIAB{${date}}`,
    dateMsg: date.replaceAll("-", "."),
    unit: "元"
  })));
  const context = createContext(source);
  const group = context.displayGroups.find(item => item.title === "合同负债");

  assert.deepEqual(Array.from(group.children, column => column.key), [
    "CONTRACTLIAB{2026-09-30}",
    "CONTRACTLIAB{2026-06-30}",
    "CONTRACTLIAB{2026-03-31}",
    "CONTRACTLIAB{2025-12-31}",
    "CONTRACTLIAB{2025-09-30}"
  ]);
});

test("contract liability column ordering does not scan stock rows when dates are in the keys", () => {
  const source = reportSource();
  source.columns.push(...[
    "2025-06-30", "2026-03-31", "2025-12-31",
    "2026-09-30", "2025-09-30", "2026-06-30"
  ].map(date => ({
    title: "合同负债",
    key: `CONTRACTLIAB{${date}}`,
    dateMsg: date.replaceAll("-", "."),
    unit: "元"
  })));
  source.rows = source.rows.map(row => new Proxy(row, {
    get(target, key, receiver) {
      if (String(key).startsWith("CONTRACTLIAB{")) {
        throw new Error("contract liability column ordering scanned a stock row");
      }
      return Reflect.get(target, key, receiver);
    }
  }));

  const context = createContext(source);
  const group = context.displayGroups.find(item => item.title === "合同负债");

  assert.deepEqual(Array.from(group.children, column => column.key), [
    "CONTRACTLIAB{2026-09-30}",
    "CONTRACTLIAB{2026-06-30}",
    "CONTRACTLIAB{2026-03-31}",
    "CONTRACTLIAB{2025-12-31}",
    "CONTRACTLIAB{2025-09-30}"
  ]);
});

test("contract liability filter requires the current period to rank top two and exceed the five-period average", () => {
  const source = reportSource(Array(5).fill("2026三季报"));
  const dates = ["2026-09-30", "2026-06-30", "2026-03-31", "2025-12-31", "2025-09-30"];
  source.columns.push(...dates.map(date => ({
    title: "合同负债",
    key: `CONTRACTLIAB{${date}}`,
    dateMsg: date.replaceAll("-", "."),
    unit: "元"
  })));
  const cases = [
    ["max", [500, 400, 300, 200, 100]],
    ["second", [400, 500, 300, 200, 100]],
    ["third", [400, 500, 600, 0, 0]],
    ["average", [100, 100, 100, 100, 100]],
    ["missing", [500, 400, 300, 200, "-"]]
  ];
  source.rows.forEach((row, rowIndex) => {
    row.SECURITY_CODE = cases[rowIndex][0];
    dates.forEach((date, dateIndex) => {
      row[`CONTRACTLIAB{${date}}`] = cases[rowIndex][1][dateIndex];
    });
  });
  const context = createContext(source);
  context.searchInput = { value: "" };
  context.reportDisclosureSelect = { value: "reported" };
  context.sortState = { key: "", direction: "asc" };

  assert.deepEqual(
    Array.from(context.getFilteredRowsForSource(source), row => row.SECURITY_CODE),
    ["max", "second"]
  );
});

test("contract liability filtering resolves recent columns once per result set", () => {
  const source = reportSource(Array(5).fill("2026三季报"));
  const dates = ["2026-09-30", "2026-06-30", "2026-03-31", "2025-12-31", "2025-09-30"];
  source.columns.push(...dates.map(date => ({
    title: "合同负债",
    key: `CONTRACTLIAB{${date}}`,
    dateMsg: date.replaceAll("-", "."),
    unit: "元"
  })));
  source.rows.forEach((row, rowIndex) => {
    row.SECURITY_CODE = String(rowIndex + 1);
    dates.forEach((date, dateIndex) => {
      row[`CONTRACTLIAB{${date}}`] = 500 - dateIndex * 100;
    });
  });
  let columnResolutionCount = 0;
  Object.defineProperty(source.columns, "flatMap", {
    configurable: true,
    value(...args) {
      columnResolutionCount += 1;
      return Array.prototype.flatMap.apply(this, args);
    }
  });
  const context = createContext(source);
  context.searchInput = { value: "" };
  context.reportDisclosureSelect = { value: "reported" };
  context.sortState = { key: "", direction: "asc" };

  const filtered = context.getFilteredRowsForSource(source);

  assert.equal(filtered.length, 5);
  assert.equal(columnResolutionCount, 1);
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

test("ROE default follows the latest period when the page shows reported rows", () => {
  const context = createContext(reportSource(["2026三季报", "2026半年报"]));
  context.reportDisclosureSelect = { value: "reported" };

  context.setDefaultRoeFilter();

  assert.equal(context.numericFilters[0].minInput.value, "7.5");
});

test("ROE default stays on the reported period when one reported row has older ROE data", () => {
  const source = reportSource(["2026三季报", "2026三季报"]);
  source.rows[1]["ROE_WEIGHT{2026-10-09}"] = "-5.47|2026一季报";
  source.rows[1]["ROE_WEIGHT{2026-10-09}&&DATE"] = "2026一季报";
  const context = createContext(source);
  context.reportDisclosureSelect = { value: "reported" };

  context.setDefaultRoeFilter();

  assert.equal(context.numericFilters[0].minInput.value, "7.5");
});

test("ROE default ignores an older outlier until the latest report period is complete", () => {
  const context = createContext(reportSource(["2026三季报", "2026一季报"]));
  context.setDefaultRoeFilter();
  assert.equal(context.numericFilters[0].minInput.value, "5");
});

test("ROE default reads the companion report-date column when metric values have no suffix", () => {
  const mixedContext = createContext(reportSourceWithDateMetadataOnly(["2026三季报", "2026半年报"]));
  mixedContext.setDefaultRoeFilter();
  assert.equal(mixedContext.numericFilters[0].minInput.value, "5");

  const completeContext = createContext(reportSourceWithDateMetadataOnly(["2026三季报", "2026三季报"]));
  completeContext.setDefaultRoeFilter();
  assert.equal(completeContext.numericFilters[0].minInput.value, "7.5");
});

test("ROE default falls back one period when a row has no report-date value", () => {
  const source = reportSource(["2026三季报", "2026三季报"]);
  source.rows[1]["ROE_WEIGHT{2026-10-09}"] = "4.90";
  source.rows[1]["ROE_WEIGHT{2026-10-09}&&DATE"] = "";
  const context = createContext(source);
  context.setDefaultRoeFilter();
  assert.equal(context.numericFilters[0].minInput.value, "5");
});

test("report disclosure filter separates the latest reporting period from earlier periods", () => {
  const source = reportSource(["2026三季报", "2026半年报", "2026三季报"]);
  source.rows.forEach((row, index) => { row.SECURITY_CODE = String(index + 1); });
  const context = createContext(source);

  assert.deepEqual(
    Array.from(context.filterRowsByReportDisclosure(source, source.rows, "reported"), row => row.SECURITY_CODE),
    ["1", "3"]
  );
  assert.deepEqual(
    Array.from(context.filterRowsByReportDisclosure(source, source.rows, "pending"), row => row.SECURITY_CODE),
    ["2"]
  );
});

test("report disclosure filter treats rows without the latest report period as pending", () => {
  const source = reportSourceWithDateMetadataOnly(["2026三季报", "2026半年报", "2026三季报"]);
  source.rows.forEach((row, index) => { row.SECURITY_CODE = String(index + 1); });
  source.rows[2]["ROE_WEIGHT{2026-10-09}&&DATE"] = "";
  source.rows[2]["XSMLL{2026-10-09}&&DATE"] = "";
  source.rows[2]["XSJLL{2026-10-09}&&DATE"] = "";
  const context = createContext(source);

  assert.deepEqual(
    Array.from(context.filterRowsByReportDisclosure(source, source.rows, "reported"), row => row.SECURITY_CODE),
    ["1"]
  );
  assert.deepEqual(
    Array.from(context.filterRowsByReportDisclosure(source, source.rows, "pending"), row => row.SECURITY_CODE),
    ["2", "3"]
  );
});

test("report-dated group titles follow the rows selected by disclosure status", () => {
  const periods = ["2026三季报", "2026半年报"];
  const source = reportSource(periods);
  source.columns.push(
    { title: "合同负债同比增长率", key: "CONTRACTLIAB同比增长率{2026-10-23}", dateMsg: "截至2026.10.23最新", unit: "%" },
    { title: "合同负债环比增长率", key: "CONTRACTLIAB环比增长率{2026-10-23}", dateMsg: "截至2026.10.23最新", unit: "%" }
  );
  source.rows.forEach((row, index) => {
    row["CONTRACTLIAB同比增长率{2026-10-23}"] = `40|${periods[index]}`;
    row["CONTRACTLIAB环比增长率{2026-10-23}"] = `30|${periods[index]}`;
  });
  const context = createContext(source);
  const pendingRows = context.filterRowsByReportDisclosure(source, source.rows, "pending");
  const reportGroup = context.displayGroups.find(group =>
    group.children?.some(column => String(column.key).startsWith("ROE_WEIGHT"))
  );
  const growthGroup = context.displayGroups.find(group =>
    group.children?.every(column => context.isGrowthRateColumn(column.key))
  );

  assert.equal(context.displayGroupTitle(reportGroup, pendingRows), "2026.6.30");
  assert.equal(context.displayGroupTitle(growthGroup, pendingRows), "合同负债 2026.6.30");
  context.sortState = { key: "", direction: "asc" };
  const header = context.renderHeader(pendingRows);
  assert.match(header, />2026\.6\.30</);
  assert.match(header, />合同负债 2026\.6\.30</);
  assert.doesNotMatch(header, />2026\.9\.30</);
});
