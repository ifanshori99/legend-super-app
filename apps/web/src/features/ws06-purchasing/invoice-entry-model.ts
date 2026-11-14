// Pure model of the supplier invoice entry form (bead legend-0xnm; PRD v1.7
// §3.18, §4 Alur I step 4). No React, no fetching.
//
// Money rule (founder 11 Nov 2026, "jangan sampai rugi"): PPN and PPh 23 are
// typed exactly as printed on the supplier's tax invoice and sent as the
// contract input. This module NEVER computes a total, DPP, tax, payable or
// variance; the server does that and the match preview shows its numbers.
import {
  formatDecimal4,
  idr,
  parseDecimal4,
  type Decimal4,
  type Idr,
} from "@starter/shared/core";
import { acceptedReceivedQuantity } from "@starter/shared/inventory";
import type {
  GoodsReceiptLine,
  PurchaseOrderLine,
  SupplierInvoiceLineKind,
} from "@starter/shared/inventory";
import { createSupplierInvoiceInputSchema } from "@starter/shared/inventory";

export type InvoiceLineDraft = {
  /** Local row key (never sent). */
  key: string;
  kind: SupplierInvoiceLineKind;
  /** Null for a service line. */
  purchaseOrderLineId: string | null;
  /** A PO line left out of the invoice is not sent. */
  included: boolean;
  description: string;
  /** Raw user text; parsed by `invoiceQuantityFromInput`. */
  quantity: string;
  /** Raw user text; parsed by `invoicePriceFromInput`. */
  unitPrice: string;
};

export type InvoiceFormValues = {
  outletId: string;
  supplierId: string;
  purchaseOrderId: string;
  number: string;
  invoiceDate: string;
  dueDate: string;
  lines: readonly InvoiceLineDraft[];
  /** Raw user text, whole rupiah, as printed on the tax invoice. */
  ppn: string;
  pph23: string;
};

export type InvoiceEntryErrorCode =
  | "required"
  | "invalidQuantity"
  | "invalidPrice"
  | "invalidAmount"
  | "dueBeforeInvoice"
  | "noLines"
  | "invalid";

export type InvoiceLineErrors = {
  description?: InvoiceEntryErrorCode;
  quantity?: InvoiceEntryErrorCode;
  unitPrice?: InvoiceEntryErrorCode;
};

export type InvoiceEntryErrors = {
  outletId?: InvoiceEntryErrorCode;
  supplierId?: InvoiceEntryErrorCode;
  purchaseOrderId?: InvoiceEntryErrorCode;
  number?: InvoiceEntryErrorCode;
  invoiceDate?: InvoiceEntryErrorCode;
  dueDate?: InvoiceEntryErrorCode;
  ppn?: InvoiceEntryErrorCode;
  pph23?: InvoiceEntryErrorCode;
  /** Whole-form problem (no included line, or a schema issue not tied to a field). */
  form?: InvoiceEntryErrorCode;
  /** Keyed by `InvoiceLineDraft.key`. */
  lines: Record<string, InvoiceLineErrors>;
};

export type CreateSupplierInvoicePayload = ReturnType<
  typeof createSupplierInvoiceInputSchema.parse
>;

export type BuildInvoiceResult =
  | { ok: true; payload: CreateSupplierInvoicePayload }
  | { ok: false; errors: InvoiceEntryErrors };

// ---- Input parsing ---------------------------------------------------------

/**
 * Indonesian number text for a Decimal4: dot = thousands, comma = decimal,
 * trailing zeros dropped. "12500.5000" → "12.500,5", "1.0000" → "1". Pure
 * string work (no float), and `decimalFromInput` reads it back to the same
 * value, so defaults round-trip.
 */
export function formatDecimalText(value: Decimal4 | string): string {
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = (
    negative ? value.slice(1) : value
  ).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const decimals = fraction.replace(/0+$/, "");
  return `${negative ? "\u2212" : ""}${grouped}${decimals === "" ? "" : `,${decimals}`}`;
}

/**
 * Unit price for display: "Rp 12.500,5" (no-break space, true minus). Keeps
 * the sub-rupiah digits that `Money` would round away.
 */
export function formatIdrDecimalText(value: Decimal4 | string): string {
  const text = formatDecimalText(value);
  return text.startsWith("\u2212")
    ? `\u2212Rp\u00a0${text.slice(1)}`
    : `Rp\u00a0${text}`;
}

const GROUPED_INTEGER = /^(?:\d+|[1-9]\d{0,2}(?:\.\d{3})+)$/;

/**
 * One reader for quantity and price (Indonesian format). Dot = thousands,
 * comma = decimal: "1.000" is 1000, "12,125" is 12.125, "1,500" is 1.5. A dot
 * that is not a thousands separator ("12.5", "1.50") is rejected, never
 * guessed. At most four decimals (Decimal4). "Rp" prefix and spaces ignored.
 */
