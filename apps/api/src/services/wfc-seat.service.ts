// WFC seats, hourly quota and product split (PRD v1.7 §3 F25/F39, FAC-14; brief
// 1270 card W1, seats from bead legend-bz9h). Configuration only: nothing here
// sells a seat or takes money. The sale (W2) must pass wfc-sales-gate.ts.
//
// - A seat sits in a floor zone marked `is_wfc`; till and reservation tables are
//   never WFC seats.
// - Quota: no cell may exceed the active WFC seats of the outlet. Quota writes
//   and seat switches take one advisory lock per outlet, so neither can slip
//   past the other.
// - Product: price = seat fee + credit, computed here, never sent by a client.
//   Every change leaves the product switched off; switching it on belongs to the
//   price floor (W1b).
//
// Writes run inside `withTenant` (RLS scopes rows to the tenant and the
// caller's outlets), re-check the permission on the row's outlet (TEN-03) and
// land an audit entry.
import { and, asc, count, eq, gt, inArray, max, sql } from "drizzle-orm";
import {
  idr,
  userIdSchema,
  type ScopedTenantContext,
  type z,
} from "@starter/shared/core";
import {
  createWfcSeatSchema,
  listWfcHourlyQuotasQuerySchema,
  listWfcSeatsQuerySchema,
  putWfcHourlyQuotasSchema,
  setWfcProductSchema,
  setWfcSeatStatusSchema,
  WFC_ACTIVE_RESERVATION_STATUSES,
  wfcProductSchema,
  wfcSeatSchema,
  type CreateWfcSeatInput,
  type ListWfcHourlyQuotasInput,
  type ListWfcSeatsInput,
  type PutWfcHourlyQuotasInput,
  type SetWfcProductInput,
  type SetWfcSeatStatusInput,
  type WfcHourlyQuota,
  type WfcProduct,
  type WfcSeat,
} from "@starter/shared/wfc";
import { eqId } from "../db/branded-ids.ts";
import { db } from "../db/index.ts";
import { facilityProducts } from "../db/schema/facility.ts";
import { floorZones } from "../db/schema/floor.ts";
import { wfcSeatReservations, wfcSeats } from "../db/schema/wfc-seat.ts";
import { wfcHourlyQuotas } from "../db/schema/wfc-settings.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { assertConfigFresh, lockConfigRow } from "./facility-config-guard.ts";
import {
  assertFacilityPermission,
  auditFacility,
  CONFIG_PERMISSION,
  loadFacility,
  notFound,
  OPERATE_PERMISSION,
  PG_UNIQUE_VIOLATION,
  pgErrorCode,
  type Tx,
} from "./facility-shared.ts";

type SeatRow = typeof wfcSeats.$inferSelect;
type ProductRow = typeof facilityProducts.$inferSelect;

/** An unknown field or malformed value is a 400, never silently used or dropped. */
function parseInput<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): z.output<Schema> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new HttpError(400, "VALIDATION_FAILED", "Input tidak valid.");
  return result.data;
}

// ---- Mappers and loaders ----------------------------------------------------

function toSeat(row: SeatRow): WfcSeat {
  return wfcSeatSchema.parse({
    id: row.id,
    outletId: row.outletId,
    zoneId: row.zoneId,
    code: row.code,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  });
}

function toWfcProduct(row: ProductRow): WfcProduct {
  return wfcProductSchema.parse({
    productId: row.id,
    outletId: row.outletId,
    priceIdr: row.priceIdr,
    isActive: row.isActive,
    wfc:
      row.wfcKind === null
        ? null
        : {
            kind: row.wfcKind,
            access: row.wfcAccess,
            seatFeeIdr: row.seatFeeIdr,
            creditIdr: row.creditIdr,
            durationMinutes: row.durationMinutes,
          },
    updatedAt: row.updatedAt.toISOString(),
  });
}

async function loadProductRow(
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
  if (!row) throw notFound("Produk");
  return row;
}

