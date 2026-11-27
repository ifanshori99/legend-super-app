// O5 follow-up and review K P3 2 and 3: the service worker keeps the /pos
// chunks the build lists, revalidates that list, and when the cache is over
// its limit drops other deploys' leftovers before this deploy's files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

function worker(initial) {
  const listeners = new Map();
  const store = new Map(
    initial.map((path) => [`https://t.test${path}`, "old"]),
  );
  const fetched = [];
  const cache = {
    match: async (key) => (store.has(String(key)) ? "hit" : undefined),
    put: async (key, value) => store.set(String(key), value),
    delete: async (request) => store.delete(request.url),
    keys: async () => [...store.keys()].map((url) => ({ url })),
  };
  const responses = {
    "/pos-precache.json": JSON.stringify(["/assets/a-1.js", "/assets/b-1.js"]),
  };
  runInNewContext(readFileSync("apps/web/public/sw.js", "utf8"), {
    URL,
    Set,
    Map,
    Array,
    Math,
    Date,
    Promise,
    Response,
    self: {
      addEventListener: (name, callback) => listeners.set(name, callback),
      location: { origin: "https://t.test" },
      skipWaiting() {},
    },
    caches: { open: async () => cache, keys: async () => [] },
    fetch: async (url, init) => {
      fetched.push({ path: new URL(url).pathname, init });
      const path = new URL(url).pathname;
      const body = responses[path] ?? "js";
      return {
        ok: true,
        type: "basic",
        redirected: false,
        headers: { get: () => null },
        json: async () => JSON.parse(body),
        text: async () => body,
        clone() {
          return this;
        },
      };
    },
  });
  return { listeners, store, fetched };
}

test("install keeps the listed chunks and revalidates the list", async () => {
  const { listeners, store, fetched } = worker([]);
  let pending;
  listeners.get("install")({ waitUntil: (p) => (pending = p) });
  await pending;
  const list = fetched.find((call) => call.path === "/pos-precache.json");
  assert.equal(list.init.cache, "no-cache");
  assert.equal(list.init.credentials, "omit");
  assert.ok(store.has("https://t.test/assets/a-1.js"));
  assert.ok(store.has("https://t.test/assets/b-1.js"));
});

test("over the limit, other deploys' leftovers go before this deploy's files", async () => {
  const stale = Array.from({ length: 1199 }, (_, i) => `/assets/old-${i}.js`);
  // The listed files were kept first (the oldest entries), then 1199 files of
  // an older deploy: 1201 in all, one over the limit of 1200. Oldest-first
  // trimming would drop a listed file; the live ones must stay.
  const { listeners, store } = worker([
    "/assets/a-1.js",
    "/assets/b-1.js",
    ...stale,
  ]);
  let pending;
  listeners.get("install")({ waitUntil: (p) => (pending = p) });
  await pending;
  assert.ok(store.has("https://t.test/assets/a-1.js"), "listed file kept");
  assert.ok(store.has("https://t.test/assets/b-1.js"), "listed file kept");
  assert.equal(store.has("https://t.test/assets/old-0.js"), false);
});
