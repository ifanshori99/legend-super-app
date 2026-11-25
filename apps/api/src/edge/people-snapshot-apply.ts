// Edge people snapshot, apply side (bead legend-tkycp; design
// docs/design/hris-edge-replication.md 3.3).
//
// The cloud ships a full, read-only projection of the people an outlet needs to
// clock offline (users, roles, role assignments, employees, shifts, attendance
// policies, QR day keys, selfie seal public key). This module applies it in ONE
// transaction, all or nothing, so a failed apply keeps the previous rows and
// the previous ETag.
//
// Two passes, because none of the unique keys is deferrable:
// 1. Free keys. Every edge row that is absent from the snapshot, or whose
//    unique-key columns differ from its snapshot row, is deleted or detached:
//    - employees: detached (`suspended`, `user_id` NULL, placeholder
//      `employee_no`); the row stays for FK from local `attendance_logs`.
//    - users: absent users are banned and their sessions deleted. Sessions of
//      users the snapshot itself marks banned go too.
//    - role_assignments: absent ones are deleted.
//    - roles: absent or key-changed roles are renamed `~detached-<id>` with
//      `template_key` NULL and `is_template` false (all three: the CHECK
//      `roles_template_check` needs them together). Absent roles that nothing
//      references are deleted at the end, once the upserted assignments no
//      longer point at them.
//    - shifts: deleted, or `cancelled` when a local attendance log, duty meal
//      or swap request references them.
//    - attendance policies: the outlet override is deleted when absent; the
//      tenant default only when the snapshot carries it under another id.
//    - QR day keys: the set for the outlet is replaced (diffed, so an
//      identical set rewrites nothing).
// 2. Upsert by id in FK order. The cloud always wins; the edge never sends
//    this data back.
//
// After pass 1 a clash can only come from two rows of the same snapshot, which
// the cloud's own unique keys rule out. A unique violation anyway aborts the
// apply with LOCAL_CONFLICT. Any other database error becomes LOCAL_WRITE
// (a code only: driver messages can carry SQL parameters).
//
// Sealed PII columns of `employees` are never written: they stay NULL on the
// edge. User rows get `email_verified = false` and the placeholder email.

import {
  and,
  eq,
  inArray,
  isNull,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { UserId } from "@starter/shared/core";
import {
  edgePeopleSnapshotSchema,
  type EdgePeopleSnapshot,
} from "@starter/shared/edge/people-snapshot";
import { db } from "../db/index.ts";
import type * as schema from "../db/schema/index.ts";
import {
  edgeAttendanceQrKeys,
  edgePeopleSyncState,
} from "../db/schema/edge-hris.ts";
import {
  attendanceDutyMeals,
  attendanceLogs,
  attendancePolicies,
} from "../db/schema/hris-attendance.ts";
import { employees } from "../db/schema/hris.ts";
import {
  shiftAssignments,
  shiftSwapRequests,
} from "../db/schema/hris-scheduling.ts";
import {
  roleAssignments,
  roles,
  approvalPolicies,
} from "../db/schema/platform-access.ts";
import { session } from "../db/schema/session.ts";
import { user } from "../db/schema/user.ts";
import { withTenant } from "../db/tenant.ts";
import { edgeNodeContext } from "../services/edge-node.service.ts";
import type { parseEdgeCredential } from "./credential.ts";
import { DETACHED_ROLE_PREFIX } from "./detached-role.ts";

type Database = NodePgDatabase<typeof schema>;
type Claims = NonNullable<ReturnType<typeof parseEdgeCredential>>;
type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];

export type EdgePeopleSnapshotErrorCode =
  "LOCAL_CONFLICT" | "LOCAL_WRITE" | "BAD_SNAPSHOT" | "SCOPE_MISMATCH";

/** code only, never the driver message (it can carry SQL parameters). */
export class EdgePeopleSnapshotError extends Error {
  readonly code: EdgePeopleSnapshotErrorCode;

  constructor(code: EdgePeopleSnapshotErrorCode) {
    super(`Edge people snapshot failed (${code})`);
    this.name = "EdgePeopleSnapshotError";
    this.code = code;
  }
}

export type EdgePeopleSyncStateView = {
  snapshotEtag: string | null;
  lastCheckedAt: Date | null;
  appliedAt: Date | null;
};

