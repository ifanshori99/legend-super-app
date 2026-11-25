// One function per POS kasir call; components never call these (they use the
// hooks in ./hooks.ts). Calls with a shared endpoint go through the typed
// client. Calls without a contract yet (see ./CONTRACT-GAPS.md) run on the mock
// engine in mock mode and fail with CONTRACT_PENDING everywhere else, so the
// screen shows a clear error instead of made-up data.
import {
  addPosTender,
  applyPosDiscount,
  completePosOrder,
  getPosApprovalPolicy,
  getPosOrder,
  issuePosReceipt,
  removePosDiscount,
  type PosOrderDetail,
} from "@starter/shared/pos";
import { validateVoucher } from "@starter/shared/crm";
import {
  getPosOrderPoints,
  quotePosOrderPoints,
  redeemPosOrderPoints,
} from "@starter/shared/pos/points";
import { callEndpoint } from "@/lib/api/endpoint";
import { ApiError } from "@/lib/api/errors";
import { API_MOCK } from "@/lib/api/mock-flag";
import { runPosKasirMock, type PosKasirEngine } from "./mock-engine";
import { remainingToPayIdr } from "./payment-due";
import {
  CONTRACT_PENDING,
  type AttemptRef,
  type CashierCodeOrder,
  type ConfirmCashInput,
  type EdcTerminal,
  type Ewallet,
  type PaymentAttempt,
  type PaymentMethodOption,
  type PaymentSession,
  type PointsAccount,
  type PointsQuote,
  type ReceiptResult,
  type RecordEdcStandaloneInput,
  type StartPaymentInput,
  type VaBank,
  type VoucherCheck,
} from "./types";

// ---- Helpers ---------------------------------------------------------------

/** The error a call without a contract gives outside mock mode. */
/** `printReceipt` could not complete the order (e.g. CONFLICT, items held). */
export const ORDER_COMPLETE_FAILED = "ORDER_COMPLETE_FAILED";

export function contractPending(feature: string): ApiError {
  return new ApiError(
    501,
    CONTRACT_PENDING,
    `Fitur ini belum tersambung ke server (${feature}).`,
  );
}

/** Local contract: the mock engine in mock mode, CONTRACT_PENDING otherwise. */
export function local<T>(
  feature: string,
  call: (engine: PosKasirEngine) => T,
  extraLatencyMs = 0,
): Promise<T> {
  if (!API_MOCK) return Promise.reject(contractPending(feature));
  return runPosKasirMock(call, extraLatencyMs);
}

// Idempotency keys are made once per intent by the hooks (./hooks.ts) and sent
// in as an argument, so a retry of the same action repeats the same key and the
// server charges or records it once.

export const METHOD_LABELS: Record<string, string> = {
  cash: "Tunai",
  qris: "QRIS",
  va: "Virtual Account",
  ewallet: "E-wallet",
  card: "Kartu kredit/debit",
  edc_card: "EDC kartu",
  edc_qris: "EDC QRIS",
  points: "Poin",
};

// ---- Typed endpoints (raw) -------------------------------------------------

export async function fetchPosOrder(
  outletId: string,
  orderId: string,
  signal?: AbortSignal,
) {
  const { data } = await callEndpoint(
    getPosOrder,
    { params: { outletId, orderId } },
    { signal },
  );
  return data;
}

export async function fetchApprovalPolicy(outletId: string) {
  const { data } = await callEndpoint(getPosApprovalPolicy, {
    params: { outletId },
  });
  return data;
}

// ---- Mapping real responses to the screen view-models ----------------------

/**
 * The EDC request the bank refused, shown until the cashier pays another way.
 * A refusal puts no tender on the bill, so totals and the remaining balance
 * stay as the server priced them. Null once the bill is paid or a later tender
 * landed (the cashier moved on).
 */
function declinedEdcAttempt(
  order: PosOrderDetail,
  captured: PosOrderDetail["tenders"],
  remainingIdr: number,
): PaymentAttempt | null {
  const latest = order.edcAttempts[0];
  if (!latest || latest.status !== "declined" || remainingIdr === 0)
    return null;
  const declinedAt = Date.parse(latest.createdAt);
  if (captured.some((t) => Date.parse(t.requestedAt) >= declinedAt))
    return null;
  const amountIdr = Number(latest.amountIdr);
  return {
    id: latest.id,
    sequence: captured.length + 1,
    method: "edc",
    status: "declined",
    amountIdr,
    edc: {
      terminalId: latest.terminalId,
      terminalLabel: latest.terminalLabel ?? "",
      bank: latest.bank ?? "",
      mode: latest.method ?? "card",
      lockedAmountIdr: amountIdr,
      ...(latest.declineReason ? { declineReason: latest.declineReason } : {}),
      ...(latest.responseCode ? { responseCode: latest.responseCode } : {}),
    },
  };
}

