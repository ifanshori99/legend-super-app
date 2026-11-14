// Pure helpers of the finance exceptions screen: default and validated date
// window (business dates, Asia/Jakarta), kind and reference labels, summary
// shaping, and the Jakarta time label. No React: loadable in Node tests.
import type { MessageKey } from "@starter/shared/i18n";
import type { FinanceExceptionSummaryDto } from "@starter/shared/types";
import {
  FINANCE_EXCEPTION_KINDS,
  FINANCE_EXCEPTIONS_MAX_DAYS,
  type FinanceExceptionKind,
} from "@starter/shared/validators/finance-exceptions";

export { FINANCE_EXCEPTION_KINDS, FINANCE_EXCEPTIONS_MAX_DAYS };
export type { FinanceExceptionKind };

export const DEFAULT_WINDOW_DAYS = 14;
const TIME_ZONE = "Asia/Jakarta";
const DAY_MS = 86_400_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type FinanceExceptionFilters = {
  kind?: FinanceExceptionKind;
  outletId?: string;
  from: string;
  to: string;
};

/** The filters as they sit in the URL: every part optional. */
export type FinanceExceptionSearch = {
  kind?: FinanceExceptionKind | undefined;
  outletId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
};

export const KIND_LABEL_KEYS: Record<FinanceExceptionKind, MessageKey> = {
  edge_tax_unsnapshotted: "financeExceptions.kinds.edge_tax_unsnapshotted",
  edge_void_unsupported: "financeExceptions.kinds.edge_void_unsupported",
  edge_receipt_skipped: "financeExceptions.kinds.edge_receipt_skipped",
  edge_link_dead_letter: "financeExceptions.kinds.edge_link_dead_letter",
  payout_fee_not_posted: "financeExceptions.kinds.payout_fee_not_posted",
};

export const KIND_HELP_KEYS: Record<FinanceExceptionKind, MessageKey> = {
  edge_tax_unsnapshotted: "financeExceptions.kindHelp.edge_tax_unsnapshotted",
  edge_void_unsupported: "financeExceptions.kindHelp.edge_void_unsupported",
  edge_receipt_skipped: "financeExceptions.kindHelp.edge_receipt_skipped",
  edge_link_dead_letter: "financeExceptions.kindHelp.edge_link_dead_letter",
  payout_fee_not_posted: "financeExceptions.kindHelp.payout_fee_not_posted",
};

const REF_TYPE_KEYS: Record<string, MessageKey> = {
  order: "financeExceptions.refTypes.order",
  auto_journal: "financeExceptions.refTypes.auto_journal",
  receipt_skip: "financeExceptions.refTypes.receipt_skip",
  link_event: "financeExceptions.refTypes.link_event",
  payout_posting: "financeExceptions.refTypes.payout_posting",
};

const DETAIL_KEYS: Record<string, MessageKey> = {
  tax_missing: "financeExceptions.details.tax_missing",
  tax_mismatch: "financeExceptions.details.tax_mismatch",
};

export function isFinanceExceptionKind(
  value: unknown,
): value is FinanceExceptionKind {
  return (FINANCE_EXCEPTION_KINDS as readonly unknown[]).includes(value);
}

export function refTypeKey(refType: string): MessageKey {
  return REF_TYPE_KEYS[refType] ?? "financeExceptions.refTypeUnknown";
}

/** Known flag codes get a sentence; anything else (a batch id) stays as is. */
export function detailKey(detail: string): MessageKey | undefined {
  return DETAIL_KEYS[detail];
}

/**
 * A long id reads badly in a row: show "…" and its last 6 characters (the tail
 * tells ids apart; the head of generated ids is often alike) and keep the full
 * id in details.
 */
export function shortRef(refId: string): string {
  return refId.length > 14 ? `…${refId.slice(-6).toUpperCase()}` : refId;
}

// ---- Dates ---------------------------------------------------------------

