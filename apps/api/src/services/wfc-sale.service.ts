// Paid WFC sale (brief 1270 card W2; PRD v1.7 §3 F25/F39, FAC-14): a member
// holds a seat, pays the pass online and gets the seat once the payment is
// confirmed (wfc-payment-consumer.ts). Rules (brief §3, decision 28 §2-3, W1 /
// W1b reviews):
//
// - Cloud only, member only, flag `WFC_SALES_ENABLED` and a complete settings
//   version (wfc-sales-gate.ts). An edge process sells nothing (403).
// - QRIS only (CTO 26 Nov, W1b no. 2): the link token is sealed on the claim and
//   never handed out, the server issues the QRIS code itself, so no other
//   method can be picked on the hosted page.
// - Hold first, link after: the claim (`pending_payment`, hold 45 min) commits
//   before `createPaymentLink` (its own transaction); the link (30 min) is
//   attached under the lock order link -> claim. A link that cannot be opened
//   releases the seat at once.
// - One unpaid hold per member (unique index, migration 0529).
// - The slot is real: inside the facility's hours of that day, never across
//   midnight; `off_peak` entirely outside the zone's Wi-Fi peak schedule (no
//   schedule: unproven, refused). A day pass runs to the last closing of the day.
// - Quota per outlet-local hour: claims of every kind that hold a seat in that
//   hour stay below min(quota cell, active WFC seats, approved `wfc_seats`),
//   counted under `lockOutletSeats` (also taken by quota, seat, zone and
//   settings writes). The exclusion constraint keeps one claim per seat.
// - Price floor re-checked per real slot (W1b no. 4): peak and off-peak
//   minutes of the slot, the settings version of the slot's business date read
//   again under the lock, and the outlet's food and drink service charge now.
//   The sale stores the version, the hourly floor and the split.
import { and, asc, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import {
  idr,
  outletIdSchema,
  type ScopedTenantContext,
  type z,
} from "@starter/shared/core";
import {
  minutesOfDay,
  wallClockAt,
  windowEndMinutes,
  type FacilityDayHours,
} from "@starter/shared/facility";
import { createPaymentIntentInputSchema } from "@starter/shared/payment";
import {
  checkWfcSlotFloor,
  holdWfcSeatSchema,
  listWfcSaleProductsQuerySchema,
  WFC_ACTIVE_RESERVATION_STATUSES,
  WFC_HOLD_MINUTES,
  WFC_LINK_MINUTES,
  WFC_PAYMENT_METHOD,
  wfcClaimSchema,
  wfcSaleProductSchema,
  type HoldWfcSeatInput,
  type ListWfcSaleProductsInput,
  type WfcClaim,
  type WfcPaymentCode,
  type WfcSaleProduct,
} from "@starter/shared/wfc";
import { eqId } from "../db/branded-ids.ts";
import { db } from "../db/index.ts";
import { withMemberScope, type MemberScope } from "../db/member-scope.ts";
import { facilityProducts, wifiPolicies } from "../db/schema/facility.ts";
import { floorZones } from "../db/schema/floor.ts";
import { paymentIntents, paymentLinks } from "../db/schema/payment.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { wfcSeatReservations, wfcSeats } from "../db/schema/wfc-seat.ts";
import { wfcHourlyQuotas } from "../db/schema/wfc-settings.ts";
import { withTenant } from "../db/tenant.ts";
import { getEdgeRuntimeState } from "../edge/runtime.ts";
import { HttpError } from "../lib/http-error.ts";
import { logger } from "../lib/logger.ts";
import { openSecret, sealSecret } from "../lib/secrets.ts";
import { auditFacility, notFound, pgErrorCode, type Tx } from "./facility-shared.ts";
import { resolveOperatingHoursOn } from "./facility-hours-versions.service.ts";
import {
  gatewayListsMethod,
  selectGatewayForNewIntent,
} from "./payment-gateway-select.ts";
import { resolveRoutingRule } from "./payment-routing.service.ts";
import {
  cancelPaymentLinkInTx,
  createIntent,
  createPaymentLink,
  readIntentView,
} from "./payment.service.ts";
import { assertWfcSalesOpen } from "./wfc-sales-gate.ts";
import { countActiveWfcSeats, lockOutletSeats } from "./wfc-seat.service.ts";
import { outletServiceChargeBp } from "./wfc-settings.service.ts";
import {
  findWfcSettings,
  wfcBusinessDate,
  wfcConfigIncomplete,
} from "./wfc-settings.ts";

type ClaimRow = typeof wfcSeatReservations.$inferSelect;
type ProductRow = typeof facilityProducts.$inferSelect;

/** `payment_links.created_by` of a pass (free text; members are not staff). */
export const WFC_LINK_CREATED_BY = "system:wfc";
const RETURN_PATH = "/wfc";
const MINUTE_MS = 60_000;
const DAY_MINUTES = 24 * 60;
const PG_EXCLUSION_VIOLATION = "23P01";
const PG_UNIQUE_VIOLATION = "23505";

/** AAD of the sealed link token (also in the re-seal registry). */
export const wfcLinkSealAad = (tenantId: string, claimId: string) =>
  `wfc-payment-link:${tenantId}:${claimId}`;

/** True in an edge process: WFC is sold and settled by the cloud only. */
export function wfcEdgeProcess(): boolean {
  return getEdgeRuntimeState().edgeMode || process.env.EDGE_MODE === "true";
}

function parseInput<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): z.output<Schema> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new HttpError(400, "VALIDATION_FAILED", "Input tidak valid.");
  return result.data;
}

