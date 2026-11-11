// WFC seats, seat reservations and day passes (PRD v1.7 §3 F25/F39, FAC-14;
// bead legend-bz9h). Routes: routes/wfc.routes.ts.
//
// Money rules ("jangan sampai rugi"), each covered by src/test/wfc-seat.test.ts:
// - M1: the price is read from the product row; no input carries a price. The
//   only client amount is `paidIdr` (what the provider captured) and it must
//   equal the stored price exactly, else 409.
// - M2: a refund never exceeds paid - refunded; a fully refunded row answers a
//   second refund with the unchanged row (no-op), so nothing is paid twice.
// - M4: the day-pass entitlement is issued only after payment (this function
//   runs after capture), once per payment reference, and is revoked by every
//   refund (partial too). A pass that was already used cannot be refunded.
// - M5: the exclusion constraint of wfc_seat_reservations (wfc-seat.custom.sql)
//   makes a double booking impossible; the service maps its error to 409.
//
// Writes run inside `withTenant` (RLS scopes rows to the tenant and the
// caller's outlets), re-check the permission on the row's outlet (TEN-03) and
// land an audit entry.
import { and, asc, eq } from "drizzle-orm";
import {
  idr,
  userIdSchema,
  type ScopedTenantContext,
  type z,
} from "@starter/shared/core";
import {
  WFC_MAX_RESERVATION_MINUTES,
  confirmWfcReservationPaidSchema,
  cancelWfcReservationSchema,
  createWfcSeatSchema,
  listWfcSeatsQuerySchema,
  purchaseDayPassSchema,
  refundDayPassSchema,
  refundWfcReservationSchema,
  reserveWfcSeatSchema,
  setWfcProductKindSchema,
  wfcDayPassPurchaseSchema,
  wfcSeatReservationSchema,
  wfcSeatSchema,
  type CancelWfcReservationInput,
  type ConfirmWfcReservationPaidInput,
  type CreateWfcSeatInput,
  type ListWfcSeatsInput,
  type PurchaseDayPassInput,
  type RefundDayPassInput,
  type RefundWfcReservationInput,
  type ReserveWfcSeatInput,
  type SetWfcProductKindInput,
  type WfcDayPassPurchase,
  type WfcProductKind,
  type WfcSeat,
  type WfcSeatReservation,
} from "@starter/shared/wfc";
import { db } from "../db/index.ts";
import { facilityProducts } from "../db/schema/facility.ts";
import { floorZones } from "../db/schema/floor.ts";
import {
  slotLiteral,
  wfcDayPassPurchases,
  wfcSeatReservations,
  wfcSeats,
} from "../db/schema/wfc-seat.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { createOnce } from "./facility-config-guard.ts";
import {
  cancelEntitlementsForSource,
  issueEntitlement,
  localDate,
  operatingDayEndAfter,
} from "./facility-entitlement.service.ts";
import {
  assertFacilityPermission,
  auditFacility,
  CONFIG_PERMISSION,
  loadFacility,
  notFound,
  OPERATE_PERMISSION,
  outletTimeZone,
  PG_EXCLUSION_VIOLATION,
  PG_UNIQUE_VIOLATION,
  pgErrorCode,
  type FacilityRow,
  type Tx,
} from "./facility-shared.ts";

type SeatRow = typeof wfcSeats.$inferSelect;
type ReservationRow = typeof wfcSeatReservations.$inferSelect;
type DayPassRow = typeof wfcDayPassPurchases.$inferSelect;
type ProductRow = typeof facilityProducts.$inferSelect;

/** 23503 = foreign_key_violation (an unknown customer profile). */
const PG_FOREIGN_KEY_VIOLATION = "23503";
const MINUTE = 60_000;

/**
 * Strict contract check: an unknown field (a client supplied `priceIdr`, say)
 * or a malformed value is a 400, never silently used or dropped (M1).
 */
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

function toReservation(row: ReservationRow): WfcSeatReservation {
  return wfcSeatReservationSchema.parse({
    id: row.id,
    outletId: row.outletId,
    seatId: row.seatId,
    productId: row.productId,
    customerProfileId: row.customerProfileId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    status: row.status,
    priceIdr: row.priceIdr,
    paidIdr: row.paidIdr,
    refundedIdr: row.refundedIdr,
    createdAt: row.createdAt.toISOString(),
  });
}

