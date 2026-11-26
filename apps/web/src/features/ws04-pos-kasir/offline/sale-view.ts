// O4 view helpers of offline sales (bead legend-wasr7.8): the cart as the
// kit prices it, the offline receipt number and the drawer cash still on the
// tablet. Pure: Node tests load it directly.
import { idr } from "@starter/shared/core";
import type {
  OfflineSaleEvent,
  OfflineSaleTender,
  PosOfflineKit,
} from "@starter/shared/pos";
import type { CartLine } from "@/features/ws04-pos-order/types";
import type { OfflineCart } from "./price";
import type { OfflineQueue } from "./queue";

export type OfflineSaved = {
  event: OfflineSaleEvent;
  receiptNumber: string;
  changeIdr: number;
};

/** Queues the sale with its `L` number on this tablet; nothing else. */
export async function saveOfflineSale(
  queue: Pick<OfflineQueue, "recordSale">,
  kit: Pick<PosOfflineKit, "receiptRun">,
  cart: OfflineCart,
  tender: OfflineSaleTender,
): Promise<OfflineSaved> {
  const event = await queue.recordSale(cart, [tender]);
  return {
    event,
    receiptNumber: offlineReceiptNumber(kit, event.sequenceNumber),
    changeIdr:
      tender.method === "cash" ? tender.receivedIdr - tender.amountIdr : 0,
  };
}

/** The cart lines as an offline sale: list price comes from the kit. */
export function offlineCartOf(
  serviceType: "dine_in" | "takeaway",
  lines: readonly CartLine[],
): OfflineCart {
  return {
    serviceType,
    lines: lines.map((line) => ({
      menuItemId: line.menuItemId,
      variantId: line.variantId,
      quantity: line.quantity,
      modifierIds: line.modifiers.map((modifier) => modifier.optionId),
    })),
  };
}

/** `L1-000043`: the run prefix and the number, as the cloud stores it. */
export function offlineReceiptNumber(
  kit: Pick<PosOfflineKit, "receiptRun"> | null,
  sequenceNumber: number,
): string {
  const number = String(sequenceNumber).padStart(6, "0");
  return kit ? `${kit.receiptRun.prefix}-${number}` : number;
}

/** Cash of these sales: it is in the drawer, not yet in the cloud. */
export function cashOf(events: readonly OfflineSaleEvent[]): number {
  return events.reduce(
    (sum, event) =>
      sum +
      event.tenders
        .filter((tender) => tender.method === "cash")
        .reduce((part, tender) => part + tender.amountIdr, 0),
    0,
  );
}

/** One tender for the whole total; null while the input is not complete. */
export function tenderOf(
  method: "cash" | "edc_card",
  totalIdr: number,
  input: { receivedIdr: number | null; reference: string },
): OfflineSaleTender | null {
  if (totalIdr <= 0) return null;
  if (method === "cash")
    return input.receivedIdr !== null && input.receivedIdr >= totalIdr
      ? {
          method,
          amountIdr: idr(totalIdr),
          receivedIdr: idr(input.receivedIdr),
        }
      : null;
  const reference = input.reference.trim();
  return reference ? { method, amountIdr: idr(totalIdr), reference } : null;
}

/** Quick cash amounts: exact, then the next round notes above the total. */
export function quickCash(totalIdr: number): number[] {
  const out = new Set<number>([totalIdr]);
  for (const step of [5_000, 50_000, 100_000]) {
    const next = Math.ceil(totalIdr / step) * step;
    if (next > totalIdr) out.add(next);
  }
  return [...out].sort((a, b) => a - b).slice(0, 3);
}
