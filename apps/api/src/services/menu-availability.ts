// Ketersediaan service (bead legend-h2a; PRD v1.7 §8 "Ketersediaan",
// §3 F8): availability schedules (breakfast, happy hour), the daily item limit
// and the 86 state that must reach QR order, POS and the online-food channels.
//
// Three layers share one decision:
//   - `evaluateAvailability` is the pure rule (schedule window in the outlet
//     time zone, 86 deadline, remaining daily quantity) used by every channel
//     read: QR/public menu today, POS/ojol order services (legend-e2x,
//     legend-kk7) next;
//   - `reserveMenuItemDailyLimit` / `releaseMenuItemDailyLimit` keep the
//     per-business-date counter race-safe: one atomic upsert per order line, so
//     concurrent orders cannot oversell the daily stock (ORD-05);
//   - `restoreExpiredSoldOut` lifts an 86 whose `soldOutUntil` passed and
//     broadcasts `item.restored` through the outbox. The sweep runs from the
//     availability list (the staff 86 board observes the deadline), so channels
//     learn about the restore without waiting for an operator.
//
// The 86 broadcast itself is the transactional outbox (`item.sold_out` /
// `item.restored` from menu-pricing.service.ts); no side effect happens outside
// the transaction that changed the row.

import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  businessDateSchema,
  CoreError,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  itemRestoredEvent,
  type Availability,
  type MenuSchedule,
} from "@starter/shared/menu";
import { itemAvailability, menuItemDailyUsage, outlets } from "../db/schema";
import { withTenant } from "../db/tenant";
import { db } from "../db";
import {
  appendMenuEvent,
  assertOutletPermission,
  resolveOutlet,
  type Tx,
} from "./menu-internals";

/** The availability toggle permission owns every availability write. */
export const AVAILABILITY_TOGGLE_PERMISSION =
  "menu.availability.toggle" as const;

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** `HH:mm` or `HH:mm:ss` -> minutes since midnight. */
export function minutesOfDay(hm: string): number {
  const [hours, minutes] = hm.split(":").map(Number);
  return hours * 60 + minutes;
}

export type WallClock = { weekday: number; minutes: number };

/**
 * Local weekday and minute of the outlet's wall clock (PRD §8 schedules are
 * opening-hours rules, so they follow the outlet time zone, not the server's).
 */
export function wallClockAt(at: Date, timeZone: string): WallClock | null {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: string) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  const weekday = WEEKDAY_INDEX[part("weekday")];
  if (weekday === undefined) return null;
  return {
    weekday,
    minutes: Number(part("hour")) * 60 + Number(part("minute")),
  };
}

/**
 * Is `at` inside one of the windows? A window whose `end` is not after `start`
 * crosses midnight and belongs to its `daysOfWeek` start day; `start === end`
 * is a full day. `emptyMeans` states the caller's policy for "no windows"
 * (availability: no schedule restriction = open; zone hours: never open).
 */
export function withinWindows(
  windows: readonly MenuSchedule[],
  at: Date,
  timeZone: string,
  emptyMeans: "open" | "closed",
): boolean {
  if (windows.length === 0) return emptyMeans === "open";
  const clock = wallClockAt(at, timeZone);
  if (!clock) return false;
  const previousDay = (clock.weekday + 6) % 7;
  return windows.some((window) => {
    const start = minutesOfDay(window.start);
    const end = minutesOfDay(window.end);
    if (start === end) return window.daysOfWeek.includes(clock.weekday);
    if (start < end)
      return (
        window.daysOfWeek.includes(clock.weekday) &&
        clock.minutes >= start &&
        clock.minutes < end
      );
    // Overnight window, e.g. 22:00-02:00 on Friday: Saturday 01:00 is inside
    // Friday's window.
    return (
      (window.daysOfWeek.includes(clock.weekday) && clock.minutes >= start) ||
      (window.daysOfWeek.includes(previousDay) && clock.minutes < end)
    );
  });
}

export type AvailabilityReason =
  "available" | "sold_out" | "outside_schedule" | "daily_limit";

export type AvailabilityDecision = {
  /** False means the item cannot be added to an order right now (ORD-05). */
  sellable: boolean;
  reason: AvailabilityReason;
  /** The 86 still holds: `sold_out` without a deadline, or before it. */
  soldOut: boolean;
  withinSchedule: boolean;
  dailyLimit: number | null;
  soldToday: number;
  /** Units left today; null when no daily limit is configured. */
  remaining: number | null;
};

