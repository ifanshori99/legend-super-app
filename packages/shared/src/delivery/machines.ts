// Delivery channel state machine, adapter action mapping and reconciliation
// rules (PRD v1.7 §3.23, docs/plan/contracts.md: money and state transitions
// only through the contract state machines). Pure functions: the API, the
// delivery-ops screen and the tests run the same rules.
//
//   received ─▶ accepted ─▶ preparing ─▶ ready ─▶ picked_up ─▶ delivered
//       │           │            │          │
//       └───────────┴────────────┴──────────┴──▶ cancelled / rejected
//
// Every step is also a `DeliveryChannel` adapter action (WS-00 adapters):
// accept → `accept_order`, progress → `update_order`, cancel/reject →
// `cancel_order`. `deliveryActionForTransition` is the single mapping, so the
// service never hand-picks a platform call.

import { subtractIdr } from "../core/index.ts";
import type { Idr } from "../core/index.ts";
import { DeliveryError } from "./errors.ts";
import type {
  DeliveryChannelOrder,
  DeliveryOrderStatus,
  DeliverySettlementLine,
  DeliverySettlementStatus,
} from "./schemas.ts";

// ---- Fulfilment state machine --------------------------------------------

const deliveryTransitions: Record<
  DeliveryOrderStatus,
  readonly DeliveryOrderStatus[]
> = {
  received: ["accepted", "rejected", "cancelled"],
  accepted: ["preparing", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["picked_up", "cancelled"],
  picked_up: ["delivered"],
  delivered: [],
  cancelled: [],
  rejected: [],
};

export function canTransitionDeliveryOrder(
  from: DeliveryOrderStatus,
  to: DeliveryOrderStatus,
): boolean {
  return deliveryTransitions[from].includes(to);
}

export function assertDeliveryOrderTransition(
  from: DeliveryOrderStatus,
  to: DeliveryOrderStatus,
): void {
  if (!canTransitionDeliveryOrder(from, to))
    throw new DeliveryError(
      "DELIVERY_TRANSITION_INVALID",
      `Pesanan ${from} tidak dapat menjadi ${to}.`,
    );
}

/** Actions of the WS-00 `DeliveryChannel` adapter this transition calls. */
export const DELIVERY_ACTIONS = [
  "accept_order",
  "update_order",
  "cancel_order",
] as const;
export type DeliveryAction = (typeof DELIVERY_ACTIONS)[number];

/**
 * The adapter call for a status step, or null when nothing is pushed to the
 * platform (the first `received` state came from the platform itself).
 */
export function deliveryActionForTransition(
  from: DeliveryOrderStatus,
  to: DeliveryOrderStatus,
): DeliveryAction | null {
  if (!canTransitionDeliveryOrder(from, to)) return null;
  if (to === "accepted") return "accept_order";
  if (to === "cancelled" || to === "rejected") return "cancel_order";
  return "update_order";
}

// ---- Money ----------------------------------------------------------------

/** Net revenue actually expected from the platform: gross − commission. */
export function deliveryNetIdr(
  order: Pick<DeliveryChannelOrder, "grossIdr" | "commissionIdr">,
): Idr {
  return subtractIdr(order.grossIdr, order.commissionIdr);
}

// ---- Reconciliation (§3.23 "Rekonsiliasi Komisi") -------------------------

/**
 * Compare a platform statement line with the internal order it names. The
 * reported net is `gross − commission` on both sides; a difference is a
 * variance for finance, a missing internal order is `unknown_order` (the
 * platform billed us for an order we never recorded).
 */
export function reconcileDeliveryLine(
  order: Pick<DeliveryChannelOrder, "id" | "grossIdr" | "commissionIdr"> | null,
  line: Pick<DeliverySettlementLine, "settledNetIdr">,
): { status: DeliverySettlementStatus; varianceIdr: Idr } {
  if (order === null)
    return { status: "unknown_order", varianceIdr: line.settledNetIdr };
  const expected = deliveryNetIdr(order);
  const varianceIdr = subtractIdr(line.settledNetIdr, expected);
  return {
    status: varianceIdr === 0 ? "matched" : "variance",
    varianceIdr,
  };
}

/** A mapped order can be injected into the KDS only when every line is known. */
export function deliveryOrderIsInjectable(
  order: Pick<DeliveryChannelOrder, "lines">,
): boolean {
  return order.lines.every(
    (line) => line.mapping === "matched" || line.mapping === "price_mismatch",
  );
}

/** Throws DELIVERY_MAPPING_INCOMPLETE for an order that cannot reach the KDS. */
export function assertDeliveryOrderInjectable(
  order: Pick<DeliveryChannelOrder, "lines">,
): void {
  if (!deliveryOrderIsInjectable(order))
    throw new DeliveryError("DELIVERY_MAPPING_INCOMPLETE");
}
