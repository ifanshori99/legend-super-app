// Reservation, waitlist and event pre-order contract tests (bead legend-m7ak).
// Acceptance IDs: RSV-01 (no overlapping table slots), RSV-02 (a paid DP is a
// deposit allocated on seating), RSV-03 (cancellation follows the snapshot in
// force at booking); PRD v1.7 §3 F19 / §3.22, §6.G reservations and
// waitlist_entries.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildEndpointPath,
  pathParamNames,
} from "../packages/shared/src/api/endpoint.ts";
import { eventCatalog } from "../packages/shared/src/events/index.ts";
import { idr } from "../packages/shared/src/core/index.ts";
import * as rsv from "../packages/shared/src/reservation/index.ts";

const f = rsv.cafeLegendReservationFixtures;
const ids = rsv.reservationFixtureIds;

test("F19 Cafe Legend reservation fixtures parse and stay coherent (§6.G reservations)", () => {
  rsv.reservationFixtureSchema.parse(f);
  assert.equal(f.policies.length, 3);
  assert.equal(f.reservations.length, 6);
  assert.equal(f.waitlist.length, 4);
  assert.equal(f.packages.length, 2);
  assert.equal(f.preOrders.length, 2);

  // Every table slot belongs to its reservation, uses the same half-open
  // interval arithmetic and only names an assigned table.
  for (const slot of f.tableSlots) {
    const reservation = f.reservations.find(
      (row) => row.id === slot.reservationId,
    );
    assert.ok(reservation, slot.reservationId);
    assert.ok(reservation.tableIds.includes(slot.tableId));
    assert.equal(
      slot.endsAt,
      rsv.reservationEndsAt(
        reservation.reservedFor,
        reservation.durationMinutes,
      ),
    );
  }

  // §3.22: a pending deposit waits for its DP link; a confirmed private room
  // carries the paid DP and its minimum spend.
  const pending = f.reservations[0];
  assert.equal(pending.status, "pending_deposit");
  assert.ok(pending.depositPaymentId);
  assert.equal(pending.depositStatus, "pending");
  const confirmed = f.reservations[1];
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.depositStatus, "paid");
  assert.equal(confirmed.policy.minimumSpendIdr, 500_000);
  // A seated reservation names the QR order table session it opened.
  assert.equal(f.reservations[2].status, "seated");
  assert.ok(f.reservations[2].tableSessionId);
  // The cancelled reservation keeps its released slot as history.
  assert.equal(f.reservations[4].status, "cancelled");
  assert.ok(
    f.tableSlots.find((slot) => slot.reservationId === f.reservations[4].id)
      ?.releasedAt,
  );

  // The pre-order is pax × package price per person, net of tax and service.
  for (const preOrder of f.preOrders) {
    assert.equal(preOrder.subtotalIdr, preOrder.pax * preOrder.pricePerPaxIdr);
    assert.ok(preOrder.items.length > 0);
  }
  // A served pre-order names the kitchen order it became.
  assert.equal(f.preOrders[1].status, "served");
  assert.ok(f.preOrders[1].orderId);
});

test("RSV-01 two reservations cannot hold the same table in overlapping slots", () => {
  const morning = {
    tableId: "00000000-0000-4000-8000-000000000201",
    startsAt: "2026-11-07T11:00:00.000Z",
    endsAt: "2026-11-07T12:30:00.000Z",
    releasedAt: null,
  };
  const backToBack = {
    ...morning,
    startsAt: "2026-11-07T12:30:00.000Z",
    endsAt: "2026-11-07T14:00:00.000Z",
  };
  const overlapping = {
    ...morning,
    startsAt: "2026-11-07T12:00:00.000Z",
    endsAt: "2026-11-07T13:15:00.000Z",
  };
  // Half-open [startsAt, endsAt): touching slots do not overlap.
  assert.equal(rsv.reservationTableSlotsOverlap(morning, backToBack), false);
  assert.equal(rsv.reservationTableSlotsOverlap(morning, overlapping), true);
  // A different table never conflicts.
  assert.equal(
    rsv.reservationTableSlotsOverlap(morning, {
      ...overlapping,
      tableId: "00000000-0000-4000-8000-000000000202",
    }),
    false,
  );
  assert.throws(
    () =>
      rsv.assertNoReservationSlotOverlap(morning, [backToBack, overlapping]),
    (error) => error.code === "RESERVATION_SLOT_TAKEN",
  );
  assert.equal(
    rsv.reservationRangeLiteral(morning),
    '["2026-11-07T11:00:00.000Z","2026-11-07T12:30:00.000Z")',
  );
});

