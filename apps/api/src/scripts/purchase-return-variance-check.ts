// Read-only check (legend-eestb): purchase returns posted before the price
// variance fix (legend-5b7uf) stored `price_variance_idr = 0` even when the
// supplier invoice billed another price than the PO. The debit note then
// cleared the payable at order price and left the difference on the invoice.
// For every return with an invoiced part this recomputes the variance it should
// have stored (billed value of the returned quantity minus the stored invoiced
// value, the rule of purchase-return.service.ts) and reports the mismatches.
// It never writes: the transaction is READ ONLY. An empty report means safe.
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  idr,
  parseDecimal4,
  tenantIdSchema,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { slugSchema } from "@starter/shared/platform";
import { goodsReceiptLines } from "../db/schema/inventory-receiving.ts";
import {
  purchaseReturnLines,
  purchaseReturns,
} from "../db/schema/purchase-returns.ts";
import {
  purchaseInvoiceLines,
  purchaseInvoices,
  supplierInvoices,
} from "../db/schema/purchasing.ts";
import {
  computeReturnBilling,
  priceVarianceOf,
  ReturnExceedsPayableError,
  splitReturnLines,
  type BillingInvoice,
  type BillingInvoiceLine,
} from "../services/purchase-return-billing.ts";
import type { Tx } from "../services/metric-sources/types";

export const PURCHASE_ORDER_BATCH_SIZE = 25;
export const USAGE =
  "Usage: pnpm --filter @starter/api purchase-return:variance-check -- [--tenant <slug>] [--json]\n" +
  "Read-only. Exit 0: nothing to fix, 3: mismatches found, 2: bad input, 1: failure.";

export class PurchaseReturnVarianceUsageError extends Error {}

export function parseArgs(args: string[]) {
  let tenant: string | undefined;
  let json = false;
  const values = args.filter((arg) => arg !== "--");
  for (let i = 0; i < values.length; i += 1) {
    const arg = values[i];
    if (arg === "--tenant" && !tenant && values[i + 1]) tenant = values[++i];
    else if (arg === "--json" && !json) json = true;
    else
      throw new PurchaseReturnVarianceUsageError(
        "Unknown or repeated argument.",
      );
  }
  if (tenant !== undefined && !slugSchema.safeParse(tenant).success)
    throw new PurchaseReturnVarianceUsageError(
      "--tenant must be a tenant slug.",
    );
  return { tenant, json };
}

// ---------------------------------------------------------------- pure core

export type VarianceCheckReturn = {
  id: string;
  number: string;
  returnedOn: string;
  /** ISO instant; orders the returns of one PO together with `id`. */
  returnedAt: string;
  /**
   * ISO instant the row was really written (`created_at`); invoice changes are
   * compared with this, not with the business date. Falls back to `returnedAt`.
   */
  postedAt?: string | null;
  invoicedValueIdr: number;
  priceVarianceIdr: number;
  ppnIdr: number;
  lines: readonly {
    purchaseOrderLineId: string;
    /** Decimal4 string, base unit. */
    quantity: string;
    lineValueIdr: number;
  }[];
};

export type VarianceCheckPurchaseOrder = {
  purchaseOrderId: string;
  /** Matched/released invoices in (invoice date, id) order. */
  invoices: readonly (BillingInvoice & {
    /** ISO instant of the latest record/decision/update of the invoice. */
    changedAt?: string | null;
  })[];
  /** Goods lines of those invoices. */
  invoiceLines: readonly BillingInvoiceLine[];
  receiptLines: readonly {
    purchaseOrderLineId: string | null;
    quantityReceived: string;
    quantityRejected: string;
    acceptedBaseQuantity: string;
  }[];
  returns: readonly VarianceCheckReturn[];
};

export type ReturnVarianceFinding = {
  purchaseOrderId: string;
  purchaseReturnId: string;
  number: string;
  returnedOn: string;
  invoicedValueIdr: number;
  /** Billed value of the returned quantity (invoice line totals consumed). */
  billedIdr: number;
  storedPriceVarianceIdr: number;
  expectedPriceVarianceIdr: number;
  /** expected - stored: the amount the debit note was short (negative: over). */
  differenceIdr: number;
  /**
   * The recompute reads the invoices as they are now. True when an invoice of
   * this PO was recorded or changed after the return was posted: the finding
   * may then be wrong and a person must look at it before acting on it.
   */
  needsManualReview: boolean;
  reviewNote: string | null;
};

export type UnresolvedReturn = {
  purchaseOrderId: string;
  purchaseReturnId: string;
  number: string;
  reason: string;
};

function sumByPoLine<T extends { purchaseOrderLineId: string | null }>(
  rows: readonly T[],
  amount: (row: T) => bigint,
): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const row of rows)
    if (row.purchaseOrderLineId)
      totals.set(
        row.purchaseOrderLineId,
        (totals.get(row.purchaseOrderLineId) ?? 0n) + amount(row),
      );
  return totals;
}

