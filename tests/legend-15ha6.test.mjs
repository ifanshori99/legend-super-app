// legend-15ha6: every outlet floor operation keeps the selected cashier.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { ACTING_STAFF_HEADER } from "../packages/shared/src/pos/acting-staff.ts";
import {
  ACTIVE_STAFF_STORAGE_KEY,
  actingStaffHeaderFor,
  endActingStaffMode,
  writeActingStaffToken,
} from "../apps/web/src/lib/api/acting-staff.ts";

const session = new Map();
const local = new Map();
let redirects;
const paths = [
  "/api/floor",
  "/api/floor?status=active",
  "/api/floor/zones/zone1",
  "/api/tables",
  "/api/tables/table1",
  "/api/table-links",
  "/api/table-links/link1/rotate",
  "/api/table-sessions",
  "/api/table-sessions/session1/close",
  "/api/outlets/o1/kitchen",
  "/api/outlets/o1/kitchen/tickets/ticket1/status",
];

beforeEach(() => {
  session.clear();
  local.clear();
  redirects = [];
  globalThis.window = {
    location: { pathname: "/pos", assign: (path) => redirects.push(path) },
    sessionStorage: {
      getItem: (key) => session.get(key) ?? null,
      setItem: (key, value) => session.set(key, value),
      removeItem: (key) => session.delete(key),
    },
    localStorage: {
      getItem: (key) => local.get(key) ?? null,
      setItem: (key, value) => local.set(key, value),
      removeItem: (key) => local.delete(key),
    },
  };
  writeActingStaffToken({
    token: "pas_floor_cashier",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
});

afterEach(() => {
  endActingStaffMode();
  delete globalThis.window;
});

test("legend-15ha6 sends the active cashier on floor reads and mutations", () => {
  for (const path of paths)
    for (const method of ["GET", "POST", "PATCH", "DELETE"])
      assert.deepEqual(
        actingStaffHeaderFor(path, method),
        { [ACTING_STAFF_HEADER]: "pas_floor_cashier" },
        `${method} ${path}`,
      );
});

test("legend-15ha6 respects route boundaries and unrelated outlet routes", () => {
  for (const path of [
    "/api/flooring",
    "/api/tables-extra",
    "/api/table-links-other",
    "/api/table-sessions-other",
    "/api/outlets/o1/kitchenette",
    "/api/outlets/o1/menu",
    "/api/outlets//kitchen",
    "/api/tenants/t1/floor",
  ])
    assert.deepEqual(actingStaffHeaderFor(path, "POST"), {}, path);
});

test("legend-15ha6 expired cashier reads freely but holds floor mutations", () => {
  writeActingStaffToken({
    token: "pas_expired",
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
  });
  local.set(ACTIVE_STAFF_STORAGE_KEY, "cashier1");
  for (const path of paths)
    assert.deepEqual(actingStaffHeaderFor(path, "GET"), {}, path);
  assert.deepEqual(redirects, []);
  assert.equal(local.get(ACTIVE_STAFF_STORAGE_KEY), "cashier1");
  for (const path of paths)
    assert.equal(actingStaffHeaderFor(path, "POST"), null, path);
  assert.ok(redirects.every((path) => path === "/pos/ganti-pengguna"));
  assert.equal(local.has(ACTIVE_STAFF_STORAGE_KEY), false);
});

test("legend-15ha6 owner mode keeps floor routes without a cashier header", () => {
  endActingStaffMode();
  for (const path of paths)
    assert.deepEqual(actingStaffHeaderFor(path, "POST"), {}, path);
  assert.deepEqual(redirects, []);
});