test("RSV-01 a cancelled reservation releases its table for the next guest", () => {
  const released = {
    tableId: "00000000-0000-4000-8000-000000000201",
    startsAt: "2026-11-08T05:00:00.000Z",
    endsAt: "2026-11-08T06:30:00.000Z",
    releasedAt: "2026-11-08T03:00:00.000Z",
  };
  const candidate = {
    tableId: released.tableId,
    startsAt: released.startsAt,
    endsAt: released.endsAt,
    releasedAt: null,
  };
  assert.equal(rsv.reservationTableSlotsOverlap(candidate, released), false);
  // The fixture's cancelled reservation keeps a released slot, so a new
  // booking at the same table and time passes the check.
  const cancelledSlot = f.tableSlots.find(
    (slot) => slot.reservationId === ids.cancelledReservationId,
  );
  assert.ok(cancelledSlot);
  assert.ok(cancelledSlot.releasedAt);
  assert.doesNotThrow(() =>
    rsv.assertNoReservationSlotOverlap(
      {
        tableId: cancelledSlot.tableId,
        startsAt: cancelledSlot.startsAt,
        endsAt: cancelledSlot.endsAt,
        releasedAt: null,
      },
      [cancelledSlot],
    ),
  );
});

test("RSV-02 a paid DP is a deposit: confirmed needs it settled, seating allocates it", () => {
  assert.equal(rsv.depositIsSettled("paid"), true);
  assert.equal(rsv.depositIsSettled("partially_refunded"), true);
  assert.equal(rsv.depositIsSettled("pending"), false);
  assert.equal(rsv.depositIsSettled(null), false);

  // A confirmed reservation whose required DP is still pending is invalid.
  const unpaid = structuredClone(f.reservations[1]);
  unpaid.depositStatus = "pending";
  assert.equal(rsv.reservationSchema.safeParse(unpaid).success, false);

  // The DP amount is the snapshot's, never another number (RSV-02/03).
  const wrongAmount = structuredClone(f.reservations[1]);
  wrongAmount.depositIdr = wrongAmount.policy.depositAmountIdr - 1;
  assert.equal(rsv.reservationSchema.safeParse(wrongAmount).success, false);
  const optional = structuredClone(f.reservations[1]);
  optional.policy.depositRequirement = "optional";
  assert.equal(rsv.reservationSchema.safeParse(optional).success, true);
  optional.depositIdr = optional.policy.depositAmountIdr + 1;
  assert.equal(rsv.reservationSchema.safeParse(optional).success, false);

  // A seated reservation keeps its required DP settled.
  const seatedUnpaid = structuredClone(f.reservations[2]);
  seatedUnpaid.depositStatus = "pending";
  assert.equal(rsv.reservationSchema.safeParse(seatedUnpaid).success, false);

  // pending_deposit must carry the payment intent it waits for.
  const noIntent = structuredClone(f.reservations[0]);
  noIntent.depositPaymentId = null;
  noIntent.depositStatus = null;
  assert.equal(rsv.reservationSchema.safeParse(noIntent).success, false);

  // Seating allocates the paid DP to the table session's bill.
  const seated = f.reservations[2];
  assert.equal(seated.depositStatus, "paid");
  assert.equal(
    rsv.reservationEventFixtures.seated.payload.depositAllocatedIdr,
    seated.depositIdr,
  );
  assert.equal(
    rsv.reservationEventFixtures.seated.payload.tableSessionId,
    seated.tableSessionId,
  );
});

