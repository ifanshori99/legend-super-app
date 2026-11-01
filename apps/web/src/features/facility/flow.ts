// Pure logic for the customer facility journey: booking a shower room from the
// facility QR (PRD v1.7 §3 F22 "Pemesanan"/"Tiket Akses"/"Sesi & Pengingat",
// F23 "Hak Akses", F42; alur S/T/U/V/Z). No React and no fetch, so the screens
// and the Node tests in tests/facility-booking-flow.test.mjs import the same
// rules: slot choice (FAC-02, FAC-06), entitlement redemption (FAC-04, FAC-05),
// subscription quota (FAC-07) and the session timer (FAC-01, 5-minute reminder).

import type {
  AccessTicketStatus,
  AccessTicketView,
  FacilityAddon,
  FacilityAvailability,
  FacilityProduct,
  FacilitySlotOption,
  FacilitySubscriptionView,
} from "@starter/shared/facility";

/**
 * Outlet wall-clock zone until the outlet context bead supplies the outlet's
 * own IANA zone (PRD: business dates in the outlet time zone). Same default as
 * `AreaFrame`.
 */
export const OUTLET_TIME_ZONE = "Asia/Jakarta";

/**
 * PRD §3 F22 "Sesi & Pengingat": a reminder 5 minutes before the session ends.
 * The push delivery is WS-06; this is the reminder state the ticket screen
 * shows while it is open.
 */
export const REMINDER_MINUTES = 5;

const MINUTE_MS = 60_000;

/** How the guest gets the right to the session (FAC-04 five sources). */
export type BookingSource = "purchase" | "subscription";

/** "Pilih slot" or "masuk sekarang" (PRD §3 F22 Pemesanan). */
export type TimingChoice =
  | { readonly kind: "now" }
  | { readonly kind: "slot"; readonly startsAt: string };

/** What the booking wizard collects before it posts one ticket. */
export type BookingDraft = {
  readonly areaId: string | null;
  readonly timing: TimingChoice | null;
  readonly productId: string | null;
  readonly addonIds: readonly string[];
  readonly source: BookingSource;
};

export const INITIAL_DRAFT: BookingDraft = {
  areaId: null,
  timing: null,
  productId: null,
  addonIds: [],
  source: "purchase",
};

export type AvailabilityArea = FacilityAvailability["areas"][number];
export type AvailabilityUnit = AvailabilityArea["units"][number];

// ---- Availability ------------------------------------------------------------

export function findArea(
  availability: FacilityAvailability | undefined,
  areaId: string | null,
): AvailabilityArea | null {
  if (!availability || !areaId) return null;
  return availability.areas.find((area) => area.areaId === areaId) ?? null;
}

/** FAC-06: an unclean or maintenance unit is listed but never bookable. */
export function bookableUnits(area: AvailabilityArea): AvailabilityUnit[] {
  return area.units.filter((unit) => unit.bookable);
}

/** FAC-06: the units the screen explains away ("perlu dibersihkan"). */
export function blockedUnits(area: AvailabilityArea): AvailabilityUnit[] {
  return area.units.filter((unit) => !unit.bookable);
}

/** "Masuk sekarang" needs one unit that is both bookable and free right now. */
export function enterNowAvailable(area: AvailabilityArea): boolean {
  return bookableUnits(area).some((unit) => unit.status === "available");
}

/**
 * Slots a guest can pick in an area: only bookable units count (FAC-06), one
 * option per start time, earliest first. FAC-02 is enforced by the API's slot
 * range; the screen only offers what the server marked available.
 */
export function availableSlots(
  availability: FacilityAvailability | undefined,
  areaId: string | null,
): FacilitySlotOption[] {
  const area = findArea(availability, areaId);
  if (!area) return [];
  const byStart = new Map<string, FacilitySlotOption>();
  for (const unit of bookableUnits(area))
    for (const slot of unit.slots)
      if (slot.available) byStart.set(slot.startsAt, slot);
  return [...byStart.values()].sort(
    (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt),
  );
}

