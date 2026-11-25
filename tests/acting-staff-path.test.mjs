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
      // legend-1268 bug 6: points and ticket routes, and B1 walk-in seating.
      "/api/pos/orders/abc/points",
      "/api/pos/orders/abc/points/quote",
      "/api/pos/orders/abc/points/redeem",
      "/api/pos/orders/abc/tickets",
      "/api/pos/orders/abc/tickets/t1/credential",
      "/api/outlets/o1/tables/t1/staff-session",
      "/api/facility/tickets/pos",
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
      "/api/pos/orders/abc/points/extra",
      "/api/pos/orders/abc/tickets/t1",
      "/api/outlets/o1/tables/t1",
      "/api/outlets/o1/tables/t1/staff-session/extra",
      "/api/facility/tickets/pos/extra",
      "/api/notes",
    ])
      assert.deepEqual(actingStaffHeaderFor(path), {}, path);
  });
});

describe("actingStaffHeaderFor holds POS mutations without a live cashier", () => {
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
      assert.equal(actingStaffHeaderFor(path, "POST"), null, path);
      assert.deepEqual(redirects, ["/pos/ganti-pengguna"], path);
      assert.equal(store.has("legend-acting-staff"), false, path);
      assert.equal(local.has(ACTIVE_STAFF_STORAGE_KEY), false, path);
    }
  });

  test("a cashier label without a token holds the call", () => {
    clearActingStaffToken();
    local.set(ACTIVE_STAFF_STORAGE_KEY, "kasir-1");
    assert.equal(
      actingStaffHeaderFor("/api/outlets/o1/pos/orders", "POST"),
      null,
    );
    assert.deepEqual(redirects, ["/pos/ganti-pengguna"]);
    assert.equal(local.has(ACTIVE_STAFF_STORAGE_KEY), false);
  });

  test("no token and no label (owner at the POS) sends no header", () => {
    clearActingStaffToken();
    assert.deepEqual(
      actingStaffHeaderFor("/api/outlets/o1/pos/orders", "POST"),
      {},
    );
    assert.deepEqual(redirects, []);
  });

  test("non-POS paths are never held", () => {
    expire();
    local.set(ACTIVE_STAFF_STORAGE_KEY, "kasir-1");
    assert.deepEqual(actingStaffHeaderFor("/api/outlets/o1/menu", "POST"), {});
    clearActingStaffToken();
    assert.deepEqual(actingStaffHeaderFor("/api/notes", "POST"), {});
    assert.deepEqual(redirects, []);
  });

  // Review K (legend-5u03q): the hold must outlive the first held call. The
  // rejection flow clears the token and the label, so without a sticky marker
  // the next POS call (Back from the PIN screen, a second query in the same
  // tick) would go out as the session owner.
  test("after a rejection every later POS call stays held until a new token", () => {
    expire();
    local.set(ACTIVE_STAFF_STORAGE_KEY, "kasir-1");
    assert.equal(
      actingStaffHeaderFor("/api/outlets/o1/pos/orders", "POST"),
      null,
    );
    pathname = "/pos";
    assert.equal(
      actingStaffHeaderFor("/api/outlets/o1/pos/orders", "POST"),
      null,
    );
    assert.equal(actingStaffHeaderFor("/api/pos-overrides/x", "POST"), null);
    writeActingStaffToken({
      token: "pas_new",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.deepEqual(
      actingStaffHeaderFor("/api/outlets/o1/pos/orders", "POST"),
      {
        [ACTING_STAFF_HEADER]: "pas_new",
      },
    );
  });

  test("a token the API refused (REVOKED) also keeps later POS calls held", () => {
    handleActingStaffRejection(ACTING_STAFF_ERROR_CODES.REVOKED);
    assert.equal(
      actingStaffHeaderFor("/api/outlets/o1/pos/orders", "POST"),
      null,
    );
  });

  test("ending cashier mode (sign-out) lets the owner use the POS again", () => {
    handleActingStaffRejection(ACTING_STAFF_ERROR_CODES.REVOKED);
    endActingStaffMode();
    redirects = [];
    assert.deepEqual(
      actingStaffHeaderFor("/api/outlets/o1/pos/orders", "POST"),
      {},
    );
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
    assert.equal(
      actingStaffHeaderFor("/api/outlets/o1/pos/orders", "POST"),
      null,
    );
  });
});

