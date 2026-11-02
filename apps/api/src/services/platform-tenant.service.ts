// Tenant resolution sources for the API (TEN-02: "tenant ditentukan dari
// domain atau token, bukan dari parameter klien").
//
// - Domain: `resolveHostname` matches a verified, active `tenant_domains` row.
// - Device token: an HMAC-signed credential names its tenant and brand; the
//   tenant must be active, so a suspended or archived tenant resolves nothing.
//
// There is deliberately no session-to-tenant lookup: a Better Auth session is
// user-scoped and carries no tenant, so the tenant of a signed-in request still
// comes from the host it was sent to. Role assignments (legend-4f9) add the
// tenant membership check; they do not invent a second tenant source.
import { eq } from "drizzle-orm";
import type { Request } from "express";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { db } from "../db";
import { tenants } from "../db/schema";
import { verifyDeviceToken } from "../lib/device-token";

export type ResolvedTenant = { tenantId: string; brandId: string | null };
export type VerifiedCredential = ResolvedTenant & {
  source: "session" | "device" | "mcp_token";
};

/**
 * Verified outlet-device credential. Returns null for an absent, malformed,
 * expired or foreign token, and for a tenant that is not active, so a revoked
 * device or suspended tenant falls back to "no tenant" rather than another one.
 */
export async function deviceTenantCredential(
  req: Request,
): Promise<VerifiedCredential | null> {
  const raw = req.get(DEVICE_TOKEN_HEADER);
  if (!raw) return null;
  const payload = verifyDeviceToken(raw);
  if (!payload) return null;
  const [tenant] = await db
    .select({ status: tenants.status })
    .from(tenants)
    .where(eq(tenants.id, payload.tenantId))
    .limit(1);
  if (tenant?.status !== "active") return null;
  return {
    tenantId: payload.tenantId,
    brandId: payload.brandId,
    source: "device",
  };
}
