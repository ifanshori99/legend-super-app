import { and, eq, isNull } from "drizzle-orm";
import {
  assertOutletInScope,
  CoreError,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import { stations } from "../db/schema/menu.ts";
import { withTenant } from "../db/tenant.ts";
import { getEdgePrintAgent } from "../edge/print/runtime.ts";
import { getEdgeRuntimeState } from "../edge/runtime.ts";
import { assertStationPermission } from "./station-access.ts";

/** Only an external heartbeat reports liveness; server-side KDS reads do not. */
export async function recordKitchenStationHeartbeat(
  context: ScopedTenantContext,
  actorUserId: string,
  rawOutletId: string,
  stationId: string,
): Promise<{ recorded: boolean }> {
  const outletId = outletIdSchema.parse(rawOutletId);
  assertOutletInScope(context.outletScope, outletId);
  await withTenant(db, context, async (tx) => {
    await assertStationPermission(
      tx,
      context,
      actorUserId,
      "kds.ticket.process",
      stationId,
      new Date(),
    );
    const [station] = await tx
      .select({ id: stations.id })
      .from(stations)
      .where(
        and(
          eq(stations.tenantId, context.tenant.tenantId),
          eq(stations.outletId, outletId),
          eq(stations.id, stationId),
          isNull(stations.deletedAt),
        ),
      );
    if (!station)
      throw new CoreError("NOT_FOUND", "Stasiun dapur tidak ditemukan.");
  });
  const runtime = getEdgeRuntimeState();
  const agent = getEdgePrintAgent();
  if (
    !runtime.edgeMode ||
    !agent ||
    runtime.identity?.context.tenant.tenantId !== context.tenant.tenantId ||
    runtime.identity.scope.outletId !== outletId
  )
    return { recorded: false };
  agent.recordKdsHeartbeat(stationId);
  return { recorded: true };
}
