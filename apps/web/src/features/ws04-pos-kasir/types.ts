// View-model types for the POS kasir screens (bead legend-mjmm). Screens read
// these through ./hooks.ts only. Rupiah are whole numbers; dates are ISO
// strings. Types marked DEMO-CONTRACT have no shared endpoint yet (see
// ./CONTRACT-GAPS.md); they are local until the contract lands.
//
// Plain TypeScript with no runtime imports (type imports only): Node tests load
// it directly.
import type { VoucherRejectionReason } from "@starter/shared/crm";
import type { PosPaymentUnavailableReason } from "@starter/shared/pos";

/**
 * One EDC request of a bill as `getPosOrder` lists it (`edcAttempts`, newest
 * first). A declined one carries `declineReason` and `responseCode` and never
 * puts a tender on the bill.
 */
export type { PosEdcAttempt } from "@starter/shared/pos";

import type { TenderVoidReason } from "./tender-void-reason";

/** Error code a hook returns outside mock mode when the contract is missing. */
export const CONTRACT_PENDING = "CONTRACT_PENDING";

/** Display form of a printed reference: "LG-0044" is shown as "LG–0044". */
export function formatReference(value: string): string {
  return value.replace("-", "–");
}

// ---- Payment ---------------------------------------------------------------

export type PaymentMethodCode =
  "qris" | "va" | "ewallet" | "card" | "cash" | "edc";

/** One active payment method of the outlet. The label and hint come from data. */
export type PaymentMethodOption = {
  code: PaymentMethodCode;
  label: string;
  /** "" when the screen words it itself (see `unavailableReason`). */
  hint: string;
  enabled: boolean;
  /** Why the server locks this method; absent when it is usable or in mock. */
  unavailableReason?: PosPaymentUnavailableReason;
};

export type AllocationStatus = "confirmed" | "waiting" | "failed";

/** A payment on the bill: the six methods, or loyalty points. */
export type AllocationMethod = PaymentMethodCode | "points";

/** A payment that already counts against the bill (DP is `bill.deposit`). */
export type PaymentAllocation = {
  id: string;
  method: AllocationMethod;
  label: string;
  amountIdr: number;
  status: AllocationStatus;
  confirmedAt?: string;
  /** Bank / gateway reference when there is one. */
  reference?: string;
};

export type PaymentBill = {
  tableLabel: string;
  orderNo: string;
  itemCount: number;
  guestCount: number;
  subtotalIdr: number;
  serviceIdr: number;
  taxIdr: number;
  totalIdr: number;
  /** DEMO-CONTRACT: reservation deposit applied to this bill. */
  deposit?: {
    /** Reservation code; the order detail does not carry it yet (gap). */
    reference?: string;
    /** The part of the deposit used on this bill (never above the total). */
    amountIdr: number;
    paid: boolean;
  };
  /** Deposit above the bill: becomes customer balance (founder Q7). */
  depositSurplusIdr: number;
  /**
   * The voucher on this bill (brief 936), read from `order.discounts`. The
   * server priced the discount: `totalIdr` and `remainingIdr` already include
   * it. `code` is the server's `voucherCode` ("" when the line has none).
   */
  voucher?: { code: string; discountIdr: number } | null;
  allocations: PaymentAllocation[];
  remainingIdr: number;
  paid: boolean;
};

/**
 * `declined`: the bank or terminal refused the payment (not a technical
 * `failed`, and not `unknown`, where the result is not known yet).
 * `cancelling`: the cashier hid the QRIS and the provider has not yet proven it
 * can no longer be paid, so the bill stays locked.
 */
export type AttemptStatus =
  | "waiting"
  | "cancelling"
  | "expired"
  | "failed"
  | "confirmed"
  | "unknown"
  | "declined";

export type EdcMode = "card" | "qris";

// ---- Voucher and member points (brief 936) ---------------------------------

/**
 * The preview of one voucher code. The discount is the server's estimate; the
 * server prices it again when the voucher is applied to the bill.
 */
export type VoucherCheck =
  | { valid: true; code: string; discountPreviewIdr: number }
  | { valid: false; code: string; reason: VoucherRejectionReason };

/** The member on the order and what they may spend now (server-computed). */
export type PointsAccount = {
  memberId: string;
  memberName: string;
  balancePoints: number;
  minRedeemPoints: number;
  /** min(balance, remaining bill): the server decides, the screen never does. */
  maxRedeemPoints: number;
};

/** What the server says a number of points is worth on this bill. */
export type PointsQuote = { points: number; valueIdr: number };

