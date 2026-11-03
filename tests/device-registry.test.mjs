// Device registry panel logic (bead legend-q2c). Cites PRD v1.7 §3 F5
// "Registri Perangkat", "Mode Latihan"; EDG-03 (UI), EDG-05 (30 s offline).

import assert from "node:assert/strict";
import { test } from "node:test";

import * as edge from "../packages/shared/src/edge/index.ts";
import * as logic from "../apps/web/src/features/ws02-devices/logic.ts";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const device = (over = {}) =>
  edge.deviceSchema.parse({
    ...edge.deviceFixtures[1],
    lastSeenAt: "2026-11-01T12:00:00.000Z",
    ...over,
  });
const ago = (ms) => new Date(NOW - ms).toISOString();

test("EDG-03: heartbeat state is online, stale, offline, never or revoked", () => {
  assert.equal(
    logic.heartbeatState(device({ lastSeenAt: ago(5_000) }), NOW),
    "online",
  );
  assert.equal(
    logic.heartbeatState(device({ lastSeenAt: ago(20_000) }), NOW),
    "stale",
  );
  assert.equal(
    logic.heartbeatState(device({ lastSeenAt: ago(30_000) }), NOW),
    "offline",
  );
  assert.equal(
    logic.heartbeatState(device({ lastSeenAt: null }), NOW),
    "never",
  );
  assert.equal(
    logic.heartbeatState(
      device({
        status: "revoked",
        revokedAt: ago(1000),
        lastSeenAt: ago(900_000),
      }),
      NOW,
    ),
    "revoked",
  );
});

test("EDG-03: heartbeat age reads in seconds, minutes, hours, days", () => {
  assert.deepEqual(logic.splitAge(2_000), { key: "justNow" });
  assert.deepEqual(logic.splitAge(20_000), { key: "ageSeconds", count: 20 });
  assert.deepEqual(logic.splitAge(13 * 60_000), {
    key: "ageMinutes",
    count: 13,
  });
  assert.deepEqual(logic.splitAge(5 * 3_600_000), {
    key: "ageHours",
    count: 5,
  });
  assert.deepEqual(logic.splitAge(72 * 3_600_000), {
    key: "ageDays",
    count: 3,
  });
});

test("EDG-03: filters combine outlet, type, status and name search", () => {
  const list = edge.deviceFixtures.map((d) => edge.deviceSchema.parse(d));
  const all = logic.EMPTY_FILTERS;
  assert.equal(logic.filterDevices(list, all).length, list.length);
  assert.equal(
    logic
      .filterDevices(list, { ...all, type: "printer" })
      .every((d) => d.type === "printer"),
    true,
  );
  assert.equal(
    logic.filterDevices(list, { ...all, search: "dapur" }).length,
    1,
  );
  assert.equal(
    logic.filterDevices(list, { ...all, outletId: "other" }).length,
    0,
  );
});

test("EDG-03: revoke needs the typed device name and a reason of 3+ characters", () => {
  assert.equal(
    logic.revokeConfirmationMatches(" printer bar ", "Printer Bar"),
    true,
  );
  assert.equal(
    logic.revokeConfirmationMatches("Printer", "Printer Bar"),
    false,
  );
  assert.equal(logic.revokeReasonValid("  ab "), false);
  assert.equal(logic.revokeReasonValid("hilang"), true);
});

test("EDG-03: a session revocation overlays an active row and never undoes a revoked one", () => {
  const active = device();
  const revoked = device({ status: "revoked", revokedAt: ago(0) });
  const merged = logic.mergeRevocations(
    [active],
    new Map([[active.id, revoked]]),
  );
  assert.equal(merged[0].status, "revoked");
  assert.equal(logic.deviceCounts(merged, NOW).revoked, 1);
});
