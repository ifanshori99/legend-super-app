// Pure helpers of the WS-07 financial statements and period close screens
// (bead legend-rx0h; PRD v1.7 §3.19 "Laporan Keuangan" and "Tutup Periode";
// ACC-02 "Transaksi di periode yang sudah ditutup ditolak kecuali periode
// dibuka ulang dengan approval", ACC-03 "Laba rugi per outlet dan per badan
// usaha dapat diturunkan sampai ke transaksi sumber").
//
// No React and no DOM at import time, and only relative `.ts` or bare package
// imports, so tests/ws07-statements.test.mjs loads this file with Node type
// stripping. Business rules stay in the contract (@starter/shared/accounting):
// this file only shapes server payloads for rendering, builds the endpoint
// queries, and wraps the contract's close decision so the screen shows the
// same refusal the API would.
//
// No money is summed here. Every amount placed in a row comes from the
// endpoint payload (`section.totalIdr`, `netProfitIdr`, …) or from the mock
// that stands in for the API.

import {
  AccountingError,
  decidePeriodClose,
  multiEntityProfitAndLossSchema,
  periodBounds,
  statementBasisFor,
  type BalanceSheet,
  type CashFlowStatement,
  type EquityChanges,
  type FiscalPeriod,
  type FiscalPeriodStatus,
  type ManualJournal,
  type PeriodCloseBlockers,
  type PeriodReopenRequestStatus,
  type ProfitAndLoss,
  type ReportGroup,
} from "@starter/shared/accounting";
import { z } from "@starter/shared/core";
import type { IsoDateTime, OutletId, UserId } from "@starter/shared/core";
import type { MessageKey } from "@starter/shared/i18n";
import {
  compareAccountCodes,
  formatBusinessDate,
  formatPeriod,
} from "../ws07-accounting/lib.ts";

export {
  JOURNAL_SOURCE_KEYS,
  REPORT_GROUP_KEYS,
  businessDateToday,
  formatBusinessDate,
  formatDateTime,
  formatPeriod,
  monthRange,
} from "../ws07-accounting/lib.ts";

/** Calendar bounds of a fiscal period key ("2026-11" → 1st..last day). */
export { periodBounds } from "@starter/shared/accounting";

/** The multi-entity payload has no hand-written type; infer it from its schema. */
export type MultiEntityProfitAndLoss = z.output<
  typeof multiEntityProfitAndLossSchema
>;

// ---- Statement types and queries -------------------------------------------

export const STATEMENT_TYPES = [
  "balanceSheet",
  "profitAndLoss",
  "cashFlow",
  "equityChanges",
  "multiEntity",
] as const;
export type StatementType = (typeof STATEMENT_TYPES)[number];

export const STATEMENT_TYPE_KEYS: Record<StatementType, MessageKey> = {
  balanceSheet: "accounting.report.type.balanceSheet",
  profitAndLoss: "accounting.report.type.profitAndLoss",
  cashFlow: "accounting.report.type.cashFlow",
  equityChanges: "accounting.report.type.equityChanges",
  multiEntity: "accounting.report.type.multiEntity",
};

export const STATEMENT_SUBTITLE_KEYS: Record<StatementType, MessageKey> = {
  balanceSheet: "accounting.report.statement.balanceSheetSubtitle",
  profitAndLoss: "accounting.report.statement.profitAndLossSubtitle",
  cashFlow: "accounting.report.statement.cashFlowSubtitle",
  equityChanges: "accounting.report.statement.equityChangesSubtitle",
  multiEntity: "accounting.report.statement.multiEntitySubtitle",
};

/** What the statement type's own query schema accepts (the date inputs). */
export type StatementParams = {
  from: string;
  to: string;
  outletId?: string;
};

export type BalanceSheetQuery = { legalEntityId: string; asOf: string };
export type PeriodStatementQuery = {
  legalEntityId: string;
  from: string;
  to: string;
};
export type OutletStatementQuery = PeriodStatementQuery & {
  outletId?: OutletId;
};
export type MultiEntityQuery = { from: string; to: string };

