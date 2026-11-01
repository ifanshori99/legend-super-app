// Typed state machines and timing rules for reservations and the waitlist
// (PRD v1.7 §6.G status columns; docs/plan/contracts.md: "money and state
// transitions only through the contract state machines"). Pure functions: the
// API, the waitlist screen and the tests run the same rules.
//
// Reservation flow (§3.22, RSV-01..03):
//
//   pending_deposit ──DP paid──▶ confirmed ──guest arrives──▶ seated ──▶ completed
//          │                        │
//          └──────cancelled─────────┴──no_show──▶ closed
//
// The DP itself is moved by the payment contract (WS-05); this module decides
// what the snapshot says must happen to it (refund or forfeit), so money math
// stays in one place.

import { applyBasisPoints, subtractIdr } from "../core/index.ts";
import type { Idr, RoundingMode } from "../core/index.ts";
import type { PaymentStatus } from "../payment/index.ts";
import { ReservationError } from "./errors.ts";
import { reservationDepositOutcomeSchema } from "./schemas.ts";
import type {
  DepositOutcomeKind,
  ReservationDepositOutcome,
  ReservationPolicySnapshot,
  ReservationStatus,
  ReservationTableSlot,
  WaitlistStatus,
} from "./schemas.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// ---- Reservation status machine -------------------------------------------

const reservationTransitions: Record<
  ReservationStatus,
  readonly ReservationStatus[]
> = {
  pending_deposit: ["confirmed", "cancelled"],
  confirmed: ["seated", "cancelled", "no_show"],
  seated: ["completed"],
  completed: [],
  cancelled: [],
  no_show: [],
};

/** True when `from → to` is one step of the reservation machine. */
export function canTransitionReservation(
  from: ReservationStatus,
  to: ReservationStatus,
): boolean {
  return reservationTransitions[from].includes(to);
}

/** Throws RESERVATION_TRANSITION_INVALID for a step outside the machine. */
export function assertReservationTransition(
  from: ReservationStatus,
  to: ReservationStatus,
): void {
  if (!canTransitionReservation(from, to))
    throw new ReservationError(
      "RESERVATION_TRANSITION_INVALID",
      `Reservasi berstatus ${from} tidak dapat menjadi ${to}.`,
    );
}

// ---- Table slots (RSV-01) -------------------------------------------------

/** The only bound convention the contract, the availability query and the DB share. */
export const RESERVATION_RANGE_BOUNDS = "[)" as const;

/**
 * Postgres `tstzrange` text for a reserved table interval, quoted and
 * half-open: `["2026-11-07T11:00:00.000Z","2026-11-07T12:30:00.000Z")`.
 * Use this literal (or the two bounds) in the exclusion constraint and in `&&`
 * lookups; never rebuild the range by hand.
 */
export function reservationRangeLiteral(slot: {
  startsAt: string;
  endsAt: string;
}): string {
  return `["${slot.startsAt}","${slot.endsAt}")`;
}

type Slot = Pick<
  ReservationTableSlot,
  "tableId" | "startsAt" | "endsAt" | "releasedAt"
>;

/**
 * RSV-01: two reservations conflict when they name the same table and their
 * half-open intervals intersect. A slot ending exactly when the next starts is
 * free, so a table can be turned over back-to-back.
 */
export function reservationTableSlotsOverlap(a: Slot, b: Slot): boolean {
  if (a.tableId !== b.tableId) return false;
  if (a.releasedAt !== null || b.releasedAt !== null) return false;
  return (
    Date.parse(a.startsAt) < Date.parse(b.endsAt) &&
    Date.parse(b.startsAt) < Date.parse(a.endsAt)
  );
}

/**
 * RSV-01: a reservation cannot hold a table that another live slot already
 * holds at an overlapping time. Throws RESERVATION_SLOT_TAKEN (409); the
 * database `tstzrange` exclusion constraint is the concurrency-safe backstop.
 */
export function assertNoReservationSlotOverlap(
  candidate: Slot,
  taken: readonly Slot[],
): void {
  for (const slot of taken)
    if (reservationTableSlotsOverlap(candidate, slot))
      throw new ReservationError(
        "RESERVATION_SLOT_TAKEN",
        `Meja ${candidate.tableId} sudah dipesan pada ${slot.startsAt}.`,
      );
}

/** Instant the reserved slot ends: `reservedFor + durationMinutes`. */
export function reservationEndsAt(
  reservedFor: string,
  durationMinutes: number,
): string {
  const start = Date.parse(reservedFor);
  if (Number.isNaN(start)) throw new RangeError("Invalid reservedFor");
  return new Date(start + durationMinutes * MINUTE).toISOString();
}

