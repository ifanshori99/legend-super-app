// Financial statements (PRD v1.7 §3.19 "Laporan Keuangan [P0] — Neraca, laba
// rugi, arus kas, perubahan ekuitas, laporan multi-entitas, dan laba rugi per
// outlet"; ACC-03 "Laba rugi per outlet dan per badan usaha dapat diturunkan
// sampai ke transaksi sumber"; POS-05 totals identical across POS, accounting
// and dashboard).
//
// Every statement is derived from posted journal lines only, so the same lines
// give the same totals everywhere. Each row carries its `accountId`; the
// drill-down endpoint lists the journal lines behind a row, and each line's
// entry carries `sourceType` + `sourceId` back to the source document.
// Builders here are pure and shared by the BE (from SQL aggregates) and the
// FE mock mode (from fixtures).

import { z } from "zod";
import {
  businessDateSchema,
  cursorPageQuerySchema,
  idrSchema,
  isoDateTimeSchema,
  outletIdSchema,
} from "../core/index.ts";
import type { Idr, OutletId } from "../core/index.ts";
import {
  normalBalanceOf,
  accountTypeSchema,
  reportGroupSchema,
} from "./coa.ts";
import type { Account, ReportGroup } from "./coa.ts";
import {
  accountIdSchema,
  journalEntryIdSchema,
  journalLineIdSchema,
  legalEntityIdSchema,
} from "./ids.ts";
import { journalSourceIdSchema, journalSourceTypeSchema } from "./journal.ts";
import {
  refineStatementBasis,
  statementBasisFields,
  statementBasisShape,
} from "./statement-basis.ts";

/** Fiscal-period rows a builder reads the basis from; none = nothing closed = live. */
type PeriodRows = readonly { period: string; status: string }[];

/** A posted line as statements need it (the entry date and line outlet). */
export type LedgerLine = {
  accountId: string;
  debitIdr: number;
  creditIdr: number;
  outletId: OutletId | null;
  entryDate: string;
};

const sumBig = (values: readonly number[]) =>
  values.reduce((total, value) => total + BigInt(value), 0n);
const toIdr = (value: bigint) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RangeError("Idr overflow");
  return number as Idr;
};

/** Natural-sign balance: positive when the account sits on its normal side. */
export function naturalBalance(
  account: Pick<Account, "type">,
  debitIdr: number,
  creditIdr: number,
): Idr {
  return toIdr(
    normalBalanceOf(account.type) === "debit"
      ? BigInt(debitIdr) - BigInt(creditIdr)
      : BigInt(creditIdr) - BigInt(debitIdr),
  );
}

type Filter = {
  from?: string;
  /** Exclusive upper bound, for opening balances (entries before `from`). */
  before?: string;
  to: string;
  outletId?: OutletId | null;
};

function totalsByAccount(lines: readonly LedgerLine[], filter: Filter) {
  const totals = new Map<string, { debit: bigint; credit: bigint }>();
  for (const line of lines) {
    if (line.entryDate > filter.to) continue;
    if (filter.from !== undefined && line.entryDate < filter.from) continue;
    if (filter.before !== undefined && line.entryDate >= filter.before)
      continue;
    if (filter.outletId !== undefined && line.outletId !== filter.outletId)
      continue;
    const row = totals.get(line.accountId) ?? { debit: 0n, credit: 0n };
    row.debit += BigInt(line.debitIdr);
    row.credit += BigInt(line.creditIdr);
    totals.set(line.accountId, row);
  }
  return totals;
}

// ---- Trial balance ---------------------------------------------------------

export const trialBalanceRowSchema = z.strictObject({
  accountId: accountIdSchema,
  code: z.string(),
  name: z.string(),
  type: accountTypeSchema,
  debitIdr: idrSchema,
  creditIdr: idrSchema,
});
export const trialBalanceSchema = z
  .strictObject({
    legalEntityId: legalEntityIdSchema,
    asOf: businessDateSchema,
    ...statementBasisShape,
    rows: z.array(trialBalanceRowSchema),
    totalDebitIdr: idrSchema,
    totalCreditIdr: idrSchema,
  })
  .superRefine((tb, ctx) => {
    refineStatementBasis(tb, { from: tb.asOf, to: tb.asOf }, ctx);
    if (tb.totalDebitIdr !== tb.totalCreditIdr)
      ctx.addIssue({ code: "custom", message: "Trial balance must balance" });
    if (toIdr(sumBig(tb.rows.map((row) => row.debitIdr))) !== tb.totalDebitIdr)
      ctx.addIssue({ code: "custom", message: "Debit rows must add up" });
    if (
      toIdr(sumBig(tb.rows.map((row) => row.creditIdr))) !== tb.totalCreditIdr
    )
      ctx.addIssue({ code: "custom", message: "Credit rows must add up" });
  });