/**
 * Maps one screen selection to the query of the endpoint the statement uses:
 * the balance sheet is as-of, the P&L takes an optional outlet (ACC-03), cash
 * flow and equity are entity ranges, and the multi-entity report has no
 * entity because it returns every entity itself.
 */
export function statementQueryFor(
  type: "balanceSheet",
  legalEntityId: string,
  params: StatementParams,
): BalanceSheetQuery;
export function statementQueryFor(
  type: "profitAndLoss",
  legalEntityId: string,
  params: StatementParams,
): OutletStatementQuery;
export function statementQueryFor(
  type: "cashFlow" | "equityChanges",
  legalEntityId: string,
  params: StatementParams,
): PeriodStatementQuery;
export function statementQueryFor(
  type: "multiEntity",
  legalEntityId: string,
  params: StatementParams,
): MultiEntityQuery;
export function statementQueryFor(
  type: StatementType,
  legalEntityId: string,
  params: StatementParams,
):
  | BalanceSheetQuery
  | OutletStatementQuery
  | PeriodStatementQuery
  | MultiEntityQuery {
  switch (type) {
    case "balanceSheet":
      return { legalEntityId, asOf: params.to };
    case "profitAndLoss":
      return {
        legalEntityId,
        from: params.from,
        to: params.to,
        ...(params.outletId ? { outletId: params.outletId as OutletId } : {}),
      };
    case "cashFlow":
    case "equityChanges":
      return { legalEntityId, from: params.from, to: params.to };
    case "multiEntity":
      return { from: params.from, to: params.to };
  }
}

/**
 * The ledger starts before the first fixture (2026-09); the balance sheet and
 * equity closing balances are cumulative, so their drill-down asks for every
 * line up to the as-of date. The date is a query bound, never a business date
 * shown to the user.
 */
export const LEDGER_START_DATE = "1970-01-01";

export type DrillDownQuery = {
  legalEntityId: string;
  accountId: string;
  from: string;
  to: string;
  outletId?: OutletId;
};

/** ACC-03: the drill-down query behind one statement row. */
export function drillDownQueryFor(
  type: StatementType,
  legalEntityId: string,
  params: StatementParams,
  accountId: string,
): DrillDownQuery {
  if (type === "balanceSheet" || type === "equityChanges")
    return {
      legalEntityId,
      accountId,
      from: LEDGER_START_DATE,
      to: params.to,
    };
  if (type === "profitAndLoss")
    return {
      legalEntityId,
      accountId,
      from: params.from,
      to: params.to,
      ...(params.outletId ? { outletId: params.outletId as OutletId } : {}),
    };
  return { legalEntityId, accountId, from: params.from, to: params.to };
}

/** A clicked statement row: the drill-down query plus what the sheet shows. */
export type StatementDrillTarget = DrillDownQuery & {
  code: string;
  name: string;
  amountIdr: number;
};

/** Props shared by the five statement renderers (keeps the page generic). */
export type StatementViewProps = {
  legalEntityId: string;
  params: StatementParams;
  onDrillDown: (target: StatementDrillTarget) => void;
  onResetRange: () => void;
  /**
   * Official/estimate label of the selected entity's figures (null while the
   * fiscal periods load). The multi-entity view derives its own per entity.
   */
  basis: StatementBasisKind | null;
};

// ---- Row shaping (only places server values) -------------------------------

export type StatementRowView =
  | { kind: "section"; group: ReportGroup }
  | {
      kind: "account";
      group: ReportGroup;
      accountId: string;
      code: string;
      name: string;
      amountIdr: number;
      depth: number;
    }
  | { kind: "subtotal"; group: ReportGroup; totalIdr: number }
  | { kind: "note"; labelKey: MessageKey; amountIdr: number }
  | {
      kind: "summary";
      labelKey: MessageKey;
      amountIdr: number;
      emphasis: "normal" | "strong";
    };

