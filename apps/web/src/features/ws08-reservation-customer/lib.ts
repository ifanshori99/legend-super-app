// Pure helpers and storage for the guest reservation flow (bead legend-xm4y;
// PRD v1.7 §3.22 "Reservasi & Event", §4 Alur H). No React and no `@/` imports,
// so the module stays loadable by a plain Node test runner.
//
// Business rules stay in the contract (@starter/shared/reservation): the field
// limits below cite the schema that enforces them, the refund percentages come
// from basis points, and the confirmation is validated with the response schema
// before it is restored from sessionStorage.
import {
  reservationCreatedSchema,
  type ReservationCreated,
  type ReservationPackage,
} from "@starter/shared/reservation";

/** `createReservationInputSchema`: pax 1–60, guestName 1–150, note ≤ 300. */
export const MAX_PAX = 60;
export const MAX_NAME = 150;
export const MAX_NOTE = 300;
/** `reservationAvailabilityQuerySchema`: durationMinutes 15–720; the fixture default is 90. */
export const DURATION_OPTIONS = [60, 90, 120, 150, 180] as const;
export const DEFAULT_DURATION = 90;

const HOUR_MS = 3_600_000;
const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isBusinessDate(value: string): boolean {
  return BUSINESS_DATE.test(value);
}

/** Shift a business date by whole days (calendar arithmetic, no clock math). */
export function shiftBusinessDate(date: string, days: number): string {
  const base = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(base)) throw new RangeError("Invalid business date");
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

/** Outlet clock, e.g. "19.30" — one locale and time zone, so SSR matches. */
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

/** Business date ("YYYY-MM-DD") of an instant in the outlet's time zone. */
export function businessDateOfInstant(
  instant: string,
  timeZone: string,
): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return "";
  // en-CA formats as YYYY-MM-DD, the contract's business-date shape.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Day and clock in the outlet's zone, e.g. "7 Nov 2026, 19.30". */
