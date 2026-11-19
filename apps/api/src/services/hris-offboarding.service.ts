// Offboarding and exit clearance (PRD v1.7 F24 "Offboarding": resign or
// termination with exit clearance, final entitlements and work certificate;
// bead legend-ovxw). Decisions: docs/DECISIONS.md "2026-11-10: WS-10
// lifecycle" §2.
//
// Lifecycle: open → revoked (exit clearance ran) → completed (checklist done,
// settlement frozen); open → cancelled. One live offboarding per employee.
//
// Exit clearance is a tenant-wide action (tenant-scoped `hr.employee.manage`)
// and runs in ONE tenant transaction, after the last working day: role
// assignments of this tenant end (sessions and PIN stop working on the next
// request), the user's staff sessions of this tenant are revoked, the
// user's push subscriptions of this tenant are removed, shifts after the last
// working day are cancelled, the employee leaves. The login account is shared
// across tenants, so it is never banned. Staff PIN rows are kept on purpose:
// `attemptStaffPin` refuses a non-member, and a deleted row would never reach
// an edge node. A second call returns the stored result and writes nothing.

import { and, asc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type {
  ScopedTenantContext,
  TenantId,
  UserId,
} from "@starter/shared/core";
import {
  checklistTemplateSchema,
  employeeIdSchema,
  isChecklistComplete,
  offboardingSchema,
  type CancelOffboardingInput,
  type CreateOffboardingInput,
  type FinalSettlementSummary,
  type Offboarding,
  type UpdateOffboardingInput,
} from "@starter/shared/hris";
import { db } from "../db/index.ts";
import { employees } from "../db/schema/hris.ts";
import {
  hrisChecklistTaskActions,
  hrisChecklistTasks,
  hrisChecklistTemplates,
  hrisOffboardings,
  type StoredChecklistTemplateItem,
} from "../db/schema/hris-lifecycle.ts";
import {
  shiftAssignments,
  shiftSwapRequests,
} from "../db/schema/hris-scheduling.ts";
import { pushSubscriptions } from "../db/schema/notification.ts";
import {
  employeeLoans,
  payrollLoanDeductions,
  payrollRuns,
} from "../db/schema/payroll.ts";
import { session } from "../db/schema/session.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  endUserRoleAssignmentsForOffboardingInTx,
  readDbClock,
} from "./access.service.ts";
import { recordAudit } from "./core-audit.ts";
import {
  HRIS_AUDIT_SAFE_FIELDS,
  SYSTEM_ACTOR_ID,
  hrisAuditEntry,
  holdsTenantRoleAssign,
  loadHrisAccess,
  type HrisAccess,
  type HrisActor,
  type Tx,
} from "./hris-access.ts";
import { cancelShiftAssignmentInTx } from "./hris-scheduling-roster.service.ts";
import { loadOutletTimeZone } from "./hris-scheduling-common.ts";
import { RESERVING_STATUSES } from "./payroll-run-loans.ts";
import { computeFinalSettlementInTx } from "./hris-settlement.service.ts";

type OffboardingRow = typeof hrisOffboardings.$inferSelect;
type EmployeeRow = typeof employees.$inferSelect;

export const HRIS_OFFBOARDING_OBJECT_TYPE = "hris_offboarding";

/** Employee states an exit can start from. */
const LEAVABLE_STATUSES = new Set(["onboarding", "active", "suspended"]);

/**
 * Tasks every offboarding checklist carries, added when the template has no
 * task of that category. Access revocation is system managed: only exit
 * clearance completes it.
 */
const REQUIRED_OFFBOARDING_TASKS: readonly (StoredChecklistTemplateItem & {
  systemManaged: boolean;
})[] = [
  {
    code: "access_revocation",
    title: "Cabut akses, sesi, dan perangkat",
    category: "access_revocation",
    requiresDocument: false,
    sortOrder: 900,
    systemManaged: true,
  },
  {
    code: "final_settlement",
    title: "Periksa ringkasan hak akhir",
    category: "final_settlement",
    requiresDocument: false,
    sortOrder: 910,
    systemManaged: false,
  },
  {
    code: "work_certificate",
    title: "Terbitkan surat keterangan kerja",
    category: "work_certificate",
    requiresDocument: false,
    sortOrder: 920,
    systemManaged: false,
  },
];

