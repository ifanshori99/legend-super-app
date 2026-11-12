// PPh 23 and PPN tax report sources (bead legend-v4v7c, Slice D; PRD v1.7 §3.19
// "PPh 23 (jasa supplier) dan PPN masukan bila badan usaha PKP";
// docs/briefs/538-g3-sub.md Slice D decisions 2 and 3).
//
// PPh 23: one line per supplier from the structured supplier invoice records
// (`supplier_invoices`) dated in the period: base = sum DPP, tax = sum PPh 23
// of the invoices that withheld it, NPWP from the invoice snapshot. The sum
// must equal what the `pph23_payable` account was credited by supplier invoice
// journals in the period.
// PPN: masukan lines per supplier (records, `ppn_input` ledger debits) and
// keluaran lines per outlet (`tax_snapshots` type ppn of the period's sales,
// `tax_payable_ppn` ledger credits), each line marked with its direction. The
// report amount is keluaran minus masukan, never below 0 (shared
// `taxReportAmountIdr`); a lebih bayar position is noted in a line reference.
// Nothing is guessed: a missing NPWP, an unmapped role that has something to
// reconcile, or any difference between records and ledger refuses the report
// with TAX_REPORT_SOURCE_UNAVAILABLE. Known limit: an invoice or sale reversed
// in another period than it was posted also fails the reconciliation (closed).

import { and, eq, gt, gte, inArray, lt, notInArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  AccountingError,
  taxReportLineSchema,
  type TaxReportLine,
} from "@starter/shared/accounting";
import { idr, ulidToUuid } from "@starter/shared/core";
import {
  accountMappings,
  fiscalPeriods,
  journalEntries,
  journalLines,
  outlets,
  supplierInvoices,
  suppliers,
  taxSnapshots,
} from "../db/schema";
import type { TenantTransaction } from "./accounting-shared";
import type { TaxLineSourceArgs } from "./accounting-tax-line-source";

const unavailable = (message: string) =>
  new AccountingError("TAX_REPORT_SOURCE_UNAVAILABLE", message);

const rupiah = (value: bigint | number) =>
  String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