/** Today's date in Jakarta as YYYY-MM-DD. */
export function jakartaToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const pick = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The last 14 days, today included. */
export function defaultRange(now: Date = new Date()): {
  from: string;
  to: string;
} {
  const to = jakartaToday(now);
  return { from: addDays(to, -(DEFAULT_WINDOW_DAYS - 1)), to };
}

function isRealDate(value: string): boolean {
  return (
    DATE_PATTERN.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString().slice(0, 10) === value
  );
}

export type RangeError = "required" | "order" | "span";

/** Same rules as the API schema, so a bad window never reaches the server. */
export function validateRange(from: string, to: string): RangeError | null {
  if (!isRealDate(from) || !isRealDate(to)) return "required";
  const span = (Date.parse(to) - Date.parse(from)) / DAY_MS;
  if (span < 0) return "order";
  if (span + 1 > FINANCE_EXCEPTIONS_MAX_DAYS) return "span";
  return null;
}

export const RANGE_ERROR_KEYS: Record<RangeError, MessageKey> = {
  required: "financeExceptions.filters.errors.required",
  order: "financeExceptions.filters.errors.order",
  span: "financeExceptions.filters.errors.span",
};

/** URL search → the filters the screen applies (defaults fill the window). */
export function resolveFilters(
  search: FinanceExceptionSearch,
  now: Date = new Date(),
): FinanceExceptionFilters {
  const range = defaultRange(now);
  return {
    ...(search.kind ? { kind: search.kind } : {}),
    ...(search.outletId ? { outletId: search.outletId } : {}),
    from: search.from ?? range.from,
    to: search.to ?? range.to,
  };
}

/** Day and time of an ISO instant in Jakarta: "14 Nov" and "14.20". */
export function formatOccurred(iso: string): { date: string; time: string } {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return { date: iso, time: "" };
  const date = new Intl.DateTimeFormat("id-ID", {
    timeZone: TIME_ZONE,
    day: "numeric",
    month: "short",
  }).format(instant);
  const parts = new Intl.DateTimeFormat("id-ID", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const pick = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return { date, time: `${pick("hour")}.${pick("minute")}` };
}

// ---- Summary -------------------------------------------------------------

export type KindSummary = {
  kind: FinanceExceptionKind;
  count: number;
  /** Sum of the amounts the source knows; never a total across kinds. */
  amountIdr: number;
  /** True when the sum is not a real figure (no known amount at all). */
  unavailable: boolean;
  /** True when the sum is only the available values, not an exact total. */
  partial: boolean;
};

/**
 * One block per kind, always all five. The API leaves out kinds with no rows
 * and counts known amounts across every matching row, including those beyond
 * the returned page. A known zero stays available; only a kind with no known
 * amounts reads "Tidak tersedia". Mixed known and unknown amounts are partial.
 */
export function summarizeByKind(
  summary: readonly FinanceExceptionSummaryDto[],
): KindSummary[] {
  return FINANCE_EXCEPTION_KINDS.map((kind) => {
    const row = summary.find((entry) => entry.kind === kind);
    const count = row?.count ?? 0;
    const amountIdr = row?.amountIdr ?? 0;
    const knownAmountCount = row?.knownAmountCount ?? 0;
    const unavailable = count > 0 && knownAmountCount === 0;
    const partial = knownAmountCount > 0 && knownAmountCount < count;
    return { kind, count, amountIdr, unavailable, partial };
  });
}

export function totalCount(summary: readonly FinanceExceptionSummaryDto[]) {
  return summary.reduce((sum, row) => sum + row.count, 0);
}

/** Query string pieces of the apply action: empty parts are dropped. */
export function toSearch(
  filters: FinanceExceptionFilters,
): FinanceExceptionSearch {
  return {
    kind: filters.kind,
    outletId: filters.outletId,
    from: filters.from,
    to: filters.to,
  };
}

/** The scenario lives in the browser, so a prefetching loader skips it. */
export function isMockScenarioRequest(searchStr: string): boolean {
  const scenario = new URLSearchParams(searchStr).get("mock");
  return scenario !== null && scenario !== "normal";
}