/**
 * The one availability rule (PRD §8 "Ketersediaan"): an item sells when it is
 * not 86'd, its schedule window includes `at`, and today's counter is below the
 * daily limit. A passed `soldOutUntil` already lifts the 86 — the stored row
 * may still say `sold_out` until the sweep persists it.
 */
export function evaluateAvailability(input: {
  status: Availability["status"];
  soldOutUntil: Date | null;
  schedule: readonly MenuSchedule[];
  dailyLimit: number | null;
  soldToday: number;
  at: Date;
  timeZone: string;
}): AvailabilityDecision {
  const soldOut =
    input.status === "sold_out" &&
    (input.soldOutUntil === null ||
      input.soldOutUntil.getTime() > input.at.getTime());
  const withinSchedule = withinWindows(
    input.schedule,
    input.at,
    input.timeZone,
    "open",
  );
  const soldToday = Math.max(0, input.soldToday);
  const remaining =
    input.dailyLimit === null
      ? null
      : Math.max(0, input.dailyLimit - soldToday);
  const reason: AvailabilityReason = soldOut
    ? "sold_out"
    : !withinSchedule
      ? "outside_schedule"
      : remaining !== null && remaining <= 0
        ? "daily_limit"
        : "available";
  return {
    sellable: reason === "available",
    reason,
    soldOut,
    withinSchedule,
    dailyLimit: input.dailyLimit,
    soldToday,
    remaining,
  };
}

/** Sold quantities per item for one outlet business date. */
export async function readDailyUsage(
  tx: Tx,
  tenantId: string,
  outletId: string,
  businessDate: string,
  itemIds: readonly string[],
): Promise<Map<string, { quantity: number; updatedAt: Date }>> {
  if (itemIds.length === 0) return new Map();
  const rows = await tx
    .select({
      menuItemId: menuItemDailyUsage.menuItemId,
      quantity: menuItemDailyUsage.quantity,
      updatedAt: menuItemDailyUsage.updatedAt,
    })
    .from(menuItemDailyUsage)
    .where(
      and(
        eq(menuItemDailyUsage.tenantId, tenantId),
        eq(menuItemDailyUsage.outletId, outletId),
        eq(menuItemDailyUsage.businessDate, businessDate),
        inArray(menuItemDailyUsage.menuItemId, [...itemIds]),
      ),
    );
  return new Map(
    rows.map((row) => [
      row.menuItemId,
      { quantity: row.quantity, updatedAt: row.updatedAt },
    ]),
  );
}

/**
 * Decisions for every item of one outlet that has an availability row. Items
 * without a row have no schedule, no limit and no 86 — the caller treats them
 * as available (the CRUD seeds a row per outlet, so this is the legacy case).
 */
