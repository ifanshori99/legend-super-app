// Pure helpers for the guest "kelola reservasi" page (bead legend-g12il). No
// React and no `@/` imports, so the module loads in a plain Node test runner.
//
// The page never computes money: every rupiah amount comes from the API
// (`deposit`, `cancellation.preview`, the cancel result). The only business
// rule here is which screen a view belongs to, and it reads server data.
import { reservationLinkTokenSchema } from "@starter/shared/reservation";
import type { GuestReservationView } from "@starter/shared/reservation";
import {
  businessDateOfInstant,
  instantAt,
  isBusinessDate,
  minutesOfDay,
} from "../ws08-reservation-customer/lib.ts";

/** Outlets are in Indonesia; WIB until the public site tells us otherwise. */
export const GUEST_DEFAULT_TIME_ZONE = "Asia/Jakarta";

/** A reschedule may ask for a time at most this many days ahead. */
const MAX_RESCHEDULE_DAYS = 180;
const DAY_MS = 86_400_000;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Token from the URL fragment (`#<token>`), or null when it is missing or not
 * the 43-character base64url shape. The token lives in the fragment only, so
 * it never reaches a server log; this returns it for the request header.
 */
export function readLinkToken(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const parsed = reservationLinkTokenSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ---- Which screen the view belongs to -------------------------------------

export type GuestScreen =
  | "detail"
  | "pending"
  | "approved"
  | "rejected"
  | "late"
  | "cancelled"
  | "closed";

/**
 * Order: cancelled, closed (seated/completed/no-show), the latest reschedule
 * request (pending/approved/declined), late, else detail.
 *
 * legend-z5ygw: the server returns only a `pending` request today; the
 * `approved` and `declined` branches follow the schema and are fed by the mock
 * until the contract returns resolved requests.
 * legend-z5ygw: a late reschedule is refused (founder W3 Q13, 14 Nov), so
 * "late" is derived from server data: part of the DP would be forfeited, or
 * the booking time has passed. The reschedule form is not offered there.
 */
export function deriveGuestScreen(
  view: GuestReservationView,
  now: Date,
): GuestScreen {
  if (view.status === "cancelled") return "cancelled";
  if (
    view.status === "seated" ||
    view.status === "completed" ||
    view.status === "no_show"
  )
    return "closed";
  const request = view.rescheduleRequest;
  if (request?.status === "pending") return "pending";
  if (request?.status === "approved") return "approved";
  if (request?.status === "declined") return "rejected";
  if (isLateForReschedule(view, now)) return "late";
  return "detail";
}

/**
 * A reschedule is refused when part of the DP would be forfeited or the
 * booking time has passed (founder W3 Q13). Reads server data only.
 */
export function isLateForReschedule(
  view: GuestReservationView,
  now: Date,
): boolean {
  const forfeited = view.cancellation.preview?.forfeitedIdr ?? 0;
  return forfeited > 0 || now.getTime() >= Date.parse(view.reservedFor);
}

// ---- Errors -----------------------------------------------------------------

export type GuestErrorKind =
  | "invalid"
  | "rate_limited"
  | "network"
  | "late"
  | "pending_exists"
  | "invalid_input"
  | "transition"
  | "unknown";

/**
 * What a failed call means for the guest. Reads `status` and `code` off the
 * error (an `ApiError`), so it needs no import of the client. Status 0, the
 * NETWORK_ERROR code and any 5xx are "network": the guest can try again.
 */
export function guestErrorKind(error: unknown): GuestErrorKind {
  if (typeof error !== "object" || error === null) return "unknown";
  const { status, code } = error as { status?: unknown; code?: unknown };
  if (code === "RESERVATION_RESCHEDULE_LATE") return "late";
  if (code === "RESERVATION_RESCHEDULE_PENDING") return "pending_exists";
  if (code === "RESERVATION_RESCHEDULE_INVALID") return "invalid_input";
  if (code === "RESERVATION_TRANSITION_INVALID") return "transition";
  if (code === "RESERVATION_LINK_INVALID") return "invalid";
  if (code === "RATE_LIMITED") return "rate_limited";
  if (code === "NETWORK_ERROR") return "network";
  if (typeof status !== "number") return "unknown";
  if (status === 404) return "invalid";
  if (status === 429) return "rate_limited";
  if (status === 0 || status >= 500) return "network";
  if (status === 400 || status === 422) return "invalid_input";
  return "unknown";
}

// ---- Reschedule form --------------------------------------------------------

/** True when Y-M-D names a real calendar day (2026-02-31 does not). */
function isRealDate(date: string): boolean {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === date
  );
}

export type RescheduleProblem =
  "missing_date" | "missing_time" | "past" | "too_far";

/**
 * Checks the date and time the guest typed (in the outlet's zone). Mirrors the
 * server limits (later than now, at most 180 days ahead); the API stays the
 * authority. `requestedFor` is an ISO UTC instant.
 */
export function validateReschedule(
  input: { date: string; time: string },
  now: Date,
  timeZone: string,
):
  | { ok: true; requestedFor: string }
  | { ok: false; problem: RescheduleProblem } {
  if (!isBusinessDate(input.date) || !isRealDate(input.date))
    return { ok: false, problem: "missing_date" };
  if (!CLOCK.test(input.time)) return { ok: false, problem: "missing_time" };
  const at = Date.parse(
    instantAt(input.date, minutesOfDay(input.time), timeZone),
  );
  if (Number.isNaN(at)) return { ok: false, problem: "missing_date" };
  if (at <= now.getTime()) return { ok: false, problem: "past" };
  if (at > now.getTime() + MAX_RESCHEDULE_DAYS * DAY_MS)
    return { ok: false, problem: "too_far" };
  return { ok: true, requestedFor: new Date(at).toISOString() };
}

/** `min` and `max` for the date input, as business dates in the outlet's zone. */
export function rescheduleDateBounds(
  now: Date,
  timeZone: string,
): { min: string; max: string } {
  return {
    min: businessDateOfInstant(now.toISOString(), timeZone),
    max: businessDateOfInstant(
      new Date(now.getTime() + MAX_RESCHEDULE_DAYS * DAY_MS).toISOString(),
      timeZone,
    ),
  };
}

/** WIB / WITA / WIT for the Indonesian zones; any other zone shows its name. */
export function zoneLabel(timeZone: string): string {
  if (timeZone === "Asia/Jakarta") return "WIB";
  if (timeZone === "Asia/Makassar") return "WITA";
  if (timeZone === "Asia/Jayapura") return "WIT";
  return timeZone;
}
