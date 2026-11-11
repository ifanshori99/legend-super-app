// Change an employee's direct manager (bead legend-f4uvg). PATCH
// /api/hris/employees/:employeeId/manager. The backfill script
// (db/backfill-employee-managers.ts) cannot resolve its "manual" list or undo
// a write; this is the audited path for both.
//
// - Who: HR (`hr.employee.manage` on the home outlet) or a General Manager
//   (`hr.attendance.manage` through a brand/tenant-scoped assignment that
//   covers the home outlet, Q41). Outlet-scoped supervisors and managers get
//   403. The employee must be visible to the actor first (404 otherwise), and
//   nobody changes their own manager (403).
// - Safety: one advisory lock per tenant serialises every manager change, then
//   the employee row is locked, so A->B and B->A can never both commit.
//   The new manager must be active in the same tenant, must not sit below the
//   employee (cycle), and a junior-only manager may not lead someone who holds
//   a non-junior role. Clearing the manager (null) is never blocked by role.
// - Audit: exactly one `hris.employee_manager_change` row with before/after.

import { and, eq, sql } from "drizzle-orm";
import type { ScopedTenantContext, TenantContext } from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import type { z } from "@starter/shared/core";
import {
  changeEmployeeManagerEndpoint,
  changeEmployeeManagerInputSchema,
  type ChangeEmployeeManagerInput,
  type Employee,
} from "@starter/shared/hris";
import { db } from "../db/index.ts";
import { employees } from "../db/schema/hris.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import {
  HRIS_AUDIT_SAFE_FIELDS,
  HRIS_MANAGE_CODE,
  forbidden,
  hrisAuditEntry,
  loadHrisAccess,
  notFound,
  type HrisAccess,
  type Tx,
} from "./hris-access.ts";
import { idempotentHrisWrite, toEmployee } from "./hris-employee.service.ts";
import {
  MAX_MANAGER_CHAIN_DEPTH,
  chainReaches,
  isJuniorOnly,
  loadRoleKeys,
} from "./hris-manager-rules.ts";

type EmployeeRow = typeof employees.$inferSelect;
type ChangeManagerBody = z.output<typeof changeEmployeeManagerEndpoint.body>;

export const MANAGER_CHANGE_ACTION = "hris.employee_manager_change";
const GM_MANAGE_CODE = "hr.attendance.manage" as const;
const AUDIT_FIELDS = [...HRIS_AUDIT_SAFE_FIELDS, "managerId"];

/** HR at the home outlet, or a brand/tenant-scoped holder of hr.attendance.manage covering it. */
function mayChangeManager(access: HrisAccess, homeOutletId: string): boolean {
  if (access.permissionsAt(homeOutletId).includes(HRIS_MANAGE_CODE))
    return true;
  const reach = access.brandOrWiderReach([GM_MANAGE_CODE]);
  if (reach === null) return false;
  if (reach.kind === "tenant") return true;
  return reach.outletIds.some(
    (id) => id.toLowerCase() === homeOutletId.toLowerCase(),
  );
}

/**
 * Whether this actor can change any employee's manager (hint for GET
 * /api/me/access; the PATCH decides per employee). Keep in step with
 * `mayChangeManager`: HR through any assignment, or a brand/tenant GM.
 */
export function mayChangeAnyEmployeeManager(access: HrisAccess): boolean {
  return (
    access.reach([HRIS_MANAGE_CODE]) !== null ||
    access.brandOrWiderReach([GM_MANAGE_CODE]) !== null
  );
}

/** Presentation hint for /me/access: false on any failure, never throws. */
export async function canChangeAnyEmployeeManager(
  tenant: TenantContext,
  actorUserId: string,
  now = new Date(),
): Promise<boolean> {
  try {
    const context = establishScopedTenantContext(tenant, { kind: "tenant" });
    return await withTenant(db, context, async (tx) =>
      mayChangeAnyEmployeeManager(
        await loadHrisAccess(tx, context, actorUserId, now),
      ),
    );
  } catch {
    return false;
  }
}

async function selectEmployee(
  tx: Tx,
  context: ScopedTenantContext,
  employeeId: string,
  lock: false | "update" | "share",
): Promise<EmployeeRow | undefined> {
  const query = tx
    .select()
    .from(employees)
    .where(
      and(
        eq(employees.tenantId, context.tenant.tenantId),
        eq(employees.id, employeeId),
      ),
    )
    .limit(1);
  const [row] = lock ? await query.for(lock) : await query;
  return row;
}

/**
 * Walks manager_id upward from `startId` (iterative, visited-set, depth cap)
 * and returns true when it reaches `employeeId`. A chain too deep to verify is
 * treated as a cycle (fail closed).
 */
