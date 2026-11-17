// legend-uyw0v (980): which order issues are manual refunds made by the
// approval route (`reportOrderIssue`), as opposed to the ORD-09 failed-item
// refunds (`order-recovery.service.ts`).
//
// Discriminator in existing data, no new column: the ORD-09 settlement always
// stores the approval it consumed in `approval_request_id` (it refuses a
// manual refund without one), while the report route spends a POS override
// and never sets it. So a live `manual_refund` issue with a NULL
// `approval_request_id` is a route refund. An ORD-09 manual issue sends the
// guest to the cashier (the POS refund), so it must not block that refund.
//
// "Live" = it gave money back or may: not cancelled, refund not rejected.

import type { TenantId } from "@starter/shared/core";
import { and, eq, isNull, ne, type SQL } from "drizzle-orm";
import { orderIssues } from "../db/schema/kds-issues.ts";

/** Condition for the live manual refunds made by the approval route. */
export function liveRouteManualRefundWhere(tenantId: TenantId): SQL {
  return and(
    eq(orderIssues.tenantId, tenantId),
    eq(orderIssues.resolution, "manual_refund"),
    isNull(orderIssues.approvalRequestId),
    ne(orderIssues.status, "cancelled"),
    isNull(orderIssues.refundRejectedAt),
  ) as SQL;
}
