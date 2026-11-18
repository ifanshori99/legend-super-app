// Set an employee's employer legal entity once (bead legend-d5n4j). PUT
// /api/hris/employees/:employeeId/legal-entity. The entity is chosen at
// employee create and had no update path, so an employee created without one
// kept approved cash kasbon / reimbursement stuck behind the legend-cv00j gate.
//
// - Who: HR (`hr.employee.manage` on the home outlet). The employee must be
//   visible to the actor (404 otherwise); the entity must belong to the caller's
//   tenant (404 for unknown and other-tenant ids alike, as createEmployee does).
// - Rule: only while `legal_entity_id IS NULL`. The same value again is a no-op
//   (200, no audit row); a different value is 409
//   EMPLOYEE_LEGAL_ENTITY_ALREADY_SET. The guarded UPDATE decides a race.
// - Audit: exactly one `hris.employee_legal_entity_set` row with before/after.

import { and, eq, isNull } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import type { z } from "@starter/shared/core";
import {
  setEmployeeLegalEntityEndpoint,
  type Employee,
} from "@starter/shared/hris";
import { db } from "../db/index.ts";
import { employees } from "../db/schema/hris.ts";
import { legalEntities } from "../db/schema/platform-org.ts";
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
  type Tx,
} from "./hris-access.ts";
import { idempotentHrisWrite, toEmployee } from "./hris-employee.service.ts";

type EmployeeRow = typeof employees.$inferSelect;
type SetLegalEntityBody = z.output<typeof setEmployeeLegalEntityEndpoint.body>;

export const LEGAL_ENTITY_SET_ACTION = "hris.employee_legal_entity_set";
const AUDIT_FIELDS = [...HRIS_AUDIT_SAFE_FIELDS, "legalEntityId"];

async function selectEmployee(
  tx: Tx,
  context: ScopedTenantContext,
  employeeId: string,
  lock: false | "update",
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
 * PUT /api/hris/employees/:employeeId/legal-entity. Idempotent per
 * `idempotencyKey`: a replay returns the first result and writes no second
 * audit row.
 */
export async function setEmployeeLegalEntity(
  context: ScopedTenantContext,
  actorUserId: string,
  employeeId: string,
  body: SetLegalEntityBody,
  now = new Date(),
): Promise<Employee> {
  const { idempotencyKey, legalEntityId } = body;
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const visible = await selectEmployee(tx, context, employeeId, false);
    if (!visible || access.viewerFor(visible) === null) throw notFound();
    if (!access.permissionsAt(visible.homeOutletId).includes(HRIS_MANAGE_CODE))
      throw forbidden();
    return idempotentHrisWrite(
      tx,
      context,
      idempotencyKey,
      "hris.employee.legal_entity",
      { actor: access.actorUserId, employeeId: visible.id, legalEntityId },
      async () => {
        // The entity must exist in this tenant; FOR SHARE keeps it from
        // vanishing before the write. Unknown and other-tenant look the same.
        const [entity] = await tx
          .select({ id: legalEntities.id })
          .from(legalEntities)
          .where(
            and(
              eq(legalEntities.tenantId, tenantId),
              eq(legalEntities.id, legalEntityId),
            ),
          )
          .limit(1)
          .for("share");
        if (!entity) throw notFound();
        const row = await selectEmployee(tx, context, employeeId, "update");
        if (!row) throw notFound();
        const alreadySet = () =>
          new HttpError(
            409,
            "EMPLOYEE_LEGAL_ENTITY_ALREADY_SET",
            "Badan usaha karyawan sudah ditetapkan dan tidak bisa diubah.",
          );
        if (row.legalEntityId === legalEntityId) return toEmployee(row);
        if (row.legalEntityId !== null) throw alreadySet();
        const lockedNow = new Date();
        const [updated] = await tx
          .update(employees)
          .set({ legalEntityId, updatedAt: lockedNow })
          .where(
            and(
              eq(employees.tenantId, tenantId),
              eq(employees.id, row.id),
              isNull(employees.legalEntityId),
            ),
          )
          .returning();
        if (!updated) throw alreadySet();
        await recordAudit(
          tx,
          context,
          hrisAuditEntry(context, access.actorUserId, lockedNow, {
            outletId: row.homeOutletId,
            action: LEGAL_ENTITY_SET_ACTION,
            objectType: "employee",
            objectId: row.id,
            before: { legalEntityId: null },
            after: { legalEntityId },
          }),
          AUDIT_FIELDS,
        );
        return toEmployee(updated);
      },
    );
  });
}
