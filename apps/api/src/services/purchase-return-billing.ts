// Pure money math of a purchase return against supplier invoices (bead
// legend-65mgw, price variance legend-5b7uf). No database, no I/O: the return
// service feeds rows in, and the read-only variance check
// (scripts/purchase-return-variance-check.ts, legend-eestb) feeds the same
// helpers to recompute what an older return should have stored. Moved out of
// purchase-return.service.ts unchanged; the service wraps calls in
// `guardMoneyMath` so a RangeError still becomes a 422.

import { divideRounded, parseDecimal4 } from "@starter/shared/core";

/** Same mode as `ROUNDING_MODE` in inventory-ops.shared.ts (kept here so this file stays import-light). */
const ROUNDING_MODE = "half_up" as const;

export type ReturnLineInput = {
  purchaseOrderLineId: string;
  quantity: bigint;
  lineValueIdr: number;
};

export type InvoicedPart = {
  purchaseOrderLineId: string;
  before: bigint;
  part: bigint;
  accepted: bigint;
  poUnits: bigint;
};

export type ReturnQuantityTotals = {
  /** Billed (matched/released) PO units per PO line. */
  invoicedPo: ReadonlyMap<string, bigint>;
  /** Accepted PO units per PO line over all receipts. */
  acceptedPo: ReadonlyMap<string, bigint>;
  /** Accepted base units per PO line over all receipts. */
  acceptedBase: ReadonlyMap<string, bigint>;
  /** Base units already returned per PO line (earlier returns). */
  returnedBase: ReadonlyMap<string, bigint>;
};

/**
 * Not-invoiced-first split per PO line: the return first takes the quantity no
 * invoice bills (uninvoiced), the rest is the invoiced part.
 */
export function splitReturnLines(
  lines: readonly ReturnLineInput[],
  totals: ReturnQuantityTotals,
): {
  uninvoicedValueIdr: number;
  invoicedValueIdr: number;
  invoicedParts: InvoicedPart[];
} {
  let uninvoicedValueIdr = 0;
  let invoicedValueIdr = 0;
  const invoicedParts: InvoicedPart[] = [];
  for (const line of lines) {
    const accepted = totals.acceptedBase.get(line.purchaseOrderLineId) ?? 0n;
    const poUnits = totals.acceptedPo.get(line.purchaseOrderLineId) ?? 0n;
    const billedBase =
      poUnits > 0n
        ? divideRounded(
            (totals.invoicedPo.get(line.purchaseOrderLineId) ?? 0n) * accepted,
            poUnits,
            ROUNDING_MODE,
          )
        : 0n;
    // Received, not billed, and not already taken by an earlier return.
    const open =
      accepted -
      billedBase -
      (totals.returnedBase.get(line.purchaseOrderLineId) ?? 0n);
    const notBilled = open > 0n ? open : 0n;
    const take = line.quantity < notBilled ? line.quantity : notBilled;
    // Earlier returns took the not-billed quantity first, the rest of them
    // was billed; this return's billed part follows it.
    const returned = totals.returnedBase.get(line.purchaseOrderLineId) ?? 0n;
    const openBefore = accepted - billedBase;
    const priorNotBilled =
      openBefore <= 0n ? 0n : returned < openBefore ? returned : openBefore;
    invoicedParts.push({
      purchaseOrderLineId: line.purchaseOrderLineId,
      before: returned - priorNotBilled,
      part: line.quantity - take,
      accepted,
      poUnits,
    });
    const lineUninvoiced = Number(
      divideRounded(
        BigInt(line.lineValueIdr) * take,
        line.quantity,
        ROUNDING_MODE,
      ),
    );
    uninvoicedValueIdr += lineUninvoiced;
    invoicedValueIdr += line.lineValueIdr - lineUninvoiced;
  }
  return { uninvoicedValueIdr, invoicedValueIdr, invoicedParts };
}

export type BillingInvoice = {
  id: string;
  totalIdr: number;
  ppnIdr: number;
};

export type BillingInvoiceLine = {
  purchaseInvoiceId: string;
  purchaseOrderLineId: string | null;
  quantity: string;
  lineTotalIdr: number;
};

/**
 * Billed value and PPN of the invoiced parts. `invoices` must be in (date, id)
 * order. `creditedPpnBeforeIdr` is the PPN earlier returns of the PO already
 * credited. Throws `ReturnExceedsPayableError` when invoice slots run out.
 */
