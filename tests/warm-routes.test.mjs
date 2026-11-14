import assert from "node:assert/strict";
import { test } from "node:test";
import { selectWarmRoutes } from "../e2e/warm-routes.ts";

const defaults = ["/", "/kds"];

test("warm route selection preserves defaults and supports opting out", () => {
  assert.deepEqual(selectWarmRoutes(undefined, defaults), defaults);
  assert.deepEqual(selectWarmRoutes("none", defaults), []);
});

test("warm route selection accepts and deduplicates local paths", () => {
  assert.deepEqual(selectWarmRoutes("/kds, /kelola/pengadaan,/kds", defaults), [
    "/kds",
    "/kelola/pengadaan",
  ]);
});

test("warm route selection rejects malformed paths", () => {
  for (const value of [
    "",
    "/kds,",
    "//example.com",
    "/\\example.com",
    "https://example.com",
    "/bad path",
  ]) {
    assert.throws(() => selectWarmRoutes(value, defaults));
  }
});
