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
import type { LoginChallengeView } from "@starter/shared/identity";
import type {
  BreakfastDelivery,
  BreakfastMenuItem,
  CreateBreakfastOrderBody,
} from "./breakfast.ts";
import { BREAKFAST_MAX_QUANTITY } from "./breakfast.ts";

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

// ---- WhatsApp login gate (AUTH-01, AUTH-03) ---------------------------------

export type LoginOutcome = "pending" | "signed_in" | "expired" | "cancelled";

/**
 * Where a polled WhatsApp challenge stands. Only a completed challenge that
 * handed this browser a session signs the guest in; a pending challenge past
 * its `expiresAt` is treated as expired even before the server sweeps it, so
 * the screen never waits on a dead code (AUTH-01: valid 5 minutes).
 */
export function loginChallengeOutcome(
  view: LoginChallengeView,
  now: number,
): LoginOutcome {
  const { challenge } = view;
  if (challenge.status === "completed")
    return view.session !== null ? "signed_in" : "expired";
  if (challenge.status === "cancelled") return "cancelled";
  if (challenge.status === "expired") return "expired";
  return now >= Date.parse(challenge.expiresAt) ? "expired" : "pending";
}

// ---- What a ticket screen may show -----------------------------------------

/**
 * FAC-01: the door QR/PIN is shown only while the ticket can still open the
 * door. A cancelled, refunded, no-show or finished ticket hides any copy this
 * device still holds, so a dead credential never looks valid.
 */
export function ticketShowsCredential(status: AccessTicketStatus): boolean {
  return status === "issued" || status === "in_use";
}

/** The session timer belongs to a ticket that has or had a session. */
export function ticketShowsTimer(status: AccessTicketStatus): boolean {
  return status === "issued" || status === "in_use" || status === "completed";
}

// ---- Breakfast from the ticket (alur Z, FAC-10) ----------------------------

const MAX_FIRE_OFFSET_MINUTES = 240;

/**
 * FAC-10: the breakfast order is held and fired `fireOffsetMinutes` before the
 * session ends (the offset is the menu prep time). ISO string in UTC, the same
 * value the shared `linkedOrderFireAt` gives for a ticket; recompute it when the
 * session is extended or the guest is late.
 */
export function breakfastFireAt(
  slotEndsAt: string,
  fireOffsetMinutes: number,
): string {
  if (
    !Number.isInteger(fireOffsetMinutes) ||
    fireOffsetMinutes < 0 ||
    fireOffsetMinutes > MAX_FIRE_OFFSET_MINUTES
  )
    throw new RangeError(`Invalid fire offset: ${fireOffsetMinutes}`);
  const endsAt = Date.parse(slotEndsAt);
  if (Number.isNaN(endsAt))
    throw new RangeError(`Invalid session end: ${slotEndsAt}`);
  return new Date(endsAt - fireOffsetMinutes * MINUTE_MS).toISOString();
}

/** The breakfast section belongs to a ticket whose session is still ahead. */
export function ticketAllowsBreakfast(status: AccessTicketStatus): boolean {
  return status === "issued" || status === "in_use";
}

/** What the guest has picked so far: portions per dish and where to receive. */
export type BreakfastDraft = {
  quantities: Readonly<Record<string, number>>;
  mode: BreakfastDelivery["mode"];
  tableId: string;
};

export const INITIAL_BREAKFAST_DRAFT: BreakfastDraft = {
  quantities: {},
  mode: "table",
  tableId: "",
};

export type BreakfastDraftErrors = {
  /** No dish chosen. */
  items?: "empty";
  /** Delivery to a table without a table chosen. */
  table?: "required";
};

/** Sets one dish's portions, clamped to 0..max; 0 drops the dish. */
export function setBreakfastQuantity(
  draft: BreakfastDraft,
  menuItemId: string,
  quantity: number,
): BreakfastDraft {
  const next = Math.min(
    BREAKFAST_MAX_QUANTITY,
    Math.max(0, Math.trunc(Number.isFinite(quantity) ? quantity : 0)),
  );
  const quantities = { ...draft.quantities };
  if (next === 0) delete quantities[menuItemId];
  else quantities[menuItemId] = next;
  return { ...draft, quantities };
}

/** Chosen dishes with their portions, in menu order. */
export function breakfastChosenLines(
  menu: readonly BreakfastMenuItem[],
  draft: BreakfastDraft,
): { item: BreakfastMenuItem; quantity: number }[] {
  return menu
    .map((item) => ({ item, quantity: draft.quantities[item.id] ?? 0 }))
    .filter((line) => line.quantity > 0);
}

/** Display subtotal only: the server recomputes it from its own prices. */
export function breakfastSubtotalIdr(
  menu: readonly BreakfastMenuItem[],
  draft: BreakfastDraft,
): number {
  return breakfastChosenLines(menu, draft).reduce(
    (sum, line) => sum + line.item.priceIdr * line.quantity,
    0,
  );
}

/** Rules before submit: at least one dish, and a table when delivering. */
export function breakfastDraftErrors(
  menu: readonly BreakfastMenuItem[],
  draft: BreakfastDraft,
): BreakfastDraftErrors {
  const errors: BreakfastDraftErrors = {};
  if (breakfastChosenLines(menu, draft).length === 0) errors.items = "empty";
  if (draft.mode === "table" && draft.tableId === "") errors.table = "required";
  return errors;
}

/** The request body for a valid draft; `null` while the draft has errors. */
export function breakfastOrderBody(
  menu: readonly BreakfastMenuItem[],
  draft: BreakfastDraft,
  idempotencyKey: string,
): CreateBreakfastOrderBody | null {
  const errors = breakfastDraftErrors(menu, draft);
  if (errors.items || errors.table) return null;
  return {
    lines: breakfastChosenLines(menu, draft).map((line) => ({
      menuItemId: line.item.id,
      quantity: line.quantity,
    })),
    delivery:
      draft.mode === "table"
        ? { mode: "table", tableId: draft.tableId }
        : { mode: "pickup" },
    idempotencyKey,
  };
}
