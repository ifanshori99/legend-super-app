// Mock for the guest reservation page (VITE_API_MOCK=true): Cafe Legend ·
// Menteng, 18 Nov 2026 19.00 WIB, 4 guests, DP Rp50.000, free cancellation
// until 17 Nov 19.00 WIB. Fixture only; the late preview (refund 25.000,
// forfeit 25.000) is a fixture too, not a computed figure.
//
// Open the page with a valid-shaped link such as
//   /reservasi/kelola#AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdE   (43 chars)
// and pick the scenario with the query string (browser only):
//   ?demo=detail (default) | pending | approved | rejected | late | cancelled
//   ?demo=cancelled-late | closed | invalid | error | rate-limit
// `invalid` answers the one 404 every bad link gets, `error` a 503 ("Coba
// lagi"), `rate-limit` a 429. A missing or malformed token never reaches the
// mock: the page shows the invalid-link state by itself.
//
// Mutations change the in-memory view, so cancelling shows the cancelled
// screen on the next read. Rescheduling a booking that is late answers 409
// RESERVATION_RESCHEDULE_LATE (founder W3 Q13: late reschedules are refused).
// legend-z5ygw: the server returns only pending requests today; `approved` and
// `rejected` exist here so the UI for resolved requests can be built.
import type {
  GuestReservationView,
  ReservationDepositOutcome,
  ReservationRescheduleRequest,
} from "@starter/shared/reservation";
import {
  cancelGuestReservation,
  getGuestReservation,
  requestGuestReschedule,
  reservationIdSchema,
} from "@starter/shared/reservation";
import { cafeLegendFixtures, idr } from "@starter/shared/core";
import { ApiError } from "../../lib/api/errors.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";

const RESERVATION_ID = reservationIdSchema.parse(
  "00000000-0000-4000-8000-0000000000a1",
);
const REQUEST_ID = "00000000-0000-4000-8000-0000000000a2";
const POLICY_VERSION = "2026-11.1";
/** 18 Nov 2026 19.00 WIB. */
const RESERVED_FOR = "2026-11-18T12:00:00.000Z";
/** 17 Nov 2026 19.00 WIB: 24 hours before. */
const FREE_UNTIL = "2026-11-17T12:00:00.000Z";
/** Thu 19 Nov 2026 19.30 WIB, the time the guest asked for. */
const REQUESTED_FOR = "2026-11-19T12:30:00.000Z";
/** Wed 18 Nov 2026 19.30 WIB: 24 hours before the requested time. */
const REQUESTED_FREE_UNTIL = "2026-11-18T12:30:00.000Z";

function demo(): string {
  if (typeof window === "undefined") return "detail";
  try {
    return new URLSearchParams(window.location.search).get("demo") ?? "detail";
  } catch {
    return "detail";
  }
}

const request = (
  status: ReservationRescheduleRequest["status"],
): ReservationRescheduleRequest => ({
  id: REQUEST_ID,
  reservationId: RESERVATION_ID,
  outletId: cafeLegendFixtures.outlets[0].id,
  requestedFor: REQUESTED_FOR,
  partySize: null,
  note: null,
  status,
  createdAt: "2026-11-14T03:00:00.000Z",
  resolvedAt: status === "pending" ? null : "2026-11-14T05:00:00.000Z",
});

const confirmed: GuestReservationView = {
  reservationId: RESERVATION_ID,
  outletId: cafeLegendFixtures.outlets[0].id,
  outletName: "Cafe Legend · Menteng",
  guestName: "Rina",
  partySize: 4,
  timeZone: "Asia/Jakarta",
  reservedFor: RESERVED_FOR,
  status: "confirmed",
  note: null,
  policy: {
    version: POLICY_VERSION,
    depositRequirement: "required",
    depositAmountIdr: idr(50_000),
    paymentWindowMinutes: 30,
    freeCancellationHours: 24,
    lateCancellationRefundBp: 5_000,
    noShowRefundBp: 0,
    minimumSpendIdr: idr(0),
    capturedAt: "2026-11-10T02:00:00.000Z",
  },
  deposit: {
    amountIdr: idr(50_000),
    paidIdr: idr(50_000),
    refundIdr: null,
    forfeitedIdr: null,
    refundStatus: null,
  },
  cancellation: {
    allowed: true,
    freeUntil: FREE_UNTIL,
    preview: {
      resolution: "refund_full",
      refundIdr: idr(50_000),
      forfeitedIdr: idr(0),
      policyVersion: POLICY_VERSION,
    },
  },
  rescheduleRequest: null,
  rescheduleDecision: null,
  linkExpiresAt: "2026-11-19T12:00:00.000Z",
};

const latePreview: ReservationDepositOutcome = {
  resolution: "refund_partial",
  refundIdr: idr(25_000),
  forfeitedIdr: idr(25_000),
  policyVersion: POLICY_VERSION,
};