/** The unit a chosen slot belongs to; the server may still pick another. */
export function unitsForSlot(
  area: AvailabilityArea,
  startsAt: string,
): string[] {
  return bookableUnits(area)
    .filter((unit) =>
      unit.slots.some((slot) => slot.startsAt === startsAt && slot.available),
    )
    .map((unit) => unit.unitId);
}

export function slotSessionMinutes(slot: FacilitySlotOption): number {
  return Math.round(
    (Date.parse(slot.endsAt) - Date.parse(slot.startsAt)) / MINUTE_MS,
  );
}

export function slotCleaningMinutes(slot: FacilitySlotOption): number {
  return Math.round(
    (Date.parse(slot.cleaningEndsAt) - Date.parse(slot.endsAt)) / MINUTE_MS,
  );
}

/** Price of the draft's product plus its add-ons, in whole rupiah. */
export function draftTotalIdr(
  draft: BookingDraft,
  products: readonly FacilityProduct[],
  addons: readonly FacilityAddon[],
): number {
  const product = products.find((item) => item.id === draft.productId);
  const addonTotal = draft.addonIds.reduce((total, id) => {
    const addon = addons.find((item) => item.id === id);
    return total + (addon?.priceIdr ?? 0);
  }, 0);
  return (product?.priceIdr ?? 0) + addonTotal;
}

/**
 * What the guest pays now. A subscription session is covered by the quota
 * (FAC-04), so only the add-ons are charged; a purchase pays the product and
 * its add-ons (PRD §3 F22 "Add-on Opsional" sells them separately).
 */
export function draftPayableIdr(
  draft: BookingDraft,
  products: readonly FacilityProduct[],
  addons: readonly FacilityAddon[],
): number {
  const total = draftTotalIdr(draft, products, addons);
  if (draft.source !== "subscription") return total;
  const product = products.find((item) => item.id === draft.productId);
  return total - (product?.priceIdr ?? 0);
}

export function selectedAddons(
  draft: BookingDraft,
  addons: readonly FacilityAddon[],
): FacilityAddon[] {
  return draft.addonIds
    .map((id) => addons.find((addon) => addon.id === id))
    .filter((addon): addon is FacilityAddon => addon !== undefined);
}

/** Add-ons are sold on/off per ticket (the contract sends ids, not counts). */
export function toggleAddon(
  addonIds: readonly string[],
  addonId: string,
): string[] {
  return addonIds.includes(addonId)
    ? addonIds.filter((id) => id !== addonId)
    : [...addonIds, addonId];
}

// ---- Entitlement and subscription ------------------------------------------

/**
 * FAC-04/FAC-07: sessions the guest may redeem right now. A subscription only
 * offers its quota while `subscriptionQuotaState` says it is usable — a bill
 * unpaid past the grace period stops redemption until it is paid, and an
 * exhausted quota offers nothing. The UI therefore hides "pakai kuota" unless
 * this is above zero; the API re-checks atomically (FAC-05).
 */
export function redeemableSessions(
  view: FacilitySubscriptionView | null | undefined,
): number {
  if (!view || !view.quota.usable) return 0;
  return Math.max(0, view.quota.remaining);
}

export function canRedeem(view: FacilitySubscriptionView | null | undefined) {
  return redeemableSessions(view) > 0;
}

// ---- Session timer (FAC-01, PRD §3 F22 Sesi & Pengingat) --------------------

export type SessionTimerState =
  "before" | "in_session" | "reminder" | "overtime" | "ended";

/**
 * Timer state from the server clock (never the device clock, see
 * `accessTicketViewSchema.serverTime`). `reminder` starts at 5 minutes before
 * the session end and is the only state that raises the reminder.
 */
export function sessionTimerState(input: {
  now: number;
  startsAt: string | null;
  endsAt: string;
  endedAt: string | null;
}): SessionTimerState {
  if (input.endedAt !== null) return "ended";
  const end = Date.parse(input.endsAt);
  if (input.now >= end) return "overtime";
  const start = input.startsAt === null ? null : Date.parse(input.startsAt);
  if (start !== null && input.now < start) return "before";
  if (end - input.now <= REMINDER_MINUTES * MINUTE_MS) return "reminder";
  return "in_session";
}

