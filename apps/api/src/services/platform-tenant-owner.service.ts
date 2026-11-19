// Platform Super Admin appoints or replaces a tenant Owner (bead legend-ktc4d,
// founder decision Q44; PRD v1.7 §3 F4 Panel Platform, §3.7 "Owner / Direksi").
//
// The Owner template can only be granted by an active tenant Owner
// (assertCanGrantRole, legend-7vsby), and provisioning only grants
// tenant_admin, so a new tenant could never get its first Owner. A Super Admin
// (platform_admins registry, never a support access grant or an impersonated
// session) may appoint or replace an Owner at any time with a fresh second
// factor and a mandatory reason. Tenant actors keep the legend-7vsby rules:
// assertCanGrantRole is not touched by this path.
//
// Every write runs in ONE tenant transaction (RLS) that also takes the same
// per-tenant advisory lock as access.service endRoleAssignment, so a tenant
// Owner ending an Owner and this path serialise. Grant/end write the same
// access events and audit rows as the tenant RBAC service, plus a
// `tenant_owner.assigned` / `tenant_owner.replaced` audit row.

import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import {
  roleAssignmentEndedEvent,
  roleAssignmentGrantedEvent,
} from "@starter/shared/access";
import { createUlid, type ScopedTenantContext } from "@starter/shared/core";
import {
  tenantOwnerAssignmentSchema,
  type AssignTenantOwnerInput,
  type ReplaceTenantOwnerInput,
  platformEvents,
  type TenantOwnerAssignment,
} from "@starter/shared/platform";
import { db } from "../db/index.ts";
import {
  platformAdmins,
  roleAssignments,
  roles,
  supportAccessGrants,
  user,
} from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { SYSTEM_ACCOUNT_ID } from "../lib/system-account.ts";
import { appendAccessEvent, readDbClock } from "./access.service.ts";
import { appendOutbox } from "./core-outbox.ts";
import { recordAudit } from "./audit-writer.ts";
import { resolveAdminAccount } from "./platform-admin-provision.service.ts";
import {
  assertTenantExists,
  isPlatformAdmin,
  platformTenantContext,
  SUPPORT_ACCESS_MFA_MAX_AGE_MS,
} from "./platform-support.service.ts";
import type { Tx } from "./permission-resolver.ts";

type AssignmentRow = typeof roleAssignments.$inferSelect;
type AccountKind = TenantOwnerAssignment["account"];
type DeniedCause =
  "impersonated_session" | "mfa_not_verified" | "read_only_support";

const OWNER_TEMPLATE = "owner";
const OBJECT_TYPE = "role_assignment";
const NOTIFICATION_DESTINATION = "notification";

type OwnerRequest = {
  tenantId: string;
  actorUserId: string;
  /** Better Auth session.impersonated_by; any value refuses the request. */
  impersonatedBy: string | null;
  /** When the six-digit code in this request was verified; null = denied. */
  mfaVerifiedAt: string | null;
  now?: Date;
};

