// Slot availability and slot holds with no overlap (PRD v1.7 §3 F22
// "Pemesanan", §6 K `access_tickets` exclusion; FAC-02, FAC-06; bead
// legend-nm4f).
//
// A hold is an `access_tickets` row in `pending_payment`. The unit is
// occupied from `starts_at` to `cleaning_ends_at` (session + cleaning
// buffer), half-open, so two back-to-back sessions are legal but any overlap
// is not (FAC-02). Three layers keep that true under concurrency:
//   1. a transaction-scoped advisory lock per (tenant, facility) serializes
//      holds of one facility, so the overlap check and the insert are atomic;
//   2. the overlap check itself (same predicate as the constraint);
//   3. the partial EXCLUDE constraint `access_tickets_no_overlap`
//      (facility.custom.sql) as the database backstop; a 23P01 maps to the
//      same SLOT_UNAVAILABLE error.
// FAC-06: a unit that needs cleaning, is being cleaned or is under
// maintenance cannot be held, whichever slot is asked for.
//
// `holdFacilitySlot` is a trusted port that runs inside the caller's tenant
// transaction (like `redeemPromotions`): the booking flow (legend-bzih) and
// the POS sale own authentication of the guest and the payment/entitlement
// step; this module owns the slot invariant.
import { createHash } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import {
  assertOutletInScope,
  assertTrustedScopedContext,
  createUlid,
  addBusinessDays,
  businessDateOf,
  idempotencyKeySchema,
  userIdSchema,
  uuidSchema,
  z,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  accessTicketSchema,
  bookingTimingSchema,
  entitlementSourceSchema,
  estimateWaitMinutes,
  FacilityError,
  facilityAvailabilitySchema,
  SLOT_HOLD_PREDICATE_SQL,
  slotConfigSchema,
  slotFitsOperatingHours,
  slotFromStart,
  transitionTicket,
  transitionUnit,
  type AccessTicket,
  type FacilityAvailability,
  type FacilitySlot,
} from "@starter/shared/facility";
import { db } from "../db/index.ts";
import {
  accessTickets,
  facilityAreas,
  facilityQueueEntries,
  facilityUnits,
} from "../db/schema/facility.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  assertFacilityPermission,
  auditFacility,
  loadArea,
  loadFacility,
  OPERATE_PERMISSION,
  outletTimeZone,
  PG_EXCLUSION_VIOLATION,
  PG_UNIQUE_VIOLATION,
  pgErrorCode,
  toTicket,
  zonedInstant,
  type FacilityRow,
  type Tx,
  type UnitRow,
} from "./facility-shared.ts";
import { posTicketPaymentNotInFlightSql } from "./facility-pos-ticket-hold.ts";
import { unitAcceptsSlot, unitIsBookable } from "./facility-rules.ts";
import { resolveOperatingHoursOn } from "./facility-hours-versions.service.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { outletBusinessDayClock } from "./outlet-clock.ts";

/** Time zone + business day cutoff of the outlet (hours versions are keyed by business date). */
async function outletClock(tx: Tx, tenantId: TenantId, outletId: string) {
  const [outlet] = await tx
    .select({
      timezone: outlets.timezone,
      businessDayCutoff: outlets.businessDayCutoff,
    })
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)))
    .limit(1);
  if (!outlet) throw new HttpError(404, "NOT_FOUND", "Outlet tidak ditemukan.");
  return outletBusinessDayClock(outlet);
}

/** How long a `pending_payment` hold keeps its unit (PRD silent: 10 min). */
export const SLOT_HOLD_TTL_MINUTES = 10;

/**
 * How long a `notified` queue guest may claim the freed unit (legend-ke4z;
 * PRD silent: 10 min, same as the hold TTL). After that the entry expires and
 * the next guest in line is notified.
 */
export const QUEUE_CLAIM_WINDOW_MINUTES = 10;

const claimCutoff = (now: Date) =>
  new Date(now.getTime() - QUEUE_CLAIM_WINDOW_MINUTES * 60_000);

const holdSql = sql.raw(SLOT_HOLD_PREDICATE_SQL);
const occupiedRange = sql`tstzrange(${accessTickets.startsAt}, ${accessTickets.cleaningEndsAt}, '[)')`;
const rangeOf = (from: Date, to: Date) =>
  sql`tstzrange(${from.toISOString()}::timestamptz, ${to.toISOString()}::timestamptz, '[)')`;

// ---- Availability ----------------------------------------------------------------

type HoldWindow = { unitId: string; startsAt: Date; cleaningEndsAt: Date };

