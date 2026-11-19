import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
function harness(fetchImpl = async () => new Response("fresh")) {
  const listeners = new Map();
  const stores = new Map();
  const fetches = [];
  const key = (request) => new URL(typeof request === "string" ? request : request.url, "https://tm.example").href;
  const open = async (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    return { match: async (request) => store.get(key(request))?.clone(),
      put: async (request, response) => { store.set(key(request), response); },
      addAll: async () => {} };
  };
  const cacheApi = { open, keys: async () => [...stores.keys()], delete: async (name) => stores.delete(name),
    match: async (request) => {
      for (const store of stores.values()) { const response = store.get(key(request)); if (response) return response.clone(); }
    } };
  vm.runInNewContext(source, { importScripts() {}, URL, setTimeout, clearTimeout,
    self: { location: new URL("https://tm.example"), addEventListener: (name, handler) => listeners.set(name, handler),
      clients: { claim: async () => {} }, skipWaiting() {} }, caches: cacheApi,
    fetch: async (request, init) => { fetches.push({ request, init }); return fetchImpl(request, init); } });
  return { listeners, stores, open, fetches, async navigate() {
    let response;
    const pending = [];
    listeners.get("fetch")({ request: { method: "GET", mode: "navigate", url: "https://tm.example/" },
      respondWith: (value) => { response = value; }, waitUntil: (value) => pending.push(value) });
    const result = await response;
    await Promise.all(pending);
    return result;
  } };
}

test("activation keeps the previous shell and unrelated application caches", async () => {
  const app = harness();
  for (const name of ["another-app", "tiny-messenger-shell-v7", "tiny-messenger-shell-v8", "tiny-messenger-shell-v9"]) await app.open(name);
  let done;
  app.listeners.get("activate")({ waitUntil: (promise) => { done = promise; } });
  await done;
  assert.deepEqual([...app.stores.keys()], ["another-app", "tiny-messenger-shell-v8", "tiny-messenger-shell-v9"]);
});

test("a new navigation fetches and caches the fresh shell without browser HTTP cache", async () => {
  const app = harness();
  await (await app.open("tiny-messenger-shell-v8")).put("/", new Response("old"));
  assert.equal(await (await app.navigate()).text(), "fresh");
  assert.equal(app.fetches[0].init.cache, "no-store");
  assert.equal(await (await (await app.open("tiny-messenger-shell-v9")).match("/")).text(), "fresh");
});

test("offline launch prefers the current shell over the previous version", async () => {
  const app = harness(async () => { throw Error("offline"); });
  await (await app.open("tiny-messenger-shell-v8")).put("/", new Response("old"));
  await (await app.open("tiny-messenger-shell-v9")).put("/", new Response("current"));
  assert.equal(await (await app.navigate()).text(), "current");
});

test("temporary server errors use the cached shell rather than an error page", async () => {
  const app = harness(async () => new Response("unavailable", { status: 503 }));
  await (await app.open("tiny-messenger-shell-v9")).put("/", new Response("current"));
  assert.equal(await (await app.navigate()).text(), "current");
});

test("API responses and writes are never intercepted by the shell cache", () => {
  const app = harness();
  for (const [method, url] of [["GET", "/api/sync"], ["POST", "/api/mutations"], ["GET", "https://other.example/"]]) {
    app.listeners.get("fetch")({ request: { method, mode: "navigate", url: new URL(url, "https://tm.example").href }, respondWith: () => assert.fail("must bypass cache") });
  }
  assert.equal(app.fetches.length, 0);
});