/** Rows per statement: keeps every statement far below the 65535 parameter cap. */
const CHUNK = 500;

function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** `excluded.<column>` of an upsert. */
function excluded(column: PgColumn): SQL {
  return sql`excluded.${sql.identifier(column.name)}`;
}

/** Postgres SQLSTATE, also when drizzle wraps the driver error as `cause`. */
function sqlState(error: unknown, depth = 0): string | null {
  if (depth > 4 || typeof error !== "object" || error === null) return null;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (
    typeof candidate.code === "string" &&
    /^[0-9A-Z]{5}$/.test(candidate.code)
  )
    return candidate.code;
  return sqlState(candidate.cause, depth + 1);
}

function assertScope(claims: Claims, snapshot: EdgePeopleSnapshot): void {
  const tenantId = claims.tenantId;
  const outletId = claims.outletId;
  const ok =
    snapshot.roles.every((row) => sameId(row.tenantId, tenantId)) &&
    snapshot.roleAssignments.every(
      (row) =>
        sameId(row.tenantId, tenantId) &&
        (row.scope.type !== "outlet" || sameId(row.scope.id, outletId)),
    ) &&
    snapshot.employees.every(
      (row) =>
        sameId(row.tenantId, tenantId) && sameId(row.homeOutletId, outletId),
    ) &&
    snapshot.shiftAssignments.every(
      (row) => sameId(row.tenantId, tenantId) && sameId(row.outletId, outletId),
    ) &&
    snapshot.attendancePolicies.every(
      (row) =>
        sameId(row.tenantId, tenantId) &&
        (row.outletId === null || sameId(row.outletId, outletId)),
    );
  if (!ok) throw new EdgePeopleSnapshotError("SCOPE_MISMATCH");
}

/** 30 characters, matches `employees_employee_no_check`, unique per id. */
function detachedEmployeeNo(id: string): string {
  return `X${id.replaceAll("-", "").slice(0, 29).toUpperCase()}`;
}

async function freeUsers(tx: Tx, snapshot: EdgePeopleSnapshot): Promise<void> {
  const keep = snapshot.users.map((row) => row.id as string);
  const absent = (
    await tx
      .select({ id: user.id })
      .from(user)
      .where(keep.length > 0 ? notInArray(user.id, keep) : undefined)
  ).map((row) => row.id);
  const banned = snapshot.users
    .filter((row) => row.banned)
    .map((row) => row.id);
  for (const ids of chunks(absent))
    await tx
      .update(user)
      .set({ banned: true })
      .where(
        and(inArray(user.id, ids), sql`${user.banned} IS DISTINCT FROM true`),
      );
  for (const ids of chunks([...absent, ...banned]))
    await tx.delete(session).where(inArray(session.userId, ids));
}

async function freeRoleAssignments(
  tx: Tx,
  claims: Claims,
  snapshot: EdgePeopleSnapshot,
): Promise<void> {
  const keep = snapshot.roleAssignments.map((row) => row.id);
  await tx
    .delete(roleAssignments)
    .where(
      and(
        eq(roleAssignments.tenantId, claims.tenantId),
        keep.length > 0 ? notInArray(roleAssignments.id, keep) : undefined,
      ),
    );
}

/** Returns the ids of absent roles: deleted at the end when nothing uses them. */
async function freeRoles(
  tx: Tx,
  claims: Claims,
  snapshot: EdgePeopleSnapshot,
): Promise<string[]> {
  const incoming = new Map(
    snapshot.roles.map((row) => [row.id.toLowerCase(), row]),
  );
  const existing = await tx
    .select({
      id: roles.id,
      name: roles.name,
      templateKey: roles.templateKey,
      isTemplate: roles.isTemplate,
    })
    .from(roles)
    .where(eq(roles.tenantId, claims.tenantId));
  const detach: string[] = [];
  const absent: string[] = [];
  for (const row of existing) {
    const next = incoming.get(row.id.toLowerCase());
    if (next === undefined) {
      absent.push(row.id);
      const detached =
        row.name === `${DETACHED_ROLE_PREFIX}${row.id}` &&
        row.templateKey === null &&
        !row.isTemplate;
      if (!detached) detach.push(row.id);
    } else if (row.name !== next.name || row.templateKey !== next.templateKey) {
      detach.push(row.id);
    }
  }
  for (const ids of chunks(detach))
    await tx
      .update(roles)
      .set({
        name: sql`${DETACHED_ROLE_PREFIX} || ${roles.id}::text`,
        templateKey: null,
        isTemplate: false,
      })
      .where(and(eq(roles.tenantId, claims.tenantId), inArray(roles.id, ids)));
  return absent;
}