function pushSection(
  rows: StatementRowView[],
  section: {
    group: ReportGroup;
    rows: readonly {
      accountId: string;
      code: string;
      name: string;
      amountIdr: number;
    }[];
    totalIdr: number;
  },
  includeWhenEmpty = false,
): void {
  if (section.rows.length === 0 && !includeWhenEmpty) return;
  rows.push({ kind: "section", group: section.group });
  for (const row of section.rows)
    rows.push({ kind: "account", group: section.group, ...row, depth: 1 });
  rows.push({
    kind: "subtotal",
    group: section.group,
    totalIdr: section.totalIdr,
  });
}

/** P&L: section headers, indented account rows, section subtotals, profit lines. */
export function profitAndLossRows(pl: ProfitAndLoss): StatementRowView[] {
  const rows: StatementRowView[] = [];
  for (const section of pl.sections) pushSection(rows, section);
  rows.push({
    kind: "summary",
    labelKey: "accounting.report.pl.grossProfit",
    amountIdr: pl.grossProfitIdr,
    emphasis: "normal",
  });
  rows.push({
    kind: "summary",
    labelKey: "accounting.report.pl.operatingProfit",
    amountIdr: pl.operatingProfitIdr,
    emphasis: "normal",
  });
  rows.push({
    kind: "summary",
    labelKey: "accounting.report.pl.netProfit",
    amountIdr: pl.netProfitIdr,
    emphasis: "strong",
  });
  return rows;
}

/** Balance sheet: asset, liability and equity sections plus the three totals. */
export function balanceSheetRows(bs: BalanceSheet): StatementRowView[] {
  const rows: StatementRowView[] = [];
  for (const section of bs.sections) {
    const equity = section.group === "equity";
    pushSection(rows, section, equity);
    // Revenue − expenses not yet closed to retained earnings sits in equity.
    if (equity)
      rows.push({
        kind: "note",
        labelKey: "accounting.report.bs.currentEarnings",
        amountIdr: bs.currentEarningsIdr,
      });
  }
  rows.push({
    kind: "summary",
    labelKey: "accounting.report.bs.totalAssets",
    amountIdr: bs.totalAssetsIdr,
    emphasis: "strong",
  });
  rows.push({
    kind: "summary",
    labelKey: "accounting.report.bs.totalLiabilities",
    amountIdr: bs.totalLiabilitiesIdr,
    emphasis: "strong",
  });
  rows.push({
    kind: "summary",
    labelKey: "accounting.report.bs.totalEquity",
    amountIdr: bs.totalEquityIdr,
    emphasis: "strong",
  });
  return rows;
}

/** True when the statement has no account row to show (drives the empty state). */
export function hasAccountRows(rows: readonly StatementRowView[]): boolean {
  return rows.some((row) => row.kind === "account");
}

// ---- Cash flow -------------------------------------------------------------

export type CashFlowActivity =
  CashFlowStatement["sections"][number]["activity"];

export const CASH_FLOW_ACTIVITY_KEYS: Record<CashFlowActivity, MessageKey> = {
  operating: "accounting.report.cf.activity.operating",
  investing: "accounting.report.cf.activity.investing",
  financing: "accounting.report.cf.activity.financing",
};

export type CashFlowRowView =
  | { kind: "section"; activity: CashFlowActivity }
  | { kind: "line"; label: string; amountIdr: number }
  | { kind: "empty" }
  | { kind: "subtotal"; activity: CashFlowActivity; totalIdr: number }
  | {
      kind: "summary";
      labelKey: MessageKey;
      amountIdr: number;
      emphasis: "normal" | "strong";
    };

/** Cash flow: activity headers, server-labelled lines, activity subtotals, cash roll-forward. */
export function cashFlowRows(cf: CashFlowStatement): CashFlowRowView[] {
  const rows: CashFlowRowView[] = [];
  for (const section of cf.sections) {
    rows.push({ kind: "section", activity: section.activity });
    for (const row of section.rows)
      rows.push({ kind: "line", label: row.label, amountIdr: row.amountIdr });
    if (section.rows.length === 0) rows.push({ kind: "empty" });
    rows.push({
      kind: "subtotal",
      activity: section.activity,
      totalIdr: section.totalIdr,
    });
  }
  rows.push({
    kind: "summary",
    labelKey: "accounting.report.cf.openingCash",
    amountIdr: cf.openingCashIdr,
    emphasis: "normal",
  });
  rows.push({
    kind: "summary",
    labelKey: "accounting.report.cf.netChange",
    amountIdr: cf.netChangeIdr,
    emphasis: "strong",
  });
  rows.push({
    kind: "summary",
    labelKey: "accounting.report.cf.closingCash",
    amountIdr: cf.closingCashIdr,
    emphasis: "strong",
  });
  return rows;
}

