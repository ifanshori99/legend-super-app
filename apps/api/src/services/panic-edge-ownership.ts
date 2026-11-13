// Who may serve the emergency button of an outlet (bead legend-bod; design
// docs/design/edge-emergency.md D-01, review finding F-C). An outlet with an
// active edge node is served by that edge: the alarm must be visible to the
// edge's sockets and fallback. The cloud therefore never takes a press, opens a
// receiver session, acknowledges or opens a socket for such an outlet, or it
// would make an alarm that the edge cannot see. A cloud-only outlet (no active
// edge node) is served by the cloud as before.
import { and, eq } from "drizzle-orm";
import type { OutletId, TenantContext } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { edgeNodes } from "../db/schema/edge-node.ts";
import { withTenant } from "../db/tenant.ts";
import { getEdgeRuntimeState } from "../edge/runtime.ts";
import { HttpError } from "../lib/http-error.ts";
import { outletContext } from "./device-pin-support.ts";

/**
 * True on an edge node: the runtime flag, or the static `EDGE_MODE` setting
 * during the boot window (same rule as device-pin.service.ts).
 */
export function isPanicEdgeProcess(): boolean {
  return getEdgeRuntimeState().edgeMode || process.env.EDGE_MODE === "true";
}

/**
 * Refuses (409 EDGE_NODE_ACTIVE) when this process is the cloud and the outlet
 * has an active edge node. Does nothing on an edge or for a cloud-only outlet.
 */
export async function refuseWhenEdgeServesOutlet(
  tenant: TenantContext,
  outletId: string,
): Promise<void> {
  if (isPanicEdgeProcess()) return;
  const [node] = await withTenant(db, outletContext(tenant, outletId), (tx) =>
    tx
      .select({ id: edgeNodes.id })
      .from(edgeNodes)
      .where(
        and(
          eq(edgeNodes.tenantId, tenant.tenantId),
          eq(edgeNodes.outletId, outletId as OutletId),
          eq(edgeNodes.status, "active"),
        ),
      )
      .limit(1),
  );
  if (node)
    throw new HttpError(
      409,
      "EDGE_NODE_ACTIVE",
      "Outlet ini dilayani server lokal. Gunakan server lokal untuk tombol darurat.",
    );
}
