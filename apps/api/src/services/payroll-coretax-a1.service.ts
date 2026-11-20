// Coretax PPh 21 BPA1 (A1, tahunan) export rows (bead legend-838hi, WS-10).
// Called by `createPayrollTaxExport` (payroll-export.service.ts) for kind
// `annual_statement`, inside its tenant transaction after `payroll.lock` was
// checked. Read-only: it opens the sealed payslips of the locked/paid runs of
// the legal entity whose pay date falls in the tax year (reversed or unlocked
// runs never match), sums them per employee and hands the rows to the pure
// `buildA1BulkXml`. It never computes or re-derives tax.
//
// Money/tax safety: per employee, the A1 amounts add up to exactly the sum of
// the year's payslip `tax.taxableGrossIdr`. Taxable lines go to their A1 field,
// the employer's JKK/JKM/BPJS Kesehatan shares to InsurancePaidByEmployer, and
// what is left of the slip's taxable gross (the employer-covered tax: gross-up
// allowance and borne tax) to OtherBenefit; a slip whose lines exceed its
// taxable gross is refused (422), never trimmed. An employee appears once. The
// export does not check that the year is closed by an annual-recalculation
// payslip: it reports exactly what the locked payslips of the year carry.
//
// MAPPING ASSUMPTIONS:
// - base_salary -> SalaryPensionJhtTht.
// - bonus, thr -> TantiemBonusThr.
// - every other taxable earning (allowances, incentive, overtime, service
//   charge, custom earning, taxable reimbursement) -> OtherBenefit.
// - Honorarium, Natura and Zakat: the payslip has no such data, always 0.
// - PensionContributionJhtThtFee = the employee's JHT + JP shares.
// - StatusOfWithholding: FullYear when the first payslip is in January and the
//   last in December, else PartialYear; Annualized is never produced (no partial-year tax subject exists, bead legend-0ytbu).
// - PTKP status is the tax year's (status on 1 January or the join date,
//   bead 1223); position comes from the employee's latest payslip.
// - Article21IncomeTax = sum of the sealed `tax.pph21Idr` of those slips,
//   never recomputed; a negative sum (refund) is refused, never clamped.
// - Layout and fixed values (GrossUpOpt No, IncomeTaxBenefit 0): see
//   docs/qa/coretax-bpa1-format.md.

import { and, eq, gte, inArray, lt } from "drizzle-orm";
import type { TenantId } from "@starter/shared/core";
import {
  payslipCalculationSchema,
  type PayslipCalculation,
  type PayslipLine,
} from "@starter/shared/hris/payroll";
import { employees } from "../db/schema/hris.ts";
import { payrollRuns, payslips } from "../db/schema/payroll.ts";
import { HttpError } from "../lib/http-error.ts";
import { normalizeHrisPii, openHrisPii } from "../lib/hris-pii.ts";
import { openPayrollValue } from "../lib/payroll-sealed.ts";
import {
  buildA1BulkXml,
  type A1Row,
} from "../lib/payroll-export/coretax-a1.ts";
import { loadTaxYearPtkpStatuses } from "./payroll-ptkp-tax-year.ts";
import type { Tx } from "./permission-resolver.ts";

/** Statuses a run can be exported in (frozen by the lock, PAYR-02). */
const EXPORTABLE_STATUSES = ["locked", "paid"] as const;
/** "Pegawai tetap" (object code 21-100-01), same rule as the BPMP export. */
const PERMANENT_EMPLOYMENT_TYPES: readonly string[] = ["pkwtt", "pkwt"];

const refuse = (code: string, message: string) =>
  new HttpError(422, code, message);

/** Employee ids only (never a name, NIK or account), capped for the message. */
function idList(ids: readonly string[]): string {
  const sorted = [...new Set(ids)].sort();
  const shown = sorted.slice(0, 20).join(", ");
  return sorted.length > 20 ? `${shown}, ...` : shown;
}

