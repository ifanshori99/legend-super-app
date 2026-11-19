// Sole-Owner self-approval check (founder decision 2026-11-10, legend-b8y6l).
// A tenant with exactly ONE Owner may approve (never reject) a shareholder_version
// request it submitted itself. Tenants with two or more Owners keep the
// distinct-actor rule. The answer is computed in SQL inside the deciding
// transaction, never from caller input.
//
// "Sole Owner" = among Owner assignments (template_key 'owner', tenant scope)
// that have not ended (valid_until IS NULL or in the future; future-dated ones
// COUNT, fail closed), exactly one distinct user exists, that user is the
// actor, and the actor's own assignment has already started.
import type { SelfApprovalBasis } from "@starter/shared/access";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { roleAssignments, roles } from "../db/schema";
import type { TenantTransaction } from "./accounting-shared";
import { readDbClock } from "./access.service";

async function isSoleOwner(
  tx: TenantTransaction,
  tenantId: string,
  actorUserId: string,
  now: Date,
): Promise<boolean> {
  const rows = await tx
    .select({
      userId: roleAssignments.userId,
      validFrom: roleAssignments.validFrom,
    })
    .from(roleAssignments)
    .innerJoin(
      roles,
      and(
        eq(roles.tenantId, roleAssignments.tenantId),
        eq(roles.id, roleAssignments.roleId),
      ),
    )
    .where(
      and(
        eq(roleAssignments.tenantId, tenantId),
        eq(roles.templateKey, "owner"),
        eq(roleAssignments.scopeType, "tenant"),
        or(
          isNull(roleAssignments.validUntil),
          gt(roleAssignments.validUntil, now),
        ),
      ),
    );
  const owners = new Set(rows.map((row) => row.userId.toLowerCase()));
  const actor = actorUserId.toLowerCase();
  return (
    owners.size === 1 &&
    owners.has(actor) &&
    rows.some(
      (row) =>
        row.userId.toLowerCase() === actor &&
        row.validFrom.getTime() <= now.getTime(),
    )
  );
}

/**
 * Takes the per-tenant role-assignment advisory lock (the key grant, end,
 * offboarding and platform-owner changes use, so this serializes against "add
 * a second Owner"), then reads the clock and the Owner rows. Returns
 * "sole_owner" or null. The lock lasts until the transaction ends.
 */
export async function lockAndCheckSoleOwnerSelfApproval(
  tx: TenantTransaction,
  tenantId: string,
  actorUserId: string,
): Promise<SelfApprovalBasis | null> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${"legend:role-assignment-end:" + tenantId}, 0))`,
  );
  // legend-e3qgo: the database clock, read after the lock, so "ended" and
  // "started" are judged by the same clock that stamps valid_until/valid_from.
  const now = await readDbClock(tx);
  return (await isSoleOwner(tx, tenantId, actorUserId, now))
    ? "sole_owner"
    : null;
}

/** Same query without the lock: display only (inbox "may self-approve" hint). */
export async function soleOwnerSelfApprovalPreview(
  tx: TenantTransaction,
  tenantId: string,
  actorUserId: string,
): Promise<boolean> {
  return isSoleOwner(tx, tenantId, actorUserId, new Date());
}