const conflict = (code: string, message: string) =>
  new HttpError(409, code, message);
const seatTaken = () =>
  conflict("WFC_SEAT_TAKEN", "Kursi ini sudah dipesan untuk jam itu.");
const noSeat = () =>
  conflict("WFC_NO_SEAT", "Tidak ada kursi WFC yang kosong untuk jam itu.");
const quotaFull = () =>
  conflict("WFC_QUOTA_FULL", "Kuota kursi WFC untuk jam itu sudah penuh.");
const holdOpen = () =>
  conflict(
    "WFC_HOLD_OPEN",
    "Selesaikan atau tunggu pesanan kursi sebelumnya berakhir.",
  );
const slotInvalid = (message: string) =>
  new HttpError(422, "WFC_SLOT_INVALID", message);
const paymentUnavailable = () =>
  new HttpError(
    503,
    "WFC_PAYMENT_UNAVAILABLE",
    "Pembayaran QRIS sedang tidak tersedia. Coba lagi nanti.",
  );

function assertCloud(): void {
  if (wfcEdgeProcess())
    throw new HttpError(
      403,
      "WFC_NEEDS_CLOUD",
      "Pass WFC hanya dijual lewat aplikasi online.",
    );
}

function memberProfileId(scope: MemberScope): string {
  if (scope.customerProfileId === null)
    throw new HttpError(404, "CUSTOMER_NOT_FOUND", "Pelanggan tidak ditemukan.");
  return scope.customerProfileId;
}

// ---- Clock ------------------------------------------------------------------

type OutletClock = { timeZone: string };

async function loadOutletClock(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
): Promise<OutletClock> {
  const [outlet] = await tx
    .select({ timezone: outlets.timezone })
    .from(outlets)
    .where(
      and(
        eq(outlets.tenantId, context.tenant.tenantId),
        eqId(outlets.id, outletId),
      ),
    )
    .limit(1);
  if (!outlet) throw notFound("Outlet");
  return { timeZone: outlet.timezone };
}

