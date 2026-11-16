// Pure helpers of the tax recap screen (bead legend-5fdy; PRD v1.7 §3 F19
// "Pajak [P0] — Rekap PBJT, PPh 21 (dari payroll), PPh 23 (jasa supplier), dan
// PPN masukan bila badan usaha PKP, dengan ekspor dalam format yang siap
// diunggah ke Coretax DJP").
//
// No React, no DOM and no `@/` alias, so tests/ws07-tax.test.mjs loads this file
// with Node type stripping. Business rules stay in the contract
// (@starter/shared/accounting): the status machine is transitionTaxReport, and
// PPN applicability is assertTaxTypeApplicable. This file only selects, groups,
// formats and serialises what the endpoints already returned.
import {
  assertTaxTypeApplicable,
  nextPeriod,
  periodKeySchema,
  periodOf,
  previousPeriod,
  TAX_REPORT_TYPES,
  type TaxReport,
  type TaxReportLine,
  type TaxReportStatus,
  type TaxReportType,
} from "@starter/shared/accounting";
import type { MessageKey } from "@starter/shared/i18n";

/** Outlet/entity business dates use the outlet time zone (D-CORE-6). */
export const TAX_TIME_ZONE = "Asia/Jakarta";

// ---- Periods ---------------------------------------------------------------

/** "2026-11" for the entity's business month today (never a device-local day). */
export function businessPeriodToday(
  now: Date = new Date(),
  timeZone: string = TAX_TIME_ZONE,
): string {
  // en-CA formats as YYYY-MM-DD.
  const businessDate = new Intl.DateTimeFormat("en-CA", {
    timeZone,
  }).format(now);
  return periodOf(businessDate);
}

export function isTaxPeriodKey(value: string): boolean {
  return periodKeySchema.safeParse(value).success;
}

/**
 * The report period the screen opens on: the latest period that has a report
 * (fixtures: 2026-11), or the current business month when there are none. A
 * caller may pass a business date ("2026-11-03"); it is reduced to its month.
 */
export function defaultTaxPeriod(
  reports: readonly Pick<TaxReport, "period">[],
  today: string = businessPeriodToday(),
): string {
  const current = /^\d{4}-\d{2}-\d{2}$/.test(today) ? today.slice(0, 7) : today;
  return latestTaxPeriod(reports) ?? current;
}

/** Highest period with a report; null when the entity has no reports yet. */
export function latestTaxPeriod(
  reports: readonly Pick<TaxReport, "period">[],
): string | null {
  let latest: string | null = null;
  for (const report of reports)
    if (latest === null || report.period > latest) latest = report.period;
  return latest;
}

/**
 * Moves a period by whole months. Invalid input falls back to the period
 * itself instead of inventing a month; the contract helpers format the result.
 */
export function shiftTaxPeriod(period: string, months: number): string {
  if (!periodKeySchema.safeParse(period).success) return period;
  let next = period;
  const step = months < 0 ? -1 : 1;
  for (let index = 0; index < Math.abs(months); index += 1)
    next = step === 1 ? nextPeriod(next) : previousPeriod(next);
  return next;
}