export type TrialBalance = z.infer<typeof trialBalanceSchema>;

/** Cumulative trial balance at `asOf`: each account's net on its debit or credit side. */
export function buildTrialBalance(
  accounts: readonly Account[],
  lines: readonly LedgerLine[],
  legalEntityId: string,
  asOf: string,
  periods: PeriodRows = [],
): TrialBalance {
  const totals = totalsByAccount(lines, { to: asOf });
  const rows = accounts
    .filter((account) => account.legalEntityId === legalEntityId)
    .flatMap((account) => {
      const row = totals.get(account.id);
      if (!row || row.debit === row.credit) return [];
      const net = row.debit - row.credit;
      return [
        {
          accountId: account.id,
          code: account.code,
          name: account.name,
          type: account.type,
          debitIdr: toIdr(net > 0n ? net : 0n),
          creditIdr: toIdr(net < 0n ? -net : 0n),
        },
      ];
    })
    .sort((a, b) => a.code.localeCompare(b.code));
  return trialBalanceSchema.parse({
    legalEntityId,
    asOf,
    ...statementBasisFields(periods, {
      from: asOf,
      to: asOf,
      cumulative: true,
    }),
    rows,
    totalDebitIdr: toIdr(sumBig(rows.map((row) => row.debitIdr))),
    totalCreditIdr: toIdr(sumBig(rows.map((row) => row.creditIdr))),
  });
}

// ---- Statement sections ----------------------------------------------------

export const statementRowSchema = z.strictObject({
  accountId: accountIdSchema,
  code: z.string(),
  name: z.string(),
  amountIdr: idrSchema,
});
export type StatementRow = z.infer<typeof statementRowSchema>;

export const statementSectionSchema = z
  .strictObject({
    group: reportGroupSchema,
    rows: z.array(statementRowSchema),
    totalIdr: idrSchema,
  })
  .superRefine((section, ctx) => {
    if (
      toIdr(sumBig(section.rows.map((row) => row.amountIdr))) !==
      section.totalIdr
    )
      ctx.addIssue({ code: "custom", message: "Section rows must add up" });
  });
export type StatementSection = z.infer<typeof statementSectionSchema>;

function sectionsFor(
  groups: readonly ReportGroup[],
  accounts: readonly Account[],
  totals: Map<string, { debit: bigint; credit: bigint }>,
): StatementSection[] {
  return groups.map((group) => {
    const rows = accounts
      .filter((account) => account.reportGroup === group)
      .flatMap((account) => {
        const row = totals.get(account.id);
        if (!row) return [];
        const amountIdr = naturalBalance(
          account,
          toIdr(row.debit),
          toIdr(row.credit),
        );
        return amountIdr === 0
          ? []
          : [
              {
                accountId: account.id,
                code: account.code,
                name: account.name,
                amountIdr,
              },
            ];
      })
      .sort((a, b) => a.code.localeCompare(b.code));
    return {
      group,
      rows,
      totalIdr: toIdr(sumBig(rows.map((row) => row.amountIdr))),
    };
  });
}

const sectionTotal = (
  sections: readonly StatementSection[],
  group: ReportGroup,
) => sections.find((section) => section.group === group)?.totalIdr ?? 0;

// ---- Profit and loss -------------------------------------------------------

const PL_GROUPS = [
  "revenue",
  "cogs",
  "operating_expense",
  "other_income",
  "other_expense",
] as const;

