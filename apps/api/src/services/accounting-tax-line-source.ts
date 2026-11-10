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
// has no link to its order in the ledger, so its base is its tax grossed up by
// the outlet's rate of the period's sales (latest PBJT snapshot rate when the
// period has no sales). An outlet whose tax nets to zero or less is left out.
// PPh 21 / PPh 23 / PPN have no wired source yet and refuse to generate.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  AccountingError,
  taxReportLineSchema,
  type TaxReportLine,
  type TaxReportType,
} from "@starter/shared/accounting";
import { idr, ulidToUuid } from "@starter/shared/core";
import {
  accountMappings,
  fiscalPeriods,
  journalEntries,
  journalLines,
  outlets,
  taxSnapshots,
} from "../db/schema";
import type { TenantTransaction } from "./accounting-shared";

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
  if (!row)
    throw new AccountingError(
      "TAX_REPORT_SOURCE_UNAVAILABLE",
      `Akun untuk peran ${role} belum dipetakan, laporan tidak bisa dibuat.`,
    );
  return row.accountId;
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
type SaleSnapshots = {
  byOutlet: Map<string, { base: bigint; tax: bigint }>;
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
  const byOutlet = new Map<string, { base: bigint; tax: bigint }>();
  if (weight.size === 0) return { byOutlet, missing: [] };

  // Batched: one bind parameter per id, and Postgres allows 65,535 per query.
  const ids = [...weight.keys()];
  const snapshots: {
    outletId: string;
    sourceId: string;
    base: number;
    tax: number;
  }[] = [];
  for (let from = 0; from < ids.length; from += 5000) {
    snapshots.push(
      ...(await tx
        .select({
          outletId: taxSnapshots.outletId,
          sourceId: taxSnapshots.sourceId,
          base: taxSnapshots.taxBaseIdr,
          tax: taxSnapshots.taxIdr,
        })
        .from(taxSnapshots)
        .where(
          and(
            sql`${taxSnapshots.tenantId} = ${args.tenantId}`,
            eq(taxSnapshots.taxType, "pbjt"),
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
    const current = byOutlet.get(row.outletId) ?? { base: 0n, tax: 0n };
    byOutlet.set(row.outletId, {
      base: current.base + w * BigInt(row.base),
      tax: current.tax + w * BigInt(row.tax),
    });
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

  // The base comes from the snapshots, the tax from the ledger: they must agree
  // on the sales of the period, else a sale lacks its snapshot (or was
  // re-quoted after posting) and the base would be wrong without any warning.
  // Fail closed, and say which outlet and by how much.
  const mismatches: string[] = [];
  for (const outletId of outletIds) {
    const ledgerSaleTax =
      (tax.get(outletId) ?? 0n) - (refundTax.get(outletId) ?? 0n);
    const snapshotTax = sales.get(outletId)?.tax ?? 0n;
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

  const lines: TaxReportLine[] = [];
  for (const outletId of outletIds) {
    const sale = sales.get(outletId) ?? { base: 0n, tax: 0n };
    // Refund base: tax grossed up by the effective rate of the period's sales
    // (snapshot base over snapshot tax), else by the latest snapshot rate.
    const refund = refundTax.get(outletId) ?? 0n;
    let refundBase = 0n;
    if (refund !== 0n) {
      if (sale.tax > 0n && sale.base > 0n)
        refundBase = divRound(refund * sale.base, sale.tax);
      else {
        const rateBp = await latestRateBp(tx, args, outletId);
        if (rateBp !== null)
          refundBase = divRound(refund * 10000n, BigInt(rateBp));
      }
    }
    const base = sale.base + refundBase;
    lines.push(
      taxReportLineSchema.parse({
        subjectType: "outlet",
        subjectId: outletId,
        subjectName: nameOf.get(outletId) ?? outletId,
        taxIdMasked: null,
        outletId,
        baseIdr: toIdr(base > 0n ? base : 0n),
        taxIdr: toIdr(tax.get(outletId) ?? 0n),
        references: [],
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
  throw new AccountingError(
    "TAX_REPORT_SOURCE_UNAVAILABLE",
    `Sumber data ${args.type.toUpperCase()} belum tersedia.`,
  );
};