const notFound = () =>
  new HttpError(404, "NOT_FOUND", "Offboarding tidak ditemukan.");

export function toOffboarding(row: OffboardingRow): Offboarding {
  return offboardingSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    employeeId: row.employeeId,
    exitType: row.exitType,
    reason: row.reason,
    noticeDate: row.noticeDate ?? null,
    lastWorkingDate: row.lastWorkingDate,
    status: row.status,
    accessRevokedAt: row.accessRevokedAt?.toISOString() ?? null,
    accessRevokedBy: row.accessRevokedBy ?? null,
    revocationResult: row.revocationResult ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    completedBy: row.completedBy ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelReason: row.cancelReason ?? null,
    certificateNo: row.certificateNo ?? null,
    createdAt: row.createdAt.toISOString(),
  });
}

/** HR manager of the employee's home outlet, else 404 (never leak). */
function assertHr(access: HrisAccess, employee: EmployeeRow): void {
  const viewer = access.viewerFor(employee);
  if (viewer === null) throw notFound();
  if (viewer.kind !== "hr")
    throw new HttpError(
      403,
      "PERMISSION_DENIED",
      "Butuh izin kelola karyawan untuk offboarding.",
    );
}

async function loadEmployee(
  tx: Tx,
  tenantId: TenantId,
  employeeId: string,
  lock = false,
): Promise<EmployeeRow | null> {
  const query = tx
    .select()
    .from(employees)
    .where(and(eq(employees.tenantId, tenantId), eq(employees.id, employeeId)))
    .limit(1);
  // NO KEY UPDATE: shifts and other rows keep taking FK KEY SHARE locks on the
  // employee while it is held.
  const [row] = lock ? await query.for("no key update") : await query;
  return row ?? null;
}

async function loadOffboarding(
  tx: Tx,
  tenantId: TenantId,
  offboardingId: string,
  lock = false,
): Promise<OffboardingRow | null> {
  const query = tx
    .select()
    .from(hrisOffboardings)
    .where(
      and(
        eq(hrisOffboardings.tenantId, tenantId),
        eq(hrisOffboardings.id, offboardingId),
      ),
    )
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  return row ?? null;
}

/** Offboarding + employee, authorised for HR; cancelled rows stay readable. */
async function loadForHr(
  tx: Tx,
  context: ScopedTenantContext,
  access: HrisAccess,
  offboardingId: string,
  lock: boolean,
): Promise<{ offboarding: OffboardingRow; employee: EmployeeRow }> {
  const tenantId = context.tenant.tenantId;
  const offboarding = await loadOffboarding(tx, tenantId, offboardingId, lock);
  if (!offboarding) throw notFound();
  const employee = await loadEmployee(tx, tenantId, offboarding.employeeId);
  if (!employee) throw notFound();
  assertHr(access, employee);
  return { offboarding, employee };
}

async function audit(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string | HrisActor,
  now: Date,
  employee: EmployeeRow,
  offboarding: OffboardingRow,
  action: string,
  after: Record<string, unknown>,
): Promise<void> {
  await recordAudit(
    tx,
    context,
    hrisAuditEntry(context, actorUserId, now, {
      outletId: employee.homeOutletId,
      action,
      objectType: HRIS_OFFBOARDING_OBJECT_TYPE,
      objectId: offboarding.id,
      after: { status: offboarding.status, ...after },
    }),
    HRIS_AUDIT_SAFE_FIELDS,
  );
}

