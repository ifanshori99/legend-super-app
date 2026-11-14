// Supplier return of received goods (PRD v1.7 §3.18 "Retur Pembelian"; bead
// legend-65mgw; design docs/briefs/301b-sub-return-petty-design.md).
//
// - A return is recorded against ONE goods receipt. Every line names the PO
//   line it came from; its goods-receipt line is found through that PO line.
// - Quantities are in the item BASE unit (the unit of the stock ledger), not
//   the purchase unit of the PO line. The client must convert before sending.
// - Stock leaves at the RECEIPT cost per base unit, not the moving average, so
//   a full return clears exactly what the receipt put on GRNI.
// - Line value is cumulative: the value of all returns so far is the receipt
//   line value x returned base quantity / accepted base quantity, rounded once;
//   each return books the difference. Full return = receipt line value, exact.
// - The PO row of the receipt is locked FOR UPDATE first (the receipt itself is
//   immutable and cannot be locked by the app role), so two returns of one
//   receipt never run side by side and cannot over-return.
// - Not-invoiced-first split (docs/briefs/ws-purchasing-apar-design.md §6): per
//   PO line the return first consumes the quantity no matched/released supplier
//   invoice bills (`uninvoicedValueIdr`, Dr GRNI); the rest is
//   `invoicedValueIdr` (order-price value, what leaves stock) plus the
//   proportional PPN of the invoices it falls on. The debit note clears the
//   payable at the BILLED value: invoiced + `priceVarianceIdr` (signed, billed
//   minus order-price value, credited to 5105) + PPN (legend-5b7uf). A held
//   invoice has no AP and never counts as billed. A return whose debit note
//   exceeds what is still owed is refused (409 PURCHASE_RETURN_EXCEEDS_PAYABLE).
// - Numbering `RT/<YYYYMM>/<0001>` from `purchasing_document_sequences`.
// - Gate: while `PURCHASE_RETURN_POSTING_ENABLED` is off, every POST is refused
//   (403 FEATURE_DISABLED) before anything is claimed or written. Stock would
//   leave without a journal and split the GL from the stock ledger.
//   `legend-29vw` (goods-receipt journal) turns it on. GET stays open.
// - Event `purchase_return.recorded` goes through the transactional outbox.

import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { AccessError, type PermissionCode } from "@starter/shared/access";
import {
  businessDateOf,
  CoreError,
  createUlid,
  type Decimal4,
  divideRounded,
  encodeCursor,
  extendCostIdr,
  formatDecimal4,
  idr,
  parseDecimal4,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  assertPurchaseReturnWithinReceipt,
  PurchasingError,
  purchaseReturnDetailSchema,
  purchaseReturnSchema,
  purchasingEvents,
  type createPurchaseReturnInputSchema,
  type purchaseReturnQuerySchema,
  type PurchaseReturn,
  type PurchaseReturnDetail,
  type PurchaseReturnLine,
} from "@starter/shared/inventory";
import { isModuleEnabled } from "@starter/shared/platform";
import type { z } from "zod";
import { env } from "../config/env.ts";
import { db } from "../db/index.ts";
import {
  accountingOpenItemSettlements,
  accountingOpenItems,
} from "../db/schema/accounting-ap-fa.ts";
import { autoJournalParked } from "../db/schema/accounting-auto-journal.ts";
import { journalEntries } from "../db/schema/accounting.ts";
import { tenants } from "../db/schema/index.ts";
import {
  goodsReceiptLines,
  goodsReceipts,
} from "../db/schema/inventory-receiving.ts";
import { stockBalances, stockLocations } from "../db/schema/inventory.ts";
import {
  purchaseReturnLines,
  purchaseReturns,
} from "../db/schema/purchase-returns.ts";
import {
  purchaseInvoiceLines,
  purchaseInvoices,
  purchaseOrders,
  purchasingDocumentSequences,
} from "../db/schema/purchasing.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { appendOutbox } from "./core-outbox.ts";
import { baseUnitCost } from "./inventory-receiving.service.ts";
import { recordStockMovementInTransaction } from "./inventory.service.ts";
import {
  assertOutlet,
  cursorInstant,
  cursorKeys,
  cursorUuid,
  EVENT_DESTINATION,
  insufficientStock,
  loadOutletClock,
  lockLocations,
  outletTarget,
  recordOpsAudit,
  requestFingerprint,
  requireOpsPermission,
  ROUNDING_MODE,
  translateInventoryError,
  type CursorPage,
  type Tx,
} from "./inventory-ops.shared.ts";
import { accessSnapshotInTransaction } from "./permission-resolver.ts";
import {
  claimPurchasingIdempotency,
  completePurchasingIdempotency,
  guardMoneyMath,
  translatePurchasingError,
} from "./purchasing-flow.shared.ts";

export type CreatePurchaseReturnInput = z.infer<
  typeof createPurchaseReturnInputSchema
>;
export type PurchaseReturnQuery = z.infer<typeof purchaseReturnQuerySchema>;