export const profitAndLossSchema = z
  .strictObject({
    legalEntityId: legalEntityIdSchema,
    /** null = whole legal entity; an id = P&L per outlet (lines tagged with that outlet). */
    outletId: outletIdSchema.nullable(),
    from: businessDateSchema,
    to: businessDateSchema,
    ...statementBasisShape,
    sections: z.array(statementSectionSchema),
    grossProfitIdr: idrSchema,
    operatingProfitIdr: idrSchema,
    netProfitIdr: idrSchema,
  })
  .superRefine((pl, ctx) => {
    refineStatementBasis(pl, pl, ctx);
    const total = (group: ReportGroup) => sectionTotal(pl.sections, group);
    const gross = total("revenue") - total("cogs");
    const operating = gross - total("operating_expense");
    const net = operating + total("other_income") - total("other_expense");
    if (
      pl.grossProfitIdr !== gross ||
      pl.operatingProfitIdr !== operating ||
      pl.netProfitIdr !== net
    )
      ctx.addIssue({
        code: "custom",
        message: "Profit lines must follow the sections",
      });
    if (pl.to < pl.from)
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: "to must not be before from",
      });
  });
export type ProfitAndLoss = z.infer<typeof profitAndLossSchema>;

/** P&L for [from, to]; pass an outletId for the per-outlet P&L (ACC-03). */
export function buildProfitAndLoss(
  accounts: readonly Account[],
  lines: readonly LedgerLine[],
  input: {
    legalEntityId: string;
    from: string;
    to: string;
    outletId?: OutletId | null;
    periods?: PeriodRows;
  },
): ProfitAndLoss {
  const scoped = accounts.filter(
    (account) => account.legalEntityId === input.legalEntityId,
  );
  const totals = totalsByAccount(lines, {
    from: input.from,
    to: input.to,
    ...(input.outletId ? { outletId: input.outletId } : {}),
  });
  const sections = sectionsFor(PL_GROUPS, scoped, totals);
  const total = (group: ReportGroup) => sectionTotal(sections, group);
  const gross = total("revenue") - total("cogs");
  const operating = gross - total("operating_expense");
  return profitAndLossSchema.parse({
    legalEntityId: input.legalEntityId,
    outletId: input.outletId ?? null,
    from: input.from,
    to: input.to,
    ...statementBasisFields(input.periods ?? [], input),
    sections,
    grossProfitIdr: gross,
    operatingProfitIdr: operating,
    netProfitIdr: operating + total("other_income") - total("other_expense"),
  });
}

// ---- Balance sheet ---------------------------------------------------------

const BS_GROUPS = [
  "cash_and_equivalents",
  "current_asset",
  "non_current_asset",
  "current_liability",
  "non_current_liability",
  "equity",
] as const;

export const balanceSheetSchema = z
  .strictObject({
    legalEntityId: legalEntityIdSchema,
    asOf: businessDateSchema,
    ...statementBasisShape,
    sections: z.array(statementSectionSchema),
    /** Revenue − expenses not yet closed to retained earnings, shown under equity. */
    currentEarningsIdr: idrSchema,
    totalAssetsIdr: idrSchema,
    totalLiabilitiesIdr: idrSchema,
    totalEquityIdr: idrSchema,
  })
  .superRefine((bs, ctx) => {
    refineStatementBasis(bs, { from: bs.asOf, to: bs.asOf }, ctx);
    const total = (group: ReportGroup) => sectionTotal(bs.sections, group);
    const assets =
      total("cash_and_equivalents") +
      total("current_asset") +
      total("non_current_asset");
    const liabilities =
      total("current_liability") + total("non_current_liability");
    const equity = total("equity") + bs.currentEarningsIdr;
    if (
      bs.totalAssetsIdr !== assets ||
      bs.totalLiabilitiesIdr !== liabilities ||
      bs.totalEquityIdr !== equity
    )
      ctx.addIssue({
        code: "custom",
        message: "Totals must follow the sections",
      });
    if (assets !== liabilities + equity)
      ctx.addIssue({
        code: "custom",
        message: "Assets must equal liabilities + equity",
      });
  });
export type BalanceSheet = z.infer<typeof balanceSheetSchema>;