async function optionalAccountOf(
  tx: TenantTransaction,
  args: TaxLineSourceArgs,
  role: "ppn_input" | "pph23_payable" | "tax_payable_ppn",
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

const unmapped = (role: string) =>
  unavailable(
    `Akun untuk peran ${role} belum dipetakan, laporan tidak bisa dibuat.`,
  );

async function accountOf(
  tx: TenantTransaction,
  args: TaxLineSourceArgs,
  role: "ppn_input" | "pph23_payable" | "tax_payable_ppn",
): Promise<string> {
  const accountId = await optionalAccountOf(tx, args, role);
  if (!accountId) throw unmapped(role);
  return accountId;
}

/** First day of "YYYY-MM" and of the month after it. */
function periodRange(period: string): { from: string; to: string } {
  const [year, month] = period.split("-").map(Number) as [number, number];
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    from: `${year}-${pad(month)}-01`,
    to: month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`,
  };
}

const reversedEntries = alias(journalEntries, "vw_reversed_entries");
/** Journal source of an entry; a reversal carries the source of its original. */
const effectiveSource = sql<string>`coalesce(${reversedEntries.sourceType}, ${journalEntries.sourceType})`;

/**
 * Credit minus debit of one account over the period's journals of the given
 * sources (a reversal counts as the entry it reverses), per outlet.
 */
async function ledgerNetByOutlet(
  tx: TenantTransaction,
  args: TaxLineSourceArgs,
  accountId: string,
  sources: string[],
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
        inArray(effectiveSource, sources),
      ),
    )
    .groupBy(outletKey);
  return new Map(rows.map((row) => [row.outletId, BigInt(row.net)]));
}

/**
 * Sources other than `allowed` that credit the account in the period (a
 * reversal counts as the entry it reverses). A credit raises what is owed, so
 * one from outside the allowed sources would be missing from the report: the
 * report is refused, naming the source only. Debits (remittances) are ignored.
 */
async function refuseForeignCredits(
  tx: TenantTransaction,
  args: TaxLineSourceArgs,
  accountId: string,
  role: string,
  allowed: string[],
): Promise<void> {
  const rows = await tx
    .select({
      source: effectiveSource,
      credits: sql<string>`sum(${journalLines.creditIdr})::text`,
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
        notInArray(effectiveSource, allowed),
      ),
    )
    .groupBy(effectiveSource);
  const others = rows
    .filter((row) => BigInt(row.credits) > 0n)
    .map((row) => row.source)
    .sort();
  if (others.length > 0)
    throw unavailable(
      `Akun ${role} punya kredit bersumber ${others.join(", ")} di periode ini, di luar penjualan; laporan tidak bisa dibuat otomatis.`,
    );
}

/**
 * Net (credit minus debit) of one account in the period, for supplier invoice
 * journals only (a reversal counts as the entry it reverses). Activity from
 * another source that would change what the records say (any on ppn_input, a
 * credit or a purchase return debit on pph23_payable) refuses the report,
 * naming the source only, no amounts; no netting is guessed. Other debits on
 * pph23_payable (remittances) are ignored, like the PPh 21 source does.
 */
async function supplierInvoiceLedgerNet(
  tx: TenantTransaction,
  args: TaxLineSourceArgs,
  role: "ppn_input" | "pph23_payable",
): Promise<bigint> {
  const accountId = await accountOf(tx, args, role);
  const rows = await tx
    .select({
      source: effectiveSource,
      net: sql<string>`sum(${journalLines.creditIdr} - ${journalLines.debitIdr})::text`,
      credits: sql<string>`sum(${journalLines.creditIdr})::text`,
      debits: sql<string>`sum(${journalLines.debitIdr})::text`,
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
      ),
    )
    .groupBy(effectiveSource);
  // PPh 23 payable: a credit raises what is owed, so another source's credit
  // would be missing from the report; a purchase return debit reverses
  // withholding and is refused too. Its other debits (remittances, setoran) do
  // not matter and are ignored. PPN input: any other activity changes the figure.
  const others = rows
    .filter(
      (row) =>
        row.source !== "supplier_invoice" &&
        (role === "ppn_input" ||
          BigInt(row.credits) > 0n ||
          (row.source === "purchase_return" && BigInt(row.debits) > 0n)),
    )
    .map((row) => row.source)
    .sort();
  if (others.length > 0)
    throw unavailable(
      `Akun ${role} punya jurnal bersumber ${others.join(", ")} di periode ini, di luar faktur supplier; laporan tidak bisa dibuat otomatis.`,
    );
  return rows
    .filter((row) => row.source === "supplier_invoice")
    .reduce((total, row) => total + BigInt(row.net), 0n);
}

const sumOf = (map: Map<unknown, bigint>): bigint =>
  [...map.values()].reduce((total, value) => total + value, 0n);

type SupplierTotals = {
  supplierId: string;
  name: string;
  npwpSnapshot: string | null;
  baseIdr: number;
  taxIdr: number;
  numbers: string[];
};

/**
 * Supplier invoice records of the period that carry tax `kind`, summed per
 * supplier. Base = DPP of those invoices only. A supplier's NPWP is the one
 * snapshotted on its latest such invoice.
 */
async function supplierTotals(
  tx: TenantTransaction,
  args: TaxLineSourceArgs,
  kind: "ppn" | "pph23",
): Promise<{ suppliers: SupplierTotals[]; totalTax: bigint }> {
  const { from, to } = periodRange(args.period);
  const taxColumn =
    kind === "ppn" ? supplierInvoices.ppnIdr : supplierInvoices.pph23Idr;
  const rows = await tx
    .select({
      supplierId: supplierInvoices.supplierId,
      name: suppliers.name,
      number: supplierInvoices.invoiceNumber,
      npwp: supplierInvoices.npwpSnapshot,
      dpp: supplierInvoices.dppIdr,
      tax: taxColumn,
    })
    .from(supplierInvoices)
    .innerJoin(
      suppliers,
      and(
        eq(suppliers.tenantId, supplierInvoices.tenantId),
        eq(suppliers.id, supplierInvoices.supplierId),
      ),
    )
    .where(
      and(
        sql`${supplierInvoices.tenantId} = ${args.tenantId}`,
        eq(supplierInvoices.legalEntityId, args.legalEntityId),
        gte(supplierInvoices.invoiceDate, from),
        lt(supplierInvoices.invoiceDate, to),
        gt(taxColumn, idr(0)),
        // A record whose journal was reversed in this period nets out of the
        // ledger of the period, so it leaves the records too.
        sql`not exists (
          select 1 from ${journalEntries} as vw_reversal
          join ${fiscalPeriods} as vw_period
            on vw_period.tenant_id = vw_reversal.tenant_id
           and vw_period.id = vw_reversal.fiscal_period_id
          where vw_reversal.tenant_id = ${supplierInvoices.tenantId}
            and vw_reversal.reversal_of = ${supplierInvoices.journalEntryId}
            and vw_period.legal_entity_id = ${args.legalEntityId}
            and vw_period.period = ${args.period}
        )`,
      ),
    )
    .orderBy(
      supplierInvoices.invoiceDate,
      supplierInvoices.createdAt,
      supplierInvoices.id,
    );
  const bySupplier = new Map<string, SupplierTotals>();
  let totalTax = 0n;
  for (const row of rows) {
    const current = bySupplier.get(row.supplierId) ?? {
      supplierId: row.supplierId,
      name: row.name,
      npwpSnapshot: null,
      baseIdr: 0,
      taxIdr: 0,
      numbers: [],
    };
    current.baseIdr += row.dpp;
    current.taxIdr += row.tax;
    current.numbers.push(row.number);
    // Ordered oldest first, so the latest invoice's snapshot wins.
    current.npwpSnapshot = row.npwp;
    bySupplier.set(row.supplierId, current);
    totalTax += BigInt(row.tax);
  }
  return {
    suppliers: [...bySupplier.values()].sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        a.supplierId.localeCompare(b.supplierId),
    ),
    totalTax,
  };
}

/** Invoice numbers within the 50 x 60 characters a line may carry. */
function invoiceReferences(numbers: string[]): string[] {
  if (numbers.length <= 50) return numbers;
  return [...numbers.slice(0, 49), `dan ${numbers.length - 49} faktur lain`];
}

function maskedNpwp(npwp: string | null): string | null {
  const digits = (npwp ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? `NPWP ****${digits.slice(-4)}` : null;
}

function supplierLine(
  totals: SupplierTotals,
  direction: "masukan" | undefined,
  taxIdMasked: string | null,
): TaxReportLine {
  return taxReportLineSchema.parse({
    subjectType: "supplier",
    subjectId: totals.supplierId,
    subjectName: totals.name,
    taxIdMasked,
    outletId: null,
    baseIdr: idr(totals.baseIdr),
    taxIdr: idr(totals.taxIdr),
    references: invoiceReferences(totals.numbers),
    ...(direction ? { direction } : {}),
  });
}

export async function pph23Lines(
  tx: TenantTransaction,
  args: TaxLineSourceArgs,
): Promise<TaxReportLine[]> {
  const { suppliers: withheld, totalTax } = await supplierTotals(
    tx,
    args,
    "pph23",
  );
  // The ledger is read even without records: it must then be empty too.
  const ledger = await supplierInvoiceLedgerNet(tx, args, "pph23_payable");
  if (ledger !== totalTax)
    throw unavailable(
      `PPh 23 di buku besar (Rp${rupiah(ledger)}) tidak cocok dengan faktur supplier (Rp${rupiah(totalTax)}), selisih Rp${rupiah(ledger - totalTax)}. Laporan tidak bisa dibuat.`,
    );
  if (withheld.length === 0) return [];
  const noNpwp = withheld.filter(
    (row) => maskedNpwp(row.npwpSnapshot) === null,
  );
  if (noNpwp.length > 0)
    throw unavailable(
      `Supplier tanpa NPWP pada faktur dengan PPh 23: ${noNpwp
        .slice(0, 3)
        .map((row) => row.name)
        .join(", ")}. Lengkapi NPWP supplier, laporan tidak bisa dibuat.`,
    );
  return withheld.map((row) =>
    supplierLine(row, undefined, maskedNpwp(row.npwpSnapshot)),
  );
}

type OutletPpn = { base: bigint; tax: bigint };

/**
 * PPN snapshots of the sales posted in the period, per outlet. The sale
 * journals carry the order id as ULID text (or a UUID); the snapshots store it
 * as a uuid. A reversal (void) of a sale counts negative.
 */
async function saleSnapshotsPpn(
  tx: TenantTransaction,
  args: TaxLineSourceArgs,
): Promise<Map<string, OutletPpn>> {
  const sign = sql<number>`case when ${journalEntries.reversalOf} is null then 1 else -1 end`;
  const sourceId = sql<
    string | null
  >`coalesce(${reversedEntries.sourceId}, ${journalEntries.sourceId})`;
  const entries = await tx
    .select({ sourceId, net: sql<string>`sum(${sign})::text` })
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
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // First character 0-7: a ULID is 128 bits, so a larger one cannot decode.
  const ulid = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;
  const weight = new Map<string, bigint>();
  for (const entry of entries) {
    if (entry.sourceId === null) continue;
    const id = uuid.test(entry.sourceId)
      ? entry.sourceId.toLowerCase()
      : ulid.test(entry.sourceId)
        ? ulidToUuid(entry.sourceId.toUpperCase())
        : null;
    if (id !== null) weight.set(id, (weight.get(id) ?? 0n) + BigInt(entry.net));
  }
  const byOutlet = new Map<string, OutletPpn>();
  const ids = [...weight.keys()];
  for (let from = 0; from < ids.length; from += 5000) {
    const rows = await tx
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
          eq(taxSnapshots.taxType, "ppn"),
          inArray(taxSnapshots.sourceId, ids.slice(from, from + 5000)),
        ),
      );
    for (const row of rows) {
      const w = weight.get(row.sourceId.toLowerCase()) ?? 0n;
      const current = byOutlet.get(row.outletId) ?? { base: 0n, tax: 0n };
      current.base += w * BigInt(row.base);
      current.tax += w * BigInt(row.tax);
      byOutlet.set(row.outletId, current);
    }
  }
  return byOutlet;
}

async function keluaranLines(
  tx: TenantTransaction,
  args: TaxLineSourceArgs,
): Promise<TaxReportLine[]> {
  const sales = await saleSnapshotsPpn(tx, args);
  const account = await optionalAccountOf(tx, args, "tax_payable_ppn");
  if (!account) {
    // Unmapped: the ledger cannot be read, so only an untaxed period is empty.
    if ([...sales.values()].some((row) => row.base !== 0n || row.tax !== 0n))
      throw unmapped("tax_payable_ppn");
    return [];
  }
  await refuseForeignCredits(tx, args, account, "tax_payable_ppn", [
    "sale",
    "refund",
  ]);
  const ledger = await ledgerNetByOutlet(tx, args, account, ["sale"]);
  // A refund of PPN needs its own base; it is not derived here.
  const refunds = await ledgerNetByOutlet(tx, args, account, ["refund"]);
  if (sumOf(refunds) !== 0n)
    throw unavailable(
      "Ada retur dengan PPN di periode ini, PPN keluaran belum bisa dilaporkan otomatis. Laporan tidak bisa dibuat.",
    );
  const mismatches: string[] = [];
  for (const outletId of new Set([...ledger.keys(), ...sales.keys()])) {
    const booked = ledger.get(outletId) ?? 0n;
    const snapshot = sales.get(outletId ?? "")?.tax ?? 0n;
    if (booked !== snapshot)
      mismatches.push(
        `${outletId ?? "tanpa outlet"}: buku besar Rp${rupiah(booked)}, snapshot Rp${rupiah(snapshot)}`,
      );
  }
  if (mismatches.length > 0)
    throw unavailable(
      `PPN keluaran di buku besar tidak cocok dengan snapshot pajak transaksi (${mismatches.join("; ")}). Laporan tidak bisa dibuat.`,
    );
  const outletIds = [...sales.keys()];
  if (outletIds.length === 0) return [];
  const names = await tx
    .select({ id: outlets.id, name: outlets.name })
    .from(outlets)
    .where(
      and(eq(outlets.tenantId, args.tenantId), inArray(outlets.id, outletIds)),
    );
  const nameOf = new Map(names.map((row) => [row.id, row.name]));
  const lines: TaxReportLine[] = [];
  for (const [outletId, row] of sales) {
    if (row.base < 0n || row.tax < 0n)
      throw unavailable(
        "PPN keluaran bernilai negatif di salah satu outlet (void lintas periode). Laporan tidak bisa dibuat.",
      );
    if (row.base === 0n && row.tax === 0n) continue;
    lines.push(
      taxReportLineSchema.parse({
        subjectType: "outlet",
        subjectId: outletId,
        subjectName: nameOf.get(outletId) ?? outletId,
        taxIdMasked: null,
        outletId,
        baseIdr: idr(Number(row.base)),
        taxIdr: idr(Number(row.tax)),
        references: [],
        direction: "keluaran",
      }),
    );
  }
  return lines.sort(
    (a, b) =>
      a.subjectName.localeCompare(b.subjectName) ||
      a.subjectId.localeCompare(b.subjectId),
  );
}

async function masukanLines(
  tx: TenantTransaction,
  args: TaxLineSourceArgs,
): Promise<TaxReportLine[]> {
  const { suppliers: input, totalTax } = await supplierTotals(tx, args, "ppn");
  // ppn_input is an asset: debit minus credit. Read even without records.
  const ledger = -(await supplierInvoiceLedgerNet(tx, args, "ppn_input"));
  if (ledger !== totalTax)
    throw unavailable(
      `PPN masukan di buku besar (Rp${rupiah(ledger)}) tidak cocok dengan faktur supplier (Rp${rupiah(totalTax)}), selisih Rp${rupiah(ledger - totalTax)}. Laporan tidak bisa dibuat.`,
    );
  return input.map((row) =>
    supplierLine(row, "masukan", maskedNpwp(row.npwpSnapshot)),
  );
}

export async function ppnLines(
  tx: TenantTransaction,
  args: TaxLineSourceArgs,
): Promise<TaxReportLine[]> {
  const keluaran = await keluaranLines(tx, args);
  const masukan = await masukanLines(tx, args);
  const lines = [...keluaran, ...masukan];
  const output = keluaran.reduce((total, line) => total + line.taxIdr, 0);
  const input = masukan.reduce((total, line) => total + line.taxIdr, 0);
  const first = lines[0];
  if (input > output && first)
    lines[0] = taxReportLineSchema.parse({
      ...first,
      references: [
        ...first.references.slice(0, 49),
        `PPN lebih bayar Rp ${rupiah(input - output)}`,
      ],
    });
  return lines;
}
