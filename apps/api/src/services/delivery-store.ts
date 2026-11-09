// Row <-> contract DTO mappers and the shared lookups of the delivery channel
// framework (bead legend-5bn3; PRD v1.7 §3.23, §6.G). Every row is parsed with
// the contract schema on the way out, so a corrupt row fails loudly instead of
// reaching the ops screen. Services (channels, ingest, orders, reconciliation)
// import from here; none of them hand-map rows.
import { and, eq } from "drizzle-orm";
import type { TenantId } from "@starter/shared/core";
import {
  deliveryChannelOrderSchema,
  deliveryChannelSchema,
  deliverySettlementLineSchema,
  type DeliveryChannel,
  type DeliveryChannelOrder,
  type DeliveryPlatform,
  type DeliverySettlementLine,
} from "@starter/shared/delivery";
import type { Tx } from "./permission-resolver.ts";
import {
  deliveryChannelOrders,
  deliveryChannels,
  deliverySettlementLines,
} from "../db/schema/delivery.ts";

export type DeliveryChannelRow = typeof deliveryChannels.$inferSelect;
export type DeliveryChannelOrderRow = typeof deliveryChannelOrders.$inferSelect;
export type DeliverySettlementLineRow =
  typeof deliverySettlementLines.$inferSelect;

const iso = (value: Date) => value.toISOString();
const isoOrNull = (value: Date | null) => (value ? value.toISOString() : null);

export function toDeliveryChannel(row: DeliveryChannelRow): DeliveryChannel {
  return deliveryChannelSchema.parse({
    tenantId: row.tenantId,
    outletId: row.outletId,
    platform: row.platform,
    isOpen: row.isOpen,
    closedUntil: isoOrNull(row.closedUntil),
    closedReason: row.closedReason,
    syncStatus: row.syncStatus,
    lastSyncedAt: isoOrNull(row.lastSyncedAt),
    syncError: row.syncError,
    menuItemCount: row.menuItemCount,
    soldOutItemCount: row.soldOutItemCount,
    updatedAt: iso(row.updatedAt),
  });
}

export function toDeliveryChannelOrder(
  row: DeliveryChannelOrderRow,
): DeliveryChannelOrder {
  return deliveryChannelOrderSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    platform: row.platform,
    externalOrderId: row.externalOrderId,
    orderId: row.orderId,
    number: row.pickupNumber,
    status: row.status,
    source: row.source,
    grossIdr: row.grossIdr,
    commissionIdr: row.commissionIdr,
    payloadHash: row.payloadHash,
    customerNote: row.customerNote,
    lines: row.lines,
    receivedAt: iso(row.receivedAt),
    acceptedAt: isoOrNull(row.acceptedAt),
    readyAt: isoOrNull(row.readyAt),
    pickedUpAt: isoOrNull(row.pickedUpAt),
    deliveredAt: isoOrNull(row.deliveredAt),
    closedAt: isoOrNull(row.closedAt),
    closeReason: row.closeReason,
    settledAt: isoOrNull(row.settledAt),
    settledNetIdr: row.settledNetIdr,
  });
}

export function toDeliverySettlementLine(
  row: DeliverySettlementLineRow,
): DeliverySettlementLine {
  return deliverySettlementLineSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    platform: row.platform,
    externalOrderId: row.externalOrderId,
    grossIdr: row.grossIdr,
    commissionIdr: row.commissionIdr,
    settledNetIdr: row.settledNetIdr,
    deliveryChannelOrderId: row.deliveryChannelOrderId,
    status: row.status,
    varianceIdr: row.varianceIdr,
    settledOn: row.settledOn,
  });
}

/**
 * The order row of this tenant locked FOR UPDATE, or null. Every status change
 * and every webhook replay for one order serialises on this lock; run it first
 * inside the transaction, before any other write.
 */
export async function lockDeliveryOrder(
  tx: Tx,
  tenantId: TenantId,
  deliveryOrderId: string,
): Promise<DeliveryChannelOrderRow | null> {
  const [row] = await tx
    .select()
    .from(deliveryChannelOrders)
    .where(
      and(
        eq(deliveryChannelOrders.tenantId, tenantId),
        eq(deliveryChannelOrders.id, deliveryOrderId),
      ),
    )
    .limit(1)
    .for("update");
  return row ?? null;
}

/** The order for one platform order id (unique per tenant + platform), or null. */
export async function findByExternalId(
  tx: Tx,
  tenantId: TenantId,
  platform: DeliveryPlatform,
  externalOrderId: string,
  options: { lock?: boolean } = {},
): Promise<DeliveryChannelOrderRow | null> {
  const query = tx
    .select()
    .from(deliveryChannelOrders)
    .where(
      and(
        eq(deliveryChannelOrders.tenantId, tenantId),
        eq(deliveryChannelOrders.platform, platform),
        eq(deliveryChannelOrders.externalOrderId, externalOrderId),
      ),
    )
    .limit(1);
  const [row] = await (options.lock ? query.for("update") : query);
  return row ?? null;
}
