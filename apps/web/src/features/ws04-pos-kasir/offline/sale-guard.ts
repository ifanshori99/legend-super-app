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
  /** The cart is the one whose cloud request is unclear. */
  | "uncertain_order"
  /** An order request is in flight right now. */
  | "sending"
  /** The cart continues an order that already exists in the cloud. */
  | "cloud_order"
  /** Offline sells dine-in and takeaway only (the kit's two price lists). */
  | "channel"
  | "empty";

/** The lines as the kitchen sees them: item, variant, options, quantity. */
function linesKey(lines: readonly CartLine[]): string {
  return JSON.stringify(
    lines
      .map((line) => [
        line.menuItemId,
        line.variantId,
        line.modifiers.map((modifier) => modifier.optionId).sort(),
        line.quantity,
      ])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
}

export function offlineSaleBlock(input: {
  lines: readonly CartLine[];
  channel: SaleChannel;
  /** The unclear order request of this cart key, if any. */
  pending: OrderSnapshot | null;
  submitting: boolean;
  /** The cloud order this cart continues (`?draft=`), if any. */
  cloudOrderId: string | null | undefined;
}): OfflineSaleBlock | null {
  if (input.submitting) return "sending";
  // Compared by lines only: a changed table or channel is still the same food.
  if (input.pending && linesKey(input.pending.lines) === linesKey(input.lines))
    return "uncertain_order";
  if (input.cloudOrderId) return "cloud_order";
  if (input.lines.length === 0) return "empty";
  if (
    !(OFFLINE_KIT_SERVICE_TYPES as readonly string[]).includes(input.channel)
  )
    return "channel";
  return null;
}