/** Outlet-local calendar date of the employee's home outlet. */
async function homeOutletToday(
  tx: Tx,
  tenantId: TenantId,
  employee: EmployeeRow,
  now: Date,
): Promise<string> {
  const timeZone =
    (await loadOutletTimeZone(tx, tenantId, employee.homeOutletId)) ??
    "Asia/Jakarta";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Template items for the employee's position (else the tenant default). */
async function offboardingTemplate(
  tx: Tx,
  tenantId: TenantId,
  positionId: string | null,
): Promise<{ id: string | null; items: StoredChecklistTemplateItem[] }> {
  const rows = await tx
    .select()
    .from(hrisChecklistTemplates)
    .where(
      and(
        eq(hrisChecklistTemplates.tenantId, tenantId),
        eq(hrisChecklistTemplates.kind, "offboarding"),
        eq(hrisChecklistTemplates.isActive, true),
      ),
    );
  const template =
    rows.find((row) => positionId !== null && row.positionId === positionId) ??
    rows.find((row) => row.positionId === null) ??
    null;
  if (!template) return { id: null, items: [] };
  // Stored items were validated on write; re-validate so a bad row fails loud.
  const parsed = checklistTemplateSchema.parse({
    id: template.id,
    tenantId: template.tenantId,
    kind: template.kind,
    positionId: template.positionId,
    title: template.title,
    items: template.items,
    version: template.version,
    isActive: template.isActive,
  });
  return { id: template.id, items: parsed.items };
}

// ------------------------------------------------------------------ create

/** POST /api/hris/employees/:employeeId/offboarding → 201. */
export async function createOffboarding(
  context: ScopedTenantContext,
  actorUserId: string,
  employeeId: string,
  input: CreateOffboardingInput,
  now = new Date(),
): Promise<Offboarding> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const tenantId = context.tenant.tenantId;
    const employee = await loadEmployee(tx, tenantId, employeeId, true);
    if (!employee) throw notFound();
    assertHr(access, employee);
    if (!LEAVABLE_STATUSES.has(employee.status))
      throw new HttpError(
        409,
        "EMPLOYEE_ALREADY_LEFT",
        "Karyawan ini sudah keluar.",
      );
    if (input.lastWorkingDate < employee.joinDate)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Hari kerja terakhir tidak boleh sebelum tanggal masuk.",
      );
    if (input.noticeDate && input.noticeDate > input.lastWorkingDate)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Tanggal pemberitahuan tidak boleh setelah hari kerja terakhir.",
      );
    const [live] = await tx
      .select({ id: hrisOffboardings.id })
      .from(hrisOffboardings)
      .where(
        and(
          eq(hrisOffboardings.tenantId, tenantId),
          eq(hrisOffboardings.employeeId, employee.id),
          ne(hrisOffboardings.status, "cancelled"),
        ),
      )
      .limit(1);
    if (live)
      throw new HttpError(
        409,
        "OFFBOARDING_EXISTS",
        "Karyawan ini sudah punya proses offboarding.",
      );

    const [row] = await tx
      .insert(hrisOffboardings)
      .values({
        tenantId,
        employeeId: employee.id,
        exitType: input.exitType,
        reason: input.reason,
        noticeDate: input.noticeDate ?? null,
        lastWorkingDate: input.lastWorkingDate,
        createdBy: access.actorUserId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const template = await offboardingTemplate(
      tx,
      tenantId,
      employee.positionId ?? null,
    );
    const categories = new Set(template.items.map((item) => item.category));
    const codes = new Set(template.items.map((item) => item.code));
    const tasks = [
      ...template.items.map((item) => ({
        ...item,
        systemManaged: item.category === "access_revocation",
        fromTemplate: true,
      })),
      ...REQUIRED_OFFBOARDING_TASKS.filter(
        (item) => !categories.has(item.category) && !codes.has(item.code),
      ).map((item) => ({ ...item, fromTemplate: false })),
    ];
    await tx.insert(hrisChecklistTasks).values(
      tasks.map((item) => ({
        tenantId,
        employeeId: employee.id,
        offboardingId: row.id,
        templateId: item.fromTemplate ? template.id : null,
        kind: "offboarding" as const,
        code: item.code,
        title: item.title,
        category: item.category,
        requiresDocument: item.requiresDocument,
        sortOrder: item.sortOrder,
        systemManaged: item.systemManaged,
        createdAt: now,
        updatedAt: now,
      })),
    );
    await audit(
      tx,
      context,
      access.actorUserId,
      now,
      employee,
      row,
      "hris.offboarding.created",
      { fields: ["exitType", "lastWorkingDate"] },
    );
    return toOffboarding(row);
  });
}