async function freeEmployees(
  tx: Tx,
  claims: Claims,
  snapshot: EdgePeopleSnapshot,
): Promise<void> {
  const incoming = new Map(
    snapshot.employees.map((row) => [row.id.toLowerCase(), row]),
  );
  const existing = await tx
    .select({
      id: employees.id,
      userId: employees.userId,
      employeeNo: employees.employeeNo,
      status: employees.status,
    })
    .from(employees)
    .where(eq(employees.tenantId, claims.tenantId));
  const detach: string[] = [];
  for (const row of existing) {
    const next = incoming.get(row.id.toLowerCase());
    if (next === undefined) {
      const detached =
        row.status === "suspended" &&
        row.userId === null &&
        row.employeeNo === detachedEmployeeNo(row.id);
      if (!detached) detach.push(row.id);
    } else if (
      row.employeeNo !== next.employeeNo ||
      row.userId !== next.userId
    ) {
      detach.push(row.id);
    }
  }
  for (const ids of chunks(detach))
    await tx
      .update(employees)
      .set({
        status: "suspended",
        userId: null,
        employeeNo: sql`'X' || upper(left(replace(${employees.id}::text, '-', ''), 29))`,
      })
      .where(
        and(
          eq(employees.tenantId, claims.tenantId),
          inArray(employees.id, ids),
        ),
      );
}

async function freeShifts(
  tx: Tx,
  claims: Claims,
  snapshot: EdgePeopleSnapshot,
): Promise<void> {
  const keep = new Set(
    snapshot.shiftAssignments.map((row) => row.id.toLowerCase()),
  );
  const existing = await tx
    .select({ id: shiftAssignments.id, status: shiftAssignments.status })
    .from(shiftAssignments)
    .where(
      and(
        eq(shiftAssignments.tenantId, claims.tenantId),
        eq(shiftAssignments.outletId, claims.outletId),
      ),
    );
  const stale = existing.filter((row) => !keep.has(row.id.toLowerCase()));
  const referenced = new Set<string>();
  for (const ids of chunks(stale.map((row) => row.id))) {
    // One after the other: a transaction has one connection.
    const logs = await tx
      .select({ id: attendanceLogs.shiftAssignmentId })
      .from(attendanceLogs)
      .where(inArray(attendanceLogs.shiftAssignmentId, ids));
    const meals = await tx
      .select({ id: attendanceDutyMeals.shiftAssignmentId })
      .from(attendanceDutyMeals)
      .where(inArray(attendanceDutyMeals.shiftAssignmentId, ids));
    const swapsFrom = await tx
      .select({ id: shiftSwapRequests.fromAssignmentId })
      .from(shiftSwapRequests)
      .where(inArray(shiftSwapRequests.fromAssignmentId, ids));
    const swapsTo = await tx
      .select({ id: shiftSwapRequests.toAssignmentId })
      .from(shiftSwapRequests)
      .where(inArray(shiftSwapRequests.toAssignmentId, ids));
    for (const row of [...logs, ...meals, ...swapsFrom, ...swapsTo])
      if (row.id !== null) referenced.add(row.id.toLowerCase());
  }
  const cancel = stale
    .filter((row) => referenced.has(row.id.toLowerCase()))
    .filter((row) => row.status !== "cancelled")
    .map((row) => row.id);
  const remove = stale
    .filter((row) => !referenced.has(row.id.toLowerCase()))
    .map((row) => row.id);
  for (const ids of chunks(cancel))
    await tx
      .update(shiftAssignments)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(shiftAssignments.tenantId, claims.tenantId),
          inArray(shiftAssignments.id, ids),
        ),
      );
  for (const ids of chunks(remove))
    await tx
      .delete(shiftAssignments)
      .where(
        and(
          eq(shiftAssignments.tenantId, claims.tenantId),
          inArray(shiftAssignments.id, ids),
        ),
      );
}

