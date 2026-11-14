// legend-gchkf: the owner's registered panic-alarm browsers ("perangkat
// alarm"), listed even when their login session has expired, and revoked one
// at a time. A lost phone whose session ran out keeps receiving alarms until
// its push subscription is deleted, and the session list hides it.
//
// push_subscriptions has tenant RLS, so every query runs in a tenant
// transaction. The tenant is the session's own (staff login on a tenant host)
// or, for a session without one, the tenant of the request's registered
// domain; never a client parameter. With neither, the list is empty. Devices
// registered in another tenant than that one stay invisible until a
// SECURITY DEFINER read exists (a migration, out of scope here).
// A session without a tenant (a platform login) still uses the request's
// registered-domain tenant (decision D): a user who signs in on a tenant host
// must be able to list and revoke that tenant's devices.
// Every query filters user_id; the endpoint, keys, ciphertext and hash are
// never selected.

import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { tenantIdSchema } from "@starter/shared/core";
import { pushDeviceSchema, type PushDevice } from "@starter/shared/identity";
import { pushSubscriptionIdSchema } from "@starter/shared/notification";
import { db } from "../db";
import { pushSubscriptions, session } from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { deliverablePushSubscription } from "../worker/web-push-provider";
import { loadSessionRow, revokeOwnSession } from "./identity-session.service";

type Scope = {
  readonly userId: string;
  /** The caller's current login session id. */
  readonly currentSessionId: string;
  /** Tenant of the request's registered domain, when one resolved. */
  readonly domainTenantId: string | null;
};

async function scopedContext(scope: Scope) {
  const row = await loadSessionRow(scope.currentSessionId);
  const parsed = tenantIdSchema.safeParse(
    row?.tenantId ?? scope.domainTenantId,
  );
  if (!parsed.success) return null;
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: parsed.data,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

/**
 * The caller's alarm devices that will still be sent an alarm, newest first.
 * Rows the worker no longer delivers to (never verified, older than 30 days,
 * device token replaced, revoked session) are hidden: listing them would offer
 * a revoke for a device that already receives nothing. Own rows only.
 */
export async function listOwnPushDevices(
  scope: Scope & { readonly now?: Date },
): Promise<PushDevice[]> {
  const context = await scopedContext(scope);
  if (!context) return [];
  const now = scope.now ?? new Date();
  const rows = await withTenant(db, context, (tx) =>
    tx
      .select({
        id: pushSubscriptions.id,
        deviceLabel: pushSubscriptions.deviceLabel,
        registeredAt: pushSubscriptions.registeredAt,
        createdAt: pushSubscriptions.createdAt,
        sessionId: pushSubscriptions.sessionId,
        liveSessionId: session.id,
      })
      .from(pushSubscriptions)
      .leftJoin(
        session,
        and(
          eq(session.id, pushSubscriptions.sessionId),
          isNull(session.revokedAt),
          gt(session.expiresAt, now),
        ),
      )
      .where(
        and(
          eq(pushSubscriptions.userId, scope.userId),
          deliverablePushSubscription(now),
        ),
      )
      .orderBy(
        desc(
          sql`coalesce(${pushSubscriptions.registeredAt}, ${pushSubscriptions.createdAt})`,
        ),
      ),
  );
  return rows.map((row) =>
    pushDeviceSchema.parse({
      id: row.id,
      deviceLabel: row.deviceLabel,
      registeredAt: (row.registeredAt ?? row.createdAt).toISOString(),
      sessionActive: row.liveSessionId !== null,
      current:
        row.sessionId !== null && row.sessionId === scope.currentSessionId,
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
  const context = parsed.success ? await scopedContext(scope) : null;
  if (!parsed.success || !context) throw pushDeviceNotFound();
  const now = scope.now ?? new Date();
  const [found] = await withTenant(db, context, (tx) =>
    tx
      .select({
        sessionId: pushSubscriptions.sessionId,
        liveSessionId: session.id,
      })
      .from(pushSubscriptions)
      .leftJoin(
        session,
        and(
          eq(session.id, pushSubscriptions.sessionId),
          eq(session.userId, scope.userId),
          isNull(session.revokedAt),
          gt(session.expiresAt, now),
        ),
      )
      .where(
        and(
          eq(pushSubscriptions.id, parsed.data),
          eq(pushSubscriptions.userId, scope.userId),
        ),
      )
      .limit(1),
  );
  if (!found) throw pushDeviceNotFound();
  if (
    found.sessionId !== null &&
    found.liveSessionId !== null &&
    found.sessionId !== scope.currentSessionId
  ) {
    // Deletes the session's push subscriptions in the same transaction as the
    // revoke (app.delete_session_push_subscriptions), this device included.
    await revokeOwnSession({
      userId: scope.userId,
      sessionId: found.sessionId,
      now,
    });
  }
  // A concurrent revoke may already have removed the row; that is fine only
  // when the row was found a moment ago, so no 404 here.
  await withTenant(db, context, (tx) =>
    tx
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.id, parsed.data),
          eq(pushSubscriptions.userId, scope.userId),
        ),
      ),
  );
}

function pushDeviceNotFound(): HttpError {
  return new HttpError(404, "NOT_FOUND", "Perangkat tidak ditemukan.");
}