/** An empty cash flow has no line at all, whatever its zero totals. */
export function isEmptyCashFlow(cf: CashFlowStatement): boolean {
  return cf.sections.every((section) => section.rows.length === 0);
}

// ---- Equity changes --------------------------------------------------------

export const EQUITY_COLUMNS = [
  "openingIdr",
  "profitIdr",
  "distributionsIdr",
  "otherMovementsIdr",
  "closingIdr",
] as const;
export type EquityColumn = (typeof EQUITY_COLUMNS)[number];

export const EQUITY_COLUMN_KEYS: Record<EquityColumn, MessageKey> = {
  openingIdr: "accounting.report.equity.columns.opening",
  profitIdr: "accounting.report.equity.columns.profit",
  distributionsIdr: "accounting.report.equity.columns.distributions",
  otherMovementsIdr: "accounting.report.equity.columns.other",
  closingIdr: "accounting.report.equity.columns.closing",
};

export function isEmptyEquityChanges(eq: EquityChanges): boolean {
  return eq.rows.length === 0;
}

// ---- Multi-entity ----------------------------------------------------------

const PL_GROUP_ORDER: readonly ReportGroup[] = [
  "revenue",
  "cogs",
  "operating_expense",
  "other_income",
  "other_expense",
];

export type MultiEntityRowView =
  | { kind: "section"; group: ReportGroup }
  | {
      kind: "account";
      group: ReportGroup;
      code: string;
      name: string;
      /** One amount per entity, in payload order; null = the entity has no row. */
      amounts: readonly (number | null)[];
      /** One account id per entity (account ids differ between entities). */
      accountIds: readonly (string | null)[];
      depth: number;
    }
  | {
      kind: "subtotal";
      group: ReportGroup;
      amounts: readonly number[];
    }
  | {
      kind: "summary";
      labelKey: MessageKey;
      amounts: readonly number[];
      /** Only the net-profit row carries the server's combined figure. */
      combinedIdr?: number;
    };

/**
 * Aligns each entity's P&L by account code so the columns read as one report.
 * Amounts and section totals are copied from the payload; nothing is summed.
 */
export function multiEntityRows(
  report: MultiEntityProfitAndLoss,
): MultiEntityRowView[] {
  const rows: MultiEntityRowView[] = [];
  for (const group of PL_GROUP_ORDER) {
    const sections = report.entities.map(
      (entity) =>
        entity.sections.find((section) => section.group === group) ?? null,
    );
    if (sections.every((section) => !section || section.rows.length === 0))
      continue;
    rows.push({ kind: "section", group });
    const byCode = new Map<
      string,
      {
        code: string;
        name: string;
        amounts: (number | null)[];
        accountIds: (string | null)[];
      }
    >();
    report.entities.forEach((_, index) => {
      for (const row of sections[index]?.rows ?? []) {
        const existing = byCode.get(row.code);
        if (existing) {
          existing.amounts[index] = row.amountIdr;
          existing.accountIds[index] = row.accountId;
        } else
          byCode.set(row.code, {
            code: row.code,
            name: row.name,
            amounts: report.entities.map((__, entityIndex) =>
              entityIndex === index ? row.amountIdr : null,
            ),
            accountIds: report.entities.map((__, entityIndex) =>
              entityIndex === index ? row.accountId : null,
            ),
          });
      }
    });
    for (const row of [...byCode.values()].sort((a, b) =>
      compareAccountCodes(a.code, b.code),
    ))
      rows.push({ kind: "account", group, ...row, depth: 1 });
    rows.push({
      kind: "subtotal",
      group,
      amounts: sections.map((section) => section?.totalIdr ?? 0),
    });
  }
  rows.push({
    kind: "summary",
    labelKey: "accounting.report.pl.grossProfit",
    amounts: report.entities.map((entity) => entity.grossProfitIdr),
  });
  rows.push({
    kind: "summary",
    labelKey: "accounting.report.pl.operatingProfit",
    amounts: report.entities.map((entity) => entity.operatingProfitIdr),
  });
  rows.push({
    kind: "summary",
    labelKey: "accounting.report.pl.netProfit",
    amounts: report.entities.map((entity) => entity.netProfitIdr),
    combinedIdr: report.combinedNetProfitIdr,
  });
  return rows;
}