function toDayPass(row: DayPassRow): WfcDayPassPurchase {
  return wfcDayPassPurchaseSchema.parse({
    id: row.id,
    outletId: row.outletId,
    productId: row.productId,
    customerProfileId: row.customerProfileId,
    paymentRef: row.paymentRef,
    status: row.status,
    priceIdr: row.priceIdr,
    paidIdr: row.paidIdr,
    refundedIdr: row.refundedIdr,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  });
}

async function loadSeat(
  tx: Tx,
  context: ScopedTenantContext,
  seatId: string,
): Promise<SeatRow | undefined> {
  const [row] = await tx
    .select()
    .from(wfcSeats)
    .where(
      and(
        eq(wfcSeats.tenantId, context.tenant.tenantId),
        eq(wfcSeats.id, seatId),
      ),
    )
    .limit(1);
  return row;
}

async function loadReservation(
  tx: Tx,
  context: ScopedTenantContext,
  reservationId: string,
  lock = false,
): Promise<ReservationRow | undefined> {
  const query = tx
    .select()
    .from(wfcSeatReservations)
    .where(
      and(
        eq(wfcSeatReservations.tenantId, context.tenant.tenantId),
        eq(wfcSeatReservations.id, reservationId),
      ),
    )
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  return row;
}

async function loadDayPassByRef(
  tx: Tx,
  context: ScopedTenantContext,
  paymentRef: string,
  lock = false,
): Promise<DayPassRow | undefined> {
  const query = tx
    .select()
    .from(wfcDayPassPurchases)
    .where(
      and(
        eq(wfcDayPassPurchases.tenantId, context.tenant.tenantId),
        eq(wfcDayPassPurchases.paymentRef, paymentRef),
      ),
    )
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  return row;
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

/** A live product of a coworking facility carrying the wanted WFC kind (M1 source). */
async function loadWfcProduct(
  tx: Tx,
  context: ScopedTenantContext,
  productId: string,
  kind: WfcProductKind,
  /** Permission check on the facility, run before the product is judged. */
  authorize?: (facility: FacilityRow) => Promise<void>,
): Promise<{ product: ProductRow; facility: FacilityRow }> {
  const product = await loadProductRow(tx, context, productId);
  const facility = await loadFacility(tx, context, product.facilityId);
  await authorize?.(facility);
  if (
    facility.type !== "coworking" ||
    product.type !== "single" ||
    product.wfcKind !== kind
  )
    throw new HttpError(
      409,
      "NOT_WFC_PRODUCT",
      "Produk ini bukan produk WFC yang sesuai.",
    );
  if (!product.isActive)
    throw new HttpError(409, "PRODUCT_INACTIVE", "Produk tidak dijual lagi.");
  return { product, facility };
}

const amountMismatch = () =>
  new HttpError(
    409,
    "AMOUNT_MISMATCH",
    "Jumlah yang dibayar tidak sama dengan harga.",
  );

const slotStarted = () =>
  new HttpError(
    409,
    "SLOT_STARTED",
    "Slot reservasi sudah dimulai atau selesai.",
  );

const refundExceeds = () =>
  new HttpError(
    409,
    "REFUND_EXCEEDS_PAID",
    "Refund melebihi jumlah yang sudah dibayar.",
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
      .select({ id: floorZones.id, outletId: floorZones.outletId })
      .from(floorZones)
      .where(
        and(
          eq(floorZones.tenantId, context.tenant.tenantId),
          eq(floorZones.id, parsed.zoneId),
        ),
      )
      .limit(1);
    // A zone of another outlet is as good as unknown to this outlet's admin.
    if (!zone || zone.outletId !== parsed.outletId) throw notFound("Zona");
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
            status: parsed.status ?? "active",
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
 * Seats of the outlets the caller may operate: RLS hides other tenants and
 * outlets, and an outlet where the caller lacks the booth permission is left
 * out, so a caller without it sees an empty list.
 */
export async function listWfcSeats(
  context: ScopedTenantContext,
  actorUserId: string,
  input: ListWfcSeatsInput,
  _now = new Date(),
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
    const allowed = new Map<string, boolean>();
    for (const outletId of new Set(rows.map((row) => row.outletId))) {
      try {
        await assertFacilityPermission(
          tx,
          context,
          actor,
          OPERATE_PERMISSION,
          outletId,
        );
        allowed.set(outletId, true);
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 403) throw error;
        allowed.set(outletId, false);
      }
    }
    return rows.filter((row) => allowed.get(row.outletId)).map(toSeat);
  });
}

