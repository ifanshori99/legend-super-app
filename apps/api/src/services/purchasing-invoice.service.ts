// Supplier invoice, three-way match, hold and release (bead legend-lspfy; design
// docs/briefs/ws-purchasing-apar-design.md §2, §4, §5, §7, §12).
//
// - An invoice of one PO is matched against the PO, the goods receipts and the
//   returns (`threeWayMatch`, shared) using the tenant tolerance (default 0 bp).
//   A clean invoice without service lines is `matched`: the journal
//   (`supplier_invoice.recorded`), the payable open item and the tax record
//   (`supplier_invoices`) are written in the SAME transaction as the document.
//   Anything else is `held`: stored, but no journal, no open item and no tax
//   record, so nothing can be paid.
// - `held` becomes `matched` by a re-match (data and tolerance as of now),
//   `released` by finance (another person than the recorder; only a price or
//   service hold, never a quantity hold) or `rejected`. `matched` / `released`
//   are never rejected here (that needs an AP reversal).
// - The PO row is locked FOR UPDATE first by every write (the same lock goods
//   receipts and returns take), so the cumulative billed quantity cannot race.
// - Any failure (missing mapping, closed period, missing NPWP for PPh 23, a
//   duplicate number) rolls the whole transaction back: no header, line,
//   journal, open item, event or idempotency claim is left behind.
// - Gate (K5): while `SUPPLIER_INVOICE_POSTING_ENABLED` is off, or the tenant's
//   accounting module is off (read in the tx, design §13 R1), an outcome that
//   would book the payable is refused with 409 SUPPLIER_INVOICE_POSTING_DISABLED
//   and nothing is written; a held outcome is still stored.
// - `supplier_invoice.recorded` must never be an auto-journal event: its journal
//   is posted here, in the document's own transaction.

import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { AccessError, type PermissionCode } from "@starter/shared/access";
import {
  createUlid,
  divideRounded,
  encodeCursor,
  extendCostIdr,
  formatDecimal4,
  idr,
  isoDateTimeSchema,
  parseDecimal4,
  userIdSchema,
  type BusinessDate,
  type Decimal4,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  purchaseOrderIdSchema,
  purchaseOrderLineIdSchema,
  purchaseOrderLineSchema,
  PurchasingError,
  purchasingEvents,
  supplierInvoiceDetailSchema,
  supplierInvoiceIdSchema,
  supplierInvoiceLineSchema,
  supplierInvoiceSchema,
  threeWayMatch,
  threeWayMatchSchema,
  type createSupplierInvoiceInputSchema,
  type decideSupplierInvoiceInputSchema,
  goodsReceiptValueIdr,
  type PurchaseOrderLine,
  type PurchaseOrderLineId,
  type recordSupplierInvoiceMatchInputSchema,
  type SupplierInvoice,
  type SupplierInvoiceDetail,
  type SupplierInvoiceLine,
  type supplierInvoiceQuerySchema,
  type SupplierInvoiceStatus,
  type ThreeWayMatch,
  type ThreeWayMatchIssue,
} from "@starter/shared/inventory";
import { isModuleEnabled } from "@starter/shared/platform";
import type { z } from "zod";
import { db } from "../db/index.ts";
import { accountingOpenItems } from "../db/schema/accounting-ap-fa.ts";
import { journalEntries } from "../db/schema/accounting.ts";
import { domainEventOutbox } from "../db/schema/core-events.ts";
import {
  goodsReceiptLines,
  goodsReceipts,
} from "../db/schema/inventory-receiving.ts";
import { outlets, tenants } from "../db/schema/platform-org.ts";
import {
  purchaseReturnLines,
  purchaseReturns,
} from "../db/schema/purchase-returns.ts";
import {
  purchaseInvoiceLines,
  purchaseInvoices,
  purchaseOrderLines,
  purchaseOrders,
  suppliers,
} from "../db/schema/purchasing.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { postJournalFromRuleInTransaction } from "./accounting-journal.service.ts";
import { recordSupplierInvoicePayableInTransaction } from "./accounting-ap.service.ts";
import { uniqueViolation } from "./accounting-shared.ts";
import { appendOutbox } from "./core-outbox.ts";
import {
  assertOutlet,
  cursorInstant,
  cursorKeys,
  cursorUuid,
  EVENT_DESTINATION,
  recordOpsAudit,
  requestFingerprint,
  requireOpsPermission,
  ROUNDING_MODE,
  outletTarget,
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
import {
  lockPayableDocument,
  lockPayableSource,
} from "./payable-source-lock.ts";
import { loadMatchToleranceBpInTransaction } from "./purchasing-policy.service.ts";
import {
  purchasingPostingEnabled,
  setPurchasingPostingEnabled,
} from "./purchasing-posting-gate.ts";

export type CreateSupplierInvoiceInput = z.infer<
  typeof createSupplierInvoiceInputSchema
>;
export type RecordSupplierInvoiceMatchInput = z.infer<
  typeof recordSupplierInvoiceMatchInputSchema
>;
export type DecideSupplierInvoiceInput = z.infer<
  typeof decideSupplierInvoiceInputSchema
>;
export type SupplierInvoiceQuery = z.infer<typeof supplierInvoiceQuerySchema>;

const MATCH_PERMISSION: PermissionCode = "purchasing.invoice.match";
const RELEASE_PERMISSION: PermissionCode =
  "accounting.supplier_payment.process";

/** Reads, re-match and reject: invoice matching or finance (fail closed). */
export const SUPPLIER_INVOICE_READ_PERMISSIONS: readonly PermissionCode[] = [
  MATCH_PERMISSION,
  RELEASE_PERMISSION,
];

const CREATE_OPERATION = "supplier_invoice.create";
const MATCH_OPERATION = "supplier_invoice.match";
const RELEASE_OPERATION = "supplier_invoice.release";
const REJECT_OPERATION = "supplier_invoice.reject";

/** PPN input may not exceed 12% of the DPP (K6). */
const PPN_RATE_PERCENT = 12n;
/** Match note of an invoice held only because it carries a service line (K3). */
const SERVICE_NOTE = "service_lines_need_review";
/** Issues a finance release may override; every other issue needs a corrected invoice. */
const RELEASABLE_ISSUES: readonly ThreeWayMatchIssue[] = [
  "price_outside_tolerance",
];
const INVOICEABLE_ORDER_STATUSES: readonly string[] = [
  "approved",
  "sent",
  "partially_received",
  "received",
];
const INVOICE_AUDIT_FIELDS = [
  "number",
  "purchaseOrderId",
  "supplierId",
  "status",
  "matchResult",
  "toleranceBp",
  "issues",
  "goodsIdr",
  "priceVarianceIdr",
  "servicesIdr",
  "ppnIdr",
  "pph23Idr",
  "totalIdr",
  "payableIdr",
] as const;

export const SUPPLIER_INVOICE_POSTING_DISABLED_MESSAGE =
  "Faktur pemasok belum bisa dibukukan sampai jurnal penerimaan barang (legend-29vw) berjalan";

/** Test seam: `null` goes back to the env flag. Re-exported from the gate. */
export const setSupplierInvoicePostingEnabled = setPurchasingPostingEnabled;

/**
 * Posting needs the env flag AND the accounting module of the tenant, read in
 * the caller's transaction: invoice AP and the return debit note must be live
 * together (design §13 R1).
 */
async function postingEnabled(
  tx: Tx,
  context: ScopedTenantContext,
): Promise<boolean> {
  if (!purchasingPostingEnabled()) return false;
  const [row] = await tx
    .select({ featureFlags: tenants.featureFlags })
    .from(tenants)
    .where(eq(tenants.id, context.tenant.tenantId))
    .limit(1);
  return isModuleEnabled(row?.featureFlags ?? null, "accounting");
}

/** Called only when the outcome would book the payable. */
async function assertPostingEnabled(
  tx: Tx,
  context: ScopedTenantContext,
): Promise<void> {
  if (!(await postingEnabled(tx, context)))
    throw new PurchasingError(
      "SUPPLIER_INVOICE_POSTING_DISABLED",
      SUPPLIER_INVOICE_POSTING_DISABLED_MESSAGE,
    );
}

type InvoiceRow = typeof purchaseInvoices.$inferSelect;
type InvoiceLineRow = typeof purchaseInvoiceLines.$inferSelect;
type OrderRow = typeof purchaseOrders.$inferSelect;

function invalid(message: string): HttpError {
  return new HttpError(422, "VALIDATION_ERROR", message);
}

function notFound(): HttpError {
  return new HttpError(404, "NOT_FOUND", "Supplier invoice not found.");
}

/** A held or rejected invoice is the discrepancy side of `matchStatus`. */
function matchStatusOf(
  status: SupplierInvoiceStatus,
): "matched" | "discrepancy" {
  return status === "matched" || status === "released"
    ? "matched"
    : "discrepancy";
}

// ------------------------------------------------------------------ DTOs

function toInvoice(row: InvoiceRow, settledIdr: number): SupplierInvoice {
  return supplierInvoiceSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    supplierId: row.supplierId,
    purchaseOrderId: row.purchaseOrderId,
    number: row.number,
    invoiceDate: row.invoiceDate,
    dueDate: row.dueDate,
    goodsIdr: row.goodsIdr,
    priceVarianceIdr: row.priceVarianceIdr,
    servicesIdr: row.servicesIdr,
    ppnIdr: row.ppnIdr,
    pph23Idr: row.pph23Idr,
    totalIdr: row.totalIdr,
    payableIdr: row.payableIdr,
    paidIdr: settledIdr,
    // Held / rejected invoices booked no payable, so nothing is outstanding.
    outstandingIdr:
      row.status === "held" || row.status === "rejected"
        ? 0
        : row.payableIdr - settledIdr,
    status: row.status,
    matchStatus: matchStatusOf(row.status),
    matchedAt: row.matchSnapshot.computedAt,
    matchNote: row.matchNote,
    recordedBy: row.recordedBy,
    recordedAt: row.recordedAt.toISOString(),
  });
}