test("RSV-03 cancellation and no-show follow the policy snapshot taken at booking", () => {
  const regular = f.policies[0];
  const paid = idr(50_000);
  const reservedFor = "2026-11-07T12:00:00.000Z";

  const early = rsv.cancellationDepositOutcome(regular, {
    depositPaidIdr: paid,
    reservedFor,
    cancelledAt: "2026-11-05T12:00:00.000Z",
  });
  assert.deepEqual(
    {
      resolution: early.resolution,
      refund: early.refundIdr,
      forfeited: early.forfeitedIdr,
    },
    { resolution: "refund_full", refund: 50_000, forfeited: 0 },
  );

  const late = rsv.cancellationDepositOutcome(regular, {
    depositPaidIdr: paid,
    reservedFor,
    cancelledAt: "2026-11-07T10:00:00.000Z",
  });
  assert.deepEqual(
    {
      resolution: late.resolution,
      refund: late.refundIdr,
      forfeited: late.forfeitedIdr,
    },
    { resolution: "refund_partial", refund: 25_000, forfeited: 25_000 },
  );
  assert.equal(late.policyVersion, regular.version);

  const noShow = rsv.noShowDepositOutcome(regular, { depositPaidIdr: paid });
  assert.deepEqual(
    {
      resolution: noShow.resolution,
      refund: noShow.refundIdr,
      forfeited: noShow.forfeitedIdr,
    },
    { resolution: "no_refund", refund: 0, forfeited: 50_000 },
  );

  const noDeposit = rsv.cancellationDepositOutcome(f.policies[2], {
    depositPaidIdr: idr(0),
    reservedFor,
    cancelledAt: "2026-11-07T10:00:00.000Z",
  });
  assert.equal(noDeposit.resolution, "nothing_paid");

  // The fixture's cancelled reservation was cancelled three hours before its
  // slot, so its own snapshot refunds half of the DP (RSV-03).
  const cancelled = f.reservations.find(
    (row) => row.id === ids.cancelledReservationId,
  );
  assert.ok(cancelled);
  const outcome = rsv.cancellationDepositOutcome(cancelled.policy, {
    depositPaidIdr: idr(cancelled.depositIdr),
    reservedFor: cancelled.reservedFor,
    cancelledAt: cancelled.closedAt,
  });
  assert.equal(outcome.resolution, "refund_partial");
  assert.equal(outcome.refundIdr, 25_000);
  assert.equal(outcome.policyVersion, cancelled.policy.version);

  // Once the slot started, cancelling is not the resolution: it is a no-show.
  assert.throws(
    () =>
      rsv.cancellationDepositOutcome(regular, {
        depositPaidIdr: paid,
        reservedFor,
        cancelledAt: reservedFor,
      }),
    (error) => error.code === "RESERVATION_TRANSITION_INVALID",
  );
});

test("§6.G reservation state machine has no skipped steps", () => {
  assert.equal(
    rsv.canTransitionReservation("pending_deposit", "confirmed"),
    true,
  );
  assert.equal(
    rsv.canTransitionReservation("pending_deposit", "seated"),
    false,
  );
  assert.equal(rsv.canTransitionReservation("confirmed", "seated"), true);
  assert.equal(rsv.canTransitionReservation("seated", "completed"), true);
  assert.equal(rsv.canTransitionReservation("completed", "seated"), false);
  assert.equal(rsv.canTransitionReservation("cancelled", "confirmed"), false);
  assert.throws(
    () => rsv.assertReservationTransition("completed", "cancelled"),
    (error) => error.code === "RESERVATION_TRANSITION_INVALID",
  );
  // A policy snapshot never carries a DP amount it does not require.
  const inconsistent = { ...f.policies[2], depositAmountIdr: idr(10_000) };
  assert.equal(
    rsv.reservationPolicySnapshotSchema.safeParse(inconsistent).success,
    false,
  );
});