/**
 * Replays the returns of ONE purchase order in order, as the return service saw
 * them (earlier returns count as already taken), and reports every return with
 * an invoiced part whose stored price variance differs from the recomputed one.
 * Pure: no I/O. Returns without an invoiced part are skipped.
 */
export function checkPurchaseOrderReturns(po: VarianceCheckPurchaseOrder): {
  checked: number;
  findings: ReturnVarianceFinding[];
  unresolved: UnresolvedReturn[];
} {
  const findings: ReturnVarianceFinding[] = [];
  const unresolved: UnresolvedReturn[] = [];
  let checked = 0;
  const invoicedPo = sumByPoLine(po.invoiceLines, (row) =>
    parseDecimal4(row.quantity),
  );
  const acceptedPo = sumByPoLine(
    po.receiptLines,
    (row) =>
      parseDecimal4(row.quantityReceived) - parseDecimal4(row.quantityRejected),
  );
  const acceptedBase = sumByPoLine(po.receiptLines, (row) =>
    parseDecimal4(row.acceptedBaseQuantity),
  );
  const ordered = [...po.returns].sort((a, b) =>
    a.returnedAt === b.returnedAt
      ? a.id < b.id
        ? -1
        : 1
      : a.returnedAt < b.returnedAt
        ? -1
        : 1,
  );
  const returnedBase = new Map<string, bigint>();
  let creditedPpnBeforeIdr = 0;
  for (const ret of ordered) {
    const lineQuantities = new Map<string, bigint>();
    const lineValues = new Map<string, number>();
    for (const line of ret.lines) {
      lineQuantities.set(
        line.purchaseOrderLineId,
        (lineQuantities.get(line.purchaseOrderLineId) ?? 0n) +
          parseDecimal4(line.quantity),
      );
      lineValues.set(
        line.purchaseOrderLineId,
        (lineValues.get(line.purchaseOrderLineId) ?? 0) + line.lineValueIdr,
      );
    }
    const priorPpn = creditedPpnBeforeIdr;
    const priorReturned = new Map(returnedBase);
    // This return now counts for the ones after it, whatever it is.
    creditedPpnBeforeIdr += ret.ppnIdr;
    for (const [lineId, quantity] of lineQuantities)
      returnedBase.set(lineId, (returnedBase.get(lineId) ?? 0n) + quantity);
    if (ret.invoicedValueIdr <= 0) continue;
    checked += 1;
    try {
      const split = splitReturnLines(
        [...lineQuantities].map(([purchaseOrderLineId, quantity]) => ({
          purchaseOrderLineId,
          quantity,
          lineValueIdr: lineValues.get(purchaseOrderLineId) ?? 0,
        })),
        { invoicedPo, acceptedPo, acceptedBase, returnedBase: priorReturned },
      );
      const billing = computeReturnBilling({
        invoices: po.invoices,
        invoiceLineRows: po.invoiceLines,
        invoicedParts: split.invoicedParts,
        creditedPpnBeforeIdr: priorPpn,
      });
      // Variance against the invoiced value the return really booked.
      const expected = priceVarianceOf(billing.billedIdr, ret.invoicedValueIdr);
      if (expected === ret.priceVarianceIdr) continue;
      const late = po.invoices.some(
        (invoice) =>
          !!invoice.changedAt &&
          invoice.changedAt > (ret.postedAt ?? ret.returnedAt),
      );
      findings.push({
        purchaseOrderId: po.purchaseOrderId,
        purchaseReturnId: ret.id,
        number: ret.number,
        returnedOn: ret.returnedOn,
        invoicedValueIdr: ret.invoicedValueIdr,
        billedIdr: Number(billing.billedIdr),
        storedPriceVarianceIdr: ret.priceVarianceIdr,
        expectedPriceVarianceIdr: expected,
        differenceIdr: expected - ret.priceVarianceIdr,
        needsManualReview: late,
        reviewNote: late
          ? "A supplier invoice of this PO was created or changed after the return was posted; check it by hand."
          : null,
      });
    } catch (error) {
      if (!(error instanceof ReturnExceedsPayableError) && !isRange(error))
        throw error;
      unresolved.push({
        purchaseOrderId: po.purchaseOrderId,
        purchaseReturnId: ret.id,
        number: ret.number,
        reason:
          error instanceof ReturnExceedsPayableError
            ? "invoice slots do not cover the returned quantity"
            : "amount too large to recompute",
      });
    }
  }
  return { checked, findings, unresolved };
}

function isRange(error: unknown): boolean {
  return error instanceof RangeError;
}

// ------------------------------------------------------------------ database