// ------------------------------------------------------------- read / edit

/** GET /api/hris/offboardings/:offboardingId (HR or payroll viewer). */
export async function getOffboarding(
  context: ScopedTenantContext,
  actorUserId: string,
  offboardingId: string,
  now = new Date(),
): Promise<Offboarding> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const tenantId = context.tenant.tenantId;
    const offboarding = await loadOffboarding(tx, tenantId, offboardingId);
    if (!offboarding) throw notFound();
    const employee = await loadEmployee(tx, tenantId, offboarding.employeeId);
    const viewer = employee ? access.viewerFor(employee) : null;
    if (viewer === null || (viewer.kind !== "hr" && viewer.kind !== "payroll"))
      throw notFound();
    return toOffboarding(offboarding);
  });
}

function assertOpen(offboarding: OffboardingRow): void {
  if (offboarding.status !== "open")
    throw new HttpError(
      409,
      "OFFBOARDING_NOT_OPEN",
      "Offboarding ini tidak bisa diubah lagi.",
    );
}

/** PATCH /api/hris/offboardings/:offboardingId (open only). */
export async function updateOffboarding(
  context: ScopedTenantContext,
  actorUserId: string,
  offboardingId: string,
  input: UpdateOffboardingInput,
  now = new Date(),
): Promise<Offboarding> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const { offboarding, employee } = await loadForHr(
      tx,
      context,
      access,
      offboardingId,
      true,
    );
    assertOpen(offboarding);
    const lastWorkingDate =
      input.lastWorkingDate ?? offboarding.lastWorkingDate;
    const noticeDate =
      input.noticeDate === undefined
        ? offboarding.noticeDate
        : input.noticeDate;
    if (lastWorkingDate < employee.joinDate)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Hari kerja terakhir tidak boleh sebelum tanggal masuk.",
      );
    if (noticeDate && noticeDate > lastWorkingDate)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Tanggal pemberitahuan tidak boleh setelah hari kerja terakhir.",
      );
    const [row] = await tx
      .update(hrisOffboardings)
      .set({
        exitType: input.exitType ?? offboarding.exitType,
        reason: input.reason ?? offboarding.reason,
        noticeDate: noticeDate ?? null,
        lastWorkingDate,
        updatedAt: now,
      })
      .where(
        and(
          eq(hrisOffboardings.tenantId, offboarding.tenantId),
          eq(hrisOffboardings.id, offboarding.id),
        ),
      )
      .returning();
    await audit(
      tx,
      context,
      access.actorUserId,
      now,
      employee,
      row,
      "hris.offboarding.updated",
      {
        changedFields: Object.keys(input).filter(
          (key) => input[key as keyof UpdateOffboardingInput] !== undefined,
        ),
      },
    );
    return toOffboarding(row);
  });
}

/** Writes a task transition plus its action row (system or actor). */
async function settleTasks(
  tx: Tx,
  tenantId: TenantId,
  offboardingId: string,
  filter: { categories?: string[]; statuses: ("open" | "blocked")[] },
  to: "done" | "waived",
  actorUserId: string,
  reason: string | null,
  now: Date,
): Promise<number> {
  const rows = await tx
    .select()
    .from(hrisChecklistTasks)
    .where(
      and(
        eq(hrisChecklistTasks.tenantId, tenantId),
        eq(hrisChecklistTasks.offboardingId, offboardingId),
        inArray(hrisChecklistTasks.status, filter.statuses),
        filter.categories
          ? inArray(hrisChecklistTasks.category, filter.categories)
          : undefined,
      ),
    )
    .orderBy(asc(hrisChecklistTasks.sortOrder), asc(hrisChecklistTasks.id))
    .for("update");
  for (const task of rows) {
    await tx
      .update(hrisChecklistTasks)
      .set(
        to === "done"
          ? {
              status: "done",
              doneBy: actorUserId as UserId,
              doneAt: now,
              updatedAt: now,
            }
          : { status: "waived", waiveReason: reason, updatedAt: now },
      )
      .where(
        and(
          eq(hrisChecklistTasks.tenantId, tenantId),
          eq(hrisChecklistTasks.id, task.id),
        ),
      );
    await tx.insert(hrisChecklistTaskActions).values({
      tenantId,
      taskId: task.id,
      action: to === "done" ? "complete" : "waive",
      fromStatus: task.status,
      toStatus: to,
      reason,
      actorUserId: actorUserId as UserId,
      createdAt: now,
    });
  }
  return rows.length;
}