async function holdWindows(
  tx: Tx,
  tenantId: TenantId,
  unitIds: readonly string[],
  from: Date,
  to: Date,
): Promise<HoldWindow[]> {
  if (unitIds.length === 0) return [];
  return tx
    .select({
      unitId: accessTickets.unitId,
      startsAt: accessTickets.startsAt,
      cleaningEndsAt: accessTickets.cleaningEndsAt,
    })
    .from(accessTickets)
    .where(
      and(
        eq(accessTickets.tenantId, tenantId),
        inArray(accessTickets.unitId, [...unitIds]),
        holdSql,
        lt(accessTickets.startsAt, to),
        gt(accessTickets.cleaningEndsAt, from),
      ),
    );
}

const overlaps = (window: HoldWindow, from: Date, to: Date) =>
  window.startsAt < to && from < window.cleaningEndsAt;

async function queueCounts(
  tx: Tx,
  tenantId: TenantId,
  facilityId: string,
  areaId: string | null,
  now: Date,
) {
  const rows = await tx
    .select({
      status: facilityQueueEntries.status,
      notifiedAt: facilityQueueEntries.notifiedAt,
    })
    .from(facilityQueueEntries)
    .where(
      and(
        eq(facilityQueueEntries.tenantId, tenantId),
        eq(facilityQueueEntries.facilityId, facilityId),
        ...(areaId ? [eq(facilityQueueEntries.areaId, areaId)] : []),
        inArray(facilityQueueEntries.status, ["waiting", "notified"]),
      ),
    );
  return {
    waiting: rows.filter((row) => row.status === "waiting").length,
    // A notified guest past the claim window no longer holds a unit; the
    // sweeper expires the row, until then it must not inflate the estimate.
    notified: rows.filter(
      (row) =>
        row.status === "notified" &&
        (row.notifiedAt === null || row.notifiedAt >= claimCutoff(now)),
    ).length,
  };
}

/**
 * "Masuk sekarang" wait estimate (PRD §3 F22 Pemesanan). Free units are clean
 * units without a hold that overlaps the next session. With a free unit the
 * guests ahead are served in parallel (`estimateWaitMinutes`); with none, the
 * first one waits for the soonest unit to be released (end of its cleaning
 * buffer, or one cleaning cycle for a unit that needs cleaning) and then the
 * queue drains one session per serving unit.
 */
export async function computeWaitEstimate(
  tx: Tx,
  tenantId: TenantId,
  facility: FacilityRow,
  units: readonly UnitRow[],
  areaId: string | null,
  now: Date,
) {
  const turnEnd = new Date(
    now.getTime() +
      (facility.sessionMinutes + facility.cleaningMinutes) * 60_000,
  );
  const serving = units.filter((unit) => unit.status !== "maintenance");
  // Holds up to one more turn ahead, so a unit whose next hold starts before
  // turnEnd is known to be busy until that hold (and its cleaning) ends.
  const windows = await holdWindows(
    tx,
    tenantId,
    serving.map((unit) => unit.id),
    now,
    new Date(turnEnd.getTime() + (turnEnd.getTime() - now.getTime())),
  );
  const free = serving.filter(
    (unit) =>
      unit.status === "available" &&
      !windows.some((w) => w.unitId === unit.id && overlaps(w, now, turnEnd)),
  );
  const queue = await queueCounts(tx, tenantId, facility.id, areaId, now);
  // Notified guests already have a unit reserved in spirit; they use up free units.
  const freeForQueue = Math.max(0, free.length - queue.notified);
  const queueLength = queue.waiting;

  let minutes: number;
  if (serving.length === 0) {
    minutes = 1440;
  } else if (freeForQueue > 0) {
    minutes = estimateWaitMinutes(
      queueLength,
      facility.sessionMinutes,
      freeForQueue,
    );
  } else {
    // Earliest start with a whole turn clear of holds: a unit with a hold
    // that begins before turnEnd is not free now even when no hold covers now.
    const turnMs = turnEnd.getTime() - now.getTime();
    const untilFree = serving.map((unit) => {
      let start =
        now.getTime() +
        (unit.status === "available" ? 0 : facility.cleaningMinutes * 60_000);
      for (;;) {
        const clash = windows.filter(
          (w) =>
            w.unitId === unit.id &&
            w.startsAt.getTime() < start + turnMs &&
            start < w.cleaningEndsAt.getTime(),
        );
        if (clash.length === 0) break;
        start = Math.max(...clash.map((w) => w.cleaningEndsAt.getTime()));
      }
      return Math.max(0, Math.ceil((start - now.getTime()) / 60_000));
    });
    minutes =
      Math.min(...untilFree) +
      estimateWaitMinutes(queueLength, facility.sessionMinutes, serving.length);
  }
  return {
    queueLength: Math.min(queueLength, 1000),
    freeUnitsNow: Math.min(free.length, 1000),
    estimatedWaitMinutes: Math.min(minutes, 1440),
  };
}