/**
 * Marks a product as a WFC day pass or seat reservation (or clears it). Only a
 * `single` product of a coworking facility is eligible.
 */
export async function setWfcProductKind(
  context: ScopedTenantContext,
  actorUserId: string,
  input: SetWfcProductKindInput,
  now = new Date(),
): Promise<{ productId: string; wfcKind: WfcProductKind | null }> {
  const actor = userIdSchema.parse(actorUserId);
  const parsed = parseInput(setWfcProductKindSchema, input);
  return withTenant(db, context, async (tx) => {
    const product = await loadProductRow(tx, context, parsed.productId);
    const facility = await loadFacility(tx, context, product.facilityId);
    await assertFacilityPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      facility.outletId,
    );
    if (
      parsed.wfcKind !== null &&
      (facility.type !== "coworking" || product.type !== "single")
    )
      throw new HttpError(
        409,
        "NOT_WFC_ELIGIBLE",
        "Hanya produk tunggal fasilitas coworking yang bisa jadi produk WFC.",
      );
    await tx
      .update(facilityProducts)
      .set({ wfcKind: parsed.wfcKind, updatedAt: now })
      .where(
        and(
          eq(facilityProducts.tenantId, context.tenant.tenantId),
          eq(facilityProducts.id, product.id),
        ),
      );
    await auditFacility(tx, context, actor, now, {
      action: "wfc_product_kind.set",
      objectType: "facility_product",
      objectId: product.id,
      outletId: product.outletId,
      before: null,
      after: { id: product.id, status: parsed.wfcKind ?? "none" },
    });
    return { productId: product.id, wfcKind: parsed.wfcKind };
  });
}

// ---- Seat reservations ------------------------------------------------------

/**
 * Holds a seat for a slot as `pending_payment`. The price is the product price
 * at this moment (M1). A slot that overlaps an active hold of the seat answers
 * 409 SEAT_TAKEN (M5).
 */
export async function reserveWfcSeat(
  context: ScopedTenantContext,
  actorUserId: string,
  input: ReserveWfcSeatInput,
  now = new Date(),
): Promise<WfcSeatReservation> {
  const actor = userIdSchema.parse(actorUserId);
  const parsed = parseInput(reserveWfcSeatSchema, input);
  const startsAt = new Date(parsed.startsAt);
  const endsAt = new Date(parsed.endsAt);
  return withTenant(db, context, async (tx) => {
    const seat = await loadSeat(tx, context, parsed.seatId);
    if (!seat) throw notFound("Kursi");
    await assertFacilityPermission(
      tx,
      context,
      actor,
      OPERATE_PERMISSION,
      seat.outletId,
    );
    const { idempotencyKey, ...payload } = parsed;
    return createOnce(tx, context, {
      idempotencyKey,
      payload,
      outletId: seat.outletId,
      resultTable: "wfc_seat_reservations",
      label: "Reservasi",
      load: (id) => loadReservation(tx, context, id),
      map: toReservation,
      create: async () => {
        if (seat.status !== "active")
          throw new HttpError(409, "SEAT_INACTIVE", "Kursi tidak aktif.");
        const minutes = (endsAt.getTime() - startsAt.getTime()) / MINUTE;
        if (
          !(minutes > 0) ||
          minutes > WFC_MAX_RESERVATION_MINUTES ||
          endsAt.getTime() <= now.getTime()
        )
          throw new HttpError(
            422,
            "INVALID_SLOT",
            "Slot reservasi tidak valid.",
          );
        const { product } = await loadWfcProduct(
          tx,
          context,
          parsed.productId,
          "seat_reservation",
        );
        if (product.outletId !== seat.outletId)
          throw new HttpError(
            409,
            "NOT_WFC_PRODUCT",
            "Produk dan kursi berada di outlet berbeda.",
          );
        let row: ReservationRow;
        try {
          [row] = await tx.transaction((savepoint) =>
            savepoint
              .insert(wfcSeatReservations)
              .values({
                tenantId: context.tenant.tenantId,
                outletId: seat.outletId,
                seatId: seat.id,
                productId: product.id,
                customerProfileId: parsed.customerProfileId,
                slot: slotLiteral(startsAt, endsAt),
                status: "pending_payment",
                priceIdr: product.priceIdr,
                paidIdr: idr(0),
                refundedIdr: idr(0),
                createdAt: now,
                updatedAt: now,
              })
              .returning(),
          );
        } catch (error) {
          const code = pgErrorCode(error);
          if (code === PG_EXCLUSION_VIOLATION)
            throw new HttpError(
              409,
              "SEAT_TAKEN",
              "Kursi sudah dipesan pada jam itu.",
            );
          if (code === PG_FOREIGN_KEY_VIOLATION) throw notFound("Pelanggan");
          throw error;
        }
        await auditFacility(tx, context, actor, now, {
          action: "wfc_reservation.created",
          objectType: "wfc_seat_reservation",
          objectId: row.id,
          outletId: row.outletId,
          before: null,
          after: {
            id: row.id,
            status: row.status,
            priceIdr: row.priceIdr,
            startsAt: row.startsAt.toISOString(),
            endsAt: row.endsAt.toISOString(),
          },
        });
        return row;
      },
    });
  });
}

