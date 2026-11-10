// Tax report line sources (bead legend-5nhkp, WS-07; PRD v1.7 §3.19 "Pajak").
// A source turns the books of one (entity, type, period) into report lines;
// the report service only sums and stores them, so a source can be swapped in
// tests or when payroll / AP data feeds PPh 21, PPh 23 and PPN.
//
// PBJT comes from the ledger: per outlet, credit minus debit of the account
// mapped to `tax_payable_pbjt` for the entries of that fiscal period (the tax
// collected, net of reversals). The base is the same figure on the account
// mapped to `sales_revenue`. An outlet whose tax nets to zero or less is left
// out. PPh 21 / PPh 23 / PPN have no wired source yet and refuse to generate.

import { and, eq, inArray, sql } from "drizzle-orm";
import {
  AccountingError,
  taxReportLineSchema,
  type TaxReportLine,
  type TaxReportType,
} from "@starter/shared/accounting";
import { idr } from "@starter/shared/core";
import {
  accountMappings,
  fiscalPeriods,
  journalEntries,
  journalLines,
  outlets,
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

/** Credit minus debit of one account in the period, per outlet (null = none). */
async function netCreditByOutlet(
  tx: TenantTransaction,
  args: TaxLineSourceArgs,
  accountId: string,
): Promise<Map<string | null, bigint>> {
  const outletKey = sql<
    string | null
  >`coalesce(${journalLines.outletId}, ${journalEntries.outletId})`;
  const rows = await tx
    .select({
      outletId: outletKey,
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
      ),
    )
    .groupBy(outletKey);
  return new Map(rows.map((row) => [row.outletId, BigInt(row.net)]));
}

const toIdr = (value: bigint) => idr(Number(value));

async function pbjtLines(
  tx: TenantTransaction,
  args: TaxLineSourceArgs,
): Promise<TaxReportLine[]> {
  const taxAccount = await mappedAccountId(tx, args, "tax_payable_pbjt");
  const revenueAccount = await mappedAccountId(tx, args, "sales_revenue");
  const tax = await netCreditByOutlet(tx, args, taxAccount);
  const revenue = await netCreditByOutlet(tx, args, revenueAccount);

  // A line needs an outlet (PBJT is per outlet/region); tax booked without one
  // cannot be reported, so refuse instead of dropping it from the total.
  if ((tax.get(null) ?? 0n) > 0n)
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

  return outletIds
    .map((outletId) => {
      const base = revenue.get(outletId) ?? 0n;
      return taxReportLineSchema.parse({
        subjectType: "outlet",
        subjectId: outletId,
        subjectName: nameOf.get(outletId) ?? outletId,
        taxIdMasked: null,
        outletId,
        baseIdr: toIdr(base > 0n ? base : 0n),
        taxIdr: toIdr(tax.get(outletId) ?? 0n),
        references: [],
      });
    })
    .sort((a, b) =>
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
