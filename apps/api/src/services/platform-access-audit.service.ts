/**
 * Audit for platform (Super Admin panel) requests refused because the session
 * is an impersonation. Such a request never reaches a platform handler: the
 * support session guard inside requireAuth or requirePlatformAdmin refuses it
 * first, so the refusal is recorded here instead of in each service.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import {
  roleAssignments,
  supportAccessGrants,
  tenants,
} from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { withoutSupportGrantLock } from "../lib/request-context.ts";
import { recordAudit } from "./audit-writer.ts";
import { platformTenantContext } from "./platform-support.service.ts";

export const PLATFORM_ACCESS_DENIED_ACTION = "platform.access.denied";

export type ImpersonatedPlatformDenial = {
  readonly tenantId: string;
  /** The impersonated account the session acts as. */
  readonly impersonatedUserId: string;
  /** The real person behind the impersonated session; the audit actor. */
  readonly impersonatedBy: string;
  /** Error code of the refusal (SUPPORT_ACCESS_REQUIRED, FORBIDDEN, ...). */
  readonly code: string;
  readonly method: string;
  /** Normalised request path, already capped by the caller. */
  readonly route: string;
};

/**
 * Writes one platform.access.denied row for the tenant in its own
 * transaction. Writes nothing and returns false when the tenant does not
 * exist or has no tie to either person (the impersonated user never held a
 * role there and the impersonator never had a support grant for it), so a
 * caller cannot put rows into the log of an unrelated tenant by naming it in
 * the path.
 */
export async function recordImpersonatedPlatformDenial(
  denial: ImpersonatedPlatformDenial,
): Promise<boolean> {
  const [row] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, denial.tenantId))
    .limit(1);
  if (!row) return false;
  const context = platformTenantContext(denial.tenantId);
  return withoutSupportGrantLock(() =>
    withTenant(db, context, async (tx) => {
      const [member] = await tx
        .select({ id: roleAssignments.id })
        .from(roleAssignments)
        .where(
          and(
            eq(roleAssignments.tenantId, denial.tenantId),
            inArray(roleAssignments.userId, [
              denial.impersonatedUserId,
              denial.impersonatedBy,
            ]),
          ),
        )
        .limit(1);
      const [tie] = member
        ? [member]
        : await tx
            .select({ id: supportAccessGrants.id })
            .from(supportAccessGrants)
            .where(
              and(
                eq(supportAccessGrants.tenantId, denial.tenantId),
                eq(supportAccessGrants.superAdminUserId, denial.impersonatedBy),
              ),
            )
            .limit(1);
      if (!tie) return false;
      await recordAudit(
        {
          tenantId: denial.tenantId,
          outletId: null,
          actorType: "user",
          actorId: denial.impersonatedBy,
          deviceId: null,
          action: PLATFORM_ACCESS_DENIED_ACTION,
          objectType: "platform_route",
          objectId: null,
          reason: null,
          before: null,
          after: {
            cause: "impersonated_session",
            code: denial.code,
            impersonatedBy: denial.impersonatedBy,
            impersonatedUserId: denial.impersonatedUserId,
            method: denial.method,
            route: denial.route,
          },
          sensitiveAccess: false,
        },
        { tx, context },
      );
      return true;
    }),
  );
}
