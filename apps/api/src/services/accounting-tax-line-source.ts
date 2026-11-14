// Tax report line sources (bead legend-5nhkp, WS-07; PRD v1.7 §3.19 "Pajak").
// A source turns the books of one (entity, type, period) into report lines;
// the report service only sums and stores them, so a source can be swapped in
// tests or when payroll / AP data feeds PPh 21, PPh 23 and PPN.
//
// PBJT comes from the ledger and the per-sale tax snapshots. Tax: per outlet,
// credit minus debit of the account mapped to `tax_payable_pbjt`, but only for
// journals of sales and refunds (a reversal counts as the entry it reverses),
// so a remittance (setoran) or an opening balance never reduces the tax
// collected. Base: the `taxBaseIdr` snapshot of each sale in the period (after
// discount, as the tax rule computed it; a voided sale subtracts it). A refund
// is linked to its order by journal_entries.order_id (legend-knfl6): its base is
// the order's PBJT snapshot base prorated by refund tax / order PBJT tax (exact
// for a full refund). A refund journal without order id (posted before that
// column) keeps the estimate: its tax grossed up by the outlet's rate of the
// period's sales (latest PBJT snapshot rate when the period has no sales).
// Since legend-xa9bc a sale books PPN and other tax to their own payable
// accounts, so the PBJT account holds PBJT only, except for sales posted before
// the split (all tax in PBJT; their non-PBJT tax is taken out here). An outlet
// whose tax nets to zero or less is left out.
// PPh 23 and PPN: accounting-tax-source-vat-wht.ts. PPh 21 has no wired source yet and refuses to generate.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  AccountingError,
  taxReportLineSchema,
  type TaxReportLine,
  type TaxReportType,
} from "@starter/shared/accounting";
import { idr, ulidToUuid, uuidToUlid } from "@starter/shared/core";
import {
  accountMappings,
  fiscalPeriods,
  journalEntries,
  journalLines,
  outlets,
  taxSnapshots,
} from "../db/schema";
import type { TenantTransaction } from "./accounting-shared";
import { pph23Lines, ppnLines } from "./accounting-tax-source-vat-wht";
import { pph21Lines } from "./accounting-tax-source-pph21";

export type TaxLineSourceArgs = {
  tenantId: string;
  legalEntityId: string;
  type: TaxReportType;
  period: string;
};

export type TaxLineSource = (
  tx: TenantTransaction,
  args: TaxLineSourceArgs,
) => Promise<TaxReportLine[]>;

async function mappedAccountId(
  tx: TenantTransaction,
  args: TaxLineSourceArgs,
  role: "tax_payable_pbjt" | "sales_revenue",
): Promise<string> {
  const accountId = await optionalAccountId(tx, args, role);
  if (!accountId)
    throw new AccountingError(
      "TAX_REPORT_SOURCE_UNAVAILABLE",
      `Akun untuk peran ${role} belum dipetakan, laporan tidak bisa dibuat.`,
    );
  return accountId;
}

async function optionalAccountId(
  tx: TenantTransaction,
  args: TaxLineSourceArgs,
  role:
    | "tax_payable_pbjt"
    | "tax_payable_ppn"
    | "tax_payable_other"
    | "sales_revenue",
): Promise<string | null> {
  const [row] = await tx
    .select({ accountId: accountMappings.accountId })
    .from(accountMappings)
    .where(
      and(
        eq(accountMappings.tenantId, args.tenantId),
        eq(accountMappings.legalEntityId, args.legalEntityId),
        eq(accountMappings.role, role),
      ),
    )
    .limit(1);
  return row?.accountId ?? null;
}

const reversedEntries = alias(journalEntries, "reversed_entries");

/** Journal source of an entry; a reversal carries the source of its original. */
const effectiveSource = sql<string>`coalesce(${reversedEntries.sourceType}, ${journalEntries.sourceType})`;

