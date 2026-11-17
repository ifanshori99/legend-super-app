// One rule for admitting a device session on an edge whose device-registry
// replica may be missing a revocation (legend-2lgu, legend-91u09). Shared by
// the device credential check (deviceTenantCredential: every device endpoint)
// and the heartbeat, so no endpoint can skip it. Kept in its own file because
// both device.service.ts and platform-tenant.service.ts need it.
//
// Replica status (getDeviceRegistryStatus):
//   fresh     -> admit.
//   stale     -> refuse 503 EDGE_DEVICE_REGISTRY_STALE, except a running session.
//   not_ready -> admit only a running session, and the caller must not move
//                lastSeenAt (the replica has not been judged yet).
// A running session is a device whose last heartbeat is within
// DEVICE_LIVE_SESSION_WINDOW_MS. A refusal is an HttpError 503, never null, so
// it does not fall through to a 401 that would clear the device's token.
import { and, eq, isNull, lt, or } from "drizzle-orm";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import { devices } from "../db/schema/device.ts";
import { withTenant } from "../db/tenant.ts";
import {
  getDeviceRegistryStatus,
  reportDeviceRegistryHardStale,
} from "../edge/runtime.ts";
import { HttpError } from "../lib/http-error.ts";
import { logger } from "../lib/logger.ts";

/** A heartbeat this recent means the device already has a running session. */
export const DEVICE_LIVE_SESSION_WINDOW_MS = 5 * 60_000;

/** Activity writes to devices.last_seen_at are throttled to one per this window. */
export const DEVICE_ACTIVITY_THROTTLE_MS = 60_000;

export const EDGE_DEVICE_REGISTRY_STALE_CODE = "EDGE_DEVICE_REGISTRY_STALE";

export function deviceRegistryStaleError(): HttpError {
  return new HttpError(
    503,
    EDGE_DEVICE_REGISTRY_STALE_CODE,
    "Data perangkat di edge sudah terlalu lama tidak diperbarui dari cloud. Sambungkan edge ke cloud, lalu coba lagi.",
  );
}

/**
 * Admit or refuse a device session. Returns the replica status when admitted;
 * "not_ready" tells the heartbeat to skip its lastSeenAt write. Alerts the
 * outlet's supervisors (once a day) on a stale refusal.
 */
export async function assertDeviceSessionAdmitted(
  device: { readonly lastSeenAt: Date | null },
  now: Date,
): Promise<"fresh" | "not_ready" | "stale"> {
  const status = getDeviceRegistryStatus(now);
  if (status === "fresh") return status;
  // A lastSeenAt in the future (clock skew, bad write) proves no session.
  const hasLiveSession =
    device.lastSeenAt !== null &&
    device.lastSeenAt.getTime() <=
      now.getTime() + DEVICE_ACTIVITY_THROTTLE_MS &&
    now.getTime() - device.lastSeenAt.getTime() <=
      DEVICE_LIVE_SESSION_WINDOW_MS;
  if (hasLiveSession) return status;
  if (status === "stale") await reportDeviceRegistryHardStale(now);
  throw deviceRegistryStaleError();
}

/**
 * Record that an admitted device request happened, so a device that never
 * sends a heartbeat (the web app) still shows a running session. Throttled in
 * JS (device.lastSeenAt) and in SQL: only a row quiet for
 * DEVICE_ACTIVITY_THROTTLE_MS is touched. A failed
 * write never fails the request. Callers skip it for a "not_ready" replica and
 * for a refused request.
 */
export async function recordDeviceActivity(
  device: { readonly id: string; readonly tenantId: string },
  brandId: string | null,
  now: Date,
): Promise<void> {
  // Throttle in JS too: skip the write (and its transaction) while the last
  // write is recent. A lastSeenAt in the future is not recent: fix it.
  if (
    device.lastSeenAt != null &&
    device.lastSeenAt.getTime() <= now.getTime() &&
    now.getTime() - device.lastSeenAt.getTime() < DEVICE_ACTIVITY_THROTTLE_MS
  )
    return;
  try {
    const context = establishScopedTenantContext(
      establishTenantContext({
        tenantId: device.tenantId,
        brandId,
        source: "device",
      }),
      { kind: "tenant" },
    );
    const quietBefore = new Date(now.getTime() - DEVICE_ACTIVITY_THROTTLE_MS);
    await withTenant(db, context, (tx) =>
      tx
        .update(devices)
        .set({ lastSeenAt: now })
        .where(
          and(
            eq(devices.tenantId, device.tenantId),
            eq(devices.id, device.id),
            or(isNull(devices.lastSeenAt), lt(devices.lastSeenAt, quietBefore)),
          ),
        ),
    );
  } catch (error) {
    // Best effort: activity bookkeeping must not fail the device's request.
    // Log the error class only: no ids, no message.
    logger.warn(
      { errName: error instanceof Error ? error.name : "Error" },
      "device activity write failed",
    );
  }
}
