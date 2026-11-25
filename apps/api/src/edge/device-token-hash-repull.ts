// Device token digests an edge missed (E2, brief 1269, review P2-1). A cloud that
// refused the opt-in (400 fallback, edge/cloud-http.ts) left rows without
// `token_hash` and moved the cursor past them, so their devices answer 503 until
// the rows come again. Once per boot, while such a device exists, the registry
// is pulled from the start.
import { and, count, eq, isNotNull, isNull } from "drizzle-orm";
import { outletIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { devices } from "../db/schema/device.ts";
import { withTenant } from "../db/tenant.ts";
import type { DeviceRegistryPullerDeps } from "./device-registry-puller.ts";

/** Active devices of this edge whose newest token cannot be verified here. */
export async function countDevicesWithoutTokenHash(
  context: ScopedTenantContext,
  outletId: string,
): Promise<number> {
  const [row] = await withTenant(db, context, (tx) =>
    tx
      .select({ n: count() })
      .from(devices)
      .where(
        and(
          eq(devices.tenantId, context.tenant.tenantId),
          eq(devices.outletId, outletIdSchema.parse(outletId)),
          eq(devices.status, "active"),
          isNull(devices.revokedAt),
          isNotNull(devices.tokenIssuedAt),
          isNull(devices.tokenHash),
        ),
      ),
  );
  return row?.n ?? 0;
}

/** Wraps the registry puller's `pull`. One instance per boot. */
export function withTokenHashRepull(
  context: ScopedTenantContext,
  outletId: string,
  pull: DeviceRegistryPullerDeps["pull"],
): DeviceRegistryPullerDeps["pull"] {
  let done = false;
  return async (since, signal) => {
    const restart =
      !done &&
      since !== null &&
      (await countDevicesWithoutTokenHash(context, outletId)) > 0;
    const result = await pull(restart ? null : since, signal);
    if (restart) done = true;
    return result;
  };
}
