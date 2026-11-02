// Reservation desk (bead legend-oye8; PRD v1.7 §3 F19 and §3.22 "Reservasi &
// Event"). Runs with the root node:test suite, no database: it loads the
// shared reservation contract, the web app's mock runtime and the desk's own
// helpers with Node type stripping.
//
// The screens are exercised end-to-end in e2e/legend-oye8.mock.spec.ts; this
// file proves the derivations and the rules the mock enforces — the same rules
// the API will enforce: RSV-01 (no overlapping table slots), RSV-02 (a paid DP
// is allocated at seating) and RSV-03 (cancellation follows the snapshot).
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import * as reservation from "../packages/shared/src/reservation/index.ts";
import { cafeLegendFixtures } from "../packages/shared/src/core/index.ts";
import { cafeLegendQrOrderFixtures } from "../packages/shared/src/qr-order/index.ts";
import { dispatchMock, resetMocks } from "../apps/web/src/lib/mock/runtime.ts";
import {
  businessDateOf,
  conflictingReservations,
  groupByBusinessDate,
  reservationActions,
  reservationSlots,
  shiftBusinessDate,
  tablesHeldAt,
  waitlistActions,
} from "../apps/web/src/features/ws08-reservation/lib.ts";
import "../apps/web/src/features/ws08-reservation/mock.ts";

const fixtures = reservation.cafeLegendReservationFixtures;
const ids = reservation.reservationFixtureIds;
const outlet = cafeLegendFixtures.outlets[0];
const tz = outlet.timeZone;
const T = cafeLegendQrOrderFixtures;

const tableOf = (code) => {
  const table = T.tables.find((row) => row.code === code);
  assert.ok(table, `fixture table ${code}`);
  return table;
};

const byId = (reservationId) =>
  fixtures.reservations.find((row) => row.id === reservationId);

const pending = () => byId(ids.pendingReservationId);
const confirmed = () => byId(ids.confirmedReservationId);
const seated = () => byId(ids.seatedReservationId);
const cancelled = () => byId(ids.cancelledReservationId);
const calledEntry = () =>
  fixtures.waitlist.find((row) => row.id === ids.calledWaitlistEntryId);

function failure(promise) {
  return promise.then(
    () => assert.fail("expected the call to fail"),
    (error) => error,
  );
}

async function get(path, query) {
  return dispatchMock({ method: "GET", path, query });
}

async function send(method, path, body) {
  return dispatchMock({ method, path, body });
}

beforeEach(resetMocks);

describe("RSV-01 table slots never overlap", () => {
  test("RSV-01 overlapping slots are detected per table, half-open", () => {
    // Dewi 19:00–20:30 and Rangga 19:30–21:30 both involve the private room.
    const conflicts = conflictingReservations(pending(), fixtures.reservations);
    assert.equal(conflicts.get(tableOf("P1").id)?.id, ids.confirmedReservationId);
    assert.equal(conflicts.size, 1);
  });

  test("RSV-01 a slot ending when the next starts is free", () => {
    const target = reservation.reservationSchema.parse({
      ...pending(),
      reservedFor: "2026-11-07T21:30:00+07:00",
    });
    assert.equal(conflictingReservations(target, fixtures.reservations).size, 0);
    assert.equal(reservationSlots(target).length, 0);
  });

  test("RSV-01 a cancelled reservation released its tables", () => {
    const released = reservationSlots(cancelled());
    assert.ok(released.length > 0);
    assert.ok(released.every((slot) => slot.releasedAt !== null));
    const target = reservation.reservationSchema.parse({
      ...pending(),
      reservedFor: cancelled().reservedFor,
    });
    assert.equal(conflictingReservations(target, fixtures.reservations).size, 0);
  });

  test("RSV-01 a table held at this instant belongs to its live reservation", () => {
    const held = tablesHeldAt(
      fixtures.reservations,
      "2026-11-01T05:00:00.000Z",
    );
    assert.equal(held.get(tableOf("A03").id)?.id, ids.seatedReservationId);
  });

  test("RSV-01 the mock refuses a table another reservation holds", async () => {
    const error = await failure(
      send(
        "PATCH",
        `/api/outlets/${outlet.id}/reservations/${ids.pendingReservationId}/tables`,
        { tableIds: [tableOf("P1").id] },
      ),
    );
    assert.equal(error.status, 409);
    assert.equal(error.code, "RESERVATION_SLOT_TAKEN");
  });

  test("RSV-01 a free table can be assigned and is written to the slots", async () => {
    const assigned = await send(
      "PATCH",
      `/api/outlets/${outlet.id}/reservations/${ids.pendingReservationId}/tables`,
      { tableIds: [tableOf("A01").id] },
    );
    assert.deepEqual(assigned.data.tableIds, [tableOf("A01").id]);

    const detail = await get(
      `/api/outlets/${outlet.id}/reservations/${ids.pendingReservationId}`,
    );
    assert.equal(detail.data.tableSlots.length, 1);
    assert.equal(detail.data.tableSlots[0].tableId, tableOf("A01").id);
    assert.equal(detail.data.tableSlots[0].releasedAt, null);
  });
});