function toLine(row: InvoiceLineRow) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    supplierInvoiceId: row.purchaseInvoiceId,
    purchaseOrderLineId: row.purchaseOrderLineId,
    kind: row.kind,
    description: row.description,
    quantity: row.quantity,
    unitPriceIdr: row.unitPriceIdr,
    lineTotalIdr: row.lineTotalIdr,
  };
}

/** Amount already settled against each payable (payments and debit notes). */
async function loadSettled(
  tx: Tx,
  tenantId: TenantId,
  ids: readonly string[],
): Promise<Map<string, number>> {
  const settled = new Map<string, number>();
  if (ids.length === 0) return settled;
  const rows = await tx
    .select({
      id: accountingOpenItems.id,
      settledIdr: accountingOpenItems.settledIdr,
    })
    .from(accountingOpenItems)
    .where(
      and(
        eq(accountingOpenItems.tenantId, tenantId),
        eq(accountingOpenItems.kind, "payable"),
        inArray(accountingOpenItems.id, [...ids]),
      ),
    );
  for (const row of rows) settled.set(row.id, row.settledIdr);
  return settled;
}

async function loadLineRows(
  tx: Tx,
  tenantId: TenantId,
  invoiceId: string,
): Promise<InvoiceLineRow[]> {
  return tx
    .select()
    .from(purchaseInvoiceLines)
    .where(
      and(
        eq(purchaseInvoiceLines.tenantId, tenantId),
        eq(purchaseInvoiceLines.purchaseInvoiceId, invoiceId),
      ),
    )
    .orderBy(asc(purchaseInvoiceLines.lineNo));
}

async function detailOf(
  tx: Tx,
  row: InvoiceRow,
): Promise<SupplierInvoiceDetail> {
  const lines = await loadLineRows(tx, row.tenantId, row.id);
  const settled = await loadSettled(tx, row.tenantId, [row.id]);
  return supplierInvoiceDetailSchema.parse({
    invoice: toInvoice(row, settled.get(row.id) ?? 0),
    lines: lines.map(toLine),
    match: threeWayMatchSchema.parse(row.matchSnapshot),
  });
}

// -------------------------------------------------------- match evaluation

type MatchData = {
  orderLines: PurchaseOrderLine[];
  receiptLines: {
    purchaseOrderLineId: PurchaseOrderLineId;
    quantityReceived: Decimal4;
    quantityRejected: Decimal4;
  }[];
  previouslyInvoiced: {
    purchaseOrderLineId: PurchaseOrderLineId | null;
    kind: "goods" | "service";
    quantity: Decimal4;
  }[];
  /** Returned quantity per PO line in the PO unit, rounded up (restricts billing). */
  returned: { purchaseOrderLineId: PurchaseOrderLineId; quantity: Decimal4 }[];
};

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * Everything the match compares an invoice with, read inside the transaction
 * that holds the PO lock. `excludeInvoiceId` leaves the invoice being
 * re-evaluated out of the "already billed" quantities; rejected invoices never
 * count, held ones do.
 */
