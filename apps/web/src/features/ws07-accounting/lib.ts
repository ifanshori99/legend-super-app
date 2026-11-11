// Pure helpers of the WS-07 accounting back office (bead legend-mzg; PRD v1.7
// §3.19 "Chart of Accounts", "Jurnal Otomatis", "Jurnal Manual & Berulang";
// ACC-01 "Setiap jurnal selalu seimbang; jurnal final tidak dapat dihapus dan
// koreksi dilakukan melalui jurnal pembalik", ACC-03 "…dapat diturunkan sampai
// ke transaksi sumber").
//
// No React and no DOM at import time, and only relative or bare package
// imports, so tests/ws07-accounting.test.mjs loads this file with Node type
// stripping. Business rules stay in the contract (@starter/shared/accounting);
// this file only shapes and derives what the screens render.

import {
  checkJournalBalance,
  headerAccountIds,
  type Account,
  type AccountId,
  type AccountType,
  type JournalEntry,
  type JournalLineInput,
  type JournalSourceType,
  type ManualJournalStatus,
  type RecurringJournalStatus,
  type ReportGroup,
} from "@starter/shared/accounting";
import {
  DEFAULT_BUSINESS_DAY_CUTOFF,
  businessDateOf,
  type OutletId,
} from "@starter/shared/core";
import type { MessageKey } from "@starter/shared/i18n";

// ---- Chart of accounts ----------------------------------------------------

export type AccountRow = {
  account: Account;
  depth: number;
  /** Header accounts group children and never take journal lines. */
  isHeader: boolean;
};

/** Codes compare segment by segment, so 1100 < 1101 < 1101.2 < 1200. */
export function compareAccountCodes(left: string, right: string): number {
  const a = left.split(/[.-]/);
  const b = right.split(/[.-]/);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index];
    const y = b[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny) && nx !== ny) return nx - ny;
    if (x !== y) return x.localeCompare(y);
  }
  return 0;
}

/**
 * Depth-first tree of one legal entity's chart, siblings by code. Accounts
 * whose parent is missing or forms a cycle are still shown (at depth 0) so a
 * broken chart is visible instead of silently disappearing.
 */
export function accountTreeRows(accounts: readonly Account[]): AccountRow[] {
  const headers = headerAccountIds(accounts);
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const children = new Map<string | null, Account[]>();
  for (const account of accounts) {
    const parent =
      account.parentId !== null && byId.has(account.parentId)
        ? account.parentId
        : null;
    const siblings = children.get(parent) ?? [];
    siblings.push(account);
    children.set(parent, siblings);
  }
  for (const siblings of children.values())
    siblings.sort((a, b) => compareAccountCodes(a.code, b.code));

  const rows: AccountRow[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const account of children.get(parent) ?? []) {
      if (seen.has(account.id)) continue;
      seen.add(account.id);
      rows.push({
        account,
        depth,
        isHeader: headers.has(account.id),
      });
      walk(account.id, depth + 1);
    }
  };
  walk(null, 0);
  for (const account of accounts) {
    if (seen.has(account.id)) continue;
    seen.add(account.id);
    rows.push({ account, depth: 0, isHeader: headers.has(account.id) });
  }
  return rows;
}

/** Accounts a journal line may point at: active leaves (ACC-01 posting check). */
export function postableAccounts(accounts: readonly Account[]): Account[] {
  const headers = headerAccountIds(accounts);
  return accounts
    .filter((account) => account.isActive && !headers.has(account.id))
    .sort((a, b) => compareAccountCodes(a.code, b.code));
}

export function accountLabel(account: Pick<Account, "code" | "name">): string {
  return `${account.code} · ${account.name}`;
}

export function accountById(
  accounts: readonly Account[],
): ReadonlyMap<string, Account> {
  return new Map(accounts.map((account) => [account.id, account]));
}

/** Case-insensitive code/name search for the chart screen. */
export function matchesAccount(
  account: Pick<Account, "code" | "name">,
  query: string,
): boolean {
  const needle = query.trim().toLocaleLowerCase("id-ID");
  if (needle === "") return true;
  return (
    account.code.toLocaleLowerCase("id-ID").includes(needle) ||
    account.name.toLocaleLowerCase("id-ID").includes(needle)
  );
}

