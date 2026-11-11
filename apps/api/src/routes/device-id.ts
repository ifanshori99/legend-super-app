// The signed device id of a request (TEN-02): the `X-Device-Token` header,
// only when its signature is valid and it names this request's tenant. A
// client-claimed device is never trusted; anything else is null.
//
// A signature alone does not prove the token is still current: a reissue
// replaces every older token and a revocation ends them all. Routes that act
// as the device (acting cashier, POS overrides) use `registeredDeviceIdOf`,
// which also asks the device registry on every request (second-opinion 495).

import type { Request } from "express";
import { CoreError } from "@starter/shared/core";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { verifyDeviceToken } from "../lib/device-token.ts";
import { getTenantContext } from "../middleware/tenant.ts";
import { deviceTenantCredential } from "../services/platform-tenant.service.ts";

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
 * The device a POS request acts on (PIN throttle, shift and order audit): null
 * without a device token; 401 when one is sent but the registry no longer
 * accepts it (revoked, rotated out, another tenant), checked on every request
 * so an old-generation token cannot be replayed (second-opinion 495).
 */
export async function currentDeviceIdOf(req: Request): Promise<string | null> {
  if (req.get(DEVICE_TOKEN_HEADER) === undefined) return null;
  const deviceId = await registeredDeviceIdOf(req);
  if (deviceId === null)
    throw new CoreError(
      "UNAUTHORIZED",
      "Token perangkat ini tidak berlaku lagi. Daftarkan ulang perangkat.",
    );
  return deviceId;
}
