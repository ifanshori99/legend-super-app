// Staff close of a dearer-swap charge (legend-i83ls S4): waive it (the guest is
// excused, a reason is mandatory) or expire it (the guest left without paying).
//
// - Permission `order.recovery.handle` on the charge's outlet, the same as
//   resolving the issue; the actor is the approver recorded on the row.
// - Only an `open` charge can be closed, once: the charge row lock (FOR UPDATE)
//   is the idempotency key, a repeat of the same action returns the row and
//   writes no second audit row, the other action or a paid/routed charge is a
//   409. A concurrent payment (handled under the same row lock) wins or loses
//   cleanly. The row is locked through `lockChargeChain` (issue, order, charge).
// - The pending payment link is cancelled, so the guest cannot pay a charge the
//   staff just closed.
// - No journal: revenue is recognised only when money arrives
//   (`order_issue.charge_paid`), so neither action posts anything.

import { and, eq } from "drizzle-orm";
import { AccessError } from "@starter/shared/access";
import {
  assertOutletInScope,
  CoreError,
  createUlid,
  toIsoDateTime,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { OrderIssueChargeStatus } from "@starter/shared/qr-order";
import { db } from "../db/index.ts";
import { orderIssueCharges } from "../db/schema/kds-issues.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import {
  assertNoPaidIntentOnChargeLink,
  confirmChargeLinksUnpaid,
  lockChargeChain,
} from "./order-recovery-charge.ts";
import { accessSnapshotInTransaction } from "./permission-resolver.ts";
import { cancelPaymentLinkInTx } from "./payment.service.ts";
import { notifyQrOrderChange } from "./qr-order-realtime-signal.ts";

const HANDLE = "order.recovery.handle";
const AUDIT_SAFE_FIELDS = [
  "id",
  "orderIssueId",
  "orderId",
  "status",
  "amountIdr",
  "closedBy",
];

type ChargeRow = typeof orderIssueCharges.$inferSelect;

export type IssueChargeCloseAction = "waive" | "expire";

const TARGET: Record<
  IssueChargeCloseAction,
  { status: "waived" | "expired"; audit: string }
> = {
  waive: { status: "waived", audit: "order_issue.charge_waived" },
  expire: { status: "expired", audit: "order_issue.charge_expired" },
};

/** The staff-facing view of a charge. */
export type IssueChargeView = {
  id: string;
  orderIssueId: string;
  orderId: string;
  tableSessionId: string | null;
  route: string;
  status: OrderIssueChargeStatus;
  differenceIdr: number;
  grossSalesIdr: number;
  serviceChargeIdr: number;
  pbjtIdr: number;
  amountIdr: number;
  paidAt: string | null;
  closedAt: string | null;
  closedBy: string | null;
  closeReason: string | null;
};

export function toView(row: ChargeRow): IssueChargeView {
  return {
    id: row.id,
    orderIssueId: row.orderIssueId,
    orderId: row.orderId,
    tableSessionId: row.tableSessionId,
    route: row.route,
    status: row.status as OrderIssueChargeStatus,
    differenceIdr: row.differenceIdr,
    grossSalesIdr: row.grossSalesIdr,
    serviceChargeIdr: row.serviceChargeIdr,
    pbjtIdr: row.pbjtIdr,
    amountIdr: row.amountIdr,
    paidAt: row.paidAt ? toIsoDateTime(row.paidAt) : null,
    closedAt: row.closedAt ? toIsoDateTime(row.closedAt) : null,
    closedBy: row.closedBy,
    closeReason: row.closeReason,
  };
}

/**
 * Closes an `open` charge as `waived` or `expired` on behalf of staff. `reason`
 * is stored on the row and in the audit trail.
 */
export async function closeIssueCharge(
  context: ScopedTenantContext,
  actorUserId: string,
  chargeId: string,
  action: IssueChargeCloseAction,
  input: { reason: string },
  now = new Date(),
): Promise<IssueChargeView> {
  const target = TARGET[action];
  const tenantId = context.tenant.tenantId;
  // legend-ukbq3: ask the provider first (outside the transaction). Money the
  // provider already holds is applied to the charge, never cancelled locally.
  const settled = await confirmChargeLinksUnpaid(context, { chargeId }, now);
  return withTenant(db, context, async (tx) => {
    const snapshot = await accessSnapshotInTransaction(
      tx,
      context,
      actorUserId,
      now,
    );
    // Issue, order, charge row (the module's lock sequence), then link and
    // intent below.
    const locked = await lockChargeChain(tx, tenantId, { chargeId });
    if (!locked)
      throw new CoreError("NOT_FOUND", "Tagihan selisih tidak ditemukan.");
    const { charge } = locked;
    assertOutletInScope(context.outletScope, charge.outletId);
    if (!snapshot.allows(HANDLE, { type: "outlet", id: charge.outletId }))
      throw new AccessError(
        "PERMISSION_DENIED",
        "Anda tidak dapat menangani tagihan selisih di outlet ini.",
      );

    if (charge.status === target.status) return toView(charge);
    if (charge.status !== "open")
      throw new HttpError(
        409,
        "CONFLICT",
        "Hanya tagihan selisih yang masih terbuka yang dapat ditutup.",
      );
    // The provider holds money for this charge but it is still open: wait for
    // the payment to be applied, do not close it. `settled` covers a payment
    // just applied by the call above; the guard covers a retry, where the
    // intent is already paid and the call above answers `unpaid`.
    if (settled)
      throw new HttpError(
        409,
        "CONFLICT",
        "QRIS sudah dibayar; tunggu konfirmasi.",
      );
    await assertNoPaidIntentOnChargeLink(tx, tenantId, charge.paymentLinkId);

    const [updated] = await tx
      .update(orderIssueCharges)
      .set({
        status: target.status,
        closedAt: now,
        closedBy: actorUserId,
        closeReason: input.reason,
        updatedAt: now,
      })
      .where(
        and(
          eq(orderIssueCharges.tenantId, tenantId),
          eq(orderIssueCharges.id, charge.id),
        ),
      )
      .returning();
    if (!updated) throw new Error("Charge close returned no row");

    // Link then intent follow the charge row lock (issue, order, charge, link,
    // intent). The gateway has no cancel: a guest who still pays the old code
    // is handled as a late payment by the charge consumer.
    if (charge.paymentLinkId !== null)
      await cancelPaymentLinkInTx(tx, context, {
        linkId: charge.paymentLinkId,
        now,
        reason: `issue_charge_${target.status}`,
      });

    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId,
        outletId: charge.outletId,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: target.audit,
        objectType: "order_issue_charge",
        objectId: charge.id,
        reason: input.reason,
        maskedChanges: {
          before: { id: charge.id, status: charge.status },
          after: {
            id: updated.id,
            orderIssueId: updated.orderIssueId,
            orderId: updated.orderId,
            status: updated.status,
            amountIdr: updated.amountIdr,
            closedBy: actorUserId,
          },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: toIsoDateTime(now),
      },
      AUDIT_SAFE_FIELDS,
    );

    // The guest's bill changed: wake the table's phones.
    if (charge.tableSessionId !== null)
      await notifyQrOrderChange(tx, context, {
        sessionId: charge.tableSessionId,
        orderId: charge.orderId,
        status: "sent",
      });
    return toView(updated);
  });
}
