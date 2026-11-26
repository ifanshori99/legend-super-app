import { posStandaloneEdcSchema } from "@starter/shared/pos";
import type { PaymentBill } from "../../types";

/** Allocations that already count against the bill. */
export function confirmedAllocations(bill: PaymentBill) {
  return bill.allocations.filter((a) => a.status === "confirmed");
}

/** "02": the position of the payment about to be taken (DP is not counted). */
export function nextSequence(bill: PaymentBill): string {
  return String(confirmedAllocations(bill).length + 1).padStart(2, "0");
}

/** Next round figure above the amount (50.000 steps), for the quick-pick. */
export function roundUpIdr(amountIdr: number, step = 50_000): number {
  return Math.ceil(amountIdr / step) * step;
}

/** Wall-clock "14.31" of an ISO time in the outlet time zone. */
export function formatClock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(new Date(iso));
}

/** What one supervisor PIN of a hand-keyed EDC payment was given for. */
export function edcApprovalKey(input: {
  orderId: string;
  terminalId: string;
  amountIdr: number;
  approverId: string;
  bankRef: string;
}): string {
  const { orderId, terminalId, amountIdr, approverId, bankRef } = input;
  return [orderId, terminalId, amountIdr, approverId, bankRef.trim()].join(":");
}

/**
 * Why a typed slip reference cannot be recorded (the contract's own rule, a
 * card number included), or undefined. Read before any approval is asked: the
 * approval reason names the reference and is stored.
 */
export function edcSlipRefProblem(bankRef: string): string | undefined {
  const parsed = posStandaloneEdcSchema.shape.bankRef.safeParse(bankRef.trim());
  return parsed.success
    ? undefined
    : (parsed.error.issues[0]?.message ?? "Nomor referensi bank tidak valid.");
}
