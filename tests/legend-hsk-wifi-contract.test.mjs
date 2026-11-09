// Wi-Fi agent contract (bead legend-hsk): strict apply input, no quota end
// reason (FAC-13), no raw device id in the grant view, walled garden builder
// (FAC-11) and its limits.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as w from "../packages/shared/src/edge/wifi.ts";
import * as edge from "../packages/shared/src/edge/index.ts";
import { CoreError } from "../packages/shared/src/core/index.ts";

const validApply = {
  outletId: "00000000-0000-4000-8000-000000000002",
  wifiSessionId: "00000000-0000-4000-8000-000000000010",
  controllerDeviceId: "AA:BB:CC:DD:EE:FF",
  speedTier: "full",
  fullSpeedKbps: 10_000,
  baseSpeedKbps: 1_000,
  remainingSeconds: 3_600,
  sessionEndsAt: "2026-11-09T10:00:00.000Z",
};
const hostError = (fn, reason) =>
  assert.throws(
    fn,
    (e) => e instanceof CoreError && e.reason === reason,
    reason,
  );

test("the edge barrel exports the Wi-Fi contract", () => {
  assert.equal(edge.buildWalledGarden, w.buildWalledGarden);
  assert.equal(edge.listEdgeWifiGrants.path, "/api/edge/wifi/grants");
});

test("apply input is strict and enforces full > base and the 24 h cap", () => {
  const parse = (extra) =>
    w.applyWifiSessionInputSchema.safeParse({ ...validApply, ...extra });
  assert.equal(parse({}).success, true);
  assert.equal(parse({ remainingSeconds: 0 }).success, true);
  assert.equal(parse({ tenantId: validApply.outletId }).success, false);
  assert.equal(parse({ extra: 1 }).success, false);
  assert.equal(parse({ fullSpeedKbps: 1_000 }).success, false);
  assert.equal(parse({ fullSpeedKbps: 500 }).success, false);
  assert.equal(parse({ remainingSeconds: 86_401 }).success, false);
  assert.equal(parse({ remainingSeconds: -1 }).success, false);
  assert.equal(parse({ fullSpeedKbps: 1_000_001 }).success, false);
  assert.equal(parse({ controllerDeviceId: "bad id!" }).success, false);
  assert.equal(parse({ speedTier: "turbo" }).success, false);
});

test("controller device ids normalize to trimmed lowercase", () => {
  assert.equal(
    w.normalizeControllerDeviceId(" AA:BB:CC:DD:EE:FF "),
    "aa:bb:cc:dd:ee:ff",
  );
  assert.equal(w.controllerDeviceIdSchema.safeParse("").success, false);
  assert.equal(
    w.controllerDeviceIdSchema.safeParse("a".repeat(65)).success,
    false,
  );
  assert.throws(() => w.normalizeControllerDeviceId("a b"));
});

test("FAC-13 no end reason is a quota reason", () => {
  assert.deepEqual(w.wifiEndReasonSchema.options, [
    "session_ended",
    "staff_revoked",
    "device_moved",
    "day_closed",
  ]);
  for (const reason of w.wifiEndReasonSchema.options)
    assert.doesNotMatch(reason, /quota|exhaust|spent/);
});

test("grant statuses are the ledger statuses", () => {
  assert.deepEqual(w.wifiGrantStatusSchema.options, [
    "pending",
    "active",
    "unknown",
    "superseded",
    "revoked",
    "failed",
  ]);
});

test("the grant view carries a device tag and never the controller id", () => {
  const keys = Object.keys(w.wifiGrantViewSchema.shape);
  assert.ok(keys.includes("deviceTag"));
  for (const key of keys)
    assert.doesNotMatch(key, /controller|mac|deviceId|deviceHash/i);
  const view = {
    id: validApply.wifiSessionId,
    tenantId: "00000000-0000-4000-8000-000000000001",
    outletId: validApply.outletId,
    wifiSessionId: validApply.wifiSessionId,
    deviceTag: "0a1b2c3d",
    speedTier: "base",
    bandwidthKbps: 1_000,
    status: "active",
    authorizedAt: "2026-11-09T09:00:00.000Z",
    expiresAt: "2026-11-09T13:05:00.000Z",
    endedAt: null,
    endReason: null,
  };
  assert.equal(w.wifiGrantViewSchema.safeParse(view).success, true);
  assert.equal(
    w.wifiGrantViewSchema.safeParse({
      ...view,
      controllerDeviceId: "aa:bb:cc:dd:ee:ff",
    }).success,
    false,
  );
  assert.equal(
    w.wifiGrantViewSchema.safeParse({ ...view, deviceTag: "aa:bb:cc" }).success,
    false,
  );
});

