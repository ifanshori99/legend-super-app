// Staff table operations and live board contract tests (bead legend-7ko;
// contracts from legend-1dg3's scope). Acceptance: ORD-10.
// PRD v1.7 §3 "9. Denah & Meja" (Operasi Meja, Papan Status), "10. QR Order
// Pelanggan" (Kontrol Open Bill).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildEndpointPath,
  matchEndpointPath,
} from "../packages/shared/src/api/endpoint.ts";
import { CoreError } from "../packages/shared/src/core/index.ts";
import * as qr from "../packages/shared/src/qr-order/index.ts";

const f = qr.qrOrderFixtures;
const row = (code) => {
  const found = f.floorBoard.tables.find((item) => item.table.code === code);
  assert.ok(found, `fixture row ${code}`);
  return found;
};
const copySession = (overrides) => ({ ...f.sessions[0], ...overrides });

test("ORD-10 the board refuses to empty a table that still has an active session", () => {
  assert.equal(
    qr.canApplyTableStatusAction({
      action: "mark_available",
      tableStatus: "occupied",
      hasActiveSession: true,
    }),
    false,
  );
  assert.throws(
    () =>
      qr.assertCanApplyTableStatusAction({
        action: "mark_available",
        tableStatus: "occupied",
        hasActiveSession: true,
      }),
    (error) =>
      error instanceof CoreError &&
      error.code === "CONFLICT" &&
      /ORD-10/.test(error.message),
  );
});

test("ORD-10 emptying is allowed again once the session is closed", () => {
  assert.equal(
    qr.canApplyTableStatusAction({
      action: "mark_available",
      tableStatus: "dirty",
      hasActiveSession: false,
    }),
    true,
  );
  assert.equal(
    qr.canApplyTableStatusAction({
      action: "mark_available",
      tableStatus: "occupied",
      hasActiveSession: false,
    }),
    true,
  );
});

test("ORD-10 status actions map to PRD floor states and refuse impossible ones", () => {
  assert.equal(qr.tableStatusActionTarget("mark_available"), "available");
  assert.equal(qr.tableStatusActionTarget("mark_dirty"), "dirty");
  assert.equal(qr.tableStatusActionTarget("reserve"), "reserved");
  assert.equal(qr.tableStatusActionTarget("release_reservation"), "available");
  assert.equal(qr.tableStatusActionTarget("deactivate"), "inactive");
  assert.equal(qr.tableStatusActionTarget("activate"), "available");

  // A reservation needs an empty table; releasing needs a reserved one.
  assert.equal(
    qr.canApplyTableStatusAction({
      action: "reserve",
      tableStatus: "occupied",
      hasActiveSession: true,
    }),
    false,
  );
  assert.equal(
    qr.canApplyTableStatusAction({
      action: "reserve",
      tableStatus: "available",
      hasActiveSession: false,
    }),
    true,
  );
  assert.equal(
    qr.canApplyTableStatusAction({
      action: "release_reservation",
      tableStatus: "available",
      hasActiveSession: false,
    }),
    false,
  );
  // Deactivating an in-use table is the same as emptying it.
  assert.equal(
    qr.canApplyTableStatusAction({
      action: "deactivate",
      tableStatus: "occupied",
      hasActiveSession: true,
    }),
    false,
  );
});

test("ORD-10 Papan Status shows the six PRD states plus confirmation and inactive", () => {
  assert.equal(qr.tableBoardStatus(row("A01")), "available");
  assert.equal(qr.tableBoardStatus(row("A03")), "awaiting_order");
  assert.equal(qr.tableBoardStatus(row("P1")), "awaiting_bill");
  assert.equal(qr.tableBoardStatus(row("A04")), "needs_cleaning");
  assert.equal(qr.tableBoardStatus(row("B02")), "reserved");
  assert.equal(qr.tableBoardStatus(row("W01")), "awaiting_confirmation");
  assert.equal(qr.tableBoardStatus(row("W03")), "inactive");
  // An open session with a bill on it is "terisi".
  const seated = { ...row("A03") };
  seated.session = {
    ...f.sessions[0],
    billTotalIdr: 148_500,
  };
  assert.equal(qr.tableBoardStatus(seated), "seated");
  // Room for exactly the eight board states, no stray values.
  assert.deepEqual(
    [...new Set(f.floorBoard.tables.map(qr.tableBoardStatus))].sort(),
    [
      "available",
      "awaiting_bill",
      "awaiting_confirmation",
      "awaiting_order",
      "needs_cleaning",
      "reserved",
      "inactive",
    ].sort(),
  );
});

test("ORD-10 seat duration counts whole minutes from the session open", () => {
  assert.equal(qr.tableSeatMinutes(row("A03"), "2026-11-01T05:10:00.000Z"), 40);
  assert.equal(qr.tableSeatMinutes(row("P1"), "2026-11-01T05:10:00.000Z"), 130);
  assert.equal(
    qr.tableSeatMinutes(row("A01"), "2026-11-01T05:10:00.000Z"),
    null,
  );
  // A clock that runs backwards never reports negative minutes.
  assert.equal(qr.tableSeatMinutes(row("A03"), "2026-11-01T04:00:00.000Z"), 0);
});