async function loadMatchData(
  tx: Tx,
  tenantId: TenantId,
  purchaseOrderId: string,
  excludeInvoiceId: string | null,
): Promise<MatchData> {
  const orderRows = await tx
    .select()
    .from(purchaseOrderLines)
    .where(
      and(
        eq(purchaseOrderLines.tenantId, tenantId),
        eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId),
      ),
    );
  const orderLines = orderRows.map((line) =>
    purchaseOrderLineSchema.parse({
      id: line.id,
      tenantId: line.tenantId,
      purchaseOrderId: line.purchaseOrderId,
      inventoryItemId: line.inventoryItemId,
      quantity: line.quantity,
      uomId: line.uomId,
      unitPriceIdr: line.unitPriceIdr,
      lineTotalIdr: line.lineTotalIdr,
    }),
  );

  const receiptRows = await tx
    .select({
      purchaseOrderLineId: goodsReceiptLines.purchaseOrderLineId,
      quantityReceived: goodsReceiptLines.quantityReceived,
      quantityRejected: goodsReceiptLines.quantityRejected,
    })
    .from(goodsReceiptLines)
    .innerJoin(
      goodsReceipts,
      and(
        eq(goodsReceipts.tenantId, goodsReceiptLines.tenantId),
        eq(goodsReceipts.id, goodsReceiptLines.goodsReceiptId),
      ),
    )
    .where(
      and(
        eq(goodsReceipts.tenantId, tenantId),
        eq(goodsReceipts.purchaseOrderId, purchaseOrderId),
      ),
    );

  // Returns are in the item base unit; the PO line is in the purchase unit.
  // Convert per receipt line with its own ratio and round up, so a rounding
  // difference can only shrink what may be billed.
  const returnRows = await tx
    .select({
      receiptLineId: purchaseReturnLines.goodsReceiptLineId,
      purchaseOrderLineId: purchaseReturnLines.purchaseOrderLineId,
      quantity: purchaseReturnLines.quantity,
      received: goodsReceiptLines.quantityReceived,
      rejected: goodsReceiptLines.quantityRejected,
      acceptedBase: goodsReceiptLines.acceptedBaseQuantity,
    })
    .from(purchaseReturnLines)
    .innerJoin(
      purchaseReturns,
      and(
        eq(purchaseReturns.tenantId, purchaseReturnLines.tenantId),
        eq(purchaseReturns.id, purchaseReturnLines.purchaseReturnId),
      ),
    )
    .innerJoin(
      goodsReceiptLines,
      and(
        eq(goodsReceiptLines.tenantId, purchaseReturnLines.tenantId),
        eq(goodsReceiptLines.id, purchaseReturnLines.goodsReceiptLineId),
      ),
    )
    .where(
      and(
        eq(purchaseReturns.tenantId, tenantId),
        eq(purchaseReturns.purchaseOrderId, purchaseOrderId),
      ),
    );
  const returnedBase = new Map<
    string,
    (typeof returnRows)[number] & { base: bigint }
  >();
  for (const row of returnRows) {
    const current = returnedBase.get(row.receiptLineId);
    returnedBase.set(row.receiptLineId, {
      ...row,
      base: (current?.base ?? 0n) + parseDecimal4(row.quantity),
    });
  }
  const returnedByLine = new Map<string, bigint>();
  for (const entry of returnedBase.values()) {
    const acceptedBase = parseDecimal4(entry.acceptedBase);
    if (acceptedBase <= 0n) continue;
    const accepted =
      parseDecimal4(entry.received) - parseDecimal4(entry.rejected);
    returnedByLine.set(
      entry.purchaseOrderLineId,
      (returnedByLine.get(entry.purchaseOrderLineId) ?? 0n) +
        ceilDiv(entry.base * accepted, acceptedBase),
    );
  }

  const invoicedRows = await tx
    .select({
      purchaseOrderLineId: purchaseInvoiceLines.purchaseOrderLineId,
      kind: purchaseInvoiceLines.kind,
      quantity: purchaseInvoiceLines.quantity,
    })
    .from(purchaseInvoiceLines)
    .innerJoin(
      purchaseInvoices,
      and(
        eq(purchaseInvoices.tenantId, purchaseInvoiceLines.tenantId),
        eq(purchaseInvoices.id, purchaseInvoiceLines.purchaseInvoiceId),
      ),
    )
    .where(
      and(
        eq(purchaseInvoices.tenantId, tenantId),
        eq(purchaseInvoices.purchaseOrderId, purchaseOrderId),
        ne(purchaseInvoices.status, "rejected"),
        excludeInvoiceId === null
          ? undefined
          : ne(purchaseInvoices.id, excludeInvoiceId),
      ),
    );

  return {
    orderLines,
    receiptLines: receiptRows.map((row) => ({
      purchaseOrderLineId: purchaseOrderLineIdSchema.parse(
        row.purchaseOrderLineId,
      ),
      quantityReceived: row.quantityReceived,
      quantityRejected: row.quantityRejected,
    })),
    previouslyInvoiced: invoicedRows.map((row) => ({
      purchaseOrderLineId:
        row.purchaseOrderLineId === null
          ? null
          : purchaseOrderLineIdSchema.parse(row.purchaseOrderLineId),
      kind: row.kind,
      quantity: row.quantity,
    })),
    returned: [...returnedByLine].map(([lineId, quantity]) => ({
      purchaseOrderLineId: purchaseOrderLineIdSchema.parse(lineId),
      quantity: formatDecimal4(quantity),
    })),
  };
}

type Evaluation = {
  match: ThreeWayMatch;
  issues: ThreeWayMatchIssue[];
  held: boolean;
  /** Stored `match_note`: the issue codes (and the service-line reason). */
  note: string | null;
};

/**
 * One three-way match. The invoice is held for any issue and for any service
 * line (K3: nothing outside the PO and the receipt is booked unseen); the
 * stored snapshot then says `discrepancy`, as the DB state check requires.
 */
function evaluate(input: {
  invoice: {
    id: string;
    purchaseOrderId: string;
    goodsIdr: number;
    servicesIdr: number;
  };
  lines: readonly SupplierInvoiceLine[];
  data: MatchData;
  toleranceBp: number;
  now: Date;
}): Evaluation {
  const match = guardMoneyMath(() =>
    threeWayMatch(
      {
        invoice: {
          id: supplierInvoiceIdSchema.parse(input.invoice.id),
          purchaseOrderId: purchaseOrderIdSchema.parse(
            input.invoice.purchaseOrderId,
          ),
          goodsIdr: idr(input.invoice.goodsIdr),
          servicesIdr: idr(input.invoice.servicesIdr),
        },
        invoiceLines: input.lines,
        purchaseOrderLines: input.data.orderLines,
        goodsReceiptLines: input.data.receiptLines,
        toleranceBp: input.toleranceBp,
        computedAt: isoDateTimeSchema.parse(input.now.toISOString()),
        previouslyInvoicedLines: input.data.previouslyInvoiced,
        returnedLines: input.data.returned,
      },
      ROUNDING_MODE,
    ),
  );
  const issues = [
    ...new Set([
      ...match.rows.flatMap((row) => row.issues),
      ...match.headerIssues,
    ]),
  ];
  const hasService = input.lines.some((line) => line.kind === "service");
  const held = issues.length > 0 || hasService;
  const notes: string[] = [...issues];
  if (hasService) notes.push(SERVICE_NOTE);
  const snapshot: ThreeWayMatch = held
    ? { ...match, status: "discrepancy" }
    : match;
  return {
    match: snapshot,
    issues,
    held,
    note: held ? notes.join(", ") : null,
  };
}

// ---------------------------------------------------------------- posting

type PayableInput = {
  invoiceId: string;
  purchaseOrderId: string;
  legalEntityId: string;
  outletId: string;
  supplierId: string;
  supplierName: string;
  number: string;
  invoiceDate: BusinessDate;
  dueDate: BusinessDate;
  goodsIdr: number;
  priceVarianceIdr: number;
  servicesIdr: number;
  ppnIdr: number;
  pph23Idr: number;
  payableIdr: number;
};

/**
 * Cutover guard (legend-29vw): the invoice debits GRNI, so every valued goods
 * receipt of the order must already have credited it (`aj:goods-receipt:<id>`,
 * the auto-journal consumer). Otherwise GRNI would go negative and the payable
 * would be booked against goods the GL never recorded: 409
 * GOODS_RECEIPT_NOT_JOURNALED, the caller's transaction rolls back.
 */
