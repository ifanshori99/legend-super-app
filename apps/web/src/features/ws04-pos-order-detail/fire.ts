// Sending held items to the kitchen from the order detail (brief 1268 W5).
// Pure: which lines are held, and whether the order may be fired at all. The
// keyed send itself is the captain's (`fireItems` in ../ws04-pos-order), so a
// lost reply repeats the same key and body, also after a refresh, and the
// captain and the cashier see the same unclear fire of one order.
import type { PosOrderStatus } from "@starter/shared/pos";
import type { AreaAccess } from "@/lib/areas/access";
import { holdsAny } from "@/lib/areas/guard";

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

/**
 * Which order actions this account may take (CTO 26 Nov, review W5 no. 2).
 * Presentation only, mirroring the API: fire is `pos.sale.create` or the
 * captain's `order.create` (the route's `sellOrCaptain`), payment is
 * `pos.payment.accept`, the cashier screen is `pos.sale.create`.
 */
export function orderActionRights(access: AreaAccess): {
  fire: boolean;
  pay: boolean;
  cashier: boolean;
} {
  return {
    fire: holdsAny(access, ["pos.sale.create", "order.create"]),
    pay: holdsAny(access, ["pos.payment.accept"]),
    cashier: holdsAny(access, ["pos.sale.create"]),
  };
}

export type PrimaryActionKind = "retry" | "fire" | "cashier" | "pay";

/**
 * The detail's one primary action: "Periksa lagi" while a fire is unclear,
 * "Kirim ke dapur" while items are held (and fire is allowed), "Lanjutkan di
 * kasir" for a draft (never payment: it is not on the shift yet), else
 * payment when allowed. Null when nothing applies.
 */
export function primaryActionOf(input: {
  unclear: boolean;
  fireable: boolean;
  status: PosOrderStatus;
  rights: { pay: boolean; cashier: boolean };
}): PrimaryActionKind | null {
  if (input.unclear) return "retry";
  if (input.fireable) return "fire";
  if (input.status === "completed" || input.status === "voided") return null;
  if (input.status === "draft") return input.rights.cashier ? "cashier" : null;
  return input.rights.pay ? "pay" : null;
}
