// legend-15ha6: every outlet floor operation keeps the selected cashier.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { ACTING_STAFF_HEADER } from "../packages/shared/src/pos/acting-staff.ts";
import {
  ACTIVE_STAFF_STORAGE_KEY,
  actingStaffHeaderFor,
  clearActingStaffToken,
  endActingStaffMode,
  readActingStaffToken,
  releaseActingStaffToken,
  writeActingStaffToken,
} from "../apps/web/src/lib/api/acting-staff.ts";
import {
  bearerHeaderFor,
  registerBearerProvider,
} from "../apps/web/src/lib/api/credentials.ts";

const session = new Map();
const local = new Map();
let redirects;
let guestBearerEnabled = false;
const guestPaths = [
  "/api/table-sessions",
  "/api/table-sessions/guest-session",
  "/api/table-sessions/guest-session/cart/lines",
  "/api/table-sessions/guest-session/orders",
  "/api/table-sessions/guest-session/bill",
  "/api/table-sessions/guest-session/quote",
  "/api/table-sessions/guest-session/splits",
  "/api/table-sessions/guest-session/payments",
  "/api/table-sessions/guest-session/service-requests",
];
registerBearerProvider((path) =>
  guestBearerEnabled && path.startsWith("/api/table-sessions")
    ? "qr_guest_token"
    : null,
);
const staffSessionPaths = [
  "confirm",
  "close",
  "move",
  "merge",
  "move-items",
  "open-bill",
].flatMap((action) => [
  `/api/table-sessions/guest-session/${action}`,
  `/api/table-sessions/guest-session/${action}/`,
  `/api/table-sessions/guest-session/${action}?x=1`,
]);
const paths = [
  "/api/floor",
  "/api/floor?status=active",
  "/api/floor/zones/zone1",
  "/api/tables",
  "/api/tables/table1",
  "/api/table-links",
  "/api/table-links/link1/rotate",
  ...staffSessionPaths,
  "/api/outlets/o1/kitchen",
  "/api/outlets/o1/kitchen/tickets/ticket1/status",
];

beforeEach(() => {
  session.clear();
  local.clear();
  redirects = [];
  guestBearerEnabled = false;
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
    "/api/table-sessions/guest-session/close-extra",
    "/api/table-sessions/guest-session/close/extra",
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

test("legend-15ha6 QR guest bearer calls never carry a live cashier token", () => {
  guestBearerEnabled = true;
  const initialSession = new Map(session);
  for (const path of guestPaths) {
    assert.deepEqual(bearerHeaderFor(path), {
      authorization: "Bearer qr_guest_token",
    });
    for (const method of ["GET", "POST", "PATCH", "DELETE"])
      assert.deepEqual(
        actingStaffHeaderFor(path, method),
        {},
        `${method} ${path}`,
      );
  }
  assert.deepEqual(redirects, []);
  assert.equal(readActingStaffToken(), "pas_floor_cashier");
  assert.deepEqual(session, initialSession);
});

test("legend-15ha6 QR guest bearer mutations ignore an expired cashier", () => {
  guestBearerEnabled = true;
  writeActingStaffToken({
    token: "pas_expired",
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
  });
  local.set(ACTIVE_STAFF_STORAGE_KEY, "cashier1");
  const initialSession = new Map(session);
  for (const path of guestPaths)
    assert.deepEqual(actingStaffHeaderFor(path, "POST"), {}, path);
  assert.deepEqual(redirects, []);
  assert.equal(local.get(ACTIVE_STAFF_STORAGE_KEY), "cashier1");
  assert.deepEqual(session, initialSession);
});

test("legend-15ha6 QR bearer mutations ignore a cashier label without a token", () => {
  guestBearerEnabled = true;
  clearActingStaffToken();
  local.set(ACTIVE_STAFF_STORAGE_KEY, "cashier1");
  const initialSession = new Map(session);
  for (const path of guestPaths)
    assert.deepEqual(actingStaffHeaderFor(path, "POST"), {}, path);
  assert.deepEqual(redirects, []);
  assert.equal(local.get(ACTIVE_STAFF_STORAGE_KEY), "cashier1");
  assert.deepEqual(session, initialSession);
});

test("legend-15ha6 QR bearer bypass keeps the cashier hold on staff operations", () => {
  guestBearerEnabled = true;
  releaseActingStaffToken();
  for (const path of guestPaths)
    assert.deepEqual(actingStaffHeaderFor(path, "POST"), {}, path);
  assert.deepEqual(redirects, []);
  for (const path of staffSessionPaths) {
    assert.ok(bearerHeaderFor(path).authorization);
    assert.equal(actingStaffHeaderFor(path, "POST"), null, path);
  }
  assert.ok(redirects.every((path) => path === "/pos/ganti-pengguna"));
});