async function assertGoodsReceiptsJournaled(
  tx: Tx,
  tenantId: TenantId,
  purchaseOrderId: string,
): Promise<void> {
  const rows = await tx
    .select({
      goodsReceiptId: goodsReceipts.id,
      quantityReceived: goodsReceiptLines.quantityReceived,
      quantityRejected: goodsReceiptLines.quantityRejected,
      unitCostIdr: goodsReceiptLines.unitCostIdr,
    })
    .from(goodsReceiptLines)
    .innerJoin(
      goodsReceipts,
      and(
        eq(goodsReceipts.tenantId, goodsReceiptLines.tenantId),
        eq(goodsReceipts.id, goodsReceiptLines.goodsReceiptId),
      ),
    )
    .where(
      and(
        eq(goodsReceipts.tenantId, tenantId),
        eq(goodsReceipts.purchaseOrderId, purchaseOrderId),
      ),
    );
  const linesByReceipt = new Map<string, typeof rows>();
  for (const row of rows) {
    const lines = linesByReceipt.get(row.goodsReceiptId) ?? [];
    lines.push(row);
    linesByReceipt.set(row.goodsReceiptId, lines);
  }
  // Same value rule as the receipt fact: a receipt worth 0 books no journal.
  const valued = [...linesByReceipt.entries()]
    .filter(
      ([, lines]) =>
        guardMoneyMath(() => goodsReceiptValueIdr(lines, ROUNDING_MODE)) > 0,
    )
    .map(([goodsReceiptId]) => goodsReceiptId);
  if (valued.length === 0) return;
  const journaled = await tx
    .select({ key: journalEntries.idempotencyKey })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.tenantId, tenantId),
        inArray(
          journalEntries.idempotencyKey,
          valued.map((id) => `aj:goods-receipt:${id}`),
        ),
      ),
    );
  if (journaled.length < valued.length)
    throw new PurchasingError(
      "GOODS_RECEIPT_NOT_JOURNALED",
      "The goods receipt journal is not posted yet; the invoice cannot be booked.",
    );
}

/**
 * Books the invoice in the caller's transaction: the `supplier_invoice.recorded`
 * journal, then the payable open item (id = invoice id) with the tax record.
 * Returns the journal entry id. Fails closed (mapping, period, NPWP): the
 * caller's transaction rolls back.
 */
async function postSupplierInvoicePayableInTransaction(
  tx: Tx,
  context: ScopedTenantContext,
  invoice: PayableInput,
  actorUserId: string,
  now: Date,
): Promise<string> {
  await assertPostingEnabled(tx, context);
  await assertGoodsReceiptsJournaled(
    tx,
    context.tenant.tenantId,
    invoice.purchaseOrderId,
  );
  const actorId = userIdSchema.parse(actorUserId);
  const entry = await postJournalFromRuleInTransaction(
    tx,
    context,
    {
      eventName: "supplier_invoice.recorded",
      amounts: {
        goodsIdr: invoice.goodsIdr,
        priceVarianceIdr: invoice.priceVarianceIdr,
        servicesIdr: invoice.servicesIdr,
        ppnIdr: invoice.ppnIdr,
        pph23Idr: invoice.pph23Idr,
        payableIdr: invoice.payableIdr,
      },
      legalEntityId: invoice.legalEntityId,
      outletId: invoice.outletId,
      entryDate: invoice.invoiceDate,
      sourceId: invoice.invoiceId,
      postedBy: actorId,
      idempotencyKey: `si-post:${invoice.invoiceId}`,
    },
    now,
  );
  await recordSupplierInvoicePayableInTransaction(
    tx,
    context,
    {
      supplierInvoiceId: invoice.invoiceId,
      legalEntityId: invoice.legalEntityId,
      outletId: invoice.outletId,
      supplierId: invoice.supplierId,
      supplierName: invoice.supplierName,
      invoiceNumber: invoice.number,
      invoiceDate: invoice.invoiceDate,
      dueOn: invoice.dueDate,
      payableIdr: invoice.payableIdr,
      dppIdr: invoice.goodsIdr + invoice.priceVarianceIdr + invoice.servicesIdr,
      ppnIdr: invoice.ppnIdr,
      pph23Idr: invoice.pph23Idr,
      journalEntryId: entry.id,
      idempotencyKey: `si-ap:${invoice.invoiceId}`,
    },
    actorId,
  );
  return entry.id;
}

function payableInputOf(row: InvoiceRow, supplierName: string): PayableInput {
  return {
    invoiceId: row.id,
    purchaseOrderId: row.purchaseOrderId,
    legalEntityId: row.legalEntityId,
    outletId: row.outletId,
    supplierId: row.supplierId,
    supplierName,
    number: row.number,
    invoiceDate: row.invoiceDate as BusinessDate,
    dueDate: row.dueDate as BusinessDate,
    goodsIdr: row.goodsIdr,
    priceVarianceIdr: row.priceVarianceIdr,
    servicesIdr: row.servicesIdr,
    ppnIdr: row.ppnIdr,
    pph23Idr: row.pph23Idr,
    payableIdr: row.payableIdr,
  };
}

// ----------------------------------------------------------------- events

async function nextInvoiceSequence(
  tx: Tx,
  tenantId: TenantId,
  invoiceId: string,
): Promise<number> {
  const [row] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.destination, EVENT_DESTINATION),
        eq(domainEventOutbox.aggregateType, "supplier_invoice"),
        eq(domainEventOutbox.aggregateId, invoiceId),
      ),
    );
  return Number(row?.last ?? 0) + 1;
}