export async function getFacilityAvailability(
  context: ScopedTenantContext,
  actorUserId: string,
  query: { facilityId: string; date: string; areaId?: string },
  now = new Date(),
): Promise<FacilityAvailability> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const facility = await loadFacility(tx, context, query.facilityId);
    await assertFacilityPermission(
      tx,
      context,
      actor,
      OPERATE_PERMISSION,
      facility.outletId,
    );
    const timeZone = await outletTimeZone(tx, context, facility.outletId);
    if (query.areaId) {
      const area = await loadArea(tx, context, query.areaId);
      if (area.facilityId !== facility.id)
        throw new HttpError(404, "NOT_FOUND", "Area tidak ditemukan.");
    }
    const areas = await tx
      .select()
      .from(facilityAreas)
      .where(
        and(
          eq(facilityAreas.tenantId, tenantId),
          eq(facilityAreas.facilityId, facility.id),
          ...(query.areaId ? [eq(facilityAreas.id, query.areaId)] : []),
        ),
      )
      .orderBy(asc(facilityAreas.sortOrder), asc(facilityAreas.name));
    const units = await tx
      .select()
      .from(facilityUnits)
      .where(
        and(
          eq(facilityUnits.tenantId, tenantId),
          eq(facilityUnits.facilityId, facility.id),
          // A retired unit is not offered or counted (legend-etawy).
          isNull(facilityUnits.retiredAt),
          ...(query.areaId ? [eq(facilityUnits.areaId, query.areaId)] : []),
        ),
      )
      .orderBy(asc(facilityUnits.sortOrder), asc(facilityUnits.code));

    // The slot grid of the business date, in the outlet time zone. A slot is
    // session + cleaning buffer wide, so neighbouring grid slots never overlap.
    const config = slotConfigSchema.parse({
      sessionMinutes: facility.sessionMinutes,
      cleaningMinutes: facility.cleaningMinutes,
    });
    const [year, month, day] = query.date.split("-").map(Number);
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    // Hours versions are keyed by business date (legend-13j7i, legend-4us1a):
    // slots stay listed under their calendar date, but each one is judged by
    // the version of its own business date (00:00-cutoff belongs to the day
    // before). Start candidates of a version are kept only for slots whose own
    // business date is that version's date, so versions never overlap.
    const clock = await outletClock(tx, tenantId, facility.outletId);
    const versionByDate = new Map<string, typeof facility.operatingHours>();
    for (const date of [addBusinessDays(query.date, -1), query.date])
      versionByDate.set(
        date,
        (await resolveOperatingHoursOn(tx, tenantId, facility.id, date)) ??
          facility.operatingHours,
      );
    const step = config.sessionMinutes + config.cleaningMinutes;
    const gridByStart = new Map<string, FacilitySlot>();
    for (const [versionDate, versionHours] of versionByDate) {
      for (const hours of versionHours) {
        if (!hours.daysOfWeek.includes(weekday)) continue;
        const [oh, om] = hours.opensAt.split(":").map(Number);
        const [ch, cm] = hours.closesAt.split(":").map(Number);
        const closes = ch * 60 + cm;
        for (
          let at = oh * 60 + om;
          at + config.sessionMinutes <= closes;
          at += step
        ) {
          const slot = slotFromStart(
            zonedInstant(query.date, at, timeZone),
            config,
          );
          if (businessDateOf(slot.startsAt, clock) !== versionDate) continue;
          if (gridByStart.has(slot.startsAt)) continue;
          if (slotFitsOperatingHours(slot, versionHours, timeZone))
            gridByStart.set(slot.startsAt, slot);
        }
      }
    }
    const grid: FacilitySlot[] = [...gridByStart.values()].sort(
      (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt),
    );
    const dayStart = zonedInstant(query.date, 0, timeZone);
    const dayEnd = zonedInstant(query.date, 1440, timeZone);
    const windows = await holdWindows(
      tx,
      tenantId,
      units.map((unit) => unit.id),
      new Date(dayStart.getTime() - 12 * 3_600_000),
      dayEnd,
    );

    const result = {
      facilityId: facility.id,
      businessDate: query.date,
      serverTime: now.toISOString(),
      areas: areas.map((area) => ({
        areaId: area.id,
        name: area.name,
        units: units
          .filter((unit) => unit.areaId === area.id)
          .map((unit) => ({
            unitId: unit.id,
            code: unit.code,
            status: unit.status,
            bookable: unitIsBookable(unit.status, unit.retiredAt),
            slots: grid.map((slot) => {
              const from = new Date(slot.startsAt);
              const to = new Date(slot.cleaningEndsAt);
              const available =
                from.getTime() >= now.getTime() &&
                unitAcceptsSlot(unit.status, from, now) &&
                !windows.some(
                  (w) => w.unitId === unit.id && overlaps(w, from, to),
                );
              return { ...slot, available };
            }),
          })),
      })),
      waitEstimate: await computeWaitEstimate(
        tx,
        tenantId,
        facility,
        units,
        query.areaId ?? null,
        now,
      ),
    };
    return facilityAvailabilitySchema.parse(result);
  });
}

