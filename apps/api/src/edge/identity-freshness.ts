// The 72 h limit of staff identity on an outlet edge (E2, brief 1269 decision
// 5): past 72 h since the last successful pull of the device registry, the
// staff PINs or the people snapshot, by the trusted clock, the edge opens no
// new login (PIN session, cashier switch) and accepts no override, because a
// revocation may be missing. Running sessions keep working until they end.
// No-op on the cloud. Anything that cannot be judged refuses.
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { edgePeopleSyncState } from "../db/schema/edge-hris.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  loadDeviceRegistryCheckpoint,
  loadStaffPinCheckpoint,
} from "../services/edge-device-sync-store.ts";
import {
  catalogOverrideNow,
  isCatalogOverrideClockReady,
} from "./catalog-override.ts";
import { isEdgeNode } from "./mode.ts";
import { getEdgeRuntimeState } from "./runtime.ts";
import { outletIdSchema } from "@starter/shared/core";

export const EDGE_IDENTITY_MAX_STALE_MS = 72 * 60 * 60 * 1000;
/** The pull stamps use the wall clock; a little skew is not "the future". */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

function staleError(): HttpError {
  return new HttpError(
    503,
    "EDGE_IDENTITY_STALE",
    "Data staf dan perangkat di server lokal sudah lebih dari 72 jam tidak diperbarui dari cloud. Sambungkan internet, lalu coba lagi.",
  );
}

export async function assertEdgeIdentityFresh(): Promise<void> {
  if (!isEdgeNode()) return;
  const { edgeMode, identity } = getEdgeRuntimeState();
  if (!edgeMode || !identity || !isCatalogOverrideClockReady())
    throw staleError();
  const now = catalogOverrideNow().getTime();
  const { context, scope } = identity;
  const registry = await loadDeviceRegistryCheckpoint(
    context,
    scope.edgeNodeId,
  );
  const pins = await loadStaffPinCheckpoint(context, scope.edgeNodeId);
  const [people] = await withTenant(db, context, (tx) =>
    tx
      .select({ lastCheckedAt: edgePeopleSyncState.lastCheckedAt })
      .from(edgePeopleSyncState)
      .where(
        and(
          eq(edgePeopleSyncState.tenantId, context.tenant.tenantId),
          eq(
            edgePeopleSyncState.outletId,
            outletIdSchema.parse(scope.outletId),
          ),
        ),
      )
      .limit(1),
  );
  for (const at of [
    registry.lastSuccessAt,
    pins.lastSuccessAt,
    people?.lastCheckedAt ?? null,
  ]) {
    const age = at === null ? NaN : now - at.getTime();
    if (!(age >= -FUTURE_TOLERANCE_MS && age <= EDGE_IDENTITY_MAX_STALE_MS))
      throw staleError();
  }
}
