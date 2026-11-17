// What a paid swap charge already gave back by hand (legend-mrwtp, brief 985):
// the sum of its `order_issue_charge_manual_refunds` by state. `reserved` is a
// request still waiting for the approver (it holds part of the charge), and
// `completed` is money already returned at the till or the EDC machine. A
// rejected request counts for neither. Read it under the charge row lock
// (`lockChargeChain`): the lock is what keeps requests, approvals, the intent
// refund and the void from passing the charge value together.

import { and, eq, sql } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import { orderIssueChargeManualRefunds } from "../db/schema/kds-issues.ts";
import type { Tx } from "./permission-resolver.ts";

export type ManualRefundedOfCharge = {
  reserved: number;
  completed: number;
};

export async function manualRefundedOfCharge(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  chargeId: string,
): Promise<ManualRefundedOfCharge> {
  const [row] = await tx
    .select({
      reserved: sql<string>`coalesce(sum(${orderIssueChargeManualRefunds.amountIdr}) filter (where ${orderIssueChargeManualRefunds.status} = 'requested'), 0)::text`,
      completed: sql<string>`coalesce(sum(${orderIssueChargeManualRefunds.amountIdr}) filter (where ${orderIssueChargeManualRefunds.status} = 'completed'), 0)::text`,
    })
    .from(orderIssueChargeManualRefunds)
    .where(
      and(
        eq(orderIssueChargeManualRefunds.tenantId, tenantId),
        eq(orderIssueChargeManualRefunds.chargeId, chargeId),
      ),
    );
  return {
    reserved: Number(row?.reserved ?? "0"),
    completed: Number(row?.completed ?? "0"),
  };
}
