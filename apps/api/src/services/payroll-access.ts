// Shared access checks for the payroll services (bead legend-gfcr). Routes
// already gate on `requireTenantPermission`; each service re-checks inside its
// transaction against the role assignments it can see (defence in depth, same
// as payroll-pph21-policy.service.ts).
//
// Payroll configuration, salaries, kasbon and reimbursement decisions are
// tenant-wide (payroll/endpoints.ts header): the right must be held on the
// tenant and the request must run in a tenant-wide scope. Employee self routes
// (/api/hris/me/...) resolve the caller's own employee row from the session,
// never from input (HR-01).
import type { PermissionCode } from "@starter/shared/access";
import {
  userIdSchema,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import { forbidden, loadHrisAccess, notFound } from "./hris-access.ts";
import {
  loadTenantAccessInTransaction,
  resolveAccessSnapshot,
  type Tx,
} from "./permission-resolver.ts";

export async function assertPayrollTenantCan(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  code: PermissionCode,
): Promise<UserId> {
  const actor = userIdSchema.parse(actorUserId);
  const data = await loadTenantAccessInTransaction(tx, context, actor);
  const snapshot = resolveAccessSnapshot({
    tenant: context.tenant,
    userId: actor,
    ...data,
    mfaVerified: false,
    now: new Date(),
  });
  if (
    context.outletScope.kind !== "tenant" ||
    !snapshot.allows(code, { type: "tenant" })
  )
    throw forbidden();
  return actor;
}

export type PayrollSelf = {
  readonly actor: UserId;
  readonly employeeId: string;
};

/** The caller's own employee row for a `self.*` route; 403/404 otherwise. */
export async function loadPayrollSelf(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  code: PermissionCode,
): Promise<PayrollSelf> {
  const access = await loadHrisAccess(tx, context, actorUserId);
  if (!access.snapshot.permissions.includes(code)) throw forbidden();
  if (!access.own) throw notFound();
  return { actor: access.actorUserId, employeeId: access.own.id };
}