export function hasMultiEntityAccountRows(
  rows: readonly MultiEntityRowView[],
): boolean {
  return rows.some((row) => row.kind === "account");
}

// ---- Closed periods in a range ---------------------------------------------

/** Closed fiscal periods that overlap a date range, oldest first. */
export function closedPeriodsInRange(
  periods: readonly FiscalPeriod[],
  from: string,
  to: string,
): FiscalPeriod[] {
  return periods
    .filter((period) => period.status === "closed")
    .filter((period) => {
      const bounds = periodBounds(period.period);
      return bounds.start <= to && bounds.end >= from;
    })
    .sort((a, b) => a.period.localeCompare(b.period));
}

// ---- Official vs estimate (PRD §3.19 Tutup Periode, §3 dashboard rule) -----

export type StatementBasisKind = "official" | "estimate";

export type StatementBasis = {
  basis: StatementBasisKind;
  /** Closed months the figures cover (official numbers, frozen at close). */
  closed: string[];
  /** Months still open, or with no fiscal period yet: their figures can change. */
  open: string[];
};

/**
 * Figures are official only when every month they depend on is a closed
 * fiscal period ("Angka resmi hanya diambil dari periode yang sudah ditutup;
 * angka berjalan diberi label estimasi"). A range that spans an open month is
 * an estimate as a whole. `cumulative` statements (balance sheet, cash flow
 * opening cash, equity opening balances) also depend on every earlier month.
 * The status comes from the server's fiscal-period rows; nothing is guessed.
 */
export function statementBasis(
  periods: readonly Pick<FiscalPeriod, "period" | "status">[],
  from: string,
  to: string,
  options: { cumulative?: boolean } = {},
): StatementBasis {
  // One rule for web and API: the shared statementBasisFor.
  const result = statementBasisFor(periods, {
    from,
    to,
    ...(options.cumulative ? { cumulative: true } : {}),
  });
  return {
    basis: result.basis === "closed_snapshot" ? "official" : "estimate",
    closed: result.closedPeriodKeys,
    open: result.openPeriodKeys,
  };
}

/** Multi-entity: official only when every entity's figures are official. */
export function combineStatementBases(
  bases: readonly StatementBasis[],
): StatementBasis {
  const closed = new Set<string>();
  const open = new Set<string>();
  for (const basis of bases) {
    basis.closed.forEach((month) => closed.add(month));
    basis.open.forEach((month) => open.add(month));
  }
  open.forEach((month) => closed.delete(month));
  const official =
    bases.length > 0 && bases.every((basis) => basis.basis === "official");
  return {
    basis: official ? "official" : "estimate",
    closed: [...closed].sort(),
    open: [...open].sort(),
  };
}

/** The date bounds a statement type's basis depends on. */
export function basisRangeFor(
  type: StatementType,
  params: StatementParams,
): { from: string; to: string; cumulative: boolean } {
  if (type === "balanceSheet")
    return { from: params.to, to: params.to, cumulative: true };
  return {
    from: params.from,
    to: params.to,
    cumulative: type === "cashFlow" || type === "equityChanges",
  };
}

/**
 * Balance check of a balance sheet, from the three server totals. Compared
 * in bigint so the check itself cannot lose precision.
 */
export function isBalanceSheetBalanced(
  bs: Pick<
    BalanceSheet,
    "totalAssetsIdr" | "totalLiabilitiesIdr" | "totalEquityIdr"
  >,
): boolean {
  return (
    BigInt(bs.totalAssetsIdr) ===
    BigInt(bs.totalLiabilitiesIdr) + BigInt(bs.totalEquityIdr)
  );
}

