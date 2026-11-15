// Emergency receiver sessions on the outlet edge (bead legend-bod; design
// docs/design/edge-emergency.md D-02, D-03, D-04). A session is a registered
// outlet device plus a staff PIN, with no Better Auth: staff on duty open one
// on a `pos` or `waiter_phone` device to receive panic alerts, confirm them and
// acknowledge them. The cookie `legend_emergency` is `<tenantId>.<43-char
// base64url>`; only the SHA-256 of the random part is stored. The session opens
// the emergency socket, delivery receipts and the acknowledge route, nothing
// else (no resolve, no attendance, no API).
//
// Lifetime: until the end of the duty window (panic-receiver-duty.ts), at most
// 14 hours. One live session per device (a new login replaces the old one:
// `replaced`), at most 3 live sessions per staff.
//
// Revocation (`recheckReceiverSession`): at every request and every send the
// edge re-checks the expiry, the device registry, the PIN generation, the
// staff status, the permission and the duty. A failed check revokes the row
// with its reason and tells the relay hub (`onReceiverSessionRevoked`) so the
// socket closes with code 4401.
//
// This login writes no `staff_pin_proofs` row (verifyStaffPinForReceiverSession):
// an emergency session can never clock attendance.
//
// Never log or return the cookie, the secret or a PIN.
import { createHash, randomBytes } from "node:crypto";
import {
  outletIdSchema,
  tenantIdSchema,
  type OutletId,
  type ScopedTenantContext,
  type TenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  EMERGENCY_COOKIE_NAME,
  EMERGENCY_PERMISSION_RESPOND,
  PANIC_SESSION_REVOKE_REASONS,
  type PanicSessionRevokeReason,
} from "@starter/shared/facility";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { devices } from "../db/schema/device.ts";
import { panicReceiverSessions } from "../db/schema/panic-alert.ts";
import { staffPins } from "../db/schema/device-pin.ts";
import { user } from "../db/schema/user.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { logger } from "../lib/logger.ts";
import { toLoggableError } from "../lib/safe-error.ts";
import { resolveDeviceOutlet } from "./device-pin.service.ts";
import { devicesTableLookup } from "./device-outlet-resolver.ts";
import { outletContext } from "./device-pin-support.ts";
import { accessSnapshotInTransaction, type Tx } from "./permission-resolver.ts";
import { refuseWhenEdgeServesOutlet } from "./panic-edge-ownership.ts";
import { dutyWindowEnd, employeeOfStaff } from "./panic-receiver-duty.ts";
import { verifyStaffPinForReceiverSession } from "./staff-pin-proof.service.ts";

/** Device types a receiver session may be opened on (D-03). */
export const RECEIVER_DEVICE_TYPES = ["pos", "waiter_phone"] as const;
export const RECEIVER_SESSION_MAX_MS = 14 * 60 * 60_000;
export const RECEIVER_SESSIONS_PER_STAFF = 3;
export const ERR_NOT_ON_DUTY = "NOT_ON_DUTY";

const COOKIE_PATTERN = /^([0-9a-fA-F-]{36})\.([A-Za-z0-9_-]{43})$/;

export type ReceiverSession = {
  readonly id: string;
  readonly tenantId: string;
  readonly outletId: string;
  readonly deviceId: string;
  readonly userId: string;
  readonly pinGenerationAt: Date;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
};

export type OpenedReceiverSession = {
  /** The cookie value, returned once; the route sets it as an HttpOnly cookie. */
  readonly cookieValue: string;
  readonly expiresAt: Date;
  readonly outletId: string;
  readonly user: { readonly id: string; readonly displayName: string };
};

// ------------------------------------------------------------------ revoked

export type ReceiverSessionRevoked = {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly outletId: string;
  readonly deviceId: string;
  readonly userId: string;
  readonly reason: PanicSessionRevokeReason;
};

type RevokedListener = (event: ReceiverSessionRevoked) => void;
const revokedListeners = new Set<RevokedListener>();