test("endpoints are strict and edge-scoped", () => {
  assert.equal(w.listEdgeWifiGrants.method, "GET");
  assert.equal(w.listEdgeWifiGrants.query.safeParse({}).success, true);
  assert.equal(w.listEdgeWifiGrants.query.safeParse({ x: 1 }).success, false);
  assert.equal(w.revokeEdgeWifiSession.method, "POST");
  assert.equal(w.revokeEdgeWifiSession.body.safeParse({ a: 1 }).success, false);
  assert.equal(
    w.revokeEdgeWifiSession.params.safeParse({ wifiSessionId: "nope" }).success,
    false,
  );
  assert.equal(w.getEdgeWifiWalledGarden.path, "/api/edge/wifi/walled-garden");
});

test("buildWalledGarden normalizes, dedupes and sorts", () => {
  assert.deepEqual(
    w.buildWalledGarden({
      orderingHosts: ["Order.Cafe.ID.", "order.cafe.id"],
      paymentHosts: ["pay.doit.id"],
      portalHosts: ["  PORTAL.cafe.id "],
      extraHosts: ["*.cdn.example.net"],
    }),
    ["*.cdn.example.net", "order.cafe.id", "pay.doit.id", "portal.cafe.id"],
  );
  assert.deepEqual(w.buildWalledGarden({}), []);
});

test("payment hosts are part of the garden", () => {
  const hosts = w.buildWalledGarden({
    paymentHosts: Object.values(w.PAYMENT_WALLED_GARDEN_HOSTS).flat(),
  });
  assert.ok(hosts.includes("pay.doit.id"));
});

test("buildWalledGarden refuses scheme, port, path, userinfo and bad wildcards", () => {
  for (const bad of [
    "https://pay.doit.id",
    "pay.doit.id:443",
    "pay.doit.id/path",
    "user@pay.doit.id",
    "pay.doit.id?x=1",
    "pay doit.id",
    "",
    "*",
    "*.",
    "a.*.doit.id",
    "*pay.doit.id",
    "**.doit.id",
    "-bad.doit.id",
    "a..b",
  ])
    hostError(
      () => w.buildWalledGarden({ extraHosts: [bad] }),
      "WIFI_WALLED_GARDEN_HOST_INVALID",
    );
  assert.deepEqual(w.buildWalledGarden({ extraHosts: ["*.doit.id"] }), [
    "*.doit.id",
  ]);
});

test("buildWalledGarden allows 100 hosts and refuses 101", () => {
  const hosts = (n) => Array.from({ length: n }, (_, i) => `h${i}.cafe.id`);
  assert.equal(w.buildWalledGarden({ extraHosts: hosts(100) }).length, 100);
  hostError(
    () => w.buildWalledGarden({ extraHosts: hosts(101) }),
    "WIFI_WALLED_GARDEN_TOO_LARGE",
  );
  // Duplicates across sources count once.
  assert.equal(
    w.buildWalledGarden({
      orderingHosts: hosts(100),
      portalHosts: hosts(100),
    }).length,
    100,
  );
});

test("supportsWalledGardenSync detects the optional capability", () => {
  assert.equal(
    w.supportsWalledGardenSync({ syncWalledGarden: async () => {} }),
    true,
  );
  assert.equal(
    w.supportsWalledGardenSync({
      authorize: async () => {},
      revoke: async () => {},
    }),
    false,
  );
});

test("WifiProviderError carries a transport code", () => {
  const error = new w.WifiProviderError("WIFI_PROVIDER_TIMEOUT");
  assert.equal(error.code, "WIFI_PROVIDER_TIMEOUT");
  assert.ok(error instanceof Error);
});
