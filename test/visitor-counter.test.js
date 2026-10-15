const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function loadWorker() {
  const source = fs.readFileSync(path.join(__dirname, "..", "worker.js"), "utf8");
  const executable = source
    .replace('import { DurableObject } from "cloudflare:workers";', "class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }")
    .replace("export class VisitorCounter", "class VisitorCounter")
    .replace("export default", "const worker =");
  return new Function(`${executable}; return { worker, VisitorCounter };`)();
}

test("visit endpoint increments through the Durable Object namespace", async () => {
  const { worker } = loadWorker();
  let requestedName = "";
  const counter = {
    getByName(name) {
      requestedName = name;
      return { increment: async () => 8 };
    }
  };

  const response = await worker.fetch(
    new Request("https://worker.example/api/visits"),
    { VISIT_COUNTER: counter }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, count: 8 });
  assert.equal(requestedName, "site");
});

test("Durable Object counter persists and increments its value", async () => {
  const { VisitorCounter } = loadWorker();
  let storedValue = 7;
  const counter = new VisitorCounter({
    storage: {
      async get(key) {
        assert.equal(key, "count");
        return storedValue;
      },
      async put(key, value) {
        assert.equal(key, "count");
        storedValue = value;
      }
    }
  }, {});

  assert.equal(await counter.increment(), 8);
  assert.equal(storedValue, 8);
});

test("visit endpoint reports a configuration error when the Durable Object binding is missing", async () => {
  const { worker } = loadWorker();

  const response = await worker.fetch(new Request("https://worker.example/api/visits"), {});

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "Visit counter is not configured"
  });
});