/** Balance sheet at `asOf` from all lines up to that date. */
export function buildBalanceSheet(
  accounts: readonly Account[],
  lines: readonly LedgerLine[],
  input: { legalEntityId: string; asOf: string; periods?: PeriodRows },
): BalanceSheet {
  const scoped = accounts.filter(
    (account) => account.legalEntityId === input.legalEntityId,
  );
  const totals = totalsByAccount(lines, { to: input.asOf });
  const sections = sectionsFor(BS_GROUPS, scoped, totals);
  const pl = sectionsFor(PL_GROUPS, scoped, totals);
  const plTotal = (group: ReportGroup) => sectionTotal(pl, group);
  const currentEarnings =
    plTotal("revenue") +
    plTotal("other_income") -
    plTotal("cogs") -
    plTotal("operating_expense") -
    plTotal("other_expense");
  const total = (group: ReportGroup) => sectionTotal(sections, group);
  return balanceSheetSchema.parse({
    legalEntityId: input.legalEntityId,
    asOf: input.asOf,
    ...statementBasisFields(input.periods ?? [], {
      from: input.asOf,
      to: input.asOf,
      cumulative: true,
    }),
    sections,
    currentEarningsIdr: currentEarnings,
    totalAssetsIdr:
      total("cash_and_equivalents") +
      total("current_asset") +
      total("non_current_asset"),
    totalLiabilitiesIdr:
      total("current_liability") + total("non_current_liability"),
    totalEquityIdr: total("equity") + currentEarnings,
  });
}

// ---- Cash flow and equity changes (schemas; BE builds them) ---------------

export const cashFlowActivitySchema = z.enum([
  "operating",
  "investing",
  "financing",
]);

export const cashFlowStatementSchema = z
  .strictObject({
    legalEntityId: legalEntityIdSchema,
    from: businessDateSchema,
    to: businessDateSchema,
    method: z.literal("direct"),
    ...statementBasisShape,
    sections: z.array(
      z.strictObject({
        activity: cashFlowActivitySchema,
        rows: z.array(
          z.strictObject({
            label: z.string().min(1).max(150),
            amountIdr: idrSchema,
          }),
        ),
        totalIdr: idrSchema,
      }),
    ),
    openingCashIdr: idrSchema,
    netChangeIdr: idrSchema,
    closingCashIdr: idrSchema,
  })
  .superRefine((cf, ctx) => {
    refineStatementBasis(cf, cf, ctx);
    for (const section of cf.sections)
      if (
        toIdr(sumBig(section.rows.map((row) => row.amountIdr))) !==
        section.totalIdr
      )
        ctx.addIssue({ code: "custom", message: "Activity rows must add up" });
    if (toIdr(sumBig(cf.sections.map((s) => s.totalIdr))) !== cf.netChangeIdr)
      ctx.addIssue({
        code: "custom",
        message: "Net change = sum of activities",
      });
    if (cf.openingCashIdr + cf.netChangeIdr !== cf.closingCashIdr)
      ctx.addIssue({
        code: "custom",
        message: "Opening + net change = closing",
      });
  });
export type CashFlowStatement = z.infer<typeof cashFlowStatementSchema>;

export const equityChangesSchema = z
  .strictObject({
    legalEntityId: legalEntityIdSchema,
    from: businessDateSchema,
    to: businessDateSchema,
    ...statementBasisShape,
    rows: z.array(
      z.strictObject({
        accountId: accountIdSchema.nullable(),
        /** Account name, or "Laba periode berjalan" for current earnings (accountId null). */
        label: z.string().min(1).max(150),
        openingIdr: idrSchema,
        profitIdr: idrSchema,
        distributionsIdr: idrSchema,
        otherMovementsIdr: idrSchema,
        closingIdr: idrSchema,
      }),
    ),
  })
  .superRefine((eq, ctx) => {
    refineStatementBasis(eq, eq, ctx);
    for (const row of eq.rows)
      if (
        row.openingIdr +
          row.profitIdr -
          row.distributionsIdr +
          row.otherMovementsIdr !==
        row.closingIdr
      )
        ctx.addIssue({
          code: "custom",
          message: `Equity row ${row.label} does not roll forward`,
        });
  });
export type EquityChanges = z.infer<typeof equityChangesSchema>;

/** A ledger line that also says which entry and source document it belongs to. */
export type EntryLedgerLine = LedgerLine & {
  entryId: string;
  sourceType: string;
};

const CASH_FLOW_ACTIVITIES = ["operating", "investing", "financing"] as const;

/** Where the other side of a cash movement lands: its report group decides. */
function cashFlowActivityOf(
  group: ReportGroup,
): z.infer<typeof cashFlowActivitySchema> {
  if (group === "non_current_asset") return "investing";
  if (group === "equity" || group === "non_current_liability")
    return "financing";
  return "operating";
}

/**
 * Direct-method cash flow for [from, to]. Cash is every account in the
 * `cash_and_equivalents` group. Each entry that moves cash is split by its
 * non-cash lines (credit minus debit is the cash they bring in), so the
 * sections add up to the change in the cash accounts exactly; entries that only
 * move cash between cash accounts have no non-cash lines and add nothing.
 */
