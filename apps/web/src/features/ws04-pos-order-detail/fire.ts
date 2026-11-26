// Sending held items to the kitchen from the order detail (brief 1268 W5).
// Pure: which lines are held, and whether the order may be fired at all. The
// keyed send itself is the captain's (`fireItems` in ../ws04-pos-order), so a
// lost reply repeats the same key and body, also after a refresh, and the
// captain and the cashier see the same unclear fire of one order.
import type { PosOrderStatus } from "@starter/shared/pos";

type Line = { id: string; status: string; fireStatus: "held" | "fired" };

/** Server ids of the lines still held back (voided lines never fire). */
export function heldItemIds(items: readonly Line[]): string[] {
  return items
    .filter((item) => item.status !== "voided" && item.fireStatus === "held")
    .map((item) => item.id);
}

/** Only an order on the shift and not final can be fired. */
export function canFire(status: PosOrderStatus, held: number): boolean {
  return held > 0 && (status === "awaiting_payment" || status === "sent");
}