/**
 * legend-7e8kx: the order's newest tender is a QRIS the server voided and
 * refunded for a reason the cashier text names, and the bill is still unpaid.
 * It is shown as a failed QRIS attempt that carries the reason; otherwise
 * there is no attempt (the gateway flow itself is not on the wire yet).
 */
function voidedQrisAttempt(
  order: PosOrderDetail,
  remainingIdr: number,
): PaymentAttempt | null {
  if (remainingIdr === 0) return null;
  const ordered = [...order.tenders].sort((a, b) =>
    a.requestedAt.localeCompare(b.requestedAt),
  );
  const latest = ordered.at(-1);
  if (
    latest === undefined ||
    latest.method !== "qris" ||
    latest.status !== "voided" ||
    !latest.voidReason
  )
    return null;
  return {
    id: latest.id,
    sequence: ordered.length,
    method: "qris",
    status: "failed",
    // The guest pays the bill that is still open, which can be less than the
    // voided tender (bill_below_tender); fall back to the tender amount.
    amountIdr: remainingIdr > 0 ? remainingIdr : Number(latest.amountIdr),
    voidReason: latest.voidReason,
  };
}

function sessionFromOrder(order: PosOrderDetail): PaymentSession {
  const captured = order.tenders.filter((t) => t.status === "captured");
  const paidIdr = captured.reduce((sum, t) => sum + Number(t.amountIdr), 0);
  // The reservation DP is not a tender: it is the order's `depositAppliedIdr`
  // (legend-p7lx). Leaving it out billed a DP-settled order in full again.
  const depositIdr = Number(order.depositAppliedIdr);
  const remainingIdr = remainingToPayIdr({
    totalIdr: Number(order.totalIdr),
    depositAppliedIdr: depositIdr,
    capturedIdr: paidIdr,
  });
  const voucherDiscount = order.discounts.find(
    (discount) => discount.source === "voucher",
  );
  const lastCash = [...captured].reverse().find((t) => t.method === "cash");
  const lastTender = captured.at(-1);
  return {
    bill: {
      // The order detail has no table label or guest count yet (gap).
      tableLabel: order.number,
      orderNo: order.number,
      itemCount: order.items
        .filter((item) => item.status !== "voided")
        .reduce((sum, item) => sum + item.quantity, 0),
      guestCount: 0,
      subtotalIdr: Number(order.subtotalIdr),
      serviceIdr: Number(order.serviceChargeIdr),
      taxIdr: Number(order.taxIdr),
      totalIdr: Number(order.totalIdr),
      // The order detail has no reservation code (gap): the line shows "DP lunas".
      ...(depositIdr > 0
        ? { deposit: { amountIdr: depositIdr, paid: true } }
        : {}),
      depositSurplusIdr: 0,
      // The server priced it: `totalIdr` and `remainingIdr` already include it.
      ...(voucherDiscount
        ? {
            voucher: {
              code: voucherDiscount.voucherCode ?? "",
              discountIdr: Number(voucherDiscount.amountIdr),
            },
          }
        : {}),
      allocations: captured.map((tender) => ({
        id: tender.id,
        method:
          tender.method === "edc_card" || tender.method === "edc_qris"
            ? ("edc" as const)
            : tender.method,
        label: METHOD_LABELS[tender.method] ?? tender.method,
        amountIdr: Number(tender.amountIdr),
        status: "confirmed" as const,
        ...(tender.resolvedAt ? { confirmedAt: tender.resolvedAt } : {}),
        ...(tender.reference ? { reference: tender.reference } : {}),
      })),
      remainingIdr,
      paid: remainingIdr === 0,
    },
    activeAttempt:
      declinedEdcAttempt(order, captured, remainingIdr) ??
      voidedQrisAttempt(order, remainingIdr),
    ...(lastTender?.method === "cash" &&
    lastCash?.receivedIdr != null &&
    lastCash.changeIdr != null
      ? {
          cash: {
            receivedIdr: Number(lastCash.receivedIdr),
            changeIdr: Number(lastCash.changeIdr),
          },
        }
      : {}),
    ...(order.receipt ? { receiptNo: order.receipt.number } : {}),
  };
}

