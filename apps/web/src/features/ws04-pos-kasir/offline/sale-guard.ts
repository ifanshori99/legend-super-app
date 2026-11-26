// O4 double guard of an offline sale (bead legend-wasr7.8, Keputusan CTO O4
// no. 2). A cart whose order request to the cloud is still unclear (the answer
// was lost, e.g. a timeout as the internet went down) may already be an order
// there; selling it again offline could make it twice. Only a new cart is sold
// offline. Pure: Node tests load it directly.
import { OFFLINE_KIT_SERVICE_TYPES } from "@starter/shared/pos";
import type {
  CartLine,
  OrderSnapshot,
  SaleChannel,
} from "@/features/ws04-pos-order/types";

export type OfflineSaleBlock =
  /** Review K P2 2: this cashier may not take payment. */
  | "noPermission"
  /** The cart is the one whose cloud request is unclear. */
  | "uncertain_order"
  /** An order request is in flight right now. */
  | "sending"
  /** The cart continues an order that already exists in the cloud. */
  | "cloud_order"
  /** Offline sells dine-in and takeaway only (the kit's two price lists). */
  | "channel"
  | "empty";

/** One line as the kitchen makes it: item, variant, options (not quantity). */
function lineKey(line: CartLine): string {
  return JSON.stringify([
    line.menuItemId,
    line.variantId,
    line.modifiers.map((modifier) => modifier.optionId).sort(),
  ]);
}

/**
 * Review K P2 1: a cart that shares any line with the unclear order (pending
 * plus one more item, or another quantity) may still be that order: held.
 */
function sharesLine(
  lines: readonly CartLine[],
  pending: readonly CartLine[],
): boolean {
  const keys = new Set(pending.map(lineKey));
  return lines.some((line) => keys.has(lineKey(line)));
}

export function offlineSaleBlock(input: {
  lines: readonly CartLine[];
  channel: SaleChannel;
  /** The unclear order request of this cart key, if any. */
  pending: OrderSnapshot | null;
  submitting: boolean;
  /** The cloud order this cart continues (`?draft=`), if any. */
  cloudOrderId: string | null | undefined;
  /** `pos.payment.accept`: an offline sale is taken payment. */
  canAcceptPayment: boolean;
}): OfflineSaleBlock | null {
  if (!input.canAcceptPayment) return "noPermission";
  if (input.submitting) return "sending";
  // Compared by lines only: a changed table or channel is still the same food.
  if (input.pending && sharesLine(input.lines, input.pending.lines))
    return "uncertain_order";
  if (input.cloudOrderId) return "cloud_order";
  if (input.lines.length === 0) return "empty";
  if (!(OFFLINE_KIT_SERVICE_TYPES as readonly string[]).includes(input.channel))
    return "channel";
  return null;
}