// ---- DP outcomes (RSV-02, RSV-03) -----------------------------------------

function outcome(
  policy: ReservationPolicySnapshot,
  depositPaidIdr: Idr,
  refundIdr: Idr,
): ReservationDepositOutcome {
  const resolution: DepositOutcomeKind =
    refundIdr === depositPaidIdr
      ? "refund_full"
      : refundIdr === 0
        ? "no_refund"
        : "refund_partial";
  return reservationDepositOutcomeSchema.parse({
    resolution,
    refundIdr,
    forfeitedIdr: subtractIdr(depositPaidIdr, refundIdr),
    policyVersion: policy.version,
  });
}

/**
 * RSV-03: cancelling follows the policy captured when the reservation was
 * made. The caller passes `reservation.policy` (the snapshot), never the
 * outlet's current policy. Within the free window the DP is refunded in full;
 * inside it the snapshot's `lateCancellationRefundBp` applies.
 */
export function cancellationDepositOutcome(
  policy: ReservationPolicySnapshot,
  input: {
    depositPaidIdr: Idr;
    reservedFor: string;
    cancelledAt: string;
    /** Rounding for a basis-point refund; tenant configuration, default half_up. */
    rounding?: RoundingMode;
  },
): ReservationDepositOutcome {
  const paid = input.depositPaidIdr;
  if (paid === 0)
    return reservationDepositOutcomeSchema.parse({
      resolution: "nothing_paid",
      refundIdr: 0,
      forfeitedIdr: 0,
      policyVersion: policy.version,
    });
  const cancelled = Date.parse(input.cancelledAt);
  const reserved = Date.parse(input.reservedFor);
  if (Number.isNaN(cancelled) || Number.isNaN(reserved))
    throw new RangeError("Invalid cancellation or reservation instant");
  // §3.22: cancellation is a pre-arrival act; once the slot starts it is a no-show.
  if (cancelled >= reserved)
    throw new ReservationError(
      "RESERVATION_TRANSITION_INVALID",
      "Waktu reservasi sudah lewat; gunakan status no-show.",
    );
  const hoursBefore = (reserved - cancelled) / HOUR;
  if (hoursBefore >= policy.freeCancellationHours)
    return outcome(policy, paid, paid);
  return outcome(
    policy,
    paid,
    applyBasisPoints(
      paid,
      policy.lateCancellationRefundBp,
      input.rounding ?? "half_up",
    ),
  );
}

/** RSV-03: the no-show outcome, also from the snapshot. */
export function noShowDepositOutcome(
  policy: ReservationPolicySnapshot,
  input: {
    depositPaidIdr: Idr;
    rounding?: RoundingMode;
  },
): ReservationDepositOutcome {
  const paid = input.depositPaidIdr;
  if (paid === 0)
    return reservationDepositOutcomeSchema.parse({
      resolution: "nothing_paid",
      refundIdr: 0,
      forfeitedIdr: 0,
      policyVersion: policy.version,
    });
  return outcome(
    policy,
    paid,
    applyBasisPoints(paid, policy.noShowRefundBp, input.rounding ?? "half_up"),
  );
}

/** RSV-02: the DP is a deposit only once the payment intent is settled. */
export function depositIsSettled(status: PaymentStatus | null): boolean {
  return status === "paid" || status === "partially_refunded";
}

// ---- Waitlist status machine (§3.22 "Waitlist Walk-in") -------------------

const waitlistTransitions: Record<WaitlistStatus, readonly WaitlistStatus[]> = {
  waiting: ["called", "cancelled"],
  called: ["seated", "left", "cancelled"],
  seated: [],
  left: [],
  cancelled: [],
};

export function canTransitionWaitlist(
  from: WaitlistStatus,
  to: WaitlistStatus,
): boolean {
  return waitlistTransitions[from].includes(to);
}

export function assertWaitlistTransition(
  from: WaitlistStatus,
  to: WaitlistStatus,
): void {
  if (!canTransitionWaitlist(from, to))
    throw new ReservationError(
      "WAITLIST_TRANSITION_INVALID",
      `Daftar tunggu berstatus ${from} tidak dapat menjadi ${to}.`,
    );
}

/**
 * Estimated wait quoted to a walk-in guest. The service owns the real queue
 * math (turnover per table); this helper only bounds the quote it may return
 * so the FE never renders an absurd number.
 */
export function clampWaitEstimate(minutes: number): number {
  if (!Number.isFinite(minutes)) throw new RangeError("Invalid wait estimate");
  return Math.min(600, Math.max(0, Math.round(minutes)));
}
