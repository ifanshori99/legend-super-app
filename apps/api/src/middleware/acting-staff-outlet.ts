// Outlet resolvers for refuseActingStaffOtherOutlet (middleware/acting-staff.ts)
// on the order-recovery routes (bead legend-cq0u7, 1120). Each one reads the
// outlet of the target on the SERVER (charge, order item or order issue named
// by the path), never from the body. They run before the permission guard, so
// they use the plain tenant context. A target that is not found resolves to
// null, which the helper refuses.

import { and, eq } from "drizzle-orm";
import type { Request } from "express";
import { uuidSchema, z } from "@starter/shared/core";
import { reportOrderIssue, resolveOrderIssue } from "@starter/shared/qr-order";
import { memberTenantContext } from "../db/member-scope.ts";
import { db } from "../db/index.ts";
import { orderIssueCharges, orderIssues } from "../db/schema/kds-issues.ts";
import { orderItems } from "../db/schema/qr-order.ts";
import { withTenant } from "../db/tenant.ts";
import { getTenantContext } from "./tenant.ts";

const chargeParams = z.strictObject({ chargeId: uuidSchema });

/** Outlet of the dearer-swap charge named by the `:chargeId` param. */
export async function chargeOutletOf(req: Request): Promise<string | null> {
  const { chargeId } = chargeParams.parse(req.params);
  const tenantId = getTenantContext(req).tenantId;
  return withTenant(db, memberTenantContext(tenantId), async (tx) => {
    const [row] = await tx
      .select({ outletId: orderIssueCharges.outletId })
      .from(orderIssueCharges)
      .where(
        and(
          eq(orderIssueCharges.tenantId, tenantId),
          eq(orderIssueCharges.id, chargeId),
        ),
      )
      .limit(1);
    return row?.outletId ?? null;
  });
}

/** Outlet of the order item named by the `:orderItemId` param. */
export async function itemOutletOf(req: Request): Promise<string | null> {
  const { orderItemId } = reportOrderIssue.params.parse(req.params);
  const tenantId = getTenantContext(req).tenantId;
  return withTenant(db, memberTenantContext(tenantId), async (tx) => {
    const [row] = await tx
      .select({ outletId: orderItems.outletId })
      .from(orderItems)
      .where(
        and(eq(orderItems.tenantId, tenantId), eq(orderItems.id, orderItemId)),
      )
      .limit(1);
    return row?.outletId ?? null;
  });
}

/** Outlet of the order issue named by the `:orderIssueId` param. */
export async function issueOutletOfParam(req: Request): Promise<string | null> {
  const { orderIssueId } = resolveOrderIssue.params.parse(req.params);
  const tenantId = getTenantContext(req).tenantId;
  return withTenant(db, memberTenantContext(tenantId), async (tx) => {
    const [row] = await tx
      .select({ outletId: orderIssues.outletId })
      .from(orderIssues)
      .where(
        and(
          eq(orderIssues.tenantId, tenantId),
          eq(orderIssues.id, orderIssueId),
        ),
      )
      .limit(1);
    return row?.outletId ?? null;
  });
}
