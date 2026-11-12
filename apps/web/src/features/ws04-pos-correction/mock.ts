// Mock mode handlers for the POS correction endpoints (VITE_API_MOCK=true; bead
// legend-2fo). The orders, tenders and receipts come from the POS kasir mock
// engine (the same demo orders the payment screens use); `getPosOrder`,
// `getPosApprovalPolicy`, `issuePosReceipt` and `createPosOverride` are already
// registered there. A correction here only checks the rules the real API
// checks and answers with the order as it stands: the demo order is not edited.
import {
  applyPosDiscount,
  getPosReceiptDocument,
  refundPosOrder,
  voidPosOrderItem,
} from "@starter/shared/pos";
import { ApiError } from "@/lib/api/errors";
import { registerMock } from "@/lib/mock/registry";
import { DEMO_CODE_ORDER_ID, DEMO_ORDER_ID } from "../ws04-pos-kasir/demo-seed";
import { MOCK_CASHIER_ID } from "../ws04-pos-kasir/fixtures";
import { callPosKasirEngine } from "../ws04-pos-kasir/mock-engine";
import {
  approvalPolicyWire,
  orderDetailWire,
  orderUlidOf,
  receiptIssueWire,
  receiptWire,
} from "../ws04-pos-kasir/mock-wire";
import { discountNeedsApproval, percentDiscountIdr } from "./correction-logic";

const wire = (value: unknown) => value as never;

const orderState = (orderId: string) =>
  callPosKasirEngine((engine) => ({
    order: engine.rawOrder(orderId),
    remaining: engine.rawRemainingIdr(orderId),
  }));

registerMock(applyPosDiscount, ({ params, body }) => {
  const { order, remaining } = orderState(params.orderId);
  if (body.kind !== "percent" || body.percentBp === undefined)
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "Diskon manual dipilih dalam persen; nominalnya dihitung server.",
    );
  if (remaining === 0)
    throw new ApiError(
      409,
      "ORDER_NOT_EDITABLE",
      "Pesanan sudah lunas, diskon tidak bisa ditambahkan.",
    );
  const discountIdr = percentDiscountIdr({
    subtotalIdr: order.subtotalIdr,
    percentBp: body.percentBp,
  });
  if (discountIdr <= 0)
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "Diskon terlalu kecil untuk pesanan ini.",
    );
  if (
    discountNeedsApproval({
      subtotalIdr: order.subtotalIdr,
      discountIdr,
      thresholdBp: approvalPolicyWire.discountThresholdBp,
    }) &&
    body.overrideId === undefined
  )
    throw new ApiError(
      403,
      "DISCOUNT_APPROVAL_REQUIRED",
      "Diskon di atas ambang memerlukan persetujuan.",
    );
  return wire({ data: orderDetailWire(order, remaining) });
});

registerMock(voidPosOrderItem, ({ params }) => {
  const { order, remaining } = orderState(params.orderId);
  if (remaining === 0)
    throw new ApiError(
      409,
      "ORDER_NOT_EDITABLE",
      "Pesanan sudah lunas, item tidak bisa di-void.",
    );
  return wire({ data: orderDetailWire(order, remaining) });
});

registerMock(refundPosOrder, ({ params, body }) => {
  const { order, remaining } = orderState(params.orderId);
  const detail = orderDetailWire(order, remaining);
  if (detail.status !== "completed")
    throw new ApiError(
      409,
      "CORRECTION_TARGET_NOT_FINAL",
      "Koreksi hanya untuk transaksi final.",
    );
  const paidIdr = detail.tenders.reduce(
    (sum, tender) => sum + Number(tender.amountIdr),
    0,
  );
  if (body.amountIdr > paidIdr)
    throw new ApiError(
      422,
      "REFUND_EXCEEDS_PAID",
      "Refund melebihi nominal yang masih dapat direfund.",
    );
  return wire({
    data: {
      id: "00000000-0000-4000-8000-0000000f0001",
      tenantId: detail.tenantId,
      outletId: detail.outletId,
      orderId: orderUlidOf(order.id),
      amountIdr: body.amountIdr,
      reason: body.reason,
      reasonNote: body.reasonNote,
      lines: [
        {
          method: detail.tenders[0]?.method ?? "cash",
          amountIdr: body.amountIdr,
          reference: null,
        },
      ],
      items: [],
      requestedBy: MOCK_CASHIER_ID,
      approvedBy: body.approvedBy,
      approvalRequestId: null,
      overrideId: body.overrideId,
      refundedAt: new Date().toISOString(),
    },
  });
});

// The demo receipt id is derived from its number, so the receipt is found by
// asking each demo order for its own id.
registerMock(getPosReceiptDocument, ({ params }) => {
  const order = callPosKasirEngine((engine) =>
    [DEMO_ORDER_ID, DEMO_CODE_ORDER_ID]
      .map((id) => engine.rawOrder(id))
      .find((candidate) => receiptWire(candidate).id === params.receiptId),
  );
  if (!order) throw new ApiError(404, "NOT_FOUND", "Struk tidak ditemukan.");
  return wire({ data: receiptIssueWire(order).document });
});
