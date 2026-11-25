// Who can approve one POS override action in one outlet (card 1268 B3).
//
// The POS supervisor-PIN dialog needs names to pick from. The list is the
// server's answer, never a client filter: staff who hold the action's approve
// permission (POS_OVERRIDE_APPROVE_PERMISSION, same check as the override
// itself) at the outlet and have a usable staff PIN there (current pepper, not
// locked). The requester is never listed (AUTH-06). The caller must be an
// active member of the outlet: a name list is not handed out to anyone else.
// Only `userId` and `displayName` leave; roles and PIN state do not.

import { AccessError, type PosOverrideAction } from "@starter/shared/access";
import {
  POS_OVERRIDE_APPROVE_PERMISSION,
  posOverrideApproverSchema,
  type PosOverrideApprover,
} from "@starter/shared/access/override";
import {
  outletIdSchema,
  userIdSchema,
  type TenantContext,
} from "@starter/shared/core";
import {
  and,
  asc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { db } from "../db";
import { roleAssignments } from "../db/schema";
import { staffPins } from "../db/schema/device-pin";
import { user } from "../db/schema/user";
import { withTenant } from "../db/tenant";
import { currentStaffPinPepperVersion } from "./device-pin-pepper";
import {
  isOutletMember,
  outletContext,
  outletTarget,
} from "./device-pin-support";
import {
  loadTenantAccessInTransaction,
  resolveAccessSnapshot,
  toAssignment,
} from "./permission-resolver";

export function listPosOverrideApprovers(
  tenant: TenantContext,
  requesterUserId: string,
  input: { outletId: string; action: PosOverrideAction },
  now = new Date(),
): Promise<PosOverrideApprover[]> {
  const requester = userIdSchema.parse(requesterUserId);
  const outlet = outletIdSchema.parse(input.outletId);
  const permission = POS_OVERRIDE_APPROVE_PERMISSION[input.action];
  // Fail closed: an action without an approve permission has no approvers.
  if (permission === undefined) return Promise.resolve([]);
  const context = outletContext(tenant, outlet);
  return withTenant(db, context, async (tx) => {
    const requesterData = await loadTenantAccessInTransaction(
      tx,
      context,
      requester,
    );
    if (!isOutletMember(tenant, requester, requesterData, outlet, now))
      throw new AccessError(
        "PERMISSION_DENIED",
        "Anda tidak terdaftar di outlet ini.",
      );
    const candidates = await tx
      .select({ userId: user.id, displayName: user.name })
      .from(staffPins)
      .innerJoin(user, eq(user.id, staffPins.userId))
      .where(
        and(
          eq(staffPins.tenantId, tenant.tenantId),
          eq(staffPins.outletId, outlet),
          ne(staffPins.userId, requester),
          lte(staffPins.pepperVersion, currentStaffPinPepperVersion()),
          // A locked PIN cannot approve: do not offer it.
          or(
            isNull(staffPins.lockedUntil),
            lte(staffPins.lockedUntil, sql`statement_timestamp()`),
          ),
          sql`${user.banned} IS NOT TRUE`,
        ),
      )
      .orderBy(asc(user.name), asc(user.id));
    if (candidates.length === 0) return [];
    // Roles and org tree are shared; assignments come in one query for every
    // candidate (the snapshot filters by user), as the open-bill approver list.
    const shared = await loadTenantAccessInTransaction(
      tx,
      context,
      candidates[0]!.userId,
    );
    const assignmentRows = await tx
      .select({
        ...getTableColumns(roleAssignments),
        dbClock: sql<Date | string>`statement_timestamp()`.as("db_clock"),
      })
      .from(roleAssignments)
      .where(
        and(
          eq(roleAssignments.tenantId, tenant.tenantId),
          inArray(
            roleAssignments.userId,
            candidates.map((candidate) => candidate.userId),
          ),
          lte(roleAssignments.validFrom, sql`statement_timestamp()`),
          or(
            isNull(roleAssignments.validUntil),
            gt(roleAssignments.validUntil, sql`statement_timestamp()`),
          ),
        ),
      );
    const rawClock = assignmentRows[0]?.dbClock;
    const data = {
      ...shared,
      assignments: assignmentRows.map(toAssignment),
      clock:
        rawClock === undefined
          ? new Date()
          : rawClock instanceof Date
            ? rawClock
            : new Date(rawClock),
    };
    const approvers: PosOverrideApprover[] = [];
    for (const candidate of candidates) {
      const allowed = resolveAccessSnapshot({
        tenant,
        userId: candidate.userId,
        ...data,
        mfaVerified: false,
        now,
      }).allows(permission, outletTarget(outlet));
      if (!allowed) continue;
      approvers.push(
        posOverrideApproverSchema.parse({
          userId: candidate.userId,
          displayName: candidate.displayName,
        }),
      );
    }
    return approvers;
  });
}
