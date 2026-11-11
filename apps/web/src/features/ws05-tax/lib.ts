// Pure helpers for the tax & service-charge back office (bead legend-efr;
// PRD v1.7 §3.14). Versioning, immutability and the calculation order are
// contract rules in @starter/shared/tax — this file only shapes what the
// screens show: effective-on-date lookup, rate/date/period formatting,
// applies-to summaries and the PBJT CSV export.
//
// No React and no `@/` alias, so tests/ws05-tax.test.mjs loads this file with
// plain Node ESM.

import {
  DEFAULT_BUSINESS_DAY_CUTOFF,
  businessDateOf,
  type BusinessDate,
} from "@starter/shared/core";
import type { MessageKey } from "@starter/shared/i18n";
import type {
  PbjtMonthlyRecap,
  RuleVersionStatus,
  TaxAppliesTo,
  TaxErrorCode,
} from "@starter/shared/tax";

/** Outlet business dates use the outlet time zone (PRD §6); one outlet today. */
export const TAX_TIME_ZONE = "Asia/Jakarta";

/**
 * "2026-11-02" for the outlet's business date (never the device's calendar):
 * core `businessDateOf` with the outlet cutoff (owner Q39, default 04:00).
 */
export function businessDateToday(
  now: Date = new Date(),
  timeZone: string = TAX_TIME_ZONE,
  cutoff: string = DEFAULT_BUSINESS_DAY_CUTOFF,
): BusinessDate {
  return businessDateOf(now, { timeZone, cutoff });
}

/** "2026-11-01" → "1 Nov 2026" for table cells (locale-stable, id-ID). */
export function formatBusinessDate(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

/** An API instant → "1 Des 2026, 08.00" in the outlet zone (SSR-safe). */
export function formatDateTime(instant: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: TAX_TIME_ZONE,
  }).format(new Date(instant));
}

/** Calendar-day arithmetic on a business date (R21 effective dates). */
export function addDays(
  date: BusinessDate | string,
  days: number,
): BusinessDate {
  const [year, month, day] = String(date).split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return next.toISOString().slice(0, 10) as BusinessDate;
}

/** 1000 bp → "10%", 550 → "5,5%" (id-ID decimal comma, max 2 places). */
export function formatBasisPoints(basisPoints: number): string {
  return `${new Intl.NumberFormat("id-ID", {
    maximumFractionDigits: 2,
  }).format(basisPoints / 100)}%`;
}

/**
 * Percent input → basis points, or null when the text is not a rate.
 * Accepts "10", "10,5" and "10.5" (max two decimals, 0–100%).
 */
export function parseRatePercent(input: string): number | null {
  const text = input.trim().replace(",", ".");
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) return null;
  const percent = Number(text);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  return Math.round(percent * 100);
}

/** A version row a screen can sort and resolve; both rule contracts match. */
export type RuleVersion = {
  id: string;
  code: string;
  name: string;
  version: number;
  status: RuleVersionStatus;
  effectiveFrom: BusinessDate;
  outletId: string | null;
  isActive: boolean;
};

/** Code ascending, newest version first when a code repeats. */
export function sortRuleVersions<T extends RuleVersion>(
  versions: readonly T[],
): T[] {
  return [...versions].sort(
    (a, b) => a.code.localeCompare(b.code) || b.version - a.version,
  );
}

/** Tenant-wide and outlet versions of the same code are separate chains. */
function versionKey(version: {
  code: string;
  outletId: string | null;
}): string {
  return `${version.outletId ?? "tenant"}:${version.code}`;
}

/**
 * The version in force on `today` for its code: published, effective on or
 * before the date, and the highest effective version of every such row
 * (PRD R20/R21, contract `effectiveVersion` rules).
 */
