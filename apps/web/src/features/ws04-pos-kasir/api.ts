// One function per POS kasir call; components never call these (they use the
// hooks in ./hooks.ts). Calls with a shared endpoint go through the typed
// client. Calls without a contract yet (see ./CONTRACT-GAPS.md) run on the mock
// engine in mock mode and fail with CONTRACT_PENDING everywhere else, so the
// screen shows a clear error instead of made-up data.
import {
  addPosTender,
  applyPosDiscount,
  cancelPosQris,
  completePosOrder,
  getPosApprovalPolicy,
  getPosOrder,
  getPosPaymentOptions,
  getPosQris,
  issuePosReceipt,
  posStandaloneEdcSchema,
  removePosDiscount,
  resolvePosPaymentIntent,
  type PosOrderDetail,
  type PosQrisStatus,
} from "@starter/shared/pos";
import {
  createPosOverride,
  listPosOverrideApprovers,
} from "@starter/shared/access/override";
import { validateVoucher } from "@starter/shared/crm";
import {
  getPosOrderPoints,
  quotePosOrderPoints,
  redeemPosOrderPoints,
} from "@starter/shared/pos/points";
import { actingStaffHeaderFor } from "@/lib/api/acting-staff";
import { callEndpoint } from "@/lib/api/endpoint";
import { ApiError, NETWORK_ERROR_MESSAGE } from "@/lib/api/errors";
import { API_MOCK } from "@/lib/api/mock-flag";
import { deviceTokenHeader } from "@/lib/device-token-store";
import { publicApiUrl } from "@/lib/env";
import { runPosKasirMock, type PosKasirEngine } from "./mock-engine";
import { remainingToPayIdr } from "./payment-due";
import {
  intentStorage,
  rawIntent,
  whileSending,
} from "./payment-intent-browser";
import {
  EDC_SLIP_AMOUNT_MISMATCH,
  EDC_SLIP_NOT_RECORDED,
  PAYMENT_UNRESOLVED,
  beginIntent,
  endIntent,
  isDefinitiveRefusal,
  markRefused,
  parseIntent,
  settleStored,
  type IntentKind,
  type IntentScope,
  type PaymentIntent,
} from "./payment-intent-store";
import {
  CONTRACT_PENDING,
  type AttemptRef,
  type CashierCodeOrder,
  type ConfirmCashInput,
  type EdcMode,
  type EdcTerminal,
  type Ewallet,
  type OrderCompletion,
  type OverrideResult,
  type PaymentAttempt,
  type PaymentMethodCode,
  type PaymentMethodOption,
  type PaymentSession,
  type PointsAccount,
  type PointsQuote,
  type ReceiptResult,
  type RecordEdcStandaloneInput,
  type ResolvePaymentInput,
  type StartPaymentInput,
  type SupervisorOption,
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

/** The QRIS hold is live: the provider may still take the customer's money. */
function liveQrisAttempt(
  order: PosOrderDetail,
  qris: PosQrisStatus | null,
): PaymentAttempt | null {
  if (!qris || (qris.state !== "open" && qris.state !== "cancelling"))
    return null;
  return {
    id: qris.tenderId ?? qris.id,
    sequence: sequenceOf(order, qris.tenderId),
    method: "qris",
    status: qris.state === "open" ? "waiting" : "cancelling",
    amountIdr: Number(qris.amountIdr),
    ...(qris.expiresAt ? { expiresAt: qris.expiresAt } : {}),
    qrShown: qris.qrPayload !== null,
    cancellable: qris.tenderId !== null && qris.state === "open",
  };
}

/** A QRIS the provider proved unpaid, while no later payment was started. */
function closedQrisAttempt(
  order: PosOrderDetail,
  qris: PosQrisStatus | null,
): PaymentAttempt | null {
  if (
    qris?.state !== "closed" ||
    (qris.closeReason !== "provider_expired" &&
      qris.closeReason !== "provider_failed")
  )
    return null;
  const latest = byRequest(order).at(-1);
  if (latest === undefined || latest.id !== qris.tenderId) return null;
  return {
    id: latest.id,
    sequence: order.tenders.length,
    method: "qris",
    status: qris.closeReason === "provider_expired" ? "expired" : "failed",
    amountIdr: Number(qris.amountIdr),
  };
}

/** An EDC request without a known result: the customer may be charged. */
function openEdcAttempt(order: PosOrderDetail): PaymentAttempt | null {
  const booked = new Set(order.tenders.map((t) => t.edcTransactionId));
  const open = order.edcAttempts.find(
    (a) =>
      a.status === "pending" ||
      a.status === "unknown" ||
      (a.status === "approved" && !booked.has(a.id)),
  );
  if (!open) return null;
  const amountIdr = Number(open.amountIdr);
  return {
    id: open.id,
    sequence: order.tenders.length + 1,
    method: "edc",
    status: open.status === "pending" ? "waiting" : "unknown",
    amountIdr,
    edc: {
      terminalId: open.terminalId,
      terminalLabel: open.terminalLabel ?? "",
      bank: open.bank ?? "",
      mode: open.method ?? "card",
      lockedAmountIdr: amountIdr,
    },
  };
}

/** A tender that is authorized only is not paid, and it locks the bill. */
function authorizedAttempt(order: PosOrderDetail): PaymentAttempt | null {
  const tender = byRequest(order).findLast((t) => t.status === "authorized");
  if (!tender) return null;
  const amountIdr = Number(tender.amountIdr);
  const base = {
    id: tender.id,
    sequence: sequenceOf(order, tender.id),
    amountIdr,
    cancellable: false,
  };
  switch (tender.method) {
    case "qris":
    case "va":
    case "ewallet":
    case "card":
      return {
        ...base,
        method: tender.method,
        status: "waiting",
        qrShown: false,
      };
    default:
      return {
        ...base,
        method: "edc",
        status: "unknown",
        edc: {
          terminalId: "",
          terminalLabel: METHOD_LABELS[tender.method] ?? tender.method,
          bank: "",
          mode: tender.method === "edc_qris" ? "qris" : "card",
          lockedAmountIdr: amountIdr,
        },
      };
  }
}

/** The bill's last payment was keyed by hand from a bank slip. */
function standaloneEdcAttempt(order: PosOrderDetail): PaymentAttempt | null {
  const last = byRequest(order).findLast((t) => t.status === "captured");
  const attempt = order.edcAttempts.find(
    (a) => a.id === last?.edcTransactionId && a.mode === "standalone",
  );
  if (!last || !attempt) return null;
  const amountIdr = Number(last.amountIdr);
  return {
    id: attempt.id,
    sequence: sequenceOf(order, last.id),
    method: "edc",
    status: "confirmed",
    amountIdr,
    edc: {
      terminalId: attempt.terminalId,
      terminalLabel: attempt.terminalLabel ?? "",
      bank: attempt.bank ?? "",
      mode: attempt.method ?? "card",
      lockedAmountIdr: amountIdr,
    },
    ...(last.reference ? { bankRef: last.reference } : {}),
    standalone: true,
  };
}

const byRequest = (order: PosOrderDetail) =>
  [...order.tenders].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));

