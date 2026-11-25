// Staff PIN login on the outlet edge (E2, brief 1269 decision 3): a verified
// device token plus a staff PIN open a session bound to that device. The only
// writer of `session.auth_method = 'edge_staff_pin'`; Better Auth never creates
// one (lib/auth.ts) and refuses every other session on an edge.
//
// - PIN: the existing throttle, pepper and lockout
//   (verifyStaffPinForReceiverSession).
// - 12 h at most by the trusted clock. One live session per device: a new login
//   ends the previous one. A revoked device ends its sessions.
// - No second factor and never a management session (database CHECK).
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  EDGE_STAFF_SESSION_DEVICE_TYPES,
  EDGE_STAFF_SESSION_TTL_MS,
  edgeStaffSessionSchema,
  type EdgeStaffSession,
} from "@starter/shared/edge";
import {
  CoreError,
  outletIdSchema,
  toIsoDateTime,
  type TenantContext,
} from "@starter/shared/core";
import { IdentityError } from "@starter/shared/identity";
import { db } from "../db/index.ts";
import { devices } from "../db/schema/device.ts";
import { session } from "../db/schema/session.ts";
import { staffPins } from "../db/schema/device-pin.ts";
import { user } from "../db/schema/user.ts";
import { withTenant } from "../db/tenant.ts";
import { catalogOverrideNow } from "../edge/catalog-override.ts";
import { assertEdgeIdentityFresh } from "../edge/identity-freshness.ts";
import { HttpError } from "../lib/http-error.ts";
import type { IssuedSession } from "../lib/identity-session.ts";
import {
  EDGE_STAFF_PIN,
  type RequestEdgeDevice,
} from "../lib/request-context.ts";
import { recordAudit } from "./audit-writer.ts";
import { outletContext } from "./device-pin-support.ts";
import { endEdgeStaffSessionsOfDevice } from "./edge-staff-session-revoke.ts";
import { verifyStaffPinForReceiverSession } from "./staff-pin-proof.service.ts";

function deviceChanged(): CoreError {
  return new CoreError(
    "UNAUTHORIZED",
    "Perangkat berubah saat masuk. Coba lagi.",
  );
}

export async function openEdgeStaffSession(
  tenant: TenantContext,
  input: {
    readonly device: RequestEdgeDevice;
    readonly outletId: string;
    readonly userId: string;
    readonly pin: string;
    readonly ipAddress: string | null;
    readonly userAgent: string | null;
  },
): Promise<{ session: IssuedSession; view: EdgeStaffSession }> {
  await assertEdgeIdentityFresh();
  const deviceId = input.device.payload.deviceId;
  const outletId = outletIdSchema.parse(input.outletId);
  const context = outletContext(tenant, outletId);
  const [device] = await withTenant(db, context, (tx) =>
    tx
      .select({ type: devices.type })
      .from(devices)
      .where(
        and(eq(devices.tenantId, tenant.tenantId), eq(devices.id, deviceId)),
      )
      .limit(1),
  );
  if (!device) throw deviceChanged();
  if (
    !(EDGE_STAFF_SESSION_DEVICE_TYPES as readonly string[]).includes(
      device.type,
    )
  )
    throw new HttpError(
      403,
      "EDGE_STAFF_SESSION_DEVICE_TYPE",
      "Staf hanya bisa masuk di kasir, layar dapur, atau HP pramusaji.",
    );

  // Wrong PIN, lockout and "not a member" throw here, before anything is
  // stored (the attempt counter commits on its own transaction).
  const verified = await verifyStaffPinForReceiverSession(tenant, {
    deviceId,
    outletId,
    userId: input.userId,
    pin: input.pin,
  });

  const now = catalogOverrideNow();
  const issued: IssuedSession = {
    id: randomUUID(),
    token: randomBytes(32).toString("base64url"),
    expiresAt: new Date(now.getTime() + EDGE_STAFF_SESSION_TTL_MS),
  };
  await withTenant(db, context, async (tx) => {
    // A PIN reset between the check and this transaction must not leave a
    // session of the old PIN: the row lock serialises with `setStaffPin`.
    const [pin] = await tx
      .select({ pinGenerationAt: staffPins.pinGenerationAt })
      .from(staffPins)
      .where(
        and(
          eq(staffPins.tenantId, tenant.tenantId),
          eq(staffPins.outletId, outletId),
          eq(staffPins.userId, verified.user.id),
        ),
      )
      .for("update");
    if (
      !pin ||
      pin.pinGenerationAt.getTime() !== verified.pinGenerationAt.getTime()
    )
      throw new IdentityError("PIN_INVALID");
    // Same for a revocation or reissue: the device pull locks this row.
    const [current] = await tx
      .select({
        status: devices.status,
        revokedAt: devices.revokedAt,
        sharedMode: devices.sharedMode,
        tokenIssuedAt: devices.tokenIssuedAt,
      })
      .from(devices)
      .where(
        and(eq(devices.tenantId, tenant.tenantId), eq(devices.id, deviceId)),
      )
      .for("update");
    if (
      !current ||
      current.status !== "active" ||
      current.revokedAt !== null ||
      current.tokenIssuedAt === null ||
      Math.floor(current.tokenIssuedAt.getTime() / 1000) !==
        input.device.payload.issuedAt
    )
      throw deviceChanged();
    // This insert skips Better Auth, so its ban check never runs.
    const [account] = await tx
      .select({ banned: user.banned, banExpires: user.banExpires })
      .from(user)
      .where(eq(user.id, verified.user.id))
      .limit(1);
    if (
      !account ||
      (account.banned === true &&
        (account.banExpires === null ||
          account.banExpires.getTime() > now.getTime()))
    )
      throw new IdentityError("PIN_INVALID");

    await endEdgeStaffSessionsOfDevice(tx, deviceId);
    await tx.insert(session).values({
      id: issued.id,
      token: issued.token,
      expiresAt: issued.expiresAt,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      userId: verified.user.id,
      tenantId: tenant.tenantId,
      authMethod: EDGE_STAFF_PIN,
      edgeDeviceId: deviceId,
      // A shared till still asks for the acting cashier's PIN on every sale.
      sharedDeviceIds: current.sharedMode ? [deviceId] : [],
    });
    await recordAudit(
      {
        tenantId: tenant.tenantId,
        outletId,
        actorType: "user",
        actorId: verified.user.id,
        deviceId,
        action: "edge_staff_session.started",
        objectType: "session",
        objectId: issued.id,
        reason: null,
        before: null,
        // Ids and the expiry only, never a token, its digest or the PIN.
        after: {
          staffUserId: verified.user.id,
          deviceId,
          expiresAt: toIsoDateTime(issued.expiresAt),
        },
        sensitiveAccess: false,
      },
      { tx, context },
    );
  });

  return {
    session: issued,
    view: edgeStaffSessionSchema.parse({
      staff: {
        id: verified.user.id,
        displayName: verified.user.displayName,
      },
      outletId,
      expiresAt: toIsoDateTime(issued.expiresAt),
    }),
  };
}