export type PaymentAttempt = {
  id: string;
  /** "Pembayaran 01": position among this bill's payments. */
  sequence: number;
  method: PaymentMethodCode;
  status: AttemptStatus;
  amountIdr: number;
  expiresAt?: string;
  va?: { bank: string; number: string; deadline: string };
  ewallet?: { code: string; label: string };
  edc?: {
    terminalId: string;
    terminalLabel: string;
    bank: string;
    mode: EdcMode;
    lockedAmountIdr: number;
    /** Server message for a declined payment, e.g. "Saldo tidak cukup". */
    declineReason?: string;
    /** Bank response code for a declined payment, e.g. "51". */
    responseCode?: string;
  };
  /** Masked card, e.g. "Kartu debit · •••• 4821". */
  cardMasked?: string;
  bankRef?: string;
  approvalCode?: string;
  /** POS reference sent to the terminal, e.g. "POS-0048-01". */
  posRef?: string;
  /** Recorded by hand from a bank slip: needs reconciliation. */
  standalone?: boolean;
  /**
   * Set when the server voided this QRIS tender and refunded the money (legend-7e8kx):
   * why, so the cashier text names the real cause. Absent otherwise.
   */
  voidReason?: TenderVoidReason;
  /** False: the server gave no QR to show for this waiting QRIS. */
  qrShown?: boolean;
  /** False: this QRIS belongs to a guest split bill and is not ours to cancel. */
  cancellable?: boolean;
};

/**
 * A paid order still has to be completed, and the server refuses that while an
 * item is held (`held`) or the order was not sent (`blocked`).
 */
export type OrderCompletion = "done" | "ready" | "held" | "blocked";

export type PaymentSession = {
  bill: PaymentBill;
  /**
   * The latest attempt. A confirmed attempt appears only once the bill is paid
   * (it is the last tender's attempt); before that it is an allocation and
   * `activeAttempt` is null so the screen goes back to the split view.
   */
  activeAttempt: PaymentAttempt | null;
  /** The last cash tender: what the customer handed over and the change. */
  cash?: { receivedIdr: number; changeIdr: number };
  receiptNo?: string;
  /** Paid bills only, from the server's order; absent in mock mode. */
  completion?: OrderCompletion;
  /** The server settles the whole remaining balance: no partial amounts. */
  partialAllowed?: boolean;
};

export type StartPaymentInput = {
  orderId: string;
  method: Exclude<PaymentMethodCode, "cash">;
  amountIdr: number;
  /** VA bank code (see useVaBanks). */
  bankCode?: string;
  /** E-wallet code (see useEwallets). */
  walletCode?: string;
  /** EDC terminal id (see useEdcTerminals). */
  terminalId?: string;
  edcMode?: EdcMode;
};

export type ConfirmCashInput = {
  orderId: string;
  /** Part of the bill this cash payment settles. */
  amountIdr: number;
  /** What the customer handed over. */
  receivedIdr: number;
};

export type RecordEdcStandaloneInput = {
  orderId: string;
  terminalId: string;
  /** What the supervisor approved; a changed balance is refused. */
  amountIdr: number;
  edcMode: EdcMode;
  bankRef: string;
  approvalCode?: string;
  overrideId: string;
};

export type AttemptRef = { orderId: string; attemptId: string };

export type EdcTerminal = {
  id: string;
  label: string;
  bank: string;
  integrated: boolean;
  status: "ready" | "busy" | "offline";
  assignedTo: string;
  /** What the machine takes; absent means both. */
  modes?: readonly EdcMode[];
};

export type VaBank = { code: string; label: string };
export type Ewallet = { code: string; label: string };

export type ReceiptResult = {
  receiptNo: string;
  printedAt: string;
  /** Printing again after the first time is a reprint. */
  reprint: boolean;
  receiptId?: string;
  /** What the server did with the print; only `queued_to_printer` may print. */
  printResult: "queued_to_printer" | "not_printed" | null;
};

// ---- Cashier code ("Bayar di kasir") ---------------------------------------

export type CashierCodeOrder = {
  orderId: string;
  code: string;
  tableLabel: string;
  items: { name: string; qty: number; amountIdr: number }[];
  totalIdr: number;
  status: "unpaid" | "paid" | "cancelled";
};

// ---- Shift -----------------------------------------------------------------

export const CASH_DENOMINATIONS_IDR = [
  100_000, 50_000, 20_000, 10_000, 5_000,
] as const;

export type ShiftStatus = "open" | "awaiting_approval" | "closed";