/** POST /api/hris/offboardings/:offboardingId/cancel (open only). */
export async function cancelOffboarding(
  context: ScopedTenantContext,
  actorUserId: string,
  offboardingId: string,
  input: CancelOffboardingInput,
  now = new Date(),
): Promise<Offboarding> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const { offboarding, employee } = await loadForHr(
      tx,
      context,
      access,
      offboardingId,
      true,
    );
    if (offboarding.status === "cancelled") return toOffboarding(offboarding);
    assertOpen(offboarding);
    await settleTasks(
      tx,
      offboarding.tenantId,
      offboarding.id,
      { statuses: ["open", "blocked"] },
      "waived",
      access.actorUserId,
      `Offboarding dibatalkan: ${input.reason}`.slice(0, 500),
      now,
    );
    const [row] = await tx
      .update(hrisOffboardings)
      .set({
        status: "cancelled",
        cancelledAt: now,
        cancelledBy: access.actorUserId,
        cancelReason: input.reason,
        updatedAt: now,
      })
      .where(
        and(
          eq(hrisOffboardings.tenantId, offboarding.tenantId),
          eq(hrisOffboardings.id, offboarding.id),
        ),
      )
      .returning();
    await audit(
      tx,
      context,
      access.actorUserId,
      now,
      employee,
      row,
      "hris.offboarding.cancelled",
      { changedFields: ["status", "cancelReason"] },
    );
    return toOffboarding(row);
  });
}

// ----------------------------------------------------------- exit clearance

/**
 * POST /api/hris/offboardings/:offboardingId/revoke-access. Order and
 * reasons: docs/DECISIONS.md "WS-10 lifecycle" §2. Idempotent: an
 * offboarding already revoked (or completed) answers as stored.
 *
 * Tenant-wide: `context` must be tenant scoped (HR pusat), else 403 once the
 * record is known to be in reach. A leaver with a tenant-scoped role
 * assignment also needs `access.role.assign` tenant-wide. That is decided
 * inside the transaction, after the tenant lock, from the DB clock
 * (legend-ig3dg); the request-time answer only caps it: `canAssignRoles` is
 * the route's earlier check and `sessionMfaVerified` is the session's second
 * factor used for the fresh check.
 */
export async function revokeOffboardingAccess(
  context: ScopedTenantContext,
  actorUserId: string,
  offboardingId: string,
  canAssignRoles: boolean,
  sessionMfaVerified: boolean,
): Promise<Offboarding> {
  return revokeOffboardingAccessAs(
    context,
    { type: "user", id: actorUserId },
    offboardingId,
    { canAssignRoles, sessionMfaVerified },
  );
}

/**
 * The scheduled exit-clearance job (`hris-offboarding-jobs.ts`; legend-arj.6).
 * Same steps and the same EXIT_NOT_DUE guard as the HR click, but no HR
 * permission check and `canAssignRoles = false`: a leaver who is Owner or
 * holds a tenant-scoped role rolls back with OFFBOARDING_OWNER /
 * OFFBOARDING_ADMIN_ROLE and stays open for a human (docs/DECISIONS.md
 * "WS-10 lifecycle" §2). Audit rows, events and "who" columns record the
 * system actor.
 */
export async function revokeOffboardingAccessAsSystem(
  context: ScopedTenantContext,
  offboardingId: string,
): Promise<Offboarding> {
  return revokeOffboardingAccessAs(context, { type: "system" }, offboardingId, {
    canAssignRoles: false,
    sessionMfaVerified: false,
  });
}

type RoleAssignAuthority = {
  /** The route's request-time answer: an upper bound, never widened. */
  canAssignRoles: boolean;
  sessionMfaVerified: boolean;
};