async function freePolicies(
  tx: Tx,
  claims: Claims,
  snapshot: EdgePeopleSnapshot,
): Promise<void> {
  const incoming = new Map(
    snapshot.attendancePolicies.map((row) => [row.id.toLowerCase(), row]),
  );
  const incomingDefault = snapshot.attendancePolicies.find(
    (row) => row.outletId === null,
  );
  const existing = await tx
    .select({
      id: attendancePolicies.id,
      outletId: attendancePolicies.outletId,
    })
    .from(attendancePolicies)
    .where(
      and(
        eq(attendancePolicies.tenantId, claims.tenantId),
        or(
          isNull(attendancePolicies.outletId),
          eq(attendancePolicies.outletId, claims.outletId),
        ),
      ),
    );
  const remove: string[] = [];
  for (const row of existing) {
    const next = incoming.get(row.id.toLowerCase());
    const sameKey =
      next !== undefined &&
      (next.outletId === null
        ? row.outletId === null
        : row.outletId !== null && sameId(next.outletId, row.outletId));
    if (sameKey) continue;
    if (row.outletId === null) {
      // The tenant default always comes; free its key only for a new id.
      if (incomingDefault !== undefined) remove.push(row.id);
    } else {
      remove.push(row.id);
    }
  }
  for (const ids of chunks(remove))
    await tx
      .delete(attendancePolicies)
      .where(
        and(
          eq(attendancePolicies.tenantId, claims.tenantId),
          inArray(attendancePolicies.id, ids),
        ),
      );
}

async function replaceQrKeys(
  tx: Tx,
  claims: Claims,
  snapshot: EdgePeopleSnapshot,
  now: Date,
): Promise<void> {
  const scope = and(
    eq(edgeAttendanceQrKeys.tenantId, claims.tenantId),
    eq(edgeAttendanceQrKeys.outletId, claims.outletId),
  );
  const incoming = new Map(
    snapshot.qrKeys.map((row) => [
      row.dayIndex,
      Buffer.from(row.key, "base64"),
    ]),
  );
  const existing = await tx
    .select({
      dayIndex: edgeAttendanceQrKeys.dayIndex,
      key: edgeAttendanceQrKeys.key,
    })
    .from(edgeAttendanceQrKeys)
    .where(scope);
  const have = new Map(existing.map((row) => [row.dayIndex, row.key]));
  const drop = existing
    .filter((row) => {
      const next = incoming.get(row.dayIndex);
      return next === undefined || !next.equals(row.key);
    })
    .map((row) => row.dayIndex);
  for (const days of chunks(drop))
    await tx
      .delete(edgeAttendanceQrKeys)
      .where(and(scope, inArray(edgeAttendanceQrKeys.dayIndex, days)));
  const add = [...incoming.entries()].filter(([dayIndex, key]) => {
    const kept = have.get(dayIndex);
    return kept === undefined || !key.equals(kept);
  });
  for (const rows of chunks(add))
    await tx.insert(edgeAttendanceQrKeys).values(
      rows.map(([dayIndex, key]) => ({
        tenantId: claims.tenantId,
        outletId: claims.outletId,
        dayIndex,
        key,
        receivedAt: now,
      })),
    );
}

