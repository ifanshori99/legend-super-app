// Edge-side checkpoint of the device registry pull (bead legend-2lp.7; PRD
// v1.7 §3 F5 Registri Perangkat, EDG-02, EDG-03, TEN-02/TEN-03). The edge
// pulls `GET /api/edge-sync/device-records` periodically
// (edge/device-registry-puller.ts); this table row remembers the watermark
// that `pullDeviceRegistry` returned and when the pull finished.
//
// - The watermark cannot be derived from the replica: heartbeats of the
//   edge's own devices bump `devices.updated_at` locally.
// - Save only after `pullDeviceRegistry` returned (every page applied); a
//   failed pull never moves it, so the next pull repeats from the old one.
// - `lastSuccessAt` survives a restart, so replica staleness does too.
// - Tenant and outlet come from the node's own row, never from the caller
//   (TEN-02); the composite foreign key keeps the row on that node.
import { and, eq } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { edgeNodes, edgePullCheckpoints } from "../db/schema/edge-node.ts";
import { withTenant } from "../db/tenant.ts";

const DEVICE_REGISTRY_STREAM = "device_registry" as const;

export type DeviceRegistryCheckpoint = {
  watermark: string | null;
  lastSuccessAt: Date | null;
};

/** No row yet (first boot) is `{ watermark: null, lastSuccessAt: null }`. */
export async function loadDeviceRegistryCheckpoint(
  context: ScopedTenantContext,
  edgeNodeId: string,
): Promise<DeviceRegistryCheckpoint> {
  const [row] = await withTenant(db, context, (tx) =>
    tx
      .select({
        watermark: edgePullCheckpoints.watermark,
        lastSuccessAt: edgePullCheckpoints.lastSuccessAt,
      })
      .from(edgePullCheckpoints)
      .where(
        and(
          eq(edgePullCheckpoints.edgeNodeId, edgeNodeId),
          eq(edgePullCheckpoints.stream, DEVICE_REGISTRY_STREAM),
        ),
      )
      .limit(1),
  );
  return row
    ? { watermark: row.watermark, lastSuccessAt: row.lastSuccessAt }
    : { watermark: null, lastSuccessAt: null };
}

/** Upsert; the node row must exist (the foreign key refuses anything else). */
export async function saveDeviceRegistryCheckpoint(
  context: ScopedTenantContext,
  edgeNodeId: string,
  input: { watermark: string | null; succeededAt: Date },
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    const [node] = await tx
      .select({ tenantId: edgeNodes.tenantId, outletId: edgeNodes.outletId })
      .from(edgeNodes)
      .where(eq(edgeNodes.id, edgeNodeId))
      .limit(1);
    if (!node) throw new Error("Edge node not found for checkpoint");
    await tx
      .insert(edgePullCheckpoints)
      .values({
        tenantId: node.tenantId,
        outletId: node.outletId,
        edgeNodeId,
        stream: DEVICE_REGISTRY_STREAM,
        watermark: input.watermark,
        lastSuccessAt: input.succeededAt,
      })
      .onConflictDoUpdate({
        target: [
          edgePullCheckpoints.tenantId,
          edgePullCheckpoints.edgeNodeId,
          edgePullCheckpoints.stream,
        ],
        set: {
          watermark: input.watermark,
          lastSuccessAt: input.succeededAt,
          updatedAt: new Date(),
        },
      });
  });
}