test("F19 waitlist walk-ins are called, seated or released in order (§3.22)", () => {
  assert.equal(rsv.canTransitionWaitlist("waiting", "called"), true);
  assert.equal(rsv.canTransitionWaitlist("waiting", "seated"), false);
  assert.equal(rsv.canTransitionWaitlist("called", "seated"), true);
  assert.equal(rsv.canTransitionWaitlist("called", "left"), true);
  assert.equal(rsv.canTransitionWaitlist("seated", "left"), false);
  assert.throws(
    () => rsv.assertWaitlistTransition("left", "called"),
    (error) => error.code === "WAITLIST_TRANSITION_INVALID",
  );
  // The fixture covers every live state and only the called entry has a call instant.
  const byStatus = Object.fromEntries(
    f.waitlist.map((entry) => [entry.status, entry]),
  );
  assert.ok(byStatus.waiting.calledAt === null);
  assert.ok(byStatus.called.calledAt);
  assert.ok(byStatus.seated.seatedAt);
  assert.ok(byStatus.left.leftAt);
  // A called entry stores only a contact hash, never a phone number.
  for (const entry of f.waitlist)
    assert.match(entry.contactHash, /^[a-f0-9]{64}$/);
  // The quote the FE receives is bounded, never absurd.
  assert.equal(rsv.clampWaitEstimate(-5), 0);
  assert.equal(rsv.clampWaitEstimate(12.4), 12);
  assert.equal(rsv.clampWaitEstimate(99_999), 600);
});

test("F19 event pre-orders reuse the reservation channel and stay net of tax", () => {
  for (const pack of f.packages) {
    assert.ok(pack.maxPax >= pack.minPax);
    assert.ok(pack.pricePerPaxIdr > 0);
    assert.ok(pack.leadTimeHours > 0);
    assert.ok(pack.items.length >= 1);
  }
  // Menu prices exclude tax and service (owner decision, 1 Nov 2026): the
  // pre-order subtotal is pax × net package price, not a taxed total.
  const family = f.preOrders.find(
    (preOrder) => preOrder.packageId === ids.privateRoomPackageId,
  );
  assert.ok(family);
  assert.equal(family.subtotalIdr, 8 * 135_000);
  assert.equal(rsv.RESERVATION_ORDER_CHANNEL, "reservation");
  // The package's per-person composition is snapshotted on the pre-order.
  assert.deepEqual(
    family.items.map((item) => item.quantityPerPax),
    [1, 1, 1],
  );
});

test("reservation events are registered in the WS-00 catalog with typed payloads (§6.G)", () => {
  const names = eventCatalog.map((entry) => entry.name);
  for (const event of rsv.reservationEventCatalogEntries) {
    assert.ok(names.includes(event.name), event.name);
    assert.equal(event.workstream, "WS-08");
    assert.equal(event.version, 1);
    assert.equal(event.payloadSchemaRef, `${event.name}.v1`);
  }
  assert.deepEqual(
    rsv.reservationEventCatalogEntries.map((entry) => entry.name),
    rsv.reservationEventNames,
  );
  const created = rsv.reservationEventFixtures.created;
  assert.ok(rsv.reservationEventSchema.parse(created));
  // A cancelled payload with a mismatched split is rejected: refund plus
  // forfeit must reconcile the DP that was paid.
  assert.equal(
    rsv.reservationEventSchema.safeParse({
      ...rsv.reservationEventFixtures.cancelled,
      payload: {
        ...rsv.reservationEventFixtures.cancelled.payload,
        depositRefundIdr: 30_000,
        depositForfeitedIdr: 10_000,
      },
    }).success,
    false,
  );
  // The wrong event name or a negative refund fails.
  assert.equal(
    rsv.reservationEventSchema.safeParse({
      ...created,
      name: "reservation.seated",
    }).success,
    false,
  );
  assert.equal(
    rsv.reservationEventSchema.safeParse({
      ...created,
      payload: { ...created.payload, depositIdr: -1 },
    }).success,
    false,
  );
  assert.equal(rsv.reservationEventPayloadSchema("order.paid"), null);
  assert.equal(rsv.reservationEventPayloadSchema("constructor"), null);
  // Guest PII never rides along: the created payload has no phone or name.
  assert.equal(Object.hasOwn(created.payload, "contactPhone"), false);
  assert.equal(Object.hasOwn(created.payload, "guestName"), false);
  // Every reservation envelope is bound to its catalog entry.
  for (const name of rsv.reservationEventNames)
    assert.equal(rsv.reservationEvents[name].version, 1);
});

