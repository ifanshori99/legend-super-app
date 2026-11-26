// Who serves an outlet's POS (1269 E3): the cloud, or the outlet's own edge.
// An outlet with an active primary edge sells, runs its drawers and opens its
// shifts on that edge ONLY (one cashier writer, PRD F5). A cloud write there
// would put a second sale or a second drawer beside the edge's, so the cloud
// refuses it, also while the edge is unreachable: selling in the cloud is never
// a shortcut for a dead edge (EDG-04 is the failover path). Any active node
// counts (same rule as pos-receipt): in doubt the cloud refuses. An outlet
// without an active edge node (none, revoked) is unchanged.
import { and, eq } from "drizzle-orm";
import type {
  OutletId,
  ScopedTenantContext,
  TenantId,
} from "@starter/shared/core";
import { PosError } from "@starter/shared/pos";
import { db } from "../db/index.ts";
import { edgeNodes } from "../db/schema/edge-node.ts";
import { tableSessions } from "../db/schema/floor.ts";
import { withTenant } from "../db/tenant.ts";
import { getEdgeRuntimeState } from "../edge/runtime.ts";
import type { Tx } from "./permission-resolver.ts";

/** Same rule as pos-receipt: static EDGE_MODE counts in the boot window. */
export function isEdgeProcess(): boolean {
  return getEdgeRuntimeState().edgeMode || process.env.EDGE_MODE === "true";
}

export async function outletHasActiveEdge(
  tx: Tx,
  tenantId: TenantId,
  outletId: OutletId,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: edgeNodes.id })
    .from(edgeNodes)
    .where(
      and(
        eq(edgeNodes.tenantId, tenantId),
        eq(edgeNodes.outletId, outletId),
        eq(edgeNodes.status, "active"),
      ),
    )
    .limit(1);
  return row !== undefined;
}

let isEdgeWriter: () => boolean = isEdgeProcess;

/** Test hook (like setSalesGateEdgeModeForTests); null restores the default. */
export function setPosWriteGateEdgeModeForTests(
  fn: (() => boolean) | null,
): void {
  isEdgeWriter = fn ?? isEdgeProcess;
}

/** 409 POS_WRITE_ON_EDGE for a cloud write on an outlet its edge serves. */
export async function assertPosWriteNotOnEdge(
  tx: Tx,
  tenantId: TenantId,
  outletId: OutletId,
): Promise<void> {
  if (isEdgeWriter()) return;
  if (await outletHasActiveEdge(tx, tenantId, outletId))
    throw new PosError("POS_WRITE_ON_EDGE");
}

/**
 * 409 POS_WRITE_ON_EDGE for a table session of an outlet its edge serves. Call
 * after the permission check with the caller's scoped context: a session the
 * caller cannot see is left to the route's own 404.
 */
export async function assertTableSessionNotOnEdge(
  context: ScopedTenantContext,
  sessionId: string,
): Promise<void> {
  if (isEdgeWriter()) return;
  const tenantId = context.tenant.tenantId;
  await withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select({ outletId: tableSessions.outletId })
      .from(tableSessions)
      .where(
        and(
          eq(tableSessions.tenantId, tenantId),
          eq(tableSessions.id, sessionId),
        ),
      )
      .limit(1);
    if (row) await assertPosWriteNotOnEdge(tx, tenantId, row.outletId);
  });
}

/** 409 POS_WRITE_ON_EDGE for an outlet its edge serves (after the permission check). */
export async function assertOutletNotOnEdge(
  context: ScopedTenantContext,
  outletId: OutletId,
): Promise<void> {
  if (isEdgeWriter()) return;
  await withTenant(db, context, (tx) =>
    assertPosWriteNotOnEdge(tx, context.tenant.tenantId, outletId),
  );
}
