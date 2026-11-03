// First tenant admin, appointed when the tenant is created (PRD v1.7 §3 F4
// flow R steps 2-3 "Super Admin menunjuk admin pertama tenant", TEN-06; bead
// legend-2ign).
//
// Runs on the caller's tenant transaction (createTenant), so the tenant row,
// its role templates, the admin's account and the tenant_admin assignment
// commit together or not at all. Nothing here issues a password, a session or
// a token: the admin proves the WhatsApp number the Super Admin entered with
// the reverse-OTP login (AUTH-01), which resolves to the account made here
// through its `user_identities` row, or uses the email magic link when an
// email was given. `tenant.created` (written by the caller) carries
// `firstAdminUserId` so the notification side can send the invitation.
//
// Account rules (PRD §6 B: one WhatsApp number maps to one account
// platform-wide):
// 1. The number already has an identity -> that account is reused. Every
//    identity row was written by a verified login or by this provisioning, so
//    the number is the account's login proof either way.
// 2. Otherwise an email whose Better Auth account is *verified* -> reused. The
//    number is NOT attached to it: a mistyped number would otherwise hand a
//    stranger an existing account (and every tenant it belongs to). The admin
//    signs in by email and links WhatsApp later through the verified link flow.
// 3. Otherwise a new, unverified account: the given email when no account uses
//    it, else the reserved `<digest>@wa.invalid` placeholder (same rule as
//    identity-account.service.ts). An unverified account that already holds the
//    email is never claimed.
// A banned account is refused (fail closed) and the whole creation rolls back.

import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import { normalizeEmail } from "@starter/shared/identity";
import type { CreateTenantInput } from "@starter/shared/platform";
import {
  roleAssignments,
  roles,
  user,
  userIdentities,
} from "../db/schema/index.ts";
import { HttpError } from "../lib/http-error.ts";
import { whatsAppDigest } from "../lib/identity-digest.ts";
import { sealSecret } from "../lib/secrets.ts";
import { recordAudit } from "./audit-writer.ts";
import type { Tx } from "./permission-resolver.ts";

export type FirstAdminProvisioning = {
  readonly userId: string;
  readonly assignmentId: string;
  readonly roleId: string;
  /** `reused`: an existing account; `invited`: created here, not yet signed in. */
  readonly account: "reused" | "invited";
};

const FIRST_ADMIN_TEMPLATE = "tenant_admin";

/**
 * Creates or reuses the first admin's account and grants it the seeded
 * tenant_admin template, tenant-scoped, inside `tx`. Idempotent per
 * (tenant, account): a per-tenant advisory lock serialises callers and an
 * existing open tenant_admin assignment is returned instead of a duplicate.
 */