// ---- Period close (ACC-02) -------------------------------------------------

/** `decidePeriodClose` needs an actor and clock for its result, not its checks. */
const PRECHECK_ACTOR = "00000000-0000-4000-8000-000000000000" as UserId;
const PRECHECK_NOW = "1970-01-01T00:00:00.000Z" as IsoDateTime;

export type CloseBlockerCode =
  | "PERIOD_NOT_ENDED"
  | "PERIOD_CLOSE_OUT_OF_ORDER"
  | "PERIOD_ALREADY_CLOSED"
  | "DRAFT_JOURNALS"
  | "PENDING_JOURNALS"
  | "TRIAL_BALANCE_UNBALANCED";

export type CloseBlocker = { code: CloseBlockerCode; count?: number };

const CONTRACT_CLOSE_CODES: readonly CloseBlockerCode[] = [
  "PERIOD_NOT_ENDED",
  "PERIOD_CLOSE_OUT_OF_ORDER",
  "PERIOD_ALREADY_CLOSED",
];

/**
 * The checklist verdict before a close. Contract rules come from
 * `decidePeriodClose` (so the screen refuses exactly what the API refuses);
 * the unposted-journal checks are the bead's close checklist and stay in the
 * UI, because the contract does not make them a hard close rule.
 */
export function closeReadiness(input: {
  period: FiscalPeriod;
  entityPeriods: readonly FiscalPeriod[];
  today: string;
  draftCount: number;
  pendingCount: number;
  trialBalanceBalanced: boolean;
}): { blockers: CloseBlocker[]; ready: boolean } {
  const blockers: CloseBlocker[] = [];
  try {
    decidePeriodClose({
      period: input.period,
      entityPeriods: input.entityPeriods,
      today: input.today,
      actorId: PRECHECK_ACTOR,
      now: PRECHECK_NOW,
    });
  } catch (error) {
    if (
      error instanceof AccountingError &&
      CONTRACT_CLOSE_CODES.includes(error.code as CloseBlockerCode)
    )
      blockers.push({ code: error.code as CloseBlockerCode });
    else throw error;
  }
  if (input.draftCount > 0)
    blockers.push({ code: "DRAFT_JOURNALS", count: input.draftCount });
  if (input.pendingCount > 0)
    blockers.push({ code: "PENDING_JOURNALS", count: input.pendingCount });
  if (!input.trialBalanceBalanced)
    blockers.push({ code: "TRIAL_BALANCE_UNBALANCED" });
  return { blockers, ready: blockers.length === 0 };
}

/** Manual journals of one period that still have to be finished before close. */
export function blockingJournalCounts(
  rows: readonly Pick<ManualJournal, "status" | "entryDate">[],
  period: string,
): { draft: number; pending: number } {
  const bounds = periodBounds(period);
  let draft = 0;
  let pending = 0;
  for (const row of rows) {
    if (row.entryDate < bounds.start || row.entryDate > bounds.end) continue;
    if (row.status === "draft") draft += 1;
    else if (row.status === "pending_approval") pending += 1;
  }
  return { draft, pending };
}

export function openPeriodCount(periods: readonly FiscalPeriod[]): number {
  return periods.filter((period) => period.status === "open").length;
}

export function closedPeriodCount(periods: readonly FiscalPeriod[]): number {
  return periods.filter((period) => period.status === "closed").length;
}

/**
 * The period the close workflow expects next: the oldest open period whose
 * month already ended. Null when every ended period is closed.
 */
export function nextPeriodToClose(
  periods: readonly FiscalPeriod[],
  today: string,
): FiscalPeriod | null {
  return (
    [...periods]
      .filter((period) => period.status === "open")
      .sort((a, b) => a.period.localeCompare(b.period))
      .find((period) => periodBounds(period.period).end < today) ?? null
  );
}

/** The latest closed period: the only one `decidePeriodReopen` will reopen. */
export function latestClosedPeriod(
  periods: readonly FiscalPeriod[],
): FiscalPeriod | null {
  return (
    [...periods]
      .filter((period) => period.status === "closed")
      .sort((a, b) => b.period.localeCompare(a.period))[0] ?? null
  );
}