/**
 * The relay hub subscribes here to close the sockets of a session that ended
 * (code 4401). Returns the unsubscribe function. Listener errors are logged
 * and never reach the caller.
 */
export function onReceiverSessionRevoked(
  listener: RevokedListener,
): () => void {
  revokedListeners.add(listener);
  return () => {
    revokedListeners.delete(listener);
  };
}

function announceRevoked(events: readonly ReceiverSessionRevoked[]): void {
  for (const event of events)
    for (const listener of revokedListeners)
      try {
        listener(event);
      } catch (error) {
        logger.error(
          { err: toLoggableError(error), sessionId: event.sessionId },
          "receiver session revoked listener failed",
        );
      }
}

// ------------------------------------------------------------------- cookie

const hashSecret = (secret: string): Buffer =>
  createHash("sha256").update(secret).digest();

/** `{tenantId, secret}` of the `legend_emergency` cookie in a Cookie header, or null. */
export function parseReceiverCookie(
  header: string | undefined,
): { tenantId: string; secret: string } | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${EMERGENCY_COOKIE_NAME}=`)) continue;
    let value = trimmed.slice(EMERGENCY_COOKIE_NAME.length + 1);
    try {
      value = decodeURIComponent(value);
    } catch {
      return null;
    }
    const match = COOKIE_PATTERN.exec(value);
    const tenantId = tenantIdSchema.safeParse(match?.[1]?.toLowerCase());
    if (!match || !tenantId.success || match[2] === undefined) return null;
    return { tenantId: tenantId.data, secret: match[2] };
  }
  return null;
}

/** A tenant context for a lookup that has only the cookie's tenant prefix. */
function cookieTenant(tenantId: string): TenantContext {
  return establishTenantContext({ tenantId, brandId: null, source: "device" });
}

function tenantWide(tenant: TenantContext): ScopedTenantContext {
  return establishScopedTenantContext(tenant, { kind: "tenant" });
}

const sessionColumns = {
  id: panicReceiverSessions.id,
  tenantId: panicReceiverSessions.tenantId,
  outletId: panicReceiverSessions.outletId,
  deviceId: panicReceiverSessions.deviceId,
  userId: panicReceiverSessions.userId,
  pinGenerationAt: panicReceiverSessions.pinGenerationAt,
  issuedAt: panicReceiverSessions.issuedAt,
  expiresAt: panicReceiverSessions.expiresAt,
};

/**
 * The live session named by a Cookie header: the tenant comes from the cookie
 * prefix, the row from the SHA-256 of the secret under that tenant (RLS). Named
 * `Any` because cloud-style sockets carry no tenant context at upgrade; call it
 * only from the receiver routes and the emergency socket. null = no cookie,
 * unknown, ended. Does not re-check duty or permission: use
 * `authenticateReceiverSession`.
 */
export async function findReceiverSessionAny(
  cookieHeader: string | undefined,
): Promise<ReceiverSession | null> {
  const cookie = parseReceiverCookie(cookieHeader);
  if (cookie === null) return null;
  const tenant = cookieTenant(cookie.tenantId);
  const [row] = await withTenant(db, tenantWide(tenant), (tx) =>
    tx
      .select(sessionColumns)
      .from(panicReceiverSessions)
      .where(
        and(
          eq(panicReceiverSessions.tenantId, tenant.tenantId),
          eq(panicReceiverSessions.tokenHash, hashSecret(cookie.secret)),
          isNull(panicReceiverSessions.revokedAt),
        ),
      )
      .limit(1),
  );
  return row ?? null;
}

// ----------------------------------------------------------------- re-check

/**
 * Why a session may no longer work now, or null when it may. First match wins,
 * in the order of the design table. Read-only.
 */
async function revocationReason(
  tx: Tx,
  context: ScopedTenantContext,
  session: ReceiverSession,
  now: Date,
): Promise<PanicSessionRevokeReason | null> {
  // A socket retains the object read during upgrade. Logout or replacement
  // can commit before that socket subscribes to the revocation announcement,
  // so the cached object alone cannot prove that the session is still live.
  const [stored] = await tx
    .select({
      revokedAt: panicReceiverSessions.revokedAt,
      revokeReason: panicReceiverSessions.revokeReason,
    })
    .from(panicReceiverSessions)
    .where(
      and(
        eq(panicReceiverSessions.tenantId, context.tenant.tenantId),
        eq(panicReceiverSessions.id, session.id),
      ),
    )
    .limit(1);
  if (!stored) return "logout";
  if (stored.revokedAt !== null)
    return (
      PANIC_SESSION_REVOKE_REASONS.find(
        (reason) => reason === stored.revokeReason,
      ) ?? "logout"
    );

  if (session.expiresAt.getTime() <= now.getTime()) return "expired";

  const [device] = await tx
    .select({
      status: devices.status,
      revokedAt: devices.revokedAt,
      type: devices.type,
      tokenIssuedAt: devices.tokenIssuedAt,
    })
    .from(devices)
    .where(
      and(
        eq(devices.tenantId, session.tenantId as TenantId),
        eq(devices.id, session.deviceId),
      ),
    )
    .limit(1);
  if (!device || device.status !== "active" || device.revokedAt !== null)
    return "device_revoked";
  // A token reissue moves `token_issued_at` forward: the session opened on the
  // old token ends. The type is immutable in the registry; kept as a guard.
  if (
    !(RECEIVER_DEVICE_TYPES as readonly string[]).includes(device.type) ||
    (device.tokenIssuedAt !== null &&
      device.tokenIssuedAt.getTime() > session.issuedAt.getTime())
  )
    return "device_revoked";

  const [pin] = await tx
    .select({ pinGenerationAt: staffPins.pinGenerationAt })
    .from(staffPins)
    .where(
      and(
        eq(staffPins.tenantId, session.tenantId as TenantId),
        eq(staffPins.outletId, session.outletId as OutletId),
        eq(staffPins.userId, session.userId),
      ),
    )
    .limit(1);
  if (!pin || pin.pinGenerationAt.getTime() > session.pinGenerationAt.getTime())
    return "pin_changed";

  const employee = await employeeOfStaff(tx, {
    tenantId: session.tenantId,
    userId: session.userId,
  });
  const [account] = await tx
    .select({ banned: user.banned })
    .from(user)
    .where(eq(user.id, session.userId))
    .limit(1);
  if (!employee?.active || !account || account.banned === true)
    return "staff_inactive";

  const snapshot = await accessSnapshotInTransaction(
    tx,
    context,
    session.userId,
    now,
  );
  if (
    !snapshot.allows(EMERGENCY_PERMISSION_RESPOND, {
      type: "outlet",
      id: session.outletId,
    })
  )
    return "permission_removed";

  const dutyEnd = await dutyWindowEnd(tx, {
    tenantId: session.tenantId,
    outletId: session.outletId,
    employeeId: employee.id,
    now,
  });
  return dutyEnd === null ? "off_duty" : null;
}

/**
 * Ends a live session with its reason and tells the relay hub. false when it
 * was already ended (nothing announced twice).
 */
export async function revokeReceiverSession(
  session: Pick<
    ReceiverSession,
    "id" | "tenantId" | "outletId" | "deviceId" | "userId"
  >,
  reason: PanicSessionRevokeReason,
  now: Date = new Date(),
): Promise<boolean> {
  const tenant = cookieTenant(session.tenantId);
  const rows = await withTenant(
    db,
    outletContext(tenant, session.outletId),
    (tx) =>
      tx
        .update(panicReceiverSessions)
        .set({ revokedAt: now, revokeReason: reason })
        .where(
          and(
            eq(panicReceiverSessions.tenantId, session.tenantId as TenantId),
            eq(panicReceiverSessions.id, session.id),
            isNull(panicReceiverSessions.revokedAt),
          ),
        )
        .returning({ id: panicReceiverSessions.id }),
  );
  if (rows.length === 0) return false;
  announceRevoked([
    {
      sessionId: session.id,
      tenantId: session.tenantId,
      outletId: session.outletId,
      deviceId: session.deviceId,
      userId: session.userId,
      reason,
    },
  ]);
  return true;
}

export type ReceiverRecheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: PanicSessionRevokeReason };

/**
 * The one revocation rule (D-03): re-check a session against the live data and
 * end it when it no longer qualifies. The relay calls this before every send
 * and every resend; the routes call it on every request.
 */
export async function recheckReceiverSession(
  session: ReceiverSession,
  now: Date = new Date(),
): Promise<ReceiverRecheck> {
  const tenant = cookieTenant(session.tenantId);
  const context = outletContext(tenant, session.outletId);
  const reason = await withTenant(db, context, (tx) =>
    revocationReason(tx, context, session, now),
  );
  if (reason === null) return { ok: true };
  await revokeReceiverSession(session, reason, now);
  return { ok: false, reason };
}

/**
 * The session a request or socket upgrade may act as: found by cookie and
 * re-checked. null = no valid session (the caller answers 401 or refuses the
 * upgrade). Throws 409 EDGE_NODE_ACTIVE on the cloud for an outlet with an edge.
 */
export async function authenticateReceiverSession(
  cookieHeader: string | undefined,
  now: Date = new Date(),
): Promise<ReceiverSession | null> {
  const session = await findReceiverSessionAny(cookieHeader);
  if (session === null) return null;
  await refuseWhenEdgeServesOutlet(
    cookieTenant(session.tenantId),
    session.outletId,
  );
  return (await recheckReceiverSession(session, now)).ok ? session : null;
}

/** Logout: ends the cookie's session if it is still live; true when one ended. */
export async function endReceiverSessionByCookie(
  cookieHeader: string | undefined,
  reason: PanicSessionRevokeReason = "logout",
): Promise<boolean> {
  const session = await findReceiverSessionAny(cookieHeader);
  return session === null ? false : revokeReceiverSession(session, reason);
}

// --------------------------------------------------------------------- open

const notAllowed = (code: string, message: string) =>
  new HttpError(403, code, message);

/**
 * POST /api/emergency/sessions: device + staff PIN -> a receiver session.
 * 1. the device must be a registered `pos` or `waiter_phone` of an open outlet
 *    (401 before any PIN check, so a stranger cannot guess PINs);
 * 2. the PIN, under the device throttle and the staff lock (401 PIN_INVALID,
 *    423 PIN_LOCKED, 429 PIN_DEVICE_THROTTLED);
 * 3. the staff member is active, holds `facility.emergency.respond` at the
 *    outlet (403) and is on duty (403 NOT_ON_DUTY);
 * 4. the device's live session ends (`replaced`), the staff keeps at most 3.
 */
export async function openReceiverSession(
  tenant: TenantContext,
  input: {
    readonly deviceId: string;
    readonly staffUserId: string;
    readonly pin: string;
    readonly now?: Date;
  },
): Promise<OpenedReceiverSession> {
  const now = input.now ?? new Date();
  const outlet = outletIdSchema.safeParse(
    await resolveDeviceOutlet(tenant.tenantId, input.deviceId),
  );
  const [entry] = await devicesTableLookup({
    tenantId: tenant.tenantId,
    deviceId: input.deviceId,
  });
  if (
    !outlet.success ||
    !entry ||
    !(RECEIVER_DEVICE_TYPES as readonly string[]).includes(entry.type)
  )
    throw new HttpError(
      401,
      "DEVICE_NOT_ALLOWED",
      "Perangkat ini tidak dapat membuka sesi darurat.",
    );
  const outletId = outlet.data;
  // Before any PIN check: the cloud opens no session for an outlet with an edge.
  await refuseWhenEdgeServesOutlet(tenant, outletId);

  const verified = await verifyStaffPinForReceiverSession(tenant, {
    deviceId: input.deviceId,
    outletId,
    userId: input.staffUserId,
    pin: input.pin,
    ...(input.now ? { now: input.now } : {}),
  });

  const context = outletContext(tenant, outletId);
  const secret = randomBytes(32).toString("base64url");
  const ended: ReceiverSessionRevoked[] = [];
  // Tenant-wide RLS: the staff cap counts the live sessions of every outlet of
  // the tenant. Every query below still names tenant, outlet or staff itself.
  const expiresAt = await withTenant(db, tenantWide(tenant), async (tx) => {
    const employee = await employeeOfStaff(tx, {
      tenantId: tenant.tenantId,
      userId: verified.user.id,
    });
    if (!employee?.active)
      throw notAllowed("STAFF_INACTIVE", "Staf ini tidak aktif.");
    const snapshot = await accessSnapshotInTransaction(
      tx,
      context,
      verified.user.id,
      now,
    );
    if (
      !snapshot.allows(EMERGENCY_PERMISSION_RESPOND, {
        type: "outlet",
        id: outletId,
      })
    )
      throw notAllowed(
        "EMERGENCY_NOT_PERMITTED",
        "Peran Anda tidak menerima alarm darurat di outlet ini.",
      );
    const dutyEnd = await dutyWindowEnd(tx, {
      tenantId: tenant.tenantId,
      outletId,
      employeeId: employee.id,
      now,
    });
    if (dutyEnd === null)
      throw notAllowed(
        ERR_NOT_ON_DUTY,
        "Anda tidak sedang bertugas di outlet ini.",
      );
    const expires = new Date(
      Math.min(dutyEnd.getTime(), now.getTime() + RECEIVER_SESSION_MAX_MS),
    );

    // Two logins on one device at once: serialize, the second replaces the first.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`panic-receiver-session:${tenant.tenantId}:${input.deviceId}`}, 0))`,
    );
    const endSession = async (
      session: {
        id: string;
        outletId: string;
        deviceId: string;
        userId: string;
      },
      reason: PanicSessionRevokeReason,
    ) => {
      await tx
        .update(panicReceiverSessions)
        .set({ revokedAt: now, revokeReason: reason })
        .where(
          and(
            eq(panicReceiverSessions.tenantId, tenant.tenantId),
            eq(panicReceiverSessions.id, session.id),
            isNull(panicReceiverSessions.revokedAt),
          ),
        );
      ended.push({
        sessionId: session.id,
        tenantId: tenant.tenantId,
        outletId: session.outletId,
        deviceId: session.deviceId,
        userId: session.userId,
        reason,
      });
    };
    const live = await tx
      .select({
        id: panicReceiverSessions.id,
        outletId: panicReceiverSessions.outletId,
        deviceId: panicReceiverSessions.deviceId,
        userId: panicReceiverSessions.userId,
      })
      .from(panicReceiverSessions)
      .where(
        and(
          eq(panicReceiverSessions.tenantId, tenant.tenantId),
          isNull(panicReceiverSessions.revokedAt),
          sql`(${panicReceiverSessions.deviceId} = ${input.deviceId}::uuid OR ${panicReceiverSessions.userId} = ${verified.user.id})`,
        ),
      )
      .orderBy(asc(panicReceiverSessions.issuedAt));
    const onDevice = live.filter((row) => row.deviceId === input.deviceId);
    for (const row of onDevice) await endSession(row, "replaced");
    const ofStaff = live.filter(
      (row) =>
        row.userId === verified.user.id && row.deviceId !== input.deviceId,
    );
    // Keep room for the new one: at most 3 live in total.
    for (const row of ofStaff.slice(
      0,
      Math.max(0, ofStaff.length - (RECEIVER_SESSIONS_PER_STAFF - 1)),
    ))
      await endSession(row, "replaced");

    await tx.insert(panicReceiverSessions).values({
      tenantId: tenant.tenantId,
      outletId,
      deviceId: input.deviceId,
      userId: verified.user.id,
      tokenHash: hashSecret(secret),
      pinGenerationAt: verified.pinGenerationAt,
      issuedAt: now,
      expiresAt: expires,
      lastSeenAt: now,
    });
    return expires;
  });
  announceRevoked(ended);
  return {
    cookieValue: `${tenant.tenantId}.${secret}`,
    expiresAt,
    outletId,
    user: { id: verified.user.id, displayName: verified.user.displayName },
  };
}
