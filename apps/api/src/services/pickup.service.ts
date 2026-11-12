// Pickup display feed, call number allocation and the "Panggil" / "Diambil"
// actions (bead legend-mzhr0; PRD v1.7 §3 F12 "Pickup Display"; contract
// @starter/shared/kitchen `pickupDisplaySchema`, `pickupCallSchema`,
// `PICKUP_CALL_TRANSITIONS`; tables legend-aiksz, migration 0168).
//
// - Every query runs on a `withTenant` transaction, so tenant and outlet RLS
//   apply; the path outlet is asserted against the caller's scope as well.
// - Number allocation (`allocatePickupCall`) is MAX+1 per (tenant, outlet,
//   business date) under a transaction advisory lock on that key, so
//   concurrent orders of one outlet serialise and never collide on the unique
//   (tenant, outlet, business_date, number). The same lock covers the unique
//   (tenant, order_id): a repeat for an order returns the existing call.
//   Decisions (legend-aiksz notes):
//     * The stored number is an unbounded sequence 1, 2, 3...; the code shown
//       to the customer is derived from it (`formatPickupCode`): A-001..A-999,
//       B-001..., Z-999, AA-001... An order is never refused because the
//       numbers ran out (founder decision Q51, legend-ggpoe). A number is never
//       reused that day, because a reused code on the wall would call two
//       customers.
//     * A voided order gets no number (409), and a call whose order was voided
//       afterwards leaves the feed and cannot be called or picked up. The row
//       stays (pickup_calls has no void status; numbers are not recycled).
// - The feed shows called numbers only: an `assigned` number is not yet for the
//   customer's eyes, and a `picked_up` one is done. A called number stays past
//   the business-day cutoff until it is picked up (look-back capped, see
//   expo-pickup-window.ts); the day is the outlet's, not the server's.
// - Promotions on the feed are display-safe (title, body, validUntil): active,
//   inside their window, running at this outlet, and not code-gated. A
//   promotion with a code or voucher requirement is never put on a wall.

import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import {
  assertOutletInScope,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  canTransitionPickupCall,
  formatPickupCode,
  isPickupCallRepeat,
  pickupCallBlock,
  pickupCallSchema,
  pickupChannelSchema,
  pickupDisplaySchema,
  pickupPromotionSchema,
  transitionPickupCall,
  type PickupCall,
  type PickupCallAction,
  type PickupDisplay,
} from "@starter/shared/kitchen";
import { withTenant } from "../db/tenant.ts";
import { db } from "../db/index.ts";
import { orders, pickupCalls, promotions } from "../db/schema/index.ts";
import { HttpError } from "../lib/http-error.ts";
import { expoPickupFloorDate } from "./expo-pickup-window.ts";
import { promotionEnabledAtOutlet } from "./crm-promo-outlets.ts";
import { businessDateFor, loadOutlet } from "./pos-order-support.ts";
import type { Tx } from "./permission-resolver.ts";

type CallRow = typeof pickupCalls.$inferSelect;

const PROMOTION_BODY_MAX = 280;

/**
 * Public text of a promotion: the description minus the internal AI action
 * marker (`[ai:<id>]`, ai-action-executors/promotion.ts), the title when empty.
 */
function displayBody(description: string, title: string): string {
  const text = description.replace(/\s*\[ai:[^\]]*\]\s*$/, "").trim();
  return (text || title).slice(0, PROMOTION_BODY_MAX);
}

function toCall(row: CallRow): PickupCall {
  return pickupCallSchema.parse({
    tenantId: row.tenantId,
    outletId: row.outletId,
    id: row.id,
    orderId: row.orderId,
    channel: row.channel,
    number: row.number,
    code: formatPickupCode(row.number),
    businessDate: row.businessDate,
    status: row.status,
    calledAt: row.calledAt?.toISOString() ?? null,
    pickedUpAt: row.pickedUpAt?.toISOString() ?? null,
  });
}

// ---- Number allocation -----------------------------------------------------

/** Advisory only: reading the next code neither reserves nor consumes it. */
export async function readNextPickupCall(
  context: ScopedTenantContext,
  outletId: string,
  now = new Date(),
) {
  const outlet = outletIdSchema.parse(outletId);
  return withTenant(db, context, async (tx) => {
    const outletRow = await loadOutlet(tx, context, outlet);
    const tenantId = context.tenant.tenantId;
    const businessDate = businessDateFor(outletRow, now);
    // Include collected calls and voided orders: a day's numbers are never
    // reused. No lock is needed for a preview; create allocates under its lock.
    const [top] = await tx
      .select({
        max: sql<number | null>`max(${pickupCalls.number})`.mapWith(Number),
      })
      .from(pickupCalls)
      .where(
        and(
          eq(pickupCalls.tenantId, tenantId),
          eq(pickupCalls.outletId, outlet),
          eq(pickupCalls.businessDate, businessDate),
        ),
      );
    const number = (top?.max ?? 0) + 1;
    return { number, code: formatPickupCode(number), businessDate };
  });
}