/** Runs one locked state change of a reservation, then audits it. */
async function changeReservation(
  context: ScopedTenantContext,
  actor: string,
  reservationId: string,
  now: Date,
  action: string,
  change: (
    row: ReservationRow,
  ) => Promise<Partial<typeof wfcSeatReservations.$inferInsert> | null>,
  permission: typeof OPERATE_PERMISSION = OPERATE_PERMISSION,
): Promise<WfcSeatReservation> {
  return withTenant(db, context, async (tx) => {
    const row = await loadReservation(tx, context, reservationId, true);
    if (!row) throw notFound("Reservasi");
    await assertFacilityPermission(
      tx,
      context,
      actor,
      permission,
      row.outletId,
    );
    const patch = await change(row);
    if (patch === null) return toReservation(row);
    const [updated] = await tx
      .update(wfcSeatReservations)
      .set({ ...patch, updatedAt: now })
      .where(
        and(
          eq(wfcSeatReservations.tenantId, context.tenant.tenantId),
          eq(wfcSeatReservations.id, row.id),
        ),
      )
      .returning();
    await auditFacility(tx, context, actor, now, {
      action,
      objectType: "wfc_seat_reservation",
      objectId: updated.id,
      outletId: updated.outletId,
      before: { id: row.id, status: row.status },
      after: {
        id: updated.id,
        status: updated.status,
        priceIdr: updated.priceIdr,
      },
    });
    return toReservation(updated);
  });
}

/**
 * Payment captured: `paidIdr` must equal the stored price exactly (M1, M2),
 * else 409 and nothing changes. A replay of the same confirmation is a no-op.
 */
export async function confirmWfcReservationPaid(
  context: ScopedTenantContext,
  actorUserId: string,
  input: ConfirmWfcReservationPaidInput,
  now = new Date(),
): Promise<WfcSeatReservation> {
  const actor = userIdSchema.parse(actorUserId);
  const parsed = parseInput(confirmWfcReservationPaidSchema, input);
  return changeReservation(
    context,
    actor,
    parsed.reservationId,
    now,
    "wfc_reservation.confirmed",
    async (row) => {
      if (row.status === "confirmed" && row.paidIdr === parsed.paidIdr)
        return null;
      if (row.status !== "pending_payment")
        throw new HttpError(
          409,
          "INVALID_STATE",
          "Reservasi tidak menunggu pembayaran.",
        );
      if (parsed.paidIdr !== row.priceIdr) throw amountMismatch();
      return { status: "confirmed", paidIdr: parsed.paidIdr };
    },
  );
}

/**
 * Releases the seat before the slot starts (409 SLOT_STARTED after). Money already paid stays on the row until it is refunded
 * with `refundWfcReservation` (a cancel never pays anything out by itself).
 */
