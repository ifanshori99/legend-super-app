// Staff map the unmatched (or sold_out) lines of a needs_review delivery order (bead
// legend-5d76): webhook lines that did not match the menu are pointed at menu
// items, then the order is injected into the KDS like a matched webhook order.
//
// The money stays the platform's: `unitPriceIdr`, `lineTotalIdr`, gross and
// commission are never recomputed from the menu price, so a mapping can never
// make the platform pay more (a different menu price is a `price_mismatch`
// line that keeps the platform price). One transaction under the row lock:
// a second click or a parallel request finds the order already injected and
// answers with the current row (no second KDS order).
import { and, eq } from "drizzle-orm";
import {
  assertOutletInScope,
  createUlid,
  idr,
  toIsoDateTime,
  type OutletId,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import {
  DeliveryError,
  deliveryOrderLineSchema,
  type DeliveryChannelOrder,
  type DeliveryOrderLine,
  type MapDeliveryOrderLinesInput,
} from "@starter/shared/delivery";
import { db } from "../db/index.ts";
import { deliveryChannelOrders } from "../db/schema/delivery.ts";
import { withTenant } from "../db/tenant.ts";
import { recordAudit } from "./core-audit.ts";
import { autoAccept } from "./delivery-ingest.service.ts";
import { advisoryLock, injectDeliveryOrder } from "./delivery-inject.ts";
import {
  lockDeliveryOrder,
  toDeliveryChannelOrder,
  type DeliveryChannelOrderRow,
} from "./delivery-store.ts";
import { loadPosCatalogue } from "./pos-order-pricing.ts";
import { businessDateFor, loadOutlet } from "./pos-order-support.ts";
import type { CatalogueItem } from "./qr-order-pricing.ts";

export type DeliveryMapLinesCaller = { readonly userId: UserId };

/** A line the webhook could not inject: no menu match, or the item sold out. */
function isRemappable(line: DeliveryOrderLine): boolean {
  return line.mapping === "unmatched" || line.mapping === "sold_out";
}

/** The line with staff's menu item, priced from the channel and checked. */
function mapOneLine(
  line: DeliveryOrderLine,
  mapping: MapDeliveryOrderLinesInput["mappings"][number],
  catalogue: ReadonlyMap<string, CatalogueItem>,
): DeliveryOrderLine {
  const entry = catalogue.get(mapping.menuItemId);
  const variantId = mapping.variantId ?? null;
  // Unknown, inactive, other-tenant or unpriced item is not in the catalogue.
  if (!entry || !entry.sellable)
    throw new DeliveryError("DELIVERY_MAPPING_INCOMPLETE");
  const channelPrice =
    variantId === null
      ? entry.variants.size > 0
        ? null
        : entry.plainPriceIdr
      : (entry.variants.get(variantId)?.priceIdr ?? null);
  if (channelPrice === null)
    throw new DeliveryError("DELIVERY_MAPPING_INCOMPLETE");
  return deliveryOrderLineSchema.parse({
    ...line,
    menuItemId: entry.id,
    variantId,
    mapping: channelPrice === line.unitPriceIdr ? "matched" : "price_mismatch",
    channelPriceIdr: idr(channelPrice),
  });
}

type Outcome =
  | { kind: "current"; row: DeliveryChannelOrderRow }
  | { kind: "injected"; row: DeliveryChannelOrderRow; accept: boolean };

export async function mapDeliveryOrderLines(
  context: ScopedTenantContext,
  caller: DeliveryMapLinesCaller,
  outletId: OutletId,
  deliveryOrderId: string,
  input: MapDeliveryOrderLinesInput,
  now = new Date(),
): Promise<DeliveryChannelOrder> {
  assertOutletInScope(context.outletScope, outletId);
  const outcome = await withTenant(
    db,
    context,
    async (tx): Promise<Outcome> => {
      // Same lock order as the webhook (advisory lock, then the row lock), so
      // a parallel webhook retry and this request cannot deadlock: read the
      // row unlocked for its platform order id, take the advisory lock, then
      // lock the row and check it again.
      const [peek] = await tx
        .select({
          outletId: deliveryChannelOrders.outletId,
          platform: deliveryChannelOrders.platform,
          externalOrderId: deliveryChannelOrders.externalOrderId,
        })
        .from(deliveryChannelOrders)
        .where(
          and(
            eq(deliveryChannelOrders.tenantId, context.tenant.tenantId),
            eq(deliveryChannelOrders.id, deliveryOrderId),
          ),
        )
        .limit(1);
      if (!peek || peek.outletId !== outletId)
        throw new DeliveryError("DELIVERY_ORDER_NOT_FOUND");
      await advisoryLock(
        tx,
        `delivery-order:${context.tenant.tenantId}:${peek.platform}:${peek.externalOrderId}`,
      );
      const row = await lockDeliveryOrder(
        tx,
        context.tenant.tenantId,
        deliveryOrderId,
      );
      if (!row || row.outletId !== outletId)
        throw new DeliveryError("DELIVERY_ORDER_NOT_FOUND");
      // Already injected (or closed): idempotent, the current row, no second order.
      if (row.orderId !== null || row.status !== "received")
        return { kind: "current", row };

      // Exactly the lines that cannot be injected (unmatched or sold_out),
      // each once; matched and price_mismatch lines are never remapped.
      const unmatched = row.lines.filter(isRemappable);
      const byLineNo = new Map(input.mappings.map((m) => [m.lineNo, m]));
      // The webhook changed the order after staff looked (another item on that
      // line, whatever its mapping state now): nothing is injected or changed,
      // staff see the new lines first. An unknown lineNo is a malformed
      // request instead (422 below).
      const storedByLineNo = new Map(row.lines.map((l) => [l.lineNo, l]));
      if (
        input.mappings.some((mapping) => {
          const stored = storedByLineNo.get(mapping.lineNo);
          return (
            stored !== undefined &&
            stored.externalItemId !== mapping.externalItemId
          );
        })
      )
        throw new DeliveryError("DELIVERY_ORDER_CHANGED");
      if (
        unmatched.length !== byLineNo.size ||
        unmatched.some((line) => !byLineNo.has(line.lineNo))
      )
        throw new DeliveryError("DELIVERY_MAPPING_INCOMPLETE");

      const outlet = await loadOutlet(tx, context, outletId);
      const catalogue = await loadPosCatalogue(tx, context, {
        brandId: outlet.brandId,
        outletId,
        timeZone: outlet.timezone,
        businessDate: businessDateFor(outlet, now),
        channel: row.platform,
        itemIds: input.mappings.map((mapping) => mapping.menuItemId),
        now,
      });
      const lines = row.lines.map((line) => {
        const mapping = byLineNo.get(line.lineNo);
        return isRemappable(line) && mapping
          ? mapOneLine(line, mapping, catalogue)
          : line;
      });

      const injected = await injectDeliveryOrder(tx, context, {
        outletId,
        platform: row.platform,
        externalOrderId: row.externalOrderId,
        source: "platform",
        grossIdr: row.grossIdr,
        commissionIdr: row.commissionIdr,
        payloadHash: row.payloadHash,
        signedAt: row.lastSignedAt,
        customerNote: row.customerNote,
        lines,
        initialStatus: "received",
        existing: row,
        actorUserId: caller.userId,
        now,
      });
      await recordAudit(
        tx,
        context,
        {
          id: createUlid(now.getTime()),
          tenantId: context.tenant.tenantId,
          outletId,
          actorType: "user",
          actorId: caller.userId,
          deviceId: null,
          action: "delivery_order.lines_mapped",
          objectType: "delivery_channel_order",
          objectId: row.id,
          reason: null,
          maskedChanges: {
            before: { platform: row.platform, status: row.status },
            after: {
              platform: row.platform,
              status: injected.row.status,
              mappings: input.mappings.map((mapping) => ({
                lineNo: mapping.lineNo,
                menuItemId: mapping.menuItemId,
                variantId: mapping.variantId ?? null,
              })),
              needsReview: injected.needsReview,
            },
          },
          ipHash: null,
          sensitiveAccess: false,
          retentionClass: "audit_2y",
          createdAt: toIsoDateTime(now),
        },
        [
          "platform",
          "status",
          "mappings",
          "lineNo",
          "menuItemId",
          "variantId",
          "needsReview",
        ],
      );
      // Linked to a POS twin the cashier voided: stays needs_review, not accepted.
      return {
        kind: "injected",
        row: injected.row,
        accept: !injected.needsReview,
      };
    },
  );

  if (outcome.kind === "injected" && outcome.accept)
    return toDeliveryChannelOrder(await autoAccept(context, outcome.row, now));
  return toDeliveryChannelOrder(outcome.row);
}