async function revokeOffboardingAccessAs(
  context: ScopedTenantContext,
  actor: HrisActor,
  offboardingId: string,
  authority: RoleAssignAuthority,
): Promise<Offboarding> {
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    // 1. Same tenant lock as every role-assignment end, before any row lock.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${"legend:role-assignment-end:" + tenantId}, 0))`,
    );
    // legend-qr1uv: "now" is read AFTER the lock, for the access check and
    // every write below. legend-e3qgo: it is the DB clock, not the app clock.
    const now = await readDbClock(tx);
    // 2. The offboarding row; a revoked one returns without writing. A user
    // is authorised as HR of the employee; the system job has no HR access.
    let offboarding: OffboardingRow;
    let who: HrisActor;
    if (actor.type === "user") {
      const access = await loadHrisAccess(tx, context, actor.id, now);
      ({ offboarding } = await loadForHr(
        tx,
        context,
        access,
        offboardingId,
        true,
      ));
      who = { type: "user", id: access.actorUserId };
    } else {
      const found = await loadOffboarding(tx, tenantId, offboardingId, true);
      if (!found) throw notFound();
      offboarding = found;
      who = actor;
    }
    // Recorded in uuid/text "who" columns: the nil UUID for the system.
    const whoId = who.type === "user" ? who.id : SYSTEM_ACTOR_ID;
    if (context.outletScope.kind !== "tenant")
      throw new HttpError(
        403,
        "CLEARANCE_NEEDS_TENANT_HR",
        "Pencabutan akses hanya bisa dilakukan HR pusat.",
      );
    if (offboarding.accessRevokedAt !== null) return toOffboarding(offboarding);
    if (offboarding.status !== "open")
      throw new HttpError(
        409,
        "OFFBOARDING_NOT_OPEN",
        "Offboarding ini sudah dibatalkan.",
      );
    // 3. The employee row.
    const employee = await loadEmployee(
      tx,
      tenantId,
      offboarding.employeeId,
      true,
    );
    if (!employee) throw notFound();
    // Only AFTER the last working day: on that day the employee still works.
    const today = await homeOutletToday(tx, tenantId, employee, now);
    if (today <= offboarding.lastWorkingDate)
      throw new HttpError(
        409,
        "EXIT_NOT_DUE",
        `Akses baru bisa dicabut setelah hari kerja terakhir (${offboarding.lastWorkingDate}).`,
      );

    let roleAssignmentIds: string[] = [];
    let sessionsRevoked = 0;
    let pushSubscriptionsRemoved = 0;
    if (employee.userId) {
      // 4. Role assignments of this tenant (Owner refused; tenant-scoped
      // roles need access.role.assign; future ones become empty windows).
      // legend-ig3dg: the permission is re-read here, after the lock, with
      // the DB clock; a grant ended while this request waited is refused.
      // The system job never gets it.
      const canAssignRoles =
        actor.type === "user" &&
        authority.canAssignRoles &&
        (await holdsTenantRoleAssign(
          tx,
          context,
          actor.id,
          authority.sessionMfaVerified,
          now,
        ));
      const ended = await endUserRoleAssignmentsForOffboardingInTx(
        tx,
        context,
        employee.userId,
        who,
        "offboarding",
        canAssignRoles,
        now,
      );
      roleAssignmentIds = ended.endedAssignmentIds;
      // 5. Staff sessions of this tenant, never customer or impersonation.
      // `session.tenant_id` is not filled at login yet
      // (middleware/identity-surface.ts), so a NULL-tenant staff session may
      // be serving this tenant and is revoked too. Consequence: the user signs
      // in again for any other tenant they work for.
      const revoked = await tx
        .update(session)
        .set({
          revokedAt: now,
          expiresAt: sql`${session.createdAt} + interval '1 millisecond'`,
        })
        .where(
          and(
            eq(session.userId, employee.userId),
            or(eq(session.tenantId, tenantId), isNull(session.tenantId)),
            ne(session.kind, "customer"),
            isNull(session.impersonatedBy),
            isNull(session.revokedAt),
          ),
        )
        .returning({ id: session.id });
      sessionsRevoked = revoked.length;
      // 6. The phone stops receiving this tenant's notifications.
      const removed = await tx
        .delete(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.tenantId, tenantId),
            sql`${pushSubscriptions.userId}::text = ${employee.userId}`,
          ),
        )
        .returning({ id: pushSubscriptions.id });
      pushSubscriptionsRemoved = removed.length;
    }

    // 7. Shifts after the last working day, in every outlet (tenant context).
    const shifts = await tx
      .select({ id: shiftAssignments.id })
      .from(shiftAssignments)
      .where(
        and(
          eq(shiftAssignments.tenantId, tenantId),
          eq(shiftAssignments.employeeId, employee.id),
          gt(shiftAssignments.businessDate, offboarding.lastWorkingDate),
          ne(shiftAssignments.status, "cancelled"),
        ),
      )
      .orderBy(asc(shiftAssignments.businessDate), asc(shiftAssignments.id));
    const cancelledShiftIds: string[] = [];
    if (shifts.length > 0) {
      const shiftIds = shifts.map((shift) => shift.id);
      // Lock order is swap -> assignment, as in cancelShiftAssignmentInTx and
      // decideShiftSwapRequest, so a concurrent swap decision cannot deadlock.
      await tx
        .select({ id: shiftSwapRequests.id })
        .from(shiftSwapRequests)
        .where(
          and(
            eq(shiftSwapRequests.tenantId, tenantId),
            eq(shiftSwapRequests.status, "pending"),
            or(
              inArray(shiftSwapRequests.fromAssignmentId, shiftIds),
              inArray(shiftSwapRequests.toAssignmentId, shiftIds),
            ),
          ),
        )
        .orderBy(asc(shiftSwapRequests.id))
        .for("update");
      const locked = await tx
        .select({
          id: shiftAssignments.id,
          employeeId: shiftAssignments.employeeId,
          status: shiftAssignments.status,
        })
        .from(shiftAssignments)
        .where(
          and(
            eq(shiftAssignments.tenantId, tenantId),
            inArray(shiftAssignments.id, shiftIds),
          ),
        )
        .orderBy(asc(shiftAssignments.id))
        .for("update");
      const lockedById = new Map(locked.map((row) => [row.id, row]));
      for (const shift of shifts) {
        // Re-checked under the lock: a shift swapped to someone else (or
        // cancelled) since the read above is not the leaver's to cancel.
        const current = lockedById.get(shift.id);
        if (
          !current ||
          current.employeeId !== employee.id ||
          current.status === "cancelled"
        )
          continue;
        await cancelShiftAssignmentInTx(tx, context, who, shift.id, now);
        cancelledShiftIds.push(shift.id);
      }
    }

    // 8. The employee leaves.
    const employeeStatus =
      offboarding.exitType === "termination" ? "terminated" : "resigned";
    await tx
      .update(employees)
      .set({
        status: employeeStatus,
        endDate: offboarding.lastWorkingDate,
        updatedAt: now,
      })
      .where(
        and(eq(employees.tenantId, tenantId), eq(employees.id, employee.id)),
      );
    await settleTasks(
      tx,
      tenantId,
      offboarding.id,
      { categories: ["access_revocation"], statuses: ["open", "blocked"] },
      "done",
      whoId,
      null,
      now,
    );

    const revocationResult = {
      roleAssignmentIds,
      sessionsRevoked,
      pushSubscriptionsRemoved,
      cancelledShiftIds,
      employeeStatus,
    };
    const [row] = await tx
      .update(hrisOffboardings)
      .set({
        status: "revoked",
        accessRevokedAt: now,
        accessRevokedBy: whoId as UserId,
        revocationResult,
        updatedAt: now,
      })
      .where(
        and(
          eq(hrisOffboardings.tenantId, tenantId),
          eq(hrisOffboardings.id, offboarding.id),
        ),
      )
      .returning();
    await audit(
      tx,
      context,
      who,
      now,
      employee,
      row,
      "hris.offboarding.access_revoked",
      { changedFields: ["status", "accessRevokedAt", "revocationResult"] },
    );
    return toOffboarding(row);
  });
}

