// One function per POS correction call (bead legend-2fo); components never call
// these (they use the hooks in ./hooks.ts). Every call has a shared endpoint,
// so all go through the typed client; mock mode answers from ./mock.ts.
import {
  applyPosDiscount,
  getPosApprovalPolicy,
  getPosOrder,
  getPosReceiptDocument,
  issuePosReceipt,
  refundPosOrder,
  voidPosOrderItem,
  type DiscountReason,
  type PosApprovalPolicy,
  type PosOrderDetail,
  type PosReceiptIssueResult,
  type PrintPaperWidth,
  type PosRefund,
  type ReceiptDocument,
  type RefundReason,
  type VoidReason,
} from "@starter/shared/pos";
import { callEndpoint } from "@/lib/api/endpoint";
import { API_MOCK } from "@/lib/api/mock-flag";
import { applyCorrectionDemo } from "./demo";

/** The supervisor's approval of one correction: who approved and which override. */
export type CorrectionApproval = { approvedBy: string; overrideId: string };

export async function fetchOrder(
  outletId: string,
  orderId: string,
  signal?: AbortSignal,
): Promise<PosOrderDetail> {
  const { data } = await callEndpoint(
    getPosOrder,
    { params: { outletId, orderId } },
    { signal },
  );
  return API_MOCK ? applyCorrectionDemo(data) : data;
}

export async function fetchPolicy(
  outletId: string,
  signal?: AbortSignal,
): Promise<PosApprovalPolicy> {
  const { data } = await callEndpoint(
    getPosApprovalPolicy,
    { params: { outletId } },
    { signal },
  );
  return data;
}

export async function fetchReceiptDocument(
  outletId: string,
  receiptId: string,
  signal?: AbortSignal,
): Promise<ReceiptDocument> {
  const { data } = await callEndpoint(
    getPosReceiptDocument,
    { params: { outletId, receiptId } },
    { signal },
  );
  return data;
}

export type ApplyDiscountInput = {
  orderId: string;
  percentBp: number;
  reason: DiscountReason;
  reasonNote: string;
  expectedVersion: number;
  approval?: CorrectionApproval;
};

/** Manual discount, in percent: the server works out the amount (POS-02). */
export async function applyManualDiscount(
  outletId: string,
  input: ApplyDiscountInput,
  idempotencyKey: string,
): Promise<PosOrderDetail> {
  const { data } = await callEndpoint(applyPosDiscount, {
    params: { outletId, orderId: input.orderId },
    body: {
      source: "manual",
      kind: "percent",
      percentBp: input.percentBp,
      reason: input.reason,
      reasonNote: input.reasonNote,
      expectedVersion: input.expectedVersion,
      ...(input.approval ?? {}),
      idempotencyKey,
    },
  });
  return data;
}

export type VoidItemInput = {
  orderId: string;
  itemId: string;
  reason: VoidReason;
  reasonNote: string;
  expectedVersion: number;
  approval: CorrectionApproval;
};

export async function voidOrderItem(
  outletId: string,
  input: VoidItemInput,
  idempotencyKey: string,
): Promise<PosOrderDetail> {
  const { data } = await callEndpoint(voidPosOrderItem, {
    params: { outletId, orderId: input.orderId, itemId: input.itemId },
    body: {
      reason: input.reason,
      reasonNote: input.reasonNote,
      expectedVersion: input.expectedVersion,
      ...input.approval,
      idempotencyKey,
    },
  });
  return data;
}

export type RefundInput = {
  orderId: string;
  amountIdr: number;
  reason: RefundReason;
  reasonNote: string;
  approval: CorrectionApproval;
};

export async function refundOrder(
  outletId: string,
  input: RefundInput,
  idempotencyKey: string,
): Promise<PosRefund> {
  const { data } = await callEndpoint(refundPosOrder, {
    params: { outletId, orderId: input.orderId },
    body: {
      amountIdr: input.amountIdr,
      reason: input.reason,
      reasonNote: input.reasonNote,
      ...input.approval,
      idempotencyKey,
    },
  });
  return data;
}

/** Print (or reprint) the receipt; the server counts a reprint by itself. */
export async function printOrderReceipt(
  outletId: string,
  orderId: string,
  idempotencyKey: string,
  /** P2: this tablet's paper; the cloud then answers with the ESC/POS bytes. */
  paperWidth?: PrintPaperWidth,
): Promise<PosReceiptIssueResult> {
  const { data } = await callEndpoint(issuePosReceipt, {
    params: { outletId, orderId },
    body: {
      deliveries: ["print"],
      ...(paperWidth === undefined ? {} : { paperWidth }),
      idempotencyKey,
    },
  });
  return data;
}
