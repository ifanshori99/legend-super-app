// Outlet-scoped guest context for the table-session routes (TEN-03,
// legend-7csf). The guest holds an opaque session credential from the scan
// (ORD-04); the session row names the outlet. Step one resolves the credential
// by its hash under a tenant-wide read (no outlet is known yet, the same shape
// as payment link tokens), step two mints the context limited to that one
// outlet, so outlet RLS also backstops every guest read and write. The outlet
// is never taken from the client.

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { CoreError, outletIdSchema } from "@starter/shared/core";
import type { ScopedTenantContext, TenantContext } from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import { tableSessions } from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";

/**
 * Unknown credential: the same UNAUTHORIZED the session services answer, so
 * this extra step is no oracle. Whether the session is still open is left to
 * the service (it refuses closed sessions and path ids that do not match).
 */
export async function guestSessionContext(
  tenant: TenantContext,
  credential: string,
): Promise<ScopedTenantContext> {
  const unknown = () =>
    new CoreError(
      "UNAUTHORIZED",
      "Sesi meja tidak dikenali; pindai QR meja lagi.",
    );
  if (credential.length < 20 || credential.length > 256) throw unknown();
  const hash = createHash("sha256").update(credential, "utf8").digest("hex");
  const lookup = establishScopedTenantContext(tenant, { kind: "tenant" });
  const row = await withTenant(db, lookup, async (tx) => {
    const [found] = await tx
      .select({ outletId: tableSessions.outletId })
      .from(tableSessions)
      .where(
        and(
          eq(tableSessions.tenantId, tenant.tenantId),
          eq(tableSessions.sessionTokenHash, hash),
        ),
      )
      .limit(1);
    return found;
  });
  if (!row) throw unknown();
  return establishScopedTenantContext(tenant, {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(row.outletId)],
  });
}
