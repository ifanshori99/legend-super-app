// The 72 h limit of staff identity on an outlet edge (E2, brief 1269 decision
// 5): past 72 h since the last successful pull of the device registry, the
// staff PINs or the people snapshot, by the trusted clock, the edge opens no
// new login (PIN session, cashier switch) and accepts no override, because a
// revocation may be missing. The pulls are stamped with the same trusted clock
// (services/edge-device-sync-store.ts). Running sessions keep working until they end.
// No-op on the cloud. Anything that cannot be judged refuses.
import { HttpError } from "../lib/http-error.ts";
import { loadEdgeIdentityStamp } from "../services/edge-device-sync-store.ts";
import {
  catalogOverrideNow,
  isCatalogOverrideClockReady,
} from "./catalog-override.ts";
import { isEdgeNode } from "./mode.ts";
import { getEdgeRuntimeState } from "./runtime.ts";

export const EDGE_IDENTITY_MAX_STALE_MS = 72 * 60 * 60 * 1000;
/** A crash can lose the last seconds of the trusted clock's high water. */
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
  for (const stream of ["device_registry", "staff_pins", "people"] as const) {
    const at = await loadEdgeIdentityStamp(context, scope.edgeNodeId, stream);
    const age = at === null ? NaN : now - at.getTime();
    if (!(age >= -FUTURE_TOLERANCE_MS && age <= EDGE_IDENTITY_MAX_STALE_MS))
      throw staleError();
  }
}
