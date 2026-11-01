// Order status per item for the guest (PRD §3 F10 "Status Pesanan": diterima,
// diproses, siap, diantar) and the derived headline of an order.
import type { QrOrder, QrOrderItem } from "@starter/shared/qr-order";

export type GuestItemStatus = "received" | "preparing" | "ready" | "delivered";

/** `voided` items are not part of the timeline; callers filter them first. */
export function guestItemStatus(
  status: QrOrderItem["status"],
): GuestItemStatus | "voided" {
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
      return "voided";
  }
}

export type OrderProgress = {
  total: number;
  received: number;
  preparing: number;
  ready: number;
  delivered: number;
  /** True when every live item is delivered. */
  done: boolean;
};

export function orderProgress(order: Pick<QrOrder, "items">): OrderProgress {
  const progress: OrderProgress = {
    total: 0,
    received: 0,
    preparing: 0,
    ready: 0,
    delivered: 0,
    done: false,
  };
  for (const item of order.items) {
    const status = guestItemStatus(item.status);
    if (status === "voided") continue;
    progress.total += 1;
    progress[status] += 1;
  }
  progress.done = progress.total > 0 && progress.delivered === progress.total;
  return progress;
}

/** Whole minutes left until `target`, never negative; null when no target. */
export function minutesUntil(
  target: string | null,
  nowMs: number,
): number | null {
  if (target === null) return null;
  const diff = new Date(target).getTime() - nowMs;
  return Math.max(0, Math.ceil(diff / 60_000));
}