function sameUser(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function isActive(row: AssignmentRow, now: Date): boolean {
  return (
    row.validFrom.getTime() <= now.getTime() &&
    (row.validUntil === null || now.getTime() < row.validUntil.getTime())
  );
}

async function tenantExists(tenantId: string): Promise<boolean> {
  try {
    await assertTenantExists(tenantId);
    return true;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return false;
    throw error;
  }
}

/** The refused attempt is recorded for the tenant in its own transaction. */
async function auditDenied(
  context: ScopedTenantContext,
  actorUserId: string,
  cause: DeniedCause,
  reason: string,
  impersonatedBy: string | null = null,
): Promise<void> {
  await withTenant(db, context, (tx) =>
    recordAudit(
      {
        tenantId: context.tenant.tenantId,
        outletId: null,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "tenant_owner.denied",
        objectType: OBJECT_TYPE,
        objectId: null,
        reason,
        before: null,
        // The real person behind an impersonated session, not only the
        // impersonated account in actorId.
        after: impersonatedBy === null ? { cause } : { cause, impersonatedBy },
        sensitiveAccess: false,
      },
      { tx, context },
    ),
  );
}

/** Same freshness rule as requestSupportAccess (TEN-04). */
function mfaFresh(
  mfaVerifiedAt: string | null,
  now: Date,
  /**
   * Under the lock `now` is the database clock while `mfaVerifiedAt` was
   * stamped by the app clock; the "not in the future" test already ran
   * against the app clock in authorize(), so only the age cap is repeated.
   */
  ageOnly = false,
): boolean {
  const mfaAt = mfaVerifiedAt === null ? Number.NaN : Date.parse(mfaVerifiedAt);
  return (
    Number.isFinite(mfaAt) &&
    (ageOnly || mfaAt <= now.getTime()) &&
    now.getTime() - mfaAt <= SUPPORT_ACCESS_MFA_MAX_AGE_MS
  );
}

/** Checks a–d of the brief, in order; returns the tenant context. */
async function authorize(
  request: OwnerRequest,
  reason: string,
  now: Date,
): Promise<ScopedTenantContext> {
  const context = platformTenantContext(request.tenantId);
  // Only the platform_admins registry authorizes this path: an impersonated
  // session (even one started by a Super Admin) never does.
  if (request.impersonatedBy !== null) {
    if (await tenantExists(request.tenantId))
      await auditDenied(
        context,
        request.actorUserId,
        "impersonated_session",
        reason,
        request.impersonatedBy,
      );
    throw new HttpError(
      403,
      "FORBIDDEN",
      "Sesi impersonasi tidak dapat menunjuk Owner tenant.",
    );
  }
  // Defense in depth: the platform router already checks the registry.
  if (!(await isPlatformAdmin(request.actorUserId)))
    throw new HttpError(403, "FORBIDDEN", "Akun ini bukan Super Admin.");
  await assertTenantExists(request.tenantId);

  // Re-checked under the lock with the database clock in changeOwner.
  if (!mfaFresh(request.mfaVerifiedAt, now)) {
    await auditDenied(context, request.actorUserId, "mfa_not_verified", reason);
    throw new HttpError(
      403,
      "FORBIDDEN",
      "Verifikasi MFA wajib sebelum menunjuk Owner tenant.",
    );
  }
  return context;
}

async function lockOwnerChanges(tx: Tx, tenantId: string): Promise<void> {
  // SAME key as access.service endRoleAssignment: a tenant-side "end Owner"
  // and this path never interleave.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${"legend:role-assignment-end:" + tenantId}, 0))`,
  );
}

async function resolveAccount(
  tx: Tx,
  tenantId: string,
  input: AssignTenantOwnerInput,
  now: Date,
): Promise<{ userId: string; account: AccountKind }> {
  const { account } = input;
  if ("invite" in account) return resolveAdminAccount(tx, account.invite, now);
  const [member] = await tx
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.tenantId, tenantId),
        eq(roleAssignments.userId, account.userId),
        lte(roleAssignments.validFrom, now),
        or(
          isNull(roleAssignments.validUntil),
          gt(roleAssignments.validUntil, now),
        ),
      ),
    )
    .limit(1);
  if (!member)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Akun ini bukan anggota aktif tenant.",
    );
  return { userId: account.userId, account: "member" };
}

/** Same rule as access.service grantRoleAssignment (legend-2dnh). */
async function assertGrantable(
  tx: Tx,
  userId: string,
  now: Date,
): Promise<void> {
  const [grantee] = await tx
    .select({ id: user.id, banned: user.banned, banExpires: user.banExpires })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!grantee)
    throw new HttpError(422, "VALIDATION_ERROR", "Unknown user account.");
  const banActive =
    grantee.banned === true &&
    (grantee.banExpires === null ||
      grantee.banExpires.getTime() > now.getTime());
  if (grantee.id === SYSTEM_ACCOUNT_ID || banActive)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "This account cannot be given a role.",
    );
}

async function ownerRoleId(tx: Tx, tenantId: string): Promise<string> {
  const [role] = await tx
    .select({ id: roles.id })
    .from(roles)
    .where(
      and(eq(roles.tenantId, tenantId), eq(roles.templateKey, OWNER_TEMPLATE)),
    )
    .limit(1);
  // Templates are seeded with the tenant; a missing one is a bug.
  if (!role) throw new Error("owner template was not seeded");
  return role.id;
}

/**
 * Active tenant-scoped Owner rows WITHOUT an end date. A temporary Owner
 * (future valid_until) never counts: reusing one on replace, or counting it as
 * "the tenant still has an Owner", would leave the tenant Owner-less once it
 * expires, and after legend-7vsby only a Super Admin could recover that.
 */
async function permanentOwnerAssignments(
  tx: Tx,
  tenantId: string,
  roleId: string,
  now: Date,
  userId?: string,
) {
  return tx
    .select()
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.tenantId, tenantId),
        eq(roleAssignments.roleId, roleId),
        eq(roleAssignments.scopeType, "tenant"),
        userId === undefined ? undefined : eq(roleAssignments.userId, userId),
        lte(roleAssignments.validFrom, now),
        isNull(roleAssignments.validUntil),
      ),
    );
}

