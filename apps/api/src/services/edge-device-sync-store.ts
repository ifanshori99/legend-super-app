// Edge-side checkpoint of the device registry pull (bead legend-2lp.7; PRD
// v1.7 §3 F5 Registri Perangkat, EDG-02, EDG-03, TEN-02/TEN-03). The edge
// pulls `GET /api/edge-sync/device-records` periodically
// (edge/device-registry-puller.ts); this table row remembers the watermark
// that `pullDeviceRegistry` returned and when the pull finished. The staff pin
// pull (legend-yvhw8, edge/staff-pin-pull.ts) keeps its own row of the same
// table under stream `staff_pins`; both share the load/save below.
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
import type { CatalogSyncStream } from "@starter/shared/edge";
import { db } from "../db/index.ts";
import { edgeNodes, edgePullCheckpoints } from "../db/schema/edge-node.ts";
import { withTenant } from "../db/tenant.ts";
import {
  catalogOverrideNow,
  isCatalogOverrideClockReady,
} from "../edge/catalog-override.ts";

type Database = Parameters<typeof withTenant>[0];

export type EdgePullStream =
  | "device_registry"
  | "staff_pins"
  | `catalog:${CatalogSyncStream}`
  | `catalog:identity:${EdgeIdentityStream}`;

export type DeviceRegistryCheckpoint = {
  watermark: string | null;
  lastSuccessAt: Date | null;
};

export type EdgePullCheckpoint = DeviceRegistryCheckpoint;

/** No row yet (first boot) is `{ watermark: null, lastSuccessAt: null }`. */
export async function loadEdgePullCheckpoint(
  context: ScopedTenantContext,
  edgeNodeId: string,
  stream: EdgePullStream,
): Promise<EdgePullCheckpoint> {
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
          eq(edgePullCheckpoints.stream, stream),
        ),
      )
      .limit(1),
  );
  return row
    ? { watermark: row.watermark, lastSuccessAt: row.lastSuccessAt }
    : { watermark: null, lastSuccessAt: null };
}

/** Upsert; the node row must exist (the foreign key refuses anything else). */
export async function saveEdgePullCheckpoint(
  context: ScopedTenantContext,
  edgeNodeId: string,
  stream: EdgePullStream,
  input: { watermark: string | null; succeededAt: Date },
  database: Database = db,
): Promise<void> {
  await withTenant(database, context, async (tx) => {
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
        stream,
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

export function loadDeviceRegistryCheckpoint(
  context: ScopedTenantContext,
  edgeNodeId: string,
): Promise<DeviceRegistryCheckpoint> {
  return loadEdgePullCheckpoint(context, edgeNodeId, "device_registry");
}

export async function saveDeviceRegistryCheckpoint(
  context: ScopedTenantContext,
  edgeNodeId: string,
  input: { watermark: string | null; succeededAt: Date },
): Promise<void> {
  await saveEdgePullCheckpoint(context, edgeNodeId, "device_registry", input);
  await stampEdgeIdentityPull(context, edgeNodeId, "device_registry");
}

export function loadStaffPinCheckpoint(
  context: ScopedTenantContext,
  edgeNodeId: string,
): Promise<EdgePullCheckpoint> {
  return loadEdgePullCheckpoint(context, edgeNodeId, "staff_pins");
}

export async function saveStaffPinCheckpoint(
  context: ScopedTenantContext,
  edgeNodeId: string,
  input: { watermark: string | null; succeededAt: Date },
): Promise<void> {
  await saveEdgePullCheckpoint(context, edgeNodeId, "staff_pins", input);
  await stampEdgeIdentityPull(context, edgeNodeId, "staff_pins");
}

// ---- identity stamps (E2, brief 1269 decision 5) ------------------------------
// When each identity pull last succeeded by the TRUSTED clock, the clock the
// 72 h limit is measured with (edge/identity-freshness.ts). Apart from
// `lastSuccessAt` above, which is the puller's wall clock: after a wall clock
// jump that was set back, the two are hours apart for good.

export type EdgeIdentityStream = "device_registry" | "staff_pins" | "people";

type PendingStamp = {
  readonly context: ScopedTenantContext;
  readonly edgeNodeId: string;
  readonly database: Database | undefined;
  /** Monotonic, so the wait for the trusted clock is not lost. */
  readonly pulledAt: number;
};
const pendingStamps = new Map<EdgeIdentityStream, PendingStamp>();

/**
 * A pull of `stream` just succeeded. The first pulls of a boot may finish
 * before the trusted clock is installed: those wait for
 * `flushEdgeIdentityStamps`, never for a wall clock stamp.
 */
export async function stampEdgeIdentityPull(
  context: ScopedTenantContext,
  edgeNodeId: string,
  stream: EdgeIdentityStream,
  database?: Database,
): Promise<void> {
  if (!isCatalogOverrideClockReady()) {
    pendingStamps.set(stream, {
      context,
      edgeNodeId,
      database,
      pulledAt: performance.now(),
    });
    return;
  }
  pendingStamps.delete(stream);
  await saveIdentityStamp(
    context,
    edgeNodeId,
    stream,
    catalogOverrideNow(),
    database,
  );
}

/** Called by edge/runtime.ts right after it installs the trusted clock. */
export async function flushEdgeIdentityStamps(): Promise<void> {
  if (!isCatalogOverrideClockReady()) return;
  for (const [stream, pending] of [...pendingStamps]) {
    pendingStamps.delete(stream);
    await saveIdentityStamp(
      pending.context,
      pending.edgeNodeId,
      stream,
      new Date(
        catalogOverrideNow().getTime() - (performance.now() - pending.pulledAt),
      ),
      pending.database,
    );
  }
}

/** A stopped runtime must not hand its pulls to the next one. */
export function clearPendingEdgeIdentityStamps(): void {
  pendingStamps.clear();
}

const saveIdentityStamp = (
  context: ScopedTenantContext,
  edgeNodeId: string,
  stream: EdgeIdentityStream,
  at: Date,
  database: Database | undefined,
): Promise<void> =>
  saveEdgePullCheckpoint(
    context,
    edgeNodeId,
    `catalog:identity:${stream}`,
    { watermark: null, succeededAt: at },
    database,
  );

export async function loadEdgeIdentityStamp(
  context: ScopedTenantContext,
  edgeNodeId: string,
  stream: EdgeIdentityStream,
): Promise<Date | null> {
  return (
    await loadEdgePullCheckpoint(
      context,
      edgeNodeId,
      `catalog:identity:${stream}`,
    )
  ).lastSuccessAt;
}
