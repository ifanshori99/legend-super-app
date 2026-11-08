// Registry check for a verified device token (bead legend-165; PRD v1.7 §3 F5
// Registri Perangkat, EDG-03, TEN-02). A valid signature proves the server
// minted the token; it does not prove the device is still allowed. This is the
// second half: the token is accepted only while the device row exists in the
// LOCAL database (the cloud's, or the edge node's replica), under the token's
// own tenant, and is
//   - status 'active' and not revoked (revocation is terminal), and
//   - not rotated out: `payload.issuedAt` is at or after the whole second of
//     `token_issued_at`, so a reissue invalidates every older token, and
//   - on an edge node, a device of THIS node's outlet.
// An unknown device, a row without `token_issued_at` and any mismatch are the
// same answer (null): fail closed, no oracle for the caller. Reads only the
// local database, so an edge node needs no cloud call to reject a revoked
// device once the replica carries the revocation.
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { outletIdSchema } from "@starter/shared/core";
import type { DeviceTokenPayload } from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { devices } from "../db/schema/device.ts";
import { withTenant } from "../db/tenant.ts";

export type RegisteredDevice = typeof devices.$inferSelect;

export type DeviceRegistryCheckOptions = {
  /** Edge node: the device must belong to this outlet. */
  readonly outletId?: string;
};

/**
 * The active registry row a token may act as, or null. The query runs under a
 * tenant-wide scope of the token's tenant, so RLS already hides other tenants'
 * rows; the explicit tenant predicate is the second line.
 */
export async function findActiveDeviceForToken(
  payload: DeviceTokenPayload,
  opts: DeviceRegistryCheckOptions = {},
): Promise<RegisteredDevice | null> {
  const tenant = establishTenantContext({
    tenantId: payload.tenantId,
    brandId: payload.brandId,
    source: "device",
  });
  const context = establishScopedTenantContext(tenant, { kind: "tenant" });
  const [row] = await withTenant(db, context, (tx) =>
    tx
      .select()
      .from(devices)
      .where(
        and(
          eq(devices.tenantId, payload.tenantId),
          eq(devices.id, payload.deviceId),
          eq(devices.status, "active"),
          isNull(devices.revokedAt),
          // NULL floor (never issued) matches nothing: fail closed.
          sql`floor(extract(epoch from ${devices.tokenIssuedAt})) <= ${payload.issuedAt}`,
          opts.outletId === undefined
            ? undefined
            : eq(devices.outletId, outletIdSchema.parse(opts.outletId)),
        ),
      )
      .limit(1),
  );
  return row ?? null;
}