type TaxByOutlet = {
  /** Net tax of sales and refunds (credit minus debit), per outlet. */
  tax: Map<string | null, bigint>;
  /** Net tax of refunds only, per outlet. */
  refundTax: Map<string | null, bigint>;
};

/** Tax collected: credit minus debit on the tax account, sales and refunds only. */
async function collectedTaxByOutlet(
  tx: TenantTransaction,
  args: TaxLineSourceArgs,
  accountId: string,
): Promise<TaxByOutlet> {
  const outletKey = sql<
    string | null
  >`coalesce(${journalLines.outletId}, ${journalEntries.outletId})`;
  const rows = await tx
    .select({
      outletId: outletKey,
      source: effectiveSource,
      net: sql<string>`sum(${journalLines.creditIdr} - ${journalLines.debitIdr})::text`,
    })
    .from(journalLines)
    .innerJoin(
      journalEntries,
      and(
        eq(journalEntries.tenantId, journalLines.tenantId),
        eq(journalEntries.id, journalLines.entryId),
      ),
    )
    .leftJoin(
      reversedEntries,
      and(
        eq(reversedEntries.tenantId, journalEntries.tenantId),
        eq(reversedEntries.id, journalEntries.reversalOf),
      ),
    )
    .innerJoin(
      fiscalPeriods,
      and(
        eq(fiscalPeriods.tenantId, journalEntries.tenantId),
        eq(fiscalPeriods.id, journalEntries.fiscalPeriodId),
      ),
    )
    .where(
      and(
        eq(journalLines.tenantId, args.tenantId),
        eq(journalLines.accountId, accountId),
        eq(journalEntries.legalEntityId, args.legalEntityId),
        eq(fiscalPeriods.legalEntityId, args.legalEntityId),
        eq(fiscalPeriods.period, args.period),
        inArray(effectiveSource, ["sale", "refund"]),
      ),
    )
    .groupBy(outletKey, effectiveSource);
  const tax = new Map<string | null, bigint>();
  const refundTax = new Map<string | null, bigint>();
  for (const row of rows) {
    const net = BigInt(row.net);
    tax.set(row.outletId, (tax.get(row.outletId) ?? 0n) + net);
    if (row.source === "refund")
      refundTax.set(row.outletId, (refundTax.get(row.outletId) ?? 0n) + net);
  }
  return { tax, refundTax };
}

/**
 * Net tax of the sales of the period booked to the PPN / other payable
 * accounts (legend-xa9bc), per outlet. Zero where no sale was split (or the
 * accounts are not mapped): then every tax sits on the PBJT account.
 */
async function splitSaleTaxByOutlet(
  tx: TenantTransaction,
  args: TaxLineSourceArgs,
): Promise<Map<string | null, bigint>> {
  const booked = new Map<string | null, bigint>();
  // One account per distinct id, and never the PBJT account itself: a role
  // mapped onto another tax account would count its balance twice (and a PPN
  // mapped onto the PBJT account is simply PBJT-booked, like an unsplit sale).
  const pbjtAccount = await optionalAccountId(tx, args, "tax_payable_pbjt");
  const accountIds = new Set<string>();
  for (const role of ["tax_payable_ppn", "tax_payable_other"] as const) {
    const accountId = await optionalAccountId(tx, args, role);
    if (accountId && accountId !== pbjtAccount) accountIds.add(accountId);
  }
  for (const accountId of accountIds) {
    const { tax, refundTax } = await collectedTaxByOutlet(tx, args, accountId);
    for (const [outletId, net] of tax)
      booked.set(
        outletId,
        (booked.get(outletId) ?? 0n) + net - (refundTax.get(outletId) ?? 0n),
      );
  }
  return booked;
}

/** Net PBJT tax (credit minus debit, negative for a refund) of one order's refunds, per outlet. */
type LinkedRefund = { outletId: string; orderId: string; net: bigint };