// ---- Holds -----------------------------------------------------------------------

export const holdSlotInputSchema = z.strictObject({
  facilityId: uuidSchema,
  areaId: uuidSchema,
  unitId: uuidSchema.optional(),
  timing: bookingTimingSchema,
  productId: uuidSchema,
  customerProfileId: uuidSchema,
  source: entitlementSourceSchema,
  entitlementLedgerId: uuidSchema.optional(),
  issuedOffline: z.boolean().optional(),
  idempotencyKey: idempotencyKeySchema,
  /** Hold length override (POS sale keeps the slot while the bill is paid). */
  holdMinutes: z.number().int().min(1).max(60).optional(),
  /** Acting staff user, when a human triggered the hold (audit actor). */
  actorUserId: uuidSchema.nullable().optional(),
});
export type HoldSlotInput = z.input<typeof holdSlotInputSchema>;

export type HoldSlotResult = { ticket: AccessTicket; replayed: boolean };

/** Request fingerprint: everything that decides the hold except the clock. */
function holdFingerprint(input: z.output<typeof holdSlotInputSchema>): string {
  const canonical = JSON.stringify([
    input.facilityId,
    input.areaId,
    input.unitId ?? null,
    input.timing.kind === "slot" ? input.timing.startsAt : "now",
    input.productId,
    input.customerProfileId,
    input.source,
    input.entitlementLedgerId ?? null,
    input.issuedOffline ?? false,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

async function lockFacilitySlots(tx: Tx, tenantId: string, facilityId: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`facility-slots:${tenantId}:${facilityId}`}, 0))`,
  );
}

/**
 * Holds one unit for a slot (FAC-02, FAC-06). Throws FacilityError
 * SLOT_UNAVAILABLE (overlap, including the cleaning buffer, or past start),
 * UNIT_NOT_BOOKABLE (needs cleaning / maintenance), FACILITY_CLOSED.
 * Idempotent per (tenant, customer, key): the same request returns the same
 * ticket, a different request under the same key is IDEMPOTENCY_KEY_REUSED.
 */
export async function holdFacilitySlot(
  tx: Tx,
  context: ScopedTenantContext,
  rawInput: HoldSlotInput,
  now = new Date(),
): Promise<HoldSlotResult> {
  assertTrustedScopedContext(context);
  const input = holdSlotInputSchema.parse(rawInput);
  const tenantId = context.tenant.tenantId;
  const facility = await loadFacility(tx, context, input.facilityId);
  assertOutletInScope(context.outletScope, facility.outletId);
  const area = await loadArea(tx, context, input.areaId);
  if (area.facilityId !== facility.id)
    throw new HttpError(404, "NOT_FOUND", "Area tidak ditemukan.");

  await lockFacilitySlots(tx, tenantId, facility.id);

  // FAC-02: the exclusion predicate cannot see hold_expires_at, so a lapsed
  // pending_payment hold keeps blocking its unit until it is cancelled. Release
  // this facility's lapsed holds here (under the facility lock) so the slot
  // frees up even when the worker sweep has not run yet.
  const lapsed = await tx
    .select({ id: accessTickets.id })
    .from(accessTickets)
    .where(
      and(
        eq(accessTickets.tenantId, tenantId),
        eq(accessTickets.facilityId, facility.id),
        eq(accessTickets.status, "pending_payment"),
        lt(accessTickets.holdExpiresAt, now),
        posTicketPaymentNotInFlightSql,
      ),
    );
  for (const { id } of lapsed)
    await cancelLapsedHoldUnlessPaying(tx, context, id, now);
  // Same for queue guests who did not claim in time (legend-ke4z): they must
  // not keep the guests behind them waiting.
  await expireStaleQueueNotifications(tx, context, now, facility.id);

  const fingerprint = holdFingerprint(input);
  const [existing] = await tx
    .select()
    .from(accessTickets)
    .where(
      and(
        eq(accessTickets.tenantId, tenantId),
        eq(accessTickets.customerProfileId, input.customerProfileId),
        eq(accessTickets.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (existing) {
    if (existing.requestFingerprint !== fingerprint)
      throw new HttpError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "Kunci idempotensi ini sudah dipakai untuk permintaan lain.",
      );
    return { ticket: toTicket(existing), replayed: true };
  }

  const clock = await outletClock(tx, tenantId, facility.outletId);
  const timeZone = clock.timeZone;
  const config = slotConfigSchema.parse({
    sessionMinutes: facility.sessionMinutes,
    cleaningMinutes: facility.cleaningMinutes,
  });
  const slot = slotFromStart(
    input.timing.kind === "slot" ? input.timing.startsAt : now,
    config,
  );
  const startsAt = new Date(slot.startsAt);
  const endsAt = new Date(slot.endsAt);
  const cleaningEndsAt = new Date(slot.cleaningEndsAt);
  if (input.timing.kind === "slot" && startsAt.getTime() < now.getTime())
    throw new FacilityError("SLOT_UNAVAILABLE");
  // Hours valid on the slot's BUSINESS date (legend-13j7i): a slot after
  // midnight but before the cutoff uses the previous day's version. A later
  // change never reaches back.
  const slotHours =
    (await resolveOperatingHoursOn(
      tx,
      tenantId,
      facility.id,
      businessDateOf(slot.startsAt, clock),
    )) ?? facility.operatingHours;
  if (!slotFitsOperatingHours(slot, slotHours, timeZone))
    throw new FacilityError("FACILITY_CLOSED");

  const candidates = await tx
    .select()
    .from(facilityUnits)
    .where(
      and(
        eq(facilityUnits.tenantId, tenantId),
        eq(facilityUnits.facilityId, facility.id),
        eq(facilityUnits.areaId, area.id),
      ),
    )
    .orderBy(asc(facilityUnits.sortOrder), asc(facilityUnits.code))
    // FAC-06: a concurrent maintenance/unclean flag (FOR UPDATE in
    // updateFacilityUnit) waits for this hold to commit, or this read waits
    // for the flag, so a hold never lands on a unit flagged in parallel.
    .for("share");
  if (input.unitId && !candidates.some((unit) => unit.id === input.unitId))
    throw new HttpError(404, "NOT_FOUND", "Bilik tidak ditemukan di area ini.");

  // Why each unit of the area cannot take the slot: state (FAC-06) or overlap (FAC-02).
  const blocked = new Map<string, "state" | "overlap">();
  const free: UnitRow[] = [];
  for (const unit of candidates) {
    if (!unitAcceptsSlot(unit.status, startsAt, now, unit.retiredAt)) {
      blocked.set(unit.id, "state");
      continue;
    }
    const [clash] = await tx
      .select({ id: accessTickets.id })
      .from(accessTickets)
      .where(
        and(
          eq(accessTickets.tenantId, tenantId),
          eq(accessTickets.unitId, unit.id),
          holdSql,
          sql`${occupiedRange} && ${rangeOf(startsAt, cleaningEndsAt)}`,
        ),
      )
      .limit(1);
    if (clash) blocked.set(unit.id, "overlap");
    else free.push(unit);
  }

  // "Masuk sekarang": guests already waiting in this area go first (FIFO).
  let queued: { id: string; joinedAt: Date } | undefined;
  if (input.timing.kind === "now") {
    const entries = await tx
      .select({
        id: facilityQueueEntries.id,
        customerProfileId: facilityQueueEntries.customerProfileId,
        joinedAt: facilityQueueEntries.joinedAt,
      })
      .from(facilityQueueEntries)
      .where(
        and(
          eq(facilityQueueEntries.tenantId, tenantId),
          eq(facilityQueueEntries.facilityId, facility.id),
          eq(facilityQueueEntries.areaId, area.id),
          inArray(facilityQueueEntries.status, ["waiting", "notified"]),
        ),
      );
    queued = entries.find(
      (entry) => entry.customerProfileId === input.customerProfileId,
    );
    const ahead = entries.filter(
      (entry) =>
        entry.customerProfileId !== input.customerProfileId &&
        (!queued || entry.joinedAt < queued.joinedAt),
    ).length;
    if (free.length > 0 && ahead >= free.length)
      throw new FacilityError("SLOT_UNAVAILABLE");
  }

  const unit = input.unitId
    ? free.find((candidate) => candidate.id === input.unitId)
    : free[0];
  if (!unit) {
    const reasons = input.unitId
      ? [blocked.get(input.unitId)]
      : [...blocked.values()];
    // Overlap wins: the slot is taken. Only when every unit is unclean or
    // under maintenance is the unit state the reason (FAC-06).
    if (reasons.includes("overlap") || reasons.length === 0)
      throw new FacilityError("SLOT_UNAVAILABLE");
    throw new FacilityError("UNIT_NOT_BOOKABLE");
  }

  const id = createUlid(now.getTime());
  const draft = accessTicketSchema.parse({
    id,
    tenantId,
    outletId: facility.outletId,
    facilityId: facility.id,
    areaId: area.id,
    unitId: unit.id,
    customerProfileId: input.customerProfileId,
    productId: input.productId,
    source: input.source,
    entitlementLedgerId: input.entitlementLedgerId ?? null,
    slot,
    graceMinutes: facility.arrivalGraceMinutes,
    addons: [],
    status: "pending_payment",
    issuedOffline: input.issuedOffline ?? false,
    firstOpenedAt: null,
    endedAt: null,
    overtimeMinutes: 0,
    overtimeFeeIdr: 0,
    createdAt: now.toISOString(),
  });

  let row;
  try {
    [row] = await tx
      .insert(accessTickets)
      .values({
        id: draft.id,
        tenantId,
        outletId: facility.outletId,
        facilityId: facility.id,
        areaId: area.id,
        unitId: unit.id,
        customerProfileId: input.customerProfileId,
        productId: input.productId,
        source: input.source,
        entitlementLedgerId: input.entitlementLedgerId ?? null,
        startsAt,
        endsAt,
        cleaningEndsAt,
        graceMinutes: facility.arrivalGraceMinutes,
        addons: [],
        status: "pending_payment",
        issuedOffline: input.issuedOffline ?? false,
        holdExpiresAt: new Date(
          now.getTime() + (input.holdMinutes ?? SLOT_HOLD_TTL_MINUTES) * 60_000,
        ),
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
        createdBy: input.actorUserId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
  } catch (error) {
    if (pgErrorCode(error) === PG_EXCLUSION_VIOLATION)
      throw new FacilityError("SLOT_UNAVAILABLE");
    // Same (customer, key) raced on another facility's lock: same answer as
    // the replay check above.
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION)
      throw new HttpError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "Kunci idempotensi ini sudah dipakai untuk permintaan lain.",
      );
    throw error;
  }

  if (queued) {
    // Status predicate: an entry the sweeper expired between the read above
    // and this write must not be revived; 0 rows rolls the whole claim back.
    const converted = await tx
      .update(facilityQueueEntries)
      .set({ status: "converted", updatedAt: now })
      .where(
        and(
          eq(facilityQueueEntries.tenantId, tenantId),
          eq(facilityQueueEntries.id, queued.id),
          inArray(facilityQueueEntries.status, ["waiting", "notified"]),
        ),
      )
      .returning({ id: facilityQueueEntries.id });
    if (converted.length === 0)
      throw new HttpError(
        409,
        "QUEUE_CLAIM_EXPIRED",
        "Klaim antrean sudah kedaluwarsa.",
      );
  }

  await auditFacility(tx, context, input.actorUserId ?? null, now, {
    action: "access_ticket.hold_created",
    objectType: "access_ticket",
    objectId: row.id,
    outletId: row.outletId,
    before: null,
    after: {
      ticketId: row.id,
      facilityId: row.facilityId,
      areaId: row.areaId,
      unitId: row.unitId,
      status: row.status,
      source: row.source,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      cleaningEndsAt: slot.cleaningEndsAt,
    },
  });
  return { ticket: toTicket(row), replayed: false };
}

/**
 * Releases a hold (cancel): the ticket drops out of the exclusion constraint
 * and the unit's range is free again (FAC-02). Only a hold that is not paid
 * yet may be released here; paid-ticket cancellation and refunds belong to
 * the ticket bead (legend-bzih).
 */
export async function cancelFacilitySlotHold(
  tx: Tx,
  context: ScopedTenantContext,
  ticketId: string,
  actorUserId: string | null,
  now = new Date(),
): Promise<AccessTicket> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const [locked] = await tx
    .select()
    .from(accessTickets)
    .where(
      and(eq(accessTickets.tenantId, tenantId), eq(accessTickets.id, ticketId)),
    )
    .limit(1)
    .for("update");
  if (!locked) throw new HttpError(404, "NOT_FOUND", "Tiket tidak ditemukan.");
  assertOutletInScope(context.outletScope, locked.outletId);
  if (locked.status !== "pending_payment")
    throw new FacilityError("TICKET_TRANSITION_INVALID");
  const status = transitionTicket(locked.status, "cancel");
  const [row] = await tx
    .update(accessTickets)
    .set({ status, updatedAt: now })
    .where(
      and(eq(accessTickets.tenantId, tenantId), eq(accessTickets.id, ticketId)),
    )
    .returning();
  await auditFacility(tx, context, actorUserId, now, {
    action: "access_ticket.hold_released",
    objectType: "access_ticket",
    objectId: row.id,
    outletId: row.outletId,
    before: { ticketId: row.id, status: locked.status },
    after: { ticketId: row.id, status: row.status },
  });
  await notifyNextInQueue(tx, tenantId, row.facilityId, row.areaId, now);
  return toTicket(row);
}

/**
 * Releases one lapsed hold unless a POS payment is in flight on it (936 D). The
 * ticket row is locked first, and the lapsed + not-paying predicate is read
 * again in a NEW statement (own snapshot): a tender that committed while this
 * waited for the lock is seen, so a ticket with money on its bill is never
 * cancelled by the sweeper. True when the hold was released.
 */
async function cancelLapsedHoldUnlessPaying(
  tx: Tx,
  context: ScopedTenantContext,
  ticketId: string,
  now: Date,
): Promise<boolean> {
  const tenantId = context.tenant.tenantId;
  await tx
    .select({ id: accessTickets.id })
    .from(accessTickets)
    .where(
      and(eq(accessTickets.tenantId, tenantId), eq(accessTickets.id, ticketId)),
    )
    .for("update");
  const [still] = await tx
    .select({ id: accessTickets.id })
    .from(accessTickets)
    .where(
      and(
        eq(accessTickets.tenantId, tenantId),
        eq(accessTickets.id, ticketId),
        eq(accessTickets.status, "pending_payment"),
        lt(accessTickets.holdExpiresAt, now),
        posTicketPaymentNotInFlightSql,
      ),
    )
    .limit(1);
  if (!still) return false;
  await cancelFacilitySlotHold(tx, context, ticketId, null, now);
  return true;
}

/** Sweeper: cancels `pending_payment` holds whose TTL passed; returns the ids. */
export async function releaseExpiredSlotHolds(
  tx: Tx,
  context: ScopedTenantContext,
  now = new Date(),
): Promise<string[]> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const expired = await tx
    .select({ id: accessTickets.id })
    .from(accessTickets)
    .where(
      and(
        eq(accessTickets.tenantId, tenantId),
        eq(accessTickets.status, "pending_payment"),
        lt(accessTickets.holdExpiresAt, now),
        posTicketPaymentNotInFlightSql,
      ),
    )
    .for("update", { skipLocked: true });
  const released: string[] = [];
  for (const { id } of expired)
    if (await cancelLapsedHoldUnlessPaying(tx, context, id, now))
      released.push(id);
  return released;
}

/**
 * An `in_use` ticket still open this many minutes after its scheduled
 * `ends_at` is stale (nobody closed it): the sweep ends it (legend-etawy).
 */
export const IN_USE_STALE_AFTER_MINUTES = 120;

/**
 * Sweeper (legend-etawy): ends `in_use` tickets left open past
 * `IN_USE_STALE_AFTER_MINUTES` after their scheduled end. It is the normal
 * "end" outcome without a charge: the ticket becomes `completed` with
 * `ended_at` set, its unit goes `in_use` -> `needs_cleaning`; overtime stays
 * 0 and no linked order is created. Idempotent (only `in_use` tickets are
 * read); scope comes from the RLS context. Returns the released ticket ids.
 */
export async function releaseStaleInUseTickets(
  tx: Tx,
  context: ScopedTenantContext,
  now = new Date(),
): Promise<string[]> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const cutoff = new Date(now.getTime() - IN_USE_STALE_AFTER_MINUTES * 60_000);
  const stale = await tx
    .select()
    .from(accessTickets)
    .where(
      and(
        eq(accessTickets.tenantId, tenantId),
        eq(accessTickets.status, "in_use"),
        lt(accessTickets.endsAt, cutoff),
      ),
    )
    .orderBy(asc(accessTickets.endsAt), asc(accessTickets.id))
    .for("update", { skipLocked: true });
  const released: string[] = [];
  for (const ticket of stale) {
    const status = transitionTicket(ticket.status, "end");
    await tx
      .update(accessTickets)
      // The scheduled end, not `now`: the sweep must not inflate overtime or
      // utilisation metrics with the time nobody closed the ticket.
      .set({ status, endedAt: ticket.endsAt, updatedAt: now })
      .where(
        and(
          eq(accessTickets.tenantId, tenantId),
          eq(accessTickets.id, ticket.id),
          eq(accessTickets.status, "in_use"),
        ),
      );
    const [otherInUse] = await tx
      .select({ id: accessTickets.id })
      .from(accessTickets)
      .where(
        and(
          eq(accessTickets.tenantId, tenantId),
          eq(accessTickets.unitId, ticket.unitId),
          eq(accessTickets.status, "in_use"),
          ne(accessTickets.id, ticket.id),
        ),
      )
      .limit(1);
    const [unit] = await tx
      .select({ status: facilityUnits.status })
      .from(facilityUnits)
      .where(
        and(
          eq(facilityUnits.tenantId, tenantId),
          eq(facilityUnits.id, ticket.unitId),
        ),
      )
      .limit(1)
      .for("update");
    // Another open ticket still holds the unit: leave it `in_use`.
    if (unit?.status === "in_use" && !otherInUse)
      await tx
        .update(facilityUnits)
        .set({ status: transitionUnit(unit.status, "end_session") })
        .where(
          and(
            eq(facilityUnits.tenantId, tenantId),
            eq(facilityUnits.id, ticket.unitId),
          ),
        );
    await auditFacility(tx, context, null, now, {
      action: "access_ticket.stale_released",
      objectType: "access_ticket",
      objectId: ticket.id,
      outletId: ticket.outletId,
      before: { ticketId: ticket.id, status: ticket.status },
      after: { ticketId: ticket.id, status, charged: false },
    });
    released.push(ticket.id);
  }
  return released;
}

/**
 * When a unit frees up, the oldest waiting guest of that area is notified
 * (status `notified`). A notified guest keeps the right to the unit until they
 * book or leave. The push itself is the notification bead's concern.
 */
export async function notifyNextInQueue(
  tx: Tx,
  tenantId: TenantId,
  facilityId: string,
  areaId: string,
  now: Date,
): Promise<string | null> {
  const [next] = await tx
    .select({ id: facilityQueueEntries.id })
    .from(facilityQueueEntries)
    .where(
      and(
        eq(facilityQueueEntries.tenantId, tenantId),
        eq(facilityQueueEntries.facilityId, facilityId),
        eq(facilityQueueEntries.areaId, areaId),
        eq(facilityQueueEntries.status, "waiting"),
      ),
    )
    .orderBy(asc(facilityQueueEntries.joinedAt), asc(facilityQueueEntries.id))
    .limit(1)
    .for("update", { skipLocked: true });
  if (!next) return null;
  await tx
    .update(facilityQueueEntries)
    .set({ status: "notified", notifiedAt: now, updatedAt: now })
    .where(
      and(
        eq(facilityQueueEntries.tenantId, tenantId),
        eq(facilityQueueEntries.id, next.id),
      ),
    );
  return next.id;
}

/**
 * Sweeper (legend-ke4z): a `notified` guest who did not book within
 * `QUEUE_CLAIM_WINDOW_MINUTES` loses the place (status `expired`) and the next
 * waiting guest of that area is notified. `facilityId` narrows the sweep to one
 * facility; every facility is swept under its slot lock (shared with
 * `holdFacilitySlot`), so a sweep and a claim cannot interleave. Returns the
 * expired entry ids.
 */
export async function expireStaleQueueNotifications(
  tx: Tx,
  context: ScopedTenantContext,
  now = new Date(),
  facilityId?: string,
): Promise<string[]> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  if (!facilityId) {
    // Whole-tenant sweep: expire facility by facility so each one runs under
    // its own slot lock (the same lock a claim holds in `holdFacilitySlot`).
    const facilities = await tx
      .selectDistinct({ facilityId: facilityQueueEntries.facilityId })
      .from(facilityQueueEntries)
      .where(
        and(
          eq(facilityQueueEntries.tenantId, tenantId),
          eq(facilityQueueEntries.status, "notified"),
          lt(facilityQueueEntries.notifiedAt, claimCutoff(now)),
        ),
      )
      // Fixed lock order: two sweeps of the same tenant take the facility
      // locks in the same sequence, so they cannot deadlock each other.
      .orderBy(asc(facilityQueueEntries.facilityId));
    const all: string[] = [];
    for (const row of facilities)
      all.push(
        ...(await expireStaleQueueNotifications(
          tx,
          context,
          now,
          row.facilityId,
        )),
      );
    return all;
  }
  // Re-entrant for the same transaction when called from `holdFacilitySlot`.
  await lockFacilitySlots(tx, tenantId, facilityId);
  const stale = await tx
    .select()
    .from(facilityQueueEntries)
    .where(
      and(
        eq(facilityQueueEntries.tenantId, tenantId),
        eq(facilityQueueEntries.status, "notified"),
        lt(facilityQueueEntries.notifiedAt, claimCutoff(now)),
        eq(facilityQueueEntries.facilityId, facilityId),
      ),
    )
    .orderBy(asc(facilityQueueEntries.notifiedAt), asc(facilityQueueEntries.id))
    .for("update", { skipLocked: true });
  const expired: string[] = [];
  for (const entry of stale) {
    assertOutletInScope(context.outletScope, entry.outletId);
    await tx
      .update(facilityQueueEntries)
      .set({ status: "expired", updatedAt: now })
      .where(
        and(
          eq(facilityQueueEntries.tenantId, tenantId),
          eq(facilityQueueEntries.id, entry.id),
        ),
      );
    await auditFacility(tx, context, null, now, {
      action: "facility_queue.claim_expired",
      objectType: "facility_queue_entry",
      objectId: entry.id,
      outletId: entry.outletId,
      before: { id: entry.id, status: entry.status },
      after: { id: entry.id, status: "expired" },
    });
    await notifyNextInQueue(tx, tenantId, entry.facilityId, entry.areaId, now);
    expired.push(entry.id);
  }
  return expired;
}
