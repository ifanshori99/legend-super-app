// Offline/connectivity UX kit (bead legend-diq). Cites PRD v1.7 §3 F5 "Print
// Agent", "Fallback Berlapis", "Mode Latihan", §4 Alur F (operasional saat
// internet putus) and EDG-05 (printer/KDS failure detected within 30 seconds
// and reported to the supervisor).

import assert from "node:assert/strict";
import { test } from "node:test";

import * as edge from "../packages/shared/src/edge/index.ts";
import * as logic from "../apps/web/src/features/ws02-edge/logic.ts";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");

function deviceAt(overrides = {}) {
  return edge.deviceSchema.parse({
    ...edge.deviceFixtures[1],
    lastSeenAt: "2026-11-01T12:00:00.000Z",
    ...overrides,
  });
}

test("F5/EDG-05: connectivity fixtures parse and reprints reference a real job", () => {
  for (const device of edge.deviceFixtures)
    assert.equal(
      edge.deviceSchema.safeParse(device).success,
      true,
      device.label,
    );
  for (const job of edge.printJobFixtures)
    assert.equal(edge.printJobSchema.safeParse(job).success, true, job.id);
  assert.equal(
    edge.edgeStatusSchema.safeParse(edge.edgeStatusFixture).success,
    true,
  );

  const jobIds = new Set(edge.printJobFixtures.map((job) => job.id));
  for (const job of edge.printJobFixtures)
    if (job.reprintOf)
      assert.ok(jobIds.has(job.reprintOf), "reprint target exists");

  // The kit is built for one outlet: every fixture shares the same scope.
  const outlets = new Set([
    ...edge.deviceFixtures.map((device) => device.outletId),
    ...edge.printJobFixtures.map((job) => job.outletId),
  ]);
  assert.equal(outlets.size, 1);
});

test("EDG-05: a printer or KDS is offline once its heartbeat is 30 seconds old", () => {
  // Exactly 30 s is already offline: detection must not exceed 30 s.
  assert.equal(
    logic.isDeviceOffline(
      deviceAt({ lastSeenAt: "2026-11-01T11:59:30.000Z" }),
      NOW,
    ),
    true,
  );
  assert.equal(
    logic.isDeviceOffline(
      deviceAt({ lastSeenAt: "2026-11-01T11:59:31.000Z" }),
      NOW,
    ),
    false,
  );
  // A device that never sent a heartbeat cannot be trusted as online.
  assert.equal(
    logic.isDeviceOffline(deviceAt({ lastSeenAt: null }), NOW),
    true,
  );
  // Revocation is a registry decision, not an outage alert.
  assert.equal(
    logic.isDeviceOffline(
      deviceAt({
        status: "revoked",
        revokedAt: "2026-11-01T11:00:00.000Z",
        lastSeenAt: null,
      }),
      NOW,
    ),
    false,
  );
});

test("EDG-05: only printers and KDS raise supervisor alerts", () => {
  const stale = { lastSeenAt: "2026-11-01T11:50:00.000Z" };
  const devices = [
    deviceAt({
      id: "44444444-4444-4444-8444-444444444445",
      type: "printer",
      ...stale,
    }),
    deviceAt({
      id: "44444444-4444-4444-8444-444444444447",
      type: "kds",
      ...stale,
    }),
    deviceAt({
      id: "44444444-4444-4444-8444-444444444444",
      type: "pos",
      ...stale,
    }),
  ];
  const alerts = logic.offlineAlertDevices(devices, NOW);
  assert.deepEqual(
    alerts.map((device) => device.type),
    ["printer", "kds"],
  );
});

test("Alur F: the banner state follows the device network, the cloud link and the backlog", () => {
  // Step 1: the edge node detects the lost cloud link.
  assert.deepEqual(
    logic.deriveConnectivity({
      browserOnline: true,
      cloudLink: "disconnected",
      pendingEventCount: 12,
      statusFailed: false,
    }),
    { kind: "cloud_down", pendingEventCount: 12 },
  );
  // Step 5: after the link returns the outbox drains; the banner says so.
  assert.deepEqual(
    logic.deriveConnectivity({
      browserOnline: true,
      cloudLink: "connected",
      pendingEventCount: 12,
      statusFailed: false,
    }),
    { kind: "syncing", pendingEventCount: 12 },
  );
  assert.deepEqual(
    logic.deriveConnectivity({
      browserOnline: true,
      cloudLink: "connected",
      pendingEventCount: 0,
      statusFailed: false,
    }),
    { kind: "online" },
  );
  // A device with no outlet network cannot reach anything, even the edge.
  assert.deepEqual(
    logic.deriveConnectivity({
      browserOnline: false,
      cloudLink: "connected",
      pendingEventCount: 0,
      statusFailed: false,
    }),
    { kind: "device_offline" },
  );
  // Loading renders nothing; only a failed probe is "unknown".
  assert.deepEqual(
    logic.deriveConnectivity({
      browserOnline: true,
      cloudLink: null,
      pendingEventCount: 0,
      statusFailed: false,
    }),
    { kind: "online" },
  );
  assert.deepEqual(
    logic.deriveConnectivity({
      browserOnline: true,
      cloudLink: null,
      pendingEventCount: 0,
      statusFailed: true,
    }),
    { kind: "unknown" },
  );
});