// ---- Catalog keys (text never lives in this file) -------------------------

export const ACCOUNT_TYPE_KEYS = {
  asset: "accounting.coa.types.asset",
  liability: "accounting.coa.types.liability",
  equity: "accounting.coa.types.equity",
  revenue: "accounting.coa.types.revenue",
  expense: "accounting.coa.types.expense",
} as const satisfies Record<AccountType, MessageKey>;

export const REPORT_GROUP_KEYS = {
  cash_and_equivalents: "accounting.coa.groups.cash_and_equivalents",
  current_asset: "accounting.coa.groups.current_asset",
  non_current_asset: "accounting.coa.groups.non_current_asset",
  current_liability: "accounting.coa.groups.current_liability",
  non_current_liability: "accounting.coa.groups.non_current_liability",
  equity: "accounting.coa.groups.equity",
  revenue: "accounting.coa.groups.revenue",
  other_income: "accounting.coa.groups.other_income",
  cogs: "accounting.coa.groups.cogs",
  operating_expense: "accounting.coa.groups.operating_expense",
  other_expense: "accounting.coa.groups.other_expense",
} as const satisfies Record<ReportGroup, MessageKey>;

export const JOURNAL_SOURCE_KEYS = {
  sale: "accounting.source.sale",
  refund: "accounting.source.refund",
  gateway_settlement: "accounting.source.gateway_settlement",
  edc_settlement: "accounting.source.edc_settlement",
  cogs: "accounting.source.cogs",
  stock_adjustment: "accounting.source.stock_adjustment",
  purchase: "accounting.source.purchase",
  supplier_invoice: "accounting.source.supplier_invoice",
  supplier_payment: "accounting.source.supplier_payment",
  purchase_return: "accounting.source.purchase_return",
  petty_purchase: "accounting.source.petty_purchase",
  production: "accounting.source.production",
  payroll: "accounting.source.payroll",
  loyalty: "accounting.source.loyalty",
  depreciation: "accounting.source.depreciation",
  asset_acquisition: "accounting.source.asset_acquisition",
  asset_disposal: "accounting.source.asset_disposal",
  asset_revaluation: "accounting.source.asset_revaluation",
  dividend: "accounting.source.dividend",
  cash_deposit: "accounting.source.cash_deposit",
  cashier_shift: "accounting.source.cashier_shift",
  customer_deposit: "accounting.source.customer_deposit",
  opening_balance: "accounting.source.opening_balance",
  manual: "accounting.source.manual",
  recurring: "accounting.source.recurring",
  reversal: "accounting.source.reversal",
} as const satisfies Record<JournalSourceType, MessageKey>;

export const MANUAL_KIND_KEYS = {
  general: "accounting.manual.kind.general",
  adjustment: "accounting.manual.kind.adjustment",
} as const;

export const JOURNAL_STATUS_KEYS = {
  draft: "accounting.status.draft",
  pending_approval: "accounting.status.pending_approval",
  rejected: "accounting.status.rejected",
  cancelled: "accounting.status.cancelled",
  posted: "accounting.status.posted",
} as const satisfies Record<ManualJournalStatus, MessageKey>;

export const RECURRING_STATUS_KEYS = {
  draft: "accounting.status.draft",
  pending_approval: "accounting.status.pending_approval",
  rejected: "accounting.status.rejected",
  active: "accounting.status.active",
  paused: "accounting.status.paused",
  ended: "accounting.status.ended",
} as const satisfies Record<RecurringJournalStatus, MessageKey>;

export function journalSourceLabelKey(source: JournalSourceType): MessageKey {
  return JOURNAL_SOURCE_KEYS[source];
}

// ---- Journal drill-down (ACC-03) ------------------------------------------

/**
 * Where a journal's source document lives. Only screens that exist in this app
 * are linked; the rest keep the reference id and say the source opens in its
 * own module. `Screen` names a route family, not a URL, so this file stays
 * testable without the router.
 */
