// Shared-device mode (legend-f586w, legend-ypwsp). A device flagged
// `devices.shared_mode` serves several cashiers on one login session, so its
// POS requests must carry an acting-cashier token (middleware/acting-staff.ts
// requireActingStaffOnSharedDevice). A session that has been used on such a
// device is marked in `session.shared_device_ids` (the newest 8 such devices);
// the mark keeps the rule when the same cookie is replayed without the device
// header, in any tenant of the login. A mark lapses when its device is
// unflagged, revoked or gone.

import { and, eq, sql } from "drizzle-orm";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import type { TenantContext } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { verifyDeviceToken } from "../lib/device-token.ts";
import { logger } from "../lib/logger.ts";
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

/** Most devices one session remembers. */
const MAX_SHARED_DEVICE_MARKS = 8;

/**
 * True when at least one of the ids is an active device flagged shared, in any
 * tenant. A session cookie is shared across tenants, so the marks are checked
 * without a tenant (app.shared_device_active answers only a boolean for ids the
 * caller already holds). An empty list is false without a query.
 */
export async function anySharedDeviceActive(
  deviceIds: readonly string[],
): Promise<boolean> {
  if (deviceIds.length === 0) return false;
  // One text parameter holding a Postgres array literal; a malformed id fails
  // the uuid[] cast, it cannot change the statement.
  const literal = `{${deviceIds.join(",")}}`;
  const result = await db.execute<{ active: boolean }>(
    sql`SELECT app.shared_device_active(${literal}::uuid[]) AS active`,
  );
  return result.rows[0]?.active === true;
}

/**
 * Marks the login session as used on this shared device: appends the id when
 * absent. One UPDATE, no write when already marked. A full list (8) makes room
 * by dropping the oldest mark that is NOT active (unflagged, revoked or gone:
 * a lapsed mark guards nothing). An active mark is never dropped, so an
 * attacker cannot evict the mark of the real shared device by flooding the
 * session with other devices; when all 8 marks are active the list is left
 * unchanged and no write happens.
 */
export async function markSessionSharedDevice(
  sessionId: string,
  deviceId: string,
): Promise<void> {
  const ids = session.sharedDeviceIds;
  await db
    .update(session)
    .set({
      sharedDeviceIds: sql`CASE
        WHEN cardinality(${ids}) < ${MAX_SHARED_DEVICE_MARKS}
          THEN array_append(${ids}, ${deviceId}::uuid)
        ELSE COALESCE(
          (SELECT array_append(array_remove(${ids}, t.x), ${deviceId}::uuid)
           FROM unnest(${ids}) WITH ORDINALITY AS t(x, n)
           WHERE NOT app.shared_device_active(ARRAY[t.x])
           ORDER BY t.n
           LIMIT 1),
          ${ids})
      END`,
    })
    .where(
      and(
        eq(session.id, sessionId),
        sql`NOT (${deviceId}::uuid = ANY(${ids}))`,
      ),
    );
}

/**
 * Early stamp (legend-jqurl), run by requireAuth. A validly signed device token
 * whose device is active and flagged shared marks the session, so the marks
 * exist before the cookie is replayed on a guarded route without the header.
 * The signature already binds tenant and device, so the lookup needs no tenant
 * context. No header, a bad signature, an unflagged device or an already marked
 * session do nothing; a failure is logged and never thrown.
 */
export async function stampSharedDeviceFromToken(
  sessionId: string,
  markedDeviceIds: readonly string[] | null | undefined,
  rawToken: string | undefined,
): Promise<void> {
  if (!rawToken) return;
  try {
    const payload = verifyDeviceToken(rawToken);
    if (payload === null || markedDeviceIds?.includes(payload.deviceId)) return;
    if (await anySharedDeviceActive([payload.deviceId]))
      await markSessionSharedDevice(sessionId, payload.deviceId);
  } catch (error) {
    logger.warn({ err: error }, "shared device early stamp failed");
  }
}