test("Alur F: guest screens keep their own waiter notice instead of the staff banner", () => {
  for (const path of ["/", "/t/abc", "/menu", "/member/poin", "/wifi"])
    assert.equal(logic.isGuestPath(path), true, path);
  for (const path of ["/pos/kasir", "/operasional/koneksi", "/kelola", "/kds"])
    assert.equal(logic.isGuestPath(path), false, path);
  for (const path of ["/pos", "/operasional/koneksi", "/fasilitas/tiket"])
    assert.equal(logic.isOperationsPath(path), true, path);
  assert.equal(logic.isOperationsPath("/kelola"), false);
});

test("F5: the print queue offers retry only on failed jobs and reprint only on printed ones", () => {
  const pick = (status) =>
    edge.printJobFixtures.find((job) => job.status === status);
  assert.deepEqual(logic.printJobActions(pick("failed")), {
    canRetry: true,
    canReprint: false,
  });
  assert.deepEqual(logic.printJobActions(pick("printed")), {
    canRetry: false,
    canReprint: true,
  });
  for (const status of ["queued", "printing"])
    assert.deepEqual(logic.printJobActions(pick(status)), {
      canRetry: false,
      canReprint: false,
    });

  const summary = logic.summarizePrintJobs(edge.printJobFixtures);
  assert.equal(
    summary.queued + summary.printing + summary.printed + summary.failed,
    edge.printJobFixtures.length,
  );
  assert.equal(summary.failed, 1);
});

test("F5: the edge endpoints keep client input strict and free of tenant ids", () => {
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const key = "reprint-key-001";

  assert.equal(
    edge.reprintPrintJob.body.safeParse({ idempotencyKey: key }).success,
    true,
  );
  // TEN-02: the tenant and the outlet come from the edge device, never the body.
  assert.equal(
    edge.reprintPrintJob.body.safeParse({ idempotencyKey: key, tenantId })
      .success,
    false,
  );
  assert.equal(
    edge.retryPrintJob.body.safeParse({ idempotencyKey: key }).success,
    true,
  );
  assert.equal(
    edge.setOutletDeviceTrainingMode.body.safeParse({ trainingMode: true })
      .success,
    true,
  );
  assert.equal(
    edge.setOutletDeviceTrainingMode.body.safeParse({ trainingMode: "yes" })
      .success,
    false,
  );
  assert.equal(
    edge.setOutletDeviceTrainingMode.path,
    "/api/devices/:deviceId/training-mode",
  );
  assert.equal(edge.revokeDevice.path, "/api/devices/:deviceId/revoke");
  // The unrouted edge-side training contract is gone (legend-2lp.9).
  assert.equal(edge.setDeviceTrainingMode, undefined);
  assert.equal(
    edge.printJobListQuerySchema.safeParse({ limit: 20, status: "printing" })
      .success,
    true,
  );
  assert.equal(
    edge.printJobListQuerySchema.safeParse({ limit: 20, status: "burned" })
      .success,
    false,
  );
  assert.equal(
    edge.deviceListQuerySchema.safeParse({ limit: 25, type: "printer" })
      .success,
    true,
  );
});

test("Alur F: a cloud deployment without an edge route is not an outage", () => {
  assert.equal(logic.edgeProbeFailed(false, null), false);
  assert.equal(
    logic.edgeProbeFailed(true, { status: 404 }),
    false,
    "404 = no edge node on this deployment",
  );
  assert.equal(logic.edgeProbeFailed(true, { status: 503 }), true);
  assert.equal(
    logic.edgeProbeFailed(true, new TypeError("fetch failed")),
    true,
  );
});

// legend-b0l9: the OperationsShell badge shows the cloud link, not just
// navigator.onLine (PRD v1.7 §4 Alur F step 1, §3 F5).
test("legend-b0l9: connection badge follows the edge cloud link", () => {
  // Edge says the cloud is down while the browser still has a LAN: not online.
  assert.equal(
    logic.cloudConnectionOnline({
      browserOnline: true,
      cloudLink: "disconnected",
    }),
    false,
  );
  assert.equal(
    logic.cloudConnectionOnline({
      browserOnline: true,
      cloudLink: "connected",
    }),
    true,
  );
  // Browser offline is a secondary hint: it still forces offline.
  assert.equal(
    logic.cloudConnectionOnline({
      browserOnline: false,
      cloudLink: "connected",
    }),
    false,
  );
  // No edge answer (loading, or a cloud deployment without an edge node):
  // fall back to the browser hint.
  assert.equal(
    logic.cloudConnectionOnline({ browserOnline: true, cloudLink: null }),
    true,
  );
  assert.equal(
    logic.cloudConnectionOnline({ browserOnline: false, cloudLink: null }),
    false,
  );
});