export function isEffectiveVersion<T extends RuleVersion>(
  version: T,
  versions: readonly T[],
  today: string,
): boolean {
  if (version.status !== "published" || version.effectiveFrom > today)
    return false;
  const key = versionKey(version);
  let best: T | undefined;
  for (const candidate of versions) {
    if (versionKey(candidate) !== key) continue;
    if (candidate.status !== "published" || candidate.effectiveFrom > today)
      continue;
    if (
      !best ||
      candidate.effectiveFrom > best.effectiveFrom ||
      (candidate.effectiveFrom === best.effectiveFrom &&
        candidate.version > best.version)
    )
      best = candidate;
  }
  return best?.id === version.id;
}

/** New versions continue the code's chain: max version + 1 (starts at 1). */
export function nextVersionNumber(
  versions: readonly {
    code: string;
    outletId: string | null;
    version: number;
  }[],
  code: string,
  outletId: string | null,
): number {
  const sameChain = versions.filter(
    (row) => row.code === code && row.outletId === outletId,
  );
  return sameChain.reduce((max, row) => Math.max(max, row.version), 0) + 1;
}

/**
 * Default effective date for a change (PRD R21: never before today, and a
 * change must start after the latest published version).
 */
export function suggestEffectiveFrom(
  versions: readonly Pick<RuleVersion, "status" | "effectiveFrom">[],
  today: string,
): BusinessDate {
  let latest: string | undefined;
  for (const row of versions) {
    if (row.status !== "published") continue;
    if (latest === undefined || row.effectiveFrom > latest)
      latest = row.effectiveFrom;
  }
  if (latest !== undefined && latest >= today) return addDays(latest, 1);
  return today;
}

export type RuleFilter = {
  search: string;
  status: RuleVersionStatus | "all";
};

/** Client-side search over code and name, plus the version-status filter. */
export function filterRuleVersions<T extends RuleVersion>(
  versions: readonly T[],
  filter: RuleFilter,
): T[] {
  const needle = filter.search.trim().toLocaleLowerCase("id-ID");
  return versions.filter((version) => {
    if (filter.status !== "all" && version.status !== filter.status) {
      return false;
    }
    if (needle === "") return true;
    return `${version.code} ${version.name}`
      .toLocaleLowerCase("id-ID")
      .includes(needle);
  });
}

export type AppliesToCounts = {
  itemClasses: TaxAppliesTo["itemClasses"];
  categoryCount: number;
  itemCount: number;
};

export function appliesToCounts(appliesTo: TaxAppliesTo): AppliesToCounts {
  return {
    itemClasses: appliesTo.itemClasses,
    categoryCount: appliesTo.categoryIds.length,
    itemCount: appliesTo.itemIds.length,
  };
}

/** Tax error code → catalog key; every code has a fix hint in the catalog. */
export const TAX_ERROR_MESSAGE_KEYS: Record<TaxErrorCode, MessageKey> = {
  TAX_RULE_NOT_FOUND: "tax.errors.ruleNotFound",
  TAX_RULE_AMBIGUOUS: "tax.errors.ruleAmbiguous",
  TAX_RULE_IMMUTABLE: "tax.errors.ruleImmutable",
  TAX_RULE_BACKDATED: "tax.errors.ruleBackdated",
  TAX_SETTINGS_NOT_FOUND: "tax.errors.settingsNotFound",
  TAX_PACKAGE_ALLOCATION_INVALID: "tax.errors.packageAllocation",
  TAX_INVALID_TRANSITION: "tax.errors.invalidTransition",
};

export function taxErrorMessageKey(code: string): MessageKey | null {
  return code in TAX_ERROR_MESSAGE_KEYS
    ? TAX_ERROR_MESSAGE_KEYS[code as TaxErrorCode]
    : null;
}