/** "2026-11" → "November 2026" (locale-stable, id-ID, no time zone drift). */
export function formatTaxPeriod(period: string): string {
  const [year, month] = period.split("-").map(Number);
  return new Intl.DateTimeFormat("id-ID", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

/** An API instant → "4 Nov 2026, 18.00" in the entity time zone. */
export function formatTaxTimestamp(
  instant: string,
  timeZone: string = TAX_TIME_ZONE,
): string {
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(instant));
}

// ---- Catalog keys (text never lives in this file) --------------------------

export const TAX_TYPE_KEYS = {
  pbjt: "accounting.tax.types.pbjt",
  pph21: "accounting.tax.types.pph21",
  pph23: "accounting.tax.types.pph23",
  ppn: "accounting.tax.types.ppn",
} as const satisfies Record<TaxReportType, MessageKey>;

export const TAX_TYPE_HINT_KEYS = {
  pbjt: "accounting.tax.types.hints.pbjt",
  pph21: "accounting.tax.types.hints.pph21",
  pph23: "accounting.tax.types.hints.pph23",
  ppn: "accounting.tax.types.hints.ppn",
} as const satisfies Record<TaxReportType, MessageKey>;

export const TAX_STATUS_KEYS = {
  draft: "accounting.tax.status.draft",
  final: "accounting.tax.status.final",
  exported: "accounting.tax.status.exported",
} as const satisfies Record<TaxReportStatus, MessageKey>;

export const TAX_SUBJECT_KEYS = {
  outlet: "accounting.tax.report.subjectTypes.outlet",
  employee: "accounting.tax.report.subjectTypes.employee",
  supplier: "accounting.tax.report.subjectTypes.supplier",
} as const satisfies Record<TaxReportLine["subjectType"], MessageKey>;

export function taxTypeLabelKey(type: TaxReportType): MessageKey {
  return TAX_TYPE_KEYS[type];
}

/** The one-line explanation under the type selector (PRD §3 F19). */
export function taxTypeHintKey(type: TaxReportType): MessageKey {
  return TAX_TYPE_HINT_KEYS[type];
}

export function taxStatusLabelKey(status: TaxReportStatus): MessageKey {
  return TAX_STATUS_KEYS[status];
}

export function taxSubjectLabelKey(
  subjectType: TaxReportLine["subjectType"],
): MessageKey {
  return TAX_SUBJECT_KEYS[subjectType];
}

/** Every type the selector offers, in contract order. */
export const TAX_TYPES = TAX_REPORT_TYPES;

// ---- Applicability (PPN needs PKP, §3 F19) --------------------------------

/**
 * Same rule as the contract: PPN masukan applies only to a PKP legal entity.
 * The contract asserts; the screen asks, so the PPN card can explain instead of
 * showing an empty table. Any failure counts as not applicable (fail closed).
 */
export function taxTypeApplicable(
  type: TaxReportType,
  isPkp: boolean,
): boolean {
  try {
    assertTaxTypeApplicable(type, { isPkp });
    return true;
  } catch {
    return false;
  }
}

// ---- Selecting the period's reports ---------------------------------------

export function reportsInPeriod(
  reports: readonly TaxReport[],
  period: string,
): TaxReport[] {
  return reports.filter((report) => report.period === period);
}

/** The report of one type in one period; the contract allows at most one. */
export function reportOfType(
  reports: readonly TaxReport[],
  type: TaxReportType,
  period: string,
): TaxReport | undefined {
  return reports.find(
    (report) => report.type === type && report.period === period,
  );
}

export type TaxPeriodSummary = {
  /** Sum of the reports' own `amountIdr` (display aggregation, no rate math). */
  totalTaxIdr: number;
  /** Reports whose numbers are locked: final or exported. */
  finalCount: number;
  /** Reports still waiting to be finalised. */
  draftCount: number;
  reportCount: number;
};

/** Period totals for the StatStrip; every amount comes from `report.amountIdr`. */
export function taxPeriodSummary(
  reports: readonly Pick<TaxReport, "period" | "status" | "amountIdr">[],
  period: string,
): TaxPeriodSummary {
  const rows = reports.filter((report) => report.period === period);
  return rows.reduce<TaxPeriodSummary>(
    (summary, report) => ({
      totalTaxIdr: summary.totalTaxIdr + report.amountIdr,
      finalCount: summary.finalCount + (report.status === "draft" ? 0 : 1),
      draftCount: summary.draftCount + (report.status === "draft" ? 1 : 0),
      reportCount: summary.reportCount + 1,
    }),
    { totalTaxIdr: 0, finalCount: 0, draftCount: 0, reportCount: 0 },
  );
}

// ---- Display-only rate -----------------------------------------------------

/**
 * The line's effective rate in basis points, for the table column only. The
 * contract stores the basis and the tax (rates are tenant tax configuration on
 * the server); this ratio is never submitted, used to compute an amount, or
 * rounded into a money value.
 */
export function taxLineRateBp(
  line: Pick<TaxReportLine, "baseIdr" | "taxIdr">,
): number | null {
  if (line.baseIdr <= 0) return null;
  return Math.round((line.taxIdr / line.baseIdr) * 10_000);
}

/** 1_000 bp → "10%", 250 bp → "2,5%" (id-ID decimal comma, max 2 places). */
export function formatTaxRateBp(basisPoints: number): string {
  return `${new Intl.NumberFormat("id-ID", {
    maximumFractionDigits: 2,
  }).format(basisPoints / 100)}%`;
}

/** "—" when the base is zero (nothing to divide); never a guessed rate. */
export function formatTaxLineRate(
  line: Pick<TaxReportLine, "baseIdr" | "taxIdr">,
): string {
  const basisPoints = taxLineRateBp(line);
  return basisPoints === null ? "—" : formatTaxRateBp(basisPoints);
}

// ---- Coretax CSV export (display serialisation) ---------------------------

export type TaxCsvHeaders = {
  subjectType: string;
  subjectTypes: Record<TaxReportLine["subjectType"], string>;
  subjectName: string;
  taxId: string;
  base: string;
  tax: string;
  references: string;
  total: string;
};

function csvCell(value: string | number): string {
  // Text comes from tenant data (employee/supplier names, document numbers). A
  // leading = + - @ or control character makes Excel/Sheets evaluate the cell as
  // a formula (CSV injection, OWASP), so text is prefixed with an apostrophe.
  // Amounts are numbers and are never prefixed.
  const raw = String(value);
  const text =
    typeof value === "string" && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * The report's lines as RFC 4180 CSV, values exactly as the endpoint returned
 * them. One row per line plus the report's own total; nothing is recomputed.
 * The Coretax upload file itself is XML produced by the API — this CSV is the
 * mock-mode, human-checkable serialisation.
 */
export function toTaxRecapCsv(
  report: Pick<TaxReport, "lines" | "amountIdr">,
  headers: TaxCsvHeaders,
): string {
  const rows: (string | number)[][] = [
    [
      headers.subjectType,
      headers.subjectName,
      headers.taxId,
      headers.base,
      headers.tax,
      headers.references,
    ],
    ...report.lines.map((line) => [
      headers.subjectTypes[line.subjectType],
      line.subjectName,
      line.taxIdMasked ?? "",
      line.baseIdr,
      line.taxIdr,
      line.references.join(" "),
    ]),
    [headers.total, "", "", "", report.amountIdr, ""],
  ];
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** e.g. "rekap-pbjt-2026-10.csv" (the report's period, not the device date). */
export function taxRecapCsvFileName(
  report: Pick<TaxReport, "type" | "period">,
): string {
  return `rekap-${report.type}-${report.period}.csv`;
}

// ---- Errors ----------------------------------------------------------------

const TAX_ERROR_KEYS = {
  INVALID_TRANSITION: "accounting.tax.errors.invalidTransition",
  PERIOD_NOT_CLOSED: "accounting.tax.errors.periodNotClosed",
  TAX_REPORT_NOT_APPLICABLE: "accounting.tax.errors.notApplicable",
  TAX_REPORT_SUPERSEDED: "accounting.tax.errors.superseded",
  TAX_REPORT_STALE: "accounting.tax.errors.stale",
  TAX_REPORT_CORRECTION_REASON_REQUIRED:
    "accounting.tax.errors.correctionReasonRequired",
  TAX_REPORT_SOURCE_UNAVAILABLE: "accounting.tax.errors.sourceUnavailable",
  TAX_REPORT_AMOUNT_MISMATCH: "accounting.tax.errors.amountMismatch",
  TAX_REPORT_NOT_FOUND: "accounting.tax.errors.notFound",
  TAX_REPORT_NO_CHANGE: "accounting.tax.errors.noChange",
} as const;

/** API error code → catalog key; every refusal the screen can hit is mapped. */
export function taxErrorMessageKey(code: string | undefined): MessageKey {
  if (code !== undefined && code in TAX_ERROR_KEYS)
    return TAX_ERROR_KEYS[code as keyof typeof TAX_ERROR_KEYS];
  return "accounting.tax.errors.generic";
}