export async function readAvailabilityDecisions(
  tx: Tx,
  input: {
    tenantId: string;
    outletId: string;
    itemIds: readonly string[];
    at: Date;
    timeZone: string;
    businessDate: string;
  },
): Promise<Map<string, AvailabilityDecision & { updatedAt: Date }>> {
  if (input.itemIds.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(itemAvailability)
    .where(
      and(
        eq(itemAvailability.tenantId, input.tenantId),
        eq(itemAvailability.outletId, input.outletId),
        inArray(itemAvailability.menuItemId, [...input.itemIds]),
        isNull(itemAvailability.deletedAt),
      ),
    );
  const usage = await readDailyUsage(
    tx,
    input.tenantId,
    input.outletId,
    input.businessDate,
    input.itemIds,
  );
  const decisions = new Map<
    string,
    AvailabilityDecision & { updatedAt: Date }
  >();
  for (const row of rows) {
    const used = usage.get(row.menuItemId);
    decisions.set(row.menuItemId, {
      ...evaluateAvailability({
        status: row.status,
        soldOutUntil: row.soldOutUntil,
        schedule: row.schedule,
        dailyLimit: row.dailyLimit,
        soldToday: used?.quantity ?? 0,
        at: input.at,
        timeZone: input.timeZone,
      }),
      // A daily-limit change moves the read-model stamp too, not only a
      // schedule or status edit on the availability row.
      updatedAt:
        used && used.updatedAt > row.updatedAt ? used.updatedAt : row.updatedAt,
    });
  }
  return decisions;
}

export type DailyLimitReservation = {
  allowed: boolean;
  /** Why the reservation was refused; `daily_limit` when the counter is full. */
  reason: AvailabilityReason;
  /** The 86-board limit the reservation was weighed against. */
  dailyLimit: number | null;
  soldToday: number;
  remaining: number | null;
};

/**
 * Reserves `quantity` units of one item for one business date — the ORD-05
 * enforcement point for every order path (QR, POS, ojol).
 *
 * The 86 state and the schedule window are re-checked here inside the caller's
 * transaction, so an order can never add an item the guest menu already marks
 * unavailable. The counter itself moves through a single
 * `INSERT ... ON CONFLICT DO UPDATE ... WHERE used + qty <= limit` statement, so
 * two concurrent orders can never both pass the last unit; a denied reservation
 * writes nothing. Items without an availability row or without a daily limit
 * are unlimited but still counted, so enabling a limit mid-day sees today's
 * sales.
 *
 * No permission is asserted: the caller's own gate (guest token, cashier role)
 * owns who may order, and the tenant/outlet policy still applies through RLS.
 */
export async function reserveMenuItemDailyLimit(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    outletId: string;
    menuItemId: string;
    businessDate: string;
    quantity: number;
    now?: Date;
  },
): Promise<DailyLimitReservation> {
  const businessDate = businessDateSchema.parse(input.businessDate);
  if (!Number.isInteger(input.quantity) || input.quantity < 1)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Jumlah item harus bilangan bulat positif.",
    );
  const now = input.now ?? new Date();
  const [availability] = await tx
    .select({
      status: itemAvailability.status,
      schedule: itemAvailability.schedule,
      soldOutUntil: itemAvailability.soldOutUntil,
      dailyLimit: itemAvailability.dailyLimit,
    })
    .from(itemAvailability)
    .where(
      and(
        eq(itemAvailability.tenantId, context.tenant.tenantId),
        eq(itemAvailability.outletId, input.outletId),
        eq(itemAvailability.menuItemId, input.menuItemId),
        isNull(itemAvailability.deletedAt),
      ),
    );
  const dailyLimit = availability?.dailyLimit ?? null;
  const soldToday = await readCurrentQuantity(tx, context, input, businessDate);
  if (availability) {
    const [outlet] = await tx
      .select({ timezone: outlets.timezone })
      .from(outlets)
      .where(
        and(
          eq(outlets.tenantId, context.tenant.tenantId),
          eq(outlets.id, input.outletId),
        ),
      );
    if (!outlet) throw new CoreError("NOT_FOUND", "Outlet tidak ditemukan.");
    const decision = evaluateAvailability({
      status: availability.status,
      soldOutUntil: availability.soldOutUntil,
      schedule: availability.schedule,
      dailyLimit,
      soldToday,
      at: now,
      timeZone: outlet.timezone,
    });
    if (!decision.sellable)
      return {
        allowed: false,
        reason: decision.reason,
        dailyLimit,
        soldToday,
        remaining: decision.remaining,
      };
  }

  // A quantity larger than what is left can never be satisfied; refusing it up
  // front also covers the insert path, which cannot carry a WHERE clause.
  if (dailyLimit !== null && input.quantity > dailyLimit - soldToday)
    return {
      allowed: false,
      reason: "daily_limit",
      dailyLimit,
      soldToday,
      remaining: Math.max(0, dailyLimit - soldToday),
    };

  const [row] = await tx
    .insert(menuItemDailyUsage)
    .values({
      tenantId: context.tenant.tenantId,
      outletId: input.outletId,
      menuItemId: input.menuItemId,
      businessDate,
      quantity: input.quantity,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        menuItemDailyUsage.tenantId,
        menuItemDailyUsage.outletId,
        menuItemDailyUsage.menuItemId,
        menuItemDailyUsage.businessDate,
      ],
      set: {
        quantity: sql`${menuItemDailyUsage.quantity} + ${input.quantity}`,
        updatedAt: now,
      },
      setWhere:
        dailyLimit === null
          ? undefined
          : sql`${menuItemDailyUsage.quantity} + ${input.quantity} <= ${dailyLimit}`,
    })
    .returning({ quantity: menuItemDailyUsage.quantity });
  if (!row)
    return {
      allowed: false,
      reason: "daily_limit",
      dailyLimit,
      soldToday: dailyLimit ?? soldToday,
      remaining: 0,
    };
  return {
    allowed: true,
    reason: "available",
    dailyLimit,
    soldToday: row.quantity,
    remaining:
      dailyLimit === null ? null : Math.max(0, dailyLimit - row.quantity),
  };
}