export async function cancelWfcReservation(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CancelWfcReservationInput,
  now = new Date(),
): Promise<WfcSeatReservation> {
  const actor = userIdSchema.parse(actorUserId);
  const parsed = parseInput(cancelWfcReservationSchema, input);
  return changeReservation(
    context,
    actor,
    parsed.reservationId,
    now,
    "wfc_reservation.cancelled",
    async (row) => {
      if (row.status === "cancelled") return null;
      if (row.status !== "pending_payment" && row.status !== "confirmed")
        throw new HttpError(
          409,
          "INVALID_STATE",
          "Reservasi tidak bisa dibatalkan.",
        );
      if (now.getTime() >= row.startsAt.getTime()) throw slotStarted();
      return { status: "cancelled" };
    },
  );
}

/**
 * Refunds part or all of what was paid (M2). Needs the config permission and a
 * slot that has not started (409 SLOT_STARTED); a no_show is not refundable.
 * `refundIdr` may not exceed paid - refunded (409). A fully refunded reservation answers a repeat with the
 * unchanged row. The last rupiah refunded sets the status `refunded`, which
 * frees the seat.
 */
export async function refundWfcReservation(
  context: ScopedTenantContext,
  actorUserId: string,
  input: RefundWfcReservationInput,
  now = new Date(),
): Promise<WfcSeatReservation> {
  const actor = userIdSchema.parse(actorUserId);
  const parsed = parseInput(refundWfcReservationSchema, input);
  return changeReservation(
    context,
    actor,
    parsed.reservationId,
    now,
    "wfc_reservation.refunded",
    async (row) => {
      if (row.status === "refunded") return null;
      if (row.status !== "confirmed" && row.status !== "cancelled")
        throw new HttpError(
          409,
          "NOT_REFUNDABLE",
          "Reservasi ini tidak bisa di-refund.",
        );
      if (now.getTime() >= row.startsAt.getTime()) throw slotStarted();
      const remaining = row.paidIdr - row.refundedIdr;
      if (parsed.refundIdr > remaining) throw refundExceeds();
      const refunded = idr(row.refundedIdr + parsed.refundIdr);
      return {
        refundedIdr: refunded,
        status: refunded === row.paidIdr ? "refunded" : row.status,
      };
    },
    CONFIG_PERMISSION,
  );
}

// ---- Day pass ---------------------------------------------------------------

/**
 * Sells one day pass after the payment was captured. `paidIdr` must equal the
 * product price (M1); `paymentRef` makes the sale idempotent. Issues a
 * 1-session `purchase` entitlement that lapses at the end of the outlet's
 * business day (M4).
 */
export async function purchaseDayPass(
  context: ScopedTenantContext,
  actorUserId: string,
  input: PurchaseDayPassInput,
  now = new Date(),
): Promise<WfcDayPassPurchase> {
  const actor = userIdSchema.parse(actorUserId);
  const parsed = parseInput(purchaseDayPassSchema, input);
  return withTenant(db, context, async (tx) => {
    const { product, facility } = await loadWfcProduct(
      tx,
      context,
      parsed.productId,
      "day_pass",
      (found) =>
        assertFacilityPermission(
          tx,
          context,
          actor,
          OPERATE_PERMISSION,
          found.outletId,
        ),
    );
    const [existing] = await tx
      .select()
      .from(wfcDayPassPurchases)
      .where(
        and(
          eq(wfcDayPassPurchases.tenantId, context.tenant.tenantId),
          eq(wfcDayPassPurchases.paymentRef, parsed.paymentRef),
        ),
      )
      .limit(1);
    if (existing) {
      // Same payment replayed: the first sale answers; anything else is a clash.
      if (
        existing.productId === product.id &&
        existing.customerProfileId === parsed.customerProfileId &&
        existing.paidIdr === parsed.paidIdr
      )
        return toDayPass(existing);
      throw paymentRefReused();
    }
    if (parsed.paidIdr !== product.priceIdr) throw amountMismatch();

    const timeZone = await outletTimeZone(tx, context, facility.outletId);
    const expiresAt = operatingDayEndAfter(
      facility.operatingHours,
      localDate(now, timeZone),
      timeZone,
      now,
    );
    let row: DayPassRow;
    try {
      [row] = await tx.transaction((savepoint) =>
        savepoint
          .insert(wfcDayPassPurchases)
          .values({
            tenantId: context.tenant.tenantId,
            outletId: facility.outletId,
            productId: product.id,
            customerProfileId: parsed.customerProfileId,
            paymentRef: parsed.paymentRef,
            status: "paid",
            priceIdr: product.priceIdr,
            paidIdr: parsed.paidIdr,
            refundedIdr: idr(0),
            expiresAt,
            createdAt: now,
            updatedAt: now,
          })
          .returning(),
      );
    } catch (error) {
      const code = pgErrorCode(error);
      if (code === PG_UNIQUE_VIOLATION) throw paymentRefReused();
      if (code === PG_FOREIGN_KEY_VIOLATION) throw notFound("Pelanggan");
      throw error;
    }
    const issued = await issueEntitlement(tx, context, {
      facilityId: facility.id,
      customerProfileId: parsed.customerProfileId,
      source: "purchase",
      sourceRef: row.id,
      sessions: 1,
      expiresAt,
      paid: true,
      conditionsMet: true,
      occurredAt: now,
    });
    if (issued.status === "rejected")
      throw new HttpError(
        409,
        "ENTITLEMENT_REJECTED",
        "Hak akses day pass tidak bisa diterbitkan.",
      );
    await auditFacility(tx, context, actor, now, {
      action: "wfc_day_pass.purchased",
      objectType: "wfc_day_pass_purchase",
      objectId: row.id,
      outletId: row.outletId,
      before: null,
      after: { id: row.id, status: row.status, priceIdr: row.priceIdr },
    });
    return toDayPass(row);
  });
}