/** Local calendar date (YYYY-MM-DD) of an instant. */
function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** Wall-clock offset (ms) of a zone at an instant. */
function offsetMs(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const part = (type: string) =>
    Number(parts.find((entry) => entry.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** The instant the outlet's wall clock reads `date` + `minutes`. */
function wallInstant(date: string, minutes: number, timeZone: string): Date {
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const wall = Date.UTC(year, month - 1, day) + minutes * MINUTE_MS;
  let guess = wall;
  for (let i = 0; i < 3; i += 1) guess = wall - offsetMs(guess, timeZone);
  return new Date(guess);
}

/** Minutes of one weekday covered by a set of windows (bitmap of 1440). */
function dayBitmap(
  windows: readonly {
    daysOfWeek: readonly number[];
    start: number;
    end: number;
  }[],
  dayOfWeek: number,
): boolean[] {
  const minutes = new Array<boolean>(DAY_MINUTES).fill(false);
  for (const window of windows)
    if (window.daysOfWeek.includes(dayOfWeek))
      for (let m = window.start; m < Math.min(window.end, DAY_MINUTES); m += 1)
        minutes[m] = true;
  return minutes;
}

// ---- Slot -------------------------------------------------------------------

export type WfcSlot = {
  startsAt: Date;
  endsAt: Date;
  /** Local calendar date and weekday of the slot. */
  date: string;
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
};

/**
 * The real slot of a hold. A seat reservation starts at `startsAt` (whole
 * minute, not in the past) and lasts the product's minutes, all of them inside
 * the facility's open hours of that day. A day pass runs from the first opening
 * of `date` (or now, today) to the last closing; its start must be open.
 */
function planSlot(
  product: ProductRow,
  input: { startsAt?: string; date?: string },
  hours: readonly FacilityDayHours[] | null,
  clock: OutletClock,
  now: Date,
): WfcSlot {
  if (!hours || hours.length === 0)
    throw slotInvalid("Jam buka fasilitas belum diatur.");
  const windows = hours.map((day) => ({
    daysOfWeek: day.daysOfWeek,
    start: minutesOfDay(day.opensAt),
    end: minutesOfDay(day.closesAt),
  }));
  const nowMinute = Math.ceil(now.getTime() / MINUTE_MS) * MINUTE_MS;
  let date: string;
  let startMinute: number;
  let endMinute: number;
  if (product.wfcKind === "seat_reservation") {
    if (input.startsAt === undefined || product.durationMinutes === null)
      throw slotInvalid("Reservasi kursi butuh jam mulai.");
    const startsAt = new Date(input.startsAt);
    if (startsAt.getTime() % MINUTE_MS !== 0)
      throw slotInvalid("Jam mulai harus tepat di menit.");
    if (startsAt.getTime() < now.getTime())
      throw slotInvalid("Jam mulai sudah lewat.");
    date = localDate(startsAt, clock.timeZone);
    startMinute = wallClockAt(startsAt, clock.timeZone).minutesOfDay;
    endMinute = startMinute + product.durationMinutes;
  } else {
    if (input.date === undefined)
      throw slotInvalid("Day pass butuh tanggal.");
    date = input.date;
    const today = localDate(now, clock.timeZone);
    if (date < today) throw slotInvalid("Tanggal sudah lewat.");
    const dayOfWeek = wallClockAt(
      wallInstant(date, 12 * 60, clock.timeZone),
      clock.timeZone,
    ).dayOfWeek;
    const open = windows.filter((w) => w.daysOfWeek.includes(dayOfWeek));
    if (open.length === 0) throw slotInvalid("Fasilitas tutup di tanggal itu.");
    const firstOpen = Math.min(...open.map((w) => w.start));
    endMinute = Math.max(...open.map((w) => w.end));
    startMinute =
      date === today
        ? Math.max(
            firstOpen,
            wallClockAt(new Date(nowMinute), clock.timeZone).minutesOfDay,
          )
        : firstOpen;
    if (startMinute >= endMinute)
      throw slotInvalid("Fasilitas sudah tutup hari ini.");
  }
  if (endMinute > DAY_MINUTES)
    throw slotInvalid("Pesanan kursi tidak boleh melewati tengah malam.");
  const startsAt = wallInstant(date, startMinute, clock.timeZone);
  const endsAt = wallInstant(date, endMinute, clock.timeZone);
  // A clock change inside the slot would make the minute math wrong: refuse.
  if (endsAt.getTime() - startsAt.getTime() !== (endMinute - startMinute) * MINUTE_MS)
    throw slotInvalid("Jam itu tidak bisa dipesan.");
  const dayOfWeek = wallClockAt(startsAt, clock.timeZone).dayOfWeek;
  const openMinutes = dayBitmap(windows, dayOfWeek);
  const mustBeOpen =
    product.wfcKind === "seat_reservation"
      ? Array.from({ length: endMinute - startMinute }, (_, i) => startMinute + i)
      : [startMinute, endMinute - 1];
  if (!mustBeOpen.every((minute) => openMinutes[minute]))
    throw slotInvalid("Jam itu di luar jam buka fasilitas.");
  return { startsAt, endsAt, date, dayOfWeek, startMinute, endMinute };
}

/** Peak minutes of the slot by the zone's Wi-Fi peak schedule; null = no schedule. */
async function slotPeakMinutes(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  zoneId: string,
  slot: WfcSlot,
): Promise<number | null> {
  const [policy] = await tx
    .select({ peakSchedule: wifiPolicies.peakSchedule })
    .from(wifiPolicies)
    .where(
      and(
        eq(wifiPolicies.tenantId, context.tenant.tenantId),
        eqId(wifiPolicies.outletId, outletId),
        eq(wifiPolicies.zoneId, zoneId),
      ),
    )
    .limit(1);
  if (!policy) return null;
  const peak = dayBitmap(
    policy.peakSchedule.map((window) => ({
      daysOfWeek: window.daysOfWeek,
      start: minutesOfDay(window.startsAt),
      end: windowEndMinutes(window.endsAt),
    })),
    slot.dayOfWeek,
  );
  let count = 0;
  for (let m = slot.startMinute; m < slot.endMinute; m += 1)
    if (peak[m]) count += 1;
  return count;
}

// ---- Seats and quota --------------------------------------------------------

type SeatCandidate = { id: string; code: string; zoneId: string };

/** Active seats in active WFC zones of the outlet, by code. */
async function sellableSeats(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
): Promise<SeatCandidate[]> {
  return tx
    .select({ id: wfcSeats.id, code: wfcSeats.code, zoneId: wfcSeats.zoneId })
    .from(wfcSeats)
    .innerJoin(
      floorZones,
      and(
        eq(floorZones.tenantId, wfcSeats.tenantId),
        eq(floorZones.outletId, wfcSeats.outletId),
        eq(floorZones.id, wfcSeats.zoneId),
      ),
    )
    .where(
      and(
        eq(wfcSeats.tenantId, context.tenant.tenantId),
        eqId(wfcSeats.outletId, outletId),
        eq(wfcSeats.status, "active"),
        eq(floorZones.isWfc, true),
        eq(floorZones.status, "active"),
      ),
    )
    .orderBy(asc(wfcSeats.code), asc(wfcSeats.id));
}

const activeClaim = () =>
  inArray(wfcSeatReservations.status, [...WFC_ACTIVE_RESERVATION_STATUSES]);

/** Claims of the outlet that hold a seat somewhere in [from, to). */
async function claimsOverlapping(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  from: Date,
  to: Date,
  seatId?: string,
): Promise<{ seatId: string }[]> {
  return tx
    .select({ seatId: wfcSeatReservations.seatId })
    .from(wfcSeatReservations)
    .where(
      and(
        eq(wfcSeatReservations.tenantId, context.tenant.tenantId),
        eqId(wfcSeatReservations.outletId, outletId),
        activeClaim(),
        lt(wfcSeatReservations.startsAt, to),
        gt(wfcSeatReservations.endsAt, from),
        ...(seatId === undefined ? [] : [eq(wfcSeatReservations.seatId, seatId)]),
      ),
    );
}

/**
 * Throws 409 WFC_QUOTA_FULL unless every outlet-local hour the slot touches
 * has room for one more claim: claims holding a seat in that hour stay below
 * min(quota cell, active WFC seats, approved `wfc_seats`). Caller holds
 * `lockOutletSeats`.
 */
async function assertQuota(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  slot: WfcSlot,
  approvedSeats: number,
): Promise<void> {
  const cells = await tx
    .select({ hour: wfcHourlyQuotas.hour, seats: wfcHourlyQuotas.seats })
    .from(wfcHourlyQuotas)
    .where(
      and(
        eq(wfcHourlyQuotas.tenantId, context.tenant.tenantId),
        eqId(wfcHourlyQuotas.outletId, outletId),
        eq(wfcHourlyQuotas.dayOfWeek, slot.dayOfWeek),
      ),
    );
  const activeSeats = await countActiveWfcSeats(tx, context, outletId);
  const firstHour = Math.floor(slot.startMinute / 60);
  const lastHour = Math.ceil(slot.endMinute / 60) - 1;
  for (let hour = firstHour; hour <= lastHour; hour += 1) {
    const cell = cells.find((row) => row.hour === hour)?.seats ?? 0;
    const cap = Math.min(cell, activeSeats, approvedSeats);
    const from = new Date(
      slot.startsAt.getTime() + (hour * 60 - slot.startMinute) * MINUTE_MS,
    );
    const to = new Date(from.getTime() + 60 * MINUTE_MS);
    const taken = await claimsOverlapping(tx, context, outletId, from, to);
    if (taken.length + 1 > cap) throw quotaFull();
  }
}

// ---- Payment ----------------------------------------------------------------

/**
 * Fails closed unless the outlet's QRIS rule selects a gateway that is up and
 * lists QRIS at the price (pattern of reservation-deposit-payment.ts).
 */
async function assertQrisReady(
  context: ScopedTenantContext,
  outletId: string,
  amountIdr: number,
): Promise<void> {
  try {
    const routing = await withTenant(db, context, (tx) =>
      resolveRoutingRule(tx, context, outletId, WFC_PAYMENT_METHOD),
    );
    const selected = await selectGatewayForNewIntent(context, outletId, routing);
    if (
      !routing.enabled ||
      selected.provider === null ||
      !(await gatewayListsMethod(
        context,
        selected.port,
        WFC_PAYMENT_METHOD,
        outletId,
        amountIdr,
      ))
    )
      throw paymentUnavailable();
  } catch {
    throw paymentUnavailable();
  }
}

function linkReference(claimId: string): string {
  return `WFC-${claimId.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
}

/** Issues (or returns the live) QRIS code of a held claim; null on failure. */
async function issueQris(
  context: ScopedTenantContext,
  claim: ClaimRow,
  now: Date,
): Promise<WfcPaymentCode | null> {
  if (claim.paymentLinkTokenSealed === null) return null;
  const token = openSecret(
    claim.paymentLinkTokenSealed,
    wfcLinkSealAad(context.tenant.tenantId, claim.id),
  );
  const live = await latestCode(context, claim, now);
  if (live && live.status === "pending") return live;
  if (live && live.status === "paid") return live;
  const count = await withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.paymentLinkId, claim.paymentLinkId!),
        ),
      );
    return Number(row?.count ?? 0);
  });
  const minute = Math.floor(now.getTime() / MINUTE_MS);
  try {
    const intent = await createIntent(
      context,
      token,
      createPaymentIntentInputSchema.parse({
        method: WFC_PAYMENT_METHOD,
        channelCode: null,
        idempotencyKey: `wfc:${claim.id}:${count}:${minute}`,
      }),
      now,
    );
    return toCode(intent);
  } catch (error) {
    logger.warn(
      { claimId: claim.id, code: (error as { code?: unknown }).code },
      "WFC QRIS code not issued",
    );
    return null;
  }
}

function toCode(intent: {
  id: string;
  amountIdr: number;
  status: string;
  expiresAt: string;
  instructions: { method: string; qrPayload?: string };
}): WfcPaymentCode {
  return {
    intentId: intent.id,
    qrisPayload:
      intent.instructions.method === "qris"
        ? (intent.instructions.qrPayload ?? null)
        : null,
    amountIdr: intent.amountIdr,
    status: intent.status,
    expiresAt: intent.expiresAt,
  };
}

/** The newest code of the claim's link, stored state only (no provider call). */
async function latestCode(
  context: ScopedTenantContext,
  claim: ClaimRow,
  now: Date,
): Promise<WfcPaymentCode | null> {
  if (claim.paymentLinkId === null || claim.paymentLinkTokenSealed === null)
    return null;
  const [intent] = await withTenant(db, context, (tx) =>
    tx
      .select({ id: paymentIntents.id })
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.paymentLinkId, claim.paymentLinkId!),
        ),
      )
      .orderBy(desc(paymentIntents.createdAt))
      .limit(1),
  );
  if (!intent) return null;
  try {
    const token = openSecret(
      claim.paymentLinkTokenSealed,
      wfcLinkSealAad(context.tenant.tenantId, claim.id),
    );
    return toCode(await readIntentView(context, token, intent.id, now));
  } catch {
    return null;
  }
}

// ---- Mappers ----------------------------------------------------------------

function toSaleProduct(row: ProductRow): WfcSaleProduct {
  return wfcSaleProductSchema.parse({
    productId: row.id,
    outletId: row.outletId,
    name: row.name,
    kind: row.wfcKind,
    access: row.wfcAccess,
    priceIdr: row.priceIdr,
    seatFeeIdr: row.seatFeeIdr,
    creditIdr: row.creditIdr,
    durationMinutes: row.durationMinutes,
  });
}

function toClaim(
  row: ClaimRow,
  seatCode: string,
  payment: WfcPaymentCode | null,
): WfcClaim {
  return wfcClaimSchema.parse({
    id: row.id,
    outletId: row.outletId,
    productId: row.productId,
    seatId: row.seatId,
    seatCode,
    kind: row.kind,
    access: row.access,
    businessDate: row.businessDate,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    status: row.status,
    priceIdr: row.priceIdr,
    seatFeeIdr: row.seatFeeIdr,
    creditIdr: row.creditIdr,
    paidIdr: row.paidIdr,
    refundedIdr: row.refundedIdr,
    holdExpiresAt: row.holdExpiresAt?.toISOString() ?? null,
    payment: row.status === "pending_payment" ? payment : null,
  });
}

async function seatCodeOf(
  tx: Tx,
  context: ScopedTenantContext,
  seatId: string,
): Promise<string> {
  const [seat] = await tx
    .select({ code: wfcSeats.code })
    .from(wfcSeats)
    .where(
      and(eq(wfcSeats.tenantId, context.tenant.tenantId), eq(wfcSeats.id, seatId)),
    )
    .limit(1);
  return seat?.code ?? "";
}

// ---- Reads ------------------------------------------------------------------

/** Passes on sale at an outlet (empty while sales are closed). */
export async function listWfcSaleProducts(
  scope: MemberScope,
  input: ListWfcSaleProductsInput,
): Promise<WfcSaleProduct[]> {
  const { outletId } = parseInput(listWfcSaleProductsQuerySchema, input);
  if (wfcEdgeProcess()) return [];
  return withMemberScope(db, scope, async (tx) => {
    try {
      await assertWfcSalesOpen(tx, scope.context, outletId, new Date());
    } catch {
      return [];
    }
    const rows = await tx
      .select()
      .from(facilityProducts)
      .where(
        and(
          eq(facilityProducts.tenantId, scope.context.tenant.tenantId),
          eqId(facilityProducts.outletId, outletId),
          eq(facilityProducts.isActive, true),
          sql`${facilityProducts.wfcKind} IS NOT NULL`,
        ),
      )
      .orderBy(asc(facilityProducts.priceIdr), asc(facilityProducts.id));
    return rows.map(toSaleProduct);
  });
}

async function loadOwnClaim(
  tx: Tx,
  scope: MemberScope,
  claimId: string,
): Promise<ClaimRow> {
  const [row] = await tx
    .select()
    .from(wfcSeatReservations)
    .where(
      and(
        eq(wfcSeatReservations.tenantId, scope.context.tenant.tenantId),
        eq(wfcSeatReservations.id, claimId),
        eq(wfcSeatReservations.customerProfileId, memberProfileId(scope)),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Pesanan kursi");
  return row;
}

/** One claim of the member, with its QRIS code while unpaid. */
export async function getWfcClaim(
  scope: MemberScope,
  claimId: string,
  now: Date = new Date(),
): Promise<WfcClaim> {
  const { row, seatCode } = await withMemberScope(db, scope, async (tx) => {
    const found = await loadOwnClaim(tx, scope, claimId);
    return { row: found, seatCode: await seatCodeOf(tx, scope.context, found.seatId) };
  });
  return toClaim(row, seatCode, await latestCode(scope.context, row, now));
}

/** The member's claims, newest slot first (at most 50). */
export async function listMyWfcClaims(
  scope: MemberScope,
  now: Date = new Date(),
): Promise<WfcClaim[]> {
  const rows = await withMemberScope(db, scope, (tx) =>
    tx
      .select({ claim: wfcSeatReservations, seatCode: wfcSeats.code })
      .from(wfcSeatReservations)
      .innerJoin(
        wfcSeats,
        and(
          eq(wfcSeats.tenantId, wfcSeatReservations.tenantId),
          eq(wfcSeats.id, wfcSeatReservations.seatId),
        ),
      )
      .where(
        and(
          eq(wfcSeatReservations.tenantId, scope.context.tenant.tenantId),
          eq(wfcSeatReservations.customerProfileId, memberProfileId(scope)),
        ),
      )
      .orderBy(desc(wfcSeatReservations.startsAt))
      .limit(50),
  );
  return Promise.all(
    rows.map(async ({ claim, seatCode }) =>
      toClaim(
        claim,
        seatCode,
        claim.status === "pending_payment"
          ? await latestCode(scope.context, claim, now)
          : null,
      ),
    ),
  );
}

// ---- Hold -------------------------------------------------------------------

async function loadSaleProduct(
  tx: Tx,
  context: ScopedTenantContext,
  productId: string,
): Promise<ProductRow> {
  const [row] = await tx
    .select()
    .from(facilityProducts)
    .where(
      and(
        eq(facilityProducts.tenantId, context.tenant.tenantId),
        eq(facilityProducts.id, productId),
      ),
    )
    .limit(1);
  if (
    !row ||
    !row.isActive ||
    row.wfcKind === null ||
    row.wfcAccess === null ||
    row.seatFeeIdr === null ||
    row.creditIdr === null
  )
    throw notFound("Produk WFC");
  return row;
}

/** Pending claim of the member (one at most). */
async function openHoldOf(
  tx: Tx,
  context: ScopedTenantContext,
  profileId: string,
): Promise<ClaimRow | null> {
  const [row] = await tx
    .select()
    .from(wfcSeatReservations)
    .where(
      and(
        eq(wfcSeatReservations.tenantId, context.tenant.tenantId),
        eq(wfcSeatReservations.customerProfileId, profileId),
        eq(wfcSeatReservations.status, "pending_payment"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Step 1: the claim, `pending_payment`, every rule checked under the outlet
 * lock. Returns the claim, or the member's open hold of the very same request
 * (a retry), or throws.
 */
async function insertHold(
  scope: MemberScope,
  input: z.output<typeof holdWfcSeatSchema>,
  now: Date,
): Promise<{ claim: ClaimRow; replay: boolean }> {
  const context = scope.context;
  const profileId = memberProfileId(scope);
  return withMemberScope(db, scope, async (tx) => {
    const preview = await loadSaleProduct(tx, context, input.productId);
    const outletId = preview.outletId;
    await lockOutletSeats(tx, context, outletId);
    const today = await assertWfcSalesOpen(tx, context, outletId, now);
    const product = await loadSaleProduct(tx, context, input.productId);
    const clock = await loadOutletClock(tx, context, outletId);
    const hoursDate = input.date ?? localDate(new Date(input.startsAt!), clock.timeZone);
    const hours = await resolveOperatingHoursOn(
      tx,
      context.tenant.tenantId,
      product.facilityId,
      hoursDate,
    );
    const slot = planSlot(product, input, hours, clock, now);
    const open = await openHoldOf(tx, context, profileId);
    if (open) {
      if (
        open.productId === product.id &&
        open.startsAt.getTime() === slot.startsAt.getTime() &&
        (input.seatId === undefined || input.seatId === open.seatId)
      )
        return { claim: open, replay: true };
      throw holdOpen();
    }
    const businessDate = await wfcBusinessDate(tx, context, outletId, slot.startsAt);
    if (businessDate < (await wfcBusinessDate(tx, context, outletId, now)))
      throw slotInvalid("Tanggal sudah lewat.");
    // The version of the slot's own business date, read again under the lock.
    const settings = await findWfcSettings(tx, context, outletId, businessDate);
    if (!settings) throw wfcConfigIncomplete();
    const seats = await sellableSeats(tx, context, outletId);
    const candidates =
      input.seatId === undefined
        ? seats
        : seats.filter((seat) => seat.id === input.seatId);
    if (input.seatId !== undefined && candidates.length === 0)
      throw notFound("Kursi");
    let seat: SeatCandidate | null = null;
    for (const candidate of candidates) {
      const taken = await claimsOverlapping(
        tx,
        context,
        outletId,
        slot.startsAt,
        slot.endsAt,
        candidate.id,
      );
      if (taken.length === 0) {
        seat = candidate;
        break;
      }
    }
    if (!seat) throw input.seatId === undefined ? noSeat() : seatTaken();
    await assertQuota(
      tx,
      context,
      outletId,
      slot,
      Math.min(settings.wfcSeats, today.wfcSeats),
    );
    const minutes = slot.endMinute - slot.startMinute;
    const peak = await slotPeakMinutes(tx, context, outletId, seat.zoneId, slot);
    if (product.wfcAccess === "off_peak" && peak !== 0)
      throw slotInvalid(
        peak === null
          ? "Jam sepi outlet ini belum diatur."
          : "Pass jam sepi tidak bisa dipakai di jam ramai.",
      );
    const peakMinutes = peak ?? minutes;
    const floor = checkWfcSlotFloor(
      settings,
      { seatFeeIdr: product.seatFeeIdr!, creditIdr: product.creditIdr! },
      { peakMinutes, offPeakMinutes: minutes - peakMinutes },
      await outletServiceChargeBp(
        tx,
        context,
        outletId,
        await wfcBusinessDate(tx, context, outletId, now),
      ),
    );
    if (!floor.ok)
      throw new HttpError(
        422,
        "WFC_PRICE_BELOW_FLOOR",
        "Pass ini belum bisa dijual untuk jam itu.",
      );
    const floorPerHour = Math.max(1, Math.ceil((floor.floorIdr * 60) / minutes));
    try {
      const [claim] = await tx
        .insert(wfcSeatReservations)
        .values({
          tenantId: context.tenant.tenantId,
          outletId: outletIdSchema.parse(outletId),
          seatId: seat.id,
          productId: product.id,
          customerProfileId: profileId,
          kind: product.wfcKind!,
          access: product.wfcAccess!,
          businessDate,
          slot: `[${slot.startsAt.toISOString()},${slot.endsAt.toISOString()})`,
          status: "pending_payment",
          seatFeeIdr: idr(product.seatFeeIdr!),
          creditIdr: idr(product.creditIdr!),
          priceIdr: idr(product.priceIdr),
          settingsVersionId: settings.id,
          floorPerHourIdr: idr(floorPerHour),
          holdExpiresAt: new Date(now.getTime() + WFC_HOLD_MINUTES * MINUTE_MS),
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!claim) throw new Error("WFC claim insert returned no row");
      await auditFacility(tx, context, null, now, {
        action: "wfc.claim_held",
        objectType: "wfc_seat_reservation",
        objectId: claim.id,
        outletId,
        before: null,
        after: {
          status: claim.status,
          startsAt: claim.startsAt.toISOString(),
          endsAt: claim.endsAt.toISOString(),
          priceIdr: claim.priceIdr,
          seatFeeIdr: claim.seatFeeIdr,
          creditIdr: claim.creditIdr,
        },
      });
      return { claim, replay: false };
    } catch (error) {
      const code = pgErrorCode(error);
      if (code === PG_EXCLUSION_VIOLATION) throw seatTaken();
      if (code === PG_UNIQUE_VIOLATION) throw holdOpen();
      throw error;
    }
  });
}

/** Releases a hold whose link could not be opened or attached. */
async function releaseHold(
  context: ScopedTenantContext,
  claimId: string,
  now: Date,
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    const [claim] = await tx
      .select()
      .from(wfcSeatReservations)
      .where(
        and(
          eq(wfcSeatReservations.tenantId, context.tenant.tenantId),
          eq(wfcSeatReservations.id, claimId),
          eq(wfcSeatReservations.status, "pending_payment"),
        ),
      )
      .for("update");
    if (!claim || claim.paymentLinkId !== null) return;
    await tx
      .update(wfcSeatReservations)
      .set({ status: "cancelled", holdExpiresAt: null, updatedAt: now })
      .where(
        and(
          eq(wfcSeatReservations.tenantId, context.tenant.tenantId),
          eq(wfcSeatReservations.id, claim.id),
        ),
      );
  });
}

/**
 * Step 2: the claim's link (30 min, price as subtotal and total, no discount,
 * tax and service charge 0: the pass price is tax inclusive until the
 * accountant answers), attached link -> claim with its sealed token.
 */
async function attachLink(
  context: ScopedTenantContext,
  claim: ClaimRow,
  now: Date,
): Promise<ClaimRow> {
  let opened: Awaited<ReturnType<typeof createPaymentLink>>;
  try {
    opened = await createPaymentLink(
      context,
      {
        outletId: outletIdSchema.parse(claim.outletId),
        reference: linkReference(claim.id),
        tableLabel: null,
        pax: null,
        subtotalIdr: claim.priceIdr,
        discountIdr: idr(0),
        serviceChargeIdr: idr(0),
        taxIdr: idr(0),
        roundingIdr: idr(0),
        totalIdr: claim.priceIdr,
        returnPath: RETURN_PATH,
        expiresInMinutes: WFC_LINK_MINUTES,
      },
      WFC_LINK_CREATED_BY,
      now,
    );
  } catch {
    await releaseHold(context, claim.id, now);
    throw paymentUnavailable();
  }
  const attached = await withTenant(db, context, async (tx) => {
    await tx
      .select({ id: paymentLinks.id })
      .from(paymentLinks)
      .where(
        and(
          eq(paymentLinks.tenantId, context.tenant.tenantId),
          eq(paymentLinks.id, opened.linkId),
        ),
      )
      .for("update");
    const [locked] = await tx
      .select()
      .from(wfcSeatReservations)
      .where(
        and(
          eq(wfcSeatReservations.tenantId, context.tenant.tenantId),
          eq(wfcSeatReservations.id, claim.id),
        ),
      )
      .for("update");
    if (
      !locked ||
      locked.status !== "pending_payment" ||
      locked.paymentLinkId !== null
    ) {
      await cancelPaymentLinkInTx(tx, context, {
        linkId: opened.linkId,
        now,
        reason: "wfc_hold_closed",
      });
      return null;
    }
    const [row] = await tx
      .update(wfcSeatReservations)
      .set({
        paymentLinkId: opened.linkId,
        paymentLinkTokenSealed: sealSecret(
          opened.token,
          wfcLinkSealAad(context.tenant.tenantId, claim.id),
        ),
        updatedAt: now,
      })
      .where(
        and(
          eq(wfcSeatReservations.tenantId, context.tenant.tenantId),
          eq(wfcSeatReservations.id, claim.id),
        ),
      )
      .returning();
    return row ?? null;
  });
  if (!attached) throw holdOpen();
  return attached;
}

/**
 * Holds a seat for the member and opens its QRIS payment. A retry of the same
 * request while the hold is open returns that hold.
 */
export async function holdWfcSeat(
  scope: MemberScope,
  input: HoldWfcSeatInput,
  now: Date = new Date(),
): Promise<WfcClaim> {
  assertCloud();
  const parsed = parseInput(holdWfcSeatSchema, input);
  memberProfileId(scope);
  const context = scope.context;
  const product = await withMemberScope(db, scope, (tx) =>
    loadSaleProduct(tx, context, parsed.productId),
  );
  await assertQrisReady(context, product.outletId, product.priceIdr);
  const { claim: held } = await insertHold(scope, parsed, now);
  const claim =
    held.paymentLinkId === null ? await attachLink(context, held, now) : held;
  const payment = await issueQris(context, claim, now);
  const seatCode = await withTenant(db, context, (tx) =>
    seatCodeOf(tx, context, claim.seatId),
  );
  return toClaim(claim, seatCode, payment);
}

/** A fresh QRIS code for an unpaid hold (the old one lapsed). */
export async function refreshWfcPayment(
  scope: MemberScope,
  claimId: string,
  now: Date = new Date(),
): Promise<WfcClaim> {
  assertCloud();
  const { row, seatCode } = await withMemberScope(db, scope, async (tx) => {
    const found = await loadOwnClaim(tx, scope, claimId);
    return {
      row: found,
      seatCode: await seatCodeOf(tx, scope.context, found.seatId),
    };
  });
  if (
    row.status !== "pending_payment" ||
    row.holdExpiresAt === null ||
    row.holdExpiresAt <= now ||
    row.paymentLinkExpiresAt === null ||
    row.paymentLinkExpiresAt <= now
  )
    throw conflict(
      "WFC_HOLD_EXPIRED",
      "Waktu bayar pesanan kursi ini sudah habis.",
    );
  return toClaim(row, seatCode, await issueQris(scope.context, row, now));
}
