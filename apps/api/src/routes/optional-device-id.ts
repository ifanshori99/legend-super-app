// The signed device id of a request, only when it carries a valid token for the
// resolved tenant (bead legend-vfj7z). Shared by the routes whose approver PIN
// check runs under the per-device window.
import type { Request } from "express";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { verifyDeviceToken } from "../lib/device-token";
import { getTenantContext } from "../middleware/tenant";

/**
 * Null for a signed-in staff browser (no device token, or one for another
 * tenant): there is no device to count then.
 */
export function optionalDeviceIdOf(req: Request): string | null {
  const tenant = getTenantContext(req);
  const raw = req.get(DEVICE_TOKEN_HEADER);
  const payload = raw ? verifyDeviceToken(raw) : null;
  if (
    tenant.source !== "device" ||
    payload === null ||
    payload.tenantId.toLowerCase() !== tenant.tenantId.toLowerCase()
  )
    return null;
  return payload.deviceId;
}
