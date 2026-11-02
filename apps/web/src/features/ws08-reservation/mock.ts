// Mock mode for the reservation desk (VITE_API_MOCK=true): serves the
// @starter/shared/reservation fixtures with the same validation, state
// machines and conflict rules the API will apply, so the schedule, the table
// assignment, the waitlist and the pre-order packages fully work with no API
// (docs/frontend.md "Mock mode").
//
// Loaded in Node by tests/ws08-reservation-ui.test.mjs, so every import here is
// a bare package import or a relative `.ts` path (no `@/` alias).
//
// Per-runtime stores: a mutation changes this browser session only, and
// `window.__legendMock.reset()` re-seeds. Two known mock-only limits, both
// consistent again once the BE bead lands: opening a table session does not
// push into the WS-03 floor-board mock (separate feature store), and assigning
// tables does not flip the table's live status to `reserved`.
import {
  assignReservationTables,
  cafeLegendReservationFixtures,
  callWaitlistEntry,
  cancellationDepositOutcome,
  canTransitionReservation,
  canTransitionWaitlist,
  cancelReservation,
  depositIsSettled,
  getReservation,
  listReservationPackages,
  listReservations,
  listWaitlist,
  markReservationNoShow,
  noShowDepositOutcome,
  placeReservationPreOrder,
  reservationErrorHttpStatus,
  reservationErrorMessages,
  reservationPreOrderSchema,
  reservationSchema,
  reservationTableSlotSchema,
  resolveWaitlistEntry,
  seatReservation,
  waitlistEntrySchema,
} from "@starter/shared/reservation";
import type {
  Reservation,
  ReservationErrorCode,
  ReservationPreOrder,
  ReservationTableSlot,
  WaitlistEntry,
} from "@starter/shared/reservation";
import { cafeLegendFixtures, idr } from "@starter/shared/core";
import { tableSessionIdSchema } from "@starter/shared/qr-order";
import { cafeLegendMenuFixtures } from "@starter/shared/menu";
import { ApiError } from "../../lib/api/errors.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import {
  businessDateOf,
  conflictingReservations,
  reservationSlots,
  sortWaitlist,
  todayInZone,
} from "./lib.ts";

const fixtures = cafeLegendReservationFixtures;
const outlet = cafeLegendFixtures.outlets[0];
const outletId = outlet.id;
const tenantId = outlet.tenantId;
const nowIso = () => new Date().toISOString();
const mintId = () => crypto.randomUUID();

function fail(code: ReservationErrorCode): never {
  throw new ApiError(
    reservationErrorHttpStatus[code],
    code,
    reservationErrorMessages[code],
  );
}

function requireOutlet(requested: string): void {
  if (requested !== outletId)
    throw new ApiError(404, "NOT_FOUND", "Outlet tidak ditemukan.");
}

// ---- Stores ---------------------------------------------------------------

const reservations = createMockStore(() =>
  structuredClone(fixtures.reservations),
);
const slots = createMockStore(() => structuredClone(fixtures.tableSlots));
const waitlist = createMockStore(() => structuredClone(fixtures.waitlist));
const packages = createMockStore(() => structuredClone(fixtures.packages));
const preOrders = createMockStore(() => structuredClone(fixtures.preOrders));

function findReservation(id: string): Reservation {
  const found = reservations.get().find((row) => row.id === id);
  if (!found) fail("RESERVATION_NOT_FOUND");
  return found;
}

function findWaitlistEntry(id: string): WaitlistEntry {
  const found = waitlist.get().find((row) => row.id === id);
  if (!found) fail("WAITLIST_ENTRY_NOT_FOUND");
  return found;
}

function saveReservation(next: Reservation): Reservation {
  const parsed = reservationSchema.parse(next);
  reservations.set(
    reservations.get().map((row) => (row.id === parsed.id ? parsed : row)),
  );
  return parsed;
}

/**
 * Rewrites this reservation's rows in the slot join table after a status or
 * table change: closed reservations keep their history with `releasedAt`.
 */
function saveSlots(reservation: Reservation): void {
  const kept = slots
    .get()
    .filter((slot) => slot.reservationId !== reservation.id);
  const next: ReservationTableSlot[] = reservationSlots(reservation).map(
    (slot) =>
      reservationTableSlotSchema.parse({
        id: mintId(),
        tenantId,
        outletId,
        reservationId: reservation.id,
        ...slot,
      }),
  );
  slots.set([...kept, ...next]);
}

/** RSV-01: no chosen table may be held by another live reservation. */
function assertTablesFree(reservation: Reservation, tableIds: string[]): void {
  const others = reservations.get().filter((row) => row.id !== reservation.id);
  const taken = conflictingReservations(reservation, others);
  for (const tableId of tableIds)
    if (taken.has(tableId)) fail("RESERVATION_SLOT_TAKEN");
}