async function appendInvoiceEvent(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    name: "supplier_invoice.recorded" | "supplier_invoice.matched";
    invoiceId: string;
    outletId: string;
    actorUserId: string;
    occurredAt: Date;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  const sequence = await nextInvoiceSequence(
    tx,
    context.tenant.tenantId,
    input.invoiceId,
  );
  const event = purchasingEvents[input.name].envelopeSchema.parse({
    id: createUlid(input.occurredAt.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: input.outletId,
    name: input.name,
    version: 1,
    aggregateType: "supplier_invoice",
    aggregateId: input.invoiceId,
    sequence,
    occurredAt: input.occurredAt.toISOString(),
    actor: { type: "user", id: input.actorUserId },
    deviceId: null,
    idempotencyKey: `${input.name}:${input.invoiceId}:${sequence}`,
    payloadSchemaRef: `${input.name}.v1`,
    payload: input.payload,
  });
  await appendOutbox(tx, context, {
    id: createUlid(),
    event,
    destination: EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
}

async function appendMatchedEvent(
  tx: Tx,
  context: ScopedTenantContext,
  row: InvoiceRow,
  actorUserId: string,
  now: Date,
): Promise<void> {
  await appendInvoiceEvent(tx, context, {
    name: "supplier_invoice.matched",
    invoiceId: row.id,
    outletId: row.outletId,
    actorUserId,
    occurredAt: now,
    payload: {
      supplierInvoiceId: row.id,
      purchaseOrderId: row.purchaseOrderId,
      status: matchStatusOf(row.status),
      priceVarianceIdr: row.priceVarianceIdr,
      matchedAt: row.matchSnapshot.computedAt,
    },
  });
}

async function appendRecordedEvent(
  tx: Tx,
  context: ScopedTenantContext,
  row: InvoiceRow,
  actorUserId: string,
  now: Date,
): Promise<void> {
  await appendInvoiceEvent(tx, context, {
    name: "supplier_invoice.recorded",
    invoiceId: row.id,
    outletId: row.outletId,
    actorUserId,
    occurredAt: now,
    payload: {
      supplierInvoiceId: row.id,
      supplierId: row.supplierId,
      purchaseOrderId: row.purchaseOrderId,
      number: row.number,
      goodsIdr: row.goodsIdr,
      priceVarianceIdr: row.priceVarianceIdr,
      servicesIdr: row.servicesIdr,
      ppnIdr: row.ppnIdr,
      pph23Idr: row.pph23Idr,
      payableIdr: row.payableIdr,
      totalIdr: row.totalIdr,
      recordedBy: row.recordedBy,
      recordedAt: row.recordedAt.toISOString(),
    },
  });
}

async function auditInvoice(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    actorUserId: string;
    action: string;
    before: InvoiceRow | null;
    after: InvoiceRow;
    issues: readonly string[];
    reason?: string | null;
  },
): Promise<void> {
  const view = (row: InvoiceRow) => ({
    number: row.number,
    purchaseOrderId: row.purchaseOrderId,
    supplierId: row.supplierId,
    status: row.status,
    matchResult: row.matchResult,
    toleranceBp: row.toleranceBp,
    issues: input.issues.join(", "),
    goodsIdr: row.goodsIdr,
    priceVarianceIdr: row.priceVarianceIdr,
    servicesIdr: row.servicesIdr,
    ppnIdr: row.ppnIdr,
    pph23Idr: row.pph23Idr,
    totalIdr: row.totalIdr,
    payableIdr: row.payableIdr,
  });
  await recordOpsAudit(tx, context, {
    actorUserId: input.actorUserId,
    outletId: input.after.outletId,
    action: input.action,
    objectType: "supplier_invoice",
    objectId: input.after.id,
    before: input.before ? view(input.before) : null,
    after: view(input.after),
    safeFields: INVOICE_AUDIT_FIELDS,
    reason: input.reason ?? null,
  });
}

// ------------------------------------------------------------------ locks

async function lockOrder(
  tx: Tx,
  tenantId: TenantId,
  purchaseOrderId: string,
): Promise<OrderRow> {
  const [order] = await tx
    .select()
    .from(purchaseOrders)
    .where(
      and(
        eq(purchaseOrders.tenantId, tenantId),
        eq(purchaseOrders.id, purchaseOrderId),
      ),
    )
    .for("update");
  if (!order)
    throw new HttpError(404, "NOT_FOUND", "Purchase order not found.");
  return order;
}

async function findInvoice(
  tx: Tx,
  tenantId: TenantId,
  invoiceId: string,
  lock: boolean,
): Promise<InvoiceRow> {
  const query = tx
    .select()
    .from(purchaseInvoices)
    .where(
      and(
        eq(purchaseInvoices.tenantId, tenantId),
        eq(purchaseInvoices.id, invoiceId),
      ),
    );
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw notFound();
  return row;
}

async function loadSupplierName(
  tx: Tx,
  tenantId: TenantId,
  supplierId: string,
): Promise<string> {
  const [supplier] = await tx
    .select({ name: suppliers.name })
    .from(suppliers)
    .where(and(eq(suppliers.tenantId, tenantId), eq(suppliers.id, supplierId)));
  if (!supplier) throw invalid("Supplier not found.");
  return supplier.name;
}

function constraintOf(error: unknown, depth = 0): string | null {
  if (depth > 4 || typeof error !== "object" || error === null) return null;
  const candidate = error as { constraint?: unknown; cause?: unknown };
  return typeof candidate.constraint === "string"
    ? candidate.constraint
    : constraintOf(candidate.cause, depth + 1);
}

const NUMBER_CONSTRAINTS = [
  "purchase_invoices_supplier_number_key",
  "supplier_invoices_tenant_supplier_number_key",
];

/** A number clash that slipped past the pre-check (another PO, same supplier). */
function translateInvoiceError(error: unknown): unknown {
  if (uniqueViolation(error)) {
    const constraint = constraintOf(error);
    if (constraint !== null && NUMBER_CONSTRAINTS.includes(constraint))
      return translatePurchasingError(
        new PurchasingError(
          "SUPPLIER_INVOICE_DUPLICATE",
          "Duplicate supplier invoice number.",
        ),
      );
  }
  return translatePurchasingError(error);
}

function requireInvoiceRead(
  snapshot: Awaited<ReturnType<typeof accessSnapshotInTransaction>>,
  outletId: string,
): void {
  const allowed = SUPPLIER_INVOICE_READ_PERMISSIONS.some((permission) =>
    snapshot.allows(permission, outletTarget(outletId)),
  );
  if (!allowed) throw new AccessError("PERMISSION_DENIED");
}

// ----------------------------------------------------------------- create

function canonicalInput(input: CreateSupplierInvoiceInput) {
  return {
    outletId: input.outletId,
    supplierId: input.supplierId,
    purchaseOrderId: input.purchaseOrderId,
    number: input.number,
    invoiceDate: input.invoiceDate,
    dueDate: input.dueDate,
    ppnIdr: input.ppnIdr,
    pph23Idr: input.pph23Idr,
    lines: input.lines.map((line) => ({
      purchaseOrderLineId: line.purchaseOrderLineId ?? null,
      kind: line.kind,
      description: line.description,
      quantity: formatDecimal4(parseDecimal4(line.quantity)),
      unitPriceIdr: formatDecimal4(parseDecimal4(line.unitPriceIdr)),
    })),
  };
}

/**
 * POST supplier invoice. Needs `purchasing.invoice.match` at the outlet. The
 * server computes every amount from the lines; the client only sends lines,
 * PPN and PPh 23. A clean invoice is booked in this transaction, anything else
 * is stored as `held` without any payable. Same key replays the first answer.
 */
export async function createSupplierInvoice(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateSupplierInvoiceInput,
  now = new Date(),
): Promise<SupplierInvoiceDetail> {
  assertOutlet(context, input.outletId);
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
  const tenantId = context.tenant.tenantId;
  try {
    return await withTenant(db, context, async (tx) => {
      await requireOpsPermission(
        tx,
        context,
        actorUserId,
        MATCH_PERMISSION,
        input.outletId,
      );
      const replay = await claimPurchasingIdempotency(tx, context, claim);
      if (replay) return supplierInvoiceDetailSchema.parse(replay.replay);

      for (const line of input.lines) {
        if (line.kind === "goods" && !line.purchaseOrderLineId)
          throw invalid("A goods line needs its purchase order line.");
        if (line.kind === "service" && line.purchaseOrderLineId)
          throw invalid("A service line has no purchase order line.");
      }

      // The PO row is the lock that serialises everything billed, received or
      // returned on this order.
      const order = await lockOrder(tx, tenantId, input.purchaseOrderId);
      if (order.outletId.toLowerCase() !== input.outletId.toLowerCase())
        throw new HttpError(404, "NOT_FOUND", "Purchase order not found.");
      if (order.supplierId.toLowerCase() !== input.supplierId.toLowerCase())
        throw invalid("The supplier does not match the purchase order.");
      if (!INVOICEABLE_ORDER_STATUSES.includes(order.status))
        throw new HttpError(
          409,
          "CONFLICT",
          "The purchase order cannot be invoiced in its current status.",
        );

      // Lock order: PO row (above) -> payable-src -> payable-doc. A fixed
      // asset bought on credit takes payable-src on its own source id (not
      // this new invoice uuid), so payable-src does not serialize the two.
      // The lock that does is payable-doc (supplier + document number): the
      // payable check below runs after a concurrent asset has committed.
      const invoiceId = randomUUID();
      await lockPayableSource(tx, tenantId, invoiceId);
      await lockPayableDocument(tx, tenantId, input.supplierId, input.number);

      const [duplicate] = await tx
        .select({ id: purchaseInvoices.id })
        .from(purchaseInvoices)
        .where(
          and(
            eq(purchaseInvoices.tenantId, tenantId),
            eq(purchaseInvoices.supplierId, input.supplierId),
            sql`lower(btrim(${purchaseInvoices.number})) = ${input.number.trim().toLowerCase()}`,
            ne(purchaseInvoices.status, "rejected"),
          ),
        )
        .limit(1);
      // A payable open item of the same supplier and document number that
      // no supplier invoice booked came from a credit fixed asset purchase.
      const [assetPayable] = duplicate
        ? []
        : await tx
            .select({ id: accountingOpenItems.id })
            .from(accountingOpenItems)
            .where(
              and(
                eq(accountingOpenItems.tenantId, tenantId),
                eq(accountingOpenItems.kind, "payable"),
                eq(accountingOpenItems.counterpartyType, "supplier"),
                eq(accountingOpenItems.counterpartyId, input.supplierId),
                sql`upper(trim(${accountingOpenItems.documentNumber})) = ${input.number.trim().toUpperCase()}`,
                sql`NOT EXISTS (SELECT 1 FROM ${purchaseInvoices} WHERE ${purchaseInvoices.tenantId} = ${accountingOpenItems.tenantId} AND ${purchaseInvoices.id} = ${accountingOpenItems.id})`,
              ),
            )
            .limit(1);
      if (duplicate || assetPayable)
        throw new PurchasingError(
          "SUPPLIER_INVOICE_DUPLICATE",
          "Duplicate supplier invoice number.",
        );

      const [outlet] = await tx
        .select({ legalEntityId: outlets.legalEntityId })
        .from(outlets)
        .where(
          and(eq(outlets.tenantId, tenantId), eq(outlets.id, input.outletId)),
        );
      if (!outlet) throw new HttpError(404, "NOT_FOUND", "Outlet not found.");
      const supplierName = await loadSupplierName(
        tx,
        tenantId,
        input.supplierId,
      );

      const data = await loadMatchData(
        tx,
        tenantId,
        input.purchaseOrderId,
        null,
      );
      const orderLineById = new Map(
        data.orderLines.map((line) => [line.id as string, line]),
      );
      const lineRows = input.lines.map((line, index) => {
        const quantity = line.quantity as Decimal4;
        const unitPriceIdr = line.unitPriceIdr as Decimal4;
        return {
          id: randomUUID(),
          tenantId,
          outletId: input.outletId,
          purchaseInvoiceId: invoiceId,
          lineNo: index + 1,
          purchaseOrderLineId:
            line.kind === "goods" ? (line.purchaseOrderLineId ?? null) : null,
          kind: line.kind,
          description: line.description,
          quantity,
          unitPriceIdr,
          lineTotalIdr: guardMoneyMath(() =>
            extendCostIdr(quantity, unitPriceIdr, ROUNDING_MODE),
          ),
        };
      });

      // Header amounts from the lines: goods at the PO price, the price
      // variance (invoice price minus PO price, signed) and services.
      let goodsAtPo = 0;
      let invoicedGoods = 0;
      let servicesIdr = 0;
      for (const line of lineRows) {
        if (line.kind === "service") {
          servicesIdr += line.lineTotalIdr;
          continue;
        }
        const orderLine = orderLineById.get(line.purchaseOrderLineId!);
        if (!orderLine)
          throw new PurchasingError(
            "THREE_WAY_MATCH_INVALID_INPUT",
            "A goods line is not on this purchase order.",
          );
        invoicedGoods += line.lineTotalIdr;
        goodsAtPo += guardMoneyMath(() =>
          extendCostIdr(line.quantity, orderLine.unitPriceIdr, ROUNDING_MODE),
        );
      }
      const priceVarianceIdr = invoicedGoods - goodsAtPo;
      const dppIdr = invoicedGoods + servicesIdr;
      const ppnLimit = guardMoneyMath(() =>
        Number(
          divideRounded(BigInt(dppIdr) * PPN_RATE_PERCENT, 100n, ROUNDING_MODE),
        ),
      );
      if (input.ppnIdr > ppnLimit)
        throw invalid("PPN may not exceed 12% of the DPP.");
      if (input.pph23Idr > 0 && servicesIdr === 0)
        throw invalid("PPh 23 applies to service lines only.");
      if (input.pph23Idr > servicesIdr)
        throw invalid("PPh 23 may not exceed the service amount.");
      const totalIdr = dppIdr + input.ppnIdr;
      const payableIdr = totalIdr - input.pph23Idr;
      if (payableIdr <= 0) throw invalid("The invoice amount must be > 0.");

      const toleranceBp = await loadMatchToleranceBpInTransaction(tx, tenantId);
      const evaluation = evaluate({
        invoice: {
          id: invoiceId,
          purchaseOrderId: input.purchaseOrderId,
          goodsIdr: goodsAtPo,
          servicesIdr,
        },
        lines: lineRows.map((line) =>
          supplierInvoiceLineSchema.parse({
            id: line.id,
            tenantId,
            supplierInvoiceId: invoiceId,
            purchaseOrderLineId: line.purchaseOrderLineId,
            kind: line.kind,
            description: line.description,
            quantity: line.quantity,
            unitPriceIdr: line.unitPriceIdr,
            lineTotalIdr: line.lineTotalIdr,
          }),
        ),
        data,
        toleranceBp,
        now,
      });

      let journalEntryId: string | null = null;
      if (!evaluation.held)
        journalEntryId = await postSupplierInvoicePayableInTransaction(
          tx,
          context,
          {
            invoiceId,
            purchaseOrderId: input.purchaseOrderId,
            legalEntityId: outlet.legalEntityId,
            outletId: input.outletId,
            supplierId: input.supplierId,
            supplierName,
            number: input.number,
            invoiceDate: input.invoiceDate,
            dueDate: input.dueDate,
            goodsIdr: goodsAtPo,
            priceVarianceIdr,
            servicesIdr,
            ppnIdr: input.ppnIdr,
            pph23Idr: input.pph23Idr,
            payableIdr,
          },
          actorUserId,
          now,
        );

      const [row] = await tx
        .insert(purchaseInvoices)
        .values({
          id: invoiceId,
          tenantId,
          outletId: input.outletId,
          legalEntityId: outlet.legalEntityId,
          supplierId: input.supplierId,
          purchaseOrderId: input.purchaseOrderId,
          number: input.number,
          invoiceDate: input.invoiceDate,
          dueDate: input.dueDate,
          goodsIdr: idr(goodsAtPo),
          priceVarianceIdr: idr(priceVarianceIdr),
          servicesIdr: idr(servicesIdr),
          ppnIdr: input.ppnIdr,
          pph23Idr: input.pph23Idr,
          totalIdr: idr(totalIdr),
          payableIdr: idr(payableIdr),
          toleranceBp,
          matchResult: evaluation.held ? "discrepancy" : "matched",
          matchSnapshot: evaluation.match,
          matchNote: evaluation.note,
          status: evaluation.held ? "held" : "matched",
          recordedBy: actorUserId,
          recordedAt: now,
          journalEntryId,
          updatedAt: now,
        })
        .returning();
      await tx.insert(purchaseInvoiceLines).values(lineRows);

      await appendMatchedEvent(tx, context, row!, actorUserId, now);
      if (!evaluation.held)
        await appendRecordedEvent(tx, context, row!, actorUserId, now);
      await auditInvoice(tx, context, {
        actorUserId,
        action: "purchasing.supplier_invoice_recorded",
        before: null,
        after: row!,
        issues: evaluation.issues,
      });
      const detail = await detailOf(tx, row!);
      await completePurchasingIdempotency(tx, context, claim, detail);
      return detail;
    });
  } catch (error) {
    throw translateInvoiceError(error);
  }
}

// ------------------------------------------------------- re-match, release

type HeldContext = {
  row: InvoiceRow;
  lines: SupplierInvoiceLine[];
  evaluation: Evaluation;
  toleranceBp: number;
  supplierName: string;
};

/**
 * With the PO locked: the held invoice (re-read FOR UPDATE), its lines and a
 * fresh match against the data and tolerance as of now.
 */
async function evaluateHeldInvoice(
  tx: Tx,
  tenantId: TenantId,
  row: InvoiceRow,
  now: Date,
): Promise<HeldContext> {
  const lineRows = await loadLineRows(tx, tenantId, row.id);
  const lines = lineRows.map((line) =>
    supplierInvoiceLineSchema.parse(toLine(line)),
  );
  const data = await loadMatchData(tx, tenantId, row.purchaseOrderId, row.id);
  const toleranceBp = await loadMatchToleranceBpInTransaction(tx, tenantId);
  const evaluation = evaluate({
    invoice: {
      id: row.id,
      purchaseOrderId: row.purchaseOrderId,
      goodsIdr: row.goodsIdr,
      servicesIdr: row.servicesIdr,
    },
    lines,
    data,
    toleranceBp,
    now,
  });
  const supplierName = await loadSupplierName(tx, tenantId, row.supplierId);
  return { row, lines, evaluation, toleranceBp, supplierName };
}

function requireHeld(row: InvoiceRow): void {
  if (row.status !== "held")
    throw new PurchasingError(
      "SUPPLIER_INVOICE_NOT_HELD",
      "The supplier invoice is not held.",
    );
}

/**
 * POST re-match of a held invoice. Needs `purchasing.invoice.match` at the
 * invoice's outlet. Matches again with today's receipts, returns, other
 * invoices and tolerance: still held, or matched with the payable booked.
 */
export async function rematchSupplierInvoice(
  context: ScopedTenantContext,
  actorUserId: string,
  supplierInvoiceId: string,
  input: RecordSupplierInvoiceMatchInput,
  now = new Date(),
): Promise<SupplierInvoiceDetail> {
  const tenantId = context.tenant.tenantId;
  try {
    return await withTenant(db, context, async (tx) => {
      const found = await findInvoice(tx, tenantId, supplierInvoiceId, false);
      await requireOpsPermission(
        tx,
        context,
        actorUserId,
        MATCH_PERMISSION,
        found.outletId,
      );
      const claim = {
        operation: MATCH_OPERATION,
        key: input.idempotencyKey,
        outletId: found.outletId,
        fingerprint: requestFingerprint(MATCH_OPERATION, actorUserId, {
          supplierInvoiceId,
          note: input.note ?? null,
        }),
      };
      const replay = await claimPurchasingIdempotency(tx, context, claim);
      if (replay) return supplierInvoiceDetailSchema.parse(replay.replay);

      await lockOrder(tx, tenantId, found.purchaseOrderId);
      const row = await findInvoice(tx, tenantId, supplierInvoiceId, true);
      await lockPayableSource(tx, tenantId, row.id);
      requireHeld(row);
      const { evaluation, toleranceBp, supplierName } =
        await evaluateHeldInvoice(tx, tenantId, row, now);

      const note = input.note ? input.note : null;
      let journalEntryId: string | null = null;
      if (!evaluation.held)
        journalEntryId = await postSupplierInvoicePayableInTransaction(
          tx,
          context,
          payableInputOf(row, supplierName),
          actorUserId,
          now,
        );
      const heldNote = [evaluation.note, note]
        .filter((part): part is string => part !== null)
        .join(" | ")
        .slice(0, 500);
      const [updated] = await tx
        .update(purchaseInvoices)
        .set({
          status: evaluation.held ? "held" : "matched",
          matchResult: evaluation.held ? "discrepancy" : "matched",
          matchSnapshot: evaluation.match,
          matchNote: evaluation.held ? heldNote : note,
          toleranceBp,
          journalEntryId,
          updatedAt: now,
        })
        .where(
          and(
            eq(purchaseInvoices.tenantId, tenantId),
            eq(purchaseInvoices.id, row.id),
          ),
        )
        .returning();

      await appendMatchedEvent(tx, context, updated!, actorUserId, now);
      if (!evaluation.held)
        await appendRecordedEvent(tx, context, updated!, actorUserId, now);
      await auditInvoice(tx, context, {
        actorUserId,
        action: "purchasing.supplier_invoice_rematched",
        before: row,
        after: updated!,
        issues: evaluation.issues,
      });
      const detail = await detailOf(tx, updated!);
      await completePurchasingIdempotency(tx, context, claim, detail);
      return detail;
    });
  } catch (error) {
    throw translateInvoiceError(error);
  }
}

/**
 * POST release of a held invoice by finance. Needs
 * `accounting.supplier_payment.process` at the invoice's outlet and a person
 * other than the recorder. The match runs again: only a price hold and/or
 * service lines may be released; a quantity or amount problem needs a
 * corrected invoice (409 SUPPLIER_INVOICE_RELEASE_BLOCKED). The payable is
 * booked with the invoice amounts.
 */
export async function releaseSupplierInvoice(
  context: ScopedTenantContext,
  actorUserId: string,
  supplierInvoiceId: string,
  input: DecideSupplierInvoiceInput,
  now = new Date(),
): Promise<SupplierInvoiceDetail> {
  const tenantId = context.tenant.tenantId;
  try {
    return await withTenant(db, context, async (tx) => {
      const found = await findInvoice(tx, tenantId, supplierInvoiceId, false);
      await requireOpsPermission(
        tx,
        context,
        actorUserId,
        RELEASE_PERMISSION,
        found.outletId,
      );
      const claim = {
        operation: RELEASE_OPERATION,
        key: input.idempotencyKey,
        outletId: found.outletId,
        fingerprint: requestFingerprint(RELEASE_OPERATION, actorUserId, {
          supplierInvoiceId,
          note: input.note,
        }),
      };
      const replay = await claimPurchasingIdempotency(tx, context, claim);
      if (replay) return supplierInvoiceDetailSchema.parse(replay.replay);

      await lockOrder(tx, tenantId, found.purchaseOrderId);
      const row = await findInvoice(tx, tenantId, supplierInvoiceId, true);
      await lockPayableSource(tx, tenantId, row.id);
      requireHeld(row);
      if (row.recordedBy.toLowerCase() === actorUserId.toLowerCase())
        throw new PurchasingError(
          "SUPPLIER_INVOICE_SELF_RELEASE",
          "The recorder cannot release the invoice.",
        );
      const { evaluation, toleranceBp, supplierName } =
        await evaluateHeldInvoice(tx, tenantId, row, now);
      if (evaluation.issues.some((issue) => !RELEASABLE_ISSUES.includes(issue)))
        throw new PurchasingError(
          "SUPPLIER_INVOICE_RELEASE_BLOCKED",
          "The invoice has a problem finance cannot release.",
        );

      const journalEntryId = await postSupplierInvoicePayableInTransaction(
        tx,
        context,
        payableInputOf(row, supplierName),
        actorUserId,
        now,
      );
      // The invoice stays a `discrepancy` (the DB state check); the snapshot
      // is refreshed only while it still shows an issue.
      const [updated] = await tx
        .update(purchaseInvoices)
        .set({
          status: "released",
          decidedBy: actorUserId,
          decidedAt: now,
          decisionNote: input.note,
          journalEntryId,
          updatedAt: now,
          ...(evaluation.held
            ? {
                matchSnapshot: evaluation.match,
                matchNote: evaluation.note,
                toleranceBp,
              }
            : {}),
        })
        .where(
          and(
            eq(purchaseInvoices.tenantId, tenantId),
            eq(purchaseInvoices.id, row.id),
          ),
        )
        .returning();

      await appendRecordedEvent(tx, context, updated!, actorUserId, now);
      await auditInvoice(tx, context, {
        actorUserId,
        action: "purchasing.supplier_invoice_released",
        before: row,
        after: updated!,
        issues: evaluation.issues,
        reason: input.note,
      });
      const detail = await detailOf(tx, updated!);
      await completePurchasingIdempotency(tx, context, claim, detail);
      return detail;
    });
  } catch (error) {
    throw translateInvoiceError(error);
  }
}

/**
 * POST reject of a held invoice: it will never be booked and its number and
 * quantities are free again. Matching or finance may reject. A matched or
 * released invoice has a payable and cannot be rejected here (409).
 */
export async function rejectSupplierInvoice(
  context: ScopedTenantContext,
  actorUserId: string,
  supplierInvoiceId: string,
  input: DecideSupplierInvoiceInput,
  now = new Date(),
): Promise<SupplierInvoiceDetail> {
  const tenantId = context.tenant.tenantId;
  try {
    return await withTenant(db, context, async (tx) => {
      const found = await findInvoice(tx, tenantId, supplierInvoiceId, false);
      requireInvoiceRead(
        await accessSnapshotInTransaction(tx, context, actorUserId, now),
        found.outletId,
      );
      const claim = {
        operation: REJECT_OPERATION,
        key: input.idempotencyKey,
        outletId: found.outletId,
        fingerprint: requestFingerprint(REJECT_OPERATION, actorUserId, {
          supplierInvoiceId,
          note: input.note,
        }),
      };
      const replay = await claimPurchasingIdempotency(tx, context, claim);
      if (replay) return supplierInvoiceDetailSchema.parse(replay.replay);

      await lockOrder(tx, tenantId, found.purchaseOrderId);
      const row = await findInvoice(tx, tenantId, supplierInvoiceId, true);
      requireHeld(row);
      const [updated] = await tx
        .update(purchaseInvoices)
        .set({
          status: "rejected",
          decidedBy: actorUserId,
          decidedAt: now,
          decisionNote: input.note,
          updatedAt: now,
        })
        .where(
          and(
            eq(purchaseInvoices.tenantId, tenantId),
            eq(purchaseInvoices.id, row.id),
          ),
        )
        .returning();
      await auditInvoice(tx, context, {
        actorUserId,
        action: "purchasing.supplier_invoice_rejected",
        before: row,
        after: updated!,
        issues: [],
        reason: input.note,
      });
      const detail = await detailOf(tx, updated!);
      await completePurchasingIdempotency(tx, context, claim, detail);
      return detail;
    });
  } catch (error) {
    throw translateInvoiceError(error);
  }
}

// ------------------------------------------------------------------ reads

/** GET supplier invoices of one outlet, newest first. */
export async function listSupplierInvoices(
  context: ScopedTenantContext,
  actorUserId: string,
  query: SupplierInvoiceQuery,
): Promise<CursorPage<SupplierInvoice>> {
  assertOutlet(context, query.outletId);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    requireInvoiceRead(
      await accessSnapshotInTransaction(tx, context, actorUserId, new Date()),
      query.outletId,
    );
    const filters: SQL[] = [
      eq(purchaseInvoices.tenantId, tenantId),
      eq(purchaseInvoices.outletId, query.outletId),
    ];
    if (query.supplierId)
      filters.push(eq(purchaseInvoices.supplierId, query.supplierId));
    if (query.purchaseOrderId)
      filters.push(eq(purchaseInvoices.purchaseOrderId, query.purchaseOrderId));
    if (query.status) filters.push(eq(purchaseInvoices.status, query.status));
    if (query.matchStatus === "matched")
      filters.push(inArray(purchaseInvoices.status, ["matched", "released"]));
    else if (query.matchStatus === "discrepancy")
      filters.push(inArray(purchaseInvoices.status, ["held", "rejected"]));
    // An invoice is never `pending`: it is matched when it is recorded.
    else if (query.matchStatus === "pending") filters.push(sql`false`);
    if (query.fromDate)
      filters.push(sql`${purchaseInvoices.invoiceDate} >= ${query.fromDate}`);
    if (query.toDate)
      filters.push(sql`${purchaseInvoices.invoiceDate} <= ${query.toDate}`);
    const [recordedAt, id] = cursorKeys(query.cursor, 2);
    if (recordedAt !== undefined && id !== undefined) {
      const at = cursorInstant(recordedAt);
      filters.push(
        or(
          lt(purchaseInvoices.recordedAt, at),
          and(
            eq(purchaseInvoices.recordedAt, at),
            sql`${purchaseInvoices.id} < ${cursorUuid(id)}::uuid`,
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(purchaseInvoices)
      .where(and(...filters))
      .orderBy(desc(purchaseInvoices.recordedAt), desc(purchaseInvoices.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const settled = await loadSettled(
      tx,
      tenantId,
      page.map((row) => row.id),
    );
    const last = page.at(-1);
    return {
      data: page.map((row) => toInvoice(row, settled.get(row.id) ?? 0)),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.recordedAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

/** GET one supplier invoice with lines and match; another outlet or tenant is a 404. */
export async function getSupplierInvoice(
  context: ScopedTenantContext,
  actorUserId: string,
  supplierInvoiceId: string,
): Promise<SupplierInvoiceDetail> {
  return withTenant(db, context, async (tx) => {
    const row = await findInvoice(
      tx,
      context.tenant.tenantId,
      supplierInvoiceId,
      false,
    );
    requireInvoiceRead(
      await accessSnapshotInTransaction(tx, context, actorUserId, new Date()),
      row.outletId,
    );
    return detailOf(tx, row);
  });
}