/** Locks the Owner assignment being replaced and checks it is replaceable. */
async function lockReplacedOwner(
  tx: Tx,
  tenantId: string,
  roleId: string,
  assignmentId: string,
  now: Date,
): Promise<AssignmentRow> {
  const [target] = await tx
    .select()
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.id, assignmentId),
        eq(roleAssignments.tenantId, tenantId),
      ),
    )
    .limit(1)
    .for("update");
  if (!target || target.roleId !== roleId || target.scopeType !== "tenant")
    throw new HttpError(404, "NOT_FOUND", "Penugasan Owner tidak ditemukan.");
  if (!isActive(target, now) || now.getTime() <= target.validFrom.getTime())
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Penugasan Owner ini sudah tidak aktif.",
    );
  return target;
}

async function grantOwner(
  tx: Tx,
  context: ScopedTenantContext,
  args: {
    userId: string;
    roleId: string;
    actorUserId: string;
    reason: string;
    mfaVerifiedAt: string;
    now: Date;
  },
): Promise<AssignmentRow> {
  const tenantId = context.tenant.tenantId;
  const [row] = await tx
    .insert(roleAssignments)
    .values({
      tenantId,
      userId: args.userId,
      roleId: args.roleId,
      scopeType: "tenant",
      scopeId: null,
      validFrom: args.now,
      validUntil: null,
      assignedBy: args.actorUserId,
      assignedAt: args.now,
    })
    .returning();
  if (!row) throw new Error("owner assignment insert returned no row");
  // Same event payload and audit snapshot as grantRoleAssignment, so tenant
  // consumers and the audit reader see an ordinary grant.
  await appendAccessEvent(tx, context, roleAssignmentGrantedEvent, {
    aggregateId: row.id,
    actorUserId: args.actorUserId,
    now: args.now,
    payload: {
      assignmentId: row.id,
      userId: row.userId,
      roleId: row.roleId,
      scope: { type: "tenant", id: null },
      validFrom: row.validFrom.toISOString(),
      validUntil: null,
      grantedBy: args.actorUserId,
      reauthenticatedAt: new Date(args.mfaVerifiedAt).toISOString(),
    },
  });
  await recordAudit(
    {
      tenantId,
      outletId: null,
      actorType: "user",
      actorId: args.actorUserId,
      deviceId: null,
      action: "role_assignment.granted",
      objectType: OBJECT_TYPE,
      objectId: row.id,
      reason: args.reason,
      before: null,
      after: {
        userId: row.userId,
        roleId: row.roleId,
        scope: { type: "tenant", id: null },
        validFrom: row.validFrom.toISOString(),
        validUntil: null,
      },
      sensitiveAccess: false,
    },
    { tx, context },
  );
  return row;
}

async function endOwner(
  tx: Tx,
  context: ScopedTenantContext,
  target: AssignmentRow,
  args: { actorUserId: string; reason: string; now: Date },
): Promise<void> {
  const [row] = await tx
    .update(roleAssignments)
    .set({ validUntil: args.now })
    .where(eq(roleAssignments.id, target.id))
    .returning();
  if (!row) throw new Error("owner assignment update returned no row");
  // Same event payload and audit snapshot as endRoleAssignment.
  await appendAccessEvent(tx, context, roleAssignmentEndedEvent, {
    aggregateId: row.id,
    actorUserId: args.actorUserId,
    now: args.now,
    payload: {
      assignmentId: row.id,
      userId: row.userId,
      roleId: row.roleId,
      validUntil: args.now.toISOString(),
      endedBy: args.actorUserId,
      reason: args.reason,
    },
  });
  await recordAudit(
    {
      tenantId: context.tenant.tenantId,
      outletId: null,
      actorType: "user",
      actorId: args.actorUserId,
      deviceId: null,
      action: "role_assignment.ended",
      objectType: OBJECT_TYPE,
      objectId: row.id,
      reason: args.reason,
      before: {
        userId: row.userId,
        roleId: row.roleId,
        validUntil: target.validUntil?.toISOString() ?? null,
      },
      after: { validUntil: args.now.toISOString() },
      sensitiveAccess: false,
    },
    { tx, context },
  );
}

/**
 * legend-fmpgz (Q46): tells the replaced Owner and every active Owner that a
 * platform Super Admin changed the Owner. The event joins the transactional
 * outbox; the worker's notification consumer sends the in-app notification and
 * the email, so a delivery failure never touches this transaction (it lands in
 * delivery_attempts / the dead letter). Appending runs in a savepoint: if even
 * that fails, the appointment stays and a `tenant_owner.notify_failed` audit
 * row records it.
 */
