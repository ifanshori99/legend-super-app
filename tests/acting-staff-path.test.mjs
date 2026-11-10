// Which web API paths carry the X-Acting-Staff header (bead legend-aruta).
// Loaded with plain Node ESM and built-in type stripping, like api-client.test.mjs.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  ACTING_STAFF_ERROR_CODES,
  ACTING_STAFF_HEADER,
} from "../packages/shared/src/pos/acting-staff.ts";
import {
  ACTIVE_STAFF_STORAGE_KEY,
  actingStaffHeaderFor,
  clearActingStaffToken,
  endActingStaffMode,
  handleActingStaffRejection,
  readActingStaffToken,
  releaseActingStaffToken,
  writeActingStaffToken,
} from "../apps/web/src/lib/api/acting-staff.ts";

const store = new Map();
const local = new Map();
let redirects = [];
let pathname = "/pos";

beforeEach(() => {
  store.clear();
  local.clear();
  redirects = [];
  pathname = "/pos";
  globalThis.window = {
    localStorage: {
      getItem: (key) => local.get(key) ?? null,
      setItem: (key, value) => local.set(key, value),
      removeItem: (key) => local.delete(key),
    },
    location: {
      get pathname() {
        return pathname;
      },
      assign: (to) => redirects.push(to),
    },
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

describe("actingStaffHeaderFor holds POS calls without a live cashier", () => {
  const expire = () =>
    writeActingStaffToken({
      token: "pas_old",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });

  test("an expired token holds the call, clears token and label, goes to the PIN screen", () => {
    expire();
    local.set(ACTIVE_STAFF_STORAGE_KEY, "kasir-1");
    for (const path of ["/api/outlets/o1/pos/orders", "/api/pos-overrides/x"]) {
      expire();
      local.set(ACTIVE_STAFF_STORAGE_KEY, "kasir-1");
      redirects = [];
      assert.equal(actingStaffHeaderFor(path), null, path);
      assert.deepEqual(redirects, ["/pos/ganti-pengguna"], path);
      assert.equal(store.has("legend-acting-staff"), false, path);
      assert.equal(local.has(ACTIVE_STAFF_STORAGE_KEY), false, path);
    }
  });

  test("a cashier label without a token holds the call", () => {
    clearActingStaffToken();
    local.set(ACTIVE_STAFF_STORAGE_KEY, "kasir-1");
    assert.equal(actingStaffHeaderFor("/api/outlets/o1/pos/orders"), null);
    assert.deepEqual(redirects, ["/pos/ganti-pengguna"]);
    assert.equal(local.has(ACTIVE_STAFF_STORAGE_KEY), false);
  });

  test("no token and no label (owner at the POS) sends no header", () => {
    clearActingStaffToken();
    assert.deepEqual(actingStaffHeaderFor("/api/outlets/o1/pos/orders"), {});
    assert.deepEqual(redirects, []);
  });

  test("non-POS paths are never held", () => {
    expire();
    local.set(ACTIVE_STAFF_STORAGE_KEY, "kasir-1");
    assert.deepEqual(actingStaffHeaderFor("/api/outlets/o1/menu"), {});
    clearActingStaffToken();
    assert.deepEqual(actingStaffHeaderFor("/api/notes"), {});
    assert.deepEqual(redirects, []);
  });

  test("readActingStaffToken on an expired token runs the full rejection flow", () => {
    expire();
    local.set(ACTIVE_STAFF_STORAGE_KEY, "kasir-1");
    assert.equal(readActingStaffToken(), null);
    assert.deepEqual(redirects, ["/pos/ganti-pengguna"]);
    assert.equal(local.has(ACTIVE_STAFF_STORAGE_KEY), false);
  });

  // Review K (legend-5u03q): the hold must outlive the first held call. The
  // rejection flow clears the token and the label, so without a sticky marker
  // the next POS call (Back from the PIN screen, a second query in the same
  // tick) would go out as the session owner.
  test("after a rejection every later POS call stays held until a new token", () => {
    expire();
    local.set(ACTIVE_STAFF_STORAGE_KEY, "kasir-1");
    assert.equal(actingStaffHeaderFor("/api/outlets/o1/pos/orders"), null);
    pathname = "/pos";
    assert.equal(actingStaffHeaderFor("/api/outlets/o1/pos/orders"), null);
    assert.equal(actingStaffHeaderFor("/api/pos-overrides/x"), null);
    writeActingStaffToken({
      token: "pas_new",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.deepEqual(actingStaffHeaderFor("/api/outlets/o1/pos/orders"), {
      [ACTING_STAFF_HEADER]: "pas_new",
    });
  });

  test("a token the API refused (REVOKED) also keeps later POS calls held", () => {
    handleActingStaffRejection(ACTING_STAFF_ERROR_CODES.REVOKED);
    assert.equal(actingStaffHeaderFor("/api/outlets/o1/pos/orders"), null);
  });

  test("ending cashier mode (sign-out) lets the owner use the POS again", () => {
    handleActingStaffRejection(ACTING_STAFF_ERROR_CODES.REVOKED);
    endActingStaffMode();
    redirects = [];
    assert.deepEqual(actingStaffHeaderFor("/api/outlets/o1/pos/orders"), {});
    assert.deepEqual(redirects, []);
  });

  // Review (legend-5u03q): the PIN screen issues a token, then undoes it when
  // the PIN belongs to another tile (endPosSessionCall). That undo must not
  // lift the hold and hand the POS back to the session owner.
  test("ending a pos-session (wrong-tile undo) keeps later POS calls held", () => {
    handleActingStaffRejection(ACTING_STAFF_ERROR_CODES.REVOKED);
    writeActingStaffToken({
      token: "pas_other",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    releaseActingStaffToken();
    assert.equal(actingStaffHeaderFor("/api/outlets/o1/pos/orders"), null);
  });
});