async function upsertPeople(
  tx: Tx,
  claims: Claims,
  snapshot: EdgePeopleSnapshot,
): Promise<void> {
  for (const rows of chunks(snapshot.users))
    await tx
      .insert(user)
      .values(
        rows.map((row) => ({
          id: row.id,
          name: row.name,
          email: row.email,
          emailVerified: false,
          banned: row.banned,
          createdAt: new Date(row.createdAt),
          updatedAt: new Date(row.updatedAt),
        })),
      )
      .onConflictDoUpdate({
        target: user.id,
        set: {
          name: excluded(user.name),
          email: excluded(user.email),
          emailVerified: excluded(user.emailVerified),
          banned: excluded(user.banned),
          banReason: null,
          banExpires: null,
          createdAt: excluded(user.createdAt),
          updatedAt: excluded(user.updatedAt),
        },
      });

  for (const rows of chunks(snapshot.roles))
    await tx
      .insert(roles)
      .values(
        rows.map((row) => ({
          id: row.id,
          tenantId: row.tenantId,
          name: row.name,
          isTemplate: row.isTemplate,
          templateKey: row.templateKey,
          permissions: row.permissions,
          mfaRequired: row.mfaRequired,
          allowedScopeTypes: row.allowedScopeTypes,
          createdAt: new Date(row.createdAt),
          updatedAt: new Date(row.updatedAt),
        })),
      )
      .onConflictDoUpdate({
        target: roles.id,
        set: {
          tenantId: excluded(roles.tenantId),
          name: excluded(roles.name),
          isTemplate: excluded(roles.isTemplate),
          templateKey: excluded(roles.templateKey),
          permissions: excluded(roles.permissions),
          mfaRequired: excluded(roles.mfaRequired),
          allowedScopeTypes: excluded(roles.allowedScopeTypes),
          createdAt: excluded(roles.createdAt),
          updatedAt: excluded(roles.updatedAt),
        },
      });

  for (const rows of chunks(snapshot.roleAssignments))
    await tx
      .insert(roleAssignments)
      .values(
        rows.map((row) => ({
          id: row.id,
          tenantId: row.tenantId,
          userId: row.userId,
          roleId: row.roleId,
          scopeType: row.scope.type,
          scopeId: row.scope.id,
          validFrom: new Date(row.validFrom),
          validUntil: row.validUntil === null ? null : new Date(row.validUntil),
          assignedBy: row.assignedBy,
          assignedAt: new Date(row.assignedAt),
        })),
      )
      .onConflictDoUpdate({
        target: roleAssignments.id,
        set: {
          tenantId: excluded(roleAssignments.tenantId),
          userId: excluded(roleAssignments.userId),
          roleId: excluded(roleAssignments.roleId),
          scopeType: excluded(roleAssignments.scopeType),
          scopeId: excluded(roleAssignments.scopeId),
          validFrom: excluded(roleAssignments.validFrom),
          validUntil: excluded(roleAssignments.validUntil),
          assignedBy: excluded(roleAssignments.assignedBy),
          assignedAt: excluded(roleAssignments.assignedAt),
        },
      });

  // Sealed PII columns are not in the set: they stay NULL on the edge.
  for (const rows of chunks(snapshot.employees))
    await tx
      .insert(employees)
      .values(
        rows.map((row) => ({
          id: row.id,
          tenantId: row.tenantId,
          userId: row.userId,
          employeeNo: row.employeeNo,
          fullName: row.fullName,
          homeOutletId: row.homeOutletId,
          employmentType: row.employmentType,
          joinDate: row.joinDate,
          endDate: row.endDate,
          status: row.status,
        })),
      )
      .onConflictDoUpdate({
        target: employees.id,
        set: {
          tenantId: excluded(employees.tenantId),
          userId: excluded(employees.userId),
          employeeNo: excluded(employees.employeeNo),
          fullName: excluded(employees.fullName),
          homeOutletId: excluded(employees.homeOutletId),
          employmentType: excluded(employees.employmentType),
          joinDate: excluded(employees.joinDate),
          endDate: excluded(employees.endDate),
          status: excluded(employees.status),
          updatedAt: sql`now()`,
        },
        // The snapshot carries no updated_at for employees: touch the row only
        // when something changed, so a repeat apply is a real no-op.
        setWhere: sql`(${employees.tenantId}, ${employees.userId}, ${employees.employeeNo}, ${employees.fullName}, ${employees.homeOutletId}, ${employees.employmentType}, ${employees.joinDate}, ${employees.endDate}, ${employees.status}) IS DISTINCT FROM (${excluded(employees.tenantId)}, ${excluded(employees.userId)}, ${excluded(employees.employeeNo)}, ${excluded(employees.fullName)}, ${excluded(employees.homeOutletId)}, ${excluded(employees.employmentType)}, ${excluded(employees.joinDate)}, ${excluded(employees.endDate)}, ${excluded(employees.status)})`,
      });

  for (const rows of chunks(snapshot.shiftAssignments))
    await tx
      .insert(shiftAssignments)
      .values(
        rows.map((row) => ({
          id: row.id,
          tenantId: row.tenantId,
          outletId: row.outletId,
          employeeId: row.employeeId,
          shiftTemplateId: null,
          stationId: null,
          businessDate: row.businessDate,
          segments: row.segments,
          breakMinutes: row.breakMinutes,
          status: row.status,
          source: row.source,
          // `shift_assignments_published_check`: published_by and published_at
          // are both set or both NULL. The snapshot carries no publisher, so
          // the opaque creator stands in (the edge never reads it).
          publishedBy:
            row.publishedAt === null ? null : (row.createdBy as UserId),
          publishedAt:
            row.publishedAt === null ? null : new Date(row.publishedAt),
          createdBy: row.createdBy as UserId,
        })),
      )
      .onConflictDoUpdate({
        target: shiftAssignments.id,
        set: {
          tenantId: excluded(shiftAssignments.tenantId),
          outletId: excluded(shiftAssignments.outletId),
          employeeId: excluded(shiftAssignments.employeeId),
          shiftTemplateId: excluded(shiftAssignments.shiftTemplateId),
          stationId: excluded(shiftAssignments.stationId),
          businessDate: excluded(shiftAssignments.businessDate),
          segments: excluded(shiftAssignments.segments),
          breakMinutes: excluded(shiftAssignments.breakMinutes),
          status: excluded(shiftAssignments.status),
          source: excluded(shiftAssignments.source),
          publishedBy: excluded(shiftAssignments.publishedBy),
          publishedAt: excluded(shiftAssignments.publishedAt),
          createdBy: excluded(shiftAssignments.createdBy),
          updatedAt: sql`now()`,
        },
      });

  for (const rows of chunks(snapshot.attendancePolicies))
    await tx
      .insert(attendancePolicies)
      .values(
        rows.map((row) => ({
          id: row.id,
          tenantId: row.tenantId,
          outletId: row.outletId,
          policy: row.policy,
          sampling: row.sampling,
          updatedBy: row.updatedBy as UserId,
          createdAt: new Date(row.createdAt),
          updatedAt: new Date(row.updatedAt),
        })),
      )
      .onConflictDoUpdate({
        target: attendancePolicies.id,
        set: {
          tenantId: excluded(attendancePolicies.tenantId),
          outletId: excluded(attendancePolicies.outletId),
          policy: excluded(attendancePolicies.policy),
          sampling: excluded(attendancePolicies.sampling),
          updatedBy: excluded(attendancePolicies.updatedBy),
          createdAt: excluded(attendancePolicies.createdAt),
          updatedAt: excluded(attendancePolicies.updatedAt),
        },
      });
}