export function buildCashFlow(
  accounts: readonly Account[],
  lines: readonly EntryLedgerLine[],
  input: {
    legalEntityId: string;
    from: string;
    to: string;
    periods?: PeriodRows;
  },
): CashFlowStatement {
  const scoped = new Map(
    accounts
      .filter((account) => account.legalEntityId === input.legalEntityId)
      .map((account) => [account.id, account]),
  );
  const isCash = (accountId: string) =>
    scoped.get(accountId)?.reportGroup === "cash_and_equivalents";
  let opening = 0n;
  const cashEntries = new Set<string>();
  for (const line of lines) {
    if (!isCash(line.accountId) || line.entryDate > input.to) continue;
    const net = BigInt(line.debitIdr) - BigInt(line.creditIdr);
    if (line.entryDate < input.from) opening += net;
    else cashEntries.add(line.entryId);
  }
  const rowsByActivity = new Map<string, Map<string, bigint>>();
  for (const line of lines) {
    const account = scoped.get(line.accountId);
    if (!account || isCash(line.accountId)) continue;
    if (line.entryDate < input.from || line.entryDate > input.to) continue;
    if (!cashEntries.has(line.entryId)) continue;
    const activity = cashFlowActivityOf(account.reportGroup);
    const rows = rowsByActivity.get(activity) ?? new Map<string, bigint>();
    rows.set(
      account.id,
      (rows.get(account.id) ?? 0n) +
        BigInt(line.creditIdr) -
        BigInt(line.debitIdr),
    );
    rowsByActivity.set(activity, rows);
  }
  const sections = CASH_FLOW_ACTIVITIES.map((activity) => {
    const rows = [...(rowsByActivity.get(activity) ?? [])]
      .filter(([, amount]) => amount !== 0n)
      .map(([accountId, amount]) => ({
        code: scoped.get(accountId)!.code,
        label: scoped.get(accountId)!.name,
        amountIdr: toIdr(amount),
      }))
      .sort((a, b) => a.code.localeCompare(b.code))
      .map(({ label, amountIdr }) => ({ label, amountIdr }));
    return {
      activity,
      rows,
      totalIdr: toIdr(sumBig(rows.map((row) => row.amountIdr))),
    };
  });
  const netChange = sumBig(sections.map((section) => section.totalIdr));
  return cashFlowStatementSchema.parse({
    legalEntityId: input.legalEntityId,
    from: input.from,
    to: input.to,
    method: "direct",
    ...statementBasisFields(input.periods ?? [], {
      from: input.from,
      to: input.to,
      cumulative: true,
    }),
    sections,
    openingCashIdr: toIdr(opening),
    netChangeIdr: toIdr(netChange),
    closingCashIdr: toIdr(opening + netChange),
  });
}

/**
 * Equity changes for [from, to]: one row per equity account that has a balance
 * or a movement, plus "Laba periode berjalan" (accountId null) for the profit
 * not yet closed to retained earnings. Distributions are debits to an equity
 * account from a dividend entry; every other movement is `otherMovementsIdr`.
 * The closing balances of all rows add up to the balance sheet's total equity.
 */
