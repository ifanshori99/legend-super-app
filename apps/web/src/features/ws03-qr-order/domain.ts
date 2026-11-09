// Pure domain logic of the guest order status, bill and recovery screens (PRD
// v1.7 §3 "QR Order Pelanggan": Status Pesanan, Split Bill, Panggil Waiter &
// Minta Tagihan, Klaim Poin per Orang, Pemulihan Item Gagal, Ulasan
// Pascamakan). Menu, cart and checkout logic lives in lib/*.ts. No React, no
// `@/` aliases: loaded by Node tests as-is.
//
// Display math here (split previews) never replaces the server: split parts
// come from the split endpoint and all totals from the bill (ORD-03, ORD-06).

import {
  GOOGLE_REVIEW_MIN_RATING,
  splitBill,
  type OrderIssue,
  type OrderItemStatus,
  type QrOrderItem,
  type QrOrderStatus,
  type TableSessionStatus,
} from "@starter/shared/qr-order";
import { idr } from "@starter/shared/core";

// ---- Order status per item ------------------------------------------------------

export type ItemStep = "received" | "preparing" | "ready" | "delivered";
const STEP_ORDER: readonly ItemStep[] = [
  "received",
  "preparing",
  "ready",
  "delivered",
];

/** PRD "Status Pesanan": diterima, diproses, siap, diantar. */
export function itemStep(status: OrderItemStatus): ItemStep | null {
  switch (status) {
    case "queued":
      return "received";
    case "in_progress":
      return "preparing";
    case "ready":
      return "ready";
    case "served":
      return "delivered";
    case "voided":
      return null;
  }
}

export function itemStepIndex(step: ItemStep): number {
  return STEP_ORDER.indexOf(step);
}

/** An order is as far along as its least advanced live item. */
export function orderProgress(
  items: readonly Pick<QrOrderItem, "status">[],
): ItemStep | null {
  const steps = items
    .map((item) => itemStep(item.status))
    .filter((step): step is ItemStep => step !== null);
  if (steps.length === 0) return null;
  return steps.reduce((least, step) =>
    itemStepIndex(step) < itemStepIndex(least) ? step : least,
  );
}

export type OrderPhase = "awaiting_payment" | "voided" | ItemStep | "completed";

export function orderPhase(order: {
  status: QrOrderStatus;
  items: readonly Pick<QrOrderItem, "status">[];
}): OrderPhase {
  if (order.status === "awaiting_payment") return "awaiting_payment";
  if (order.status === "voided") return "voided";
  if (order.status === "completed") return "completed";
  return orderProgress(order.items) ?? "received";
}

// ---- Split bill ------------------------------------------------------------------

/** Equal split preview: the same largest-remainder helper as the server (ORD-06). */
export function previewEqualSplit(totalIdr: number, parts: number): number[] {
  return splitBill({ method: "equal", totalIdr: idr(totalIdr), parts }).map(
    (draft) => draft.amountIdr,
  );
}

export type ItemAssignment = { orderItemIds: readonly string[] };

export function unassignedItems(
  allItemIds: readonly string[],
  assignments: readonly ItemAssignment[],
): string[] {
  const assigned = new Set(assignments.flatMap((a) => a.orderItemIds));
  return allItemIds.filter((itemId) => !assigned.has(itemId));
}

export function hasDuplicateAssignment(
  assignments: readonly ItemAssignment[],
): boolean {
  const seen = new Set<string>();
  for (const assignment of assignments)
    for (const itemId of assignment.orderItemIds) {
      if (seen.has(itemId)) return true;
      seen.add(itemId);
    }
  return false;
}

/**
 * What a split divides (ORD-06). A pay-first order waiting for payment is
 * split on its own; otherwise the whole bill. Once part of the bill was paid
 * outside a split (a pay-first order, or "Bayar semua" before new orders), a
 * new split is refused: shares of the full total would charge that part twice.
 * PRD is silent on splitting a partly paid bill; the guest pays the rest in
 * one go or asks the waiter (safest option, reviewer note legend-2m4).
 */
export function splitScope<
  O extends { id: string; status: QrOrderStatus; totalIdr: number },
>(
  orders: readonly O[],
  paidIdr: number,
): { orders: O[]; totalIdr: number } | null {
  const awaiting = orders.find((order) => order.status === "awaiting_payment");
  if (awaiting) return { orders: [awaiting], totalIdr: awaiting.totalIdr };
  const live = orders.filter((order) => order.status !== "voided");
  if (live.length === 0 || paidIdr > 0) return null;
  return {
    orders: live,
    totalIdr: live.reduce((sum, order) => sum + order.totalIdr, 0),
  };
}

/** True when a share of this order is already paid: paying the whole order again would charge twice. */
export function orderHasPaidShare(
  splits: readonly { orderId: string | null; status: string }[],
  orderId: string,
): boolean {
  return splits.some(
    (split) => split.orderId === orderId && split.status === "paid",
  );
}