export type JournalSourceScreen = "journal" | "manualJournal" | "recurring";

export type JournalSourceInfo = {
  labelKey: MessageKey;
  /** Source document id from the entry, for tracing (ACC-03). */
  reference: string | null;
  link: { screen: JournalSourceScreen; id?: string } | null;
};

export function journalSourceInfo(
  entry: Pick<JournalEntry, "sourceType" | "sourceId">,
): JournalSourceInfo {
  const labelKey = journalSourceLabelKey(entry.sourceType);
  const reference = entry.sourceId;
  if (entry.sourceType === "manual")
    return {
      labelKey,
      reference,
      link:
        reference === null ? null : { screen: "manualJournal", id: reference },
    };
  if (entry.sourceType === "recurring")
    return { labelKey, reference, link: { screen: "recurring" } };
  if (entry.sourceType === "reversal")
    return {
      labelKey,
      reference,
      link: reference === null ? null : { screen: "journal", id: reference },
    };
  return { labelKey, reference, link: null };
}

// ---- Balance (ACC-01) -----------------------------------------------------

export type EntryBalance = {
  debitIdr: number;
  creditIdr: number;
  /** debit − credit; 0 when balanced. */
  differenceIdr: number;
  balanced: boolean;
  issues: string[];
};

/** ACC-01 balance of any line set (form preview, detail footer, tests). */
export function entryBalance(
  lines: readonly { debitIdr: number; creditIdr: number }[],
): EntryBalance {
  const result = checkJournalBalance(lines);
  return {
    debitIdr: result.totalDebitIdr,
    creditIdr: result.totalCreditIdr,
    differenceIdr: result.totalDebitIdr - result.totalCreditIdr,
    balanced: result.balanced,
    issues: result.issues,
  };
}

/** Debit total of a line set; lines are balanced so this is the entry value. */
export function linesTotal(lines: readonly { debitIdr: number }[]): number {
  return lines.reduce((sum, line) => sum + line.debitIdr, 0);
}

export type LineDraft = {
  accountId: string | null;
  /** "" or absent = entity-level line (outletId null, ACC-03). */
  outletId?: string | null;
  /** Raw field text; the user may type "1.520.000". */
  debit: string;
  credit: string;
};

export type DraftIssue = "amount" | "side" | "account";

export type DraftEvaluation = {
  lines: JournalLineInput[];
  debitIdr: number;
  creditIdr: number;
  differenceIdr: number;
  /** Rows with a non-zero amount (blank rows are ignored). */
  filled: number;
  balanced: boolean;
  /** Row index → first problem, for field-level messages. */
  lineIssues: Readonly<Record<number, DraftIssue>>;
};

/** Parses a rupiah field: "1.520.000" and "1520000" both become 1520000. */
export function parseRupiahInput(value: string): number | null {
  const digits = value.replace(/[.\s]/g, "");
  if (digits === "") return 0;
  if (!/^\d+$/.test(digits)) return null;
  const amount = Number(digits);
  return Number.isSafeInteger(amount) ? amount : null;
}

/**
 * Turns the line editor into contract line inputs and the messages the form
 * shows. Blank rows are ignored; a row needs exactly one side and an account
 * (ACC-01), and fewer than two filled rows can never balance.
 */
export function evaluateManualDraft(
  drafts: readonly LineDraft[],
): DraftEvaluation {
  const lineIssues: Record<number, DraftIssue> = {};
  const lines: JournalLineInput[] = [];
  let debitIdr = 0;
  let creditIdr = 0;
  let filled = 0;
  drafts.forEach((draft, index) => {
    const debit = parseRupiahInput(draft.debit);
    const credit = parseRupiahInput(draft.credit);
    if (debit === null || credit === null) {
      lineIssues[index] = "amount";
      return;
    }
    if (debit > 0 && credit > 0) {
      lineIssues[index] = "side";
      return;
    }
    if (debit === 0 && credit === 0) return; // an empty row is not an error
    filled += 1;
    debitIdr += debit;
    creditIdr += credit;
    if (draft.accountId === null || draft.accountId === "") {
      lineIssues[index] = "account";
      return;
    }
    lines.push({
      accountId: draft.accountId as AccountId,
      debitIdr: debit as JournalLineInput["debitIdr"],
      creditIdr: credit as JournalLineInput["creditIdr"],
      outletId: draft.outletId ? (draft.outletId as OutletId) : null,
      costCenter: null,
    });
  });
  const differenceIdr = debitIdr - creditIdr;
  return {
    lines,
    debitIdr,
    creditIdr,
    differenceIdr,
    filled,
    balanced:
      filled >= 2 &&
      differenceIdr === 0 &&
      Object.keys(lineIssues).length === 0,
    lineIssues,
  };
}