function detailOf(reservation: Reservation) {
  return {
    reservation,
    preOrder:
      preOrders.get().find((row) => row.reservationId === reservation.id) ??
      null,
    tableSlots: slots
      .get()
      .filter((slot) => slot.reservationId === reservation.id),
  };
}

function menuItemName(menuItemId: string): string {
  const item = cafeLegendMenuFixtures.items.find(
    (entry) => entry.id === menuItemId,
  );
  if (!item) throw new RangeError(`Unknown menu fixture id: ${menuItemId}`);
  return item.name;
}

// ---- Schedule -------------------------------------------------------------

registerMock(listReservations, ({ params, query, scenario }) => {
  requireOutlet(params.outletId);
  const today = todayInZone(outlet.timeZone);
  const rows = reservations
    .get()
    .filter((row) => {
      if (query.status !== undefined && row.status !== query.status)
        return false;
      if (query.zoneId !== undefined && row.zoneId !== query.zoneId)
        return false;
      const date = businessDateOf(row.reservedFor, outlet.timeZone);
      // No `date` means "all upcoming" (the contract's list query); a date
      // filter asks for that business date, past or future.
      return query.date === undefined ? date >= today : date === query.date;
    })
    .sort(
      (left, right) =>
        Date.parse(left.reservedFor) - Date.parse(right.reservedFor),
    );
  return paginateFixture(rows, query, (row) => row.id, scenario);
});

registerMock(getReservation, ({ params }) => {
  requireOutlet(params.outletId);
  return { data: detailOf(findReservation(params.reservationId)) };
});

// ---- Table assignment and the guest lifecycle -----------------------------

registerMock(assignReservationTables, ({ params, body }) => {
  requireOutlet(params.outletId);
  const current = findReservation(params.reservationId);
  // Tables are only (re)assigned while the party is still expected.
  if (!(current.status === "pending_deposit" || current.status === "confirmed"))
    fail("RESERVATION_TRANSITION_INVALID");
  assertTablesFree(current, body.tableIds);
  const next = saveReservation({
    ...current,
    tableIds: body.tableIds,
    updatedAt: nowIso(),
  });
  saveSlots(next);
  return { data: next };
});

registerMock(seatReservation, ({ params, body }) => {
  requireOutlet(params.outletId);
  const current = findReservation(params.reservationId);
  // RSV-02: a required DP is settled before the guest sits. Checked before the
  // status machine so a pending-DP booking reports the actionable cause.
  if (
    current.policy.depositRequirement === "required" &&
    !depositIsSettled(current.depositStatus)
  )
    fail("RESERVATION_DEPOSIT_UNPAID");
  if (!canTransitionReservation(current.status, "seated"))
    fail("RESERVATION_TRANSITION_INVALID");
  assertTablesFree(current, body.tableIds);
  const tableSessionId = tableSessionIdSchema.parse(mintId());
  const at = nowIso();
  const next = saveReservation({
    ...current,
    status: "seated",
    tableIds: body.tableIds,
    seatedAt: at,
    tableSessionId,
    updatedAt: at,
  });
  saveSlots(next);
  return { data: { reservation: next, tableSessionId } };
});

registerMock(cancelReservation, ({ params, body }) => {
  requireOutlet(params.outletId);
  const current = findReservation(params.reservationId);
  if (!canTransitionReservation(current.status, "cancelled"))
    fail("RESERVATION_TRANSITION_INVALID");
  const cancelledAt = nowIso();
  // §3.22: cancellation is a pre-arrival act; once the slot starts it is a
  // no-show. The screen only offers the button for open reservations.
  if (Date.parse(current.reservedFor) <= Date.parse(cancelledAt))
    fail("RESERVATION_TRANSITION_INVALID");
  const paid = depositIsSettled(current.depositStatus)
    ? current.depositIdr
    : idr(0);
  // RSV-03: the outcome follows the policy snapshot, not today's policy.
  const depositOutcome = cancellationDepositOutcome(current.policy, {
    depositPaidIdr: paid,
    reservedFor: current.reservedFor,
    cancelledAt,
  });
  const next = saveReservation({
    ...current,
    status: "cancelled",
    closedAt: cancelledAt,
    closeReason: body.reason,
    updatedAt: cancelledAt,
  });
  saveSlots(next);
  return { data: { reservation: next, depositOutcome } };
});

