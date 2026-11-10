// Cloud -> edge forwarding of `wifi_quota.updated` (bead legend-xk7az; PRD v1.7
// §3 F25, FAC-12/FAC-13). The quota engine writes the event to the outbox
// (`cloud-sync`, a cloud-local sink). The edge node of the outlet holds the
// controller, so the same envelope is also queued `cloud_to_edge` on the
// quota transaction: committed with the quota change or not at all, delivered
// by the existing link (at least once, resumed after an offline period).
//
// Outlet without an active edge node: nothing is queued. Edge node known but
// its link down: still queued, the link drains the queue when it reconnects.
import { and, eq } from "drizzle-orm";
import type { OutletId, ScopedTenantContext } from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { edgeNodes } from "../db/schema/edge-node.ts";
import {
  enqueueEdgeEvent,
  type EdgeTx,
} from "../services/edge-queue.service.ts";

/**
 * Queues one `wifi_quota.updated` envelope for every active edge node of the
 * outlet. Only the node that holds the session's grant acts on it (a node
 * without a grant for the session consumes it as a no-op), so a stale
 * heartbeat of the primary can never send the change to the wrong node alone.
 * Returns how many nodes it was queued for (0: the outlet has no edge node).
 */
export async function forwardWifiQuotaToEdge(
  tx: EdgeTx,
  context: ScopedTenantContext,
  event: EventEnvelope,
): Promise<number> {
  if (!event.outletId) return 0;
  const nodes = await tx
    .select({ id: edgeNodes.id })
    .from(edgeNodes)
    .where(
      and(
        eq(edgeNodes.tenantId, context.tenant.tenantId),
        eq(edgeNodes.outletId, event.outletId as OutletId),
        eq(edgeNodes.status, "active"),
      ),
    );
  for (const node of nodes) {
    await enqueueEdgeEvent(tx, context, {
      edgeNodeId: node.id,
      direction: "cloud_to_edge",
      // Full state (absolute quota) and "newest sequence wins": a replayed or
      // reordered older event is skipped by the receiver, never applied.
      kind: "master_data",
      event,
    });
  }
  return nodes.length;
}