/**
 * Gives a takeaway or delivery-platform order its daily call number, on the
 * caller's tenant transaction (the order flow calls this inside its own
 * transaction, so the number commits with the order). Idempotent per order.
 */
export async function allocatePickupCall(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
): Promise<PickupCall> {
  const tenantId = context.tenant.tenantId;
  const [order] = await tx
    .select({
      outletId: orders.outletId,
      channel: orders.channel,
      serviceType: orders.serviceType,
      status: orders.status,
      businessDate: orders.businessDate,
    })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)))
    // Shared row lock: a concurrent void waits, so a voided order never gets a number.
    .for("share", { of: orders });
  if (!order) throw new HttpError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
  assertOutletInScope(
    context.outletScope,
    outletIdSchema.parse(order.outletId),
  );
  // The pickup channel is the delivery platform, or `takeaway` / `delivery`
  // (own POS delivery) by service type for any other channel (POS, QR,
  // kiosk...); dine-in gets none.
  const channel = pickupChannelSchema.safeParse(
    order.channel === "gofood" ||
      order.channel === "grabfood" ||
      order.channel === "shopeefood"
      ? order.channel
      : order.serviceType === "takeaway" || order.serviceType === "delivery"
        ? order.serviceType
        : null,
  );
  if (!channel.success)
    throw new HttpError(
      409,
      "PICKUP_CHANNEL_UNSUPPORTED",
      "Pesanan ini tidak memakai nomor panggil.",
    );
  if (order.status === "voided")
    throw new HttpError(
      409,
      "PICKUP_ORDER_VOIDED",
      "Pesanan sudah dibatalkan, nomor panggil tidak dibuat.",
    );

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pickup-number:${tenantId}:${order.outletId}:${order.businessDate}`}, 0))`,
  );

  const [existing] = await tx
    .select()
    .from(pickupCalls)
    .where(
      and(eq(pickupCalls.tenantId, tenantId), eq(pickupCalls.orderId, orderId)),
    );
  if (existing) return toCall(existing);

  const [top] = await tx
    .select({
      max: sql<number | null>`max(${pickupCalls.number})`.mapWith(Number),
    })
    .from(pickupCalls)
    .where(
      and(
        eq(pickupCalls.tenantId, tenantId),
        eq(pickupCalls.outletId, order.outletId),
        eq(pickupCalls.businessDate, order.businessDate),
      ),
    );
  const next = (top?.max ?? 0) + 1;

  const [row] = await tx
    .insert(pickupCalls)
    .values({
      tenantId,
      outletId: order.outletId,
      orderId,
      channel: channel.data,
      number: next,
      businessDate: order.businessDate,
      status: "assigned",
    })
    .returning();
  if (!row) throw new Error("Pickup call insert returned no row");
  return toCall(row);
}

// ---- Feed ------------------------------------------------------------------