/** Refund journals of the period linked to an order by journal_entries.order_id. */
async function linkedRefunds(
  tx: TenantTransaction,
  args: TaxLineSourceArgs,
  accountId: string,
): Promise<LinkedRefund[]> {
  const outletKey = sql<
    string | null
  >`coalesce(${journalLines.outletId}, ${journalEntries.outletId})`;
  const orderKey = sql<
    string | null
  >`coalesce(${reversedEntries.orderId}, ${journalEntries.orderId})`;
  const rows = await tx
    .select({
      outletId: outletKey,
      orderId: orderKey,
      net: sql<string>`sum(${journalLines.creditIdr} - ${journalLines.debitIdr})::text`,
    })
    .from(journalLines)
    .innerJoin(
      journalEntries,
      and(
        eq(journalEntries.tenantId, journalLines.tenantId),
        eq(journalEntries.id, journalLines.entryId),
      ),
    )
    .leftJoin(
      reversedEntries,
      and(
        eq(reversedEntries.tenantId, journalEntries.tenantId),
        eq(reversedEntries.id, journalEntries.reversalOf),
      ),
    )
    .innerJoin(
      fiscalPeriods,
      and(
        eq(fiscalPeriods.tenantId, journalEntries.tenantId),
        eq(fiscalPeriods.id, journalEntries.fiscalPeriodId),
      ),
    )
    .where(
      and(
        eq(journalLines.tenantId, args.tenantId),
        eq(journalLines.accountId, accountId),
        eq(journalEntries.legalEntityId, args.legalEntityId),
        eq(fiscalPeriods.legalEntityId, args.legalEntityId),
        eq(fiscalPeriods.period, args.period),
        eq(effectiveSource, "refund"),
        sql`${orderKey} is not null`,
      ),
    )
    .groupBy(outletKey, orderKey);
  return rows
    .filter(
      (row): row is typeof row & { outletId: string; orderId: string } =>
        row.outletId !== null && row.orderId !== null,
    )
    .map((row) => ({
      outletId: row.outletId,
      orderId: row.orderId.toLowerCase(),
      net: BigInt(row.net),
    }));
}

/** PBJT snapshot base and tax of whole orders (any period), by order uuid. */
async function orderPbjtSnapshots(
  tx: TenantTransaction,
  args: TaxLineSourceArgs,
  orderIds: string[],
): Promise<Map<string, { base: bigint; tax: bigint }>> {
  const out = new Map<string, { base: bigint; tax: bigint }>();
  for (let from = 0; from < orderIds.length; from += 5000) {
    const rows = await tx
      .select({
        sourceId: taxSnapshots.sourceId,
        base: taxSnapshots.taxBaseIdr,
        tax: taxSnapshots.taxIdr,
      })
      .from(taxSnapshots)
      .where(
        and(
          sql`${taxSnapshots.tenantId} = ${args.tenantId}`,
          eq(taxSnapshots.sourceType, "order"),
          eq(taxSnapshots.taxType, "pbjt"),
          inArray(taxSnapshots.sourceId, orderIds.slice(from, from + 5000)),
        ),
      );
    for (const row of rows) {
      const key = row.sourceId.toLowerCase();
      const current = out.get(key) ?? { base: 0n, tax: 0n };
      current.base += BigInt(row.base);
      current.tax += BigInt(row.tax);
      out.set(key, current);
    }
  }
  return out;
}

/**
 * Tax each order's sale journal credited to the PBJT account, by order uuid. It
 * equals the PBJT snapshot tax for a split sale, and also holds the PPN / other
 * tax of a sale posted before the split (all tax booked to PBJT). The refund of
 * such a sale debited the same all-PBJT amount, so the refund is prorated over
 * this, not over the PBJT snapshot tax (that would take PPN into the PBJT base).
 */
