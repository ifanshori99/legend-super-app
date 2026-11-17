// push_subscriptions has tenant RLS, so the account-level reads and the delete
// go through SECURITY DEFINER functions (app.list_own_push_devices,
// app.delete_own_push_device). Each derives the owner inside the function from
// the caller's live login session, so devices registered in any tenant are
// listed and revoked, and no user, owner or tenant id is ever a parameter.
// The endpoint, keys, ciphertext and hash are never selected.

import { sql } from "drizzle-orm";
import { pushDeviceSchema, type PushDevice } from "@starter/shared/identity";
import { pushSubscriptionIdSchema } from "@starter/shared/notification";
import { db } from "../db";
import { HttpError } from "../lib/http-error";
import { loadSessionRow, revokeOwnSession } from "./identity-session.service";

type Scope = {
  readonly userId: string;
  /** The caller's current login session id. */
  readonly currentSessionId: string;
  /**
   * Support (impersonated) sessions only: keep just devices registered in
   * these tenants (legend-xqkr7). Undefined for an ordinary session.
   */
  readonly onlyTenantIds?: readonly string[];
};

type DeviceRow = {
  id: string;
  tenant_id: string;
  device_label: string;
  registered_at: Date | string | null;
  created_at: Date | string;
  session_id: string | null;
  session_active: boolean;
};

function isoTimestamp(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

async function listRows(scope: Scope, now: Date): Promise<DeviceRow[]> {
  const result = await db.execute<DeviceRow>(
    sql`SELECT * FROM app.list_own_push_devices(${scope.currentSessionId}, ${now.toISOString()}::timestamptz)`,
  );
  const allowed = scope.onlyTenantIds;
  return allowed
    ? result.rows.filter((row) => allowed.includes(row.tenant_id))
    : result.rows;
}

/**
 * The caller's alarm devices, in every tenant, that will still be sent an
 * alarm, newest first. Rows the worker no longer delivers to (never verified,
 * older than 30 days, device token replaced, revoked session) are hidden:
 * listing them would offer a revoke for a device that already receives
 * nothing. Own rows only.
 */
export async function listOwnPushDevices(
  scope: Scope & { readonly now?: Date },
): Promise<PushDevice[]> {
  const rows = await listRows(scope, scope.now ?? new Date());
  return rows.map((row) =>
    pushDeviceSchema.parse({
      id: row.id,
      deviceLabel: row.device_label,
      registeredAt: isoTimestamp(row.registered_at ?? row.created_at),
      sessionActive: row.session_active,
      current:
        row.session_id !== null && row.session_id === scope.currentSessionId,
    }),
  );
}

/**
 * Deletes one of the caller's alarm devices. Another user's device, an unknown
 * id and an already revoked one all answer 404 (no enumeration).
 *
 * When the device's registering session is still active and is not the
 * caller's current one, that session is revoked too (same path as "cabut
 * sesi"): otherwise the phone would register itself again through the panic
 * push control and keep receiving alarms. The current session is never
 * revoked here; the caller stays signed in and the browser unsubscribes
 * itself after the 204.
 */
export async function revokeOwnPushDevice(
  scope: Scope & { readonly id: string; readonly now?: Date },
): Promise<void> {
  const parsed = pushSubscriptionIdSchema.safeParse(scope.id);
  if (!parsed.success) throw pushDeviceNotFound();
  const now = scope.now ?? new Date();
  const found = (await listRows(scope, now)).find(
    (row) => row.id === parsed.data,
  );
  if (!found) throw pushDeviceNotFound();
  if (
    found.session_id !== null &&
    found.session_active &&
    found.session_id !== scope.currentSessionId
  ) {
    // Deletes the session's push subscriptions in the same transaction as the
    // revoke (app.delete_session_push_subscriptions), this device included.
    await revokeOwnSession({
      userId: scope.userId,
      sessionId: found.session_id,
      now,
    });
  }
  const result = await db.execute<{ deleted: number | string }>(
    sql`SELECT app.delete_own_push_device(${scope.currentSessionId}, ${parsed.data}::uuid, ${now.toISOString()}::timestamptz) AS deleted`,
  );
  // The function returns the number of rows it deleted. 0 means nothing was
  // removed: either a concurrent revoke got there first (the row is gone, keep
  // the 204) or the delete missed a row that is still deliverable, for example
  // because the caller's session stopped matching. List again: a row still
  // listed means the device is not revoked, so answer 409 instead of a false 204.
  // A caller session that died meanwhile lists nothing, so it cannot confirm
  // the row is gone: answer 401 (sign in again and retry) instead.
  if (Number(result.rows[0]?.deleted ?? 0) === 0) {
    const caller = await loadSessionRow(scope.currentSessionId);
    if (!caller || caller.revokedAt || caller.expiresAt <= now) {
      throw new HttpError(
        401,
        "UNAUTHORIZED",
        "Sesi berakhir. Masuk lagi lalu cabut perangkat ini.",
      );
    }
    const stillListed = (await listRows(scope, now)).some(
      (row) => row.id === parsed.data,
    );
    if (stillListed) {
      throw new HttpError(
        409,
        "CONFLICT",
        "Perangkat belum tercabut. Coba lagi.",
      );
    }
  }
}

function pushDeviceNotFound(): HttpError {
  return new HttpError(404, "NOT_FOUND", "Perangkat tidak ditemukan.");
}
