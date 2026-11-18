// POS pure arithmetic shared by the API, the edge node and the POS screens:
// tender coverage, cash change, the cashier-shift drawer, blind count and
// refund allocation. Nothing here talks to a database or a provider; the
// POS-03 and POS-02 rules live in functions so the API and the UI cannot
// disagree about them.
//
// Money is whole rupiah (D-CORE-2); intermediate sums use core's bigint
// helpers so a multi-tender bill never loses a rupiah.

import {
  addIdr,
  allocateIdr,
  idr,
  subtractIdr,
  sumIdr,
} from "../core/index.ts";
import type { Idr } from "../core/index.ts";
import type { PaymentMethod } from "../payment/index.ts";
import { PosError } from "./errors.ts";
import { IDR_CASH_DENOMINATIONS } from "./schemas.ts";
import type {
  BlindCashCount,
  PosShift,
  PosShiftWithFigures,
  PosTender,
  TenderBucket,
} from "./schemas.ts";

function nonNegative(amount: Idr, label: string): Idr {
  if (Number(amount) < 0)
    throw new RangeError(`${label} must not be negative: ${amount}`);
  return idr(Number(amount));
}

/**
 * Which accounting bucket a tender method settles into. The three clearing
 * buckets are the ones `order.paid` books (§3.19 Jurnal Otomatis: cash on
 * hand, gateway clearing, EDC clearing) plus the loyalty liability for points,
 * so a tender method never silently disappears from the journal.
 */
export function tenderBucket(method: PaymentMethod): TenderBucket {
  switch (method) {
    case "cash":
      return "cash";
    case "qris":
    case "va":
    case "ewallet":
    case "card":
      return "gateway";
    case "edc_card":
    case "edc_qris":
      return "edc";
    case "points":
      return "points";
    default:
      // Vouchers are a discount line before the total, never a tender; any
      // other method has no accounting bucket and must fail closed.
      throw new RangeError(`Method ${method} is not a POS tender method`);
  }
}

/**
 * A cash tender applies at most what is still due. Handing over more produces
 * change; handing over less leaves a balance for the next tender (split
 * payment). The client sends only the cash it received, never the amount
 * applied — the server computes it from the order (TEN-02 money rule).
 */
export function planCashTender(
  remainingIdr: Idr,
  receivedIdr: Idr,
): { amountIdr: Idr; receivedIdr: Idr; changeIdr: Idr } {
  const remaining = nonNegative(remainingIdr, "Remaining amount");
  const received = nonNegative(receivedIdr, "Cash received");
  if (received === 0)
    throw new RangeError("Cash received must be greater than zero");
  const amountIdr = received < remaining ? received : remaining;
  return {
    amountIdr,
    receivedIdr: received,
    changeIdr: subtractIdr(received, amountIdr) as Idr,
  };
}

/** Captured tenders only: authorized-but-unconfirmed money is not money yet. */
export function capturedTenders(tenders: readonly PosTender[]): PosTender[] {
  return tenders.filter((tender) => tender.status === "captured");
}

/** What is still due on the order: total minus captured tenders. */
export function remainingDueIdr(
  totalIdr: Idr,
  tenders: readonly PosTender[],
): Idr {
  const captured = sumIdr(
    capturedTenders(tenders).map((tender) => tender.amountIdr),
  );
  const remaining = Number(totalIdr) - Number(captured);
  if (remaining < 0)
    throw new PosError(
      "TENDER_TOTAL_MISMATCH",
      "Captured tenders exceed the order total",
    );
  return idr(remaining);
}

export type TenderSummary = {
  readonly totalIdr: Idr;
  readonly byBucket: Record<TenderBucket, Idr>;
  readonly byMethod: Readonly<Record<string, Idr>>;
  readonly changeIdr: Idr;
};

/** Bucket and per-method totals for the receipt, the shift and `order.paid`. */
export function summarizeTenders(tenders: readonly PosTender[]): TenderSummary {
  const captured = capturedTenders(tenders);
  const byMethod: Record<string, Idr> = {};
  for (const tender of captured)
    byMethod[tender.method] = addIdr(
      byMethod[tender.method] ?? idr(0),
      tender.amountIdr,
    );
  const bucket = (name: TenderBucket): Idr =>
    sumIdr(
      captured
        .filter((tender) => tenderBucket(tender.method) === name)
        .map((tender) => tender.amountIdr),
    );
  return {
    totalIdr: sumIdr(captured.map((tender) => tender.amountIdr)),
    byBucket: {
      cash: bucket("cash"),
      gateway: bucket("gateway"),
      edc: bucket("edc"),
      points: bucket("points"),
    },
    byMethod,
    changeIdr: sumIdr(
      captured
        .filter((tender) => tender.method === "cash")
        .map((tender) => tender.changeIdr ?? idr(0)),
    ),
  };
}