/** Serialises quota writes and seat switches of one outlet. */
async function lockOutletSeats(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`legend:wfc-seats:${context.tenant.tenantId}:${outletId}`}, 0))`,
  );
}

/** Active seats of the outlet in zones still marked WFC and active. */
export async function countActiveWfcSeats(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
): Promise<number> {
  const [row] = await tx
    .select({ seats: count() })
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
    );
  return row?.seats ?? 0;
}

const quotaExceedsSeats = () =>
  new HttpError(
    409,
    "QUOTA_EXCEEDS_SEATS",
    "Kuota tidak boleh melebihi jumlah kursi WFC yang aktif.",
  );

// ---- Seats ------------------------------------------------------------------

export async function createWfcSeat(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateWfcSeatInput,
  now = new Date(),
): Promise<WfcSeat> {
  const actor = userIdSchema.parse(actorUserId);
  const parsed = parseInput(createWfcSeatSchema, input);
  return withTenant(db, context, async (tx) => {
    await assertFacilityPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      parsed.outletId,
    );
    const [zone] = await tx
      .select({
        id: floorZones.id,
        outletId: floorZones.outletId,
        isWfc: floorZones.isWfc,
      })
      .from(floorZones)
      .where(
        and(
          eq(floorZones.tenantId, context.tenant.tenantId),
          eqId(floorZones.outletId, parsed.outletId),
          eq(floorZones.id, parsed.zoneId),
        ),
      )
      .limit(1);
    // A zone of another outlet is as good as unknown to this outlet's admin.
    if (!zone) throw notFound("Zona");
    if (!zone.isWfc)
      throw new HttpError(
        409,
        "ZONE_NOT_WFC",
        "Kursi WFC hanya bisa dibuat di zona WFC.",
      );
    let row: SeatRow;
    try {
      [row] = await tx.transaction((savepoint) =>
        savepoint
          .insert(wfcSeats)
          .values({
            tenantId: context.tenant.tenantId,
            outletId: zone.outletId,
            zoneId: zone.id,
            code: parsed.code,
            createdAt: now,
          })
          .returning(),
      );
    } catch (error) {
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION)
        throw new HttpError(
          409,
          "SEAT_CODE_TAKEN",
          "Kode kursi sudah dipakai di zona ini.",
        );
      throw error;
    }
    await auditFacility(tx, context, actor, now, {
      action: "wfc_seat.created",
      objectType: "wfc_seat",
      objectId: row.id,
      outletId: row.outletId,
      before: null,
      after: { id: row.id, outletId: row.outletId, status: row.status },
    });
    return toSeat(row);
  });
}

/**
 * Switches a seat on or off. Off is refused while a live claim still needs the
 * seat (409 SEAT_IN_USE) or a quota cell would exceed the seats left. The row
 * lock waits for a claim being inserted (its FK holds the seat row).
 */
export async function setWfcSeatStatus(
  context: ScopedTenantContext,
  actorUserId: string,
  input: SetWfcSeatStatusInput,
  now = new Date(),
): Promise<WfcSeat> {
  const actor = userIdSchema.parse(actorUserId);
  const parsed = parseInput(setWfcSeatStatusSchema, input);
  return withTenant(db, context, async (tx) => {
    const seatWhere = and(
      eq(wfcSeats.tenantId, context.tenant.tenantId),
      eq(wfcSeats.id, parsed.seatId),
    );
    const [found] = await tx
      .select({ outletId: wfcSeats.outletId })
      .from(wfcSeats)
      .where(seatWhere)
      .limit(1);
    if (!found) throw notFound("Kursi");
    await assertFacilityPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      found.outletId,
    );
    await lockOutletSeats(tx, context, found.outletId);
    const [existing] = await tx
      .select()
      .from(wfcSeats)
      .where(seatWhere)
      .for("update");
    if (!existing) throw notFound("Kursi");
    if (existing.status === parsed.status) return toSeat(existing);
    if (parsed.status === "inactive") {
      const [claim] = await tx
        .select({ id: wfcSeatReservations.id })
        .from(wfcSeatReservations)
        .where(
          and(
            eq(wfcSeatReservations.tenantId, context.tenant.tenantId),
            eq(wfcSeatReservations.seatId, existing.id),
            inArray(wfcSeatReservations.status, [
              ...WFC_ACTIVE_RESERVATION_STATUSES,
            ]),
            gt(wfcSeatReservations.endsAt, now),
          ),
        )
        .limit(1);
      if (claim)
        throw new HttpError(
          409,
          "SEAT_IN_USE",
          "Kursi ini masih dipesan. Selesaikan pesanannya dulu.",
        );
    }
    const [row] = await tx
      .update(wfcSeats)
      .set({ status: parsed.status })
      .where(seatWhere)
      .returning();
    if (parsed.status === "inactive") {
      const [quota] = await tx
        .select({ seats: max(wfcHourlyQuotas.seats) })
        .from(wfcHourlyQuotas)
        .where(
          and(
            eq(wfcHourlyQuotas.tenantId, context.tenant.tenantId),
            eq(wfcHourlyQuotas.outletId, existing.outletId),
          ),
        );
      const seats = await countActiveWfcSeats(tx, context, existing.outletId);
      if ((quota?.seats ?? 0) > seats) throw quotaExceedsSeats();
    }
    await auditFacility(tx, context, actor, now, {
      action: "wfc_seat.status_set",
      objectType: "wfc_seat",
      objectId: row.id,
      outletId: row.outletId,
      before: { id: row.id, status: existing.status },
      after: { id: row.id, status: row.status },
    });
    return toSeat(row);
  });
}

/**
 * Seats of the outlets the caller may operate: RLS hides other tenants and
 * outlets, and an outlet where the caller lacks the booth permission is left
 * out, so a caller without it sees an empty list.
 */
export async function listWfcSeats(
  context: ScopedTenantContext,
  actorUserId: string,
  input: ListWfcSeatsInput,
): Promise<WfcSeat[]> {
  const actor = userIdSchema.parse(actorUserId);
  const parsed = parseInput(listWfcSeatsQuerySchema, input);
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .select()
      .from(wfcSeats)
      .where(
        and(
          eq(wfcSeats.tenantId, context.tenant.tenantId),
          ...(parsed.zoneId ? [eq(wfcSeats.zoneId, parsed.zoneId)] : []),
        ),
      )
      .orderBy(asc(wfcSeats.zoneId), asc(wfcSeats.code));
    const allowed = new Set<string>();
    for (const outletId of new Set(rows.map((row) => row.outletId))) {
      try {
        await assertFacilityPermission(
          tx,
          context,
          actor,
          OPERATE_PERMISSION,
          outletId,
        );
        allowed.add(outletId);
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 403) throw error;
      }
    }
    return rows.filter((row) => allowed.has(row.outletId)).map(toSeat);
  });
}

// ---- Hourly quota -----------------------------------------------------------

/** Every set cell of the outlet's week; a cell not listed is 0. */
async function readQuotas(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
): Promise<WfcHourlyQuota[]> {
  return tx
    .select({
      dayOfWeek: wfcHourlyQuotas.dayOfWeek,
      hour: wfcHourlyQuotas.hour,
      seats: wfcHourlyQuotas.seats,
    })
    .from(wfcHourlyQuotas)
    .where(
      and(
        eq(wfcHourlyQuotas.tenantId, context.tenant.tenantId),
        eqId(wfcHourlyQuotas.outletId, outletId),
      ),
    )
    .orderBy(asc(wfcHourlyQuotas.dayOfWeek), asc(wfcHourlyQuotas.hour));
}

export async function listWfcHourlyQuotas(
  context: ScopedTenantContext,
  actorUserId: string,
  input: ListWfcHourlyQuotasInput,
): Promise<WfcHourlyQuota[]> {
  const actor = userIdSchema.parse(actorUserId);
  const parsed = parseInput(listWfcHourlyQuotasQuerySchema, input);
  return withTenant(db, context, async (tx) => {
    await assertFacilityPermission(
      tx,
      context,
      actor,
      OPERATE_PERMISSION,
      parsed.outletId,
    );
    return readQuotas(tx, context, parsed.outletId);
  });
}

/** Readable audit value of one cell: weekday, hour and seats. */
const quotaLabel = (cell: WfcHourlyQuota) =>
  `${cell.dayOfWeek}/${cell.hour}=${cell.seats}`;

/** Sets the given cells (the others stay); answers every set cell. */
export async function putWfcHourlyQuotas(
  context: ScopedTenantContext,
  actorUserId: string,
  input: PutWfcHourlyQuotasInput,
  now = new Date(),
): Promise<WfcHourlyQuota[]> {
  const actor = userIdSchema.parse(actorUserId);
  const parsed = parseInput(putWfcHourlyQuotasSchema, input);
  return withTenant(db, context, async (tx) => {
    await assertFacilityPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      parsed.outletId,
    );
    await lockOutletSeats(tx, context, parsed.outletId);
    const seats = await countActiveWfcSeats(tx, context, parsed.outletId);
    if (parsed.quotas.some((cell) => cell.seats > seats))
      throw quotaExceedsSeats();
    const before = await readQuotas(tx, context, parsed.outletId);
    await tx
      .insert(wfcHourlyQuotas)
      .values(
        parsed.quotas.map((cell) => ({
          tenantId: context.tenant.tenantId,
          outletId:
            parsed.outletId as typeof wfcHourlyQuotas.$inferInsert.outletId,
          ...cell,
          updatedBy: actor,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [
          wfcHourlyQuotas.tenantId,
          wfcHourlyQuotas.outletId,
          wfcHourlyQuotas.dayOfWeek,
          wfcHourlyQuotas.hour,
        ],
        set: {
          seats: sql`excluded.seats`,
          updatedBy: sql`excluded.updated_by`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
    const after = await readQuotas(tx, context, parsed.outletId);
    await auditFacility(tx, context, actor, now, {
      action: "wfc_quota.set",
      objectType: "outlet",
      objectId: parsed.outletId,
      outletId: parsed.outletId,
      before: { quota: before.map(quotaLabel) },
      after: { quota: after.map(quotaLabel) },
    });
    return after;
  });
}

// ---- Product ----------------------------------------------------------------

/**
 * Sets (or clears) the WFC split of a `single`, till-unlinked product of a
 * coworking facility. The price becomes seat fee + credit and the product is
 * switched off. A product a claim already references keeps its split's kind.
 */
export async function setWfcProduct(
  context: ScopedTenantContext,
  actorUserId: string,
  input: SetWfcProductInput,
  now = new Date(),
): Promise<WfcProduct> {
  const actor = userIdSchema.parse(actorUserId);
  const parsed = parseInput(setWfcProductSchema, input);
  return withTenant(db, context, async (tx) => {
    const found = await loadProductRow(tx, context, parsed.productId);
    await assertFacilityPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      found.outletId,
    );
    await lockConfigRow(tx, "facility_products", context, found.id);
    const existing = await loadProductRow(tx, context, found.id);
    assertConfigFresh(existing.updatedAt, parsed.expectedUpdatedAt);
    const facility = await loadFacility(tx, context, existing.facilityId);
    const { wfc } = parsed;
    if (
      wfc !== null &&
      (facility.type !== "coworking" ||
        existing.type !== "single" ||
        existing.menuItemId !== null ||
        existing.sessions !== 1 ||
        existing.maxPerDay !== null)
    )
      throw new HttpError(
        409,
        "NOT_WFC_ELIGIBLE",
        "Hanya produk tunggal fasilitas coworking tanpa menu kasir yang bisa jadi produk WFC.",
      );
    if (existing.wfcKind !== null && existing.wfcKind !== wfc?.kind) {
      const [claim] = await tx
        .select({ id: wfcSeatReservations.id })
        .from(wfcSeatReservations)
        .where(
          and(
            eq(wfcSeatReservations.tenantId, context.tenant.tenantId),
            eq(wfcSeatReservations.productId, existing.id),
          ),
        )
        .limit(1);
      if (claim)
        throw new HttpError(
          409,
          "WFC_PRODUCT_IN_USE",
          "Produk ini sudah pernah dipesan; jenisnya tidak bisa diubah.",
        );
    }
    const [row] = await tx
      .update(facilityProducts)
      .set({
        ...(wfc !== null && { priceIdr: idr(wfc.seatFeeIdr + wfc.creditIdr) }),
        wfcKind: wfc?.kind ?? null,
        wfcAccess: wfc?.access ?? null,
        seatFeeIdr: wfc === null ? null : idr(wfc.seatFeeIdr),
        creditIdr: wfc === null ? null : idr(wfc.creditIdr),
        durationMinutes: wfc?.durationMinutes ?? null,
        isActive: false,
        updatedAt: now,
      })
      .where(
        and(
          eq(facilityProducts.tenantId, context.tenant.tenantId),
          eq(facilityProducts.id, existing.id),
        ),
      )
      .returning();
    await auditFacility(tx, context, actor, now, {
      action: "wfc_product.set",
      objectType: "facility_product",
      objectId: row.id,
      outletId: row.outletId,
      before: {
        id: existing.id,
        type: existing.wfcKind ?? "none",
        priceIdr: existing.priceIdr,
        seatFeeIdr: existing.seatFeeIdr,
        creditIdr: existing.creditIdr,
        isActive: existing.isActive,
      },
      after: {
        id: row.id,
        type: row.wfcKind ?? "none",
        priceIdr: row.priceIdr,
        seatFeeIdr: row.seatFeeIdr,
        creditIdr: row.creditIdr,
        isActive: row.isActive,
      },
    });
    return toWfcProduct(row);
  });
}