test("ORD-10 merge refuses an unconfirmed open-bill session and cross-outlet sessions", () => {
  const open = copySession({
    id: f.sessions[1].id,
    status: "open",
    paymentMode: "open_bill",
  });
  const pending = copySession({
    id: f.sessions[2].id,
    status: "pending_confirmation",
    paymentMode: "open_bill",
  });
  assert.throws(
    () => qr.assertSessionsCanMerge({ target: open, source: pending }),
    (error) => error instanceof CoreError && error.code === "CONFLICT",
  );
  assert.throws(
    () => qr.assertSessionsCanMerge({ target: open, source: open }),
    /tidak boleh sama/,
  );
  assert.throws(
    () =>
      qr.assertSessionsCanMerge({
        target: open,
        source: copySession({
          id: f.sessions[2].id,
          outletId: f.zones[1].outletId.replace(/.$/, "9"),
          paymentMode: "open_bill",
        }),
      }),
    /outlet/,
  );
  // Two running sessions with one payment mode merge; mixing modes would put
  // two settlement rules on one bill.
  assert.doesNotThrow(() =>
    qr.assertSessionsCanMerge({
      target: open,
      source: copySession({
        id: f.sessions[2].id,
        status: "bill_requested",
        paymentMode: "open_bill",
      }),
    }),
  );
  assert.throws(
    () =>
      qr.assertSessionsCanMerge({
        target: open,
        source: copySession({
          id: f.sessions[2].id,
          status: "open",
          paymentMode: "pay_first",
        }),
      }),
    /Mode bayar|mode bayar/,
  );
});

test("ORD-10 moving items needs two running sessions in the same outlet", () => {
  const running = copySession({ status: "open" });
  const other = copySession({ id: f.sessions[2].id, status: "open" });
  assert.doesNotThrow(() =>
    qr.assertItemsCanMove({ from: running, to: other }),
  );
  assert.throws(
    () => qr.assertItemsCanMove({ from: running, to: running }),
    /berbeda/,
  );
  assert.throws(
    () =>
      qr.assertItemsCanMove({
        from: running,
        to: { ...other, status: "pending_confirmation" },
      }),
    /berjalan/,
  );
});

test("ORD-10 a session keeps its payment mode, so it moves only within that mode", () => {
  assert.doesNotThrow(() =>
    qr.assertSessionPaymentModeMatches({
      sessionPaymentMode: "open_bill",
      targetPaymentMode: "open_bill",
    }),
  );
  assert.throws(
    () =>
      qr.assertSessionPaymentModeMatches({
        sessionPaymentMode: "open_bill",
        targetPaymentMode: "pay_first",
      }),
    /Mode bayar/,
  );
});

test("ORD-10 table operation endpoints carry strict inputs and typed responses", () => {
  const endpoints = [
    qr.updateTableStatus,
    qr.moveTableSession,
    qr.mergeTableSessions,
    qr.moveSessionItems,
  ];
  for (const endpoint of endpoints) {
    assert.equal(endpoint.method, "POST");
    assert.match(endpoint.id, /^POST /);
  }
  assert.deepEqual(
    buildEndpointPath(qr.updateTableStatus.path, {
      tableId: f.tables[0].id,
    }),
    `/api/tables/${f.tables[0].id}/status`,
  );
  assert.deepEqual(
    matchEndpointPath(
      qr.moveTableSession.path,
      `/api/table-sessions/${f.sessions[0].id}/move`,
    ),
    { sessionId: f.sessions[0].id },
  );
  assert.deepEqual(
    matchEndpointPath(
      qr.moveSessionItems.path,
      `/api/table-sessions/${f.sessions[0].id}/move-items`,
    ),
    { sessionId: f.sessions[0].id },
  );

  // TEN-02: a client input never carries tenant/outlet scope.
  const withTenant = qr.updateTableStatusInputSchema.safeParse({
    action: "mark_available",
    tenantId: f.zones[0].tenantId,
  });
  assert.equal(withTenant.success, false);
  assert.equal(
    qr.updateTableStatusInputSchema.safeParse({ action: "mark_available" })
      .success,
    true,
  );
  assert.equal(
    qr.updateTableStatusInputSchema.safeParse({ action: "nope" }).success,
    false,
  );

  const merge = qr.mergeTableSessionsInputSchema.safeParse({
    sourceSessionId: f.sessions[0].id,
  });
  assert.equal(merge.success, true);
  assert.equal(
    qr.moveSessionItemsInputSchema.safeParse({
      toSessionId: f.sessions[0].id,
      orderItemIds: [],
    }).success,
    false,
  );
});