function sealedCalculation(row: {
  id: string;
  tenantId: string;
  calculationEncrypted: Buffer;
  piiKeyVersion: number;
}): PayslipCalculation {
  try {
    return payslipCalculationSchema.parse(
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
    );
  } catch {
    // Never echo the decrypt or parse error: it may carry payroll values.
    throw refuse(
      "PAYROLL_PAYSLIP_UNREADABLE",
      "Slip gaji tidak bisa dibaca atau tidak sesuai format, berkas tidak bisa dibuat.",
    );
  }
}

type A1Slip = { payDate: string; runId: string; calc: PayslipCalculation };

type Amounts = {
  salaryPensionJhtTht: number;
  otherBenefit: number;
  tantiemBonusThr: number;
  insurancePaidByEmployer: number;
  pensionContributionJhtThtFee: number;
  taxableGross: number;
  /** Signed: PPh 21 sealed on the slip (a lebih potong refund is negative). */
  pph21: number;
};

function lineField(
  line: PayslipLine,
): "salaryPensionJhtTht" | "tantiemBonusThr" | "otherBenefit" {
  if (line.category === "base_salary") return "salaryPensionJhtTht";
  if (line.category === "bonus" || line.category === "thr")
    return "tantiemBonusThr";
  return "otherBenefit";
}

/**
 * One slip's A1 amounts, or null when its lines exceed its taxable gross
 * (the slip cannot be split without inventing a figure).
 */
function slipAmounts(calc: PayslipCalculation): Amounts | null {
  const amounts: Amounts = {
    salaryPensionJhtTht: 0,
    otherBenefit: 0,
    tantiemBonusThr: 0,
    insurancePaidByEmployer: 0,
    pensionContributionJhtThtFee: 0,
    taxableGross: calc.tax.taxableGrossIdr,
    pph21: calc.tax.pph21Idr,
  };
  let accounted = 0;
  for (const line of calc.lines) {
    // The gross-up allowance is part of the employer-covered tax below.
    if (
      line.kind !== "earning" ||
      !line.taxable ||
      line.category === "tax_allowance"
    )
      continue;
    amounts[lineField(line)] += line.amountIdr;
    accounted += line.amountIdr;
  }
  for (const bpjs of calc.bpjs) {
    if (
      bpjs.type === "jkk" ||
      bpjs.type === "jkm" ||
      bpjs.type === "bpjs_kes"
    ) {
      amounts.insurancePaidByEmployer += bpjs.employerIdr;
      accounted += bpjs.employerIdr;
    }
    if (bpjs.type === "jht" || bpjs.type === "jp")
      amounts.pensionContributionJhtThtFee += bpjs.employeeIdr;
  }
  const covered = calc.tax.taxableGrossIdr - accounted;
  if (covered < 0) return null;
  amounts.otherBenefit += covered;
  return amounts;
}

const monthOf = (payDate: string) => Number(payDate.slice(5, 7));

export type AnnualA1Result = {
  xml: string;
  rowCount: number;
  excluded: {
    nonPermanentEmployee: number;
    annualRecalculation: number;
    zeroGross: number;
  };
};