/** A bill is paid only when the captured tenders equal its total exactly. */
export function assertTenderCoverage(
  totalIdr: Idr,
  tenders: readonly PosTender[],
): void {
  const summary = summarizeTenders(tenders);
  if (Number(summary.totalIdr) !== Number(totalIdr))
    throw new PosError("TENDER_TOTAL_MISMATCH");
}

// ---- Cashier shift (POS-03, §3.11 Shift Kasir) ----------------------------

export type ShiftCashInput = {
  readonly openingFloatIdr: Idr;
  readonly cashSalesIdr: Idr;
  readonly cashRefundsIdr: Idr;
  readonly cashInIdr: Idr;
  readonly cashOutIdr: Idr;
  readonly cashDropIdr: Idr;
};

/**
 * What the drawer should hold (the number the cashier must not see while
 * counting): modal awal + penjualan tunai − refund tunai + kas masuk − kas
 * keluar − setoran brankas. Boleh negatif (legend-4wu4).
 */
export function shiftExpectedCashIdr(input: ShiftCashInput): Idr {
  const sum = sumIdr([
    input.openingFloatIdr,
    input.cashSalesIdr,
    input.cashInIdr,
  ]);
  const out = sumIdr([
    input.cashRefundsIdr,
    input.cashOutIdr,
    input.cashDropIdr,
  ]);
  // May be negative (legend-4wu4): cash out is never refused on the drawer, so
  // the gap is a variance for the supervisor, not an error for the cashier.
  return idr(Number(sum) - Number(out));
}

/**
 * Blind count (POS-03: "kasir menghitung tanpa melihat angka sistem"): the
 * cashier submits denomination counts, and the total is derived here. No
 * expected/variance amount can be submitted with it — the close input schema
 * is strict and has no such fields.
 */
export function blindCountTotalIdr(counts: readonly BlindCashCount[]): Idr {
  if (counts.length === 0)
    throw new RangeError("A blind count needs at least one denomination");
  let total = 0n;
  const seen = new Set<number>();
  for (const row of counts) {
    if (
      !(IDR_CASH_DENOMINATIONS as readonly number[]).includes(
        row.denominationIdr,
      )
    )
      throw new RangeError(`Invalid denomination: ${row.denominationIdr}`);
    if (seen.has(row.denominationIdr))
      throw new RangeError(`Duplicate denomination: ${row.denominationIdr}`);
    seen.add(row.denominationIdr);
    if (!Number.isSafeInteger(row.quantity) || row.quantity < 0)
      throw new RangeError(`Invalid note count: ${row.quantity}`);
    total += BigInt(row.denominationIdr) * BigInt(row.quantity);
  }
  return idr(Number(total));
}

/** counted − expected: negative is short (kurang), positive is over (lebih). */
export function shiftVarianceIdr(countedIdr: Idr, expectedIdr: Idr): Idr {
  return subtractIdr(countedIdr, expectedIdr) as Idr;
}

/** POS-03: once approved the variance is history, never editable. */
export function assertShiftCountEditable(
  shift: Pick<PosShift, "status">,
): void {
  if (shift.status === "closed") throw new PosError("SHIFT_VARIANCE_LOCKED");
}

/** Cash moves only while the shift is open (kas masuk/keluar, setoran). */
export function assertCashMovementAllowed(
  shift: Pick<PosShift, "status">,
): void {
  if (shift.status !== "open") throw new PosError("SHIFT_NOT_OPEN");
}

export type CloseShiftInput = {
  readonly counts: readonly BlindCashCount[];
  /** The stored count submission (`pos_shift_counts`) the close uses. */
  readonly countId: string;
  /**
   * Cash held for supervisor review at count time (left out of expected).
   * The note rule judges counted − expected + held, as if nothing were held,
   * so a held item never shows itself through the note (legend-utqr).
   */
  readonly heldCashOutIdr?: number;
  readonly varianceNote: string | null;
  readonly approvedBy: string;
  readonly approvalRequestId: string;
  readonly approvedAt: string;
  readonly closedAt: string;
};

/**
 * The whole POS-03 close in one pure transition: refuse a second close, take
 * the blind count, compute expected and variance on the server, and require a
 * written explanation and supervisor approval for any difference (U9: "setiap
 * selisih memiliki penjelasan dan persetujuan"). The result is the stored row;
 * after this the variance is locked.
 */