export function formatInstant(instant: string, timeZone: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("id-ID", {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/**
 * Basis points of the frozen policy as a percentage label: 5000 → "50%".
 * The policy stores fractions in bp (RSV-03), so the UI never hard-codes one.
 */
export function formatBasisPoints(bp: number): string {
  return `${new Intl.NumberFormat("id-ID", {
    maximumFractionDigits: 2,
  }).format(bp / 100)}%`;
}

/**
 * The guest credential of an app-local DP payment path (`/bayar/<token>`,
 * `reservationDepositLinkSchema`). The route tree types the static shape
 * `/bayar/$token`, so a Link takes the token from the path the API returned
 * instead of rebuilding a URL.
 */
export function depositToken(paymentPath: string): string | null {
  const match = /^\/bayar\/([A-Za-z0-9._-]+)$/.exec(paymentPath);
  return match ? match[1] : null;
}

/** UTC offset of a time zone on a business date, e.g. "+07:00". */
export function utcOffsetAt(businessDate: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  }).formatToParts(new Date(`${businessDate}T12:00:00.000Z`));
  const name = parts.find((part) => part.type === "timeZoneName")?.value;
  const offset = (name ?? "GMT").replace("GMT", "");
  return offset === "" ? "+00:00" : offset;
}

/** "HH:MM" → minutes after midnight. */
export function minutesOfDay(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

/** Minutes after midnight → "HH:MM" (24-hour clock). */
export function timeOfDay(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/** ISO instant for a local wall clock on a business date, e.g. 11:00 +07:00. */
export function instantAt(
  businessDate: string,
  minutes: number,
  timeZone: string,
): string {
  return `${businessDate}T${timeOfDay(minutes)}:00${utcOffsetAt(businessDate, timeZone)}`;
}

// ---- Form validation ------------------------------------------------------

export type GuestValues = {
  name: string;
  /** Waited-for WhatsApp number as typed; the contract normalizes it. */
  phone: string;
  note: string;
};

export type GuestField = keyof GuestValues;

/**
 * Field-level checks mirroring `createReservationInputSchema`; each failure
 * maps to one catalog sentence in the component. The API stays the authority,
 * and the caller decides whether a slot is required.
 */
export function validateGuestDetails(
  values: GuestValues,
  options: { phoneIsValid: boolean },
): { ok: true } | { ok: false; errors: Partial<Record<GuestField, true>> } {
  const errors: Partial<Record<GuestField, true>> = {};
  const name = values.name.trim();
  if (name.length < 1 || name.length > MAX_NAME) errors.name = true;
  if (!options.phoneIsValid) errors.phone = true;
  if (values.note.trim().length > MAX_NOTE) errors.note = true;
  return Object.keys(errors).length === 0
    ? { ok: true }
    : { ok: false, errors };
}

// ---- Event pre-orders (§3.22 "Pre-order Event") ---------------------------

/**
 * Packages the guest can still order for a chosen slot: active, party inside
 * the package's pax range, and ordered at least `leadTimeHours` before the
 * reservation (the contract's "sebelum hari H" rule). `nowMs` stays null until
 * the page has mounted, so the server and client render the same list.
 */
export function eligiblePackages(
  packages: readonly ReservationPackage[],
  pax: number,
  startsAt: string,
  nowMs: number | null,
): ReservationPackage[] {
  const start = Date.parse(startsAt);
  return packages
    .filter((pack) => pack.status === "active")
    .filter((pack) => pax >= pack.minPax && pax <= pack.maxPax)
    .filter(
      (pack) => nowMs === null || start - nowMs >= pack.leadTimeHours * HOUR_MS,
    )
    .sort((left, right) => left.sortOrder - right.sortOrder);
}

/** Price per person × party size; menu prices exclude tax and service. */
export function packageTotal(pack: ReservationPackage, pax: number): number {
  return pack.pricePerPaxIdr * pax;
}

// ---- Confirmation persistence -------------------------------------------

/**
 * The confirmation survives a reload through sessionStorage (one tab, no route
 * parameter): the record is keyed by reservation id and a small pointer names
 * the latest one, so refreshing `/reservasi` shows the DP card again.
 */
export const CONFIRMATION_STORAGE_PREFIX = "legend.reservasi.confirmation";
const LAST_CONFIRMATION_KEY = `${CONFIRMATION_STORAGE_PREFIX}.last`;

function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    // Storage can be blocked by the browser; the page still works in memory.
    return null;
  }
}

export function saveConfirmation(created: ReservationCreated): void {
  const store = sessionStore();
  if (!store) return;
  try {
    store.setItem(
      `${CONFIRMATION_STORAGE_PREFIX}.${created.reservation.id}`,
      JSON.stringify(created),
    );
    store.setItem(LAST_CONFIRMATION_KEY, created.reservation.id);
  } catch {
    // Quota or private mode: the confirmation stays on screen for this view.
  }
}

/** The stored confirmation, validated against the contract; null when absent. */
export function readConfirmation(): ReservationCreated | null {
  const store = sessionStore();
  if (!store) return null;
  try {
    const id = store.getItem(LAST_CONFIRMATION_KEY);
    if (!id) return null;
    const raw = store.getItem(`${CONFIRMATION_STORAGE_PREFIX}.${id}`);
    if (!raw) return null;
    const parsed = reservationCreatedSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function clearConfirmation(): void {
  const store = sessionStore();
  if (!store) return;
  try {
    const id = store.getItem(LAST_CONFIRMATION_KEY);
    if (id) store.removeItem(`${CONFIRMATION_STORAGE_PREFIX}.${id}`);
    store.removeItem(LAST_CONFIRMATION_KEY);
  } catch {
    // Nothing to clean up when storage is unavailable.
  }
}

/**
 * Which problem a failed booking or waitlist submit reports. A 409 the guest
 * cannot fix by resending (slot taken, package gone, already on the list) gets
 * its own copy and action instead of "coba kirim lagi"; anything else is a
 * retryable send failure that reuses the attempt's Idempotency-Key.
 */
export type SubmitProblem =
  "slot" | "package" | "duplicate" | "rateLimited" | "retry";

export function submitProblemOf(error: unknown): SubmitProblem {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  switch (code) {
    case "RESERVATION_SLOT_TAKEN":
    case "RESERVATION_SLOT_UNAVAILABLE":
      return "slot";
    case "RESERVATION_PACKAGE_UNAVAILABLE":
      return "package";
    case "WAITLIST_DUPLICATE_ENTRY":
      return "duplicate";
    case "RATE_LIMITED":
      return "rateLimited";
    default:
      return "retry";
  }
}