async function readCurrentQuantity(
  tx: Tx,
  context: ScopedTenantContext,
  input: { outletId: string; menuItemId: string },
  businessDate: string,
): Promise<number> {
  const [row] = await tx
    .select({ quantity: menuItemDailyUsage.quantity })
    .from(menuItemDailyUsage)
    .where(
      and(
        eq(menuItemDailyUsage.tenantId, context.tenant.tenantId),
        eq(menuItemDailyUsage.outletId, input.outletId),
        eq(menuItemDailyUsage.menuItemId, input.menuItemId),
        eq(menuItemDailyUsage.businessDate, businessDate),
      ),
    );
  return row?.quantity ?? 0;
}

/** Gives reserved units back (void, cancellation, refund). Never below zero. */
export async function releaseMenuItemDailyLimit(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    outletId: string;
    menuItemId: string;
    businessDate: string;
    quantity: number;
    now?: Date;
  },
): Promise<number> {
  const businessDate = businessDateSchema.parse(input.businessDate);
  if (!Number.isInteger(input.quantity) || input.quantity < 1)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Jumlah item harus bilangan bulat positif.",
    );
  const [row] = await tx
    .update(menuItemDailyUsage)
    .set({
      quantity: sql`GREATEST(${menuItemDailyUsage.quantity} - ${input.quantity}, 0)`,
      updatedAt: input.now ?? new Date(),
    })
    .where(
      and(
        eq(menuItemDailyUsage.tenantId, context.tenant.tenantId),
        eq(menuItemDailyUsage.outletId, input.outletId),
        eq(menuItemDailyUsage.menuItemId, input.menuItemId),
        eq(menuItemDailyUsage.businessDate, businessDate),
      ),
    )
    .returning({ quantity: menuItemDailyUsage.quantity });
  return row?.quantity ?? 0;
}

/**
 * Persists the end of an 86 whose `soldOutUntil` passed and broadcasts
 * `item.restored` in the same transaction (PRD §8 "langsung tersiar"). Reads
 * already treat a passed deadline as available, so this only reconciles the
 * stored row and the channel sync; running it twice restores nothing the
 * second time.
 */
export async function restoreExpiredSoldOut(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    actorUserId: string;
    now: Date;
    outletIds?: readonly string[];
  },
): Promise<number> {
  const rows = await tx
    .select()
    .from(itemAvailability)
    .where(
      and(
        eq(itemAvailability.tenantId, context.tenant.tenantId),
        eq(itemAvailability.status, "sold_out"),
        lte(itemAvailability.soldOutUntil, input.now),
        isNull(itemAvailability.deletedAt),
        input.outletIds === undefined
          ? undefined
          : inArray(itemAvailability.outletId, [...input.outletIds]),
      ),
    )
    .for("update", { skipLocked: true });
  for (const row of rows) {
    await tx
      .update(itemAvailability)
      .set({ status: "available", soldOutUntil: null, updatedAt: input.now })
      .where(
        and(
          eq(itemAvailability.tenantId, context.tenant.tenantId),
          eq(itemAvailability.id, row.id),
        ),
      );
    await appendMenuEvent(tx, context, itemRestoredEvent, {
      aggregateId: row.id,
      actorUserId: input.actorUserId,
      payload: {
        itemId: row.menuItemId,
        availabilityId: row.id,
        outletId: row.outletId,
      },
      affects: { kind: "outlet", outletId: row.outletId },
      now: input.now,
    });
  }
  return rows.length;
}

/**
 * Staff entry for the sweep (the availability list calls it inside its own
 * transaction after the permission check). Kept separate so a worker can run
 * the same code per tenant later without a request.
 */
export async function sweepExpiredSoldOut(
  context: ScopedTenantContext,
  actorUserId: string,
  input: { outletId?: string; now?: Date } = {},
): Promise<{ restored: number }> {
  const now = input.now ?? new Date();
  return withTenant(db, context, async (tx) => {
    const outletId = await resolveOutlet(tx, context, input.outletId);
    await assertOutletPermission(
      tx,
      context,
      actorUserId,
      AVAILABILITY_TOGGLE_PERMISSION,
      outletId,
      now,
    );
    const restored = await restoreExpiredSoldOut(tx, context, {
      actorUserId,
      now,
      outletIds: [outletId],
    });
    return { restored };
  });
}