export function buildEquityChanges(
  accounts: readonly Account[],
  lines: readonly EntryLedgerLine[],
  input: {
    legalEntityId: string;
    from: string;
    to: string;
    periods?: PeriodRows;
  },
): EquityChanges {
  const scoped = accounts.filter(
    (account) => account.legalEntityId === input.legalEntityId,
  );
  const opening = totalsByAccount(lines, {
    to: input.to,
    before: input.from,
  });
  const closing = totalsByAccount(lines, { to: input.to });
  const during = totalsByAccount(lines, { from: input.from, to: input.to });
  const dividends = totalsByAccount(
    lines.filter((line) => line.sourceType === "dividend"),
    { from: input.from, to: input.to },
  );
  const profitOf = (totals: ReturnType<typeof totalsByAccount>) => {
    const pl = sectionsFor(PL_GROUPS, scoped, totals);
    const total = (group: ReportGroup) => sectionTotal(pl, group);
    return (
      total("revenue") +
      total("other_income") -
      total("cogs") -
      total("operating_expense") -
      total("other_expense")
    );
  };
  const balanceOf = (
    account: Account,
    totals: ReturnType<typeof totalsByAccount>,
  ) => {
    const row = totals.get(account.id);
    return naturalBalance(
      account,
      toIdr(row?.debit ?? 0n),
      toIdr(row?.credit ?? 0n),
    );
  };
  const rows = [...scoped]
    .sort((a, b) => a.code.localeCompare(b.code))
    .filter((account) => account.reportGroup === "equity")
    .flatMap((account) => {
      const openingIdr = balanceOf(account, opening);
      const closingIdr = balanceOf(account, closing);
      const paid = dividends.get(account.id);
      const distributionsIdr = toIdr(
        (paid?.debit ?? 0n) - (paid?.credit ?? 0n),
      );
      const moved = during.get(account.id);
      if (
        openingIdr === 0 &&
        closingIdr === 0 &&
        distributionsIdr === 0 &&
        !moved
      )
        return [];
      return [
        {
          accountId: account.id,
          label: account.name,
          openingIdr,
          profitIdr: 0,
          distributionsIdr,
          otherMovementsIdr: toIdr(
            BigInt(closingIdr) - BigInt(openingIdr) + BigInt(distributionsIdr),
          ),
          closingIdr,
        },
      ];
    });
  const openingEarnings = profitOf(opening);
  const profit = profitOf(during);
  const closingEarnings = profitOf(closing);
  return equityChangesSchema.parse({
    legalEntityId: input.legalEntityId,
    from: input.from,
    to: input.to,
    ...statementBasisFields(input.periods ?? [], {
      from: input.from,
      to: input.to,
      cumulative: true,
    }),
    rows: [
      ...rows,
      {
        accountId: null,
        label: "Laba periode berjalan",
        openingIdr: openingEarnings,
        profitIdr: profit,
        distributionsIdr: 0,
        otherMovementsIdr: closingEarnings - openingEarnings - profit,
        closingIdr: closingEarnings,
      },
    ],
  });
}

/** Multi-entity view: one P&L per legal entity plus a plain sum (no intercompany elimination in v1). */
export const multiEntityProfitAndLossSchema = z
  .strictObject({
    from: businessDateSchema,
    to: businessDateSchema,
    /** closed_snapshot only when every entity's figures are. */
    basis: statementBasisShape.basis,
    periodKeys: statementBasisShape.periodKeys,
    entities: z.array(profitAndLossSchema).min(1),
    combinedNetProfitIdr: idrSchema,
  })
  .superRefine((report, ctx) => {
    const allClosed = report.entities.every(
      (entity) => entity.basis === "closed_snapshot",
    );
    if (allClosed !== (report.basis === "closed_snapshot"))
      ctx.addIssue({
        code: "custom",
        path: ["basis"],
        message: "Combined basis is closed_snapshot only if every entity is",
      });
    // Only the months are checked here; the closed subset lives per entity.
    refineStatementBasis(
      { basis: "live", periodKeys: report.periodKeys, closedPeriodKeys: [] },
      report,
      ctx,
    );
    if (
      toIdr(sumBig(report.entities.map((pl) => pl.netProfitIdr))) !==
      report.combinedNetProfitIdr
    )
      ctx.addIssue({
        code: "custom",
        message: "Combined profit = sum of entities",
      });
  });

// ---- Drill-down (ACC-03) ---------------------------------------------------

export const statementQuerySchema = z.strictObject({
  legalEntityId: legalEntityIdSchema,
  from: businessDateSchema,
  to: businessDateSchema,
  outletId: outletIdSchema.optional(),
});

export const drillDownQuerySchema = cursorPageQuerySchema.extend({
  legalEntityId: legalEntityIdSchema,
  accountId: accountIdSchema,
  from: businessDateSchema,
  to: businessDateSchema,
  outletId: outletIdSchema.optional(),
});

/** One journal line behind a statement row, with the way back to its source. */
export const drillDownLineSchema = z.strictObject({
  journalEntryId: journalEntryIdSchema,
  journalLineId: journalLineIdSchema,
  entryDate: businessDateSchema,
  description: z.string(),
  outletId: outletIdSchema.nullable(),
  debitIdr: idrSchema,
  creditIdr: idrSchema,
  sourceType: journalSourceTypeSchema,
  sourceId: journalSourceIdSchema.nullable(),
  postedAt: isoDateTimeSchema,
});
export type DrillDownLine = z.infer<typeof drillDownLineSchema>;
