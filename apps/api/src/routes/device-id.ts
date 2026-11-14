// The signed device id of a request (TEN-02): the `X-Device-Token` header,
// only when its signature is valid and it names this request's tenant. A
// client-claimed device is never trusted; anything else is null.
//
// A signature alone does not prove the token is still current: a reissue
// replaces every older token and a revocation ends them all. Routes that act
// as the device (acting cashier, POS overrides) use `registeredDeviceIdOf`,
// which also asks the device registry on every request (second-opinion 495).

import { eq } from "drizzle-orm";
import type { Request } from "express";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { db } from "../db";
import { tenants } from "../db/schema";
import { getEdgeRuntimeState } from "../edge/runtime.ts";
import { HttpError } from "../lib/http-error.ts";
import { verifyDeviceToken } from "../lib/device-token.ts";
import { getTenantContext } from "../middleware/tenant.ts";
import { deviceTenantCredential } from "../services/platform-tenant.service.ts";

/** Error code for a sent device token the registry no longer accepts; the web client clears its stored token on it. */
export const DEVICE_TOKEN_INVALID = "DEVICE_TOKEN_INVALID";

/** The signed device id, only when the token names this request's tenant. */
export function deviceIdOf(req: Request): string | null {
  const raw = req.get(DEVICE_TOKEN_HEADER);
  const payload = raw ? verifyDeviceToken(raw) : null;
  if (
    payload === null ||
    payload.tenantId.toLowerCase() !==
      getTenantContext(req).tenantId.toLowerCase()
  )
    return null;
  return payload.deviceId;
}

/** The `iat` (epoch seconds) of the request's verified device token, else null. Signature check only, like deviceIdOf. */
export function deviceTokenIssuedAtOf(req: Request): number | null {
  const raw = req.get(DEVICE_TOKEN_HEADER);
  const payload = raw ? verifyDeviceToken(raw) : null;
  return payload === null ? null : payload.issuedAt;
}

/**
 * The signed device id, only while the registry still accepts this token:
 * device active and not revoked, token not rotated out (`issuedAt` at or after
 * `token_issued_at`), tenant active and, on an edge node, this node's outlet
 * (deviceTenantCredential). An old-generation token is null, like no token.
 */
export async function registeredDeviceIdOf(
  req: Request,
): Promise<string | null> {
  const deviceId = deviceIdOf(req);
  if (deviceId === null) return null;
  return (await deviceTenantCredential(req)) === null ? null : deviceId;
}

/**
 * True when the registry cannot vouch for a validly signed token for reasons
 * that say nothing about the token itself: the tenant is not active, or this
 * is an edge process without its node identity (deviceTenantCredential). The
 * client must keep its token then, so these answer UNAUTHORIZED.
 */
async function deviceRegistryUnavailable(req: Request): Promise<boolean> {
  if (getEdgeRuntimeState().edgeMode && !getEdgeRuntimeState().identity)
    return true;
  const [tenant] = await db
    .select({ status: tenants.status })
    .from(tenants)
    .where(eq(tenants.id, getTenantContext(req).tenantId))
    .limit(1);
  return tenant?.status !== "active";
}

/**
 * The device a POS request acts on (PIN throttle, shift and order audit): null
 * without a device token; 401 when one is sent but the registry no longer
 * accepts it, checked on every request so an old-generation token cannot be
 * replayed (second-opinion 495). The code is DEVICE_TOKEN_INVALID (the web
 * client then clears its token) only for a token that is badly signed, expired,
 * of another tenant, or whose device is revoked, rotated out or unknown; an
 * inactive tenant or an edge process without identity stays UNAUTHORIZED and
 * the token is kept.
 */
export async function currentDeviceIdOf(req: Request): Promise<string | null> {
  if (req.get(DEVICE_TOKEN_HEADER) === undefined) return null;
  const deviceId = await registeredDeviceIdOf(req);
  if (deviceId !== null) return deviceId;
  if (deviceIdOf(req) !== null && (await deviceRegistryUnavailable(req)))
    throw new HttpError(
      401,
      "UNAUTHORIZED",
      "Perangkat belum bisa diverifikasi. Coba lagi nanti.",
    );
  throw new HttpError(
    401,
    DEVICE_TOKEN_INVALID,
    "Token perangkat ini tidak berlaku lagi. Daftarkan ulang perangkat.",
  );
}
