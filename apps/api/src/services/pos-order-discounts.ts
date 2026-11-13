// POS discount lines (bead legend-kk7; PRD v1.7 §3 F8 "Diskon, Void &
// Refund", §3.21 Promo Engine; POS-02; contract applyPosDiscount /
// removePosDiscount, calculations.ts requiresDiscountApproval).
//
// - Manual discounts are a percentage of the live subtotal (the contract body
//   carries no rupiah amount, ORD-03 money rule), so `kind: "amount"` is only
//   for promo/voucher lines the engine prices. A manual discount above the
//   tenant threshold (pos_approval_policies, fail closed at 1 bp) needs a
//   verified supervisor approval; the threshold is compared with the
//   cumulative manual discount of the order (decision: splitting one large
//   discount into several small ones cannot dodge POS-02).
// - Promo and voucher codes go through the promo engine port (order-promo
//   port, legend-souz), redeemed inside this transaction after the order row
//   is locked (engine lock order step 1). One live promo/voucher per order.
// - Discounts change only before settlement: a live order with no captured
//   tender. Removal is a soft `removed_at` (history kept); a promo is
//   released through the port.

import { and, eq, isNull } from "drizzle-orm";
import {
  CoreError,
  idr,
  z,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  applyPosDiscount as applyEndpoint,
  PosError,
  requiresDiscountApproval,
  type PosOrderDetail,
} from "@starter/shared/pos";
import { posOrderDiscounts } from "../db/schema/pos-order.ts";
import { posOrderPromoPort } from "./pos-order-ports.ts";
import { lineSubtotalIdr, posPriceChannel } from "./pos-order-pricing.ts";
import {
  discountThresholdBp,
  freshDetail,
  mutatePosOrder,
} from "./pos-order.service.ts";
import {
  appendOrderEvent,
  assertMutable,
  assertNoPendingGatewayTender,
  auditPos,
  bumpPos,
  capturedIdr,
  consumeApproval,
  itemsOf,
  liveDiscountsOf,
  loadOutlet,
  repriceOrder,
  tendersOf,
  type Locked,
  type PosCaller,
} from "./pos-order-support.ts";
import type { Tx } from "./menu-internals.ts";
import { assertNoActiveQrisHold } from "./pos-qris-hold.ts";

type ApplyInput = z.output<typeof applyEndpoint.body>;

async function assertBeforeSettlement(
  tx: Tx,
  context: ScopedTenantContext,
  locked: Locked,
): Promise<void> {
  assertMutable(locked.order);
  // legend-yhia9 D-01: no discount while a QR can still be paid.
  await assertNoActiveQrisHold(tx, context, locked.order.id);
  const tenders = await tendersOf(tx, context, locked.order.id);
  if (capturedIdr(tenders) > 0)
    throw new CoreError(
      "CONFLICT",
      "Diskon hanya dapat diubah sebelum pembayaran diterima.",
    );
  // A pending QRIS bill was opened for the old total: repricing now would let
  // the guest pay a stale amount that can no longer be captured (review fix).
  assertNoPendingGatewayTender(tenders);
}

