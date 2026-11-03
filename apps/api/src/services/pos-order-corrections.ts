// POS-04 corrections of a completed sale (bead legend-kk7; PRD v1.7 §3 F8
// "Diskon, Void & Refund", POS-02, POS-04, POS-06; contract
// voidPosOrderCorrection / refundPosOrder, posVoidSchema, posRefundSchema).
//
// "Transaksi final tidak dapat dihapus; koreksi dilakukan melalui void atau
// refund yang tertaut": the completed order and its lines are never touched
// (POS-04 triggers). A correction is a new append-only row linked to the
// order — `pos_order_voids` (once per sale, keeps the receipt number, POS-06)
// or `pos_order_refunds` (up to what is still refundable, split back over the
// original tender methods by `refundAllocation`). Both need a verified
// supervisor approval (requester != approver, AUTH-06), are audited and emit
// the contract event (`order.voided` with voidedFinalOrder, `order.refunded`)
// on the transactional outbox. Decisions (PRD silent): a sale with a refund
// is not voided afterwards and a voided sale is not refunded (one correction
// path per sale keeps the day's totals unambiguous, POS-05).

import { and, eq } from "drizzle-orm";
import {
  allocateIdr,
  CoreError,
  idr,
  z,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  assertCorrectionTargetsFinalOrder,
  assertRefundWithinPaid,
  posRefundSchema,
  posVoidSchema,
  refundAllocation,
  refundPosOrder as refundEndpoint,
  tenderBucket,
  voidPosOrderCorrection as voidCorrectionEndpoint,
  type PosRefund,
  type PosVoid,
} from "@starter/shared/pos";
import { db } from "../db/index.ts";
import { posOrderRefunds, posOrderVoids } from "../db/schema/pos-order.ts";
import { withTenant } from "../db/tenant.ts";
import type { Tx } from "./menu-internals.ts";
import { posReceiptPort } from "./pos-order-ports.ts";
import {
  appendOrderEvent,
  appendPosEvent,
  auditPos,
  consumeApproval,
  lockPosOrder,
  posIdempotent,
  tenderDto,
  tendersOf,
  type Locked,
  type PosCaller,
} from "./pos-order-support.ts";

type VoidCorrectionInput = z.output<typeof voidCorrectionEndpoint.body>;
type RefundInput = z.output<typeof refundEndpoint.body>;

type VoidRow = typeof posOrderVoids.$inferSelect;
type RefundRow = typeof posOrderRefunds.$inferSelect;

function voidDto(row: VoidRow): PosVoid {
  return posVoidSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    orderId: row.orderId,
    receiptNumber: row.receiptNumber,
    amountIdr: row.amountIdr,
    reason: row.reason,
    reasonNote: row.reasonNote,
    requestedBy: row.requestedBy,
    approvedBy: row.approvedBy,
    approvalRequestId: row.approvalRequestId,
    voidedAt: row.voidedAt.toISOString(),
  });
}

function refundDto(row: RefundRow): PosRefund {
  return posRefundSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    orderId: row.orderId,
    amountIdr: row.amountIdr,
    reason: row.reason,
    reasonNote: row.reasonNote,
    lines: row.lines,
    requestedBy: row.requestedBy,
    approvedBy: row.approvedBy,
    approvalRequestId: row.approvalRequestId,
    refundedAt: row.refundedAt.toISOString(),
  });
}

/** Corrections lock the final order (FOR UPDATE does not fire the triggers). */
async function correct<T>(
  context: ScopedTenantContext,
  caller: PosCaller,
  input: {
    outletId: string;
    orderId: string;
    key: string;
    operation: string;
    request: unknown;
  },
  run: (tx: Tx, locked: Locked) => Promise<T>,
): Promise<T> {
  return withTenant(db, context, (tx) =>
    posIdempotent(
      tx,
      context,
      {
        outletId: input.outletId,
        actorId: caller.userId,
        key: input.key,
        operation: input.operation,
        target: input.orderId,
        request: input.request,
      },
      async () => {
        const locked = await lockPosOrder(
          tx,
          context,
          input.outletId,
          input.orderId,
        );
        assertCorrectionTargetsFinalOrder({ status: locked.order.status });
        return run(tx, locked);
      },
    ),
  );
}