/** Whether the "Ajukan buka ulang" action belongs on this row. */
export function isReopenable(
  period: FiscalPeriod,
  periods: readonly FiscalPeriod[],
): boolean {
  return (
    period.status === "closed" && latestClosedPeriod(periods)?.id === period.id
  );
}

export const MIN_REOPEN_REASON_LENGTH = 10;

export type ReopenReasonIssue = "required" | "too_short" | null;

/** UI minimum for a reopen reason (the contract only requires one character). */
export function reopenReasonIssue(
  reason: string,
  minLength: number = MIN_REOPEN_REASON_LENGTH,
): ReopenReasonIssue {
  const trimmed = reason.trim();
  if (trimmed === "") return "required";
  if (trimmed.length < minLength) return "too_short";
  return null;
}

// ---- Close override (card 1263) --------------------------------------------

/** Same limits as `closeFiscalPeriodOverrideInputSchema` (trimmed reason). */
export const OVERRIDE_REASON_MIN_LENGTH = 20;
export const OVERRIDE_REASON_MAX_LENGTH = 1000;

export type OverrideReasonIssue = "required" | "too_short" | "too_long" | null;

/** Length is judged on the trimmed text, like the contract does. */
export function overrideReasonIssue(reason: string): OverrideReasonIssue {
  const length = reason.trim().length;
  if (length === 0) return "required";
  if (length < OVERRIDE_REASON_MIN_LENGTH) return "too_short";
  if (length > OVERRIDE_REASON_MAX_LENGTH) return "too_long";
  return null;
}

/**
 * Closing over incomplete batches needs both permissions: the API requires
 * `accounting.period.close` as well as the override one. The API re-checks.
 */
export function canOverridePeriodClose(
  permissions: readonly string[],
): boolean {
  return (
    permissions.includes("accounting.period.close") &&
    permissions.includes("accounting.period.close_override")
  );
}

export type OverrideMode =
  /** The list came back empty: close again the normal way. */
  | "empty"
  /** Another kind of blocker is present: fix it first. */
  | "fix_first"
  /** Overridable, but the visitor may not continue. */
  | "no_permission"
  | "allowed";

export function overrideMode(
  blockers: Pick<PeriodCloseBlockers, "overridable" | "sources">,
  canOverride: boolean,
): OverrideMode {
  if (blockers.sources.length === 0) return "empty";
  if (!blockers.overridable) return "fix_first";
  return canOverride ? "allowed" : "no_permission";
}

/** The ids sent to the API: exactly the sources shown, in the order shown. */
export function overrideSourceIds(
  blockers: Pick<PeriodCloseBlockers, "sources">,
): string[] {
  return blockers.sources.map((source) => source.sourceId);
}

/**
 * What identifies one close attempt. The idempotency key follows this: a retry
 * of the same request reuses its key; a changed reason, period version or
 * source list is a new request and gets a new one.
 */
export function overrideAttemptPayload(input: {
  fiscalPeriodId: string;
  expectedVersion: number;
  reason: string;
  sourceIds: readonly string[];
}) {
  return {
    fiscalPeriodId: input.fiscalPeriodId,
    expectedVersion: input.expectedVersion,
    reason: input.reason.trim(),
    sourceIds: [...input.sourceIds],
  };
}

const BLOCKER_SOURCE_KEYS: Record<string, MessageKey> = {
  production_order:
    "accounting.report.periods.closeDialog.stock.sourceType.production_order",
  stock_count:
    "accounting.report.periods.closeDialog.stock.sourceType.stock_count",
  waste_log: "accounting.report.periods.closeDialog.stock.sourceType.waste_log",
  order: "accounting.report.periods.closeDialog.stock.sourceType.order",
  negative_stock_revaluation:
    "accounting.report.periods.closeDialog.stock.sourceType.negative_stock_revaluation",
};