// ---- Payment ---------------------------------------------------------------

export function fetchPaymentSession(
  outletId: string,
  orderId: string,
  signal?: AbortSignal,
): Promise<PaymentSession> {
  // Mock orders use demo ids that are not ULIDs, so the mock reads the engine.
  if (API_MOCK) return runPosKasirMock((engine) => engine.session(orderId));
  return fetchPosOrder(outletId, orderId, signal).then(sessionFromOrder);
}

export const fetchPaymentMethods = (): Promise<PaymentMethodOption[]> =>
  local("metode pembayaran", (engine) => engine.paymentMethods());
export const fetchEdcTerminals = (): Promise<EdcTerminal[]> =>
  local("terminal EDC", (engine) => engine.edcTerminals());
export const fetchVaBanks = (): Promise<VaBank[]> =>
  local("bank Virtual Account", (engine) => engine.vaBanks());
export const fetchEwallets = (): Promise<Ewallet[]> =>
  local("dompet digital", (engine) => engine.ewallets());

export const startPayment = (
  input: StartPaymentInput,
): Promise<PaymentSession> =>
  local("pembayaran gateway/EDC", (engine) => engine.startPayment(input));

export const checkPaymentStatus = (ref: AttemptRef): Promise<PaymentSession> =>
  local("cek status pembayaran", (engine) => engine.checkStatus(ref));

// The mock waits ~2.5 s like a bank would, so the "memeriksa status dan
// memperbarui QRIS" state is visible before the new QRIS arrives.
export const MOCK_QRIS_REFRESH_MS = 2500;
export const refreshQris = (ref: AttemptRef): Promise<PaymentSession> =>
  local("QRIS baru", (engine) => engine.refreshQris(ref), MOCK_QRIS_REFRESH_MS);

export const cancelAttempt = (ref: AttemptRef): Promise<PaymentSession> =>
  local("batal pembayaran", (engine) => engine.cancelAttempt(ref));

export const recordEdcStandalone = (
  input: RecordEdcStandaloneInput,
): Promise<PaymentSession> =>
  local("EDC standalone", (engine) => engine.recordEdcStandalone(input));

export async function confirmCash(
  outletId: string,
  input: ConfirmCashInput,
  idempotencyKey: string,
): Promise<PaymentSession> {
  if (API_MOCK) return runPosKasirMock((engine) => engine.confirmCash(input));
  const before = await fetchPosOrder(outletId, input.orderId);
  const session = sessionFromOrder(before);
  // The tender body has no amount: the API applies min(received, remaining).
  if (input.amountIdr !== session.bill.remainingIdr)
    throw contractPending("tunai sebagian");
  await callEndpoint(addPosTender, {
    params: { outletId, orderId: input.orderId },
    body: {
      method: "cash",
      receivedIdr: input.receivedIdr,
      expectedStatus: before.status,
      idempotencyKey: `${idempotencyKey}:tender`,
    },
  });
  const after = await fetchPosOrder(outletId, input.orderId);
  if (after.status !== "completed")
    await callEndpoint(completePosOrder, {
      params: { outletId, orderId: input.orderId },
      body: {
        expectedStatus: after.status,
        idempotencyKey: `${idempotencyKey}:complete`,
      },
    });
  return sessionFromOrder(await fetchPosOrder(outletId, input.orderId));
}

export async function printReceipt(
  outletId: string,
  orderId: string,
  idempotencyKey: string,
): Promise<ReceiptResult> {
  if (API_MOCK)
    return runPosKasirMock((engine) => engine.printReceipt(orderId));
  // A bill the reservation DP settled alone never went through a tender, so
  // nothing completed the order and the API refuses a receipt for it
  // (legend-p7lx). Complete it first; the key keeps a retry from doing it twice.
  const order = await fetchPosOrder(outletId, orderId);
  if (
    (order.status === "awaiting_payment" || order.status === "sent") &&
    sessionFromOrder(order).bill.remainingIdr === 0
  )
    try {
      await callEndpoint(completePosOrder, {
        params: { outletId, orderId },
        body: {
          expectedStatus: order.status,
          idempotencyKey: `${idempotencyKey}:complete`,
        },
      });
    } catch (error) {
      // Distinct from a print failure: the order is still open, so the screen
      // must not offer to skip the receipt and move on.
      if (error instanceof ApiError)
        throw new ApiError(
          error.status,
          ORDER_COMPLETE_FAILED,
          error.message,
          error.details,
        );
      throw error;
    }
  const { data } = await callEndpoint(issuePosReceipt, {
    params: { outletId, orderId },
    body: {
      deliveries: ["print"],
      idempotencyKey,
    },
  });
  return {
    receiptNo: data.receipt.number,
    printedAt: data.receipt.issuedAt,
    reprint: data.receipt.reprintCount > 0,
  };
}

