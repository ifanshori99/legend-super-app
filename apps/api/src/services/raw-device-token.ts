// Device token of a raw Node request (a WebSocket upgrade never passes through
// Express, so there is no `req.get`). Same rules as routes/device-id.ts
// `deviceIdOf` / `registeredDeviceIdOf` and
// services/platform-tenant.service.ts `deviceTenantCredential`, for
// IncomingHttpHeaders: the signature must be valid, the token must name the
// given tenant, and the device registry must still accept it (active, not
// revoked, not rotated out, tenant active, edge node: this node's outlet).
// Anything else is null (deny by default).

import type { IncomingHttpHeaders } from "node:http";
import { eq } from "drizzle-orm";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { tenants } from "../db/schema";
import { getEdgeRuntimeState } from "../edge/runtime.ts";
import { verifyDeviceToken } from "../lib/device-token.ts";
import { findActiveDeviceForToken } from "./device-registry-check.ts";

function verifiedPayload(headers: IncomingHttpHeaders, tenantId: string) {
  const raw = headers[DEVICE_TOKEN_HEADER];
  if (typeof raw !== "string" || raw === "") return null;
  const payload = verifyDeviceToken(raw);
  if (payload === null) return null;
  return payload.tenantId.toLowerCase() === tenantId.toLowerCase()
    ? payload
    : null;
}

/** The signed device id, only when the token names this tenant. Signature check only. */
export function signedDeviceIdOfHeaders(
  headers: IncomingHttpHeaders,
  tenantId: string,
): string | null {
  return verifiedPayload(headers, tenantId)?.deviceId ?? null;
}

/** The signed device id, only while the registry still accepts this token. */
export async function registeredDeviceIdOfHeaders(
  headers: IncomingHttpHeaders,
  tenantId: string,
): Promise<string | null> {
  const payload = verifiedPayload(headers, tenantId);
  if (payload === null) return null;
  const [tenant] = await db
    .select({ status: tenants.status })
    .from(tenants)
    .where(eq(tenants.id, payload.tenantId))
    .limit(1);
  if (tenant?.status !== "active") return null;
  const runtime = getEdgeRuntimeState();
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
  return device ? payload.deviceId : null;
}