export async function buildAnnualA1Xml(
  tx: Tx,
  input: {
    tenantId: TenantId;
    legalEntityId: string;
    taxYear: number;
    withholderTin16: string;
    nitku22: string;
  },
): Promise<AnnualA1Result> {
  const { tenantId, taxYear } = input;
  const slipRows = await tx
    .select({
      id: payslips.id,
      tenantId: payslips.tenantId,
      employeeId: payslips.employeeId,
      calculationEncrypted: payslips.calculationEncrypted,
      piiKeyVersion: payslips.piiKeyVersion,
      runId: payrollRuns.id,
      payDate: payrollRuns.payDate,
      employmentType: employees.employmentType,
      joinDate: employees.joinDate,
      nikEncrypted: employees.nikEncrypted,
      employeePiiKeyVersion: employees.piiKeyVersion,
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
        eq(payslips.tenantId, tenantId),
        eq(payrollRuns.legalEntityId, input.legalEntityId),
        inArray(payrollRuns.status, [...EXPORTABLE_STATUSES]),
        gte(payrollRuns.payDate, `${taxYear}-01-01`),
        lt(payrollRuns.payDate, `${taxYear + 1}-01-01`),
      ),
    );

  const excluded = {
    nonPermanentEmployee: 0,
    // Last-period payslips are what the A1 is made of, never left out.
    annualRecalculation: 0,
    zeroGross: 0,
  };
  const slipsByEmployee = new Map<string, A1Slip[]>();
  const identityByEmployee = new Map<
    string,
    { nikEncrypted: Buffer | null; piiKeyVersion: number }
  >();
  for (const row of slipRows) {
    const calc = sealedCalculation(row);
    if (calc.employeeId !== row.employeeId)
      throw refuse(
        "PAYROLL_PAYSLIP_UNREADABLE",
        "Slip gaji tidak sesuai dengan karyawannya, berkas tidak bisa dibuat.",
      );
    if (!PERMANENT_EMPLOYMENT_TYPES.includes(row.employmentType)) {
      excluded.nonPermanentEmployee += 1;
      continue;
    }
    identityByEmployee.set(row.employeeId, {
      nikEncrypted: row.nikEncrypted,
      piiKeyVersion: row.employeePiiKeyVersion,
    });
    const list = slipsByEmployee.get(row.employeeId) ?? [];
    list.push({ payDate: row.payDate, runId: row.runId, calc });
    slipsByEmployee.set(row.employeeId, list);
  }

  // Bead 1223 (PMK 168/2023): the A1 states the PTKP of the tax year (status on
  // 1 January, or on the join date), the one the year's payslips are computed
  // with. No history: the latest payslip's status.
  const joinDateByEmployee = new Map<string, string>();
  for (const row of slipRows)
    if (slipsByEmployee.has(row.employeeId))
      joinDateByEmployee.set(row.employeeId, row.joinDate);
  const taxYearPtkp = await loadTaxYearPtkpStatuses(
    tx,
    tenantId,
    taxYear,
    [...joinDateByEmployee].map(([id, joinDate]) => ({ id, joinDate })),
  );

  const badAmounts: string[] = [];
  const negativeTax: string[] = [];
  const unsupportedPtkp: string[] = [];
  const badNik: string[] = [];
  const noPosition: string[] = [];
  const rows: A1Row[] = [];

  for (const [employeeId, unsorted] of [...slipsByEmployee].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    // Stable order: pay date, then run id.
    const slips = [...unsorted].sort(
      (a, b) =>
        a.payDate.localeCompare(b.payDate) || a.runId.localeCompare(b.runId),
    );
    const total: Amounts = {
      salaryPensionJhtTht: 0,
      otherBenefit: 0,
      tantiemBonusThr: 0,
      insurancePaidByEmployer: 0,
      pensionContributionJhtThtFee: 0,
      taxableGross: 0,
      pph21: 0,
    };
    let split = true;
    for (const slip of slips) {
      const amounts = slipAmounts(slip.calc);
      if (!amounts) {
        split = false;
        break;
      }
      for (const key of Object.keys(total) as (keyof Amounts)[])
        total[key] += amounts[key];
    }
    if (!split) {
      badAmounts.push(employeeId);
      continue;
    }
    if (total.taxableGross === 0) {
      // Zero gross with sealed tax cannot be skipped: the tax would vanish from A1.
      if (total.pph21 !== 0) {
        negativeTax.push(employeeId);
        continue;
      }
      excluded.zeroGross += slips.length;
      continue;
    }

    // Article21IncomeTax is the sealed sum, never recomputed or raised. A
    // negative sum (refund) cannot be stated as >= 0 without exceeding it.
    if (!Number.isSafeInteger(total.pph21) || total.pph21 < 0) {
      negativeTax.push(employeeId);
      continue;
    }

    // Latest payslip of the year: position, withholding date.
    const first = slips[0]!;
    const last = slips[slips.length - 1]!;
    const startMonth = monthOf(first.payDate);
    const endMonth = monthOf(last.payDate);

    const ptkpStatus = taxYearPtkp.get(employeeId) ?? last.calc.tax.ptkpStatus;
    if (ptkpStatus.startsWith("K/I/")) {
      unsupportedPtkp.push(employeeId);
      continue;
    }

    const identity = identityByEmployee.get(employeeId);
    let nik16: string | null = null;
    if (identity?.nikEncrypted) {
      try {
        nik16 = normalizeHrisPii(
          "nik",
          openHrisPii(
            identity.nikEncrypted,
            { tenantId, table: "employees", rowId: employeeId, field: "nik" },
            identity.piiKeyVersion,
          ),
        );
      } catch {
        nik16 = null;
      }
    }
    if (nik16 === null || !/^\d{16}$/.test(nik16)) {
      badNik.push(employeeId);
      continue;
    }
    const position = last.calc.positionName?.trim() ?? "";
    if (position === "") {
      noPosition.push(employeeId);
      continue;
    }

    rows.push({
      taxYear,
      nik16,
      ptkpStatus,
      position,
      statusOfWithholding:
        startMonth === 1 && endMonth === 12 ? "FullYear" : "PartialYear",
      taxPeriodMonthStart: startMonth,
      taxPeriodMonthEnd: endMonth,
      salaryPensionJhtThtIdr: total.salaryPensionJhtTht,
      otherBenefitIdr: total.otherBenefit,
      honorariumIdr: 0,
      insurancePaidByEmployerIdr: total.insurancePaidByEmployer,
      naturaIdr: 0,
      tantiemBonusThrIdr: total.tantiemBonusThr,
      pensionContributionJhtThtFeeIdr: total.pensionContributionJhtThtFee,
      zakatIdr: 0,
      article21IncomeTaxIdr: total.pph21,
      withholdingDate: last.payDate,
    });
  }

  if (badAmounts.length > 0)
    throw refuse(
      "PAYROLL_TAX_EXPORT_A1_AMOUNT_MISMATCH",
      `Rincian slip gaji melebihi penghasilan bruto kena pajak, A1 tidak bisa dibuat (ID karyawan: ${idList(badAmounts)}).`,
    );
  if (negativeTax.length > 0)
    throw refuse(
      "PAYROLL_TAX_EXPORT_A1_TAX_INVALID",
      `Total PPh 21 tersegel negatif atau tidak valid, A1 tidak bisa dibuat (ID karyawan: ${idList(negativeTax)}).`,
    );
  if (unsupportedPtkp.length > 0)
    throw refuse(
      "PAYROLL_TAX_EXPORT_PTKP_UNSUPPORTED",
      `Status PTKP K/I belum didukung impor Coretax (ID karyawan: ${idList(unsupportedPtkp)}).`,
    );
  if (badNik.length > 0)
    throw refuse(
      "PAYROLL_TAX_EXPORT_NIK_INVALID",
      `NIK karyawan kosong atau tidak valid (ID karyawan: ${idList(badNik)}).`,
    );
  if (noPosition.length > 0)
    throw refuse(
      "PAYROLL_TAX_EXPORT_POSITION_MISSING",
      `Jabatan karyawan belum diisi pada slip gaji (ID karyawan: ${idList(noPosition)}).`,
    );
  if (rows.length === 0)
    throw refuse(
      "PAYROLL_TAX_EXPORT_EMPTY",
      "Tidak ada pegawai tetap dengan penghasilan untuk bukti potong A1 pada tahun pajak ini.",
    );

  return {
    xml: buildA1BulkXml({
      withholderTin16: input.withholderTin16,
      nitku22: input.nitku22,
      rows,
    }),
    rowCount: rows.length,
    excluded,
  };
}