async function managerChainReaches(
  tx: Tx,
  context: ScopedTenantContext,
  startId: string,
  employeeId: string,
): Promise<boolean> {
  const managerOf = new Map<string, string | null>();
  let current: string | null = startId;
  while (current !== null && !managerOf.has(current)) {
    if (managerOf.size > MAX_MANAGER_CHAIN_DEPTH) return true;
    const [row]: { managerId: string | null }[] = await tx
      .select({ managerId: employees.managerId })
      .from(employees)
      .where(
        and(
          eq(employees.tenantId, context.tenant.tenantId),
          eq(employees.id, current),
        ),
      )
      .limit(1);
    managerOf.set(current, row?.managerId ?? null);
    current = row?.managerId ?? null;
  }
  return chainReaches((id) => managerOf.get(id), startId, employeeId);
}

/**
 * PATCH /api/hris/employees/:employeeId/manager — sets (or clears with null)
 * the direct manager. Idempotent per `idempotencyKey`: a replay returns the
 * first result and writes no second audit row.
 */
export async function changeEmployeeManager(
  context: ScopedTenantContext,
  actorUserId: string,
  employeeId: string,
  body: ChangeManagerBody,
  now = new Date(),
): Promise<Employee> {
  const { idempotencyKey, ...rest } = body;
  const input: ChangeEmployeeManagerInput =
    changeEmployeeManagerInputSchema.parse(rest);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const visible = await selectEmployee(tx, context, employeeId, false);
    if (!visible || access.viewerFor(visible) === null) throw notFound();
    if (!mayChangeManager(access, visible.homeOutletId)) throw forbidden();
    // Nobody picks their own manager: that person would then see them as a
    // direct report and could decide their attendance corrections.
    if (access.own?.id.toLowerCase() === visible.id.toLowerCase())
      throw forbidden();
    return idempotentHrisWrite(
      tx,
      context,
      idempotencyKey,
      "hris.employee.manager",
      {
        actor: access.actorUserId,
        employeeId: visible.id,
        managerId: input.managerId,
        reason: input.reason ?? null,
      },
      async () => {
        // Serialise every manager change of the tenant, then lock the row.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`hris.employee_manager:${tenantId}`}))`,
        );
        const row = await selectEmployee(tx, context, employeeId, "update");
        if (!row) throw notFound();
        const newManagerId = input.managerId;
        if (newManagerId === row.id)
          throw new HttpError(
            422,
            "VALIDATION_ERROR",
            "Karyawan tidak bisa menjadi atasan dirinya sendiri.",
          );
        if ((row.managerId ?? null) === newManagerId)
          throw new HttpError(422, "VALIDATION_ERROR", "Atasan tidak berubah.");
        if (newManagerId !== null) {
          // FOR SHARE: a resignation of the new manager (offboarding) cannot
          // commit between this check and the write.
          const manager = await selectEmployee(
            tx,
            context,
            newManagerId,
            "share",
          );
          // The new manager must be someone the caller may see: otherwise the
          // answers (422/409/200) would reveal people outside the caller's
          // reach, and a brand-A GM could attach a brand-B employee.
          if (
            !manager ||
            manager.status !== "active" ||
            access.viewerFor(manager) === null
          )
            throw new HttpError(
              422,
              "MANAGER_NOT_ELIGIBLE",
              "Atasan harus karyawan aktif di perusahaan ini.",
            );
          if (await managerChainReaches(tx, context, manager.id, row.id))
            throw new HttpError(
              409,
              "MANAGER_CYCLE",
              "Atasan ini berada di bawah karyawan tersebut; hierarki tidak boleh melingkar.",
            );
          const roleKeys = await loadRoleKeys(
            tx,
            tenantId,
            [row.id, manager.id],
            now,
          );
          if (
            !isJuniorOnly(roleKeys.get(row.id) ?? []) &&
            isJuniorOnly(roleKeys.get(manager.id) ?? [])
          )
            throw new HttpError(
              422,
              "MANAGER_ROLE_TOO_LOW",
              "Jabatan atasan lebih rendah dari karyawan ini.",
            );
        }
        const [updated] = await tx
          .update(employees)
          .set({ managerId: newManagerId, updatedAt: now })
          .where(
            and(eq(employees.tenantId, tenantId), eq(employees.id, row.id)),
          )
          .returning();
        if (!updated) throw notFound();
        await recordAudit(
          tx,
          context,
          hrisAuditEntry(context, access.actorUserId, now, {
            outletId: row.homeOutletId,
            action: MANAGER_CHANGE_ACTION,
            objectType: "employee",
            objectId: row.id,
            before: { managerId: row.managerId ?? null },
            after: { managerId: newManagerId },
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
          }),
          AUDIT_FIELDS,
        );
        return toEmployee(updated);
      },
    );
  });
}
