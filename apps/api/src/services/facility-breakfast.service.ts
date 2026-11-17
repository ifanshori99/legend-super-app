// Breakfast order from an access ticket (bead oa0qk; owner Q43: the ticket's
// breakfast MUST be paid before it reaches the kitchen / KDS; PRD v1.7 §3 F22
// "Sarapan Siap Saat Keluar Shower", FAC-10). Member and staff entry points
// behind routes/facility-breakfast.routes.ts.
//
// - create: prices the lines on the server (outlet price list, tax and service
//   by the POS engine), writes an `orders` row of channel `facility` (pay_first,
//   `awaiting_payment`, items `held`, no `pos_orders` row) and its
//   `facility_linked_orders` row. The ticket row is locked first, so one ticket
//   holds one live order and a key replay finds the earlier order.
// - pay: opens the WS-05 payment link once (sealed token on the order, reused
//   after). It never marks anything paid; only the verified `payment.paid`
//   event does (facility-breakfast-consumers.ts).
// - cancel / fire: open the tenant transaction, lock order -> linked row and
//   hand over to facility-breakfast-money.ts (the one place that moves money
//   or reaches the kitchen).
// The idempotency key of pay / cancel / fire is validated by the route schema;
// those calls are idempotent by the status machine plus the row locks.
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  CoreError,
  createUlid,
  idr,
  ulidSchema,
  uuidSchema,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  BREAKFAST_MAX_QUANTITY,
  FacilityError,
  breakfastCancelResultSchema,
  breakfastMenuSchema,
  breakfastOrderSchema,
  breakfastPaymentSchema,
  type BreakfastCancelResult,
  type BreakfastDelivery,
  type BreakfastMenu,
  type BreakfastOrder,
  type BreakfastPayment,
  type CreateBreakfastOrderBody,
} from "@starter/shared/facility";
import { orderNetSubtotalIdr } from "@starter/shared/tax";
import { db } from "../db/index.ts";
import { accessTickets, facilityLinkedOrders } from "../db/schema/facility.ts";
import { floorZones, tables } from "../db/schema/floor.ts";
import { menuCategories, menuItems } from "../db/schema/index.ts";
import { orderItems, orders } from "../db/schema/qr-order.ts";
import { withTenant } from "../db/tenant.ts";
import { openSecret, sealSecret } from "../lib/secrets.ts";
import {
  assertFacilityPermission,
  auditFacility,
  notFound,
  OPERATE_PERMISSION,
  type Tx,
} from "./facility-shared.ts";
import {
  assertBreakfastLinkHoldsNoMoney,
  breakfastLines,
  cancelBreakfastOrderTx,
  confirmBreakfastLinkUnpaid,
  DEAD_TICKET_STATUSES,
  fireBreakfastOrderTx,
  lockBreakfastOrder,
  lockBreakfastPayLink,
  type BreakfastLinkedRow,
  type BreakfastOrderRow,
} from "./facility-breakfast-money.ts";
import { reserveMenuItemDailyLimit } from "./menu-availability.ts";
import { computeLineCostSnapshots } from "./order-cost-snapshot.service.ts";
import { operationsFingerprint } from "./operations-idempotency.ts";
import { createPaymentLink } from "./payment.service.ts";
import { assertBusinessDayOpen } from "./pos-cash-guard.ts";
import {
  computePosBill,
  loadPosCatalogue,
  loadPosTaxConfig,
  posPriceChannel,
  resolveLine,
} from "./pos-order-pricing.ts";
import { businessDateFor, loadOutlet } from "./pos-order-support.ts";

/** Minutes before the session ends that the kitchen is fed (menu prep time). */
// TODO(oa0qk): make this a facility setting; a constant until the owner asks.
export const BREAKFAST_FIRE_OFFSET_MINUTES = 15;

/** Most dishes the guest can browse in one menu response. */
const MENU_LIMIT = 200;

const MINUTE_MS = 60_000;
const LINK_CREATED_BY = "system:facility-breakfast";
const ORDERABLE_TICKET_STATUSES = ["issued", "in_use"] as const;

type TicketRow = typeof accessTickets.$inferSelect;
export type BreakfastMember = { customerProfileId: string };

function linkSealAad(tenantId: string, orderId: string): string {
  return `facility-breakfast-payment-link:${tenantId}:${orderId}`;
}