// ---- State machines (which buttons a status allows) -----------------------

export type ManualJournalAction =
  "edit" | "submit" | "withdraw" | "approve" | "reject" | "cancel";

export function manualJournalActions(
  status: ManualJournalStatus,
): readonly ManualJournalAction[] {
  switch (status) {
    case "draft":
      return ["edit", "submit", "cancel"];
    case "pending_approval":
      return ["approve", "reject", "withdraw"];
    case "rejected":
      return ["edit", "cancel"];
    case "posted":
    case "cancelled":
      return [];
  }
}

export type RecurringJournalAction =
  "submit" | "approve" | "reject" | "pause" | "resume" | "end";

export function recurringJournalActions(
  status: RecurringJournalStatus,
): readonly RecurringJournalAction[] {
  switch (status) {
    case "draft":
      return ["submit"];
    case "pending_approval":
      return ["approve", "reject"];
    case "active":
      return ["pause", "end"];
    case "paused":
      return ["resume", "end"];
    case "rejected":
    case "ended":
      return [];
  }
}

export type ReversalState = "reversible" | "reversal" | "reversed";

/**
 * ACC-01: a posted entry is reversed at most once, and a reversal itself is
 * never reversed again (`assertReversible` in the contract says the same).
 */
export function journalReversalState(
  entry: Pick<JournalEntry, "reversalOf">,
  reversedBy: string | null,
): ReversalState {
  if (entry.reversalOf !== null) return "reversal";
  if (reversedBy !== null) return "reversed";
  return "reversible";
}

// ---- Dates and formatting -------------------------------------------------

/** The outlet's business date; the outlet-context bead supplies the zone. */
export const DEFAULT_OUTLET_TIME_ZONE = "Asia/Jakarta";

/** Core `businessDateOf` with the outlet cutoff (owner Q39, default 04:00). */
export function businessDateToday(
  now: Date = new Date(),
  timeZone: string = DEFAULT_OUTLET_TIME_ZONE,
  cutoff: string = DEFAULT_BUSINESS_DAY_CUTOFF,
): string {
  return businessDateOf(now, { timeZone, cutoff });
}

/** First and last day of the month a business date falls in. */
export function monthRange(businessDate: string): { from: string; to: string } {
  const [year, month] = businessDate.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const prefix = businessDate.slice(0, 7);
  return {
    from: `${prefix}-01`,
    to: `${prefix}-${String(lastDay).padStart(2, "0")}`,
  };
}

/** "2026-11-03" → "3 Nov 2026" (locale-stable, id-ID, no time zone drift). */
export function formatBusinessDate(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

/** ISO instant → "3 Nov 2026, 10.00" in the outlet time zone. */
export function formatDateTime(
  value: string,
  timeZone: string = DEFAULT_OUTLET_TIME_ZONE,
): string {
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(value));
}

/** "2026-11" → "Nov 2026". */
export function formatPeriod(period: string): string {
  const [year, month] = period.split("-").map(Number);
  return new Intl.DateTimeFormat("id-ID", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

/**
 * `?mock=empty|slow|error|offline` skips the route loader's SSR prefetch: the
 * scenario lives in the browser, so a server-prefetched page would never show
 * the state (docs/frontend.md "See loading, empty and error states").
 */
export function isMockScenarioRequest(searchStr: string): boolean {
  const scenario = new URLSearchParams(searchStr).get("mock");
  return scenario !== null && scenario !== "normal";
}