export async function provisionFirstTenantAdmin(
  tx: Tx,
  context: ScopedTenantContext,
  firstAdmin: CreateTenantInput["firstAdmin"],
  options: { actorUserId: string; now: Date },
): Promise<FirstAdminProvisioning> {
  const tenantId = context.tenant.tenantId;
  if (context.outletScope.kind !== "tenant")
    throw new Error("First admin provisioning needs a tenant-wide scope");
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`tenant-first-admin:${tenantId}`}::text, 0))`,
  );

  const { userId, account } = await resolveAdminAccount(
    tx,
    firstAdmin,
    options.now,
  );

  const [role] = await tx
    .select({ id: roles.id })
    .from(roles)
    .where(
      and(
        eq(roles.tenantId, tenantId),
        eq(roles.templateKey, FIRST_ADMIN_TEMPLATE),
      ),
    )
    .limit(1);
  // The templates are seeded in the same transaction; a missing one is a bug.
  if (!role) throw new Error("tenant_admin template was not seeded");

  const [existing] = await tx
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.tenantId, tenantId),
        eq(roleAssignments.userId, userId),
        eq(roleAssignments.roleId, role.id),
        eq(roleAssignments.scopeType, "tenant"),
        isNull(roleAssignments.validUntil),
      ),
    )
    .limit(1);
  if (existing)
    return { userId, assignmentId: existing.id, roleId: role.id, account };

  const [assignment] = await tx
    .insert(roleAssignments)
    .values({
      tenantId,
      userId,
      roleId: role.id,
      scopeType: "tenant",
      scopeId: null,
      validFrom: options.now,
      validUntil: null,
      assignedBy: options.actorUserId,
      assignedAt: options.now,
    })
    .returning();

  // Same action and snapshot shape as access.service grantRoleAssignment, so
  // the tenant's audit reader shows the appointment like any other grant.
  await recordAudit(
    {
      tenantId,
      outletId: null,
      actorType: "user",
      actorId: options.actorUserId,
      deviceId: null,
      action: "role_assignment.granted",
      objectType: "role_assignment",
      objectId: assignment.id,
      reason: null,
      before: null,
      after: {
        userId,
        roleId: role.id,
        scope: { type: "tenant", id: null },
        validFrom: assignment.validFrom.toISOString(),
        validUntil: null,
      },
      sensitiveAccess: false,
    },
    { tx, context },
  );
  return { userId, assignmentId: assignment.id, roleId: role.id, account };
}

async function resolveAdminAccount(
  tx: Tx,
  firstAdmin: CreateTenantInput["firstAdmin"],
  now: Date,
): Promise<{ userId: string; account: "reused" | "invited" }> {
  const digest = await whatsAppDigest(firstAdmin.whatsapp);

  const byNumber = await identityOwner(tx, digest);
  if (byNumber)
    return { userId: await usable(tx, byNumber), account: "reused" };

  const email = normalizeEmail(firstAdmin.email);
  let emailFree = false;
  if (email !== null) {
    const [holder] = await tx
      .select({ id: user.id, emailVerified: user.emailVerified })
      .from(user)
      .where(eq(user.email, email))
      .limit(1);
    if (holder?.emailVerified)
      return { userId: await usable(tx, holder.id), account: "reused" };
    emailFree = holder === undefined;
  }

  // Claim the number first: the unique (type, value_hash) key decides a race
  // with a concurrent login or provisioning, and the loser reuses the winner.
  const userId = randomUUID();
  const [claimed] = await tx
    .insert(userIdentities)
    .values({
      userId,
      type: "whatsapp",
      valueHash: digest,
      valueEncrypted: sealSecret(
        firstAdmin.whatsapp,
        `user_identity:whatsapp:${digest}`,
      ),
      // Not verified until the admin's first WhatsApp login proves the number.
      verifiedAt: null,
      isPrimary: true,
      createdAt: now,
    })
    .onConflictDoNothing({
      target: [userIdentities.type, userIdentities.valueHash],
    })
    .returning({ userId: userIdentities.userId });
  if (!claimed) {
    const winner = await identityOwner(tx, digest);
    if (!winner)
      throw new Error("WhatsApp identity vanished during provisioning");
    return { userId: await usable(tx, winner), account: "reused" };
  }

  const candidates = [
    ...(email !== null && emailFree ? [email] : []),
    `${digest}@wa.invalid`,
  ];
  for (const candidate of candidates) {
    const [created] = await tx
      .insert(user)
      .values({
        id: userId,
        name: firstAdmin.name,
        email: candidate,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: user.email })
      .returning({ id: user.id });
    if (created) return { userId: created.id, account: "invited" };
  }
  throw new HttpError(
    409,
    "CONFLICT",
    "The first admin's contact is already used by another account.",
  );
}

async function identityOwner(tx: Tx, digest: string): Promise<string | null> {
  const [row] = await tx
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.type, "whatsapp"),
        eq(userIdentities.valueHash, digest),
      ),
    )
    .limit(1);
  return row?.userId ?? null;
}

/** The account exists and is not banned; anything else refuses the tenant. */
async function usable(tx: Tx, userId: string): Promise<string> {
  const [row] = await tx
    .select({ id: user.id, banned: user.banned })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!row || row.banned)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "The first admin's account cannot be used.",
    );
  return row.id;
}
