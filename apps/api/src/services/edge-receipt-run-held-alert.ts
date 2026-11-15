// Supervisor alert of a receipt run the edge reporter cannot move on (bead
// legend-n2d3g): the dead-lettered `order.voided` event of a voided receipt
// never reaches the cloud, so the reporter holds that receipt and every one
// behind it. One alert per (tenant, order, dead event), deduped like
// core-outbox-dead-alert.ts: sha256 -> uuid, advisory lock, and a check of
// notification_outbox.source_event_id inside the same transaction.
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  outletIdSchema,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../lib/logger.ts";
import { notifyOutletSupervisors } from "./edge-sync-conflict-alert.ts";

export type HeldReceiptRun = {
  /** Order aggregate id (uuid). */
  orderUuid: string;
  /** Id (uuid) of the dead-lettered event that holds the run. */
  eventUuid: string;
  eventName: string;
};

/** Alerts the outlet supervisors once per held order and dead event. */
export async function alertHeldReceiptRun(
  context: ScopedTenantContext,
  outletId: string,
  held: HeldReceiptRun,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const alertKey = JSON.stringify([
    "edge_receipt_run.held",
    tenantId,
    held.orderUuid.toLowerCase(),
    held.eventUuid.toLowerCase(),
  ]);
  const hex = createHash("sha256").update(alertKey).digest("hex").slice(0, 32);
  const alertUuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const alertId = uuidToUlid(alertUuid);
  const orderId = uuidToUlid(held.orderUuid);
  const eventId = uuidToUlid(held.eventUuid);
  try {
    await withTenant(db, context, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${alertUuid}`}, 0))`,
      );
      const existing = await tx.execute(
        sql`SELECT 1 FROM notification_outbox WHERE tenant_id = ${tenantId}::uuid AND source_event_id = ${alertUuid}::uuid LIMIT 1`,
      );
      if (existing.rows.length) return;
      const delivered = await notifyOutletSupervisors(
        tx,
        context,
        {
          tenantId,
          outletId: outletIdSchema.parse(outletId),
          id: alertId,
          eventName: "edge_receipt_run.held",
          aggregateType: "edge_receipt_run",
          aggregateId: alertId,
          payload: { orderId, eventId, eventName: held.eventName },
          title: "Struk tertahan",
          body: `Event ${held.eventName} pesanan ${orderId} tidak terkirim ke server pusat, sehingga struk pesanan itu dan struk sesudahnya belum dilaporkan. Periksa antrean event.`,
          recordEmpty: true,
        },
        new Date(),
      );
      if (!delivered)
        logger.error(
          { tenantId, orderId },
          "Held receipt run has no alert recipients",
        );
    });
  } catch (err) {
    // Never fails the reporter pass; the next pass retries (the marker is the
    // dedupe, so a failed attempt leaves none).
    logger.warn({ err }, "Held receipt run notification failed");
  }
}
