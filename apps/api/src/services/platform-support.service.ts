// Support access (PRD v1.7 §3 F4 "Support Access", §6 A
// `support_access_grants`, TEN-04). A Super Admin opens a time-boxed session
// with a mandatory reason and a second factor; tenant personal/financial data
// is unreachable without one, every session is recorded, and the tenant admin
// can list the sessions that touched their tenant.
//
// The grant row names the target tenant, so reads/writes run inside that
// tenant's transaction (RLS): a tenant can never see another tenant's grants,
// and the platform service sets the context explicitly because the target is a
// path parameter chosen by a platform-permissioned user (TEN-02 exception for
// platform routes, see platform/endpoints.ts).
//
// MFA: the route passes the timestamp of a verified second factor. Until the
// identity bead stores MFA factors there is no verifier, so `mfaVerifiedAt` is
// null and every request fails closed (lib/mfa.ts).

import { and, desc, eq, gt, isNull, lt, or } from "drizzle-orm";
import {
  assertCanOpenSupportAccess,
  assertSupportAccess,
  supportAccessExpiry,
  supportAccessGrantSchema,
  type DataClass,
  type RequestSupportAccessInput,
  type SupportAccessGrant,
} from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { decodeCursor, encodeCursor } from "@starter/shared/core";
import { db } from "../db";
import { platformAdmins, supportAccessGrants } from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";

type GrantRow = typeof supportAccessGrants.$inferSelect;

function toGrant(row: GrantRow): SupportAccessGrant {
  return supportAccessGrantSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    superAdminUserId: row.superAdminUserId,
    reason: row.reason,
    accessMode: row.accessMode,
    durationMinutes: row.durationMinutes,
    startedAt: row.startedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    mfaVerifiedAt: row.mfaVerifiedAt.toISOString(),
    tenantAdminNotifiedAt: row.tenantAdminNotifiedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    endedBy: row.endedBy,
  });
}

/** The Super Admin registry: an active platform_admins row, deny by default. */
export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: platformAdmins.id })
    .from(platformAdmins)
    .where(
      and(eq(platformAdmins.userId, userId), isNull(platformAdmins.revokedAt)),
    )
    .limit(1);
  return Boolean(row);
}

/** Tenant context for a platform route's path parameter. */
function platformTenantContext(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

export async function requestSupportAccess(input: {
  tenantId: string;
  actorUserId: string;
  request: RequestSupportAccessInput;
  /** When the second factor was verified; null = not verified (denied). */
  mfaVerifiedAt: string | null;
  now?: Date;
}): Promise<SupportAccessGrant> {
  const mfaVerifiedAt = input.mfaVerifiedAt;
  if (mfaVerifiedAt === null)
    throw new HttpError(
      403,
      "FORBIDDEN",
      "Verifikasi MFA wajib sebelum membuka sesi support access.",
    );
  if (!(await isPlatformAdmin(input.actorUserId)))
    throw new HttpError(403, "FORBIDDEN", "Akun ini bukan Super Admin.");
  const now = input.now ?? new Date();
  const startedAt = now.toISOString();
  const context = platformTenantContext(input.tenantId);
  return withTenant(db, context, async (tx) => {
    const open = await tx
      .select()
      .from(supportAccessGrants)
      .where(
        and(
          eq(supportAccessGrants.tenantId, input.tenantId),
          eq(supportAccessGrants.superAdminUserId, input.actorUserId),
          isNull(supportAccessGrants.endedAt),
          gt(supportAccessGrants.expiresAt, now),
        ),
      );
    assertCanOpenSupportAccess(
      open.map(toGrant),
      {
        tenantId: input.tenantId,
        superAdminUserId: input.actorUserId,
      },
      now,
    );
    const [row] = await tx
      .insert(supportAccessGrants)
      .values({
        tenantId: input.tenantId,
        superAdminUserId: input.actorUserId,
        reason: input.request.reason,
        accessMode: input.request.accessMode,
        durationMinutes: input.request.durationMinutes,
        startedAt: new Date(startedAt),
        expiresAt: new Date(
          supportAccessExpiry(startedAt, input.request.durationMinutes),
        ),
        // mfaVerifiedAt <= startedAt is a table check; the verified instant is
        // never later than the session it authorizes.
        mfaVerifiedAt: new Date(mfaVerifiedAt),
      })
      .returning();
    return toGrant(row);
  });
}

/** Tenant admin view of the sessions that touched their tenant (TEN-04). */
export async function listSupportAccess(
  context: ScopedTenantContext,
  query: { limit: number; cursor?: string },
): Promise<{
  data: SupportAccessGrant[];
  meta: { limit: number; nextCursor: string | null };
}> {
  return withTenant(db, context, async (tx) => {
    const filters = [eq(supportAccessGrants.tenantId, context.tenant.tenantId)];
    if (query.cursor) {
      const [startedAt, id] = decodeCursor(query.cursor);
      if (typeof startedAt !== "string" || typeof id !== "string")
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
      const at = new Date(startedAt);
      const cursorFilter = or(
        lt(supportAccessGrants.startedAt, at),
        and(
          eq(supportAccessGrants.startedAt, at),
          lt(supportAccessGrants.id, id),
        ),
      );
      if (cursorFilter) filters.push(cursorFilter);
    }
    const rows = await tx
      .select()
      .from(supportAccessGrants)
      .where(and(...filters))
      .orderBy(
        desc(supportAccessGrants.startedAt),
        desc(supportAccessGrants.id),
      )
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toGrant),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.startedAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

/** Ends a session early; an ended session is history and stays readable. */
export async function endSupportAccess(input: {
  tenantId: string;
  grantId: string;
  actorUserId: string;
  now?: Date;
}): Promise<SupportAccessGrant> {
  const now = input.now ?? new Date();
  const context = platformTenantContext(input.tenantId);
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .update(supportAccessGrants)
      .set({ endedAt: now, endedBy: input.actorUserId })
      .where(
        and(
          eq(supportAccessGrants.id, input.grantId),
          eq(supportAccessGrants.tenantId, input.tenantId),
          isNull(supportAccessGrants.endedAt),
        ),
      )
      .returning();
    if (!row)
      throw new HttpError(404, "NOT_FOUND", "Support session not found.");
    return toGrant(row);
  });
}

/**
 * TEN-04 gate every platform read of tenant personal/financial data must call.
 * Returns the grant the access is attributed to (for the audit row) or null
 * for data classes that need no session. Throws SUPPORT_ACCESS_REQUIRED /
 * SUPPORT_ACCESS_READ_ONLY (mapped to 403 by the error handler).
 */
export async function requireSupportAccess(input: {
  tenantId: string;
  actorUserId: string;
  dataClass: DataClass;
  intent: "read" | "write";
  now?: Date;
}): Promise<SupportAccessGrant | null> {
  const now = input.now ?? new Date();
  const context = platformTenantContext(input.tenantId);
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .select()
      .from(supportAccessGrants)
      .where(
        and(
          eq(supportAccessGrants.tenantId, input.tenantId),
          eq(supportAccessGrants.superAdminUserId, input.actorUserId),
        ),
      );
    return assertSupportAccess(rows.map(toGrant), {
      tenantId: input.tenantId,
      superAdminUserId: input.actorUserId,
      dataClass: input.dataClass,
      intent: input.intent,
      now,
    });
  });
}