function decimalFromInput(value: string): Decimal4 | null {
  const trimmed = value
    .trim()
    .replace(/^rp\.?\s*/i, "")
    .replace(/\s+/g, "");
  if (trimmed === "") return null;
  const [integerText = "", fractionText, ...rest] = trimmed.split(",");
  if (rest.length > 0 || !GROUPED_INTEGER.test(integerText)) return null;
  if (fractionText !== undefined && !/^\d{1,4}$/.test(fractionText))
    return null;
  const prepared = `${integerText.replace(/\./g, "")}${
    fractionText === undefined ? "" : `.${fractionText}`
  }`;
  if (!/^\d{1,10}(\.\d{1,4})?$/.test(prepared)) return null;
  return formatDecimal4(parseDecimal4(prepared));
}

/** Positive quantity, Indonesian format (see `decimalFromInput`). */
export function invoiceQuantityFromInput(value: string): Decimal4 | null {
  const parsed = decimalFromInput(value);
  return parsed !== null && parseDecimal4(parsed) > 0n ? parsed : null;
}

/** Non-negative unit price in rupiah, same format as the quantity. */
export function invoicePriceFromInput(value: string): Decimal4 | null {
  return decimalFromInput(value);
}

/**
 * Whole-rupiah tax amount as printed on the tax invoice. Empty means zero
 * (PPh 23 is usually absent); grouping dots are accepted, nothing else.
 */
export function invoiceAmountFromInput(value: string): Idr | null {
  const trimmed = value
    .trim()
    .replace(/^rp\.?\s*/i, "")
    .replace(/\s+/g, "");
  if (trimmed === "") return idr(0);
  const prepared = /^[1-9]\d{0,2}(\.\d{3})+$/.test(trimmed)
    ? trimmed.replace(/\./g, "")
    : trimmed;
  if (!/^\d+$/.test(prepared)) return null;
  const amount = Number(prepared);
  return Number.isSafeInteger(amount) ? idr(amount) : null;
}

// ---- Defaults --------------------------------------------------------------

/**
 * One draft per PO line: quantity defaults to what was accepted after QC
 * (INV-05), the price to the PO price. A line with nothing accepted starts
 * excluded. These are reference defaults the user may overwrite; the server
 * compares them against the PO and the receipts.
 */
export function goodsDraftsFromOrder(
  orderLines: readonly PurchaseOrderLine[],
  receiptLines: readonly Pick<
    GoodsReceiptLine,
    "purchaseOrderLineId" | "quantityReceived" | "quantityRejected"
  >[],
  describe: (line: PurchaseOrderLine) => string,
): InvoiceLineDraft[] {
  return orderLines.map((line) => {
    const accepted = acceptedReceivedQuantity(receiptLines, line.id);
    return {
      key: line.id,
      kind: "goods",
      purchaseOrderLineId: line.id,
      included: parseDecimal4(accepted) > 0n,
      description: describe(line),
      quantity: formatDecimalText(accepted),
      unitPrice: formatDecimalText(line.unitPriceIdr),
    };
  });
}

export function newServiceDraft(key: string): InvoiceLineDraft {
  return {
    key,
    kind: "service",
    purchaseOrderLineId: null,
    included: true,
    description: "",
    quantity: "1",
    unitPrice: "",
  };
}