async function notifyOwnerChange(
  tx: Tx,
  context: ScopedTenantContext,
  args: {
    kind: "assigned" | "replaced";
    actorUserId: string;
    reason: string;
    newAssignmentId: string;
    replacedAssignmentId: string | null;
    now: Date;
  },
): Promise<void> {
  const { tenantId } = context.tenant;
  try {
    await tx.transaction(async (savepoint) => {
      const definition = platformEvents["tenant_owner.changed"];
      const aggregateId = createUlid(args.now.getTime());
      const event = definition.envelopeSchema.parse({
        id: createUlid(args.now.getTime()),
        tenantId,
        outletId: null,
        name: definition.name,
        version: definition.version,
        aggregateType: definition.entry.aggregateType,
        aggregateId,
        sequence: 1,
        occurredAt: args.now.toISOString(),
        actor: { type: "user", id: args.actorUserId },
        deviceId: null,
        idempotencyKey: `${definition.name}:${aggregateId}`,
        payloadSchemaRef: definition.payloadSchemaRef,
        payload: {
          kind: args.kind,
          actorUserId: args.actorUserId,
          reason: args.reason,
          changedAt: args.now.toISOString(),
          newAssignmentId: args.newAssignmentId,
          replacedAssignmentId: args.replacedAssignmentId,
        },
      });
      await appendOutbox(savepoint, context, {
        id: createUlid(args.now.getTime()),
        event,
        destination: NOTIFICATION_DESTINATION,
        direction: null,
        peerId: null,
      });
    });
  } catch (error) {
    await recordAudit(
      {
        tenantId,
        outletId: null,
        actorType: "user",
        actorId: args.actorUserId,
        deviceId: null,
        action: "tenant_owner.notify_failed",
        objectType: OBJECT_TYPE,
        objectId: args.newAssignmentId,
        reason: args.reason,
        before: null,
        after: {
          assignmentId: args.newAssignmentId,
          kind: args.kind,
          error: (error instanceof Error ? error.message : String(error)).slice(
            0,
            200,
          ),
        },
        sensitiveAccess: false,
      },
      { tx, context },
    );
  }
}