/** The pending split part that belongs to this guest, if any. */
export function myPendingShare<
  T extends { status: string; participantId: string | null },
>(splits: readonly T[], participantId: string | null): T | null {
  if (participantId === null) return null;
  return (
    splits.find(
      (split) =>
        split.status === "pending" && split.participantId === participantId,
    ) ?? null
  );
}

// ---- Failed-item recovery and review ----------------------------------------------

/** ORD-08: the customer only ever chooses between these two. */
export const CUSTOMER_CHOICES = ["swap", "voucher"] as const;

export function isIssueActionable(issue: Pick<OrderIssue, "status">): boolean {
  return issue.status === "open";
}

/**
 * Swap price difference (PRD "selisih harga dibayar atau dikreditkan"):
 * a cheaper replacement credits the guest, a dearer one asks for the rest.
 */
export function priceDifference(
  failedLineIdr: number,
  replacementIdr: number,
): { kind: "pay" | "credit" | "even"; amountIdr: number } {
  const delta = replacementIdr - failedLineIdr;
  if (delta === 0) return { kind: "even", amountIdr: 0 };
  return delta > 0
    ? { kind: "pay", amountIdr: delta }
    : { kind: "credit", amountIdr: -delta };
}

export function promptsGoogleReview(rating: number): boolean {
  return rating >= GOOGLE_REVIEW_MIN_RATING;
}

/** Per-item split preview: same allocation as the server (largest remainder). */
export function previewItemSplit(
  totalIdr: number,
  lines: readonly { orderItemId: string; lineTotalIdr: number }[],
  assignments: readonly ItemAssignment[],
): number[] {
  return splitBill({
    method: "by_item",
    totalIdr: idr(totalIdr),
    lines: lines.map((line) => ({
      orderItemId: line.orderItemId,
      lineTotalIdr: idr(line.lineTotalIdr),
    })),
    assignments,
  }).map((draft) => draft.amountIdr);
}

export type SplitMode = "equal" | "by_person" | "by_item";

/**
 * Whether a draft split can be sent. ORD-06: every item exactly once for
 * by-item; at least two parts for equal/by-person (one part is no split).
 */
export function splitDraftError(input: {
  mode: SplitMode;
  parts: number;
  participantCount: number;
  itemIds: readonly string[];
  assignments: readonly ItemAssignment[];
}):
  | "TOO_FEW_PARTS"
  | "TOO_MANY_PARTS"
  | "ITEMS_UNASSIGNED"
  | "ITEM_TWICE"
  | null {
  if (input.mode === "by_item") {
    if (hasDuplicateAssignment(input.assignments)) return "ITEM_TWICE";
    if (unassignedItems(input.itemIds, input.assignments).length > 0)
      return "ITEMS_UNASSIGNED";
    return input.assignments.length >= 2 ? null : "TOO_FEW_PARTS";
  }
  const parts = input.mode === "equal" ? input.parts : input.participantCount;
  if (parts < 2) return "TOO_FEW_PARTS";
  if (parts > 50) return "TOO_MANY_PARTS";
  return null;
}

/** Splitting is allowed while there is something left to pay. */
export function canSplitBill(input: {
  sessionStatus: TableSessionStatus;
  outstandingIdr: number;
}): boolean {
  return (
    input.outstandingIdr > 0 &&
    input.sessionStatus !== "closed" &&
    input.sessionStatus !== "voided" &&
    input.sessionStatus !== "pending_confirmation"
  );
}

/**
 * PRD "Kontrol Open Bill": how far the bill is from the zone minimum spend.
 * Q53 (legend-v9fh): the minimum counts the value before tax and service
 * charge, so the service charge and tax already inside inclusive-price orders
 * (`includedChargesIdr`) are taken out; same rule as the API quote.
 */
export function minimumSpendShortfall(
  requiredIdr: number,
  subtotalIdr: number,
  discountIdr: number,
  includedChargesIdr = 0,
): number {
  return Math.max(
    0,
    requiredIdr - (subtotalIdr - discountIdr - includedChargesIdr),
  );
}

export type ClaimView = "unavailable" | "available" | "claimed" | "expired";

/** An "available" claim past its 24 h deadline reads as expired (PRD). */
export function effectiveClaimStatus(
  claim: { status: ClaimView; claimableUntil: string | null },
  nowMs: number,
): ClaimView {
  if (
    claim.status === "available" &&
    claim.claimableUntil !== null &&
    new Date(claim.claimableUntil).getTime() <= nowMs
  )
    return "expired";
  return claim.status;
}

/** "Tamu 1", "Tamu 2" by join order; the caller marks "(Anda)". */
export function guestNumber(
  participantIds: readonly string[],
  participantId: string,
): number {
  return participantIds.indexOf(participantId) + 1;
}
