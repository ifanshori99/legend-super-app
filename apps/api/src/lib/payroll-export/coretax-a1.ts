// Coretax PPh 21 BPA1 (A1, tahunan) bulk import XML (bead legend-838hi, WS-10).
// A pure function of its rows: no clock, no randomness, no logging, so the same
// input always renders the same bytes. It never computes tax: every amount
// comes from payslips already sealed by the payroll engine and summed by
// services/payroll-coretax-a1.service.ts. Errors name a row index only, never a
// NIK or other PII.
//
// Layout: the official DJP BPA1 XSD, 27 elements in mandatory xsd:sequence
// order. See docs/qa/coretax-bpa1-format.md for the source and the diff against
// the earlier guessed layout. `Article21IncomeTax` is the PPh 21 already
// withheld, taken from sealed payslips by the service, never computed here.

import { HttpError } from "../http-error.ts";

// Same escaping as coretax-bpmp.ts and services/accounting-coretax-xml.ts.
// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

function escapeXml(value: string): string {
  return value
    .replace(INVALID_XML_CHARS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const element = (name: string, value: string | number, indent: string) =>
  `${indent}<${name}>${escapeXml(String(value))}</${name}>`;

/** Same cap as the BPMP position text (unconfirmed Catapa note). */
export const A1_POSITION_MAX_LENGTH = 50;

/** Same PTKP list as the BPMP sample; `K/I/n` is refused, never mapped by guess. */
const A1_PTKP_STATUSES: ReadonlySet<string> = new Set([
  "TK/0",
  "TK/1",
  "TK/2",
  "TK/3",
  "K/0",
  "K/1",
  "K/2",
  "K/3",
]);

/**
 * FullYear = January to December in one period of service; PartialYear = one
 * shorter period of service. Annualized (Coretax "disetahunkan", foreign
 * employees under 183 days) is never produced: the engine has no such subject
 * (`partialYearTaxSubject` is always false, bead legend-0ytbu).
 */
export type A1WithholdingStatus = "FullYear" | "PartialYear" | "Annualized";

export type A1Row = {
  taxYear: number;
  /** Employee NIK, exactly 16 digits (CounterpartTin). */
  nik16: string;
  ptkpStatus: string;
  position: string;
  statusOfWithholding: A1WithholdingStatus;
  /** 1-12; FullYear requires 1 to 12, start <= end. */
  taxPeriodMonthStart: number;
  taxPeriodMonthEnd: number;
  /** Integer IDR, whole-year amounts (all non-negative). */
  salaryPensionJhtThtIdr: number;
  otherBenefitIdr: number;
  honorariumIdr: number;
  insurancePaidByEmployerIdr: number;
  naturaIdr: number;
  tantiemBonusThrIdr: number;
  /** Employee JHT + JP (iuran pensiun/JHT/THT), a deduction from gross. */
  pensionContributionJhtThtFeeIdr: number;
  zakatIdr: number;
  /** PPh 21 already withheld (sum of sealed payslip PPh 21), integer IDR >= 0. */
  article21IncomeTaxIdr: number;
  /** YYYY-MM-DD, not earlier than the end of the tax period. */
  withholdingDate: string;
};

export type A1Input = {
  /** Withholder NPWP, 16 digits. */
  withholderTin16: string;
  /** Withholder place-of-business id (NITKU), 22 digits. */
  nitku22: string;
  rows: readonly A1Row[];
};

const invalid = (message: string) =>
  new HttpError(422, "PAYROLL_TAX_EXPORT_INVALID", message);

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value)
  );
}

/** Cut to `max` Unicode code points (never splits a surrogate pair). */
function truncatePosition(value: string): string {
  const cleaned = value
    .replace(INVALID_XML_CHARS, "")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(cleaned).slice(0, A1_POSITION_MAX_LENGTH).join("").trim();
}

const AMOUNT_FIELDS = [
  ["salaryPensionJhtThtIdr", "SalaryPensionJhtTht"],
  ["otherBenefitIdr", "OtherBenefit"],
  ["honorariumIdr", "Honorarium"],
  ["insurancePaidByEmployerIdr", "InsurancePaidByEmployer"],
  ["naturaIdr", "Natura"],
  ["tantiemBonusThrIdr", "TantiemBonusThr"],
  ["pensionContributionJhtThtFeeIdr", "PensionContributionJhtThtFee"],
  ["zakatIdr", "Zakat"],
] as const satisfies readonly (readonly [keyof A1Row, string])[];

const NON_NEGATIVE_FIELDS = [
  ...AMOUNT_FIELDS.map(([key]) => key),
  "article21IncomeTaxIdr",
] as const satisfies readonly (keyof A1Row)[];

const isMonth = (value: number) =>
  Number.isInteger(value) && value >= 1 && value <= 12;