/** Deletes absent (detached) roles once no assignment or approval policy uses them. */
async function dropUnusedRoles(
  tx: Tx,
  claims: Claims,
  absentRoleIds: readonly string[],
): Promise<void> {
  if (absentRoleIds.length === 0) return;
  const used = new Set<string>();
  // One after the other: a transaction has one connection.
  const assigned = await tx
    .select({ id: roleAssignments.roleId })
    .from(roleAssignments)
    .where(eq(roleAssignments.tenantId, claims.tenantId));
  const approvers = await tx
    .select({ id: approvalPolicies.approverRoleId })
    .from(approvalPolicies)
    .where(eq(approvalPolicies.tenantId, claims.tenantId));
  for (const row of [...assigned, ...approvers]) used.add(row.id.toLowerCase());
  const drop = absentRoleIds.filter((id) => !used.has(id.toLowerCase()));
  for (const ids of chunks(drop))
    await tx
      .delete(roles)
      .where(and(eq(roles.tenantId, claims.tenantId), inArray(roles.id, ids)));
}

/**
 * Applies a verified people snapshot in one transaction. `snapshot` is
 * re-validated here (`BAD_SNAPSHOT`) and its scope checked against the
 * credential (`SCOPE_MISMATCH`) before anything is written. Throws
 * EdgePeopleSnapshotError only; a failed apply leaves the previous rows and
 * ETag.
 */