registerMock(markReservationNoShow, ({ params, body }) => {
  requireOutlet(params.outletId);
  const current = findReservation(params.reservationId);
  if (!canTransitionReservation(current.status, "no_show"))
    fail("RESERVATION_TRANSITION_INVALID");
  const paid = depositIsSettled(current.depositStatus)
    ? current.depositIdr
    : idr(0);
  const depositOutcome = noShowDepositOutcome(current.policy, {
    depositPaidIdr: paid,
  });
  const at = nowIso();
  const next = saveReservation({
    ...current,
    status: "no_show",
    closedAt: at,
    closeReason: body.note ?? null,
    updatedAt: at,
  });
  saveSlots(next);
  return { data: { reservation: next, depositOutcome } };
});

// ---- Event pre-order packages --------------------------------------------

registerMock(listReservationPackages, ({ params, scenario }) => {
  requireOutlet(params.outletId);
  if (scenario === "empty") return { data: [] };
  return {
    data: [...packages.get()].sort(
      (left, right) => left.sortOrder - right.sortOrder,
    ),
  };
});

registerMock(placeReservationPreOrder, ({ params, body }) => {
  requireOutlet(params.outletId);
  const current = findReservation(params.reservationId);
  if (!(current.status === "pending_deposit" || current.status === "confirmed"))
    fail("RESERVATION_TRANSITION_INVALID");
  const pack = packages.get().find((row) => row.id === body.packageId);
  if (!pack || pack.status !== "active")
    fail("RESERVATION_PACKAGE_UNAVAILABLE");
  if (current.pax < pack.minPax || current.pax > pack.maxPax)
    fail("RESERVATION_PACKAGE_UNAVAILABLE");
  // §3.22 "sebelum hari H": the package's lead time must still be met.
  const hoursToEvent =
    (Date.parse(current.reservedFor) - Date.parse(nowIso())) / 3_600_000;
  if (hoursToEvent < pack.leadTimeHours)
    fail("RESERVATION_PACKAGE_UNAVAILABLE");
  const existing = preOrders
    .get()
    .find((row) => row.reservationId === current.id);
  if (
    existing &&
    (existing.status === "preparing" || existing.status === "served")
  )
    fail("RESERVATION_TRANSITION_INVALID");

  const preOrder: ReservationPreOrder = reservationPreOrderSchema.parse({
    id: existing?.id ?? mintId(),
    tenantId,
    outletId,
    reservationId: current.id,
    packageId: pack.id,
    packageName: pack.name,
    pax: current.pax,
    items: pack.items.map((item) => ({
      menuItemId: item.menuItemId,
      name: menuItemName(item.menuItemId),
      quantityPerPax: item.quantity,
    })),
    pricePerPaxIdr: pack.pricePerPaxIdr,
    subtotalIdr: pack.pricePerPaxIdr * current.pax,
    status: "confirmed",
    orderId: existing?.orderId ?? null,
    createdAt: existing?.createdAt ?? nowIso(),
  });
  preOrders.set(
    existing
      ? preOrders.get().map((row) => (row.id === preOrder.id ? preOrder : row))
      : [preOrder, ...preOrders.get()],
  );
  return { data: preOrder };
});

// ---- Waitlist -------------------------------------------------------------

registerMock(listWaitlist, ({ params, query, scenario }) => {
  requireOutlet(params.outletId);
  const rows = sortWaitlist(
    waitlist
      .get()
      .filter(
        (row) => query.status === undefined || row.status === query.status,
      ),
  );
  return paginateFixture(rows, query, (row) => row.id, scenario);
});

registerMock(callWaitlistEntry, ({ params }) => {
  requireOutlet(params.outletId);
  const current = findWaitlistEntry(params.entryId);
  if (!canTransitionWaitlist(current.status, "called"))
    fail("WAITLIST_TRANSITION_INVALID");
  const next = waitlistEntrySchema.parse({
    ...current,
    status: "called",
    calledAt: nowIso(),
  });
  waitlist.set(waitlist.get().map((row) => (row.id === next.id ? next : row)));
  return { data: next };
});

registerMock(resolveWaitlistEntry, ({ params, body }) => {
  requireOutlet(params.outletId);
  const current = findWaitlistEntry(params.entryId);
  if (!canTransitionWaitlist(current.status, body.resolution))
    fail("WAITLIST_TRANSITION_INVALID");
  const at = nowIso();
  const next = waitlistEntrySchema.parse({
    ...current,
    status: body.resolution,
    seatedAt: body.resolution === "seated" ? at : current.seatedAt,
    leftAt: body.resolution === "left" ? at : current.leftAt,
    estimatedWaitMinutes: null,
  });
  waitlist.set(waitlist.get().map((row) => (row.id === next.id ? next : row)));
  return {
    data: {
      entry: next,
      tableSessionId: body.resolution === "seated" ? mintId() : null,
    },
  };
});