// legend-5u03q follow-up: only mutations are held. Reads (the customer display
// in a second window, order boards) never wait for a PIN and never wipe the
// cashier tab's label; they carry the token only while it is live.
describe("actingStaffHeaderFor never holds POS reads", () => {
  const display = "/api/outlets/o1/pos/customer-display";

  test("a second window with the cashier label and no token reads freely", () => {
    clearActingStaffToken();
    local.set(ACTIVE_STAFF_STORAGE_KEY, "kasir-1");
    assert.deepEqual(actingStaffHeaderFor(display, "GET"), {});
    assert.deepEqual(redirects, []);
    assert.equal(local.get(ACTIVE_STAFF_STORAGE_KEY), "kasir-1");
  });

  test("an expired token is not sent on a read, and the read is not held", () => {
    writeActingStaffToken({
      token: "pas_old",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    local.set(ACTIVE_STAFF_STORAGE_KEY, "kasir-1");
    assert.deepEqual(actingStaffHeaderFor(display), {});
    assert.deepEqual(redirects, []);
  });

  test("reads go through while the tab's hold is set; mutations stay held", () => {
    handleActingStaffRejection(ACTING_STAFF_ERROR_CODES.REVOKED);
    redirects = [];
    assert.deepEqual(actingStaffHeaderFor(display, "GET"), {});
    assert.deepEqual(redirects, []);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      assert.equal(
        actingStaffHeaderFor("/api/outlets/o1/pos/orders", method),
        null,
        method,
      );
  });

  test("a live token is still sent on reads", () => {
    assert.deepEqual(actingStaffHeaderFor(display, "GET"), {
      [ACTING_STAFF_HEADER]: "pas_test",
    });
  });

  test("a read the API refused drops the tab's token quietly: no PIN screen, label kept", () => {
    local.set(ACTIVE_STAFF_STORAGE_KEY, "kasir-1");
    handleActingStaffRejection(ACTING_STAFF_ERROR_CODES.REVOKED, "GET");
    assert.deepEqual(redirects, []);
    assert.equal(local.get(ACTIVE_STAFF_STORAGE_KEY), "kasir-1");
    assert.equal(store.has("legend-acting-staff"), false);
    assert.deepEqual(actingStaffHeaderFor(display, "GET"), {});
    assert.equal(
      actingStaffHeaderFor("/api/outlets/o1/pos/orders", "POST"),
      null,
    );
  });

  test("ending cashier mode (sign-in) also lifts a leftover cashier label", () => {
    clearActingStaffToken();
    local.set(ACTIVE_STAFF_STORAGE_KEY, "kasir-1");
    endActingStaffMode();
    assert.deepEqual(
      actingStaffHeaderFor("/api/outlets/o1/pos/orders", "POST"),
      {},
    );
    assert.deepEqual(redirects, []);
  });

  test("readActingStaffToken on an expired token never redirects or wipes the label", () => {
    writeActingStaffToken({
      token: "pas_old",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    local.set(ACTIVE_STAFF_STORAGE_KEY, "kasir-1");
    redirects = [];
    assert.equal(readActingStaffToken(), null);
    assert.deepEqual(redirects, []);
    assert.equal(local.get(ACTIVE_STAFF_STORAGE_KEY), "kasir-1");
    assert.equal(
      actingStaffHeaderFor("/api/outlets/o1/pos/orders", "POST"),
      null,
    );
  });
});