function validateRow(row: A1Row, index: number): string {
  const at = `Baris ${index + 1}`;
  if (
    !Number.isInteger(row.taxYear) ||
    row.taxYear < 1000 ||
    row.taxYear > 9999
  )
    throw invalid(`${at}: tahun pajak tidak valid.`);
  if (!/^\d{16}$/.test(row.nik16)) throw invalid(`${at}: NIK harus 16 digit.`);
  if (!A1_PTKP_STATUSES.has(row.ptkpStatus))
    throw invalid(`${at}: status PTKP tidak didukung Coretax.`);
  if (
    row.statusOfWithholding !== "FullYear" &&
    row.statusOfWithholding !== "PartialYear" &&
    row.statusOfWithholding !== "Annualized"
  )
    throw invalid(`${at}: status pemotongan tidak valid.`);
  if (!isMonth(row.taxPeriodMonthStart) || !isMonth(row.taxPeriodMonthEnd))
    throw invalid(`${at}: bulan masa pajak harus 1 sampai 12.`);
  if (row.taxPeriodMonthStart > row.taxPeriodMonthEnd)
    throw invalid(`${at}: bulan awal masa pajak melebihi bulan akhir.`);
  if (
    row.statusOfWithholding === "FullYear" &&
    (row.taxPeriodMonthStart !== 1 || row.taxPeriodMonthEnd !== 12)
  )
    throw invalid(`${at}: status FullYear harus masa pajak Januari-Desember.`);
  for (const key of NON_NEGATIVE_FIELDS)
    if (!Number.isSafeInteger(row[key]) || (row[key] as number) < 0)
      throw invalid(`${at}: jumlah harus rupiah bulat tidak negatif.`);
  if (!isValidDate(row.withholdingDate))
    throw invalid(`${at}: tanggal pemotongan harus YYYY-MM-DD yang valid.`);
  if (
    row.withholdingDate <
    `${row.taxYear}-${String(row.taxPeriodMonthEnd).padStart(2, "0")}-01`
  )
    throw invalid(`${at}: tanggal pemotongan lebih awal dari masa pajak.`);
  const position = truncatePosition(row.position);
  if (position === "") throw invalid(`${at}: jabatan wajib diisi.`);
  return position;
}

export function buildA1BulkXml(input: A1Input): string {
  if (!/^\d{16}$/.test(input.withholderTin16))
    throw invalid("NPWP pemotong harus 16 digit.");
  if (!/^\d{22}$/.test(input.nitku22))
    throw invalid("NITKU pemotong harus 22 digit.");

  const seenNik = new Set<string>();
  const rows = input.rows.map((row, index) => {
    const position = validateRow(row, index);
    // One A1 per employee: a repeated NIK is refused, never merged.
    if (seenNik.has(row.nik16))
      throw invalid(`Baris ${index + 1}: NIK ganda dalam satu berkas.`);
    seenNik.add(row.nik16);
    const i = "\t\t\t";
    return [
      "\t\t<A1>",
      element("WorkForSecondEmployer", "No", i),
      element("TaxPeriodMonthStart", row.taxPeriodMonthStart, i),
      element("TaxPeriodMonthEnd", row.taxPeriodMonthEnd, i),
      element("TaxPeriodYear", row.taxYear, i),
      element("CounterpartOpt", "Resident", i),
      `${i}<CounterpartPassport xsi:nil="true"/>`,
      element("CounterpartTin", row.nik16, i),
      element("TaxExemptOpt", row.ptkpStatus, i),
      element("StatusOfWithholding", row.statusOfWithholding, i),
      element("CounterpartPosition", position, i),
      element("TaxObjectCode", "21-100-01", i),
      element(
        "NumberOfMonths",
        row.statusOfWithholding === "Annualized"
          ? row.taxPeriodMonthEnd - row.taxPeriodMonthStart + 1
          : 0,
        i,
      ),
      element("SalaryPensionJhtTht", row.salaryPensionJhtThtIdr, i),
      element("GrossUpOpt", "No", i),
      element("IncomeTaxBenefit", 0, i),
      element("OtherBenefit", row.otherBenefitIdr, i),
      element("Honorarium", row.honorariumIdr, i),
      element("InsurancePaidByEmployer", row.insurancePaidByEmployerIdr, i),
      element("Natura", row.naturaIdr, i),
      element("TantiemBonusThr", row.tantiemBonusThrIdr, i),
      element(
        "PensionContributionJhtThtFee",
        row.pensionContributionJhtThtFeeIdr,
        i,
      ),
      element("Zakat", row.zakatIdr, i),
      `${i}<PrevWhTaxSlip xsi:nil="true"/>`,
      element("TaxCertificate", "N/A", i),
      element("Article21IncomeTax", row.article21IncomeTaxIdr, i),
      element("IDPlaceOfBusinessActivity", input.nitku22, i),
      element("WithholdingDate", row.withholdingDate, i),
      "\t\t</A1>",
    ].join("\n");
  });

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<A1Bulk xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    element("TIN", input.withholderTin16, "\t"),
    "\t<ListOfA1>",
    ...rows,
    "\t</ListOfA1>",
    "</A1Bulk>",
    "",
  ].join("\n");
}
