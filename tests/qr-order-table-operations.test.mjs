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
import { roleTemplate } from "../packages/shared/src/access/roles.ts";

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

test("ORD-06 a partly paid session cannot be merged or have items moved (paid share locks re-split)", () => {
  const paid = { ...copySession({ status: "open" }), paidIdr: 25_000 };
  const other = {
    ...copySession({ id: f.sessions[2].id, status: "open" }),
    paidIdr: 0,
  };
  for (const [from, to] of [
    [paid, other],
    [other, paid],
  ]) {
    assert.throws(
      () => qr.assertItemsCanMove({ from, to }),
      (error) => error instanceof CoreError && /dibayar/.test(error.message),
    );
    assert.throws(
      () =>
        qr.assertSessionsCanMerge({
          target: { ...to, paymentMode: from.paymentMode },
          source: from,
        }),
      /dibayar/,
    );
  }
  assert.doesNotThrow(() =>
    qr.assertItemsCanMove({ from: other, to: { ...paid, paidIdr: 0 } }),
  );
});

test("legend-4rmk legend-2l6k floor operations are a waiter/cashier task, layout stays manage", () => {
  const holds = (key, permission) =>
    roleTemplate(key).permissions.includes(permission);
  for (const key of ["waiter", "cashier", "supervisor", "outlet_manager"])
    assert.equal(holds(key, "floor.table.operate"), true, key);
  for (const key of ["waiter", "cashier", "supervisor"])
    assert.equal(holds(key, "floor.table.manage"), false, key);
  assert.equal(holds("barista_cook", "floor.table.operate"), false);
  // legend-2l6k: the outlet manager edits the floor plan; supervisor does not.
  assert.equal(holds("outlet_manager", "floor.table.manage"), true);
});

test("legend-1nmh table link: strict inputs, request shape guard, endpoints, events", () => {
  const [a, b] = [f.tables[0].id, f.tables[1].id];
  assert.equal(
    qr.linkTablesInputSchema.safeParse({ tableIds: [a, b] }).success,
    true,
  );
  assert.equal(
    qr.linkTablesInputSchema.safeParse({ tableIds: [a], tenantId: "x" })
      .success,
    false,
  );
  assert.equal(qr.unlinkTablesInputSchema.safeParse({}).success, true);
  assert.equal(
    qr.linkTablesInputSchema.safeParse({ tableIds: [] }).success,
    false,
  );
  const shapeError = (error) =>
    error instanceof CoreError && error.code === "VALIDATION_ERROR";
  assert.throws(() => qr.assertLinkRequestShape({ tableIds: [a] }), shapeError);
  assert.throws(
    () => qr.assertLinkRequestShape({ tableIds: [a, a] }),
    shapeError,
  );
  assert.doesNotThrow(() => qr.assertLinkRequestShape({ tableIds: [a, b] }));
  assert.doesNotThrow(() =>
    qr.assertLinkRequestShape({ groupId: "g", tableIds: [a] }),
  );
  assert.equal(qr.linkTables.path, "/api/table-links");
  assert.equal(qr.unlinkTables.path, "/api/table-links/:groupId/unlink");
  assert.equal(
    qr.tableLiveStatusSchema.safeParse({
      ...f.floorBoard.tables[0],
      linkGroup: { id: f.tables[0].id, tableIds: [a] },
    }).success,
    false,
  );
  for (const name of [
    "table.status_changed",
    "table_session.linked",
    "table_session.unlinked",
  ]) {
    assert.ok(qr.qrOrderEventNames.includes(name), name);
    assert.equal(qr.qrOrderEvents[name].entry.workstream, "WS-03");
  }
  assert.equal(
    qr.qrOrderEvents["table.status_changed"].entry.aggregateType,
    "table",
  );
});