export function remainingMs(now: number, endsAt: string): number {
  return Math.max(0, Date.parse(endsAt) - now);
}

/** `mm:ss` for the countdown; tabular figures keep the digits from jumping. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Progress of the session, 0–100, for the meter (never negative). */
export function sessionProgress(input: {
  now: number;
  startsAt: string | null;
  endsAt: string;
}): number {
  const start = input.startsAt === null ? null : Date.parse(input.startsAt);
  const end = Date.parse(input.endsAt);
  if (start === null || !(end > start)) return 0;
  const ratio = (input.now - start) / (end - start);
  return Math.min(100, Math.max(0, Math.round(ratio * 100)));
}

// ---- Labels ----------------------------------------------------------------

const clockFormatters = new Map<string, Intl.DateTimeFormat>();
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function formatter(
  cache: Map<string, Intl.DateTimeFormat>,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let found = cache.get(key);
  if (!found) {
    found = new Intl.DateTimeFormat("id-ID", { timeZone, ...options });
    cache.set(key, found);
  }
  return found;
}

/** `06:20` in the outlet time zone (SSR and browser agree). */
export function formatClock(
  instant: string,
  timeZone: string = OUTLET_TIME_ZONE,
): string {
  return formatter(clockFormatters, timeZone, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(instant));
}

/** `Sen, 2 Nov` in the outlet time zone. */
export function formatDateLabel(
  instant: string,
  timeZone: string = OUTLET_TIME_ZONE,
): string {
  return formatter(dateFormatters, timeZone, {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(instant));
}

/** Business date (`YYYY-MM-DD`) of an instant in the outlet time zone. */
export function businessDateInOutletZone(
  instant: string | Date,
  timeZone: string = OUTLET_TIME_ZONE,
): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(typeof instant === "string" ? new Date(instant) : instant);
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export type TicketStatusTone = "info" | "success" | "warning" | "danger";

type TicketStatusMeta = {
  /** Catalog key under `facility.ticket.status`. */
  readonly key:
    | "pendingPayment"
    | "issued"
    | "inUse"
    | "completed"
    | "noShow"
    | "cancelled"
    | "refunded";
  readonly tone: TicketStatusTone;
};

const TICKET_STATUS: Record<AccessTicketStatus, TicketStatusMeta> = {
  pending_payment: { key: "pendingPayment", tone: "warning" },
  issued: { key: "issued", tone: "success" },
  in_use: { key: "inUse", tone: "info" },
  completed: { key: "completed", tone: "success" },
  no_show: { key: "noShow", tone: "danger" },
  cancelled: { key: "cancelled", tone: "danger" },
  refunded: { key: "refunded", tone: "danger" },
};

export function ticketStatusMeta(status: AccessTicketStatus): TicketStatusMeta {
  return TICKET_STATUS[status];
}

const ACTIVE_STATUSES: readonly AccessTicketStatus[] = [
  "pending_payment",
  "issued",
  "in_use",
];

export function isActiveTicket(status: AccessTicketStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

/** Active first, then the newest session first (list screen). */
export function sortTicketViews(
  views: readonly AccessTicketView[],
): AccessTicketView[] {
  return [...views].sort((a, b) => {
    const active =
      Number(isActiveTicket(b.ticket.status)) -
      Number(isActiveTicket(a.ticket.status));
    if (active !== 0) return active;
    return (
      Date.parse(b.ticket.slot.startsAt) - Date.parse(a.ticket.slot.startsAt)
    );
  });
}

/** Area and unit names of a ticket, read from the day's availability. */
export function unitLabel(
  availability: FacilityAvailability | undefined,
  unitId: string,
): { areaName: string; code: string } | null {
  if (!availability) return null;
  for (const area of availability.areas) {
    for (const unit of area.units)
      if (unit.unitId === unitId)
        return { areaName: area.name, code: unit.code };
  }
  return null;
}

/** `YYYY-MM-DD` shifted by whole days (business-date arithmetic, no clock). */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}
