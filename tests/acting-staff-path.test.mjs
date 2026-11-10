// Which web API paths carry the X-Acting-Staff header (bead legend-aruta).
// Loaded with plain Node ESM and built-in type stripping, like api-client.test.mjs.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ACTING_STAFF_HEADER } from "../packages/shared/src/pos/acting-staff.ts";
import {
  actingStaffHeaderFor,
  clearActingStaffToken,
  writeActingStaffToken,
} from "../apps/web/src/lib/api/acting-staff.ts";

const store = new Map();

beforeEach(() => {
  store.clear();
  globalThis.window = {
    sessionStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
      removeItem: (key) => store.delete(key),
    },
  };
  writeActingStaffToken({
    token: "pas_test",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
});

afterEach(() => {
  clearActingStaffToken();
  delete globalThis.window;
});

describe("actingStaffHeaderFor", () => {
  test("sends the token on POS paths, including the order customer route", () => {
    for (const path of [
      "/api/outlets/o1/pos/orders",
      "/api/outlets/o1/pos",
      "/api/pos-overrides/x",
      "/api/pos/orders/abc/customer",
      "/api/pos/orders/abc/customer?x=1",
    ])
      assert.deepEqual(
        actingStaffHeaderFor(path),
        { [ACTING_STAFF_HEADER]: "pas_test" },
        path,
      );
  });

  test("keeps the session owner as actor on every other path", () => {
    for (const path of [
      "/api/outlets/o1/posx",
      "/api/outlets/o1/menu",
      "/api/pos/orders/abc",
      "/api/pos/orders/abc/customer/extra",
      "/api/notes",
    ])
      assert.deepEqual(actingStaffHeaderFor(path), {}, path);
  });
});