async function creditedPbjtByOrder(
  tx: TenantTransaction,
  args: TaxLineSourceArgs,
  accountId: string,
  orderIds: string[],
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  for (let from = 0; from < orderIds.length; from += 2000) {
    const chunk = orderIds.slice(from, from + 2000);
    const ulids = chunk.map((id) => uuidToUlid(id));
    const rows = await tx
      .select({
        orderId: journalEntries.orderId,
        sourceId: journalEntries.sourceId,
        net: sql<string>`sum(${journalLines.creditIdr} - ${journalLines.debitIdr})::text`,
      })
      .from(journalEntries)
      .innerJoin(
        journalLines,
        and(
          eq(journalLines.tenantId, journalEntries.tenantId),
          eq(journalLines.entryId, journalEntries.id),
        ),
      )
      .where(
        and(
          eq(journalEntries.tenantId, args.tenantId),
          eq(journalEntries.legalEntityId, args.legalEntityId),
          eq(journalEntries.sourceType, "sale"),
          sql`${journalEntries.reversalOf} is null`,
          eq(journalLines.accountId, accountId),
          sql`(${inArray(journalEntries.orderId, chunk)} or ${inArray(journalEntries.sourceId, ulids)})`,
        ),
      )
      .groupBy(journalEntries.orderId, journalEntries.sourceId);
    for (const row of rows) {
      const key = (
        row.orderId ??
        (row.sourceId !== null && ULID_RE.test(row.sourceId)
          ? ulidToUuid(row.sourceId.toUpperCase())
          : "")
      ).toLowerCase();
      if (key !== "") out.set(key, (out.get(key) ?? 0n) + BigInt(row.net));
    }
  }
  return out;
}

/**
 * Refund base per outlet from the order snapshots: base x refund tax / order
 * tax, negative like the refund. `linkedTax` is the refund tax this covers; the
 * rest of an outlet's refund tax (no order id, or an order without PBJT
 * snapshot) is left to the estimate.
 */