const CREATE_OPERATION = "purchase_return.create";
const CREATE_PERMISSION = "purchasing.return.create";
const RETURN_AUDIT_FIELDS = [
  "number",
  "goodsReceiptId",
  "purchaseOrderId",
  "supplierId",
  "reason",
  "returnedOn",
  "lineCount",
  "valueIdr",
] as const;

/** Reads: the return permission or invoice matching (fail closed). */
export const PURCHASE_RETURN_READ_PERMISSIONS: readonly PermissionCode[] = [
  CREATE_PERMISSION,
  "purchasing.invoice.match",
];

export const PURCHASE_RETURN_DISABLED_MESSAGE =
  "Retur pembelian belum aktif sampai jurnal penerimaan barang (legend-29vw) berjalan";

let postingEnabledOverride: boolean | null = null;

/** Test seam: `null` goes back to the env flag. */
export function setPurchaseReturnPostingEnabled(enabled: boolean | null): void {
  postingEnabledOverride = enabled;
}

function postingEnabled(): boolean {
  return postingEnabledOverride ?? env.PURCHASE_RETURN_POSTING_ENABLED;
}

type ReturnRow = typeof purchaseReturns.$inferSelect;
type ReturnLineRow = typeof purchaseReturnLines.$inferSelect;
type ReceiptLineRow = typeof goodsReceiptLines.$inferSelect;

function invalid(message: string): HttpError {
  return new HttpError(422, "VALIDATION_ERROR", message);
}

function toReturn(row: ReturnRow): PurchaseReturn {
  return purchaseReturnSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    supplierId: row.supplierId,
    purchaseOrderId: row.purchaseOrderId,
    goodsReceiptId: row.goodsReceiptId,
    number: row.number,
    returnedOn: row.returnedOn,
    returnedBy: row.returnedBy,
    reason: row.reason,
    valueIdr: row.valueIdr,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  });
}

function toLine(row: ReturnLineRow) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    purchaseReturnId: row.purchaseReturnId,
    inventoryItemId: row.inventoryItemId,
    purchaseOrderLineId: row.purchaseOrderLineId,
    quantity: row.quantity,
    unitCostIdr: row.unitCostIdr,
    lineValueIdr: row.lineValueIdr,
    batchCode: row.batchCode,
  };
}

async function detailOf(tx: Tx, row: ReturnRow): Promise<PurchaseReturnDetail> {
  const lines = await tx
    .select()
    .from(purchaseReturnLines)
    .where(
      and(
        eq(purchaseReturnLines.tenantId, row.tenantId),
        eq(purchaseReturnLines.purchaseReturnId, row.id),
      ),
    )
    .orderBy(asc(purchaseReturnLines.lineNo));
  return purchaseReturnDetailSchema.parse({
    purchaseReturn: toReturn(row),
    lines: lines.map(toLine),
  });
}

/** `RT/<YYYYMM>/<0001>`: next value of the tenant's monthly counter. */
async function nextRtNumber(
  tx: Tx,
  context: ScopedTenantContext,
  businessDate: string,
): Promise<string> {
  const period = `${businessDate.slice(0, 4)}${businessDate.slice(5, 7)}`;
  const [row] = await tx
    .insert(purchasingDocumentSequences)
    .values({
      tenantId: context.tenant.tenantId,
      kind: "RT",
      period,
      lastValue: 1,
    })
    .onConflictDoUpdate({
      target: [
        purchasingDocumentSequences.tenantId,
        purchasingDocumentSequences.kind,
        purchasingDocumentSequences.period,
      ],
      set: {
        lastValue: sql`${purchasingDocumentSequences.lastValue} + 1`,
      },
    })
    .returning({ value: purchasingDocumentSequences.lastValue });
  return `RT/${period}/${String(row!.value).padStart(4, "0")}`;
}

function canonicalInput(input: CreatePurchaseReturnInput) {
  return {
    outletId: input.outletId,
    supplierId: input.supplierId,
    purchaseOrderId: input.purchaseOrderId ?? null,
    goodsReceiptId: input.goodsReceiptId ?? null,
    returnedOn: input.returnedOn,
    reason: input.reason,
    note: input.note ?? null,
    lines: input.lines.map((line) => ({
      purchaseOrderLineId: line.purchaseOrderLineId ?? null,
      inventoryItemId: line.inventoryItemId,
      quantity: formatDecimal4(parseDecimal4(line.quantity)),
      locationId: line.locationId,
      batchCode: line.batchCode ?? null,
    })),
  };
}

function acceptedOf(line: ReceiptLineRow) {
  return formatDecimal4(
    parseDecimal4(line.quantityReceived) - parseDecimal4(line.quantityRejected),
  );
}

async function assertLocations(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  locationIds: readonly string[],
): Promise<void> {
  const unique = [...new Set(locationIds)];
  const rows = await tx
    .select({ id: stockLocations.id })
    .from(stockLocations)
    .where(
      and(
        eq(stockLocations.tenantId, context.tenant.tenantId),
        eq(stockLocations.outletId, outletId),
        inArray(stockLocations.id, unique),
      ),
    );
  if (rows.length !== unique.length)
    throw invalid("A stock location does not belong to this outlet.");
}

