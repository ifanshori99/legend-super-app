// Pure helpers for the reservation desk (bead legend-oye8; PRD v1.7 §3 F19 and
// §3.22 "Reservasi & Event"): business-date grouping, table-slot conflicts
// (RSV-01), deposit wording (RSV-02/03) and which actions a status allows.
// No React and no `@/` imports, so tests/ws08-reservation-ui.test.mjs can load
// this file with Node type stripping.
//
// Business rules stay in the contract (@starter/shared/reservation): the state
// machines, the half-open slot convention and the DP outcome wording are
// imported, never re-implemented.
import {
  RESERVATION_ERROR_CODES,
  canTransitionReservation,
  canTransitionWaitlist,
  depositIsSettled,
  reservationEndsAt,
  reservationTableSlotsOverlap,
} from "@starter/shared/reservation";
import type {
  RescheduleRequestStatus,
  Reservation,
  ReservationStatus,
  ReservationTableSlot,
  WaitlistEntry,
  WaitlistStatus,
} from "@starter/shared/reservation";
import type { PaymentStatus } from "@starter/shared/payment";
import type { FloorZone, Table } from "@starter/shared/qr-order";
import type { MessageKey, Translate } from "@starter/shared/i18n";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Every reservation the desk can show in one day view. */
export const RESERVATION_LIMIT = 100;

// ---- Business dates in the outlet time zone -------------------------------

/** Calendar date (`YYYY-MM-DD`) of one instant in the outlet's time zone. */
export function businessDateOf(instant: string, timeZone: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) throw new RangeError("Invalid instant");
  // en-CA formats as YYYY-MM-DD, the contract's business-date shape.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Today's business date in the outlet time zone. */
export function todayInZone(timeZone: string, now: Date = new Date()): string {
  return businessDateOf(now.toISOString(), timeZone);
}

/** Shift a business date by whole days (calendar arithmetic, no clock math). */
export function shiftBusinessDate(date: string, days: number): string {
  const base = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(base)) throw new RangeError("Invalid business date");
  return new Date(base + days * DAY_MS).toISOString().slice(0, 10);
}