/** The view a scenario starts from. */
function seedView(seed: string): GuestReservationView {
  const view = structuredClone(confirmed);
  switch (seed) {
    case "pending":
      return { ...view, rescheduleRequest: request("pending") };
    case "approved":
      return {
        ...view,
        reservedFor: REQUESTED_FOR,
        cancellation: { ...view.cancellation, freeUntil: REQUESTED_FREE_UNTIL },
        rescheduleRequest: request("approved"),
      };
    case "rejected":
      return { ...view, rescheduleRequest: request("declined") };
    case "late":
    case "cancelled-late":
      return {
        ...view,
        cancellation: { ...view.cancellation, preview: latePreview },
      };
    case "cancelled":
      return cancelledView(view, confirmed.cancellation.preview);
    case "closed":
      return {
        ...view,
        status: "completed",
        cancellation: { ...view.cancellation, allowed: false, preview: null },
      };
    default:
      return view;
  }
}

/** The view after a cancel; the amounts are copied from the outcome. */
function cancelledView(
  view: GuestReservationView,
  outcome: ReservationDepositOutcome | null,
): GuestReservationView {
  return {
    ...view,
    status: "cancelled",
    deposit: {
      ...view.deposit,
      refundIdr: outcome?.refundIdr ?? null,
      forfeitedIdr: outcome?.forfeitedIdr ?? null,
      refundStatus: outcome && outcome.refundIdr > 0 ? "pending" : null,
    },
    cancellation: { ...view.cancellation, allowed: false, preview: null },
  };
}

/** What happened to the DP of an already cancelled view, from its own fields. */
function outcomeOf(view: GuestReservationView): ReservationDepositOutcome {
  const refundIdr = view.deposit.refundIdr ?? idr(0);
  const forfeitedIdr = view.deposit.forfeitedIdr ?? idr(0);
  const resolution =
    forfeitedIdr > 0
      ? refundIdr > 0
        ? "refund_partial"
        : "no_refund"
      : refundIdr > 0
        ? "refund_full"
        : "nothing_paid";
  return { resolution, refundIdr, forfeitedIdr, policyVersion: POLICY_VERSION };
}

/** The scenario's view, kept between calls so a mutation shows on the next read. */
const store = createMockStore<{ seed: string; view: GuestReservationView }>(
  () => ({ seed: "", view: confirmed }),
);

function current(): GuestReservationView {
  const seed = demo();
  const held = store.get();
  if (held.seed === seed) return held.view;
  const view = seedView(seed);
  store.set({ seed, view });
  return view;
}

function save(view: GuestReservationView) {
  store.set({ seed: demo(), view });
}

/** The failure scenarios answer the same on every guest endpoint. */
function failIfScenario() {
  switch (demo()) {
    case "invalid":
      throw new ApiError(
        404,
        "RESERVATION_LINK_INVALID",
        "Tautan reservasi tidak berlaku.",
      );
    case "error":
      throw new ApiError(503, "SERVICE_UNAVAILABLE", "Layanan belum tersedia.");
    case "rate-limit":
      throw new ApiError(
        429,
        "RATE_LIMITED",
        "Terlalu banyak percobaan. Coba lagi sebentar.",
      );
  }
}

function isLate(view: GuestReservationView, now: Date): boolean {
  return (
    (view.cancellation.preview?.forfeitedIdr ?? 0) > 0 ||
    now.getTime() >= Date.parse(view.reservedFor)
  );
}

registerMock(getGuestReservation, () => {
  failIfScenario();
  return { data: current() };
});

registerMock(cancelGuestReservation, () => {
  failIfScenario();
  const view = current();
  if (view.status === "cancelled")
    return {
      data: { view, depositOutcome: outcomeOf(view), alreadyCancelled: true },
    };
  if (!view.cancellation.allowed || !view.cancellation.preview)
    throw new ApiError(
      409,
      "RESERVATION_TRANSITION_INVALID",
      "Reservasi ini tidak bisa dibatalkan.",
    );
  const depositOutcome = view.cancellation.preview;
  const cancelled = cancelledView(view, depositOutcome);
  save(cancelled);
  return {
    data: { view: cancelled, depositOutcome, alreadyCancelled: false },
  };
});

registerMock(requestGuestReschedule, ({ body }) => {
  failIfScenario();
  const view = current();
  const now = new Date();
  if (view.status !== "pending_deposit" && view.status !== "confirmed")
    throw new ApiError(
      422,
      "RESERVATION_RESCHEDULE_INVALID",
      "Reservasi ini tidak bisa dijadwalkan ulang.",
    );
  if (view.rescheduleRequest?.status === "pending")
    throw new ApiError(
      409,
      "RESERVATION_RESCHEDULE_PENDING",
      "Sudah ada permintaan jadwal ulang yang menunggu.",
    );
  if (isLate(view, now))
    throw new ApiError(
      409,
      "RESERVATION_RESCHEDULE_LATE",
      "Jadwal ulang sudah terlambat.",
    );
  if (Date.parse(body.requestedFor) <= now.getTime())
    throw new ApiError(
      422,
      "RESERVATION_RESCHEDULE_INVALID",
      "Waktu yang diminta sudah lewat.",
    );
  const created: ReservationRescheduleRequest = {
    ...request("pending"),
    requestedFor: body.requestedFor,
    partySize: body.partySize ?? null,
    note: body.note ?? null,
    createdAt: now.toISOString(),
  };
  const next = { ...view, rescheduleRequest: created };
  save(next);
  return { data: { view: next, request: created } };
});