const fireAtOf = (ticket: TicketRow, offsetMinutes: number): Date =>
  new Date(ticket.endsAt.getTime() - offsetMinutes * MINUTE_MS);

// ---- Reads and DTO ----------------------------------------------------------

/** A ticket of this member, or 404 (a stranger never learns it exists). */
async function loadOwnTicket(
  tx: Tx,
  context: ScopedTenantContext,
  member: BreakfastMember,
  ticketId: string,
  lock: boolean,
): Promise<TicketRow> {
  if (!ulidSchema.safeParse(ticketId).success) throw notFound("Tiket");
  const query = tx
    .select()
    .from(accessTickets)
    .where(
      and(
        eq(accessTickets.tenantId, context.tenant.tenantId),
        eq(accessTickets.id, ticketId),
        eq(accessTickets.customerProfileId, member.customerProfileId),
      ),
    );
  const [ticket] = await (lock ? query.for("update") : query);
  if (!ticket) throw notFound("Tiket");
  return ticket;
}

/** The order DTO of a locked or freshly written linked row. */
async function toBreakfastOrder(
  tx: Tx,
  context: ScopedTenantContext,
  linked: BreakfastLinkedRow,
): Promise<BreakfastOrder> {
  const tenantId = context.tenant.tenantId;
  const [order] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, linked.orderId)));
  if (!order) throw new Error("Breakfast linked order has no order row");
  const items = await breakfastLines(tx, tenantId, [order.id]);
  return breakfastOrderSchema.parse({
    id: order.id,
    ticketId: linked.accessTicketId,
    status: linked.status,
    lines: items.map((item) => ({
      menuItemId: item.menuItemId,
      name: item.name,
      quantity: item.quantity,
      unitPriceIdr: item.unitPriceIdr,
    })),
    delivery: linked.delivery,
    subtotalIdr: linked.subtotalIdr,
    totalIdr: linked.totalIdr,
    fireOffsetMinutes: linked.fireOffsetMinutes,
    fireAt: linked.fireAt.toISOString(),
    paidAt: linked.paidAt?.toISOString() ?? null,
    firedAt: linked.firedAt?.toISOString() ?? null,
  });
}

/** The ticket's order: a live one first, else the latest cancelled one. */
async function currentLinked(
  tx: Tx,
  context: ScopedTenantContext,
  ticketId: string,
): Promise<BreakfastLinkedRow | null> {
  const [row] = await tx
    .select()
    .from(facilityLinkedOrders)
    .where(
      and(
        eq(facilityLinkedOrders.tenantId, context.tenant.tenantId),
        eq(facilityLinkedOrders.accessTicketId, ticketId),
      ),
    )
    .orderBy(
      sql`(${facilityLinkedOrders.status} = 'cancelled')`,
      desc(facilityLinkedOrders.createdAt),
    )
    .limit(1);
  return row ?? null;
}

// ---- Menu -------------------------------------------------------------------

/**
 * legend-lgyfh fallback rule, shared by the menu and the order path: an outlet
 * that has flagged no item `is_breakfast` (active, not deleted, same tenant and
 * brand as the breakfast menu) keeps the old behaviour (every item the flow
 * offered, none refused for being unflagged). From the first flagged item on,
 * only flagged items are listed and orderable.
 */
