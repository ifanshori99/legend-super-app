// Shared-device mode (legend-f586w, legend-ypwsp). A device flagged
// `devices.shared_mode` serves several cashiers on one login session, so its
// POS requests must carry an acting-cashier token (middleware/acting-staff.ts
// requireActingStaffOnSharedDevice). A session that has been used on such a
// device is marked in `session.shared_device_ids` (the newest 8 such devices);
// the mark keeps the rule when the same cookie is replayed without the device
// header, in any tenant of the login. A mark never lapses (legend 1027): when
// its device is unflagged or revoked the sessions are closed best effort, and
// the guards stay closed even if that close fails.

import { and, eq, sql } from "drizzle-orm";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import type { TenantContext } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { verifyDeviceToken } from "../lib/device-token.ts";
import { HttpError } from "../lib/http-error.ts";
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
 * by dropping the oldest mark that is NOT active (unflagged, revoked or gone;
 * its sessions were closed best effort). An active mark is never dropped, so an
 * attacker cannot evict the mark of the real shared device by flooding the
 * session with other devices.
 *
 * Returns true when the device is marked after the call (already was, or now
 * is), false when the list is full of 8 active marks and nothing could be
 * dropped: the device is NOT recorded. A caller that gets false must refuse the
 * request of that device (403 SHARED_DEVICE_MARK_LIMIT), never let it continue
 * as the session owner; the 9th device stays protected because its requests
 * are refused.
 */
export async function markSessionSharedDevice(
  sessionId: string,
  deviceId: string,
): Promise<boolean> {
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
  const [row] = await db
    .select({ marked: sql<boolean>`${deviceId}::uuid = ANY(${ids})` })
    .from(session)
    .where(eq(session.id, sessionId))
    .limit(1);
  return row?.marked === true;
}

/**
 * legend-dn7uo: the session holds 8 active marks and a 9th device asked for
 * it. The refused device is not recorded, so its cookie would carry no mark
 * and pass header-less as the owner. Closing the session here removes that
 * cookie's access: the user signs in again on the 9th device, and the new
 * session is stamped at sign-in (legend-sq1ux). Best effort, never throws.
 */
export async function closeSessionAtMarkLimit(
  sessionId: string,
  userId: string,
): Promise<void> {
  try {
    // The revoke path audits it: a support (impersonated) session is deleted
    // with its impersonation end recorded, a normal one is revoked with a
    // session.revoked event. A plain delete would skip both (Better Auth's
    // delete hook does not run for direct SQL). Loaded lazily: it pulls in
    // the platform-support service.
    const { revokeOwnSession } = await import("./identity-session.service.ts");
    await revokeOwnSession({ userId, sessionId });
  } catch (error) {
    logger.warn({ err: error }, "shared device mark limit: revoke failed");
    try {
      await db.delete(session).where(eq(session.id, sessionId));
    } catch (deleteError) {
      logger.warn(
        { err: deleteError },
        "shared device mark limit: close failed",
      );
    }
  }
}

/**
 * legend-1024: a device was revoked, so every login session that was used on it
 * is closed (same audited revoke as closeSessionAtMarkLimit). Their cookies
 * would otherwise stay usable. A mark never lapses, so the guards stay closed
 * even if this close fails. Best effort per session, never throws. Returns
 * the closed session ids.
 */
export async function closeSessionsOfSharedDevice(
  deviceId: string,
): Promise<string[]> {
  let rows: { id: string; userId: string }[];
  try {
    rows = await db
      .select({ id: session.id, userId: session.userId })
      .from(session)
      .where(sql`${session.sharedDeviceIds} @> ARRAY[${deviceId}]::uuid[]`);
  } catch (selectError) {
    logger.warn(
      { err: selectError },
      "shared device sessions close: select failed",
    );
    return [];
  }
  for (const row of rows) await closeSessionAtMarkLimit(row.id, row.userId);
  return rows.map((row) => row.id);
}

// legend-dn7uo: the session already carries 8 active shared-device marks, so
// this 9th device cannot be recorded. Refused outright, never passed as owner,
// and the session is closed so its cookie, which carries no mark of the 9th
// device, cannot pass header-less. Usage: `throw await sharedDeviceMarkLimit(session.id, user.id)`.
export async function sharedDeviceMarkLimit(
  sessionId: string,
  userId: string,
): Promise<HttpError> {
  await closeSessionAtMarkLimit(sessionId, userId);
  return new HttpError(
    403,
    "SHARED_DEVICE_MARK_LIMIT",
    "Sesi ini sudah dipakai di 8 perangkat bersama dan ditutup. Masuk lagi di perangkat ini.",
  );
}

/**
 * Ids to stamp on a session created at sign-in (legend-sq1ux). Sign-in runs in
 * Better Auth, outside requireAuth, so the early stamp has not seen the device
 * header yet. A validly signed device token whose device is active and flagged
 * shared gives that one id; anything else (no token, bad signature, unflagged,
 * revoked or unknown device) gives []. Never throws: a failure is logged and
 * the sign-in goes on with no marks.
 */
export async function sharedDeviceIdsFromToken(
  rawToken: string | null | undefined,
): Promise<string[]> {
  if (!rawToken) return [];
  try {
    const payload = verifyDeviceToken(rawToken);
    if (payload === null) return [];
    return (await anySharedDeviceActive([payload.deviceId]))
      ? [payload.deviceId]
      : [];
  } catch (error) {
    logger.warn({ err: error }, "shared device sign-in stamp failed");
    return [];
  }
}

/** The marks plus `deviceId`, deduped, as a new array. */
export function withSharedMark(
  marked: readonly string[] | null | undefined,
  deviceId: string,
): string[] {
  const list = marked ?? [];
  return list.includes(deviceId) ? [...list] : [...list, deviceId];
}

/**
 * Early stamp (legend-jqurl), run by requireAuth and the /api/auth guard. A
 * validly signed device token whose device is active and flagged shared marks
 * the session, so the marks exist before the cookie is replayed on a guarded
 * route without the header. The signature already binds tenant and device, so
 * the lookup needs no tenant context. No header, a bad signature or an
 * unflagged device do nothing; a failure is logged and never thrown. Returns
 * the marks in effect for THIS request (legend-7yvmm): the existing marks plus
 * the token's device when it was stamped now or was already marked, as a new
 * array, so the caller can refresh its session snapshot and not read a stale
 * list. Returns null only when the device is flagged and active but the
 * session's 8 marks are all active (markSessionSharedDevice false): the caller
 * must refuse the request with 403 SHARED_DEVICE_MARK_LIMIT.
 */
export async function stampSharedDeviceFromToken(
  sessionId: string,
  markedDeviceIds: readonly string[] | null | undefined,
  rawToken: string | undefined,
): Promise<string[] | null> {
  const existing = [...(markedDeviceIds ?? [])];
  if (!rawToken) return existing;
  try {
    const payload = verifyDeviceToken(rawToken);
    if (payload === null) return existing;
    if (existing.includes(payload.deviceId)) return existing;
    if (await anySharedDeviceActive([payload.deviceId]))
      return (await markSessionSharedDevice(sessionId, payload.deviceId))
        ? withSharedMark(existing, payload.deviceId)
        : null;
    return existing;
  } catch (error) {
    logger.warn({ err: error }, "shared device early stamp failed");
    return existing;
  }
}
