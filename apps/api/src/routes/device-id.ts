// The signed device id of a request (TEN-02): the `X-Device-Token` header,
// only when its signature is valid and it names this request's tenant. A
// client-claimed device is never trusted; anything else is null.

import type { Request } from "express";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { verifyDeviceToken } from "../lib/device-token.ts";
import { getTenantContext } from "../middleware/tenant.ts";

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
