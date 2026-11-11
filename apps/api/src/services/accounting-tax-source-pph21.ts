// PPh 21 tax report source (bead legend-v4v7c, slice D of 538-G3; PRD v1.7 §3.19
// "Pajak", Coretax e-Bupot per employee).
//
// One line per employee from the sealed payslips of POSTED payroll runs (status
// locked or paid) whose period end falls in the report month: tax is the
// payslip's tax.pph21Idr, base its tax.taxableGrossIdr, both summed over the
// employee's runs. The payslip total must equal the ledger credit on the account
// mapped to `pph21_payable`, counting only journals whose effective source is
// 'payroll' (a reversal counts as the entry it reverses; remittance debits of
// other sources are ignored). A credit from another source (opening balance,
// manual), any difference, a missing posting, an unreadable NPWP or an unmapped
// role refuses the report (TAX_REPORT_SOURCE_UNAVAILABLE): no amount is guessed.
// The NPWP is shown masked only; an employee without NPWP has taxIdMasked null.

import { and, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  AccountingError,
  taxReportLineSchema,
  type TaxReportLine,
} from "@starter/shared/accounting";
import { idr } from "@starter/shared/core";
import { payslipCalculationSchema } from "@starter/shared/hris/payroll/payslips";
import {
  accountMappings,
  employees,
  fiscalPeriods,
  journalEntries,
  journalLines,
  payrollRuns,
  payslips,
} from "../db/schema";
import { maskHrisPii, openHrisPii } from "../lib/hris-pii";
import { openPayrollValue } from "../lib/payroll-sealed";
import type { TenantTransaction } from "./accounting-shared";
import type { TaxLineSourceArgs } from "./accounting-tax-line-source";

const unavailable = (message: string) =>
  new AccountingError("TAX_REPORT_SOURCE_UNAVAILABLE", message);

const reversedEntries = alias(journalEntries, "pph21_reversed_entries");
const effectiveSource = sql<string>`coalesce(${reversedEntries.sourceType}, ${journalEntries.sourceType})`;