async function linkedRefundBase(
  tx: TenantTransaction,
  args: TaxLineSourceArgs,
  accountId: string,
): Promise<Map<string, { base: bigint; tax: bigint }>> {
  const refunds = await linkedRefunds(tx, args, accountId);
  const orderIds = [...new Set(refunds.map((refund) => refund.orderId))];
  const snapshots = await orderPbjtSnapshots(tx, args, orderIds);
  const credited = await creditedPbjtByOrder(tx, args, accountId, orderIds);
  const byOutlet = new Map<string, { base: bigint; tax: bigint }>();
  for (const refund of refunds) {
    const order = snapshots.get(refund.orderId);
    const collected = credited.get(refund.orderId) ?? 0n;
    if (!order || order.tax <= 0n || collected <= 0n) continue;
    const current = byOutlet.get(refund.outletId) ?? { base: 0n, tax: 0n };
    current.base += divRound(refund.net * order.base, collected);
    current.tax += refund.net;
    byOutlet.set(refund.outletId, current);
  }
  return byOutlet;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// First character 0-7: a ULID is 128 bits, so a larger one cannot decode.
const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;

/** The `uuid` a sale journal's source id is stored as in tax_snapshots. */
function snapshotSourceId(sourceId: string): string | null {
  if (UUID_RE.test(sourceId)) return sourceId.toLowerCase();
  if (ULID_RE.test(sourceId)) return ulidToUuid(sourceId.toUpperCase());
  return null;
}

/**
 * Tax base and snapshot tax of the sales posted in the period, per snapshot
 * outlet. The sale journals carry the order id as ULID text (or a UUID); the
 * snapshots store it as a uuid. A reversal (void) of a sale counts negative.
 */
/** Snapshot totals of an outlet's sales, signed by sale (+) and void (-). */
type OutletSnapshots = {
  /** PBJT base and tax: the figures of the report. */
  base: bigint;
  tax: bigint;
  /** PBJT rows with a rate above 0%, for the refund gross-up ratio. */
  ratedBase: bigint;
  ratedTax: bigint;
  /** Tax of the other tax types (PPN, other): booked to PBJT by the journal. */
  otherTax: bigint;
};

type SaleSnapshots = {
  byOutlet: Map<string, OutletSnapshots>;
  /** Source ids (journal form) of sales in the period without any snapshot. */
  missing: string[];
};

async function saleSnapshotsByOutlet(
  tx: TenantTransaction,
  args: TaxLineSourceArgs,
): Promise<SaleSnapshots> {
  const sign = sql<number>`case when ${journalEntries.reversalOf} is null then 1 else -1 end`;
  const sourceId = sql<
    string | null
  >`coalesce(${reversedEntries.sourceId}, ${journalEntries.sourceId})`;
  const entries = await tx
    .select({
      sourceId,
      net: sql<string>`sum(${sign})::text`,
    })
    .from(journalEntries)
    .leftJoin(
      reversedEntries,
      and(
        eq(reversedEntries.tenantId, journalEntries.tenantId),
        eq(reversedEntries.id, journalEntries.reversalOf),
      ),
    )
    .innerJoin(
      fiscalPeriods,
      and(
        eq(fiscalPeriods.tenantId, journalEntries.tenantId),
        eq(fiscalPeriods.id, journalEntries.fiscalPeriodId),
      ),
    )
    .where(
      and(
        eq(journalEntries.tenantId, args.tenantId),
        eq(journalEntries.legalEntityId, args.legalEntityId),
        eq(fiscalPeriods.legalEntityId, args.legalEntityId),
        eq(fiscalPeriods.period, args.period),
        eq(effectiveSource, "sale"),
      ),
    )
    .groupBy(sourceId);
  const weight = new Map<string, bigint>();
  const journalForm = new Map<string, string>();
  for (const entry of entries) {
    const id =
      entry.sourceId === null ? null : snapshotSourceId(entry.sourceId);
    if (id === null || entry.sourceId === null) continue;
    weight.set(id, (weight.get(id) ?? 0n) + BigInt(entry.net));
    journalForm.set(id, entry.sourceId);
  }
  const byOutlet = new Map<string, OutletSnapshots>();
  if (weight.size === 0) return { byOutlet, missing: [] };

  // Batched: one bind parameter per id, and Postgres allows 65,535 per query.
  const ids = [...weight.keys()];
  const snapshots: {
    outletId: string;
    sourceId: string;
    taxType: string;
    rateBp: number;
    base: number;
    tax: number;
  }[] = [];
  for (let from = 0; from < ids.length; from += 5000) {
    snapshots.push(
      ...(await tx
        .select({
          outletId: taxSnapshots.outletId,
          sourceId: taxSnapshots.sourceId,
          taxType: taxSnapshots.taxType,
          rateBp: taxSnapshots.rateBp,
          base: taxSnapshots.taxBaseIdr,
          tax: taxSnapshots.taxIdr,
        })
        .from(taxSnapshots)
        .where(
          and(
            sql`${taxSnapshots.tenantId} = ${args.tenantId}`,
            // Every tax type: the sale journal books all of an order's tax to
            // the PBJT account, so the ledger can only be checked against all.
            inArray(taxSnapshots.sourceId, ids.slice(from, from + 5000)),
          ),
        )),
    );
  }
  const seen = new Set<string>();
  for (const row of snapshots) {
    const key = row.sourceId.toLowerCase();
    seen.add(key);
    const w = weight.get(key) ?? 0n;
    const current = byOutlet.get(row.outletId) ?? {
      base: 0n,
      tax: 0n,
      ratedBase: 0n,
      ratedTax: 0n,
      otherTax: 0n,
    };
    if (row.taxType !== "pbjt") current.otherTax += w * BigInt(row.tax);
    else {
      current.base += w * BigInt(row.base);
      current.tax += w * BigInt(row.tax);
      if (row.rateBp > 0) {
        current.ratedBase += w * BigInt(row.base);
        current.ratedTax += w * BigInt(row.tax);
      }
    }
    byOutlet.set(row.outletId, current);
  }
  const missing = [...weight.entries()]
    .filter(([id, w]) => w > 0n && !seen.has(id))
    .map(([id]) => journalForm.get(id) ?? id)
    .sort();
  return { byOutlet, missing };
}

/** First day of the month after "YYYY-MM". */
function periodEndExclusive(period: string): string {
  const [year, month] = period.split("-").map(Number) as [number, number];
  return month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, "0")}-01`;
}

/** PBJT rate (basis points) of the outlet's latest snapshot, if any. */
async function latestRateBp(
  tx: TenantTransaction,
  args: TaxLineSourceArgs,
  outletId: string,
): Promise<number | null> {
  const [row] = await tx
    .select({ rateBp: taxSnapshots.rateBp })
    .from(taxSnapshots)
    .where(
      and(
        sql`${taxSnapshots.tenantId} = ${args.tenantId}`,
        sql`${taxSnapshots.outletId} = ${outletId}`,
        eq(taxSnapshots.taxType, "pbjt"),
        // Bounded by the period so regenerating a closed period is stable.
        sql`${taxSnapshots.businessDate} < ${periodEndExclusive(args.period)}`,
      ),
    )
    .orderBy(
      desc(taxSnapshots.businessDate),
      desc(taxSnapshots.createdAt),
      desc(taxSnapshots.id),
    )
    .limit(1);
  return row && row.rateBp > 0 ? row.rateBp : null;
}

/** Whole-rupiah division rounded half away from zero. */
function divRound(numerator: bigint, denominator: bigint): bigint {
  const twice = 2n * numerator + (numerator < 0n ? -denominator : denominator);
  return twice / (2n * denominator);
}

const toIdr = (value: bigint) => idr(Number(value));

async function pbjtLines(
  tx: TenantTransaction,
  args: TaxLineSourceArgs,
): Promise<TaxReportLine[]> {
  const taxAccount = await mappedAccountId(tx, args, "tax_payable_pbjt");
  const { tax, refundTax } = await collectedTaxByOutlet(tx, args, taxAccount);

  // A line needs an outlet (PBJT is per outlet/region); tax booked without one
  // cannot be reported, so refuse instead of dropping it from the total.
  if ((tax.get(null) ?? 0n) !== 0n)
    throw new AccountingError(
      "TAX_REPORT_SOURCE_UNAVAILABLE",
      "Ada PBJT tanpa outlet di buku besar, laporan tidak bisa dibuat.",
    );

  const outletIds = [...tax.entries()]
    .filter((entry): entry is [string, bigint] => entry[0] !== null)
    .filter(([, net]) => net > 0n)
    .map(([outletId]) => outletId);
  if (outletIds.length === 0) return [];

  const names = await tx
    .select({ id: outlets.id, name: outlets.name })
    .from(outlets)
    .where(
      and(eq(outlets.tenantId, args.tenantId), inArray(outlets.id, outletIds)),
    );
  const nameOf = new Map(names.map((row) => [row.id, row.name]));

  const { byOutlet: sales, missing } = await saleSnapshotsByOutlet(tx, args);
  const splitBooked = await splitSaleTaxByOutlet(tx, args);
  /** Non-PBJT tax still sitting on the PBJT account: sales posted before the split. */
  const legacyOtherTax = (outletId: string): bigint =>
    (sales.get(outletId)?.otherTax ?? 0n) - (splitBooked.get(outletId) ?? 0n);

  // The base comes from the snapshots, the tax from the ledger: they must agree
  // on the sales of the period, else a sale lacks its snapshot (or was
  // re-quoted after posting) and the base would be wrong without any warning.
  // Fail closed, and say which outlet and by how much.
  const mismatches: string[] = [];
  for (const outletId of outletIds) {
    const ledgerSaleTax =
      (tax.get(outletId) ?? 0n) - (refundTax.get(outletId) ?? 0n);
    const found = sales.get(outletId);
    const snapshotTax = (found?.tax ?? 0n) + legacyOtherTax(outletId);
    if (snapshotTax !== ledgerSaleTax)
      mismatches.push(
        `${nameOf.get(outletId) ?? outletId}: buku besar Rp${ledgerSaleTax}, snapshot Rp${snapshotTax}, selisih Rp${ledgerSaleTax - snapshotTax}`,
      );
  }
  if (mismatches.length > 0) {
    const sample = missing.slice(0, 3).join(", ");
    throw new AccountingError(
      "TAX_REPORT_SOURCE_UNAVAILABLE",
      `Pajak PBJT di buku besar tidak cocok dengan snapshot pajak transaksi (${mismatches.join("; ")})` +
        (missing.length > 0
          ? `. Penjualan tanpa snapshot: ${missing.length}, contoh id: ${sample}`
          : "") +
        ". Laporan tidak bisa dibuat.",
    );
  }

  const linked = await linkedRefundBase(tx, args, taxAccount);
  const lines: TaxReportLine[] = [];
  for (const outletId of outletIds) {
    const sale = sales.get(outletId) ?? {
      base: 0n,
      tax: 0n,
      ratedBase: 0n,
      ratedTax: 0n,
      otherTax: 0n,
    };
    // Refund base: from the order snapshot where the refund journal carries
    // its order; the rest is the tax grossed up by the effective rate of the
    // period's taxed sales (0% snapshots left out), else by the latest
    // snapshot rate.
    const refund = refundTax.get(outletId) ?? 0n;
    const fromOrders = linked.get(outletId) ?? { base: 0n, tax: 0n };
    const estimated = refund - fromOrders.tax;
    let refundBase = fromOrders.base;
    if (estimated !== 0n) {
      if (sale.ratedTax > 0n && sale.ratedBase > 0n)
        refundBase += divRound(estimated * sale.ratedBase, sale.ratedTax);
      else {
        const rateBp = await latestRateBp(tx, args, outletId);
        if (rateBp !== null)
          refundBase += divRound(estimated * 10000n, BigInt(rateBp));
      }
    }
    const base = sale.base + refundBase;
    // The report carries PBJT only: the PBJT snapshot tax of the sales plus
    // the refunds (negative) booked on the PBJT account.
    const pbjtTax = sale.tax + refund;
    if (pbjtTax <= 0n) continue;
    lines.push(
      taxReportLineSchema.parse({
        subjectType: "outlet",
        subjectId: outletId,
        subjectName: nameOf.get(outletId) ?? outletId,
        taxIdMasked: null,
        outletId,
        baseIdr: toIdr(base > 0n ? base : 0n),
        taxIdr: toIdr(pbjtTax),
        references: [],
        // Auditor note for the screen; the Coretax export never carries it.
        warnings:
          legacyOtherTax(outletId) !== 0n
            ? [`Pajak non-PBJT Rp${legacyOtherTax(outletId)} tidak ikut`]
            : [],
      }),
    );
  }
  return lines.sort((a, b) =>
    a.subjectName === b.subjectName
      ? a.subjectId.localeCompare(b.subjectId)
      : a.subjectName.localeCompare(b.subjectName),
  );
}

export const defaultTaxLineSource: TaxLineSource = async (tx, args) => {
  if (args.type === "pbjt") return pbjtLines(tx, args);
  if (args.type === "pph23") return pph23Lines(tx, args);
  if (args.type === "ppn") return ppnLines(tx, args);
  if (args.type === "pph21") return pph21Lines(tx, args);
  throw new AccountingError(
    "TAX_REPORT_SOURCE_UNAVAILABLE",
    `Sumber data ${String(args.type).toUpperCase()} belum tersedia.`,
  );
};