export const lookupCashierCode = (code: string): Promise<CashierCodeOrder> =>
  local("kode Bayar di kasir", (engine) => engine.lookupCode(code));

// ---- Voucher and member points (brief 936) ---------------------------------
// The server prices every discount and every redemption: these calls return
// what it says and the screens show it as is.

export async function validateVoucherCode(
  outletId: string,
  orderId: string,
  code: string,
): Promise<VoucherCheck> {
  if (API_MOCK)
    return runPosKasirMock((engine) => engine.validateVoucher(orderId, code));
  // The preview needs the order subtotal; the server prices the real discount
  // again when the voucher is applied.
  const order = await fetchPosOrder(outletId, orderId);
  const { data } = await callEndpoint(validateVoucher, {
    body: {
      code,
      subtotalIdr: Number(order.subtotalIdr),
      channel: "dine_in",
    },
  });
  return data.valid
    ? {
        valid: true,
        code,
        discountPreviewIdr: Number(data.discountPreviewIdr),
      }
    : { valid: false, code, reason: data.reason };
}

// Applying is a POS order discount (source "voucher", kind "amount"): the
// server prices it with the promo engine and caps it at the remaining bill.
export async function applyVoucherCode(
  outletId: string,
  orderId: string,
  code: string,
  idempotencyKey: string,
): Promise<PaymentSession> {
  if (API_MOCK)
    return runPosKasirMock((engine) =>
      engine.applyVoucher(orderId, code, idempotencyKey),
    );
  const { data } = await callEndpoint(applyPosDiscount, {
    params: { outletId, orderId },
    body: {
      source: "voucher",
      kind: "amount",
      voucherCode: code,
      reason: "promo_engine",
      idempotencyKey,
    },
  });
  return sessionFromOrder(data);
}

export async function removeVoucherCode(
  outletId: string,
  orderId: string,
  idempotencyKey: string,
): Promise<PaymentSession> {
  if (API_MOCK)
    return runPosKasirMock((engine) => engine.removeVoucher(orderId));
  const order = await fetchPosOrder(outletId, orderId);
  const voucher = order.discounts.find(
    (discount) => discount.source === "voucher",
  );
  // Already gone (a retry after the answer was lost): nothing left to remove.
  if (!voucher) return sessionFromOrder(order);
  const { data } = await callEndpoint(removePosDiscount, {
    params: { outletId, orderId, discountId: voucher.id },
    body: { idempotencyKey },
  });
  return sessionFromOrder(data);
}

export async function fetchPointsAccount(
  orderId: string,
): Promise<PointsAccount | null> {
  if (API_MOCK)
    return runPosKasirMock((engine) => engine.pointsAccount(orderId));
  const { data } = await callEndpoint(getPosOrderPoints, {
    params: { orderId },
  });
  return data.account;
}

export async function quotePointsValue(
  orderId: string,
  points: number,
): Promise<PointsQuote> {
  if (API_MOCK)
    return runPosKasirMock((engine) => engine.quotePoints(orderId, points));
  const { data } = await callEndpoint(quotePosOrderPoints, {
    params: { orderId },
    body: { points },
  });
  return { points: data.points, valueIdr: data.valueIdr };
}

/** Redeeming sends points only; the server prices them and answers the bill. */
export async function redeemPointsValue(
  orderId: string,
  points: number,
  idempotencyKey: string,
): Promise<PaymentSession> {
  if (API_MOCK)
    return runPosKasirMock((engine) =>
      engine.redeemPoints(orderId, points, idempotencyKey),
    );
  const { data } = await callEndpoint(redeemPosOrderPoints, {
    params: { orderId },
    body: { points, idempotencyKey },
  });
  return sessionFromOrder(data);
}