test("reservation endpoint contracts are unique and path-param complete", () => {
  const endpoints = Object.values(rsv).filter(
    (value) =>
      value &&
      typeof value === "object" &&
      typeof value.id === "string" &&
      typeof value.method === "string" &&
      typeof value.path === "string" &&
      value.id === `${value.method} ${value.path}`,
  );
  assert.ok(endpoints.length >= 12, `found ${endpoints.length} endpoints`);
  const paths = endpoints.map((endpoint) => endpoint.id);
  assert.equal(new Set(paths).size, paths.length);
  for (const endpoint of endpoints) {
    assert.ok(endpoint.path.startsWith("/"), endpoint.id);
    const names = pathParamNames(endpoint.path);
    if (names.length > 0) assert.ok(endpoint.params, endpoint.id);
    for (const name of names)
      assert.ok(
        Object.hasOwn(endpoint.params.shape, name),
        `${endpoint.id} declares no schema for :${name}`,
      );
  }
  assert.equal(
    buildEndpointPath(rsv.createReservation.path, {
      outletId: f.reservations[0].outletId,
    }),
    `/api/public/outlets/${f.reservations[0].outletId}/reservations`,
  );
  // The public form rejects a submitted tenant id and any money field (TEN-02).
  assert.equal(
    rsv.createReservationInputSchema.safeParse({
      reservedFor: "2026-11-07T12:00:00.000Z",
      pax: 2,
      guestName: "Dewi Lestari",
      contactPhone: "6281234567890",
      tenantId: f.reservations[0].tenantId,
    }).success,
    false,
  );
  assert.equal(
    rsv.createReservationInputSchema.safeParse({
      reservedFor: "2026-11-07T12:00:00.000Z",
      pax: 2,
      guestName: "Dewi Lestari",
      contactPhone: "6281234567890",
      depositIdr: 1,
    }).success,
    false,
  );
});

test("guest contact is a keyed digest, never a bare SHA-256 of the phone", async () => {
  const secret = "reservation-contact-secret-0001";
  const phone = "6281234567890";
  const digest = await rsv.hashGuestContact(phone, secret);
  assert.match(digest, /^[a-f0-9]{64}$/);
  // Deterministic for the same secret, so reservations and the waitlist link.
  assert.equal(await rsv.hashGuestContact(phone, secret), digest);
  // Different secret → different digest; a bare SHA-256 is not accepted.
  assert.notEqual(
    await rsv.hashGuestContact(phone, "another-secret-of-16+chars"),
    digest,
  );
  const { createHash } = await import("node:crypto");
  assert.notEqual(createHash("sha256").update(phone).digest("hex"), digest);
  await assert.rejects(() => rsv.hashGuestContact(phone, "short"), TypeError);
  // One normalizer: local and formatted forms hash like the 628… form.
  assert.equal(await rsv.hashGuestContact("+62 812-3456-7890", secret), digest);
  assert.equal(await rsv.hashGuestContact("081234567890", secret), digest);
  await assert.rejects(() => rsv.hashGuestContact("not a phone", secret));
  // The digest stays write-only: no event payload carries it.
  for (const event of Object.values(rsv.reservationEventFixtures))
    assert.equal(
      JSON.stringify(event).includes(f.reservations[0].contactHash),
      false,
    );
});
