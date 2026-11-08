// Tenant resolution sources for the API (TEN-02: "tenant ditentukan dari
// domain atau token, bukan dari parameter klien").
//
// - Domain: `resolveHostname` matches a verified, active `tenant_domains` row.
// - Device token: an HMAC-signed credential names its tenant and brand; the
//   tenant must be active, so a suspended or archived tenant resolves nothing,
//   and the device must still be an active registry row of that tenant with an
//   unrotated token (services/device-registry-check.ts, legend-165). On an edge
//   node the device must also belong to the node's outlet.
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
import { getEdgeRuntimeState } from "../edge/runtime.ts";
import { findActiveDeviceForToken } from "./device-registry-check.ts";

export type ResolvedTenant = { tenantId: string; brandId: string | null };
export type VerifiedCredential = ResolvedTenant & {
  source: "session" | "device" | "mcp_token";
};

/**
 * Verified outlet-device credential. Returns null for an absent, malformed,
 * expired or foreign token, for a tenant that is not active, and for a device
 * that is unknown, revoked, rotated out or (edge) of another outlet, so a
 * revoked device or suspended tenant falls back to "no tenant" rather than
 * another one.
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
  const runtime = getEdgeRuntimeState();
  // Edge process without its node identity cannot tell whose outlet this is.
  if (runtime.edgeMode && !runtime.identity) return null;
  if (
    runtime.identity &&
    runtime.identity.scope.tenantId.toLowerCase() !==
      payload.tenantId.toLowerCase()
  )
    return null;
  const device = await findActiveDeviceForToken(
    payload,
    runtime.identity ? { outletId: runtime.identity.scope.outletId } : {},
  );
  if (!device) return null;
  return {
    tenantId: payload.tenantId,
    brandId: payload.brandId,
    source: "device",
  };
}
