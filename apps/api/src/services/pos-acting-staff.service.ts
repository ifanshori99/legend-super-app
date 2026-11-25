// Acting cashier per device (bead legend-aruta; docs/DECISIONS.md "Kasir aktif
// per perangkat lewat token server").
//
// - Issue: the staff member proves their PIN on the registered device
//   (`verifyStaffPinOnDeviceVersioned`: same lockout and oracle rules), then
//   one transaction locks the staff_pins row and refuses when the PIN
//   generation changed since the check, revokes the device's live token (`switched`), stores the
//   sha256 of a fresh `pas_` token and audits `pos_acting_staff.started`. The
//   device owner (login session) must belong to the same outlet.
// - End: revokes the device's live token of this session (`ended`).
// - Resolve: every POS request that carries the token. It must match device,
//   login session, tenant and outlet, be live, and name a staff member who is
//   still active in the outlet. Anything else fails closed; there is no
//   fallback to the session owner.
// - Revoke hooks (pin reset, shift close, day close) live in
//   pos-acting-staff-revoke.ts and run on the caller's transaction.
//
// Only the sha256 of a token is stored. Never log or audit a token or a pin.

import { createHash, randomBytes } from "node:crypto";
import { AccessError } from "@starter/shared/access";
import {
  CoreError,
  outletIdSchema,
  toIsoDateTime,
  type ScopedTenantContext,
  type TenantContext,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import {
  ACTING_STAFF_ERROR_CODES,
  ACTING_STAFF_TOKEN_PREFIX,
  ACTING_STAFF_TTL_MS,
  posSessionResponseSchema,
  type PosSessionResponse,
} from "@starter/shared/pos/acting-staff";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.ts";
import { posActingStaff } from "../db/schema/pos-acting-staff.ts";
import { staffPins } from "../db/schema/device-pin.ts";
import { assertEdgeIdentityFresh } from "../edge/identity-freshness.ts";
import { user } from "../db/schema/user.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./audit-writer.ts";
import {
  resolveDeviceOutlet,
  verifyStaffPinOnDeviceVersioned,
} from "./device-pin.service.ts";
import { isOutletMember, outletContext } from "./device-pin-support.ts";
import { loadTenantAccessInTransaction } from "./permission-resolver.ts";
import {
  revokeActingStaffForDevice,
  revokeActingStaffForOutlet,
  revokeActingStaffForStaff,
} from "./pos-acting-staff-revoke.ts";

export {
  revokeActingStaffForDevice,
  revokeActingStaffForOutlet,
  revokeActingStaffForStaff,
};

const CODES = ACTING_STAFF_ERROR_CODES;

/** 32 random bytes as unpadded base64url are 43 characters. */
const TOKEN_PATTERN = new RegExp(
  `^${ACTING_STAFF_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`,
);

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function invalid(): HttpError {
  return new HttpError(
    401,
    CODES.INVALID,
    "Kasir aktif tidak valid. Masukkan PIN lagi.",
  );
}

/** A unique violation of `pos_acting_staff_live_device_key`, in the cause chain. */
function isUniqueViolation(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return (
    candidate.code === "23505" || isUniqueViolation(candidate.cause, depth + 1)
  );
}

// ------------------------------------------------------------------- issue

/**
 * POST /api/staff-pins/pos-session. The device and the login session come from
 * the signed device token and the verified session, never from the body.
 */
export async function issueActingStaff(
  tenant: TenantContext,
  input: {
    readonly deviceId: string;
    readonly sessionId: string;
    readonly sessionUserId: string;
    readonly userId: string;
    readonly pin: string;
  },
): Promise<PosSessionResponse> {
  // E2 (brief 1269): a cashier switch is a new login on an edge.
  await assertEdgeIdentityFresh();
  // Wrong PIN, lockout and "not a member" all throw here, before anything is
  // stored (the attempt counter commits on its own transaction).
  const { switch: verified, pinVersion } =
    await verifyStaffPinOnDeviceVersioned(tenant, {
      deviceId: input.deviceId,
      userId: input.userId,
      pin: input.pin,
    });
  const outletId = verified.outletId;
  const context = outletContext(tenant, outletId);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ACTING_STAFF_TTL_MS);
  const token = `${ACTING_STAFF_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;

  try {
    await withTenant(db, context, async (tx) => {
      const owner = await loadTenantAccessInTransaction(
        tx,
        context,
        input.sessionUserId,
      );
      if (!isOutletMember(tenant, input.sessionUserId, owner, outletId, now))
        throw new AccessError(
          "PERMISSION_DENIED",
          "Anda tidak terdaftar di outlet ini.",
        );

      // A pin reset between the check above and this transaction must not
      // leave a token of the old pin. The row lock serialises with
      // `setStaffPin` and the edge adoption: a reset that committed first
      // changes the generation or the salt (refused here); one that waits for
      // this lock revokes the new token after it commits.
      const [pin] = await tx
        .select({
          pinGenerationAt: staffPins.pinGenerationAt,
          pinSalt: staffPins.pinSalt,
        })
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
        pin.pinGenerationAt.getTime() !==
          pinVersion.pinGenerationAt.getTime() ||
        pin.pinSalt !== pinVersion.pinSalt
      )
        throw new HttpError(
          401,
          CODES.INVALID,
          "PIN baru saja diganti. Masukkan PIN lagi.",
        );

      await revokeActingStaffForDevice(tx, tenant, {
        deviceId: input.deviceId,
        reason: "switched",
      });
      // `issued_at` is set from the same clock as `expires_at`: the 12 hour
      // check must not trip on skew between the app and the database.
      const [row] = await tx
        .insert(posActingStaff)
        .values({
          tenantId: tenant.tenantId,
          outletId,
          deviceId: input.deviceId,
          staffUserId: verified.user.id,
          sessionUserId: input.sessionUserId,
          sessionId: input.sessionId,
          tokenHash: sha256Hex(token),
          issuedAt: now,
          expiresAt,
        })
        .returning({ id: posActingStaff.id });
      if (!row) throw new Error("acting staff insert returned no row");
      await recordAudit(
        {
          tenantId: tenant.tenantId,
          outletId,
          actorType: "user",
          actorId: verified.user.id,
          deviceId: input.deviceId,
          action: "pos_acting_staff.started",
          objectType: "pos_acting_staff",
          objectId: row.id,
          reason: null,
          before: null,
          // Ids and the expiry only, never the token or its hash.
          after: {
            staffUserId: verified.user.id,
            sessionUserId: input.sessionUserId,
            deviceId: input.deviceId,
            expiresAt: toIsoDateTime(expiresAt),
          },
          sensitiveAccess: false,
        },
        { tx, context },
      );
    });
  } catch (error) {
    // Two switches racing on one device: the second hits the one-live-token
    // index. The cashier retries; nothing was issued twice.
    if (isUniqueViolation(error))
      throw new CoreError(
        "CONFLICT",
        "Pergantian kasir sedang berjalan. Coba lagi.",
      );
    throw error;
  }

  return posSessionResponseSchema.parse({
    token,
    expiresAt: toIsoDateTime(expiresAt),
    staff: { id: verified.user.id, displayName: verified.user.displayName },
    outletId,
  });
}

// --------------------------------------------------------------------- end

/**
 * POST /api/staff-pins/pos-session/end. Idempotent: no live token of this
 * session on the device is a no-op.
 */
export async function endActingStaff(
  tenant: TenantContext,
  input: { readonly deviceId: string; readonly sessionId: string },
): Promise<void> {
  const resolved = await resolveDeviceOutlet(tenant.tenantId, input.deviceId);
  if (resolved === null)
    throw new CoreError(
      "FORBIDDEN",
      "Perangkat ini belum terdaftar di outlet mana pun.",
    );
  const outletId = outletIdSchema.parse(resolved);
  const context = outletContext(tenant, outletId);
  await withTenant(db, context, async (tx) => {
    const ended = await tx
      .update(posActingStaff)
      .set({ revokedAt: new Date(), revokeReason: "ended" })
      .where(
        and(
          eq(posActingStaff.tenantId, tenant.tenantId),
          eq(posActingStaff.outletId, outletId),
          eq(posActingStaff.deviceId, input.deviceId),
          eq(posActingStaff.sessionId, input.sessionId),
          isNull(posActingStaff.revokedAt),
        ),
      )
      .returning({
        id: posActingStaff.id,
        staffUserId: posActingStaff.staffUserId,
        sessionUserId: posActingStaff.sessionUserId,
      });
    for (const row of ended)
      await recordAudit(
        {
          tenantId: tenant.tenantId,
          outletId,
          actorType: "user",
          actorId: row.staffUserId,
          deviceId: input.deviceId,
          action: "pos_acting_staff.ended",
          objectType: "pos_acting_staff",
          objectId: row.id,
          reason: null,
          before: null,
          after: {
            staffUserId: row.staffUserId,
            sessionUserId: row.sessionUserId,
            deviceId: input.deviceId,
          },
          sensitiveAccess: false,
        },
        { tx, context },
      );
  });
}

// ----------------------------------------------------------------- resolve

export type ResolvedActingStaff = {
  readonly staffUserId: string;
  readonly sessionUserId: string;
  readonly tokenId: string;
  readonly outletId: string;
};

/**
 * Resolves an `X-Acting-Staff` token for one POS request. The token row is
 * read with a tenant-wide scope so a token of another outlet answers
 * OUTLET_MISMATCH instead of looking unknown; the tenant is always the
 * request's.
 */
export async function resolveActingStaffToken(
  tenant: TenantContext,
  input: {
    readonly token: string;
    readonly deviceId: string;
    readonly sessionId: string;
    /** Null for routes without `:outletId` in the path; the caller then checks the outlet itself. */
    readonly outletId: string | null;
  },
): Promise<ResolvedActingStaff> {
  if (!TOKEN_PATTERN.test(input.token)) throw invalid();
  const now = new Date();
  const wide: ScopedTenantContext = establishScopedTenantContext(tenant, {
    kind: "tenant",
  });

  const found = await withTenant(db, wide, async (tx) => {
    const [row] = await tx
      .select()
      .from(posActingStaff)
      .where(
        and(
          eq(posActingStaff.tenantId, tenant.tenantId),
          eq(posActingStaff.tokenHash, sha256Hex(input.token)),
        ),
      )
      .limit(1);
    return row ?? null;
  });
  if (
    !found ||
    !same(found.deviceId, input.deviceId) ||
    found.sessionId !== input.sessionId
  )
    throw invalid();
  if (found.revokedAt !== null)
    throw new HttpError(
      401,
      CODES.REVOKED,
      `Kasir aktif sudah dicabut (${found.revokeReason ?? "unknown"}). Masukkan PIN lagi.`,
    );
  if (found.expiresAt.getTime() <= now.getTime())
    throw new HttpError(
      401,
      CODES.EXPIRED,
      "Kasir aktif sudah kedaluwarsa. Masukkan PIN lagi.",
    );
  // The token's outlet, the path's outlet and the device's outlet agree.
  const deviceOutlet = await resolveDeviceOutlet(
    tenant.tenantId,
    input.deviceId,
  );
  if (
    (input.outletId !== null && !same(found.outletId, input.outletId)) ||
    deviceOutlet === null ||
    !same(found.outletId, deviceOutlet)
  )
    throw new HttpError(
      403,
      CODES.OUTLET_MISMATCH,
      "Kasir aktif tidak berlaku di outlet ini.",
    );

  // Staff must still be an active member of the outlet. A lapse revokes the
  // token (committed) before the request is refused.
  const context = outletContext(tenant, found.outletId);
  const active = await withTenant(db, context, async (tx) => {
    const [account] = await tx
      .select({ banned: user.banned })
      .from(user)
      .where(eq(user.id, found.staffUserId))
      .limit(1);
    const data = await loadTenantAccessInTransaction(
      tx,
      context,
      found.staffUserId,
    );
    const ok =
      account !== undefined &&
      account.banned !== true &&
      isOutletMember(tenant, found.staffUserId, data, found.outletId, now);
    if (!ok)
      await revokeActingStaffForStaff(tx, tenant, {
        outletId: found.outletId,
        staffUserId: found.staffUserId,
        reason: "staff_inactive",
      });
    return ok;
  });
  if (!active)
    throw new HttpError(
      403,
      CODES.INACTIVE,
      "Kasir aktif tidak lagi aktif di outlet ini.",
    );

  return {
    staffUserId: found.staffUserId,
    sessionUserId: found.sessionUserId,
    tokenId: found.id,
    outletId: found.outletId,
  };
}