export async function applyEdgePeopleSnapshot(args: {
  claims: Claims;
  snapshot: unknown;
  etag: string;
  generatedAt: Date | null;
  now?: Date;
  database?: Database;
}): Promise<void> {
  const { claims, etag, generatedAt } = args;
  const now = args.now ?? new Date();
  const parsed = edgePeopleSnapshotSchema.safeParse(args.snapshot);
  if (!parsed.success) throw new EdgePeopleSnapshotError("BAD_SNAPSHOT");
  // The cloud ships a user who is banned right now together with the active
  // role assignments the ban left in place. On the edge the trigger
  // `role_assignments_grantee_guard` refuses an assignment for a banned
  // grantee, which would fail the whole apply on every cycle. A banned user
  // clocks and signs in with nothing here, so those assignments are dropped
  // (and pass 1 deletes any the edge already holds).
  const bannedUserIds = new Set(
    parsed.data.users
      .filter((row) => row.banned)
      .map((row) => row.id.toLowerCase()),
  );
  const snapshot: EdgePeopleSnapshot = {
    ...parsed.data,
    roleAssignments: parsed.data.roleAssignments.filter(
      (row) => !bannedUserIds.has(row.userId.toLowerCase()),
    ),
  };
  assertScope(claims, snapshot);
  try {
    await withTenant(
      args.database ?? db,
      edgeNodeContext(claims),
      async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`edge-people-snapshot:${claims.tenantId}:${claims.outletId}`}, 0))`,
        );
        // Pass 1: free keys.
        await freeUsers(tx, snapshot);
        await freeRoleAssignments(tx, claims, snapshot);
        const absentRoleIds = await freeRoles(tx, claims, snapshot);
        await freeEmployees(tx, claims, snapshot);
        await freeShifts(tx, claims, snapshot);
        await freePolicies(tx, claims, snapshot);
        await replaceQrKeys(tx, claims, snapshot, now);
        // Pass 2: upsert by id in FK order, then the sync state.
        await upsertPeople(tx, claims, snapshot);
        await dropUnusedRoles(tx, claims, absentRoleIds);
        const seal = snapshot.selfieSealKey;
        const state = {
          snapshotEtag: etag,
          snapshotGeneratedAt: generatedAt,
          appliedAt: now,
          lastCheckedAt: now,
          selfieSealKid: seal?.kid ?? null,
          selfieSealPublicKey: seal?.publicKeyPem ?? null,
        };
        await tx
          .insert(edgePeopleSyncState)
          .values({
            tenantId: claims.tenantId,
            outletId: claims.outletId,
            ...state,
          })
          .onConflictDoUpdate({
            target: [
              edgePeopleSyncState.tenantId,
              edgePeopleSyncState.outletId,
            ],
            set: state,
          });
      },
    );
  } catch (error) {
    if (error instanceof EdgePeopleSnapshotError) throw error;
    // A clash after pass 1 means the cloud sent two rows with one key.
    if (sqlState(error) === "23505")
      throw new EdgePeopleSnapshotError("LOCAL_CONFLICT");
    throw new EdgePeopleSnapshotError("LOCAL_WRITE");
  }
}

/** 304: the cloud confirmed the stored snapshot. Moves `last_checked_at` only. */
export async function markEdgePeopleSnapshotChecked(args: {
  claims: Claims;
  now?: Date;
  database?: Database;
}): Promise<void> {
  const { claims } = args;
  const now = args.now ?? new Date();
  try {
    await withTenant(args.database ?? db, edgeNodeContext(claims), (tx) =>
      tx
        .insert(edgePeopleSyncState)
        .values({
          tenantId: claims.tenantId,
          outletId: claims.outletId,
          lastCheckedAt: now,
        })
        .onConflictDoUpdate({
          target: [edgePeopleSyncState.tenantId, edgePeopleSyncState.outletId],
          set: { lastCheckedAt: now },
        }),
    );
  } catch {
    throw new EdgePeopleSnapshotError("LOCAL_WRITE");
  }
}

export async function loadEdgePeopleSyncState(args: {
  claims: Claims;
  database?: Database;
}): Promise<EdgePeopleSyncStateView | null> {
  const { claims } = args;
  return withTenant(
    args.database ?? db,
    edgeNodeContext(claims),
    async (tx) => {
      const [row] = await tx
        .select({
          snapshotEtag: edgePeopleSyncState.snapshotEtag,
          lastCheckedAt: edgePeopleSyncState.lastCheckedAt,
          appliedAt: edgePeopleSyncState.appliedAt,
        })
        .from(edgePeopleSyncState)
        .where(
          and(
            eq(edgePeopleSyncState.tenantId, claims.tenantId),
            eq(edgePeopleSyncState.outletId, claims.outletId),
          ),
        );
      return row ?? null;
    },
  );
}
