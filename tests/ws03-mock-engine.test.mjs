// WS-03 mock infrastructure (bead legend-jzud): the QR order journey, the floor
// board and the floor editor share ONE session/floor engine, and the mock
// registry refuses a second handler for the same endpoint. Loaded with plain
// Node ESM and built-in type stripping like the other root suites.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../apps/web/src/lib/api/errors.ts";
import { createEngine } from "../apps/web/src/features/ws03-qr-order/mock-engine.ts";
import { createWs03Engine } from "../apps/web/src/lib/mock/ws03/engine.ts";
import { clearMocks, registerMock } from "../apps/web/src/lib/mock/registry.ts";
import * as api from "../packages/shared/src/api/index.ts";
import * as qr from "../packages/shared/src/qr-order/index.ts";
import * as sample from "../packages/shared/src/qr-order/sample.ts";

function fresh() {
  const now = 1_700_000_000_000;
  const clock = () => now;
  const floor = createWs03Engine(clock);
  return { floor, engine: createEngine(clock, floor), clock };
}

const sessionIdOf = (engine, token) =>
  engine.scan({ qrToken: token, pax: 2, deviceHash: "d".repeat(32) }).session
    .id;

test("legend-jzud a QR scan is one session for the guest engine and the floor board", () => {
  const { floor, engine } = fresh();
  const sessionId = sessionIdOf(engine, sample.qrTokenFixtures.freeTable);

  // The guest opened a session that did not exist in the fixtures...
  assert.equal(engine.view(sessionId).session.status, "open");
  assert.equal(
    engine.view(sessionId).session.tableId,
    floor.tableByCode("A01").id,
  );
  // ...and the board (and the editor, which reads the same board) sees it.
  const row = floor.rowOf(floor.tableByCode("A01").id);
  assert.equal(row.session?.id, sessionId);
  assert.equal(row.table.status, "occupied");

  // A staff confirmation through the board is what the guest sees next.
  const openBill = floor.sessionOf(
    sessionIdOf(engine, sample.qrTokenFixtures.wfc),
  );
  assert.equal(openBill.status, "pending_confirmation");
  floor.confirmOpenBillSession(openBill.id);
  assert.equal(engine.view(openBill.id).session.status, "open");
});

test("a mock service request includes the table code as its label", () => {
  const { floor, engine } = fresh();
  const sessionId = sessionIdOf(engine, sample.qrTokenFixtures.freeTable);
  const request = floor.createServiceRequest(sessionId, {
    type: "call_waiter",
  });

  assert.equal(request.tableLabel, floor.tableByCode("A01").code);
  assert.equal(qr.serviceRequestSchema.parse(request).tableLabel, "A01");
});

test("legend-jzud the guest bill and the board bill are the same bill", () => {
  const { floor, engine } = fresh();
  const p1 = qr.qrOrderFixtures.sessions[1].id;
  const boardBill = floor.billFor(p1);
  const guestBill = engine.bill(p1);
  assert.equal(guestBill.totals.totalIdr, boardBill.totals.totalIdr);
  assert.equal(guestBill.totals.paidIdr, boardBill.totals.paidIdr);
  assert.deepEqual(
    guestBill.orders.map((order) => order.id),
    boardBill.orders.map((order) => order.id),
  );

  // A guest split is the split the board locks on (ORD-06, decision C2). W02
  // is the second running open-bill session the shared seed adds, with one
  // order and no paid share yet.
  const w02 = "00000000-0000-4000-8000-000000000406";
  engine.createSplits(w02, { method: "equal", parts: 2 });
  assert.ok(floor.splitsOf(w02).length > 0);
  assert.throws(
    () => engine.createSplits(p1, { method: "equal", parts: 2 }),
    (error) => error instanceof ApiError && error.code === "SPLIT_LOCKED",
  );
});

test("legend-jzud a closed session leaves the guest engine (ORD-04)", () => {
  const { floor, engine } = fresh();
  const sessionId = sessionIdOf(engine, sample.qrTokenFixtures.freeTable);
  floor.closeTableSession(sessionId, {
    tableCleaned: true,
    waiterConfirmedEmpty: true,
  });
  assert.throws(
    () => engine.view(sessionId),
    (error) => error instanceof ApiError && error.status === 404,
  );
});

test("legend-jzud registerMock refuses a second handler for one endpoint", () => {
  const endpoint = api.defineEndpoint({
    method: "GET",
    path: "/api/legend-jzud/probe",
  });
  registerMock(endpoint, () => undefined);
  assert.throws(
    () => registerMock(endpoint, () => undefined),
    /Duplicate handler for "GET \/api\/legend-jzud\/probe"/,
  );
  clearMocks();
});

test("legend-zrdy mock floor seeds without crypto.randomUUID and preserves bill amounts", (t) => {
  const normal = fresh();
  const sessionIds = [
    qr.qrOrderFixtures.sessions[1].id,
    "00000000-0000-4000-8000-000000000406",
  ];
  const totals = sessionIds.map((id) => normal.floor.billFor(id).totals);
  const original = Object.getOwnPropertyDescriptor(
    Crypto.prototype,
    "randomUUID",
  );
  t.after(() =>
    Object.defineProperty(Crypto.prototype, "randomUUID", original),
  );
  Object.defineProperty(Crypto.prototype, "randomUUID", {
    value: undefined,
    configurable: true,
  });
  assert.equal(typeof crypto.randomUUID, "undefined");
  const fallback = fresh();
  assert.deepEqual(
    sessionIds.map((id) => fallback.floor.billFor(id).totals),
    totals,
  );
});
