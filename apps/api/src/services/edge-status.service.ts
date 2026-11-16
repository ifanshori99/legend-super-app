// GET /api/edge/status (bead legend-2pi; contract `getEdgeStatus` in
// @starter/shared/edge, PRD v1.7 §4 Alur F step 1: staff devices show the
// offline state; §5 Sinkronisasi backlog). Served by the edge node for its
// own outlet only: tenant and outlet come from the node's credential at boot,
// never from the request (TEN-02).
//
//   cloudLink         the link client's state (connected / disconnected)
//   edgeNode          the node's own registry row
//   pendingEventCount offline queue backlog edge -> cloud (unacknowledged)
//   lastSyncedAt      when the cloud last acknowledged the edge's events
//   deviceRegistry    last successful device-registry pull and whether the
//                     replica is stale (legend-2lp.7; revocations may be missing)
//                     and whether it is past the hard limit (legend-2lgu:
//                     hardStale, maxStaleSeconds; new device sessions refused)
//   thisDevice        the calling device from the device registry port
//                     (legend-165); null until it is wired or for a session
import { edgeStatusSchema, type EdgeStatus } from "@starter/shared/edge";
import type { CloudLink } from "@starter/shared/edge";
import type { ScopedTenantContext } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { getDeviceRegistrySyncState } from "../edge/runtime.ts";
import { DEFAULT_DEVICE_REGISTRY_MAX_STALE_SECONDS } from "../edge/config.ts";
import { lookupEdgeDevice } from "../edge/ports.ts";
import type { LinkScope } from "../edge/link-peer.ts";
import { getEdgeNode } from "./edge-node.service.ts";
import { edgeQueueBacklog } from "./edge-queue.service.ts";

export async function getEdgeStatus(input: {
  context: ScopedTenantContext;
  scope: LinkScope;
  cloudLink: CloudLink;
  deviceId: string | null;
}): Promise<EdgeStatus> {
  const { context, scope } = input;
  const [edgeNode, backlog, device] = await Promise.all([
    getEdgeNode(context, scope.edgeNodeId),
    edgeQueueBacklog(db, context, scope.edgeNodeId, "edge_to_cloud"),
    input.deviceId ? lookupEdgeDevice(context, input.deviceId) : null,
  ]);
  // A device of another outlet is never "this device" here.
  const thisDevice =
    device &&
    device.tenantId === scope.tenantId &&
    device.outletId === scope.outletId
      ? device
      : null;
  // No pull state (cloud, or before boot) counts as stale: fail visible.
  const registry = getDeviceRegistrySyncState();
  return edgeStatusSchema.parse({
    tenantId: scope.tenantId,
    outletId: scope.outletId,
    cloudLink: input.cloudLink,
    edgeNode,
    pendingEventCount: backlog.pending,
    lastSyncedAt: backlog.lastAckedAt?.toISOString() ?? null,
    deviceRegistry: {
      lastPulledAt: registry?.lastSuccessAt ?? null,
      stale: registry?.stale ?? true,
      // legend-2lgu: no pull state (cloud, or before boot) is never hard
      // stale; only an edge that has been running past the limit is.
      hardStale: registry?.hardStale ?? false,
      maxStaleSeconds:
        registry && registry.maxStaleSeconds > 0
          ? registry.maxStaleSeconds
          : DEFAULT_DEVICE_REGISTRY_MAX_STALE_SECONDS,
      receiptSequencesRefused: registry?.receiptSequencesRefused ?? 0,
      receiptSequencesRefusedAt: registry?.receiptSequencesRefusedAt ?? null,
      receiptRunAlert: registry?.receiptRunAlert ?? false,
      receiptRunAlertAt: registry?.receiptRunAlertAt ?? null,
      receiptSequencesRetired: registry?.receiptSequencesRetired ?? 0,
      receiptSequencesRetiredAt: registry?.receiptSequencesRetiredAt ?? null,
    },
    thisDevice,
  });
}