/** "YYYY-MM" for the report period (contract `taxPeriodSchema`). */
export function isTaxPeriod(value: string | undefined): value is string {
  return value !== undefined && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** The outlet's current business month, the report's default period. */
export function currentTaxPeriod(today: string = businessDateToday()): string {
  return today.slice(0, 7);
}

/** "2026-11" → "November 2026" for report headings (locale-stable). */
export function formatTaxPeriod(period: string): string {
  const [year, month] = period.split("-").map(Number);
  return new Intl.DateTimeFormat("id-ID", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

/** The settings version in force on `today` (settings have no code). */
export function effectiveSettings<
  T extends {
    status: RuleVersionStatus;
    effectiveFrom: string;
    version: number;
  },
>(rows: readonly T[], today: string): T | undefined {
  let best: T | undefined;
  for (const row of rows) {
    if (row.status !== "published" || row.effectiveFrom > today) continue;
    if (
      !best ||
      row.effectiveFrom > best.effectiveFrom ||
      (row.effectiveFrom === best.effectiveFrom && row.version > best.version)
    )
      best = row;
  }
  return best;
}

export type PbjtTotals = {
  transactionCount: number;
  grossSalesIdr: number;
  serviceChargeIdr: number;
};

/**
 * Column sums the recap totals do not already carry (gross sales, service).
 * The transaction total is the recap's distinct-sale count, never a sum of
 * rows (a sale taxed under two rule codes sits in two rows).
 */
export function pbjtRowTotals(recap: PbjtMonthlyRecap): PbjtTotals {
  return recap.rows.reduce(
    (totals, row) => ({
      transactionCount: totals.transactionCount,
      grossSalesIdr: totals.grossSalesIdr + row.grossSalesIdr,
      serviceChargeIdr: totals.serviceChargeIdr + row.serviceChargeIdr,
    }),
    {
      transactionCount: recap.totalTransactionCount,
      grossSalesIdr: 0,
      serviceChargeIdr: 0,
    },
  );
}

export type PbjtCsvHeaders = {
  code: string;
  rate: string;
  transactions: string;
  gross: string;
  base: string;
  service: string;
  tax: string;
  total: string;
};

function csvCell(value: string | number): string {
  // Text cells come from tenant input (rule codes). A leading = + - @ or
  // control character makes Excel/Sheets evaluate the cell as a formula
  // (CSV injection, OWASP), so text is prefixed with an apostrophe. Numbers
  // are written as numbers and never prefixed.
  const raw = String(value);
  const text =
    typeof value === "string" && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * The PBJT recap as RFC 4180 CSV: one row per rule code plus a totals row.
 * Amounts stay whole-rupiah integers with no separators so a spreadsheet
 * imports them as numbers (the regional report wants figures, not labels).
 */
export function toPbjtCsv(
  recap: PbjtMonthlyRecap,
  headers: PbjtCsvHeaders,
): string {
  const sums = pbjtRowTotals(recap);
  const lines = [
    [
      headers.code,
      headers.rate,
      headers.transactions,
      headers.gross,
      headers.base,
      headers.service,
      headers.tax,
    ],
    ...recap.rows.map((row) => [
      row.taxRuleCode,
      row.rateBp,
      row.transactionCount,
      row.grossSalesIdr,
      row.taxBaseIdr,
      row.serviceChargeIdr,
      row.taxIdr,
    ]),
    [
      headers.total,
      "",
      sums.transactionCount,
      sums.grossSalesIdr,
      recap.totalTaxBaseIdr,
      sums.serviceChargeIdr,
      recap.totalTaxIdr,
    ],
  ];
  return `${lines.map((line) => line.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function pbjtCsvFileName(period: string, outletId: string): string {
  return `pbjt-${period}-${outletId.slice(0, 8)}.csv`;
}

/**
 * Triggers a browser download of a text file (UTF-8 BOM so Excel reads the
 * Indonesian characters). Returns false where no DOM exists (SSR, tests).
 */
export function downloadTextFile(
  fileName: string,
  content: string,
  mime = "text/csv;charset=utf-8",
): boolean {
  if (typeof document === "undefined") return false;
  const blob = new Blob([`\ufeff${content}`], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}