/** First day of the month after "YYYY-MM". */
function periodEndExclusive(period: string): string {
  const [year, month] = period.split("-").map(Number) as [number, number];
  return month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, "0")}-01`;
}

/** Net credit (credit minus debit) of payroll journals on the PPh 21 payable account. */
async function ledgerPph21(
  tx: TenantTransaction,
  args: TaxLineSourceArgs,
): Promise<bigint> {
  const [mapping] = await tx
    .select({ accountId: accountMappings.accountId })
    .from(accountMappings)
    .where(
      and(
        eq(accountMappings.tenantId, args.tenantId),
        eq(accountMappings.legalEntityId, args.legalEntityId),
        eq(accountMappings.role, "pph21_payable"),
      ),
    )
    .limit(1);
  if (!mapping)
    throw unavailable(
      "Akun untuk peran pph21_payable belum dipetakan, laporan tidak bisa dibuat.",
    );
  const rows = await tx
    .select({
      source: effectiveSource,
      net: sql<string>`sum(${journalLines.creditIdr} - ${journalLines.debitIdr})::text`,
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
        eq(journalLines.accountId, mapping.accountId),
        eq(journalEntries.legalEntityId, args.legalEntityId),
        eq(fiscalPeriods.legalEntityId, args.legalEntityId),
        eq(fiscalPeriods.period, args.period),
      ),
    )
    .groupBy(effectiveSource);
  // A credit raises what is owed: one from outside payroll (opening balance,
  // manual) would be missing from the report, so it is refused, naming the
  // source only. Debits of other sources (remittances) are ignored.
  const others = rows
    .filter((row) => row.source !== "payroll" && BigInt(row.credits) > 0n)
    .map((row) => row.source)
    .sort();
  if (others.length > 0)
    throw unavailable(
      `Akun pph21_payable punya kredit bersumber ${others.join(", ")} di periode ini, di luar penggajian; laporan tidak bisa dibuat otomatis.`,
    );
  return rows
    .filter((row) => row.source === "payroll")
    .reduce((total, row) => total + BigInt(row.net), 0n);
}

type EmployeeTotal = {
  name: string;
  outletId: string;
  npwpEncrypted: Buffer | null;
  piiKeyVersion: number;
  base: number;
  tax: number;
};

export async function pph21Lines(
  tx: TenantTransaction,
  args: TaxLineSourceArgs,
): Promise<TaxReportLine[]> {
  const rows = await tx
    .select({
      id: payslips.id,
      tenantId: payslips.tenantId,
      employeeId: payslips.employeeId,
      calculationEncrypted: payslips.calculationEncrypted,
      piiKeyVersion: payslips.piiKeyVersion,
      fullName: employees.fullName,
      homeOutletId: employees.homeOutletId,
      npwpEncrypted: employees.npwpEncrypted,
      employeeKeyVersion: employees.piiKeyVersion,
    })
    .from(payslips)
    .innerJoin(
      payrollRuns,
      and(
        eq(payrollRuns.tenantId, payslips.tenantId),
        eq(payrollRuns.id, payslips.payrollRunId),
      ),
    )
    .innerJoin(
      employees,
      and(
        eq(employees.tenantId, payslips.tenantId),
        eq(employees.id, payslips.employeeId),
      ),
    )
    .where(
      and(
        sql`${payslips.tenantId} = ${args.tenantId}`,
        eq(payrollRuns.legalEntityId, args.legalEntityId),
        inArray(payrollRuns.status, ["locked", "paid"]),
        sql`${payrollRuns.periodEnd} >= ${`${args.period}-01`}`,
        sql`${payrollRuns.periodEnd} < ${periodEndExclusive(args.period)}`,
      ),
    );

  const totals = new Map<string, EmployeeTotal>();
  let payslipTax = 0n;
  let unreadable = 0;
  for (const row of rows) {
    let tax;
    try {
      ({ tax } = payslipCalculationSchema.parse(
        JSON.parse(
          openPayrollValue(
            row.calculationEncrypted,
            {
              tenantId: row.tenantId,
              table: "payslips",
              rowId: row.id,
              field: "calculation",
            },
            row.piiKeyVersion,
          ),
        ),
      ));
    } catch {
      // Count only: the raw decrypt / parse error may echo payroll values.
      unreadable += 1;
      continue;
    }
    const current = totals.get(row.employeeId) ?? {
      name: row.fullName,
      outletId: row.homeOutletId,
      npwpEncrypted: row.npwpEncrypted,
      piiKeyVersion: row.employeeKeyVersion,
      base: 0,
      tax: 0,
    };
    current.base += tax.taxableGrossIdr;
    current.tax += tax.pph21Idr;
    payslipTax += BigInt(tax.pph21Idr);
    totals.set(row.employeeId, current);
  }

  if (unreadable > 0)
    throw unavailable(
      `${unreadable} slip gaji tidak bisa dibaca atau tidak sesuai format, laporan tidak bisa dibuat.`,
    );

  const ledger = await ledgerPph21(tx, args);
  if (ledger !== payslipTax)
    throw unavailable(
      `PPh 21 slip gaji Rp${payslipTax} tidak cocok dengan buku besar Rp${ledger} (selisih Rp${ledger - payslipTax}). Laporan tidak bisa dibuat.`,
    );

  const lines: TaxReportLine[] = [];
  for (const [employeeId, total] of totals) {
    let npwpMasked: string | null = null;
    if (total.npwpEncrypted) {
      try {
        const npwp = openHrisPii(
          total.npwpEncrypted,
          {
            tenantId: args.tenantId,
            table: "employees",
            rowId: employeeId,
            field: "npwp",
          },
          total.piiKeyVersion,
        );
        npwpMasked = maskHrisPii("npwp", npwp, total.piiKeyVersion).masked;
      } catch {
        // No raw error text: it may echo the sealed or the plain NPWP.
        throw unavailable(
          "NPWP karyawan tidak bisa dibaca, laporan tidak bisa dibuat.",
        );
      }
    }
    lines.push(
      taxReportLineSchema.parse({
        subjectType: "employee",
        subjectId: employeeId,
        subjectName: total.name,
        taxIdMasked: npwpMasked,
        outletId: total.outletId,
        baseIdr: idr(total.base),
        taxIdr: idr(total.tax),
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
