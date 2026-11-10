// Guest read models for the QR order screens (bead legend-cpq2; contracts
// @starter/shared/qr-order guest.ts getMenuSuggestions).
//
// Suggestions are simple rules, no AI (legend-ptd adds AI later): the outlet's
// most ordered items of the last 30 days, orderable now, that are not already
// in the session cart. With no history the menu's own order fills the list.
// The outlet comes from the verified session credential (TEN-03), never from
// the client, and the credential is resolved the same way as every other
// guest read (ORD-04: a closed session is refused). A zone that cannot order
// right now (inactive or outside its hours) gets an empty list.

import { and, asc, eq, gte, inArray, ne, notExists, sql } from "drizzle-orm";
import { idr, type ScopedTenantContext } from "@starter/shared/core";
import {
  menuSuggestionSchema,
  orderEtaSchema,
  type MenuSuggestion,
  type OrderEta,
} from "@starter/shared/qr-order";
import { db } from "../db/index.ts";
import { orderIssues } from "../db/schema/kds-issues.ts";
import { cartLines, orderItems, orders } from "../db/schema/qr-order.ts";
import { withTenant } from "../db/tenant.ts";
import { estimateOrderRanges } from "./kds-estimate.service.ts";
import {
  listOrderableGuestItems,
  zoneOrderingOpen,
} from "./guest-menu.service.ts";
import {
  loadQrOutlet,
  loadQrZoneOfSession,
  lockGuestSessionForPayment,
} from "./qr-order.service.ts";

/** The contract caps the list at 6 (`getMenuSuggestions` response). */
export const MAX_SUGGESTIONS = 6;
/** How far back the order history counts. */
export const SUGGESTION_WINDOW_DAYS = 30;