/** Business date (YYYY-MM-DD) plus whole days; "" when the date is invalid. */
export function addDaysToBusinessDate(date: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return "";
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

// ---- Contract-shaped helpers ----------------------------------------------

export type SupplierInvoiceLinePayload = {
  purchaseOrderLineId: string | null;
  kind: SupplierInvoiceLineKind;
  description: string;
  quantity: Decimal4;
  unitPriceIdr: Decimal4;
};

/**
 * Contract-shaped lines for every PO line with something accepted after QC
 * (received − rejected, summed over all receipts, INV-05) at the PO price. A
 * PO line with nothing accepted is left out: an invoice line needs a positive
 * quantity. Reference defaults only; the server compares them to PO and
 * receipts.
 */
export function defaultInvoiceLines(input: {
  orderLines: readonly PurchaseOrderLine[];
  receiptLines: readonly Pick<
    GoodsReceiptLine,
    "purchaseOrderLineId" | "quantityReceived" | "quantityRejected"
  >[];
  itemNames: Readonly<Record<string, string>>;
}): SupplierInvoiceLinePayload[] {
  const lines: SupplierInvoiceLinePayload[] = [];
  for (const line of input.orderLines) {
    const accepted = acceptedReceivedQuantity(input.receiptLines, line.id);
    if (parseDecimal4(accepted) <= 0n) continue;
    lines.push({
      purchaseOrderLineId: line.id,
      kind: "goods",
      description: input.itemNames[line.inventoryItemId] ?? "",
      quantity: accepted,
      unitPriceIdr: line.unitPriceIdr,
    });
  }
  return lines;
}

/**
 * Zod result of the shared create-invoice schema. PPN and PPh 23 arrive as
 * typed text and pass through unchanged (blank = 0): never derived from the
 * lines. Text that is not whole rupiah is left as text so the schema rejects it
 * on `ppnIdr` / `pph23Idr`.
 */
export function buildSupplierInvoicePayload(draft: {
  outletId: string;
  supplierId: string;
  purchaseOrderId: string;
  number: string;
  invoiceDate: string;
  dueDate: string;
  lines: readonly SupplierInvoiceLinePayload[];
  ppnIdr: string;
  pph23Idr: string;
  idempotencyKey: string;
}) {
  return createSupplierInvoiceInputSchema.safeParse({
    ...draft,
    number: draft.number.trim(),
    lines: [...draft.lines],
    ppnIdr: invoiceAmountFromInput(draft.ppnIdr) ?? draft.ppnIdr,
    pph23Idr: invoiceAmountFromInput(draft.pph23Idr) ?? draft.pph23Idr,
  });
}

// ---- Payload ---------------------------------------------------------------

const FIELD_KEYS = [
  "outletId",
  "supplierId",
  "purchaseOrderId",
  "number",
  "invoiceDate",
  "dueDate",
] as const;

/**
 * Validate the form and build the contract input. Field checks run first so
 * each problem lands on its own field; the shared zod schema is the final gate
 * (anything it still rejects is reported on the form).
 */
export function buildInvoiceInput(
  values: InvoiceFormValues,
  idempotencyKey: string,
): BuildInvoiceResult {
  const errors: InvoiceEntryErrors = { lines: {} };
  let bad = false;
  const fail = () => {
    bad = true;
  };

  for (const key of FIELD_KEYS) {
    if (values[key].trim() === "") {
      errors[key] = "required";
      fail();
    }
  }
  if (
    !errors.invoiceDate &&
    !errors.dueDate &&
    values.dueDate < values.invoiceDate
  ) {
    errors.dueDate = "dueBeforeInvoice";
    fail();
  }

  const ppn = invoiceAmountFromInput(values.ppn);
  if (ppn === null) {
    errors.ppn = "invalidAmount";
    fail();
  }
  const pph23 = invoiceAmountFromInput(values.pph23);
  if (pph23 === null) {
    errors.pph23 = "invalidAmount";
    fail();
  }

  const included = values.lines.filter((line) => line.included);
  if (included.length === 0) {
    errors.form = "noLines";
    fail();
  }
  const lines: SupplierInvoiceLinePayload[] = [];
  for (const line of included) {
    const lineErrors: InvoiceLineErrors = {};
    const description = line.description.trim();
    if (description === "" || description.length > 200)
      lineErrors.description = "required";
    const quantity = invoiceQuantityFromInput(line.quantity);
    if (quantity === null) lineErrors.quantity = "invalidQuantity";
    const unitPrice = invoicePriceFromInput(line.unitPrice);
    if (unitPrice === null) lineErrors.unitPrice = "invalidPrice";
    if (Object.keys(lineErrors).length > 0) {
      errors.lines[line.key] = lineErrors;
      fail();
      continue;
    }
    lines.push({
      purchaseOrderLineId: line.purchaseOrderLineId,
      kind: line.kind,
      description,
      quantity: quantity as Decimal4,
      unitPriceIdr: unitPrice as Decimal4,
    });
  }
  if (bad) return { ok: false, errors };

  const parsed = buildSupplierInvoicePayload({
    outletId: values.outletId,
    supplierId: values.supplierId,
    purchaseOrderId: values.purchaseOrderId,
    number: values.number,
    invoiceDate: values.invoiceDate,
    dueDate: values.dueDate,
    lines,
    ppnIdr: values.ppn,
    pph23Idr: values.pph23,
    idempotencyKey,
  });
  if (parsed.success) return { ok: true, payload: parsed.data };

  for (const issue of parsed.error.issues) {
    const head = issue.path[0];
    if (head === "ppnIdr") errors.ppn = "invalidAmount";
    else if (head === "pph23Idr") errors.pph23 = "invalidAmount";
    else if (
      typeof head === "string" &&
      (FIELD_KEYS as readonly string[]).includes(head)
    )
      errors[head as (typeof FIELD_KEYS)[number]] = "invalid";
    else errors.form = "invalid";
  }
  return { ok: false, errors };
}