async function changeOwner(
  request: OwnerRequest & {
    input: AssignTenantOwnerInput;
    replacedAssignmentId: string | null;
  },
): Promise<TenantOwnerAssignment> {
  const { input, tenantId, actorUserId, replacedAssignmentId } = request;
  const context = await authorize(
    request,
    input.reason,
    request.now ?? new Date(),
  );
  // authorize() refuses a null instant.
  const mfaVerifiedAt = request.mfaVerifiedAt as string;

  return withTenant(db, context, async (tx) => {
    await lockOwnerChanges(tx, tenantId);
    // The write instant is read AFTER the lock: a tenant-side "end Owner"
    // that committed while this call waited is then already in the past and
    // seen as ended, so both paths cannot each end the other's Owner.
    // Production reads the database clock (legend-hzdy5); `request.now` stays
    // an override for tests.
    const now = request.now ?? (await readDbClock(tx));
    // authorize() ran before this wait: re-check the Super Admin registry and
    // MFA freshness now that the lock is held (legend-2n5qj). The registry row
    // is read without FOR SHARE: the app role only holds SELECT on
    // platform_admins (drizzle/0007), and a row lock needs UPDATE as well.
    // A revoke that commits while this call waited is therefore seen here.
    const [registryRow] = await tx
      .select({ id: platformAdmins.id })
      .from(platformAdmins)
      .where(
        and(
          eq(platformAdmins.userId, actorUserId),
          isNull(platformAdmins.revokedAt),
        ),
      )
      .limit(1);
    if (!registryRow)
      throw new HttpError(403, "FORBIDDEN", "Akun ini bukan Super Admin.");
    if (!mfaFresh(mfaVerifiedAt, now, true)) {
      // Separate transaction: the refused attempt must survive the rollback.
      await auditDenied(context, actorUserId, "mfa_not_verified", input.reason);
      throw new HttpError(
        403,
        "FORBIDDEN",
        "Verifikasi MFA wajib sebelum menunjuk Owner tenant.",
      );
    }
    // A platform registry grant does not turn an active read-only support
    // session into write access. Check under this target tenant's RLS and the
    // owner-change lock, before resolving accounts or changing assignments.
    const [readOnlySupport] = await tx
      .select({ id: supportAccessGrants.id })
      .from(supportAccessGrants)
      .where(
        and(
          eq(supportAccessGrants.tenantId, tenantId),
          eq(supportAccessGrants.superAdminUserId, actorUserId),
          eq(supportAccessGrants.accessMode, "read_only"),
          lte(supportAccessGrants.startedAt, now),
          gt(supportAccessGrants.expiresAt, now),
          isNull(supportAccessGrants.endedAt),
          isNull(supportAccessGrants.expiryRecordedAt),
        ),
      )
      .limit(1);
    if (readOnlySupport) {
      // Use a separate transaction: throwing below rolls this one back, but
      // the refused attempt must remain visible in the tenant audit log.
      await auditDenied(
        context,
        actorUserId,
        "read_only_support",
        input.reason,
      );
      throw new HttpError(
        403,
        "FORBIDDEN",
        "Sesi dukungan read-only tidak dapat mengubah Owner tenant.",
      );
    }
    const roleId = await ownerRoleId(tx, tenantId);
    const replaced =
      replacedAssignmentId === null
        ? null
        : await lockReplacedOwner(
            tx,
            tenantId,
            roleId,
            replacedAssignmentId,
            now,
          );

    const { userId, account } = await resolveAccount(tx, tenantId, input, now);
    // No self-appointment: the Super Admin's own tenant membership is not
    // raised to Owner through the platform panel.
    if (sameUser(userId, actorUserId))
      throw new HttpError(
        403,
        "FORBIDDEN",
        "Super Admin tidak dapat menunjuk dirinya sendiri sebagai Owner.",
      );
    // Nor another Super Admin: two of them must not appoint each other.
    // Platform staff still become Owner through the tenant path.
    if (await isPlatformAdmin(userId))
      throw new HttpError(
        403,
        "FORBIDDEN",
        "Akun Super Admin tidak dapat ditunjuk sebagai Owner lewat Panel Platform.",
      );
    await assertGrantable(tx, userId, now);
    if (replaced && sameUser(replaced.userId, userId))
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Owner pengganti harus akun yang berbeda.",
      );

    // Only a permanent Owner row is "already Owner"; a temporary one gets a
    // new permanent row next to it.
    const [existing] = await permanentOwnerAssignments(
      tx,
      tenantId,
      roleId,
      now,
      userId,
    );
    if (existing && replaced === null)
      throw new HttpError(
        409,
        "CONFLICT",
        "Akun ini sudah menjadi Owner aktif tenant.",
      );
    const assignment =
      existing ??
      (await grantOwner(tx, context, {
        userId,
        roleId,
        actorUserId,
        reason: input.reason,
        mfaVerifiedAt,
        now,
      }));

    if (replaced) {
      await endOwner(tx, context, replaced, {
        actorUserId,
        reason: input.reason,
        now,
      });
      const remaining = await permanentOwnerAssignments(
        tx,
        tenantId,
        roleId,
        now,
      );
      if (remaining.length === 0)
        throw new HttpError(
          409,
          "CONFLICT",
          "Tenant harus memiliki minimal satu Owner aktif.",
        );
    }

    const result = {
      tenantId,
      assignmentId: assignment.id,
      userId,
      roleId,
      account,
      replacedAssignmentId: replaced?.id ?? null,
    };
    await recordAudit(
      {
        tenantId,
        outletId: null,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: replaced ? "tenant_owner.replaced" : "tenant_owner.assigned",
        objectType: OBJECT_TYPE,
        objectId: assignment.id,
        reason: input.reason,
        before: null,
        after: {
          userId,
          assignmentId: assignment.id,
          replacedAssignmentId: result.replacedAssignmentId,
          account,
        },
        sensitiveAccess: false,
      },
      { tx, context },
    );
    await notifyOwnerChange(tx, context, {
      kind: replaced ? "replaced" : "assigned",
      actorUserId,
      reason: input.reason,
      newAssignmentId: assignment.id,
      replacedAssignmentId: result.replacedAssignmentId,
      now,
    });
    return tenantOwnerAssignmentSchema.parse(result);
  });
}

/** Appoints an Owner (no Owner is ended). 409 when the account already is one. */
export async function assignTenantOwner(
  request: OwnerRequest & { input: AssignTenantOwnerInput },
): Promise<TenantOwnerAssignment> {
  return changeOwner({ ...request, replacedAssignmentId: null });
}

/** Ends `replacedAssignmentId` (an active tenant Owner) and appoints the
 * account; an account that already is an active Owner is reused. */
export async function replaceTenantOwner(
  request: OwnerRequest & {
    input: ReplaceTenantOwnerInput;
    replacedAssignmentId: string;
  },
): Promise<TenantOwnerAssignment> {
  return changeOwner(request);
}
