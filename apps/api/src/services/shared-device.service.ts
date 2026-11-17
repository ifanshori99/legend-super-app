// Shared-device mode (legend-f586w, legend-ypwsp). A device flagged
// `devices.shared_mode` serves several cashiers on one login session, so its
// POS requests must carry an acting-cashier token (middleware/acting-staff.ts
// requireActingStaffOnSharedDevice). A session that has been used on such a
// device is marked in `session.shared_device_id`; the mark keeps the rule when
// the same cookie is replayed without the device header. The mark lapses when
// the device is unflagged, revoked or gone.

import { and, eq, sql } from "drizzle-orm";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import type { TenantContext } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { devices, session } from "../db/schema";
import { withTenant } from "../db/tenant.ts";

/**
 * True when the device exists in this tenant, is active (not revoked) and is
 * flagged shared. Unknown, revoked and unflagged devices are false.
 */
export async function isActiveSharedDevice(
  tenant: TenantContext,
  deviceId: string,
): Promise<boolean> {
  const [row] = await withTenant(
    db,
    establishScopedTenantContext(tenant, { kind: "tenant" }),
    (tx) =>
      tx
        .select({ sharedMode: devices.sharedMode })
        .from(devices)
        .where(
          and(
            eq(devices.id, deviceId),
            eq(devices.status, "active"),
            eq(devices.sharedMode, true),
          ),
        )
        .limit(1),
  );
  return row?.sharedMode === true;
}

/** Marks the login session as used on this shared device. No write when already marked. */
export async function markSessionSharedDevice(
  sessionId: string,
  deviceId: string,
): Promise<void> {
  await db
    .update(session)
    .set({ sharedDeviceId: deviceId })
    .where(
      and(
        eq(session.id, sessionId),
        sql`${session.sharedDeviceId} IS DISTINCT FROM ${deviceId}::uuid`,
      ),
    );
}