export function closeShift(
  shift: PosShiftWithFigures,
  input: CloseShiftInput,
): PosShiftWithFigures {
  if (shift.status === "closed") throw new PosError("SHIFT_ALREADY_CLOSED");
  const countedIdr = blindCountTotalIdr(input.counts);
  const expectedIdr = shiftExpectedCashIdr(shift);
  const varianceIdr = shiftVarianceIdr(countedIdr, expectedIdr);
  if (
    varianceIdr + (input.heldCashOutIdr ?? 0) !== 0 &&
    (input.varianceNote ?? "").trim().length === 0
  )
    throw new PosError("SHIFT_VARIANCE_NOTE_REQUIRED");
  return {
    ...shift,
    status: "closed",
    countedIdr,
    expectedIdr,
    varianceIdr,
    varianceNote: input.varianceNote,
    approvedBy: input.approvedBy as PosShift["approvedBy"],
    approvalRequestId: input.approvalRequestId,
    approvedAt: input.approvedAt,
    closedAt: input.closedAt,
    countId: input.countId as PosShift["countId"],
  };
}

// ---- Discounts, voids and refunds (POS-02, POS-04) ------------------------

/**
 * POS-02: a manual discount above the tenant threshold needs approval; promo
 * engine and member discounts are already authorized by their configuration.
 * The comparison is integer: "above" means strictly greater, and the threshold
 * is basis points of the subtotal (tenant setting, never a coded constant).
 */
export function requiresDiscountApproval(input: {
  readonly source: "promo" | "voucher" | "manual";
  readonly amountIdr: Idr;
  readonly subtotalIdr: Idr;
  readonly thresholdBp: number;
}): boolean {
  if (!Number.isInteger(input.thresholdBp) || input.thresholdBp < 0)
    throw new RangeError(`Invalid discount threshold: ${input.thresholdBp}`);
  if (input.source !== "manual") return false;
  if (Number(input.subtotalIdr) <= 0)
    throw new RangeError("Cannot discount an empty order");
  return (
    Number(input.amountIdr) * 10_000 >
    Number(input.subtotalIdr) * input.thresholdBp
  );
}

export function assertDiscountApproved(input: {
  readonly source: "promo" | "voucher" | "manual";
  readonly amountIdr: Idr;
  readonly subtotalIdr: Idr;
  readonly thresholdBp: number;
  readonly approvalRequestId: string | null;
}): void {
  if (Number(input.amountIdr) > Number(input.subtotalIdr))
    throw new PosError("DISCOUNT_EXCEEDS_SUBTOTAL");
  if (requiresDiscountApproval(input) && input.approvalRequestId === null)
    throw new PosError("DISCOUNT_APPROVAL_REQUIRED");
}

/** POS-02: a void always carries the verified supervisor approval. */
export function assertVoidApproved(input: {
  readonly approvalRequestId: string | null;
  readonly approvedBy: string | null;
}): void {
  if (input.approvalRequestId === null || input.approvedBy === null)
    throw new PosError("VOID_APPROVAL_REQUIRED");
}

/** POS-02: a refund always carries the verified supervisor approval. */
export function assertRefundApproved(input: {
  readonly approvalRequestId: string | null;
  readonly approvedBy: string | null;
}): void {
  if (input.approvalRequestId === null || input.approvedBy === null)
    throw new PosError("REFUND_APPROVAL_REQUIRED");
}

/** What is still refundable after the earlier refunds of the same sale. */
export function refundableIdr(paidIdr: Idr, alreadyRefundedIdr: Idr): Idr {
  const refundable = Number(paidIdr) - Number(alreadyRefundedIdr);
  if (refundable < 0) throw new RangeError("Refunds exceed the amount paid");
  return idr(refundable);
}

export function assertRefundWithinPaid(
  paidIdr: Idr,
  alreadyRefundedIdr: Idr,
  amountIdr: Idr,
): void {
  if (Number(amountIdr) <= 0)
    throw new RangeError("A refund must be greater than zero");
  if (Number(amountIdr) > Number(refundableIdr(paidIdr, alreadyRefundedIdr)))
    throw new PosError("REFUND_EXCEEDS_PAID");
}

/**
 * A refund returns money through the same methods it was taken with, in the
 * original proportion (largest remainder via core `allocateIdr`), so the parts
 * sum to exactly the refund amount and no client-chosen methods can skew the
 * reconciliation.
 */
export function refundAllocation(
  tenders: readonly PosTender[],
  amountIdr: Idr,
): Array<{ method: PaymentMethod; amountIdr: Idr }> {
  const captured = capturedTenders(tenders).filter(
    (tender) => Number(tender.amountIdr) > 0,
  );
  if (captured.length === 0)
    throw new RangeError("The order has no captured tender to refund");
  const weights = captured.map((tender) => Number(tender.amountIdr));
  const parts = allocateIdr(amountIdr, weights);
  return captured
    .map((tender, index) => ({
      method: tender.method,
      amountIdr: parts[index] as Idr,
    }))
    .filter((row) => Number(row.amountIdr) > 0);
}