describe("RSV-02 the DP is a deposit, allocated when the guest sits", () => {
  test("RSV-02 seating needs the required DP settled", async () => {
    const error = await failure(
      send(
        "POST",
        `/api/outlets/${outlet.id}/reservations/${ids.pendingReservationId}/seat`,
        { tableIds: [tableOf("A01").id] },
      ),
    );
    assert.equal(error.status, 409);
    assert.equal(error.code, "RESERVATION_DEPOSIT_UNPAID");
  });

  test("RSV-02 seating a confirmed reservation opens its table session once", async () => {
    const seatedResult = await send(
      "POST",
      `/api/outlets/${outlet.id}/reservations/${ids.confirmedReservationId}/seat`,
      { tableIds: [tableOf("P1").id] },
    );
    assert.equal(seatedResult.data.reservation.status, "seated");
    assert.ok(seatedResult.data.reservation.seatedAt);
    assert.equal(
      seatedResult.data.reservation.tableSessionId,
      seatedResult.data.tableSessionId,
    );
    assert.equal(seatedResult.data.reservation.depositStatus, "paid");

    const again = await failure(
      send(
        "POST",
        `/api/outlets/${outlet.id}/reservations/${ids.confirmedReservationId}/seat`,
        { tableIds: [tableOf("P1").id] },
      ),
    );
    assert.equal(again.code, "RESERVATION_TRANSITION_INVALID");
  });

  test("RSV-02 the desk only offers seat once the table and DP are settled", () => {
    assert.equal(reservationActions(pending()).seat, false);
    assert.equal(reservationActions(confirmed()).seat, true);
    assert.equal(reservationActions(seated()).seat, false);
    assert.equal(reservationActions(seated()).cancel, false);
  });
});

describe("RSV-03 closing follows the frozen policy snapshot", () => {
  test("RSV-03 a paid DP inside the free window is refunded in full", async () => {
    const closed = await send(
      "POST",
      `/api/outlets/${outlet.id}/reservations/${ids.confirmedReservationId}/cancel`,
      { reason: "Rencana berubah." },
    );
    assert.equal(closed.data.reservation.status, "cancelled");
    assert.ok(closed.data.reservation.closedAt);
    assert.equal(closed.data.depositOutcome.resolution, "refund_full");
    assert.equal(closed.data.depositOutcome.refundIdr, 100_000);
    assert.equal(closed.data.depositOutcome.forfeitedIdr, 0);
    assert.equal(
      closed.data.depositOutcome.policyVersion,
      ids.privateRoomPolicyVersion,
    );

    // The tables are released, so the slot no longer blocks them.
    const detail = await get(
      `/api/outlets/${outlet.id}/reservations/${ids.confirmedReservationId}`,
    );
    assert.ok(detail.data.tableSlots.every((slot) => slot.releasedAt !== null));
  });

  test("RSV-03 cancelling without a paid DP refunds nothing", async () => {
    const closed = await send(
      "POST",
      `/api/outlets/${outlet.id}/reservations/${ids.pendingReservationId}/cancel`,
      { reason: "Tamu membatalkan." },
    );
    assert.equal(closed.data.depositOutcome.resolution, "nothing_paid");
    assert.equal(closed.data.depositOutcome.refundIdr, 0);
  });

  test("RSV-03 a no-show forfeits the DP under the snapshot", async () => {
    const closed = await send(
      "POST",
      `/api/outlets/${outlet.id}/reservations/${ids.confirmedReservationId}/no-show`,
      {},
    );
    assert.equal(closed.data.reservation.status, "no_show");
    assert.equal(closed.data.depositOutcome.resolution, "no_refund");
    assert.equal(closed.data.depositOutcome.refundIdr, 0);
    assert.equal(closed.data.depositOutcome.forfeitedIdr, 100_000);
  });

  test("RSV-03 a seated reservation can no longer be cancelled", async () => {
    const error = await failure(
      send(
        "POST",
        `/api/outlets/${outlet.id}/reservations/${ids.seatedReservationId}/cancel`,
        { reason: "Sudah duduk." },
      ),
    );
    assert.equal(error.status, 409);
    assert.equal(error.code, "RESERVATION_TRANSITION_INVALID");
  });
});