/** GET /api/table-sessions/:sessionId/suggestions */
export async function getMenuSuggestions(
  context: ScopedTenantContext,
  credential: string,
  sessionId: string,
  input: { menuItemId?: string },
  now = new Date(),
): Promise<MenuSuggestion[]> {
  return withTenant(db, context, async (tx) => {
    const session = await lockGuestSessionForPayment(
      tx,
      context,
      credential,
      sessionId,
      now,
      "none",
    );
    const tenantId = context.tenant.tenantId;

    // Same gate as checkout: an inactive zone or one outside its ordering
    // hours cannot order, so it gets no suggestions.
    const outlet = await loadQrOutlet(tx, context, session.outletId);
    const { zone } = await loadQrZoneOfSession(tx, context, session);
    if (
      zone.status !== "active" ||
      !zoneOrderingOpen(zone.hours, now, outlet.timezone)
    )
      return [];

    const cart = await tx
      .select({
        menuItemId: cartLines.menuItemId,
        addedAt: cartLines.addedAt,
      })
      .from(cartLines)
      .where(
        and(
          eq(cartLines.tenantId, tenantId),
          eq(cartLines.tableSessionId, session.id),
        ),
      );
    const inCart = new Set(cart.map((line) => line.menuItemId));
    const latestInCart = [...cart].sort(
      (a, b) => b.addedAt.getTime() - a.addedAt.getTime(),
    )[0]?.menuItemId;

    const orderable = await listOrderableGuestItems(tx, context, {
      outletId: session.outletId,
      now,
    });
    const orderableIds = new Set(orderable.map((item) => item.id));

    const since = new Date(
      now.getTime() - SUGGESTION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    const history = await tx
      .select({
        menuItemId: orderItems.menuItemId,
        lines: sql<number>`count(*)::int`,
      })
      .from(orderItems)
      .innerJoin(
        orders,
        and(
          eq(orders.tenantId, orderItems.tenantId),
          eq(orders.id, orderItems.orderId),
        ),
      )
      .where(
        and(
          eq(orderItems.tenantId, tenantId),
          eq(orderItems.outletId, session.outletId),
          gte(orderItems.createdAt, since),
          ne(orderItems.status, "voided"),
          ne(orders.status, "voided"),
          // A free swap replacement line is not a sale (legend-8igcm).
          notExists(
            tx
              .select({ one: sql`1` })
              .from(orderIssues)
              .where(
                and(
                  eq(orderIssues.tenantId, orderItems.tenantId),
                  eq(orderIssues.replacementOrderItemId, orderItems.id),
                  eq(orderItems.lineTotalIdr, idr(0)),
                ),
              ),
          ),
        ),
      )
      .groupBy(orderItems.menuItemId)
      .orderBy(sql`count(*) desc`, orderItems.menuItemId);

    // The item the guest is looking at is the anchor when it is known to the
    // session (orderable or in the cart); otherwise the newest cart line.
    const focus = input.menuItemId;
    const anchor =
      focus !== undefined && (orderableIds.has(focus) || inCart.has(focus))
        ? focus
        : (latestInCart ?? null);

    const skip = new Set(inCart);
    if (focus !== undefined) skip.add(focus);
    const ranked = [
      ...history.map((row) => row.menuItemId),
      ...orderable.map((item) => item.id),
    ];
    const picked: string[] = [];
    for (const id of ranked) {
      if (picked.length >= MAX_SUGGESTIONS) break;
      if (!orderableIds.has(id) || skip.has(id) || picked.includes(id))
        continue;
      picked.push(id);
    }
    return picked.map((menuItemId) =>
      menuSuggestionSchema.parse({
        menuItemId,
        kind: "pairing",
        basedOnMenuItemId: anchor,
      }),
    );
  });
}

/**
 * GET /api/table-sessions/:sessionId/order-etas (bead legend-541h).
 *
 * One ETA range per order of the session that is in the kitchen (`sent`) and
 * still has a line that is neither served nor voided; lines already `ready`
 * add no cooking time (an order with only ready lines gets 0 to 0). Unpaid, voided and
 * completed orders get none. Ranges come from the KDS pacing maths over the
 * remaining lines (kds-estimate.service.ts); `estimatedReadyAt` is the low
 * end of the range from `now`.
 */
export async function getOrderEtas(
  context: ScopedTenantContext,
  credential: string,
  sessionId: string,
  now = new Date(),
): Promise<OrderEta[]> {
  return withTenant(db, context, async (tx) => {
    const session = await lockGuestSessionForPayment(
      tx,
      context,
      credential,
      sessionId,
      now,
      "none",
    );
    const tenantId = context.tenant.tenantId;
    const sessionOrders = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.tableSessionId, session.id),
          eq(orders.status, "sent"),
        ),
      )
      .orderBy(asc(orders.createdAt), asc(orders.id));
    if (sessionOrders.length === 0) return [];

    const lines = await tx
      .select({
        orderId: orderItems.orderId,
        menuItemId: orderItems.menuItemId,
        quantity: orderItems.quantity,
        status: orderItems.status,
      })
      .from(orderItems)
      .where(
        and(
          eq(orderItems.tenantId, tenantId),
          inArray(
            orderItems.orderId,
            sessionOrders.map((order) => order.id),
          ),
          ne(orderItems.status, "served"),
          ne(orderItems.status, "voided"),
        ),
      );
    const linesOf = new Map<
      string,
      { menuItemId: string; quantity: number }[]
    >();
    for (const line of lines) {
      const list = linesOf.get(line.orderId) ?? [];
      // A ready line is out of the station queue: the order is still open
      // (not served) but that line adds no cooking time.
      if (line.status !== "ready")
        list.push({ menuItemId: line.menuItemId, quantity: line.quantity });
      linesOf.set(line.orderId, list);
    }
    const open = sessionOrders
      .filter((order) => linesOf.has(order.id))
      .map((order) => ({
        orderId: order.id,
        lines: linesOf.get(order.id) ?? [],
      }));
    if (open.length === 0) return [];

    const ranges = await estimateOrderRanges(
      tx,
      context,
      session.outletId,
      open,
      now,
    );
    return open.map(({ orderId }) => {
      const range = ranges.get(orderId) ?? { minMinutes: 0, maxMinutes: 0 };
      return orderEtaSchema.parse({
        orderId,
        minMinutes: range.minMinutes,
        maxMinutes: range.maxMinutes,
        estimatedReadyAt: new Date(
          now.getTime() + range.minMinutes * 60_000,
        ).toISOString(),
      });
    });
  });
}