async function loadPurchaseOrder(
  tx: Tx,
  tenantId: TenantId,
  purchaseOrderId: string,
): Promise<VarianceCheckPurchaseOrder> {
  const invoices = await tx
    .select({
      id: purchaseInvoices.id,
      totalIdr: purchaseInvoices.totalIdr,
      ppnIdr: purchaseInvoices.ppnIdr,
      recordedAt: purchaseInvoices.recordedAt,
      decidedAt: purchaseInvoices.decidedAt,
      updatedAt: purchaseInvoices.updatedAt,
    })
    .from(purchaseInvoices)
    .where(
      and(
        eq(purchaseInvoices.tenantId, tenantId),
        eq(purchaseInvoices.purchaseOrderId, purchaseOrderId),
        inArray(purchaseInvoices.status, ["matched", "released"]),
      ),
    )
    .orderBy(asc(purchaseInvoices.invoiceDate), asc(purchaseInvoices.id));
  // The AP record shares the id of the purchase invoice (= its open item id);
  // its created_at counts as a change moment too.
  const apCreated =
    invoices.length === 0
      ? []
      : await tx
          .select({
            id: supplierInvoices.id,
            createdAt: supplierInvoices.createdAt,
          })
          .from(supplierInvoices)
          .where(
            and(
              eq(supplierInvoices.tenantId, tenantId),
              inArray(
                supplierInvoices.id,
                invoices.map((invoice) => invoice.id),
              ),
            ),
          );
  const apCreatedAt = new Map(apCreated.map((row) => [row.id, row.createdAt]));
  const invoiceLines =
    invoices.length === 0
      ? []
      : await tx
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
            ),
          );
  const returns = await tx
    .select({
      id: purchaseReturns.id,
      number: purchaseReturns.number,
      returnedOn: purchaseReturns.returnedOn,
      returnedAt: purchaseReturns.returnedAt,
      createdAt: purchaseReturns.createdAt,
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
  const returnLines =
    returns.length === 0
      ? []
      : await tx
          .select({
            purchaseReturnId: purchaseReturnLines.purchaseReturnId,
            purchaseOrderLineId: purchaseReturnLines.purchaseOrderLineId,
            quantity: purchaseReturnLines.quantity,
            lineValueIdr: purchaseReturnLines.lineValueIdr,
          })
          .from(purchaseReturnLines)
          .where(
            and(
              eq(purchaseReturnLines.tenantId, tenantId),
              inArray(
                purchaseReturnLines.purchaseReturnId,
                returns.map((row) => row.id),
              ),
            ),
          );
  const poLineIds = [...new Set(returnLines.map((l) => l.purchaseOrderLineId))];
  const receiptLines =
    poLineIds.length === 0
      ? []
      : await tx
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
  return {
    purchaseOrderId,
    invoices: invoices.map((invoice) => ({
      id: invoice.id,
      totalIdr: invoice.totalIdr,
      ppnIdr: invoice.ppnIdr,
      changedAt: [
        apCreatedAt.get(invoice.id),
        invoice.recordedAt,
        invoice.decidedAt,
        invoice.updatedAt,
      ]
        .filter((at): at is Date => at instanceof Date)
        .map((at) => at.toISOString())
        .reduce<string | null>((a, b) => (a === null || b > a ? b : a), null),
    })),
    invoiceLines,
    receiptLines,
    returns: returns.map((row) => ({
      id: row.id,
      number: row.number,
      returnedOn: row.returnedOn,
      returnedAt: row.returnedAt.toISOString(),
      postedAt: row.createdAt.toISOString(),
      invoicedValueIdr: row.invoicedValueIdr,
      priceVarianceIdr: row.priceVarianceIdr,
      ppnIdr: row.ppnIdr,
      lines: returnLines.filter((line) => line.purchaseReturnId === row.id),
    })),
  };
}

export type PurchaseReturnVarianceReport = {
  tenants: number;
  purchaseOrders: number;
  returnsChecked: number;
  findings: (ReturnVarianceFinding & { tenantId: string })[];
  unresolved: (UnresolvedReturn & { tenantId: string })[];
  /** Findings with `needsManualReview` (late or changed invoices). */
  manualReviewCount: number;
  /** Sum of `differenceIdr` over all findings. */
  totalDifferenceIdr: number;
};

/** Scans every tenant (or one slug). Writes nothing. Empty findings = safe. */
export async function checkPurchaseReturnVariance(
  options: { tenant?: string; log?: (line: string) => void } = {},
): Promise<PurchaseReturnVarianceReport> {
  if (
    options.tenant !== undefined &&
    !slugSchema.safeParse(options.tenant).success
  )
    throw new PurchaseReturnVarianceUsageError(
      "--tenant must be a tenant slug.",
    );
  // Delay app/config imports until CLI argument validation and env loading.
  const { db } = await import("../db/index");
  const { withTenant } = await import("../db/tenant");
  const report: PurchaseReturnVarianceReport = {
    tenants: 0,
    purchaseOrders: 0,
    returnsChecked: 0,
    findings: [],
    unresolved: [],
    manualReviewCount: 0,
    totalDifferenceIdr: 0,
  };
  let tenantAfter = "";
  for (;;) {
    const page = await db.execute(sql`
      SELECT id FROM tenants
       WHERE id::text > ${tenantAfter}
         ${options.tenant === undefined ? sql`` : sql`AND slug = ${options.tenant}`}
       ORDER BY id::text LIMIT ${PURCHASE_ORDER_BATCH_SIZE}`);
    if (page.rows.length === 0) break;
    for (const row of page.rows) {
      const tenantId = tenantIdSchema.parse(row.id);
      tenantAfter = tenantId;
      report.tenants += 1;
      const context: ScopedTenantContext = establishScopedTenantContext(
        establishTenantContext({ tenantId, brandId: null, source: "job" }),
        { kind: "tenant" },
      );
      let poAfter = "00000000-0000-0000-0000-000000000000";
      for (;;) {
        const found = await withTenant(db, context, async (tx) => {
          // Belt and braces: the database refuses any write in this transaction.
          await tx.execute(sql`SET TRANSACTION READ ONLY`);
          const ids = await tx
            .selectDistinct({ id: purchaseReturns.purchaseOrderId })
            .from(purchaseReturns)
            .where(
              and(
                eq(purchaseReturns.tenantId, tenantId),
                gt(purchaseReturns.invoicedValueIdr, idr(0)),
                gt(purchaseReturns.purchaseOrderId, poAfter),
              ),
            )
            .orderBy(asc(purchaseReturns.purchaseOrderId))
            .limit(PURCHASE_ORDER_BATCH_SIZE);
          const orders: VarianceCheckPurchaseOrder[] = [];
          for (const { id } of ids)
            orders.push(await loadPurchaseOrder(tx, tenantId, id));
          return orders;
        });
        if (found.length === 0) break;
        for (const order of found) {
          poAfter = order.purchaseOrderId;
          report.purchaseOrders += 1;
          const result = checkPurchaseOrderReturns(order);
          report.returnsChecked += result.checked;
          for (const finding of result.findings) {
            report.findings.push({ ...finding, tenantId });
            report.totalDifferenceIdr += finding.differenceIdr;
            if (finding.needsManualReview) report.manualReviewCount += 1;
          }
          for (const item of result.unresolved)
            report.unresolved.push({ ...item, tenantId });
        }
      }
      (options.log ?? (() => undefined))(
        JSON.stringify({
          tenantId,
          findings: report.findings.filter((f) => f.tenantId === tenantId)
            .length,
        }),
      );
    }
  }
  if (options.tenant !== undefined && report.tenants === 0)
    throw new PurchaseReturnVarianceUsageError("Tenant was not found.");
  return report;
}

export async function cli(args: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(args);
  } catch {
    console.error(USAGE);
    return 2;
  }
  let pool: typeof import("../db/index").pool | undefined;
  try {
    await import("../load-env");
    const { logger } = await import("../lib/logger");
    logger.level = "silent";
    pool = (await import("../db/index")).pool;
    const report = await checkPurchaseReturnVariance({ tenant: parsed.tenant });
    if (parsed.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(
        `Tenants ${report.tenants}, purchase orders ${report.purchaseOrders}, returns checked ${report.returnsChecked}.`,
      );
      for (const finding of report.findings)
        console.log(
          `MISMATCH tenant=${finding.tenantId} ${finding.number}: stored ${finding.storedPriceVarianceIdr}, expected ${finding.expectedPriceVarianceIdr} (difference ${finding.differenceIdr} IDR)${finding.needsManualReview ? " [REVIEW BY HAND: invoice changed after return]" : ""}`,
        );
      for (const item of report.unresolved)
        console.log(
          `UNRESOLVED tenant=${item.tenantId} ${item.number}: ${item.reason}`,
        );
      console.log(
        report.findings.length === 0 && report.unresolved.length === 0
          ? "No mismatches: nothing to fix."
          : `Mismatches: ${report.findings.length}, total difference ${report.totalDifferenceIdr} IDR, manual review: ${report.manualReviewCount}, unresolved: ${report.unresolved.length}.`,
      );
    }
    return report.findings.length > 0 || report.unresolved.length > 0 ? 3 : 0;
  } catch (error) {
    console.error(
      error instanceof PurchaseReturnVarianceUsageError
        ? "Purchase return variance check input was rejected."
        : "Purchase return variance check failed; check database availability and migrations.",
    );
    return error instanceof PurchaseReturnVarianceUsageError ? 2 : 1;
  } finally {
    await pool?.end();
  }
}