/** Outlet clock, e.g. "19.30" — one locale and one time zone, so SSR matches. */
export function formatClock(instant: string, timeZone: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("id-ID", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/** Outlet date and clock, e.g. "Sab, 7 Nov 19.30". */
export function formatDateTime(instant: string, timeZone: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("id-ID", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/** Long day label for a business date, e.g. "Sabtu, 7 November 2026". */
export function formatDayLabel(date: string): string {
  const parsed = Date.parse(`${date}T12:00:00.000Z`);
  if (Number.isNaN(parsed)) return date;
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(parsed));
}

/** Short day label for a date strip, e.g. "Sab 7 Nov". */
export function formatDayShort(date: string): string {
  const parsed = Date.parse(`${date}T12:00:00.000Z`);
  if (Number.isNaN(parsed)) return date;
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(parsed));
}

/** "Hari ini" / "Besok" / the long date, relative to the outlet's today. */
export function dayHeading(date: string, today: string, t: Translate): string {
  if (date === today) return t("reservation.list.dayToday");
  if (date === shiftBusinessDate(today, 1))
    return t("reservation.list.dayTomorrow");
  return formatDayLabel(date);
}

export type ReservationGroup = {
  /** Business date in the outlet time zone. */
  date: string;
  rows: Reservation[];
};

/** Upcoming reservations grouped by business date, earliest first. */
export function groupByBusinessDate(
  reservations: readonly Reservation[],
  timeZone: string,
): ReservationGroup[] {
  const groups = new Map<string, Reservation[]>();
  for (const reservation of reservations) {
    const date = businessDateOf(reservation.reservedFor, timeZone);
    const rows = groups.get(date);
    if (rows) rows.push(reservation);
    else groups.set(date, [reservation]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, rows]) => ({
      date,
      rows: [...rows].sort(
        (left, right) =>
          Date.parse(left.reservedFor) - Date.parse(right.reservedFor),
      ),
    }));
}

// ---- Table slots and conflicts (RSV-01) ------------------------------------

/** The contract's slot shape; the overlap rule is typed on the same fields. */
type Slot = Pick<
  ReservationTableSlot,
  "tableId" | "startsAt" | "endsAt" | "releasedAt"
>;

/** Live slots a reservation holds; a closed reservation keeps released history. */
export function reservationSlots(reservation: Reservation): Slot[] {
  const endsAt = reservationEndsAt(
    reservation.reservedFor,
    reservation.durationMinutes,
  );
  const closed =
    reservation.status === "cancelled" || reservation.status === "no_show";
  const releasedAt = closed ? reservation.closedAt : null;
  return reservation.tableIds.map((tableId) => ({
    tableId,
    startsAt: reservation.reservedFor,
    endsAt,
    releasedAt,
  }));
}

/**
 * RSV-01: the tables another reservation already holds during this
 * reservation's half-open time slot, with the reservation that holds each.
 * Closed reservations have released their slots and never block.
 */
export function conflictingReservations(
  target: Reservation,
  others: readonly Reservation[],
): Map<string, Reservation> {
  const startsAt = target.reservedFor;
  const endsAt = reservationEndsAt(target.reservedFor, target.durationMinutes);
  const conflicts = new Map<string, Reservation>();
  for (const other of others) {
    if (other.id === target.id) continue;
    for (const slot of reservationSlots(other)) {
      if (conflicts.has(slot.tableId)) continue;
      if (
        reservationTableSlotsOverlap(
          { tableId: slot.tableId, startsAt, endsAt, releasedAt: null },
          slot,
        )
      )
        conflicts.set(slot.tableId, other);
    }
  }
  return conflicts;
}

export type AssignTable = {
  table: Table;
  zone: FloorZone | undefined;
  /** Inactive tables cannot be assigned; conflicting ones must not (RSV-01). */
  state: "available" | "conflict" | "inactive";
  conflict: Reservation | null;
};

/**
 * Tables a reservation holds at one instant — the walk-in check: a table the
 * desk seats now must not be inside another reservation's live slot.
 */
export function tablesHeldAt(
  reservations: readonly Reservation[],
  instant: string,
): Map<string, Reservation> {
  const held = new Map<string, Reservation>();
  const at = Date.parse(instant);
  for (const reservation of reservations) {
    for (const slot of reservationSlots(reservation)) {
      if (slot.releasedAt !== null) continue;
      if (
        Date.parse(slot.startsAt) <= at &&
        at < Date.parse(slot.endsAt) &&
        !held.has(slot.tableId)
      )
        held.set(slot.tableId, reservation);
    }
  }
  return held;
}

/**
 * The floor plan of one zone (or every zone) prepared for assignment. Live
 * sessions are deliberately not part of this decision: RSV-01 is about
 * reservation slots, and the API enforces an occupied table when seating.
 */
export function assignableTables(input: {
  tables: readonly Table[];
  zones: readonly FloorZone[];
  conflicts: ReadonlyMap<string, Reservation>;
  zoneId: string | null;
}): AssignTable[] {
  const zoneOf = (zoneId: string) =>
    input.zones.find((zone) => zone.id === zoneId);
  const zoneOrder = new Map(
    input.zones.map((zone, index) => [zone.id, zone.sortOrder ?? index]),
  );
  return input.tables
    .filter((table) => input.zoneId === null || table.zoneId === input.zoneId)
    .map((table) => {
      const conflict = input.conflicts.get(table.id) ?? null;
      const state =
        table.status === "inactive"
          ? ("inactive" as const)
          : conflict !== null
            ? ("conflict" as const)
            : ("available" as const);
      return { table, zone: zoneOf(table.zoneId), state, conflict };
    })
    .sort((left, right) => {
      const zoneDelta =
        (zoneOrder.get(left.table.zoneId) ?? 0) -
        (zoneOrder.get(right.table.zoneId) ?? 0);
      return zoneDelta !== 0
        ? zoneDelta
        : left.table.code.localeCompare(right.table.code, "id-ID");
    });
}

/** Total seats of the chosen tables. */
export function selectedSeats(
  tables: readonly Table[],
  selectedIds: readonly string[],
): number {
  const chosen = new Set(selectedIds);
  return tables
    .filter((table) => chosen.has(table.id))
    .reduce((total, table) => total + table.capacity, 0);
}

/** Seats still missing for the party; 0 when the selection is big enough. */
export function seatsMissing(pax: number, seats: number): number {
  return Math.max(0, pax - seats);
}

// ---- Which actions a status allows ----------------------------------------

export type ReservationActions = {
  assign: boolean;
  seat: boolean;
  cancel: boolean;
  noShow: boolean;
  preOrder: boolean;
};

/**
 * Buttons the detail sheet offers. Transitions come from the contract state
 * machine; seating additionally needs the required DP settled (RSV-02). The
 * settled rule is `depositIsSettled` from the contract, never a local copy:
 * a later WS-05 refund (`refunded`) keeps the DP valid.
 */
export function reservationActions(
  reservation: Reservation,
): ReservationActions {
  const status = reservation.status;
  const open = status === "pending_deposit" || status === "confirmed";
  const depositSettled =
    reservation.policy.depositRequirement !== "required" ||
    depositIsSettled(reservation.depositStatus);
  return {
    assign: open,
    seat:
      canTransitionReservation(status, "seated") &&
      reservation.tableIds.length > 0 &&
      depositSettled,
    cancel: canTransitionReservation(status, "cancelled"),
    noShow: canTransitionReservation(status, "no_show"),
    preOrder: open,
  };
}

export type WaitlistActions = {
  call: boolean;
  seat: boolean;
  leave: boolean;
  cancel: boolean;
};

/** Waitlist buttons per status, straight from the contract machine. */
export function waitlistActions(entry: WaitlistEntry): WaitlistActions {
  const status = entry.status;
  return {
    call: status === "waiting",
    seat: canTransitionWaitlist(status, "seated"),
    leave: canTransitionWaitlist(status, "left"),
    cancel: canTransitionWaitlist(status, "cancelled"),
  };
}

/** Queue order: who has waited longest sits first, then called guests. */
const WAITLIST_RANK: Record<WaitlistStatus, number> = {
  waiting: 0,
  called: 1,
  seated: 2,
  left: 3,
  cancelled: 4,
};

export function sortWaitlist(
  entries: readonly WaitlistEntry[],
): WaitlistEntry[] {
  return [...entries].sort((left, right) => {
    const rank = WAITLIST_RANK[left.status] - WAITLIST_RANK[right.status];
    return rank !== 0
      ? rank
      : Date.parse(left.joinedAt) - Date.parse(right.joinedAt);
  });
}

/** Entries still in the queue (waiting or called). */
export function activeWaitlist(
  entries: readonly WaitlistEntry[],
): WaitlistEntry[] {
  return entries.filter(
    (entry) => entry.status === "waiting" || entry.status === "called",
  );
}

// ---- Labels ---------------------------------------------------------------

export function reservationStatusKey(status: ReservationStatus): MessageKey {
  return `reservation.status.${status}` as MessageKey;
}

export function reservationSourceKey(
  source: Reservation["source"],
): MessageKey {
  return `reservation.source.${source}` as MessageKey;
}

export function rescheduleStatusKey(
  status: RescheduleRequestStatus,
): MessageKey {
  return `reservation.reschedule.status.${status}` as MessageKey;
}

export function waitlistStatusKey(status: WaitlistStatus): MessageKey {
  return `reservation.waitlist.status.${status}` as MessageKey;
}

/**
 * DP badge text (RSV-02). "Tanpa DP" when no DP applies. A pending DP with no
 * intent yet means the guest has not opened the DP bill link: the staff copy
 * says "Menunggu pembayaran DP" instead of implying a payment that exists.
 */
export function depositLabelKey(reservation: Reservation): MessageKey {
  if (
    reservation.depositIdr === 0 ||
    reservation.policy.depositRequirement === "none"
  )
    return "reservation.deposit.none";
  if (
    reservation.depositStatus === "pending" &&
    reservation.depositPaymentId === null
  )
    return "reservation.deposit.awaitingPayment";
  return depositStatusKey(reservation.depositStatus);
}

export function depositStatusKey(status: PaymentStatus | null): MessageKey {
  switch (status) {
    case "pending":
      return "reservation.deposit.pending";
    case "paid":
      return "reservation.deposit.paid";
    case "failed":
      return "reservation.deposit.failed";
    case "expired":
      return "reservation.deposit.expired";
    case "refunded":
      return "reservation.deposit.refunded";
    case "partially_refunded":
      return "reservation.deposit.partially_refunded";
    default:
      return "reservation.deposit.none";
  }
}

/** Basis points as a whole percent: 5000 → "50%". */
export function percentLabel(basisPoints: number): string {
  const percent = basisPoints / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}

export function countByStatus(
  reservations: readonly Reservation[],
): Record<ReservationStatus, number> {
  const counts: Record<ReservationStatus, number> = {
    pending_deposit: 0,
    confirmed: 0,
    seated: 0,
    completed: 0,
    cancelled: 0,
    no_show: 0,
  };
  for (const reservation of reservations) counts[reservation.status] += 1;
  return counts;
}

/**
 * Catalog key for a failed action. Domain codes from the contract win; network
 * and unknown failures fall back to a retry-oriented text.
 */
const ERROR_CODES: ReadonlySet<string> = new Set([
  ...RESERVATION_ERROR_CODES,
  "NETWORK_ERROR",
]);

export function reservationErrorKey(error: unknown): MessageKey {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  return (
    ERROR_CODES.has(code)
      ? `reservation.errors.${code}`
      : "reservation.errors.generic"
  ) as MessageKey;
}