/**
 * What the cashier may see of a shift. There is deliberately no expected cash
 * or variance here (blind count, POS-03): `useShiftReview` serves them.
 */
export type ActiveShift = {
  id: string;
  shiftNo: string;
  status: ShiftStatus;
  cashierName: string;
  terminalLabel: string;
  businessDate: string;
  openedAt: string;
  openingFloatIdr: number;
  countSubmitted: boolean;
};

export type CashMovementType = "cash_in" | "cash_out" | "drop";

export type CashMovement = {
  id: string;
  type: CashMovementType;
  amountIdr: number;
  reasonNote: string;
  recordedAt: string;
};

export type OpenShiftInput = { openingFloatIdr: number };

export type RecordCashMovementInput = {
  shiftId: string;
  type: CashMovementType;
  amountIdr: number;
  reasonNote: string;
};

export type BlindCountLine = { denominationIdr: number; quantity: number };

export type SubmitBlindCountInput = {
  shiftId: string;
  counts: BlindCountLine[];
  /** Combined amount of other denominations and coins. */
  otherAmountIdr: number;
};

/** The cashier only learns that the count was received. */
export type BlindCountReceipt = {
  shiftId: string;
  status: "awaiting_supervisor";
  submittedAt: string;
};

export type RegisteredTerminal = {
  id: string;
  label: string;
  outletName: string;
  cashierName: string;
};

// ---- Supervisor ------------------------------------------------------------

export type SupervisorOption = { userId: string; name: string };

export type ShiftReview = {
  shiftId: string;
  shiftNo: string;
  status: Exclude<ShiftStatus, "open">;
  cashierName: string;
  terminalLabel: string;
  businessDate: string;
  countedIdr: number;
  /**
   * The seven drawer figures below are null in the blind view (legend-4wrfd):
   * a caller without the variance permission, such as a supervisor reading
   * their own shift. They are null together; show a dash, never 0.
   */
  expectedIdr: number | null;
  /** counted - expected: negative is short. Null: hidden from the caller. */
  varianceIdr: number | null;
  breakdown: {
    openingFloatIdr: number;
    cashSalesIdr: number | null;
    cashRefundsIdr: number | null;
    cashInIdr: number | null;
    cashOutIdr: number | null;
    cashDropIdr: number | null;
  };
  /** Set once approved and locked. */
  varianceNote?: string;
  approvedByName?: string;
  closedAt?: string;
};

/** Actions an override can be asked for. The last two have no contract yet. */
export type OverrideAction =
  | "void"
  | "discount"
  | "refund"
  | "cash_drawer_open"
  | "price_correction"
  | "cash_shift_close"
  | "edc_standalone";

export type RequestOverrideInput = {
  action: OverrideAction;
  valueIdr: number;
  reason: string;
  objectType: string;
  objectId: string;
  approverUserId: string;
  pin: string;
};

export type OverrideResult = { overrideId: string; approvedByName: string };

export type ApproveShiftCloseInput = {
  shiftId: string;
  overrideId: string;
  /** Required when the count differs from the system figure. */
  reason: string;
};

// ---- End of day ------------------------------------------------------------

export type DayStatus = "open" | "closed";

export type DayCloseRecap = {
  businessDate: string;
  /** Business-day start in the outlet time zone, "HH:mm". */
  cutoffTime: string;
  status: DayStatus;
  totalSalesIdr: number;
  refundIdr: number;
  voidIdr: number;
  /** DP applied to the day's sales (liability, never a tender). Not shown yet. */
  depositAppliedIdr?: number;
  /** DP refunded on this day (on top of `refundIdr`). Not shown yet. */
  depositRefundedIdr?: number;
  channels: { code: string; label: string; amountIdr: number }[];
  shifts: {
    total: number;
    closed: number;
    terminals: number;
    /** null when the drawer figures are hidden from the caller. */
    cashVarianceIdr: number | null;
  };
  netPayments: { code: string; label: string; netIdr: number | null }[];
  totalNetIdr: number | null;
  /** Blind view: the caller ran a shift today, so drawer figures are null. */
  drawerFiguresHidden?: boolean;
  /** DEMO-CONTRACT: EDC settlement per bank; null when the server has none. */
  settlement: { bank: string; amountIdr: number }[] | null;
  /** Standalone EDC transactions that still need reconciliation. */
  standaloneUnmatched: number | null;
  /** Receipt numbers the cloud sequence issued but has not received (legend-21c8n). */
  unsyncedReceiptCount?: number;
  stockDeduction: { available: boolean; applied: boolean };
  /** Present once the day is closed. */
  result?: DayCloseResult;
};