const BLOCKER_REASON_KEYS: Record<string, MessageKey> = {
  PRODUCTION_INCOMPLETE:
    "accounting.report.periods.closeDialog.stock.reason.PRODUCTION_INCOMPLETE",
  PERIOD_CLOSED:
    "accounting.report.periods.closeDialog.stock.reason.PERIOD_CLOSED",
  ACCOUNT_MAPPING_MISSING:
    "accounting.report.periods.closeDialog.stock.reason.ACCOUNT_MAPPING_MISSING",
  ACCOUNT_NOT_POSTABLE:
    "accounting.report.periods.closeDialog.stock.reason.ACCOUNT_NOT_POSTABLE",
  ACCOUNT_INACTIVE:
    "accounting.report.periods.closeDialog.stock.reason.ACCOUNT_INACTIVE",
  ACCOUNT_ENTITY_MISMATCH:
    "accounting.report.periods.closeDialog.stock.reason.ACCOUNT_ENTITY_MISMATCH",
};

/** Label of a source type when the source has no item name (never a raw id). */
export function blockerSourceKey(sourceType: string): MessageKey {
  return (
    BLOCKER_SOURCE_KEYS[sourceType] ??
    "accounting.report.periods.closeDialog.stock.sourceType.unknown"
  );
}

/** Short reason text of a parked source's error code. */
export function blockerReasonKey(errorCode: string): MessageKey {
  return (
    BLOCKER_REASON_KEYS[errorCode] ??
    "accounting.report.periods.closeDialog.stock.reason.unknown"
  );
}

/** Catalog text of a refused close-override request; null: use the generic one. */
export function closeOverrideErrorKey(code: string): MessageKey | null {
  switch (code) {
    case "PERIOD_OVERRIDE_SOURCES_CHANGED":
      return "accounting.report.periods.closeDialog.stock.sourcesChanged";
    case "PERIOD_INVENTORY_GL_BLOCKED":
      return "accounting.report.periods.closeDialog.stock.stillBlocked";
    case "PERIOD_CHANGED":
      return "accounting.report.periods.closeDialog.stock.periodChanged";
    case "MFA_REQUIRED":
      return "accounting.report.periods.closeDialog.stock.mfaRequired";
    case "FORBIDDEN":
    case "PERMISSION_DENIED":
      return "accounting.report.periods.closeDialog.stock.forbidden";
    default:
      return null;
  }
}

/** Refusals that mean the shown list is out of date and must be read again. */
export function closeOverrideNeedsRefetch(code: string): boolean {
  return (
    code === "PERIOD_OVERRIDE_SOURCES_CHANGED" ||
    code === "PERIOD_INVENTORY_GL_BLOCKED"
  );
}

// ---- Snapshot history ------------------------------------------------------

/**
 * A close snapshot is history once its period is open again or its version no
 * longer matches the period's (reopened, maybe closed again). Older mocks omit
 * periodStatus/periodVersion: then nothing says the snapshot is stale.
 */
export function isSnapshotHistory(snapshot: {
  version: number;
  periodStatus?: FiscalPeriodStatus;
  periodVersion?: number;
}): boolean {
  if (snapshot.periodStatus === "open") return true;
  return (
    snapshot.periodVersion !== undefined &&
    snapshot.periodVersion !== snapshot.version
  );
}

// ---- Catalog keys of period statuses --------------------------------------

export const PERIOD_STATUS_KEYS: Record<FiscalPeriodStatus, MessageKey> = {
  open: "accounting.report.periods.statusOpen",
  closed: "accounting.report.periods.statusClosed",
};

export const REOPEN_STATUS_KEYS: Record<PeriodReopenRequestStatus, MessageKey> =
  {
    pending: "accounting.report.periods.reopen.status.pending",
    approved: "accounting.report.periods.reopen.status.approved",
    rejected: "accounting.report.periods.reopen.status.rejected",
    cancelled: "accounting.report.periods.reopen.status.cancelled",
  };

/** A user id has no name endpoint yet; the first segment is enough to trace. */
export function shortUserId(userId: string | null): string {
  return userId === null ? "—" : userId.slice(0, 8);
}

/** Re-exported formatters keep one date style across the accounting screens. */
export const formatStatementDate = formatBusinessDate;
export const formatStatementPeriod = formatPeriod;