async function correctionsOf(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
): Promise<{ voids: VoidRow[]; refunds: RefundRow[] }> {
  const tenantId = context.tenant.tenantId;
  const [voids, refunds] = await Promise.all([
    tx
      .select()
      .from(posOrderVoids)
      .where(
        and(
          eq(posOrderVoids.tenantId, tenantId),
          eq(posOrderVoids.orderId, orderId),
        ),
      ),
    tx
      .select()
      .from(posOrderRefunds)
      .where(
        and(
          eq(posOrderRefunds.tenantId, tenantId),
          eq(posOrderRefunds.orderId, orderId),
        ),
      ),
  ]);
  return { voids, refunds };
}

/** POST .../corrections/void — linked void of a completed sale (POS-04). */
export async function voidPosOrderCorrection(
  context: ScopedTenantContext,
  caller: PosCaller,
  outletId: string,
  orderId: string,
  input: VoidCorrectionInput,
  now = new Date(),
): Promise<PosVoid> {
  const { idempotencyKey, ...request } = input;
  return correct(
    context,
    caller,
    {
      outletId,
      orderId,
      key: idempotencyKey,
      operation: "order.correction_void",
      request,
    },
    async (tx, { order }) => {
      const { voids, refunds } = await correctionsOf(tx, context, order.id);
      if (voids.length > 0)
        throw new CoreError("CONFLICT", "Transaksi ini sudah di-void.");
      if (refunds.length > 0)
        throw new CoreError(
          "CONFLICT",
          "Transaksi ini sudah direfund sebagian; lanjutkan dengan refund.",
        );
      if (order.totalIdr <= 0)
        throw new CoreError(
          "CONFLICT",
          "Tidak ada nilai transaksi untuk di-void.",
        );
      await consumeApproval(tx, context, {
        action: "void",
        purpose: "correction_void",
        outletId,
        orderId: order.id,
        objectType: "order",
        objectId: order.id,
        requesterId: caller.userId,
        approvedBy: input.approvedBy,
        approvalRequestId: input.approvalRequestId,
        minValueIdr: order.totalIdr,
      });
      const receipts = posReceiptPort();
      const receipt = await receipts.findForOrder(tx, context, order.id);
      if (receipt === null)
        throw new CoreError(
          "CONFLICT",
          "Struk transaksi ini tidak ditemukan; void tertaut memerlukan nomor struk.",
        );
      const [row] = await tx
        .insert(posOrderVoids)
        .values({
          tenantId: context.tenant.tenantId,
          outletId: order.outletId,
          orderId: order.id,
          receiptNumber: receipt.number,
          amountIdr: order.totalIdr,
          reason: input.reason,
          reasonNote: input.reasonNote,
          requestedBy: caller.userId,
          approvedBy: input.approvedBy,
          approvalRequestId: input.approvalRequestId,
          voidedAt: now,
        })
        .returning();
      if (!row) throw new Error("Void insert returned no row");
      // POS-06: the receipt is marked voided; its number stays on record.
      await receipts.voidForOrder(tx, context, {
        orderId: order.id,
        reason: input.reason,
        voidedBy: caller.userId,
        at: now,
      });
      const payload = {
        orderId: order.id,
        outletId,
        businessDate: order.businessDate,
        amountIdr: order.totalIdr,
        reason: input.reason,
        reasonNote: input.reasonNote,
        approvedBy: input.approvedBy,
        approvalRequestId: input.approvalRequestId,
        voidedFinalOrder: true,
        voidId: row.id,
        receiptNumber: receipt.number,
        voidedAt: now.toISOString(),
      };
      await appendPosEvent(tx, context, "order.voided", {
        order,
        payload,
        caller,
        now,
      });
      await appendOrderEvent(tx, context, {
        order,
        type: "order.voided",
        payload,
        caller,
        now,
      });
      await auditPos(
        tx,
        context,
        {
          action: "pos_order.correction_voided",
          order,
          caller,
          objectType: "pos_order_void",
          objectId: row.id,
          before: { id: order.id, status: order.status },
          after: {
            id: row.id,
            amountIdr: row.amountIdr,
            reason: row.reason,
            approvedBy: row.approvedBy,
            approvalRequestId: row.approvalRequestId,
            receiptNumber: row.receiptNumber,
          },
          reason: input.reasonNote,
        },
        now,
      );
      return voidDto(row);
    },
  );
}

/**
 * Splits a refund over the sale's revenue lines for the WS-07 refund rule
 * (gross − discount + service + tax = amount, exactly): service charge and
 * tax pro rata to the bill, discount pro rata to the net, gross the rest.
 */