export type DayCloseResult = {
  closedAt: string;
  closedByName: string;
  /** The local recap was saved at the outlet. */
  localRecapSaved: boolean;
  /** Settlement batch per bank. A successful batch is not reconciled money. */
  batches: { bank: string; status: "success" | "failed" }[];
  /** Accounting sync is a separate step from saving the recap. */
  accounting: "queued" | "synced" | "failed";
  standaloneUnmatched: number;
  stockDeductionApplied: boolean;
};

export type CloseDayInput = { inventoryDeduction: boolean };

// ---- Mock engine state (JSON, kept in sessionStorage) ----------------------

export type EngineTender = {
  id: string;
  method: AllocationMethod;
  label: string;
  amountIdr: number;
  confirmedAt: string;
  reference?: string;
  attemptId?: string;
  receivedIdr?: number;
  changeIdr?: number;
};

export type EngineAttempt = {
  id: string;
  sequence: number;
  method: PaymentMethodCode;
  /** Stored status; "expired" is derived from `expiresAt` when read. */
  status: AttemptStatus | "cancelled";
  amountIdr: number;
  startedAtMs: number;
  expiresAt?: string;
  va?: { bank: string; number: string; deadline: string };
  ewallet?: { code: string; label: string };
  edc?: PaymentAttempt["edc"];
  cardMasked?: string;
  bankRef?: string;
  approvalCode?: string;
  posRef?: string;
  standalone?: boolean;
  voidReason?: TenderVoidReason;
};

export type EngineOrder = {
  id: string;
  orderNo: string;
  tableLabel: string;
  guestCount: number;
  items: { name: string; qty: number; amountIdr: number }[];
  subtotalIdr: number;
  serviceIdr: number;
  taxIdr: number;
  totalIdr: number;
  /** Full reservation deposit; the bill uses at most the total. */
  deposit: { reference: string; amountIdr: number } | null;
  tenders: EngineTender[];
  attempts: EngineAttempt[];
  /** What a new gateway attempt resolves to when its status is checked. */
  checkOutcome: "confirm" | "fail";
  receiptNo: string | null;
  receiptPrints: number;
  /** Mock of `pos_orders.version`: starts at 0, +1 per mock write. */
  version: number;
  /** Code shown to customers ("LG-0044"), when the order came from a code. */
  code: string | null;
  /** The voucher applied to the bill; the engine prices `discountIdr`. */
  voucher?: { code: string; discountIdr: number } | null;
  /** The loyalty member on the order, when there is one. */
  member?: { id: string; name: string } | null;
};

/**
 * The mock engine's own record of a shift: server-side truth, so the drawer
 * figures are always numbers here. The blind view (null figures) is applied at
 * the output edge: `shiftWire` and `reviewOf` (legend-ekaca).
 */
export type EngineShift = {
  id: string;
  shiftNo: string;
  status: ShiftStatus;
  cashierName: string;
  terminalLabel: string;
  businessDate: string;
  openedAt: string;
  openingFloatIdr: number;
  cashSalesIdr: number;
  cashRefundsIdr: number;
  cashInIdr: number;
  cashOutIdr: number;
  cashDropIdr: number;
  count: {
    countedIdr: number;
    counts: BlindCountLine[];
    otherAmountIdr: number;
    submittedAt: string;
  } | null;
  closed: {
    expectedIdr: number;
    varianceIdr: number;
    varianceNote: string;
    approvedByName: string;
    closedAt: string;
  } | null;
};

export type EngineOverride = {
  id: string;
  action: OverrideAction;
  valueIdr: number;
  reason: string;
  objectType: string;
  objectId: string;
  approvedBy: string;
  createdAt: string;
  usedFor: string | null;
};

export type EngineDay = {
  status: DayStatus;
  inventoryDeduction: boolean;
  standaloneUnmatched: number;
  result: DayCloseResult | null;
};

export type EngineState = {
  orders: Record<string, EngineOrder>;
  shift: EngineShift | null;
  movements: (CashMovement & { shiftId: string })[];
  overrides: Record<string, EngineOverride>;
  pinMisses: Record<string, number>;
  day: EngineDay | null;
  /** Which demo seed each area was last seeded with (re-seed on change). */
  applied: Record<string, string>;
  counters: { override: number; movement: number; shift: number; id: number };
  /** Voucher and points state (brief 936); created on first use. */
  loyalty?: {
    balances: Record<string, number>;
    redeemedVouchers: string[];
    /** Idempotency keys already served: a repeat returns the session as is. */
    keys: string[];
  };
};