const paymentRefReused = () =>
  new HttpError(
    409,
    "PAYMENT_REF_REUSED",
    "Referensi pembayaran sudah dipakai untuk transaksi lain.",
  );

/**
 * Refunds a day pass (M2, M4). Needs the config permission. The refund may not
 * exceed paid - refunded. Every refund (partial too) revokes the unredeemed
 * entitlement; a pass that was already used (nothing left to revoke) cannot be
 * refunded at all, so the customer is never both served and repaid. A fully refunded pass answers a repeat with
 * the unchanged row.
 */
export async function refundDayPass(
  context: ScopedTenantContext,
  actorUserId: string,
  input: RefundDayPassInput,
  now = new Date(),
): Promise<WfcDayPassPurchase> {
  const actor = userIdSchema.parse(actorUserId);
  const parsed = parseInput(refundDayPassSchema, input);
  return withTenant(db, context, async (tx) => {
    const row = await loadDayPassByRef(tx, context, parsed.paymentRef, true);
    if (!row) throw notFound("Pembelian day pass");
    await assertFacilityPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      row.outletId,
    );
    if (row.status === "refunded") return toDayPass(row);
    const remaining = row.paidIdr - row.refundedIdr;
    if (parsed.refundIdr > remaining) throw refundExceeds();
    const refunded = idr(row.refundedIdr + parsed.refundIdr);
    const full = refunded === row.paidIdr;
    const cancelled = await cancelEntitlementsForSource(tx, context, {
      sourceRef: row.id,
      sourceTypes: ["purchase"],
      reason: "Refund day pass",
      occurredAt: now,
    });
    // Nothing to revoke: the pass was used or has lapsed. Throwing rolls the
    // transaction back, so no money moves.
    if (cancelled.cancelledSessions === 0)
      throw new HttpError(
        409,
        "PASS_ALREADY_USED",
        "Day pass sudah dipakai atau kedaluwarsa, tidak bisa di-refund.",
      );
    const [updated] = await tx
      .update(wfcDayPassPurchases)
      .set({
        refundedIdr: refunded,
        status: full ? "refunded" : row.status,
        updatedAt: now,
      })
      .where(
        and(
          eq(wfcDayPassPurchases.tenantId, context.tenant.tenantId),
          eq(wfcDayPassPurchases.id, row.id),
        ),
      )
      .returning();
    await auditFacility(tx, context, actor, now, {
      action: "wfc_day_pass.refunded",
      objectType: "wfc_day_pass_purchase",
      objectId: updated.id,
      outletId: updated.outletId,
      before: { id: row.id, status: row.status },
      after: { id: updated.id, status: updated.status },
    });
    return toDayPass(updated);
  });
}