// ---------------------------------------------------------------- complete

/**
 * Refuses completion while a live payroll run (draft, simulated, hr_approved
 * or approved) still holds a kasbon deduction row of the employee: the frozen
 * snapshot would otherwise store a balance that the lock step lowers later.
 * The employee's loans are locked FOR UPDATE (id order, like the run
 * simulation) before the check, so a simulation running at the same time
 * either commits its rows first (refused here) or waits for this transaction.
 */
async function assertNoPendingPayrollDeduction(
  tx: Tx,
  tenantId: TenantId,
  employeeId: string,
): Promise<void> {
  await tx
    .select({ id: employeeLoans.id })
    .from(employeeLoans)
    .where(
      and(
        eq(employeeLoans.tenantId, tenantId),
        eq(employeeLoans.employeeId, employeeId),
      ),
    )
    .orderBy(asc(employeeLoans.id))
    .for("update");
  const [pending] = await tx
    .select({ loanId: payrollLoanDeductions.loanId })
    .from(payrollLoanDeductions)
    .innerJoin(
      payrollRuns,
      and(
        eq(payrollRuns.tenantId, payrollLoanDeductions.tenantId),
        eq(payrollRuns.id, payrollLoanDeductions.payrollRunId),
      ),
    )
    .where(
      and(
        eq(payrollLoanDeductions.tenantId, tenantId),
        eq(
          payrollLoanDeductions.employeeId,
          employeeIdSchema.parse(employeeId),
        ),
        inArray(payrollRuns.status, [...RESERVING_STATUSES]),
      ),
    )
    .limit(1);
  if (pending)
    throw new HttpError(
      409,
      "PAYROLL_DEDUCTION_PENDING",
      "Karyawan masih punya potongan kasbon di run payroll yang belum dikunci. Kunci run payroll itu dulu, lalu selesaikan offboarding.",
    );
}