describe("Waitlist queue", () => {
  test("waitlist actions follow the contract machine", () => {
    assert.deepEqual(waitlistActions(calledEntry()), {
      call: false,
      seat: true,
      leave: true,
      cancel: true,
    });
  });

  test("calling a waiting guest stamps the call", async () => {
    const waiting = fixtures.waitlist.find((row) => row.status === "waiting");
    assert.ok(waiting);
    const called = await send(
      "POST",
      `/api/outlets/${outlet.id}/waitlist/${waiting.id}/call`,
    );
    assert.equal(called.data.status, "called");
    assert.ok(called.data.calledAt);
  });

  test("a called guest is seated with the chosen tables", async () => {
    const seatedEntry = await send(
      "POST",
      `/api/outlets/${outlet.id}/waitlist/${ids.calledWaitlistEntryId}/resolve`,
      { resolution: "seated", tableIds: [tableOf("A04").id] },
    );
    assert.equal(seatedEntry.data.entry.status, "seated");
    assert.ok(seatedEntry.data.entry.seatedAt);
    assert.ok(seatedEntry.data.tableSessionId);
  });

  test("a seated guest cannot be called again", async () => {
    const error = await failure(
      send("POST", `/api/outlets/${outlet.id}/waitlist/${ids.calledWaitlistEntryId}/resolve`, {
        resolution: "seated",
        tableIds: [tableOf("A04").id],
      }),
    );
    assert.equal(error.code, "WAITLIST_TRANSITION_INVALID");
  });
});

describe("Event pre-order packages", () => {
  test("a package is charged per pax and frozen on the reservation", async () => {
    const placed = await send(
      "POST",
      `/api/outlets/${outlet.id}/reservations/${ids.confirmedReservationId}/preorder`,
      { packageId: ids.privateRoomPackageId },
    );
    assert.equal(placed.data.pax, confirmed().pax);
    assert.equal(
      placed.data.subtotalIdr,
      placed.data.pricePerPaxIdr * placed.data.pax,
    );
    assert.equal(placed.data.status, "confirmed");
  });

  test("a package outside the party size is refused", async () => {
    // Paket Kopi & Pastry needs at least 6 guests; Dewi booked 2.
    const error = await failure(
      send(
        "POST",
        `/api/outlets/${outlet.id}/reservations/${ids.pendingReservationId}/preorder`,
        { packageId: fixtures.packages[0].id },
      ),
    );
    assert.equal(error.status, 409);
    assert.equal(error.code, "RESERVATION_PACKAGE_UNAVAILABLE");
  });
});

describe("Schedule derivations", () => {
  test("business dates are read in the outlet time zone", () => {
    assert.equal(
      businessDateOf("2026-11-07T19:00:00+07:00", tz),
      "2026-11-07",
    );
    // 18:00Z is already the next day in WIB.
    assert.equal(businessDateOf("2026-11-07T18:00:00.000Z", tz), "2026-11-08");
    assert.equal(shiftBusinessDate("2026-11-07", 1), "2026-11-08");
  });

  test("the schedule groups by day, earliest first", () => {
    const groups = groupByBusinessDate(fixtures.reservations, tz);
    assert.deepEqual(
      groups.map((group) => group.date),
      ["2026-11-01", "2026-11-07", "2026-11-08"],
    );
    assert.equal(groups[1].rows.length, 2);
  });

  test("list filters by business date and status", async () => {
    const day = await get(`/api/outlets/${outlet.id}/reservations`, {
      date: "2026-11-07",
      limit: 100,
    });
    assert.equal(day.data.length, 2);

    const pendingOnly = await get(`/api/outlets/${outlet.id}/reservations`, {
      date: "2026-11-07",
      status: "pending_deposit",
      limit: 100,
    });
    assert.deepEqual(
      pendingOnly.data.map((row) => row.id),
      [ids.pendingReservationId],
    );
  });

  test("the empty scenario serves an empty page, not a broken payload", async () => {
    // The runtime's scenario switch is what the screens' empty state rides on.
    const { setScenario } = await import(
      "../apps/web/src/lib/mock/control.ts"
    );
    setScenario("empty");
    const page = await get(`/api/outlets/${outlet.id}/reservations`, {
      limit: 100,
    });
    assert.deepEqual(page.data, []);
    assert.equal(page.meta.nextCursor, null);
  });
});