/** POST .../discounts. */
export async function applyPosDiscount(
  context: ScopedTenantContext,
  caller: PosCaller,
  outletId: OutletId,
  orderId: string,
  input: ApplyInput,
  now = new Date(),
): Promise<PosOrderDetail> {
  const { idempotencyKey, ...request } = input;
  return mutatePosOrder(
    context,
    caller,
    {
      outletId,
      orderId,
      key: idempotencyKey,
      operation: "order.discount",
      request,
    },
    async (tx, locked) => {
      const { order, pos } = locked;
      const tenantId = context.tenant.tenantId;
      await assertBeforeSettlement(tx, context, locked);
      const items = (await itemsOf(tx, context, order.id))
        .map(({ item }) => item)
        .filter((item) => item.status !== "voided");
      const subtotal = items.reduce(
        (sum, item) => sum + lineSubtotalIdr(item),
        0,
      );
      if (subtotal <= 0) throw new PosError("DISCOUNT_EXCEEDS_SUBTOTAL");
      const existing = await liveDiscountsOf(tx, context, order.id);
      const existingTotal = existing.reduce(
        (sum, row) => sum + row.amountIdr,
        0,
      );

      let amount: number;
      let approved: {
        by: string;
        requestId: string | null;
        overrideId: string;
      } | null = null;
      let promoCode: string | null = null;
      if (input.source === "manual") {
        if (input.kind !== "percent" || input.percentBp === undefined)
          throw new CoreError(
            "VALIDATION_ERROR",
            "Diskon manual dipilih dalam persen; nominalnya dihitung server.",
          );
        amount = Math.floor((subtotal * input.percentBp) / 10_000);
        if (amount <= 0)
          throw new CoreError(
            "VALIDATION_ERROR",
            "Diskon terlalu kecil untuk pesanan ini.",
          );
        if (existingTotal + amount > subtotal)
          throw new PosError("DISCOUNT_EXCEEDS_SUBTOTAL");
        const manualTotal =
          existing
            .filter((row) => row.source === "manual")
            .reduce((sum, row) => sum + row.amountIdr, 0) + amount;
        const needsApproval = requiresDiscountApproval({
          source: "manual",
          amountIdr: idr(manualTotal),
          subtotalIdr: idr(subtotal),
          thresholdBp: await discountThresholdBp(tx, context, outletId),
        });
        if (
          needsApproval &&
          (input.overrideId === undefined || input.approvedBy === undefined)
        )
          throw new PosError("DISCOUNT_APPROVAL_REQUIRED");
        // An approval that is sent is always verified, required or not.
        if (input.overrideId !== undefined && input.approvedBy !== undefined) {
          const override = await consumeApproval(tx, context, {
            action: "discount",
            purpose: "discount",
            outletId,
            orderId: order.id,
            objectType: "order",
            objectId: order.id,
            requesterId: caller.userId,
            approvedBy: input.approvedBy,
            overrideId: input.overrideId,
            minValueIdr: amount,
            deviceId: caller.deviceId,
            now,
          });
          approved = {
            by: input.approvedBy,
            requestId: override.approvalRequestId,
            overrideId: override.id,
          };
        }
      } else {
        if (input.kind !== "amount")
          throw new CoreError(
            "VALIDATION_ERROR",
            "Diskon promo/voucher dihitung oleh mesin promo (kind amount).",
          );
        if (existing.some((row) => row.source !== "manual"))
          throw new CoreError(
            "CONFLICT",
            "Pesanan ini sudah memakai promo/voucher.",
          );
        promoCode =
          (input.source === "promo" ? input.promoCode : input.voucherCode) ??
          null;
        if (promoCode === null)
          throw new CoreError("VALIDATION_ERROR", "Kode promo wajib diisi.");
        const outlet = await loadOutlet(tx, context, outletId);
        const promoInput = {
          outletId: outlet.id as OutletId,
          channel: posPriceChannel(
            order.channel as Parameters<typeof posPriceChannel>[0],
            order.serviceType as Parameters<typeof posPriceChannel>[1],
          ),
          lines: items.map((item) => ({
            menuItemId: item.menuItemId,
            quantity: item.quantity,
            unitPriceIdr: idr(item.unitPriceIdr + item.modifiersTotalIdr),
            lineTotalIdr: idr(lineSubtotalIdr(item)),
          })),
          customer: null,
          voucherCode: promoCode,
          at: now,
        };
        const port = posOrderPromoPort();
        const quote = await port.quote(tx, context, promoInput);
        if (quote.totalDiscountIdr <= 0)
          throw new CoreError(
            "CONFLICT",
            "Promo ini tidak berlaku untuk pesanan ini.",
          );
        const redeemed = await port.redeem(tx, context, {
          ...promoInput,
          orderId: order.id,
          actorUserId: caller.userId,
          expected: quote.result,
        });
        amount = redeemed.totalDiscountIdr;
        if (amount <= 0 || existingTotal + amount > subtotal)
          throw new PosError("DISCOUNT_EXCEEDS_SUBTOTAL");
      }

      const [row] = await tx
        .insert(posOrderDiscounts)
        .values({
          tenantId,
          outletId: order.outletId,
          orderId: order.id,
          source: input.source,
          kind: input.kind,
          percentBp:
            input.kind === "percent" ? (input.percentBp ?? null) : null,
          amountIdr: idr(amount),
          promoCode,
          reason: input.reason,
          reasonNote: input.reasonNote ?? null,
          appliedBy: caller.userId,
          approvedBy: approved?.by ?? null,
          approvalRequestId: approved?.requestId ?? null,
          overrideId: approved?.overrideId ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new Error("Discount insert returned no row");
      const outlet = await loadOutlet(tx, context, outletId);
      const repriced = await repriceOrder(tx, context, { order, outlet, now });
      await bumpPos(tx, context, pos, now);
      await appendOrderEvent(tx, context, {
        order,
        type: "order.discount_applied",
        payload: {
          discountId: row.id,
          source: row.source,
          kind: row.kind,
          percentBp: row.percentBp,
          amountIdr: row.amountIdr,
          reason: row.reason,
          approvedBy: row.approvedBy,
          approvalRequestId: row.approvalRequestId,
          overrideId: row.overrideId,
          totalIdr: repriced.totalIdr,
        },
        caller,
        now,
      });
      await auditPos(
        tx,
        context,
        {
          action: "pos_order.discount_applied",
          order,
          caller,
          objectType: "pos_order_discount",
          objectId: row.id,
          before: { id: order.id, totalIdr: order.totalIdr },
          after: {
            id: row.id,
            source: row.source,
            kind: row.kind,
            percentBp: row.percentBp,
            amountIdr: row.amountIdr,
            reason: row.reason,
            approvedBy: row.approvedBy,
            approvalRequestId: row.approvalRequestId,
            overrideId: row.overrideId,
            totalIdr: repriced.totalIdr,
          },
          reason: row.reasonNote,
        },
        now,
      );
      return freshDetail(tx, context, outletId, orderId);
    },
  );
}

/** DELETE .../discounts/:discountId (before settlement only). */
export async function removePosDiscount(
  context: ScopedTenantContext,
  caller: PosCaller,
  outletId: OutletId,
  orderId: string,
  discountId: string,
  input: { idempotencyKey: string },
  now = new Date(),
): Promise<PosOrderDetail> {
  return mutatePosOrder(
    context,
    caller,
    {
      outletId,
      orderId,
      key: input.idempotencyKey,
      operation: "order.discount_remove",
      request: { discountId },
    },
    async (tx, locked) => {
      const { order, pos } = locked;
      const tenantId = context.tenant.tenantId;
      await assertBeforeSettlement(tx, context, locked);
      const [removed] = await tx
        .update(posOrderDiscounts)
        .set({ removedAt: now, removedBy: caller.userId, updatedAt: now })
        .where(
          and(
            eq(posOrderDiscounts.tenantId, tenantId),
            eq(posOrderDiscounts.orderId, order.id),
            eq(posOrderDiscounts.id, discountId),
            isNull(posOrderDiscounts.removedAt),
          ),
        )
        .returning();
      if (!removed) throw new CoreError("NOT_FOUND", "Diskon tidak ditemukan.");
      if (removed.source !== "manual")
        await posOrderPromoPort().release(tx, context, {
          orderId: order.id,
          reason: "Diskon dilepas kasir",
          actorUserId: caller.userId,
          at: now,
        });
      const outlet = await loadOutlet(tx, context, outletId);
      const repriced = await repriceOrder(tx, context, { order, outlet, now });
      await bumpPos(tx, context, pos, now);
      await appendOrderEvent(tx, context, {
        order,
        type: "order.discount_removed",
        payload: {
          discountId,
          source: removed.source,
          amountIdr: removed.amountIdr,
          totalIdr: repriced.totalIdr,
        },
        caller,
        now,
      });
      await auditPos(
        tx,
        context,
        {
          action: "pos_order.discount_removed",
          order,
          caller,
          objectType: "pos_order_discount",
          objectId: discountId,
          before: {
            id: discountId,
            source: removed.source,
            amountIdr: removed.amountIdr,
          },
          after: { id: discountId, totalIdr: repriced.totalIdr },
        },
        now,
      );
      return freshDetail(tx, context, outletId, orderId);
    },
  );
}