/**
 * POST /api/hris/offboardings/:offboardingId/complete. Needs exit clearance
 * done and every checklist task done or waived; freezes the settlement
 * summary. A completed offboarding answers as stored.
 */
export async function completeOffboarding(
  context: ScopedTenantContext,
  actorUserId: string,
  offboardingId: string,
  now = new Date(),
): Promise<Offboarding> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const { offboarding, employee } = await loadForHr(
      tx,
      context,
      access,
      offboardingId,
      true,
    );
    if (offboarding.status === "completed") return toOffboarding(offboarding);
    if (offboarding.status !== "revoked")
      throw new HttpError(
        409,
        "CLEARANCE_PENDING",
        "Cabut akses karyawan dulu sebelum menyelesaikan offboarding.",
      );
    const tasks = await tx
      .select({ status: hrisChecklistTasks.status })
      .from(hrisChecklistTasks)
      .where(
        and(
          eq(hrisChecklistTasks.tenantId, offboarding.tenantId),
          eq(hrisChecklistTasks.offboardingId, offboarding.id),
        ),
      );
    if (!isChecklistComplete(tasks))
      throw new HttpError(
        409,
        "CHECKLIST_INCOMPLETE",
        "Masih ada tugas offboarding yang belum selesai.",
      );
    await assertNoPendingPayrollDeduction(
      tx,
      context.tenant.tenantId,
      employee.id,
    );
    const settlement: FinalSettlementSummary = await computeFinalSettlementInTx(
      tx,
      context,
      offboarding,
      employee,
      now,
    );
    const [row] = await tx
      .update(hrisOffboardings)
      .set({
        status: "completed",
        completedAt: now,
        completedBy: access.actorUserId,
        settlementSnapshot: { ...settlement, frozen: true },
        updatedAt: now,
      })
      .where(
        and(
          eq(hrisOffboardings.tenantId, offboarding.tenantId),
          eq(hrisOffboardings.id, offboarding.id),
        ),
      )
      .returning();
    await audit(
      tx,
      context,
      access.actorUserId,
      now,
      employee,
      row,
      "hris.offboarding.completed",
      {},
    );
    return toOffboarding(row);
  });
}
