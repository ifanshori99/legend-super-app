// Guest self-service link contract tests (bead legend-o5gr).
// PRD v1.7 §3.22 DP & Kebijakan; RSV-03 (cancel follows the booking snapshot).
import assert from "node:assert/strict";
import { test } from "node:test";
import { pathParamNames } from "../packages/shared/src/api/endpoint.ts";
import * as rsv from "../packages/shared/src/reservation/index.ts";

const f = rsv.cafeLegendReservationFixtures;
const confirmed = f.reservations[1];
const token = "A".repeat(43);

const request = {
  id: "00000000-0000-4000-8000-0000000000a1",
  reservationId: confirmed.id,
  outletId: confirmed.outletId,
  requestedFor: "2026-11-20T12:00:00.000Z",
  partySize: 4,
  note: null,
  status: "pending",
  createdAt: "2026-11-08T03:00:00.000Z",
  resolvedAt: null,
};

const view = {
  reservationId: confirmed.id,
  outletId: confirmed.outletId,
  outletName: "Cafe Legend",
  guestName: confirmed.guestName,
  partySize: confirmed.pax,
  timeZone: "Asia/Makassar",
  reservedFor: confirmed.reservedFor,
  status: confirmed.status,
  note: confirmed.note,
  policy: confirmed.policy,
  deposit: {
    amountIdr: confirmed.depositIdr,
    paidIdr: confirmed.depositIdr,
    refundIdr: null,
    forfeitedIdr: null,
    refundStatus: null,
  },
  cancellation: {
    allowed: true,
    freeUntil: "2026-11-01T00:00:00.000Z",
    preview: {
      resolution: "refund_full",
      refundIdr: confirmed.depositIdr,
      forfeitedIdr: 0,
      policyVersion: confirmed.policy.version,
    },
  },
  rescheduleRequest: request,
  rescheduleDecision: null,
  linkExpiresAt: "2026-12-01T00:00:00.000Z",
};

test("guest view parses and never carries contact data or table ids", () => {
  const parsed = rsv.guestReservationViewSchema.parse(view);
  for (const key of ["contactHash", "contactPhone", "tableIds", "createdBy"])
    assert.equal(key in parsed, false, key);
  assert.throws(() =>
    rsv.guestReservationViewSchema.parse({ ...view, contactHash: "x" }),
  );
  assert.throws(() =>
    rsv.guestReservationViewSchema.parse({ ...view, tableIds: [] }),
  );
});

test("link token must be 43 base64url characters", () => {
  assert.equal(rsv.RESERVATION_LINK_TOKEN_HEADER, "x-reservation-link-token");
  assert.ok(rsv.reservationLinkTokenSchema.safeParse(token).success);
  for (const bad of ["", "A".repeat(42), "A".repeat(44), `${"A".repeat(42)}=`])
    assert.equal(rsv.reservationLinkTokenSchema.safeParse(bad).success, false);
  assert.ok(
    rsv.issueGuestLinkResultSchema.safeParse({
      token,
      expiresAt: "2026-12-01T00:00:00.000Z",
    }).success,
  );
});

test("guest inputs are strict and bounded", () => {
  assert.ok(rsv.guestCancelInputSchema.safeParse({}).success);
  assert.equal(
    rsv.guestCancelInputSchema.safeParse({ reason: "" }).success,
    false,
  );
  assert.equal(
    rsv.guestCancelInputSchema.safeParse({ reason: "x".repeat(301) }).success,
    false,
  );
  assert.equal(
    rsv.guestCancelInputSchema.safeParse({ tenantId: "x" }).success,
    false,
  );
  const base = { requestedFor: "2026-11-20T12:00:00.000Z" };
  assert.ok(rsv.guestRescheduleInputSchema.safeParse(base).success);
  assert.equal(
    rsv.guestRescheduleInputSchema.safeParse({ ...base, partySize: 51 })
      .success,
    false,
  );
  assert.equal(
    rsv.guestRescheduleInputSchema.safeParse({ ...base, note: "x".repeat(301) })
      .success,
    false,
  );
});

test("cancel and reschedule results parse", () => {
  assert.ok(
    rsv.guestCancelResultSchema.safeParse({
      view,
      depositOutcome: view.cancellation.preview,
      alreadyCancelled: false,
    }).success,
  );
  assert.ok(
    rsv.guestRescheduleResultSchema.safeParse({ view, request }).success,
  );
});

test("link error codes carry status and Indonesian message", () => {
  assert.equal(rsv.reservationErrorHttpStatus.RESERVATION_LINK_INVALID, 404);
  assert.equal(
    rsv.reservationErrorHttpStatus.RESERVATION_RESCHEDULE_PENDING,
    409,
  );
  assert.equal(
    rsv.reservationErrorHttpStatus.RESERVATION_RESCHEDULE_INVALID,
    422,
  );
  assert.equal(
    new rsv.ReservationError("RESERVATION_LINK_INVALID").message,
    "Tautan reservasi tidak berlaku.",
  );
});

test("self-service endpoints declare every path param", () => {
  for (const endpoint of [
    rsv.getGuestReservation,
    rsv.cancelGuestReservation,
    rsv.requestGuestReschedule,
    rsv.issueReservationGuestLink,
    rsv.revokeReservationGuestLink,
    rsv.listRescheduleRequests,
  ])
    for (const name of pathParamNames(endpoint.path))
      assert.ok(name in endpoint.params.shape, `${endpoint.path} ${name}`);
  assert.equal(rsv.getGuestReservation.path, "/api/public/reservation-link");
  assert.equal(rsv.revokeReservationGuestLink.method, "DELETE");
  assert.equal(rsv.listRescheduleRequestsQuerySchema.parse({}).limit, 25);
});
