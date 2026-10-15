const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const page = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

test("page includes a visible visit count and loads it from the Worker", async () => {
  assert.match(page, /id="visitCount"/);
  const recordPageVisit = page.match(/async function recordPageVisit\(\) \{[\s\S]*?\n      \}/);
  assert.ok(recordPageVisit, "recordPageVisit should remain a named function");

  const visitCount = { textContent: "-" };
  const requests = [];
  const context = {
    apiBaseUrl: "https://worker.example",
    visitCount,
    stockApiUrl: pathName => `https://worker.example${pathName}`,
    fetchStockApi: async url => {
      requests.push(url);
      return { response: { ok: true }, responseText: JSON.stringify({ ok: true, count: 1234 }) };
    },
    parseJsonResponse: JSON.parse,
    cleanError: error => String(error),
    console
  };
  vm.createContext(context);
  vm.runInContext(`${recordPageVisit[0]}\nthis.runRecordPageVisit = recordPageVisit;`, context);

  await context.runRecordPageVisit();

  assert.deepEqual(requests, ["https://worker.example/api/visits"]);
  assert.equal(visitCount.textContent, "1,234");
});