function refundSplit(
  order: Locked["order"],
  amountIdr: number,
): {
  grossSalesIdr: number;
  discountIdr: number;
  serviceChargeIdr: number;
  pbjtIdr: number;
} {
  const net = Math.max(0, order.subtotalIdr - order.discountIdr);
  const [netPart, servicePart, taxPart] = allocateIdr(idr(amountIdr), [
    net,
    order.serviceChargeIdr,
    order.taxIdr,
  ]).map(Number);
  const discountPart =
    net > 0
      ? Math.min(
          order.discountIdr,
          Math.floor((order.discountIdr * netPart) / net),
        )
      : 0;
  return {
    grossSalesIdr: netPart + discountPart,
    discountIdr: discountPart,
    serviceChargeIdr: servicePart,
    pbjtIdr: taxPart,
  };
}

/** POST .../corrections/refund — linked refund against a paid sale (POS-04). */
export async function refundPosOrder(
  context: ScopedTenantContext,
  caller: PosCaller,
  outletId: string,
  orderId: string,
  input: RefundInput,
  now = new Date(),
): Promise<PosRefund> {
  const { idempotencyKey, ...request } = input;
  return correct(
    context,
    caller,
    {
      outletId,
      orderId,
      key: idempotencyKey,
      operation: "order.refund",
      request,
    },
    async (tx, { order }) => {
      const { voids, refunds } = await correctionsOf(tx, context, order.id);
      if (voids.length > 0)
        throw new CoreError("CONFLICT", "Transaksi ini sudah di-void.");
      const tenders = (await tendersOf(tx, context, order.id)).map(tenderDto);
      const paid = tenders
        .filter((tender) => tender.status === "captured")
        .reduce((sum, tender) => sum + Number(tender.amountIdr), 0);
      const refunded = refunds.reduce((sum, row) => sum + row.amountIdr, 0);
      assertRefundWithinPaid(idr(paid), idr(refunded), idr(input.amountIdr));
      await consumeApproval(tx, context, {
        action: "refund",
        purpose: "refund",
        outletId,
        orderId: order.id,
        objectType: "order",
        objectId: order.id,
        requesterId: caller.userId,
        approvedBy: input.approvedBy,
        approvalRequestId: input.approvalRequestId,
        minValueIdr: input.amountIdr,
      });
      const allocation = refundAllocation(tenders, idr(input.amountIdr));
      const lines = allocation.map((line) => ({
        method: line.method,
        amountIdr: Number(line.amountIdr),
        reference: null,
      }));
      const [row] = await tx
        .insert(posOrderRefunds)
        .values({
          tenantId: context.tenant.tenantId,
          outletId: order.outletId,
          orderId: order.id,
          amountIdr: idr(input.amountIdr),
          reason: input.reason,
          reasonNote: input.reasonNote,
          lines,
          requestedBy: caller.userId,
          approvedBy: input.approvedBy,
          approvalRequestId: input.approvalRequestId,
          refundedAt: now,
        })
        .returning();
      if (!row) throw new Error("Refund insert returned no row");
      const bucket = (name: string) =>
        lines
          .filter((line) => tenderBucket(line.method as never) === name)
          .reduce((sum, line) => sum + line.amountIdr, 0);
      const payload = {
        orderId: order.id,
        outletId,
        businessDate: order.businessDate,
        refundId: row.id,
        amountIdr: input.amountIdr,
        reason: input.reason,
        reasonNote: input.reasonNote,
        approvedBy: input.approvedBy,
        approvalRequestId: input.approvalRequestId,
        ...refundSplit(order, input.amountIdr),
        refundCashIdr: bucket("cash"),
        refundGatewayIdr: bucket("gateway"),
        refundEdcIdr: bucket("edc"),
        refundPointsIdr: bucket("points"),
        lines: lines.map((line) => ({
          method: line.method,
          amountIdr: line.amountIdr,
        })),
        refundedAt: now.toISOString(),
      };
      await appendPosEvent(tx, context, "order.refunded", {
        order,
        payload,
        caller,
        now,
      });
      await appendOrderEvent(tx, context, {
        order,
        type: "order.refunded",
        payload,
        caller,
        now,
      });
      await auditPos(
        tx,
        context,
        {
          action: "pos_order.refunded",
          order,
          caller,
          objectType: "pos_order_refund",
          objectId: row.id,
          before: { id: order.id, amountIdr: refunded },
          after: {
            id: row.id,
            amountIdr: row.amountIdr,
            reason: row.reason,
            approvedBy: row.approvedBy,
            approvalRequestId: row.approvalRequestId,
          },
          reason: input.reasonNote,
        },
        now,
      );
      return refundDto(row);
    },
  );
}
