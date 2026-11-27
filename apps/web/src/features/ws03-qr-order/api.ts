// One typed function per endpoint of the QR order journey. The contracts live
// in @starter/shared/qr-order (+ guest.ts); the same objects drive mock mode.
import { callEndpoint } from "@/lib/api/endpoint";
import {
  addCartLine,
  chooseOrderIssueResolution,
  claimSessionPoints,
  createGuestPayment,
  createServiceRequest,
  createSessionSplits,
  getGuestPayment,
  getGuestPaymentOptions,
  getMenuSuggestions,
  getOrderEtas,
  getPointClaim,
  getQrMenu,
  getReviewEligibility,
  getSessionBill,
  getSplitClaim,
  getTableSession,
  listSessionOrderIssues,
  openOrJoinTableSession,
  placeQrOrder,
  quoteTableSession,
  removeCartLine,
  submitTableReview,
  updateCartLine,
} from "@starter/shared/qr-order";
import type {
  CreateSplitsInput,
  CustomerOrderIssueResolution,
  GuestPaymentMethod,
  GuestPaymentTarget,
  ServiceRequestReason,
} from "@starter/shared/qr-order";
import { ApiError } from "@/lib/api/errors";
import { idempotencyKey } from "./lib/ids.ts";
import { payerSecretForSplit, storedPayerSecret } from "./session-store.ts";

export const menuEndpoint = getQrMenu;
export const sessionEndpoint = getTableSession;
export const suggestionsEndpoint = getMenuSuggestions;
export const billEndpoint = getSessionBill;
export const reviewEligibilityEndpoint = getReviewEligibility;
export const orderIssuesEndpoint = listSessionOrderIssues;
export const pointClaimEndpoint = getPointClaim;
export const paymentEndpoint = getGuestPayment;
export const paymentOptionsEndpoint = getGuestPaymentOptions;
export const orderEtasEndpoint = getOrderEtas;

export const scanTable = (input: {
  qrToken: string;
  pax: number;
  deviceHash: string;
}) => callEndpoint(openOrJoinTableSession, { body: input });

export type CartItemInput = {
  menuItemId: string;
  variantId: string | null;
  quantity: number;
  modifierIds: readonly string[];
  note?: string;
};

export const addToCart = (
  sessionId: string,
  expectedCartVersion: number,
  line: CartItemInput,
) =>
  callEndpoint(addCartLine, {
    params: { sessionId },
    body: {
      menuItemId: line.menuItemId,
      variantId: line.variantId,
      quantity: line.quantity,
      modifierIds: [...line.modifierIds],
      ...(line.note ? { note: line.note } : {}),
      expectedCartVersion,
      idempotencyKey: idempotencyKey("cart-add"),
    },
  });

export const changeCartLine = (
  sessionId: string,
  lineId: string,
  expectedCartVersion: number,
  patch: { quantity?: number; note?: string | null },
) =>
  callEndpoint(updateCartLine, {
    params: { sessionId, lineId },
    body: {
      ...patch,
      expectedCartVersion,
      idempotencyKey: idempotencyKey("cart-set"),
    },
  });

export const deleteCartLine = (
  sessionId: string,
  lineId: string,
  expectedCartVersion: number,
) =>
  callEndpoint(removeCartLine, {
    params: { sessionId, lineId },
    query: { expectedCartVersion },
  });

export const requestQuote = (
  sessionId: string,
  codes: { promoCode?: string; voucherCode?: string },
) => callEndpoint(quoteTableSession, { params: { sessionId }, body: codes });

export const placeOrder = (
  sessionId: string,
  input: { expectedCartVersion: number; idempotencyKey: string; note?: string },
) => callEndpoint(placeQrOrder, { params: { sessionId }, body: input });

export const createSplits = (sessionId: string, input: CreateSplitsInput) =>
  callEndpoint(createSessionSplits, { params: { sessionId }, body: input });

export const sendServiceRequest = (
  sessionId: string,
  input:
    | { type: "call_waiter"; reason: ServiceRequestReason; message?: string }
    | { type: "request_bill" }
    | { type: "complaint"; message: string },
) =>
  callEndpoint(createServiceRequest, {
    params: { sessionId },
    body: { ...input, idempotencyKey: idempotencyKey("svc") },
  });

export const submitReview = (
  sessionId: string,
  input: { rating: number; comment?: string },
) =>
  callEndpoint(submitTableReview, {
    params: { sessionId },
    body: input,
  });

export const chooseIssueResolution = (
  orderIssueId: string,
  input: { choice: CustomerOrderIssueResolution; replacementItemId?: string },
) =>
  callEndpoint(chooseOrderIssueResolution, {
    params: { orderIssueId },
    body: input,
  });

export const startPayment = (
  sessionId: string,
  input: {
    target: GuestPaymentTarget;
    method: GuestPaymentMethod;
    /** Required for `va` (a code from the payment options); none for QRIS. */
    bankCode?: string;
    /** The total (bill + fee) the guest saw; sent for a method with a fee. */
    expectedChargedIdr?: number;
    idempotencyKey: string;
  },
) =>
  callEndpoint(createGuestPayment, {
    params: { sessionId },
    // A split part is paid with the payer's own secret (legend-r77pq).
    body:
      input.target.kind === "split"
        ? {
            ...input,
            payerSecret: payerSecretForSplit(
              sessionId,
              input.target.billSplitId,
            ),
          }
        : input,
  });

/** Claim token of a split part the guest paid; needs the secret kept at pay time. */
export const fetchSplitClaim = (sessionId: string, splitId: string) => {
  const payerSecret = storedPayerSecret(sessionId, splitId);
  // No kept secret (other device, cleared storage): same answer as a wrong one.
  if (payerSecret === null)
    return Promise.reject(
      new ApiError(404, "NOT_FOUND", "Bagian ini tidak ditemukan."),
    );
  return callEndpoint(getSplitClaim, {
    params: { sessionId, splitId },
    body: { payerSecret },
  });
};

export const claimPoints = (sessionId: string) =>
  callEndpoint(claimSessionPoints, {
    params: { sessionId },
    body: { idempotencyKey: idempotencyKey("claim") },
  });