export function computeReturnBilling(input: {
  invoices: readonly BillingInvoice[];
  invoiceLineRows: readonly BillingInvoiceLine[];
  invoicedParts: readonly InvoicedPart[];
  creditedPpnBeforeIdr: number;
}): { ppnIdr: number; billedIdr: bigint } {
  const { invoices, invoiceLineRows } = input;
  type Slot = {
    invoice: BillingInvoice;
    base: bigint;
    billedIdr: bigint;
  };
  const invoiceIndex = new Map(
    invoices.map((invoice, index) => [invoice.id, index]),
  );
  const delta = new Map<string, { before: bigint; after: bigint }>();
  for (const part of input.invoicedParts) {
    if (part.part === 0n || part.poUnits === 0n) continue;
    const perInvoice = new Map<string, { qtyPo: bigint; totalIdr: bigint }>();
    for (const row of invoiceLineRows) {
      if (row.purchaseOrderLineId !== part.purchaseOrderLineId) continue;
      const current = perInvoice.get(row.purchaseInvoiceId) ?? {
        qtyPo: 0n,
        totalIdr: 0n,
      };
      current.qtyPo += parseDecimal4(row.quantity);
      current.totalIdr += BigInt(row.lineTotalIdr);
      perInvoice.set(row.purchaseInvoiceId, current);
    }
    const slots: Slot[] = [...perInvoice]
      .sort(([a], [b]) => invoiceIndex.get(a)! - invoiceIndex.get(b)!)
      .map(([invoiceId, row]) => ({
        invoice: invoices[invoiceIndex.get(invoiceId)!]!,
        base: divideRounded(
          row.qtyPo * part.accepted,
          part.poUnits,
          ROUNDING_MODE,
        ),
        billedIdr: row.totalIdr,
      }));
    let priorLeft = part.before;
    let wanted = part.part;
    for (const slot of slots) {
      const used = priorLeft < slot.base ? priorLeft : slot.base;
      priorLeft -= used;
      const room = slot.base - used;
      const taken = wanted < room ? wanted : room;
      wanted -= taken;
      if (taken === 0n) continue;
      // Billed value of the consumed quantity of this invoice line.
      const valueOf = (qty: bigint) =>
        divideRounded(slot.billedIdr * qty, slot.base, ROUNDING_MODE);
      const entry = delta.get(slot.invoice.id) ?? { before: 0n, after: 0n };
      entry.before += valueOf(used);
      entry.after += valueOf(used + taken);
      delta.set(slot.invoice.id, entry);
    }
    // Invoice slots used up but part of the return is still unbilled: the
    // billed value would come out short and the supplier be debited too
    // little. Refuse instead of silently favoring the supplier. Each slot
    // base is rounded on its own (at most 1 scaled unit off), so a line
    // spread over several invoices may leave that crumb: not a refusal.
    if (wanted > BigInt(slots.length)) throw new ReturnExceedsPayableError();
  }
  let ppn = 0n;
  let billed = 0n;
  for (const [invoiceId, entry] of delta) {
    billed += entry.after - entry.before;
    const invoice = invoices[invoiceIndex.get(invoiceId)!]!;
    // DPP billed = total - PPN (goods + price variance + services).
    const dpp = BigInt(invoice.totalIdr) - BigInt(invoice.ppnIdr);
    if (dpp <= 0n) continue;
    const share = (value: bigint) =>
      divideRounded(BigInt(invoice.ppnIdr) * value, dpp, ROUNDING_MODE);
    ppn += share(entry.after) - share(entry.before);
  }
  // Rounding across lines of one invoice must never credit more PPN in total
  // than the PO's invoices carry.
  const creditedBefore = BigInt(input.creditedPpnBeforeIdr);
  const ceiling = invoices.reduce(
    (sum, invoice) => sum + BigInt(invoice.ppnIdr),
    0n,
  );
  const room = ceiling > creditedBefore ? ceiling - creditedBefore : 0n;
  return { ppnIdr: Number(ppn < room ? ppn : room), billedIdr: billed };
}

/** The return is worth more than the invoice slots still hold. */
export class ReturnExceedsPayableError extends Error {
  constructor() {
    super("The return is worth more than the supplier invoices still owed.");
  }
}

/** Billed minus order-price value of the invoiced part (signed). */
export function priceVarianceOf(
  billedIdr: bigint,
  invoicedValueIdr: number,
): number {
  return Number(billedIdr - BigInt(invoicedValueIdr));
}
