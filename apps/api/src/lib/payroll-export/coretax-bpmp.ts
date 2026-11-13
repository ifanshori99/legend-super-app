// Coretax PPh 21 BPMP (bulanan) import XML (bead legend-34qx, WS-10). A pure
// function of its rows: no clock, no randomness, no logging, so the same input
// always renders the same bytes. It never computes tax: gross and TER rate come
// from payslips already finalised by the payroll engine. Layout follows the
// official DJP sample `bpmp.zip` (BPMP template 2024-12): tab indent, fixed
// element order. Errors name a row index only, never a NIK or other PII.

import { HttpError } from "../http-error.ts";

// XML 1.0 forbids most control characters even when escaped; drop them.
// Same escaping as services/accounting-coretax-xml.ts.
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

/** Catapa note (unconfirmed): Coretax caps the position text at 50 characters. */
export const BPMP_POSITION_MAX_LENGTH = 50;

/**
 * PTKP codes the Coretax sample lists (TK/0..K/3). `K/I/n` is not in the
 * sample, so it is refused rather than mapped by guess.
 */
const BPMP_PTKP_STATUSES: ReadonlySet<string> = new Set([
  "TK/0",
  "TK/1",
  "TK/2",
  "TK/3",
  "K/0",
  "K/1",
  "K/2",
  "K/3",
]);

export type BpmpRow = {
  /** 1..12, rendered without a leading zero. */
  taxMonth: number;
  taxYear: number;
  /** Employee NIK, exactly 16 digits (CounterpartTin). */
  nik16: string;
  ptkpStatus: string;
  position: string;
  /** Integer IDR, sum of the month's TER taxable gross. */
  grossIdr: number;
  /** TER rate in basis points (1600 = 16%). */
  terRateBp: number;
  /** YYYY-MM-DD. */
  withholdingDate: string;
};

export type BpmpInput = {
  /** Withholder NPWP, 16 digits. */
  withholderTin16: string;
  /** Withholder place-of-business id (NITKU), 22 digits. */
  nitku22: string;
  rows: readonly BpmpRow[];
};

const invalid = (message: string) =>
  new HttpError(422, "PAYROLL_TAX_EXPORT_INVALID", message);

/**
 * TER rate in percent from basis points: dot decimal, no trailing zeros
 * ("16", "1.75", "0.25", "1.5"). The decimal format is an assumption: the DJP
 * sample only shows integers.
 */
export function formatTerRate(bp: number): string {
  if (!Number.isSafeInteger(bp) || bp < 0 || bp > 10_000)
    throw invalid("Tarif TER tidak valid.");
  const whole = Math.floor(bp / 100);
  const frac = bp % 100;
  if (frac === 0) return String(whole);
  return `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
}

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
  return Array.from(cleaned).slice(0, BPMP_POSITION_MAX_LENGTH).join("").trim();
}

function validateRow(row: BpmpRow, index: number): string {
  const at = `Baris ${index + 1}`;
  if (!Number.isInteger(row.taxMonth) || row.taxMonth < 1 || row.taxMonth > 12)
    throw invalid(`${at}: bulan pajak tidak valid.`);
  if (
    !Number.isInteger(row.taxYear) ||
    row.taxYear < 1000 ||
    row.taxYear > 9999
  )
    throw invalid(`${at}: tahun pajak tidak valid.`);
  if (!/^\d{16}$/.test(row.nik16)) throw invalid(`${at}: NIK harus 16 digit.`);
  if (!BPMP_PTKP_STATUSES.has(row.ptkpStatus))
    throw invalid(`${at}: status PTKP tidak didukung Coretax.`);
  if (!Number.isSafeInteger(row.grossIdr) || row.grossIdr < 0)
    throw invalid(`${at}: penghasilan bruto harus rupiah bulat tidak negatif.`);
  if (!isValidDate(row.withholdingDate))
    throw invalid(`${at}: tanggal pemotongan harus YYYY-MM-DD yang valid.`);
  const position = truncatePosition(row.position);
  if (position === "") throw invalid(`${at}: jabatan wajib diisi.`);
  return position;
}

export function buildBpmpXml(input: BpmpInput): string {
  if (!/^\d{16}$/.test(input.withholderTin16))
    throw invalid("NPWP pemotong harus 16 digit.");
  if (!/^\d{22}$/.test(input.nitku22))
    throw invalid("NITKU pemotong harus 22 digit.");

  const rows = input.rows.map((row, index) => {
    const position = validateRow(row, index);
    const rate = formatTerRate(row.terRateBp);
    return [
      "\t\t<MmPayroll>",
      element("TaxPeriodMonth", row.taxMonth, "\t\t\t"),
      element("TaxPeriodYear", row.taxYear, "\t\t\t"),
      element("CounterpartOpt", "Resident", "\t\t\t"),
      '\t\t\t<CounterpartPassport xsi:nil="true"/>',
      element("CounterpartTin", row.nik16, "\t\t\t"),
      element("StatusTaxExemption", row.ptkpStatus, "\t\t\t"),
      element("Position", position, "\t\t\t"),
      element("TaxCertificate", "N/A", "\t\t\t"),
      element("TaxObjectCode", "21-100-01", "\t\t\t"),
      element("Gross", row.grossIdr, "\t\t\t"),
      element("Rate", rate, "\t\t\t"),
      element("IDPlaceOfBusinessActivity", input.nitku22, "\t\t\t"),
      element("WithholdingDate", row.withholdingDate, "\t\t\t"),
      "\t\t</MmPayroll>",
    ].join("\n");
  });

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<MmPayrollBulk xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    element("TIN", input.withholderTin16, "\t"),
    "\t<ListOfMmPayroll>",
    ...rows,
    "\t</ListOfMmPayroll>",
    "</MmPayrollBulk>",
    "",
  ].join("\n");
}