export async function readPickupDisplay(
  context: ScopedTenantContext,
  outletId: string,
  now: Date,
): Promise<PickupDisplay> {
  const outlet = outletIdSchema.parse(outletId);
  return withTenant(db, context, async (tx) => {
    const outletRow = await loadOutlet(tx, context, outlet);
    const tenantId = context.tenant.tenantId;
    const today = businessDateFor(outletRow, now);

    const callRows = await tx
      .select({ call: pickupCalls })
      .from(pickupCalls)
      .innerJoin(
        orders,
        and(
          eq(orders.tenantId, pickupCalls.tenantId),
          eq(orders.id, pickupCalls.orderId),
        ),
      )
      .where(
        and(
          eq(pickupCalls.tenantId, tenantId),
          eq(pickupCalls.outletId, outlet),
          // Past the cutoff a called number stays until it is picked up.
          lte(pickupCalls.businessDate, today),
          gte(pickupCalls.businessDate, expoPickupFloorDate(today)),
          // Numbers restart each day: an earlier day's number is hidden once
          // today reuses it, so the wall never shows two of the same number.
          or(
            eq(pickupCalls.businessDate, today),
            sql`NOT EXISTS (SELECT 1 FROM pickup_calls AS today_calls WHERE today_calls.tenant_id = ${pickupCalls.tenantId} AND today_calls.outlet_id = ${pickupCalls.outletId} AND today_calls.business_date = ${today} AND today_calls.number = ${pickupCalls.number})`,
          ),
          eq(pickupCalls.status, "called"),
          sql`${orders.status} <> 'voided'`,
        ),
      )
      .orderBy(desc(pickupCalls.calledAt), asc(pickupCalls.number));

    const promoRows = await tx
      .select({
        id: promotions.id,
        name: promotions.name,
        description: promotions.description,
        endsAt: promotions.endsAt,
        conditions: promotions.conditions,
      })
      .from(promotions)
      .where(
        and(
          eq(promotions.tenantId, tenantId),
          eq(promotions.status, "active"),
          lte(promotions.startsAt, now),
          or(isNull(promotions.endsAt), gt(promotions.endsAt, now)),
          // Used-up quota or budget: checkout refuses it, so the wall must not
          // advertise it (crm-promo-engine).
          or(
            isNull(promotions.quotaTotal),
            lt(promotions.usesTotal, promotions.quotaTotal),
          ),
          or(
            isNull(promotions.budgetIdr),
            lt(promotions.spentIdr, promotions.budgetIdr),
          ),
          isNull(promotions.codeHash),
          eq(promotions.voucherRequired, false),
          promotionEnabledAtOutlet(outlet),
        ),
      )
      .orderBy(
        desc(promotions.priority),
        asc(promotions.name),
        asc(promotions.id),
      );

    return pickupDisplaySchema.parse({
      tenantId,
      outletId: outlet,
      generatedAt: now.toISOString(),
      calls: callRows.map((r) => toCall(r.call)),
      promotions: promoRows
        // A time-window or channel condition depends on the moment and the
        // order, which a wall cannot know: such a promotion is never shown.
        .filter(
          (p) =>
            !p.conditions.some(
              (c) => c.kind === "time_window" || c.kind === "channel",
            ),
        )
        .map((p) =>
          pickupPromotionSchema.parse({
            tenantId,
            outletId: outlet,
            id: p.id,
            title: p.name,
            body: displayBody(p.description, p.name),
            validUntil: p.endsAt?.toISOString() ?? null,
          }),
        ),
    });
  });
}

// ---- Actions ---------------------------------------------------------------

/**
 * "Panggil" (`call`) and "Diambil" (`pickup`) on one number. Follows
 * `PICKUP_CALL_TRANSITIONS`: a repeat answers the call unchanged (first
 * timestamps kept), `pickup` from `assigned` is 409 PICKUP_CALL_NOT_CALLED and
 * `call` from `picked_up` is 409 PICKUP_CALL_CLOSED.
 */
export async function applyPickupAction(
  context: ScopedTenantContext,
  outletId: string,
  callId: string,
  action: PickupCallAction,
  now: Date,
): Promise<PickupCall> {
  const outlet = outletIdSchema.parse(outletId);
  return withTenant(db, context, async (tx) => {
    assertOutletInScope(context.outletScope, outlet);
    const tenantId = context.tenant.tenantId;
    const [row] = await tx
      .select({ call: pickupCalls, orderStatus: orders.status })
      .from(pickupCalls)
      .innerJoin(
        orders,
        and(
          eq(orders.tenantId, pickupCalls.tenantId),
          eq(orders.id, pickupCalls.orderId),
        ),
      )
      .where(
        and(
          eq(pickupCalls.tenantId, tenantId),
          eq(pickupCalls.outletId, outlet),
          eq(pickupCalls.id, callId),
        ),
      )
      .for("update", { of: pickupCalls });
    if (!row)
      throw new HttpError(404, "NOT_FOUND", "Nomor panggil tidak ditemukan.");
    const current = row.call;

    // A repeat answers 200 even if the order was voided afterwards (contract).
    if (
      row.orderStatus === "voided" &&
      !isPickupCallRepeat(current.status, action)
    )
      throw new HttpError(
        409,
        "PICKUP_ORDER_VOIDED",
        "Pesanan sudah dibatalkan, nomor panggil tidak bisa diproses.",
      );

    const block = pickupCallBlock(current.status, action);
    if (block === "PICKUP_CALL_NOT_CALLED")
      throw new HttpError(
        409,
        block,
        "Nomor belum dipanggil, tidak bisa ditandai diambil.",
      );
    if (block === "PICKUP_CALL_CLOSED")
      throw new HttpError(
        409,
        block,
        "Nomor sudah diambil, tidak bisa dipanggil lagi.",
      );
    // pickupCallBlock is null only for a listed transition.
    if (!canTransitionPickupCall(current.status, action))
      throw new Error("Unreachable pickup transition");

    if (isPickupCallRepeat(current.status, action)) return toCall(current);

    const next = transitionPickupCall(current.status, action);
    const [updated] = await tx
      .update(pickupCalls)
      .set({
        status: next,
        ...(action === "call" ? { calledAt: now } : { pickedUpAt: now }),
        updatedAt: now,
      })
      .where(
        and(eq(pickupCalls.tenantId, tenantId), eq(pickupCalls.id, callId)),
      )
      .returning();
    if (!updated) throw new Error("Pickup call update returned no row");
    return toCall(updated);
  });
}