type ReturnSplit = {
  uninvoicedValueIdr: number;
  invoicedValueIdr: number;
  /** Signed: billed value minus order-price value of the invoiced part. */
  priceVarianceIdr: number;
  ppnIdr: number;
};

/**
 * Not-invoiced-first split of a return (design §6). Runs under the PO lock, so
 * the earlier returns it reads are final. Quantities are base units; invoice
 * lines are in the PO unit and are converted with the PO line's accepted
 * base/PO ratio over all its receipts.
 */
async function splitReturnAgainstInvoices(
  tx: Tx,
  tenantId: TenantId,
  purchaseOrderId: string,
  lines: readonly {
    purchaseOrderLineId: string;
    quantity: bigint;
    lineValueIdr: number;
  }[],
): Promise<ReturnSplit> {
  const unsplit = (): ReturnSplit => ({
    uninvoicedValueIdr: lines.reduce((sum, line) => sum + line.lineValueIdr, 0),
    invoicedValueIdr: 0,
    priceVarianceIdr: 0,
    ppnIdr: 0,
  });
  // A held or rejected invoice has no AP: only matched/released are billed.
  const invoices = await tx
    .select()
    .from(purchaseInvoices)
    .where(
      and(
        eq(purchaseInvoices.tenantId, tenantId),
        eq(purchaseInvoices.purchaseOrderId, purchaseOrderId),
        inArray(purchaseInvoices.status, ["matched", "released"]),
      ),
    )
    .orderBy(asc(purchaseInvoices.invoiceDate), asc(purchaseInvoices.id));
  if (invoices.length === 0) return unsplit();

  const poLineIds = lines.map((line) => line.purchaseOrderLineId);
  const invoiceLineRows = await tx
    .select({
      purchaseInvoiceId: purchaseInvoiceLines.purchaseInvoiceId,
      purchaseOrderLineId: purchaseInvoiceLines.purchaseOrderLineId,
      quantity: purchaseInvoiceLines.quantity,
      lineTotalIdr: purchaseInvoiceLines.lineTotalIdr,
    })
    .from(purchaseInvoiceLines)
    .where(
      and(
        eq(purchaseInvoiceLines.tenantId, tenantId),
        inArray(
          purchaseInvoiceLines.purchaseInvoiceId,
          invoices.map((invoice) => invoice.id),
        ),
        eq(purchaseInvoiceLines.kind, "goods"),
        inArray(purchaseInvoiceLines.purchaseOrderLineId, poLineIds),
      ),
    );
  const receiptRows = await tx
    .select({
      purchaseOrderLineId: goodsReceiptLines.purchaseOrderLineId,
      quantityReceived: goodsReceiptLines.quantityReceived,
      quantityRejected: goodsReceiptLines.quantityRejected,
      acceptedBaseQuantity: goodsReceiptLines.acceptedBaseQuantity,
    })
    .from(goodsReceiptLines)
    .where(
      and(
        eq(goodsReceiptLines.tenantId, tenantId),
        inArray(goodsReceiptLines.purchaseOrderLineId, poLineIds),
      ),
    );
  const returnedRows = await tx
    .select({
      purchaseOrderLineId: purchaseReturnLines.purchaseOrderLineId,
      quantity: purchaseReturnLines.quantity,
    })
    .from(purchaseReturnLines)
    .where(
      and(
        eq(purchaseReturnLines.tenantId, tenantId),
        inArray(purchaseReturnLines.purchaseOrderLineId, poLineIds),
      ),
    );
  const sumBy = <T extends { purchaseOrderLineId: string | null }>(
    rows: readonly T[],
    amount: (row: T) => bigint,
  ) => {
    const totals = new Map<string, bigint>();
    for (const row of rows)
      if (row.purchaseOrderLineId)
        totals.set(
          row.purchaseOrderLineId,
          (totals.get(row.purchaseOrderLineId) ?? 0n) + amount(row),
        );
    return totals;
  };
  const invoicedPo = sumBy(invoiceLineRows, (row) =>
    parseDecimal4(row.quantity),
  );
  const acceptedPo = sumBy(
    receiptRows,
    (row) =>
      parseDecimal4(row.quantityReceived) - parseDecimal4(row.quantityRejected),
  );
  const acceptedBase = sumBy(receiptRows, (row) =>
    parseDecimal4(row.acceptedBaseQuantity),
  );
  const returnedBase = sumBy(returnedRows, (row) =>
    parseDecimal4(row.quantity),
  );

  const split = guardMoneyMath(() => {
    let uninvoicedValueIdr = 0;
    let invoicedValueIdr = 0;
    const invoicedParts: {
      purchaseOrderLineId: string;
      before: bigint;
      part: bigint;
      accepted: bigint;
      poUnits: bigint;
    }[] = [];
    for (const line of lines) {
      const accepted = acceptedBase.get(line.purchaseOrderLineId) ?? 0n;
      const poUnits = acceptedPo.get(line.purchaseOrderLineId) ?? 0n;
      const billedBase =
        poUnits > 0n
          ? divideRounded(
              (invoicedPo.get(line.purchaseOrderLineId) ?? 0n) * accepted,
              poUnits,
              ROUNDING_MODE,
            )
          : 0n;
      // Received, not billed, and not already taken by an earlier return.
      const open =
        accepted -
        billedBase -
        (returnedBase.get(line.purchaseOrderLineId) ?? 0n);
      const notBilled = open > 0n ? open : 0n;
      const take = line.quantity < notBilled ? line.quantity : notBilled;
      // Earlier returns took the not-billed quantity first, the rest of them
      // was billed; this return's billed part follows it.
      const returned = returnedBase.get(line.purchaseOrderLineId) ?? 0n;
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
  });
  if (split.invoicedValueIdr === 0)
    return {
      uninvoicedValueIdr: split.uninvoicedValueIdr,
      invoicedValueIdr: 0,
      priceVarianceIdr: 0,
      ppnIdr: 0,
    };

  // A billed part needs a debit note against the AP open item. With the
  // accounting module off no AP exists to reduce, so refuse (R1, design §13).
  const [tenantRow] = await tx
    .select({ featureFlags: tenants.featureFlags })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!isModuleEnabled(tenantRow?.featureFlags ?? null, "accounting"))
    throw new PurchasingError(
      "SUPPLIER_INVOICE_POSTING_DISABLED",
      "The return has an invoiced part, but supplier payables are not enabled for this tenant.",
    );

  // Payable check below needs the earlier returns of this PO.
  const priorReturns = await tx
    .select({
      id: purchaseReturns.id,
      invoicedValueIdr: purchaseReturns.invoicedValueIdr,
      priceVarianceIdr: purchaseReturns.priceVarianceIdr,
      ppnIdr: purchaseReturns.ppnIdr,
    })
    .from(purchaseReturns)
    .where(
      and(
        eq(purchaseReturns.tenantId, tenantId),
        eq(purchaseReturns.purchaseOrderId, purchaseOrderId),
      ),
    );
  // PPN goes to the invoices that actually bill the returned PO line. Per PO
  // line, the invoices holding it are filled in (date, id) order: earlier
  // returns used the first part, this return takes the next. Per invoice the
  // PPN is the cumulative share of its billed value consumed so far, so the
  // sum over all returns never passes the invoice's PPN.
  // The same slots give the billed value of the returned quantity (the
  // invoice line totals consumed), which the debit note clears.
  const billing = guardMoneyMath(() => {
    type Slot = {
      invoice: (typeof invoices)[number];
      base: bigint;
      billedIdr: bigint;
    };
    const invoiceIndex = new Map(
      invoices.map((invoice, index) => [invoice.id, index]),
    );
    const delta = new Map<string, { before: bigint; after: bigint }>();
    for (const part of split.invoicedParts) {
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
      if (wanted > BigInt(slots.length))
        throw new PurchasingError(
          "PURCHASE_RETURN_EXCEEDS_PAYABLE",
          "The return is worth more than the supplier invoices still owed.",
        );
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
    const creditedBefore = priorReturns.reduce(
      (sum, row) => sum + BigInt(row.ppnIdr),
      0n,
    );
    const ceiling = invoices.reduce(
      (sum, invoice) => sum + BigInt(invoice.ppnIdr),
      0n,
    );
    const room = ceiling > creditedBefore ? ceiling - creditedBefore : 0n;
    return { ppnIdr: Number(ppn < room ? ppn : room), billedIdr: billed };
  });
  const { ppnIdr } = billing;
  // Billed minus order-price value of the invoiced part (signed). Billed is
  // never negative, so invoiced + variance (the debit note base) is too.
  const priceVarianceIdr = guardMoneyMath(() =>
    Number(billing.billedIdr - BigInt(split.invoicedValueIdr)),
  );

  // Refuse a debit note larger than what is still owed on this PO's invoices.
  // Earlier returns whose debit note the consumer has not booked yet count as
  // already taken, so two quick returns cannot both pass.
  const openItems = await tx
    .select({
      originalIdr: accountingOpenItems.originalIdr,
      settledIdr: accountingOpenItems.settledIdr,
    })
    .from(accountingOpenItems)
    .where(
      and(
        eq(accountingOpenItems.tenantId, tenantId),
        eq(accountingOpenItems.kind, "payable"),
        inArray(
          accountingOpenItems.id,
          invoices.map((invoice) => invoice.id),
        ),
      ),
    );
  // legend-3fi5v: only a debit note that will still land on the payable keeps
  // room reserved. Settled ones are already inside the open item outstanding;
  // one parked non-retryable (`retryable = false`) has reduced nothing and is
  // not counted. Pending and retryable-parked ones (mapping missing, period
  // closed) post on their own later, so they stay reserved: else two quick
  // returns could both pass and the supplier be paid for goods already returned.
  const debitReturns = priorReturns.filter(
    (row) => row.invoicedValueIdr + row.priceVarianceIdr + row.ppnIdr > 0,
  );
  let reservedDebit = 0;
  if (debitReturns.length > 0) {
    const returnIds = debitReturns.map((row) => row.id);
    const settled = await tx
      .select({ sourceId: accountingOpenItemSettlements.sourceId })
      .from(accountingOpenItemSettlements)
      .where(
        and(
          eq(accountingOpenItemSettlements.tenantId, tenantId),
          eq(accountingOpenItemSettlements.kind, "payable"),
          eq(accountingOpenItemSettlements.method, "debit_note"),
          inArray(accountingOpenItemSettlements.sourceId, returnIds),
        ),
      );
    const failed = await tx
      .select({ idempotencyKey: autoJournalParked.idempotencyKey })
      .from(autoJournalParked)
      .where(
        and(
          eq(autoJournalParked.tenantId, tenantId),
          eq(autoJournalParked.retryable, false),
          inArray(
            autoJournalParked.idempotencyKey,
            returnIds.map((id) => `aj:purchase-return:${id}`),
          ),
        ),
      );
    const settledIds = new Set(settled.map((row) => row.sourceId));
    const failedKeys = new Set(failed.map((row) => row.idempotencyKey));
    reservedDebit = debitReturns
      .filter(
        (row) =>
          !settledIds.has(row.id) &&
          !failedKeys.has(`aj:purchase-return:${row.id}`),
      )
      .reduce(
        (sum, row) =>
          sum + row.invoicedValueIdr + row.priceVarianceIdr + row.ppnIdr,
        0,
      );
  }
  const owed =
    openItems.reduce((sum, row) => sum + row.originalIdr - row.settledIdr, 0) -
    reservedDebit;
  if (split.invoicedValueIdr + priceVarianceIdr + ppnIdr > owed)
    throw new PurchasingError(
      "PURCHASE_RETURN_EXCEEDS_PAYABLE",
      "The return is worth more than the supplier invoices still owed.",
    );
  return {
    uninvoicedValueIdr: split.uninvoicedValueIdr,
    invoicedValueIdr: split.invoicedValueIdr,
    priceVarianceIdr,
    ppnIdr,
  };
}

async function appendReturnRecordedEvent(
  tx: Tx,
  context: ScopedTenantContext,
  row: ReturnRow,
  movingAvgVarianceIdr: number,
): Promise<void> {
  const name = "purchase_return.recorded";
  const returnedAt = row.returnedAt.toISOString();
  const event = purchasingEvents[name].envelopeSchema.parse({
    id: createUlid(row.returnedAt.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: row.outletId,
    name,
    version: 1,
    aggregateType: "purchase_return",
    aggregateId: row.id,
    sequence: 1,
    occurredAt: returnedAt,
    actor: { type: "user", id: row.returnedBy },
    deviceId: null,
    idempotencyKey: `${name}:${row.id}:1`,
    payloadSchemaRef: `${name}.v1`,
    payload: {
      purchaseReturnId: row.id,
      supplierId: row.supplierId,
      outletId: row.outletId,
      number: row.number,
      valueIdr: row.valueIdr,
      uninvoicedValueIdr: row.uninvoicedValueIdr,
      invoicedValueIdr: row.invoicedValueIdr,
      returnPriceVarianceIdr: row.priceVarianceIdr,
      movingAvgVarianceIdr,
      ppnIdr: row.ppnIdr,
      returnedBy: row.returnedBy,
      returnedAt,
    },
  });
  await appendOutbox(tx, context, {
    id: createUlid(),
    event,
    destination: EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
}

/**
 * POST purchase return. Needs `purchasing.return.create` at the outlet. Takes
 * the stock out, writes the nota retur and the event in one transaction; a
 * retry with the same key replays the first return. Refused with
 * FEATURE_DISABLED while the posting gate is off.
 */
export async function createPurchaseReturn(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreatePurchaseReturnInput,
): Promise<PurchaseReturnDetail> {
  assertOutlet(context, input.outletId);
  // Before the idempotency claim: a refused request leaves no trace.
  if (!postingEnabled())
    throw new CoreError("FEATURE_DISABLED", PURCHASE_RETURN_DISABLED_MESSAGE);
  const claim = {
    operation: CREATE_OPERATION,
    key: input.idempotencyKey,
    outletId: input.outletId,
    fingerprint: requestFingerprint(
      CREATE_OPERATION,
      actorUserId,
      canonicalInput(input),
    ),
  };
  try {
    return await withTenant(db, context, async (tx) => {
      await requireOpsPermission(
        tx,
        context,
        actorUserId,
        CREATE_PERMISSION,
        input.outletId,
      );
      const replay = await claimPurchasingIdempotency(tx, context, claim);
      if (replay) return purchaseReturnDetailSchema.parse(replay.replay);

      // The contract leaves these optional (manual adjustments); a return of
      // received goods needs them.
      if (!input.goodsReceiptId)
        throw invalid("A goods receipt is required for a purchase return.");
      const goodsReceiptId = input.goodsReceiptId;
      const lineInputs = input.lines.map((line) => {
        if (!line.purchaseOrderLineId)
          throw invalid("Every return line needs its purchase order line.");
        return { ...line, purchaseOrderLineId: line.purchaseOrderLineId };
      });
      const poLineIds = lineInputs.map((line) => line.purchaseOrderLineId);
      if (new Set(poLineIds).size !== poLineIds.length)
        throw invalid("A purchase order line appears twice in this return.");

      // The receipt is immutable (the app role has no UPDATE on it, so it
      // cannot be locked): read it, then lock its PO row FOR UPDATE, as goods
      // receipts do. Every return of this PO's receipts runs in turn.
      const [receipt] = await tx
        .select()
        .from(goodsReceipts)
        .where(
          and(
            eq(goodsReceipts.tenantId, context.tenant.tenantId),
            eq(goodsReceipts.id, goodsReceiptId),
          ),
        );
      if (
        !receipt ||
        receipt.outletId.toLowerCase() !== input.outletId.toLowerCase()
      )
        throw new HttpError(404, "NOT_FOUND", "Goods receipt not found.");
      if (receipt.supplierId.toLowerCase() !== input.supplierId.toLowerCase())
        throw invalid("The supplier does not match the goods receipt.");
      if (
        input.purchaseOrderId &&
        receipt.purchaseOrderId.toLowerCase() !==
          input.purchaseOrderId.toLowerCase()
      )
        throw invalid("The purchase order does not match the goods receipt.");

      // The PO row is the lock that serialises returns of one receipt; a
      // missing row means nothing is locked, so refuse instead of racing.
      const [lockedPo] = await tx
        .select({ id: purchaseOrders.id })
        .from(purchaseOrders)
        .where(
          and(
            eq(purchaseOrders.tenantId, context.tenant.tenantId),
            eq(purchaseOrders.id, receipt.purchaseOrderId),
          ),
        )
        .for("update");
      if (!lockedPo)
        throw new HttpError(404, "NOT_FOUND", "Purchase order not found.");

      const receiptLines = await tx
        .select()
        .from(goodsReceiptLines)
        .where(
          and(
            eq(goodsReceiptLines.tenantId, context.tenant.tenantId),
            eq(goodsReceiptLines.goodsReceiptId, receipt.id),
          ),
        );
      const receiptLineByPoLine = new Map(
        receiptLines.map((line) => [line.purchaseOrderLineId, line]),
      );
      const matched = lineInputs.map((line, index) => {
        const receiptLine = receiptLineByPoLine.get(line.purchaseOrderLineId);
        if (!receiptLine)
          throw invalid("A return line is not on this goods receipt.");
        if (
          receiptLine.inventoryItemId.toLowerCase() !==
          line.inventoryItemId.toLowerCase()
        )
          throw invalid("A return line item does not match the receipt line.");
        if (
          line.batchCode !== undefined &&
          line.batchCode !== null &&
          line.batchCode !== receiptLine.batchCode
        )
          throw invalid("A return line batch does not match the receipt line.");
        return { input: line, receiptLine, lineNo: index + 1 };
      });
      await assertLocations(
        tx,
        context,
        input.outletId,
        matched.map((line) => line.input.locationId),
      );

      // Earlier returns of the same receipt lines (serial: the PO row is locked).
      const priorRows = await tx
        .select({
          goodsReceiptLineId: purchaseReturnLines.goodsReceiptLineId,
          quantity: purchaseReturnLines.quantity,
          lineValueIdr: purchaseReturnLines.lineValueIdr,
        })
        .from(purchaseReturnLines)
        .where(
          and(
            eq(purchaseReturnLines.tenantId, context.tenant.tenantId),
            inArray(
              purchaseReturnLines.goodsReceiptLineId,
              matched.map((line) => line.receiptLine.id),
            ),
          ),
        );
      const priorQty = new Map<string, bigint>();
      const priorValue = new Map<string, bigint>();
      for (const prior of priorRows) {
        priorQty.set(
          prior.goodsReceiptLineId,
          (priorQty.get(prior.goodsReceiptLineId) ?? 0n) +
            parseDecimal4(prior.quantity),
        );
        priorValue.set(
          prior.goodsReceiptLineId,
          (priorValue.get(prior.goodsReceiptLineId) ?? 0n) +
            BigInt(prior.lineValueIdr),
        );
      }
      // Quantity limit per PO line: accepted base on the receipt vs returned.
      assertPurchaseReturnWithinReceipt(
        new Map(
          matched.map((line) => [
            line.input.purchaseOrderLineId,
            line.receiptLine.acceptedBaseQuantity,
          ]),
        ),
        new Map(
          matched.map((line) => [
            line.input.purchaseOrderLineId,
            formatDecimal4(priorQty.get(line.receiptLine.id) ?? 0n),
          ]),
        ),
        matched.map((line) => ({
          purchaseOrderLineId: line.input.purchaseOrderLineId,
          quantity: line.input.quantity,
        })) as unknown as Pick<
          PurchaseReturnLine,
          "purchaseOrderLineId" | "quantity"
        >[],
      );

      const now = new Date();
      const businessDate = businessDateOf(
        now,
        await loadOutletClock(tx, input.outletId),
      );
      if (input.returnedOn < receipt.receivedOn)
        throw invalid("The return date is before the goods receipt date.");
      if (input.returnedOn > businessDate)
        throw invalid("The return date is in the future.");

      const number = await nextRtNumber(tx, context, businessDate);
      const returnId = randomUUID();
      const lineRows = matched.map((line) => {
        const receiptLine = line.receiptLine;
        const quantity = parseDecimal4(line.input.quantity);
        const before = priorQty.get(receiptLine.id) ?? 0n;
        const acceptedBase = parseDecimal4(receiptLine.acceptedBaseQuantity);
        const { unitCostIdr, lineValueIdr } = guardMoneyMath(() => {
          const receiptLineValue = BigInt(
            extendCostIdr(
              acceptedOf(receiptLine),
              receiptLine.unitCostIdr,
              ROUNDING_MODE,
            ),
          );
          const cumulative = divideRounded(
            receiptLineValue * (before + quantity),
            acceptedBase,
            ROUNDING_MODE,
          );
          return {
            unitCostIdr: baseUnitCost(
              receiptLine.unitCostIdr,
              acceptedOf(receiptLine),
              receiptLine.acceptedBaseQuantity,
            ),
            lineValueIdr: idr(
              Number(cumulative - (priorValue.get(receiptLine.id) ?? 0n)),
            ),
          };
        });
        return {
          id: randomUUID(),
          tenantId: context.tenant.tenantId,
          outletId: input.outletId,
          purchaseReturnId: returnId,
          goodsReceiptLineId: receiptLine.id,
          purchaseOrderLineId: receiptLine.purchaseOrderLineId,
          inventoryItemId: receiptLine.inventoryItemId,
          locationId: line.input.locationId,
          batchId: receiptLine.batchId,
          batchCode: receiptLine.batchCode,
          quantity: formatDecimal4(quantity),
          unitCostIdr,
          lineValueIdr,
          lineNo: line.lineNo,
        };
      });
      const valueIdr = guardMoneyMath(() =>
        idr(lineRows.reduce((sum, line) => sum + line.lineValueIdr, 0)),
      );

      const split = await splitReturnAgainstInvoices(
        tx,
        context.tenant.tenantId,
        receipt.purchaseOrderId,
        lineRows.map((line) => ({
          purchaseOrderLineId: line.purchaseOrderLineId,
          quantity: parseDecimal4(line.quantity),
          lineValueIdr: line.lineValueIdr,
        })),
      );
      // Cutover guard (design §2.3): the not-invoiced part debits GRNI, which
      // only exists once the receipt's own journal is posted. No Dr GRNI
      // without a Cr GRNI; nothing has been written yet, so the refusal is clean.
      if (split.uninvoicedValueIdr > 0) {
        const [receiptJournal] = await tx
          .select({ id: journalEntries.id })
          .from(journalEntries)
          .where(
            and(
              eq(journalEntries.tenantId, context.tenant.tenantId),
              eq(
                journalEntries.idempotencyKey,
                `aj:goods-receipt:${receipt.id}`,
              ),
            ),
          )
          .limit(1);
        if (!receiptJournal)
          throw new PurchasingError(
            "GOODS_RECEIPT_NOT_JOURNALED",
            "The goods receipt journal is not posted yet; the return cannot be booked.",
          );
      }

      const [row] = await tx
        .insert(purchaseReturns)
        .values({
          id: returnId,
          tenantId: context.tenant.tenantId,
          outletId: input.outletId,
          goodsReceiptId: receipt.id,
          purchaseOrderId: receipt.purchaseOrderId,
          supplierId: receipt.supplierId,
          number,
          reason: input.reason,
          returnedOn: input.returnedOn,
          returnedAt: now,
          returnedBy: actorUserId,
          valueIdr,
          uninvoicedValueIdr: idr(split.uninvoicedValueIdr),
          invoicedValueIdr: idr(split.invoicedValueIdr),
          priceVarianceIdr: idr(split.priceVarianceIdr),
          ppnIdr: idr(split.ppnIdr),
          note: input.note ? input.note : null,
        })
        .returning();
      await tx.insert(purchaseReturnLines).values(lineRows);

      // Same lock order for every document (location, item, line): no deadlocks.
      const stockOrder = [...lineRows].sort(
        (a, b) =>
          a.locationId.localeCompare(b.locationId) ||
          a.inventoryItemId.localeCompare(b.inventoryItemId) ||
          a.lineNo - b.lineNo,
      );
      // The ledger helper lets a balance go negative; a return must not.
      await lockLocations(
        tx,
        context.tenant.tenantId,
        stockOrder.map((line) => line.locationId),
      );
      const wantedByStock = new Map<string, bigint>();
      for (const line of stockOrder) {
        const stockKey = `${line.locationId}:${line.inventoryItemId}`;
        wantedByStock.set(
          stockKey,
          (wantedByStock.get(stockKey) ?? 0n) + parseDecimal4(line.quantity),
        );
      }
      // Moving average of each balance before the return, read under the
      // location lock above. A return moves stock out at the receipt cost but
      // leaves the average alone, so it is valid for every line of that stock.
      const avgByStock = new Map<string, Decimal4>();
      for (const [stockKey, wanted] of wantedByStock) {
        const [locationId, itemId] = stockKey.split(":") as [string, string];
        const [balance] = await tx
          .select({
            quantity: stockBalances.quantity,
            avgCostIdr: stockBalances.avgCostIdr,
          })
          .from(stockBalances)
          .where(
            and(
              eq(stockBalances.tenantId, context.tenant.tenantId),
              eq(stockBalances.locationId, locationId),
              eq(stockBalances.inventoryItemId, itemId),
            ),
          );
        if (!balance || parseDecimal4(balance.quantity) < wanted)
          throw insufficientStock(itemId);
        avgByStock.set(stockKey, balance.avgCostIdr);
      }
      // D per line = value at receipt cost - round(qty x average before): the
      // GL inventory credit then equals what the sub-ledger drops (legend-uloj6).
      const movingAvgVarianceIdr = guardMoneyMath(() =>
        stockOrder.reduce(
          (sum, line) =>
            sum +
            line.lineValueIdr -
            extendCostIdr(
              line.quantity,
              avgByStock.get(`${line.locationId}:${line.inventoryItemId}`)!,
              ROUNDING_MODE,
            ),
          0,
        ),
      );
      for (const line of stockOrder)
        await recordStockMovementInTransaction(tx, context, {
          outletId: input.outletId,
          locationId: line.locationId,
          inventoryItemId: line.inventoryItemId,
          movementType: "return",
          quantity: formatDecimal4(-parseDecimal4(line.quantity)),
          unitCostIdr: line.unitCostIdr,
          batchId: line.batchId,
          sourceType: "purchase_return",
          sourceId: returnId,
          occurredAt: now.toISOString(),
          idempotencyKey: `purchase_return:${returnId}:${line.id}`,
          actor: { type: "user", id: actorUserId },
        });

      const detail = await detailOf(tx, row!);
      await recordOpsAudit(tx, context, {
        actorUserId,
        outletId: input.outletId,
        action: "purchasing.return_recorded",
        objectType: "purchase_return",
        objectId: returnId,
        before: null,
        after: {
          number,
          goodsReceiptId: receipt.id,
          purchaseOrderId: receipt.purchaseOrderId,
          supplierId: receipt.supplierId,
          reason: input.reason,
          returnedOn: input.returnedOn,
          lineCount: detail.lines.length,
          valueIdr,
        },
        safeFields: RETURN_AUDIT_FIELDS,
      });
      await appendReturnRecordedEvent(tx, context, row!, movingAvgVarianceIdr);
      await completePurchasingIdempotency(tx, context, claim, detail);
      return detail;
    });
  } catch (error) {
    throw translatePurchasingError(translateInventoryError(error));
  }
}

function requireReturnRead(
  snapshot: Awaited<ReturnType<typeof accessSnapshotInTransaction>>,
  outletId: string,
): void {
  const allowed = PURCHASE_RETURN_READ_PERMISSIONS.some((permission) =>
    snapshot.allows(permission, outletTarget(outletId)),
  );
  if (!allowed) throw new AccessError("PERMISSION_DENIED");
}

/** GET purchase returns of one outlet, newest first. */
export async function listPurchaseReturns(
  context: ScopedTenantContext,
  actorUserId: string,
  query: PurchaseReturnQuery,
): Promise<CursorPage<PurchaseReturn>> {
  assertOutlet(context, query.outletId);
  return withTenant(db, context, async (tx) => {
    requireReturnRead(
      await accessSnapshotInTransaction(tx, context, actorUserId, new Date()),
      query.outletId,
    );
    const filters: SQL[] = [
      eq(purchaseReturns.tenantId, context.tenant.tenantId),
      eq(purchaseReturns.outletId, query.outletId),
    ];
    if (query.purchaseOrderId)
      filters.push(eq(purchaseReturns.purchaseOrderId, query.purchaseOrderId));
    if (query.supplierId)
      filters.push(eq(purchaseReturns.supplierId, query.supplierId));
    const [returnedAt, id] = cursorKeys(query.cursor, 2);
    if (returnedAt !== undefined && id !== undefined) {
      const at = cursorInstant(returnedAt);
      filters.push(
        or(
          lt(purchaseReturns.returnedAt, at),
          and(
            eq(purchaseReturns.returnedAt, at),
            sql`${purchaseReturns.id} < ${cursorUuid(id)}::uuid`,
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(purchaseReturns)
      .where(and(...filters))
      .orderBy(desc(purchaseReturns.returnedAt), desc(purchaseReturns.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toReturn),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.returnedAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

/** GET one purchase return with lines; another outlet or tenant is a 404. */
export async function getPurchaseReturn(
  context: ScopedTenantContext,
  actorUserId: string,
  purchaseReturnId: string,
): Promise<PurchaseReturnDetail> {
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(purchaseReturns)
      .where(
        and(
          eq(purchaseReturns.tenantId, context.tenant.tenantId),
          eq(purchaseReturns.id, purchaseReturnId),
        ),
      );
    if (!row)
      throw new HttpError(404, "NOT_FOUND", "Purchase return not found.");
    requireReturnRead(
      await accessSnapshotInTransaction(tx, context, actorUserId, new Date()),
      row.outletId,
    );
    return detailOf(tx, row);
  });
}