function sequenceOf(order: PosOrderDetail, tenderId: string | null): number {
  const index = byRequest(order).findIndex((t) => t.id === tenderId);
  return index < 0 ? order.tenders.length + 1 : index + 1;
}

function completionOf(order: PosOrderDetail): OrderCompletion {
  if (order.status === "completed") return "done";
  if (
    order.items.some(
      (item) => item.status !== "voided" && item.fireStatus === "held",
    )
  )
    return "held";
  return order.status === "sent" ? "ready" : "blocked";
}

/**
 * `qris` is the bill's newest QRIS hold (null: never one, or the bill is paid).
 * Whatever may still take the customer's money comes before what is known to
 * have failed.
 */
function sessionFromOrder(
  order: PosOrderDetail,
  qris: PosQrisStatus | null = null,
): PaymentSession {
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
      remainingIdr === 0
        ? standaloneEdcAttempt(order)
        : (liveQrisAttempt(order, qris) ??
          openEdcAttempt(order) ??
          authorizedAttempt(order) ??
          declinedEdcAttempt(order, captured, remainingIdr) ??
          voidedQrisAttempt(order, remainingIdr) ??
          closedQrisAttempt(order, qris)),
    partialAllowed: false,
    ...(remainingIdr === 0 ? { completion: completionOf(order) } : {}),
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

/** The bill's newest QRIS hold; null when it never had one. */
async function fetchQris(
  outletId: string,
  orderId: string,
  signal?: AbortSignal,
): Promise<PosQrisStatus | null> {
  try {
    const { data } = await callEndpoint(
      getPosQris,
      { params: { outletId, orderId } },
      { signal },
    );
    return data;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * The bill holds money of this very EDC slip. A bank reference is not unique,
 * so the terminal and the amount must be known and the same: in doubt it is
 * another slip and the warning stays.
 */
const hasCapturedSlip = (
  order: PosOrderDetail,
  slip: Record<string, unknown> | undefined,
  amountIdr: number | undefined,
): boolean =>
  order.tenders.some((t) => {
    const row = order.edcAttempts.find((a) => a.id === t.edcTransactionId);
    return (
      t.status === "captured" &&
      (t.method === "edc_card" || t.method === "edc_qris") &&
      t.reference !== null &&
      t.reference === slip?.bankRef &&
      row !== undefined &&
      row.terminalId === slip.terminalId &&
      Number(t.amountIdr) === amountIdr
    );
  });

const slipOf = (intent: PaymentIntent) =>
  intent.body.standalone as Record<string, unknown> | undefined;

/**
 * A paid bill takes no other payment: the stored request is settled. Not so for
 * an EDC slip the bill was not paid with, nor for a request that cannot be read
 * and may have been one: that card may be charged and needs a void on the
 * machine, so it stays until a supervisor closes it.
 */
function forgetPaidIntent(outletId: string, order: PosOrderDetail): void {
  const scope = scopeOf(outletId, order.id, "payment");
  const raw = rawIntent(scope);
  const state = parseIntent(raw);
  if (raw === null || state.status !== "pending") return;
  const { intent } = state;
  if (
    intent.kind === "edc_standalone" &&
    !hasCapturedSlip(order, slipOf(intent), intent.amountIdr)
  )
    return;
  try {
    settleStored(intentStorage(), scope, raw);
  } catch {
    // Blocked storage (or the server render): there is no note to forget.
  }
}

/** An order read plus its QRIS hold, which can lock an unpaid bill. */
async function sessionOfOrder(
  outletId: string,
  order: PosOrderDetail,
  signal?: AbortSignal,
): Promise<PaymentSession> {
  const session = sessionFromOrder(order);
  if (session.bill.paid) {
    forgetPaidIntent(outletId, order);
    return session;
  }
  return sessionFromOrder(order, await fetchQris(outletId, order.id, signal));
}

/** After a write succeeded: a failed re-read must not look like a failed write. */
async function sessionAfterWrite(
  outletId: string,
  order: PosOrderDetail,
): Promise<PaymentSession> {
  try {
    return await sessionOfOrder(outletId, order);
  } catch {
    return sessionFromOrder(order);
  }
}

// ---- Payment ---------------------------------------------------------------

export function fetchPaymentSession(
  outletId: string,
  orderId: string,
  signal?: AbortSignal,
): Promise<PaymentSession> {
  // Mock orders use demo ids that are not ULIDs, so the mock reads the engine.
  if (API_MOCK) return runPosKasirMock((engine) => engine.session(orderId));
  return fetchPosOrder(outletId, orderId, signal).then((order) =>
    sessionOfOrder(outletId, order, signal),
  );
}

async function fetchPaymentOptions(outletId: string) {
  const { data } = await callEndpoint(getPosPaymentOptions, {
    params: { outletId },
  });
  return data;
}

/** The grid order of the old screen; EDC is one tile for card and QRIS. */
const GRID_METHODS = [
  { code: "qris", from: ["qris"] },
  { code: "va", from: ["va"] },
  { code: "ewallet", from: ["ewallet"] },
  { code: "card", from: ["card"] },
  { code: "cash", from: ["cash"] },
  { code: "edc", from: ["edc_card", "edc_qris"] },
] as const satisfies readonly {
  code: PaymentMethodCode;
  from: readonly string[];
}[];

/** Methods this screen can really take; the rest stay locked. */
const WIRED_METHODS: readonly PaymentMethodCode[] = ["qris", "cash", "edc"];

export async function fetchPaymentMethods(
  outletId: string,
): Promise<PaymentMethodOption[]> {
  if (API_MOCK) return runPosKasirMock((engine) => engine.paymentMethods());
  const options = await fetchPaymentOptions(outletId);
  return GRID_METHODS.flatMap(({ code, from }) => {
    const rows = options.methods.filter((row) =>
      (from as readonly string[]).includes(row.method),
    );
    if (rows.length === 0) return [];
    const wired = WIRED_METHODS.includes(code);
    const enabled = wired && rows.some((row) => row.enabled);
    const reason = wired ? rows[0]?.unavailableReason : "not_supported";
    return [
      {
        code,
        label: code === "edc" ? "EDC" : (METHOD_LABELS[code] ?? code),
        hint: "",
        enabled,
        ...(!enabled
          ? { unavailableReason: reason ?? ("not_supported" as const) }
          : {}),
      },
    ];
  });
}

export async function fetchEdcTerminals(
  outletId: string,
): Promise<EdcTerminal[]> {
  if (API_MOCK) return runPosKasirMock((engine) => engine.edcTerminals());
  const { edc } = await fetchPaymentOptions(outletId);
  return edc.terminals.map((terminal) => ({
    id: terminal.id,
    label: `${terminal.bankCode.toUpperCase()} · ${terminal.model}`,
    bank: terminal.bankCode.toUpperCase(),
    // No route sends an amount to a machine yet, whatever the server says.
    integrated: false,
    status: "ready" as const,
    assignedTo: `•••• ${terminal.terminalIdLast4}`,
    modes: terminal.supportedMethods,
  }));
}

export const fetchVaBanks = (): Promise<VaBank[]> =>
  local("bank Virtual Account", (engine) => engine.vaBanks());
export const fetchEwallets = (): Promise<Ewallet[]> =>
  local("dompet digital", (engine) => engine.ewallets());

// ---- Payment requests (1268 W2) ----------------------------------------------
// Every request that takes money is stored with its key and its exact body
// before it is sent (./payment-intent-store.ts) and kept until its answer is
// known. The same tap, a refresh or a second tab then repeats those bytes.

const scopeOf = (
  outletId: string,
  orderId: string,
  slot: IntentScope["slot"],
): IntentScope => ({ outletId, orderId, slot });

/** Refuse a change of a bill whose last payment request has no known answer. */
export function assertPaymentResolved(outletId: string, orderId: string): void {
  if (
    parseIntent(rawIntent(scopeOf(outletId, orderId, "payment"))).status !==
    "none"
  )
    throw new ApiError(
      409,
      PAYMENT_UNRESOLVED,
      "Hasil pembayaran sebelumnya belum diketahui. Kirim ulang permintaan yang sama dulu.",
    );
}

/** Send a stored request; it is forgotten only once its answer is known. */
async function settleIntent<T>(
  scope: IntentScope,
  { intent, replay }: { intent: PaymentIntent; replay: boolean },
  send: (body: never) => Promise<T>,
): Promise<T> {
  const storage = intentStorage();
  return whileSending(scope, async () => {
    try {
      const result = await send(intent.body as never);
      endIntent(storage, scope, intent.key);
      return result;
    } catch (error) {
      if (isDefinitiveRefusal(intent.kind, error, replay)) {
        endIntent(storage, scope, intent.key);
        markRefused(error as ApiError);
      }
      throw error;
    }
  });
}

/** The order as the server answered the stored payment request. */
function sendPayment(
  scope: IntentScope,
  begun: { intent: PaymentIntent; replay: boolean },
): Promise<PosOrderDetail> {
  const { outletId, orderId } = scope;
  return settleIntent(scope, begun, async (body) => {
    if (begun.intent.kind === "points") {
      const { data } = await callEndpoint(redeemPosOrderPoints, {
        params: { orderId },
        body,
      });
      return data;
    }
    const { data } = await callEndpoint(addPosTender, {
      params: { outletId, orderId },
      body,
    });
    return data.order;
  });
}

type TenderBody = Record<string, unknown>;

const edcTenderMethod = (mode: EdcMode) =>
  mode === "qris" ? "edc_qris" : "edc_card";

/** A body the contract refuses must not be stored as a payment in progress. */
function tenderBody(body: TenderBody): TenderBody {
  const parsed = addPosTender.body.safeParse(body);
  if (!parsed.success)
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      parsed.error.issues[0]?.message ?? "Data pembayaran tidak valid.",
    );
  return body;
}

type PaymentAsk = {
  kind: IntentKind;
  signature: string;
  /** EDC standalone: what the slip says was charged. */
  amountIdr?: number;
  /** Reads the bill and builds the body; skipped when a request is stored. */
  prepare: () => Promise<(key: string) => Record<string, unknown>>;
};

async function pay(
  outletId: string,
  orderId: string,
  actorId: string,
  ask: PaymentAsk,
): Promise<PosOrderDetail> {
  const scope = scopeOf(outletId, orderId, "payment");
  // Sending from the tap: the other panels lock before the bill is even read.
  return whileSending(scope, () => payScoped(scope, actorId, ask));
}

async function payScoped(
  scope: IntentScope,
  actorId: string,
  ask: PaymentAsk,
): Promise<PosOrderDetail> {
  const storage = intentStorage();
  const stored = parseIntent(rawIntent(scope)).status !== "none";
  // A stored request must not be checked against the bill first: after a lost
  // answer the bill is already paid, and the repeat is what proves it.
  const makeBody = stored
    ? () => {
        throw new ApiError(
          409,
          PAYMENT_UNRESOLVED,
          "Permintaan pembayaran berubah di tab lain. Muat ulang tagihan.",
        );
      }
    : await ask.prepare();
  const begun = beginIntent(storage, scope, {
    kind: ask.kind,
    signature: ask.signature,
    actorId,
    amountIdr: ask.amountIdr,
    makeKey: () => `${ask.kind}:${globalThis.crypto.randomUUID()}`,
    makeBody,
    now: () => new Date(),
  });
  return sendPayment(scope, begun);
}

/** The cashier's own tap: send the unresolved request again, byte for byte. */
export async function replayPayment(
  outletId: string,
  orderId: string,
  actorId: string,
): Promise<PaymentSession> {
  const scope = scopeOf(outletId, orderId, "payment");
  const state = parseIntent(rawIntent(scope));
  if (state.status === "none") return fetchPaymentSession(outletId, orderId);
  const begun = beginIntent(intentStorage(), scope, {
    kind: state.status === "pending" ? state.intent.kind : "cash",
    signature: state.status === "pending" ? state.intent.signature : "",
    actorId,
    makeKey: () => "",
    makeBody: () => {
      throw new ApiError(409, PAYMENT_UNRESOLVED, "Muat ulang tagihan.");
    },
    now: () => new Date(),
  });
  return sessionAfterWrite(outletId, await sendPayment(scope, begun));
}

/** Supervisors who may settle a payment request without a known answer. */
export async function fetchResolveApprovers(
  outletId: string,
  action: "void" | "edc_standalone",
): Promise<SupervisorOption[]> {
  if (API_MOCK) return runPosKasirMock((engine) => engine.supervisors());
  const { data } = await callEndpoint(listPosOverrideApprovers, {
    query: { outletId, action },
  });
  return data.map((row) => ({ userId: row.userId, name: row.displayName }));
}

/**
 * A supervisor settles the unresolved request with their PIN. The server reads
 * what it recorded or makes sure it never can be; until it answers, the bill
 * stays locked. `recording`: the card was charged, so the slip (of the stored
 * request, or typed when that cannot be read) is recorded under a new key and a
 * new approval, and that request takes the stored one's place without opening
 * the bill.
 */
export async function resolvePayment(
  outletId: string,
  actorId: string,
  input: ResolvePaymentInput,
): Promise<PaymentSession> {
  if (API_MOCK) throw contractPending("penyelesaian pembayaran");
  const { orderId, card, voidRef, reason, approverUserId, pin } = input;
  const scope = scopeOf(outletId, orderId, "payment");
  const raw = rawIntent(scope);
  const state = parseIntent(raw);
  if (raw === null || state.status === "none")
    return fetchPaymentSession(outletId, orderId);
  const stored = state.status === "pending" ? state.intent : null;
  if (stored?.kind === "edc_standalone") {
    // This very slip may be recorded by now: then there is nothing to settle.
    const order = await fetchPosOrder(outletId, orderId);
    if (sessionFromOrder(order).bill.paid) forgetPaidIntent(outletId, order);
    if (rawIntent(scope) === null) return sessionAfterWrite(outletId, order);
  }
  const slip =
    card === "recording" ? await newSlipRequest(scope, stored, input) : null;
  // Named when the card was charged: the server never voids a recorded slip.
  const bankRef =
    card === "voided" || card === "recording"
      ? (slip?.standalone.bankRef ??
        (stored ? slipOf(stored)?.bankRef : input.bankRef))
      : undefined;
  const { data } = await callEndpoint(resolvePosPaymentIntent, {
    params: { outletId, orderId },
    body: {
      key: stored?.key ?? null,
      ...(card ? { card } : {}),
      ...(voidRef === undefined ? {} : { voidRef }),
      ...(typeof bankRef === "string" ? { bankRef } : {}),
      reason,
      approverUserId,
      pin,
    },
  });
  const storage = intentStorage();
  if (slip === null || data.outcome === "recorded") {
    // Without a key "recorded" only says the bill is paid, not with this slip.
    if (
      slip &&
      !stored &&
      !hasCapturedSlip(data.order, slip.standalone, slip.amountIdr)
    )
      throw slipNotRecorded();
    settleStored(storage, scope, raw);
    return sessionAfterWrite(outletId, data.order);
  }
  // The slip was on a paid bill a moment ago and is not now: nothing to record.
  if (slip.body === null) throw slipNotRecorded();
  const key = `edc_standalone:${globalThis.crypto.randomUUID()}`;
  const intent: PaymentIntent = {
    kind: "edc_standalone",
    signature: slip.signature,
    amountIdr: slip.amountIdr,
    key,
    body: tenderBody({
      ...slip.body,
      expectedStatus: data.order.status,
      expectedVersion: data.order.version,
      idempotencyKey: key,
    }),
    actorId,
    startedAt: new Date().toISOString(),
  };
  if (!settleStored(storage, scope, raw, intent))
    return fetchPaymentSession(outletId, orderId);
  return sessionAfterWrite(
    outletId,
    await sendPayment(scope, { intent, replay: false }),
  );
}

type ChargedSlip = {
  amountIdr: number | undefined;
  method: unknown;
  standalone: Record<string, unknown>;
};

/** The slip of the stored request, as it is; typed only when unreadable. */
function chargedSlip(
  stored: PaymentIntent | null,
  typed: ResolvePaymentInput["slip"],
): ChargedSlip {
  const standalone = stored ? slipOf(stored) : undefined;
  if (stored?.kind === "edc_standalone" && standalone)
    return {
      amountIdr: stored.amountIdr,
      method: stored.body.method,
      standalone,
    };
  if (!stored && typed)
    return {
      amountIdr: typed.amountIdr,
      method: edcTenderMethod(typed.edcMode),
      standalone: {
        terminalId: typed.terminalId,
        bankRef: typed.bankRef,
        ...(typed.approvalCode ? { approvalCode: typed.approvalCode } : {}),
      },
    };
  throw new ApiError(
    409,
    PAYMENT_UNRESOLVED,
    "Data slip EDC tidak bisa dibaca, jadi pembayarannya tidak bisa dicatat dari sini.",
  );
}

const slipNotRecorded = () =>
  new ApiError(
    409,
    EDC_SLIP_NOT_RECORDED,
    "Slip ini tidak cocok dengan pembayaran EDC di tagihan. Cocokkan slip dulu; jangan void bila sudah tercatat.",
  );

/**
 * The charged slip with a new supervisor approval of exactly its amount. No
 * approval and no body when it already paid the bill: it is only closed.
 */
async function newSlipRequest(
  { outletId, orderId }: IntentScope,
  stored: PaymentIntent | null,
  input: ResolvePaymentInput,
) {
  const { amountIdr, method, standalone } = chargedSlip(stored, input.slip);
  const valid = posStandaloneEdcSchema
    .partial({ overrideId: true })
    .safeParse(standalone);
  if (!valid.success)
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      valid.error.issues[0]?.message ?? "Data slip EDC tidak valid.",
    );
  const order = await fetchPosOrder(outletId, orderId);
  // A slip is recorded for what it charged: never for another amount.
  const { remainingIdr, paid } = sessionFromOrder(order).bill;
  if (!stored && paid) {
    if (!hasCapturedSlip(order, standalone, amountIdr)) throw slipNotRecorded();
    return { amountIdr, standalone, signature: "", body: null };
  }
  if (amountIdr !== remainingIdr || amountIdr <= 0)
    throw new ApiError(
      409,
      EDC_SLIP_AMOUNT_MISMATCH,
      "Nominal slip EDC berbeda dari sisa tagihan. Cocokkan slip dulu; jangan void bila sudah tercatat.",
    );
  const { overrideId } = await requestEdcApproval(outletId, {
    orderId,
    amountIdr,
    reason: input.reason,
    approverUserId: input.approverUserId,
    pin: input.pin,
  });
  return {
    amountIdr,
    standalone,
    signature: `resolved:${overrideId}`,
    body: { method, standalone: { ...standalone, overrideId } },
  };
}

/** Complete a paid order; held items or an unsent order are never forced. */
async function completePaid(
  outletId: string,
  actorId: string,
  order: PosOrderDetail,
): Promise<PosOrderDetail> {
  const scope = scopeOf(outletId, order.id, "complete");
  const begun = beginIntent(intentStorage(), scope, {
    kind: "complete",
    signature: `complete:${order.status}`,
    actorId,
    makeKey: () => `complete:${globalThis.crypto.randomUUID()}`,
    makeBody: (idempotencyKey) => ({
      expectedStatus: order.status,
      expectedVersion: order.version,
      idempotencyKey,
    }),
    now: () => new Date(),
  });
  await settleIntent(scope, begun, (body) =>
    callEndpoint(completePosOrder, {
      params: { outletId, orderId: order.id },
      body,
    }),
  );
  return fetchPosOrder(outletId, order.id);
}

/** Complete a paid order when the server would take it; otherwise as it is. */
export async function completePaidOrder(
  outletId: string,
  orderId: string,
  actorId: string,
): Promise<PaymentSession> {
  const order = await fetchPosOrder(outletId, orderId);
  if (sessionFromOrder(order).completion !== "ready")
    return sessionOfOrder(outletId, order);
  return sessionFromOrder(await completePaid(outletId, actorId, order));
}

export async function startPayment(
  outletId: string,
  actorId: string,
  input: StartPaymentInput,
): Promise<PaymentSession> {
  if (API_MOCK) return runPosKasirMock((engine) => engine.startPayment(input));
  if (input.method !== "qris") throw contractPending("pembayaran gateway/EDC");
  const order = await pay(outletId, input.orderId, actorId, {
    kind: "qris",
    signature: "qris",
    prepare: async () => {
      const before = await fetchPosOrder(outletId, input.orderId);
      if (input.amountIdr !== sessionFromOrder(before).bill.remainingIdr)
        throw contractPending("QRIS sebagian");
      return (idempotencyKey) =>
        tenderBody({
          method: "qris",
          expectedStatus: before.status,
          expectedVersion: before.version,
          idempotencyKey,
        });
    },
  });
  return sessionAfterWrite(outletId, order);
}

/** Real mode: the server asks the provider; the screen reads the bill again. */
export function checkPaymentStatus(
  outletId: string,
  ref: AttemptRef,
): Promise<PaymentSession> {
  if (API_MOCK) return runPosKasirMock((engine) => engine.checkStatus(ref));
  return fetchPaymentSession(outletId, ref.orderId);
}

/**
 * Hides the QR. The bill stays locked (`cancelling`) until the provider proves
 * the code can no longer be paid; a repeat returns the hold as it is.
 */
export async function cancelAttempt(
  outletId: string,
  ref: AttemptRef & { method: PaymentMethodCode },
): Promise<PaymentSession> {
  if (API_MOCK) return runPosKasirMock((engine) => engine.cancelAttempt(ref));
  if (ref.method !== "qris") throw contractPending("batal pembayaran");
  await callEndpoint(cancelPosQris, {
    params: { outletId, orderId: ref.orderId },
    body: { idempotencyKey: `qris-cancel:${globalThis.crypto.randomUUID()}` },
  });
  return fetchPaymentSession(outletId, ref.orderId);
}

export async function fetchEdcApprovers(
  outletId: string,
): Promise<SupervisorOption[]> {
  if (API_MOCK) return runPosKasirMock((engine) => engine.supervisors());
  const { data } = await callEndpoint(listPosOverrideApprovers, {
    query: { outletId, action: "edc_standalone" },
  });
  return data.map((row) => ({ userId: row.userId, name: row.displayName }));
}

/** A supervisor's PIN for one hand-keyed EDC payment of exactly this amount. */
export async function requestEdcApproval(
  outletId: string,
  input: {
    orderId: string;
    amountIdr: number;
    reason: string;
    approverUserId: string;
    pin: string;
  },
): Promise<OverrideResult> {
  const { orderId, amountIdr, reason, approverUserId, pin } = input;
  if (API_MOCK)
    return runPosKasirMock((engine) =>
      engine.requestOverride({
        action: "edc_standalone",
        valueIdr: amountIdr,
        reason,
        objectType: "pos_order",
        objectId: orderId,
        approverUserId,
        pin,
      }),
    );
  const { data } = await callEndpoint(createPosOverride, {
    body: {
      outletId,
      action: "edc_standalone",
      valueIdr: amountIdr,
      reason,
      objectType: "pos_order",
      objectId: orderId,
      approval: { method: "supervisor_pin", approverUserId, pin },
    },
  });
  return { overrideId: data.id, approvedByName: "" };
}

export async function recordEdcStandalone(
  outletId: string,
  actorId: string,
  input: RecordEdcStandaloneInput,
): Promise<PaymentSession> {
  if (API_MOCK)
    return runPosKasirMock((engine) => engine.recordEdcStandalone(input));
  const { orderId, terminalId, bankRef, approvalCode, overrideId } = input;
  const order = await pay(outletId, orderId, actorId, {
    kind: "edc_standalone",
    signature: [
      "edc",
      input.edcMode,
      terminalId,
      bankRef,
      approvalCode ?? "",
      overrideId,
    ].join(":"),
    amountIdr: input.amountIdr,
    prepare: async () => {
      const before = await fetchPosOrder(outletId, orderId);
      // The supervisor approved one amount: refuse to record a different one.
      if (input.amountIdr !== sessionFromOrder(before).bill.remainingIdr)
        throw new ApiError(
          403,
          "OVERRIDE_INVALID",
          "Sisa tagihan berubah sejak persetujuan. Minta persetujuan ulang.",
        );
      return (idempotencyKey) =>
        tenderBody({
          method: edcTenderMethod(input.edcMode),
          standalone: {
            terminalId,
            bankRef,
            ...(approvalCode ? { approvalCode } : {}),
            overrideId,
          },
          expectedStatus: before.status,
          expectedVersion: before.version,
          idempotencyKey,
        });
    },
  });
  return sessionAfterWrite(outletId, order);
}

export async function confirmCash(
  outletId: string,
  actorId: string,
  input: ConfirmCashInput,
): Promise<PaymentSession> {
  if (API_MOCK) return runPosKasirMock((engine) => engine.confirmCash(input));
  const order = await pay(outletId, input.orderId, actorId, {
    kind: "cash",
    signature: `cash:${input.receivedIdr}`,
    prepare: async () => {
      const before = await fetchPosOrder(outletId, input.orderId);
      // The tender body has no amount: the API applies min(received, remaining).
      if (input.amountIdr !== sessionFromOrder(before).bill.remainingIdr)
        throw contractPending("tunai sebagian");
      return (idempotencyKey) =>
        tenderBody({
          method: "cash",
          receivedIdr: input.receivedIdr,
          expectedStatus: before.status,
          expectedVersion: before.version,
          idempotencyKey,
        });
    },
  });
  return sessionAfterWrite(outletId, order);
}

const completeFailed = (error: ApiError) =>
  new ApiError(
    error.status,
    ORDER_COMPLETE_FAILED,
    error.message,
    error.details,
  );

export async function printReceipt(
  outletId: string,
  orderId: string,
  actorId: string,
): Promise<ReceiptResult> {
  if (API_MOCK)
    return runPosKasirMock((engine) => engine.printReceipt(orderId));
  // The API refuses a receipt for an order that is still open. Distinct from a
  // print failure: the screen must not offer to skip the receipt and move on.
  const order = await fetchPosOrder(outletId, orderId);
  const { completion } = sessionFromOrder(order);
  if (completion === "ready")
    try {
      await completePaid(outletId, actorId, order);
    } catch (error) {
      if (error instanceof ApiError) throw completeFailed(error);
      throw error;
    }
  else if (completion === "held" || completion === "blocked")
    throw completeFailed(
      new ApiError(
        409,
        ORDER_COMPLETE_FAILED,
        "Pesanan masih terbuka. Kirim dulu semua item, lalu cetak struk.",
      ),
    );
  const scope = scopeOf(outletId, orderId, "receipt");
  const begun = beginIntent(intentStorage(), scope, {
    kind: "receipt",
    signature: "print",
    actorId,
    makeKey: () => `receipt:${globalThis.crypto.randomUUID()}`,
    makeBody: (idempotencyKey) => ({ deliveries: ["print"], idempotencyKey }),
    now: () => new Date(),
  });
  const { data } = await settleIntent(scope, begun, (body) =>
    callEndpoint(issuePosReceipt, { params: { outletId, orderId }, body }),
  );
  return {
    receiptNo: data.receipt.number,
    printedAt: data.receipt.issuedAt,
    reprint: data.receipt.reprintCount > 0,
    receiptId: data.receipt.id,
    printResult: data.printResult,
  };
}

/** The receipt as a PDF file: the way out when nothing was printed. */
export async function fetchReceiptPdf(
  outletId: string,
  receiptId: string,
): Promise<Blob> {
  if (API_MOCK) throw contractPending("PDF struk");
  const path = `/api/outlets/${encodeURIComponent(outletId)}/pos/receipts/${encodeURIComponent(receiptId)}/pdf`;
  let response: Response;
  try {
    response = await fetch(`${publicApiUrl(path)}?kind=receipt`, {
      credentials: "include",
      headers: { ...actingStaffHeaderFor(path), ...deviceTokenHeader() },
    });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", NETWORK_ERROR_MESSAGE);
  }
  if (!response.ok)
    throw new ApiError(
      response.status,
      "HTTP_ERROR",
      `Request failed with status ${response.status}.`,
    );
  return response.blob();
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
  assertPaymentResolved(outletId, orderId);
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
  return sessionAfterWrite(outletId, data);
}

export async function removeVoucherCode(
  outletId: string,
  orderId: string,
  idempotencyKey: string,
): Promise<PaymentSession> {
  if (API_MOCK)
    return runPosKasirMock((engine) => engine.removeVoucher(orderId));
  assertPaymentResolved(outletId, orderId);
  const order = await fetchPosOrder(outletId, orderId);
  const voucher = order.discounts.find(
    (discount) => discount.source === "voucher",
  );
  // Already gone (a retry after the answer was lost): nothing left to remove.
  if (!voucher) return sessionOfOrder(outletId, order);
  const { data } = await callEndpoint(removePosDiscount, {
    params: { outletId, orderId, discountId: voucher.id },
    body: { idempotencyKey },
  });
  return sessionAfterWrite(outletId, data);
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
  outletId: string,
  orderId: string,
  actorId: string,
  points: number,
  mockKey: string,
): Promise<PaymentSession> {
  if (API_MOCK)
    return runPosKasirMock((engine) =>
      engine.redeemPoints(orderId, points, mockKey),
    );
  const order = await pay(outletId, orderId, actorId, {
    kind: "points",
    signature: `points:${points}`,
    prepare: async () => {
      const { version } = await fetchPosOrder(outletId, orderId);
      return (idempotencyKey) => ({
        points,
        expectedVersion: version,
        idempotencyKey,
      });
    },
  });
  return sessionAfterWrite(outletId, order);
}