async function outletUsesBreakfastFlag(
  tx: Tx,
  tenantId: string,
  brandId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: menuItems.id })
    .from(menuItems)
    .where(
      and(
        eq(menuItems.tenantId, tenantId),
        eq(menuItems.brandId, brandId),
        eq(menuItems.isActive, true),
        eq(menuItems.isBreakfast, true),
        isNull(menuItems.deletedAt),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export async function getBreakfastMenuForMember(
  context: ScopedTenantContext,
  member: BreakfastMember,
  ticketId: string,
  now = new Date(),
): Promise<BreakfastMenu> {
  return withTenant(db, context, async (tx) => {
    const ticket = await loadOwnTicket(tx, context, member, ticketId, false);
    const tenantId = context.tenant.tenantId;
    const outlet = await loadOutlet(tx, context, ticket.outletId as OutletId);
    // legend-lgyfh: once an item is flagged `is_breakfast` only flagged items
    // are offered (priced on the dine-in list); with none flagged the old menu
    // stays (see outletUsesBreakfastFlag).
    const flagOnly = await outletUsesBreakfastFlag(
      tx,
      tenantId,
      outlet.brandId,
    );
    const candidates = await tx
      .select({ id: menuItems.id })
      .from(menuItems)
      .innerJoin(
        menuCategories,
        and(
          eq(menuCategories.tenantId, menuItems.tenantId),
          eq(menuCategories.id, menuItems.categoryId),
        ),
      )
      .where(
        and(
          eq(menuItems.tenantId, tenantId),
          eq(menuItems.brandId, outlet.brandId),
          eq(menuItems.isActive, true),
          flagOnly ? eq(menuItems.isBreakfast, true) : undefined,
          isNull(menuItems.deletedAt),
          isNull(menuCategories.deletedAt),
        ),
      )
      .orderBy(asc(menuCategories.sortOrder), asc(menuItems.name))
      .limit(MENU_LIMIT);
    const catalogue = await loadPosCatalogue(tx, context, {
      brandId: outlet.brandId,
      outletId: outlet.id as OutletId,
      timeZone: outlet.timezone,
      businessDate: businessDateFor(outlet, now),
      channel: "dine_in",
      itemIds: candidates.map((row) => row.id),
      now,
    });
    const items = candidates.flatMap((row) => {
      const item = catalogue.get(row.id);
      if (
        !item ||
        !item.sellable ||
        item.plainPriceIdr === null ||
        item.variants.size > 0 ||
        item.groups.some((group) => group.minSelect > 0)
      )
        return [];
      return [{ id: row.id, name: item.name, priceIdr: item.plainPriceIdr }];
    });
    const tableRows = await tx
      .select({ id: tables.id, code: tables.code })
      .from(tables)
      .innerJoin(
        floorZones,
        and(
          eq(floorZones.tenantId, tables.tenantId),
          eq(floorZones.id, tables.zoneId),
        ),
      )
      .where(
        and(
          eq(tables.tenantId, tenantId),
          eq(tables.outletId, ticket.outletId),
          ne(tables.status, "inactive"),
          eq(floorZones.status, "active"),
        ),
      )
      .orderBy(asc(tables.code))
      .limit(MENU_LIMIT);
    const linked = await currentLinked(tx, context, ticket.id);
    return breakfastMenuSchema.parse({
      items,
      tables: tableRows.map((row) => ({
        id: row.id,
        label: `Meja ${row.code}`,
      })),
      fireOffsetMinutes: BREAKFAST_FIRE_OFFSET_MINUTES,
      order: linked ? await toBreakfastOrder(tx, context, linked) : null,
    });
  });
}

// ---- Create -----------------------------------------------------------------

/** The delivery table of the outlet with its zone, or a validation error. */
async function loadDeliveryTable(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  delivery: BreakfastDelivery,
) {
  if (delivery.mode !== "table") return null;
  const tableId = uuidSchema.safeParse(delivery.tableId);
  const [row] = tableId.success
    ? await tx
        .select({ table: tables, zone: floorZones })
        .from(tables)
        .innerJoin(
          floorZones,
          and(
            eq(floorZones.tenantId, tables.tenantId),
            eq(floorZones.id, tables.zoneId),
          ),
        )
        .where(
          and(
            eq(tables.tenantId, context.tenant.tenantId),
            eq(tables.outletId, outletId),
            eq(tables.id, tableId.data),
            ne(tables.status, "inactive"),
            eq(floorZones.status, "active"),
          ),
        )
    : [];
  if (!row)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Meja tidak ditemukan. Muat ulang menu, lalu pilih lagi.",
    );
  return row;
}

export async function createBreakfastOrderForMember(
  context: ScopedTenantContext,
  member: BreakfastMember,
  ticketId: string,
  body: CreateBreakfastOrderBody,
  now = new Date(),
): Promise<BreakfastOrder> {
  const { idempotencyKey, ...request } = body;
  // Merge duplicate dishes, then cap the portions per dish.
  const portions = new Map<string, number>();
  for (const line of request.lines)
    portions.set(
      line.menuItemId,
      (portions.get(line.menuItemId) ?? 0) + line.quantity,
    );
  for (const quantity of portions.values())
    if (quantity > BREAKFAST_MAX_QUANTITY)
      throw new CoreError(
        "VALIDATION_ERROR",
        `Paling banyak ${BREAKFAST_MAX_QUANTITY} porsi untuk satu menu.`,
      );
  const wanted = [...portions]
    .map(([menuItemId, quantity]) => ({ menuItemId, quantity }))
    .sort((a, b) => a.menuItemId.localeCompare(b.menuItemId));
  const fingerprint = operationsFingerprint({
    lines: wanted,
    delivery: request.delivery,
  });

  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    // The ticket row serializes every create (and replay) of this ticket.
    const ticket = await loadOwnTicket(tx, context, member, ticketId, true);

    const [replay] = await tx
      .select()
      .from(facilityLinkedOrders)
      .where(
        and(
          eq(facilityLinkedOrders.tenantId, tenantId),
          eq(facilityLinkedOrders.accessTicketId, ticket.id),
          eq(facilityLinkedOrders.idempotencyKey, idempotencyKey),
        ),
      );
    if (replay) {
      if (replay.requestFingerprint !== fingerprint)
        throw new CoreError(
          "IDEMPOTENCY_KEY_REUSED",
          "Kunci idempotensi sudah dipakai permintaan lain.",
        );
      return toBreakfastOrder(tx, context, replay);
    }

    const [live] = await tx
      .select({ id: facilityLinkedOrders.id })
      .from(facilityLinkedOrders)
      .where(
        and(
          eq(facilityLinkedOrders.tenantId, tenantId),
          eq(facilityLinkedOrders.accessTicketId, ticket.id),
          ne(facilityLinkedOrders.status, "cancelled"),
        ),
      )
      .limit(1);
    if (live) throw new FacilityError("BREAKFAST_ORDER_EXISTS");

    const fireAt = fireAtOf(ticket, BREAKFAST_FIRE_OFFSET_MINUTES);
    if (
      !(ORDERABLE_TICKET_STATUSES as readonly string[]).includes(
        ticket.status,
      ) ||
      fireAt.getTime() <= now.getTime()
    )
      throw new FacilityError("BREAKFAST_UNAVAILABLE");

    const outletId = ticket.outletId as OutletId;
    const outlet = await loadOutlet(tx, context, outletId);
    const businessDate = businessDateFor(outlet, now);
    await assertBusinessDayOpen(tx, context, {
      outletId,
      businessDates: [businessDate],
    });
    const deliveryTable = await loadDeliveryTable(
      tx,
      context,
      outletId,
      request.delivery,
    );
    const serviceType = deliveryTable ? "dine_in" : "takeaway";
    const channel = posPriceChannel("facility", serviceType);
    const catalogue = await loadPosCatalogue(tx, context, {
      brandId: outlet.brandId,
      outletId,
      timeZone: outlet.timezone,
      businessDate,
      channel,
      itemIds: wanted.map((line) => line.menuItemId),
      now,
    });

    // legend-lgyfh: once the outlet flags items, an item outside the breakfast
    // menu is refused like an unavailable one, so a guessed id cannot be
    // ordered. With none flagged the old rule applies (nothing refused here).
    const flagOnly = await outletUsesBreakfastFlag(
      tx,
      context.tenant.tenantId,
      outlet.brandId,
    );
    const breakfastIds = flagOnly
      ? new Set(
          (
            await tx
              .select({ id: menuItems.id })
              .from(menuItems)
              .where(
                and(
                  eq(menuItems.tenantId, context.tenant.tenantId),
                  eq(menuItems.brandId, outlet.brandId),
                  eq(menuItems.isBreakfast, true),
                  isNull(menuItems.deletedAt),
                  inArray(
                    menuItems.id,
                    wanted.map((line) => line.menuItemId),
                  ),
                ),
              )
          ).map((row) => row.id),
        )
      : null;

    const orderId = createUlid(now.getTime());
    const resolved = wanted.map((line, index) => {
      const item =
        breakfastIds === null || breakfastIds.has(line.menuItemId)
          ? catalogue.get(line.menuItemId)
          : undefined;
      const resolution = resolveLine(item, {
        menuItemId: line.menuItemId,
        variantId: null,
        quantity: line.quantity,
        modifierIds: [],
      });
      if (!resolution.ok || !item)
        throw new CoreError(
          resolution.ok || resolution.reason === "sold_out"
            ? "CONFLICT"
            : "VALIDATION_ERROR",
          "Menu sarapan tidak tersedia. Muat ulang menu, lalu pilih lagi.",
        );
      return {
        id: createUlid(now.getTime() + index + 1),
        line,
        item,
        priced: resolution.line,
      };
    });
    // ORD-05: reserve each dish's daily stock; the cancel path releases it.
    for (const entry of resolved) {
      const reservation = await reserveMenuItemDailyLimit(tx, context, {
        outletId,
        menuItemId: entry.line.menuItemId,
        businessDate,
        quantity: entry.line.quantity,
        now,
      });
      if (!reservation.allowed)
        throw new CoreError(
          "CONFLICT",
          `${entry.priced.name} sudah habis untuk hari ini.`,
        );
    }
    const bill = computePosBill({
      context,
      outletId,
      businessDate,
      channel,
      zone: deliveryTable?.zone ?? null,
      lines: resolved.map((entry) => ({
        lineId: entry.id,
        menuItemId: entry.line.menuItemId,
        categoryId: entry.item.categoryId,
        quantity: entry.line.quantity,
        unitPriceIdr: entry.priced.unitPriceIdr,
        modifiersTotalIdr: entry.priced.modifiersTotalIdr,
      })),
      orderDiscountIdr: 0,
      taxConfig: await loadPosTaxConfig(tx, context, outletId),
    });
    // A bill of 0 can never be "paid"; refuse it instead of holding it forever.
    if (bill.totalIdr <= 0)
      throw new CoreError(
        "VALIDATION_ERROR",
        "Total pesanan sarapan harus lebih dari nol.",
      );

    const note = deliveryTable
      ? `Sarapan tiket - Meja ${deliveryTable.table.code}`
      : "Sarapan tiket - ambil sendiri";
    const [order] = await tx
      .insert(orders)
      .values({
        id: orderId,
        tenantId,
        outletId,
        number: `F${businessDate.replaceAll("-", "").slice(2)}-${orderId.slice(-8)}`,
        channel: "facility",
        serviceType,
        tableSessionId: null,
        customerProfileId: member.customerProfileId,
        customerAttachedBy: null,
        customerAttachedVia: "pwa_session",
        customerAttachedAt: now,
        // Pay first: the kitchen gets it only after the verified payment.
        paymentMode: "pay_first",
        subtotalIdr: bill.subtotalIdr,
        discountIdr: bill.discountIdr,
        serviceChargeIdr: bill.serviceChargeIdr,
        taxIdr: bill.taxIdr,
        roundingIdr: bill.roundingIdr,
        totalIdr: bill.totalIdr,
        depositAppliedIdr: idr(0),
        status: "awaiting_payment",
        businessDate,
        taxResult: bill.tax,
        note,
        createdBy: null,
        placedAt: now,
        firedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!order) throw new Error("Breakfast order insert returned no row");
    const costSnapshots = await computeLineCostSnapshots(
      tx,
      context,
      outletId,
      resolved.map((entry) => ({
        menuItemId: entry.line.menuItemId,
        variantId: null,
        modifierIds: [],
        quantity: entry.line.quantity,
      })),
    );
    await tx.insert(orderItems).values(
      resolved.map((entry, index) => {
        const costSnapshot = costSnapshots[index] ?? null;
        return {
          id: entry.id,
          tenantId,
          outletId,
          orderId,
          menuItemId: entry.line.menuItemId,
          variantId: null,
          name: entry.priced.name,
          quantity: entry.line.quantity,
          unitPriceIdr: entry.priced.unitPriceIdr,
          modifiersTotalIdr: entry.priced.modifiersTotalIdr,
          lineTotalIdr: idr(
            (entry.priced.unitPriceIdr + entry.priced.modifiersTotalIdr) *
              entry.line.quantity,
          ),
          modifiers: entry.priced.modifiers,
          note: null,
          course: entry.item.course,
          fireStatus: "held" as const,
          status: "queued" as const,
          reservedBusinessDate: businessDate,
          costSnapshotIdr: costSnapshot === null ? null : idr(costSnapshot),
          createdAt: now,
          updatedAt: now,
        };
      }),
    );
    const [linked] = await tx
      .insert(facilityLinkedOrders)
      .values({
        tenantId,
        outletId,
        facilityId: ticket.facilityId,
        accessTicketId: ticket.id,
        orderId,
        status: "awaiting_payment",
        delivery: request.delivery,
        subtotalIdr: bill.subtotalIdr,
        totalIdr: bill.totalIdr,
        paidIdr: idr(0),
        fireOffsetMinutes: BREAKFAST_FIRE_OFFSET_MINUTES,
        fireAt,
        refundedIdr: idr(0),
        idempotencyKey,
        requestFingerprint: fingerprint,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!linked)
      throw new Error("Breakfast linked order insert returned no row");
    await auditFacility(tx, context, null, now, {
      action: "facility.breakfast.created",
      objectType: "facility_linked_order",
      objectId: linked.id,
      outletId,
      before: null,
      after: { id: linked.id, status: "awaiting_payment", ticketId: ticket.id },
    });
    return toBreakfastOrder(tx, context, linked);
  });
}

// ---- Pay --------------------------------------------------------------------

/** Locked breakfast order of this member's ticket, or 404. */
async function lockOwnOrder(
  tx: Tx,
  context: ScopedTenantContext,
  member: BreakfastMember,
  ticketId: string,
  orderId: string,
) {
  const ticket = await loadOwnTicket(tx, context, member, ticketId, false);
  if (!ulidSchema.safeParse(orderId).success) throw notFound("Pesanan");
  const locked = await lockBreakfastOrder(tx, context, orderId);
  if (!locked || locked.linked.accessTicketId !== ticket.id)
    throw notFound("Pesanan");
  return { ...locked, ticket };
}

export async function payBreakfastOrderForMember(
  context: ScopedTenantContext,
  member: BreakfastMember,
  ticketId: string,
  orderId: string,
  _body: { idempotencyKey: string },
  now = new Date(),
): Promise<BreakfastPayment> {
  // `confirmed`: the provider was asked about the pay link (outside any lock)
  // before this run may cancel; the first run only reports that it must.
  const attempt = (confirmed: boolean) =>
    withTenant(db, context, async (tx) => {
      const tenantId = context.tenant.tenantId;
      const { order, linked, ticket } = await lockOwnOrder(
        tx,
        context,
        member,
        ticketId,
        orderId,
      );
      const dto = await toBreakfastOrder(tx, context, linked);
      if (linked.status === "cancelled")
        throw new FacilityError("BREAKFAST_ORDER_CANCELLED");
      // Paid or fired: nothing left to pay, no token.
      if (linked.status !== "awaiting_payment")
        return breakfastPaymentSchema.parse({ order: dto, paymentToken: null });
      // No new code or link for a dead ticket or an ended session: a payment
      // made then would only be refunded. The sweep would cancel this order for
      // the same reason, so cancel now: that closes the pay link the guest may
      // already hold. Refused after the commit, or the cancel would roll back.
      if (
        DEAD_TICKET_STATUSES.includes(ticket.status) ||
        now.getTime() >= ticket.endsAt.getTime()
      ) {
        // A pay link the guest may hold is proven unpaid at the provider first,
        // outside this lock: stop here, nothing written, and run again.
        if (order.paymentLinkId !== null && !confirmed)
          return "confirm" as const;
        // Link before intent (the cancel updates both).
        if (order.paymentLinkId !== null)
          await lockBreakfastPayLink(tx, context, order.paymentLinkId);
        await assertBreakfastLinkHoldsNoMoney(tx, context, { order, linked });
        await cancelBreakfastOrderTx(
          tx,
          context,
          { order, linked },
          { reason: "payment_window_closed", actorUserId: null, now },
        );
        return null;
      }
      if (order.status !== "awaiting_payment")
        throw new CoreError(
          "CONFLICT",
          "Pesanan ini tidak menunggu pembayaran.",
        );
      const aad = linkSealAad(tenantId, order.id);
      if (order.paymentLinkId !== null) {
        if (order.paymentLinkTokenSealed === null)
          throw new Error("Payment link token missing");
        return breakfastPaymentSchema.parse({
          order: dto,
          paymentToken: openSecret(order.paymentLinkTokenSealed, aad),
        });
      }
      // The link is opened once, while this transaction holds the order row, so
      // concurrent payers never open two bills (same pattern as QR).
      const opened = await createPaymentLink(
        context,
        {
          outletId: order.outletId,
          reference: order.number,
          tableLabel: null,
          pax: null,
          subtotalIdr: orderNetSubtotalIdr(order),
          discountIdr: order.discountIdr + order.depositAppliedIdr,
          serviceChargeIdr: order.serviceChargeIdr,
          taxIdr: order.taxIdr,
          roundingIdr: order.roundingIdr,
          totalIdr: order.totalIdr - order.depositAppliedIdr,
          returnPath: null,
        },
        LINK_CREATED_BY,
        now,
      );
      await tx
        .update(orders)
        .set({
          paymentLinkId: opened.linkId,
          paymentLinkTokenSealed: sealSecret(opened.token, aad),
          updatedAt: now,
        })
        .where(and(eq(orders.tenantId, tenantId), eq(orders.id, order.id)));
      return breakfastPaymentSchema.parse({
        order: dto,
        paymentToken: opened.token,
      });
    });
  let result = await attempt(false);
  if (result === "confirm") {
    await confirmBreakfastLinkUnpaid(context, orderId, now);
    result = await attempt(true);
  }
  if (result === "confirm") throw new FacilityError("BREAKFAST_UNAVAILABLE");
  if (result === null) throw new FacilityError("BREAKFAST_UNAVAILABLE");
  return result;
}

// ---- Cancel and fire --------------------------------------------------------

export async function cancelBreakfastOrderForMember(
  context: ScopedTenantContext,
  member: BreakfastMember,
  ticketId: string,
  orderId: string,
  _body: { idempotencyKey: string },
  now = new Date(),
): Promise<BreakfastCancelResult> {
  // Own order first (a stranger's order is never touched at the provider), then
  // the provider proof outside any lock; the cancel below re-reads under lock:
  // an order the proof found paid takes the paid (refund) path.
  await withTenant(db, context, (tx) =>
    lockOwnOrder(tx, context, member, ticketId, orderId),
  );
  await confirmBreakfastLinkUnpaid(context, orderId, now);
  return withTenant(db, context, async (tx) => {
    const locked = await lockOwnOrder(tx, context, member, ticketId, orderId);
    // Link before intent; refuse while an intent of the link holds money the
    // order does not show as paid yet (the next try takes the refund path).
    if (locked.order.paymentLinkId !== null)
      await lockBreakfastPayLink(tx, context, locked.order.paymentLinkId);
    await assertBreakfastLinkHoldsNoMoney(tx, context, locked);
    const { linked, refundIdr } = await cancelBreakfastOrderTx(
      tx,
      context,
      locked,
      // The member's Better Auth id is not a staff user id: audited as system.
      { reason: "guest_cancelled", actorUserId: null, now },
    );
    return breakfastCancelResultSchema.parse({
      order: await toBreakfastOrder(tx, context, linked),
      refundIdr,
    });
  });
}

export async function fireBreakfastOrderByStaff(
  context: ScopedTenantContext,
  actorUserId: string,
  orderId: string,
  _body: { idempotencyKey: string },
  now = new Date(),
): Promise<BreakfastOrder> {
  const result = await withTenant(db, context, async (tx) => {
    if (!ulidSchema.safeParse(orderId).success) throw notFound("Pesanan");
    const locked = await lockBreakfastOrder(tx, context, orderId);
    if (!locked) throw notFound("Pesanan");
    await assertFacilityPermission(
      tx,
      context,
      actorUserId,
      OPERATE_PERMISSION,
      locked.order.outletId,
    );
    // Refuses anything not paid (BREAKFAST_NOT_PAID); a fired order answers
    // with itself. A refund already filed or a dead ticket cancels instead.
    const { linked, outcome } = await fireBreakfastOrderTx(
      tx,
      context,
      locked,
      { actorUserId, now },
    );
    // At or after ends_at the order was cancelled and refunded in full above;
    // refused after the commit, or the cancel would roll back.
    if (outcome === "ended") return null;
    return toBreakfastOrder(tx, context, linked);
  });
  if (result === null) throw new FacilityError("BREAKFAST_UNAVAILABLE");
  return result;
}

export type { BreakfastOrderRow };
