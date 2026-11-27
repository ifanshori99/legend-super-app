// Cafe Legend accounting mock data (FE mock mode + contract tests). PRD facts:
// tenant Cafe Legend, legal entity PT Sultan Solusi Nusantara, PBJT 10%.
// Everything else is illustrative sample data: the real chart, opening
// balances, bank accounts and PKP status come from the owner (PRD A14), so the
// entity is shown as non-PKP here and no PPN report exists. Suppliers and
// customers are fictional. Journals are built through the posting rules, so
// the fixtures exercise the same code the BE runs and always balance.

import { cafeLegendFixtures, idr } from "../core/index.ts";
import type { Idr, OutletId, UserId } from "../core/index.ts";
import { cafeLegendAccessFixtures } from "../access/fixtures.ts";
import {
  straightLineSchedule,
  fixedAssetDerivedFields,
  fixedAssetSchema,
  depreciationRunSchema,
} from "./assets.ts";
import {
  bankAccountSchema,
  bankStatementImportSchema,
  bankStatementLineSchema,
  cashDepositSchema,
  reconciliationCaseSchema,
  statementLineDedupeKey,
} from "./banking.ts";
import type { CashCollection } from "./banking.ts";
import { budgetSchema } from "./budgets.ts";
import {
  accountMapFor,
  accountMappingSchema,
  accountSchema,
  standardFnbChartTemplate,
} from "./coa.ts";
import type { Account, AccountMapping } from "./coa.ts";
import {
  buildReversalLines,
  journalEntrySchema,
  manualJournalSchema,
  recurringJournalSchema,
} from "./journal.ts";
import type {
  JournalEntry,
  JournalLineInput,
  JournalSourceType,
} from "./journal.ts";
import { openItemSchema } from "./payables.ts";
import { payrollJournalAmounts } from "./payroll-journal.ts";
import {
  fiscalPeriodSchema,
  periodCloseSnapshotSchema,
  periodReopenRequestSchema,
} from "./period.ts";
import {
  buildJournalLinesFromRule,
  defaultPostingRules,
  resolvePostingRule,
} from "./posting-rules.ts";
import {
  attachDistributionStatement,
  buildDistributionStatement,
  buildMyProfitShare,
  buildProfitShareEstimate,
  calculateAdjustmentDistribution,
  calculateDistribution,
  distributionRunSchema,
  profitEntitySchema,
  shareAllocationVersionSchema,
  shareholderDocumentSchema,
  shareholderSchema,
  transitionDistributionRun,
} from "./profit-share.ts";
import type {
  AdjustmentCalculation,
  DistributionCalculation,
  DistributionRun,
} from "./profit-share.ts";
import { statementBasisFields } from "./statement-basis.ts";
import {
  buildBalanceSheet,
  buildProfitAndLoss,
  buildTrialBalance,
  cashFlowStatementSchema,
  equityChangesSchema,
} from "./statements.ts";
import type { LedgerLine } from "./statements.ts";
import { taxReportSchema } from "./tax.ts";

function fixedId(prefix: string, n: number): string {
  return `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const { tenant, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
const bandung = outlets[0].id;
const people = cafeLegendAccessFixtures.users;
const finance = people.finance.id;
const owner = people.owner.id;
const generalManager = people.generalManager.id;
const outletManager = people.outletManager.id;

const legalEntity = {
  id: "5e1a7c30-4b2d-4e8f-9a61-3c7d2b8e0f14",
  tenantId,
  name: cafeLegendFixtures.legalEntityName,
  /** Illustrative until the owner confirms PKP status (PRD A14). */
  isPkp: false,
} as const;
const legalEntityId = legalEntity.id as Account["legalEntityId"];

// ---- Chart of accounts + mappings (from the standard template) ------------

const idByCode = new Map(
  standardFnbChartTemplate.map((row, index) => [
    row.code,
    fixedId("ac000000", index + 1),
  ]),
);
const accounts: Account[] = standardFnbChartTemplate.map((row) =>
  accountSchema.parse({
    id: idByCode.get(row.code),
    tenantId,
    legalEntityId,
    code: row.code,
    name: row.name,
    type: row.type,
    reportGroup: row.reportGroup,
    parentId: row.parentCode === null ? null : idByCode.get(row.parentCode),
    isActive: true,
  }),
);
const acc = (code: string) => {
  const id = idByCode.get(code);
  if (!id) throw new RangeError(`No fixture account ${code}`);
  return id as Account["id"];
};
const accountMappings: AccountMapping[] = standardFnbChartTemplate.flatMap(
  (row) =>
    row.roles.map((role) =>
      accountMappingSchema.parse({
        tenantId,
        legalEntityId,
        role,
        accountId: acc(row.code),
      }),
    ),
);
const accountMap = accountMapFor(accountMappings, legalEntityId);

// ---- Fiscal periods ----------------------------------------------------------

const periodRow = (n: number, period: string, extra: Record<string, unknown>) =>
  fiscalPeriodSchema.parse({
    id: fixedId("f1000000", n),
    tenantId,
    legalEntityId,
    period,
    status: "open",
    version: 1,
    closedBy: null,
    closedAt: null,
    reopenedReason: null,
    reopenedBy: null,
    reopenedAt: null,
    ...extra,
  });
const fiscalPeriods = [
  periodRow(1, "2026-09", {
    status: "closed",
    version: 2,
    closedBy: finance,
    closedAt: "2026-10-03T09:00:00.000Z",
  }),
  // Closed, reopened once with approval (missed electricity bill), closed again.
  periodRow(2, "2026-10", {
    status: "closed",
    version: 4,
    closedBy: finance,
    closedAt: "2026-11-04T10:30:00.000Z",
    reopenedReason: "Tagihan listrik Oktober belum dicatat.",
    reopenedBy: owner,
    reopenedAt: "2026-11-04T08:15:00.000Z",
  }),
  periodRow(3, "2026-11", {}),
];
const periodId = (period: string) =>
  fiscalPeriods.find((row) => row.period === period)!.id;

const periodReopenRequests = [
  periodReopenRequestSchema.parse({
    id: fixedId("f2000000", 1),
    tenantId,
    legalEntityId,
    fiscalPeriodId: periodId("2026-10"),
    period: "2026-10",
    reason: "Tagihan listrik Oktober belum dicatat.",
    status: "approved",
    requestedBy: finance,
    requestedAt: "2026-11-04T07:50:00.000Z",
    decidedBy: owner,
    decidedAt: "2026-11-04T08:15:00.000Z",
    decisionNote: null,
  }),
];

// ---- Journals ----------------------------------------------------------------

let journalCount = 0;
let lineCount = 0;
const journals: JournalEntry[] = [];

function post(input: {
  entryDate: string;
  sourceType: JournalSourceType;
  sourceId: string | null;
  description: string;
  lines: JournalLineInput[];
  outletId?: OutletId | null;
  postedBy?: string | null;
  reversalOf?: string | null;
}): JournalEntry {
  journalCount += 1;
  const entry = journalEntrySchema.parse({
    id: fixedId("e1000000", journalCount),
    tenantId,
    legalEntityId,
    outletId: input.outletId ?? null,
    entryDate: input.entryDate,
    fiscalPeriodId: periodId(input.entryDate.slice(0, 7)),
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    description: input.description,
    reversalOf: input.reversalOf ?? null,
    postedBy: input.postedBy ?? null,
    postedAt: `${input.entryDate}T15:00:00.000Z`,
    lines: input.lines.map((line) => {
      lineCount += 1;
      return { id: fixedId("e2000000", lineCount), ...line };
    }),
  });
  journals.push(entry);
  return entry;
}

const fromRule = (
  trigger: Parameters<typeof resolvePostingRule>[1],
  amounts: Record<string, number>,
  outletId: OutletId | null,
) =>
  buildJournalLinesFromRule(
    resolvePostingRule(defaultPostingRules, trigger),
    amounts,
    accountMap,
    { outletId },
  );

const manual = (
  rows: [code: string, debit: number, credit: number][],
  outletId: OutletId | null,
) =>
  rows.map(([code, debit, credit]) => ({
    accountId: acc(code),
    debitIdr: idr(debit),
    creditIdr: idr(credit),
    outletId,
    costCenter: null,
  }));

// Opening balances (illustrative until A14).
post({
  entryDate: "2026-09-01",
  sourceType: "opening_balance",
  sourceId: null,
  description: "Saldo awal pembukuan",
  postedBy: finance,
  lines: manual(
    [
      ["1103", 250_000_000, 0],
      ["1101", 2_000_000, 0],
      ["1501", 114_000_000, 0],
      ["3101", 0, 366_000_000],
    ],
    null,
  ),
});

// October payroll (PAYR-04): gross + employer BPJS = net + BPJS + PPh 21.
post({
  entryDate: "2026-10-31",
  sourceType: "payroll",
  sourceId: fixedId("9a000000", 1),
  description: "Payroll Oktober 2026",
  lines: fromRule(
    { eventName: "payroll.locked" },
    payrollJournalAmounts({
      employeeCount: 3,
      grossIdr: idr(42_000_000),
      deductionsIdr: idr(1_470_000),
      netIdr: idr(40_530_000),
      bpjsEmployeeIdr: idr(840_000),
      bpjsCompanyIdr: idr(2_184_000),
      pph21Idr: idr(630_000),
      pph21WithheldIdr: idr(630_000),
      pph21EmployerBorneIdr: idr(0),
      pph21RefundIdr: idr(0),
      pph21EmployerRefundIdr: idr(0),
      pph21EmployerAllowanceRefundIdr: idr(0),
      loanRepaymentIdr: idr(0),
      pph21ReceivableIdr: idr(0),
      pph21ReceivableCollectedIdr: idr(0),
      otherDeductionsIdr: idr(0),
      serviceChargeIdr: idr(0),
      reimbursementIdr: idr(0),
      bankTransferIdr: idr(40_530_000),
      cashIdr: idr(0),
    }),
    null,
  ),
});
post({
  entryDate: "2026-10-31",
  sourceType: "depreciation",
  sourceId: fixedId("fd000000", 1),
  description: "Penyusutan Oktober 2026",
  lines: fromRule(
    { sourceType: "depreciation" },
    { amountIdr: 1_875_000 },
    null,
  ),
});
// Posted during the approved reopen of October.
const electricityOctober = post({
  entryDate: "2026-10-31",
  sourceType: "manual",
  sourceId: fixedId("e3000000", 1),
  description: "Tagihan listrik PLN Oktober 2026",
  outletId: bandung,
  postedBy: owner,
  lines: manual(
    [
      ["6106", 2_350_000, 0],
      ["1103", 0, 2_350_000],
    ],
    bandung,
  ),
});

// November: one cash sale (the core fixture order: Rp125.000 + PBJT 10%).
const cashSale = post({
  entryDate: "2026-11-01",
  sourceType: "sale",
  sourceId: cafeLegendFixtures.orderId,
  description: "Penjualan order BDG-01",
  outletId: bandung,
  lines: fromRule(
    { eventName: "order.paid" },
    {
      paidCashIdr: 137_500,
      paidGatewayIntentIdr: 0,
      paidDepositIdr: 0,
      paidGatewayIdr: 0,
      paidEdcIdr: 0,
      paidPointsIdr: 0,
      discountIdr: 0,
      grossSalesIdr: 125_000,
      serviceChargeIdr: 0,
      pbjtIdr: 12_500,
      roundingIdr: 0,
    },
    bandung,
  ),
});
post({
  entryDate: "2026-11-01",
  sourceType: "cogs",
  sourceId: fixedId("57000000", 1),
  description: "HPP order BDG-01",
  outletId: bandung,
  lines: fromRule(
    { eventName: "stock.deducted" },
    { costIdr: 41_250 },
    bandung,
  ),
});
// QRIS sale through the gateway: the receipt books first (payment.paid), the
// sale then moves it out of customer_deposit, and settlement with MDR
// (illustrative 0.7%) clears gateway_clearing.
post({
  entryDate: "2026-11-01",
  sourceType: "customer_deposit",
  sourceId: fixedId("9b000000", 1),
  description: "Penerimaan QRIS BDG-01",
  outletId: bandung,
  lines: fromRule(
    { eventName: "payment.paid" },
    { receivedIdr: 275_000, depositIdr: 275_000, guestFeeIdr: 0 },
    bandung,
  ),
});
post({
  entryDate: "2026-11-01",
  sourceType: "sale",
  sourceId: "01JBQ9A2B3C4D5E6F7G8H9J0KM",
  description: "Penjualan QRIS BDG-01",
  outletId: bandung,
  lines: fromRule(
    { eventName: "order.paid" },
    {
      paidCashIdr: 0,
      paidGatewayIntentIdr: 275_000,
      paidDepositIdr: 0,
      paidGatewayIdr: 0,
      paidEdcIdr: 0,
      paidPointsIdr: 0,
      discountIdr: 0,
      grossSalesIdr: 250_000,
      serviceChargeIdr: 0,
      pbjtIdr: 25_000,
      roundingIdr: 0,
    },
    bandung,
  ),
});
const gatewaySettlement = post({
  entryDate: "2026-11-02",
  sourceType: "gateway_settlement",
  sourceId: fixedId("5e000000", 1),
  description: "Settlement DOIT 1 November 2026",
  outletId: bandung,
  lines: fromRule(
    { eventName: "settlement.reconciled" },
    { netSettledIdr: 273_075, feeIdr: 1_925, grossIdr: 275_000 },
    bandung,
  ),
});
const cashDepositEntry = post({
  entryDate: "2026-11-02",
  sourceType: "cash_deposit",
  sourceId: fixedId("cd000000", 1),
  description: "Setoran kas BDG-01 untuk 1 November 2026",
  outletId: bandung,
  lines: fromRule(
    { sourceType: "cash_deposit" },
    { amountIdr: 137_500 },
    bandung,
  ),
});
// ACC-01 correction: a wrong internet bill, its reversal, and the right one.
const wrongInternet = post({
  entryDate: "2026-11-03",
  sourceType: "manual",
  sourceId: fixedId("e3000000", 2),
  description: "Tagihan internet November 2026",
  outletId: bandung,
  postedBy: owner,
  lines: manual(
    [
      ["6106", 1_250_000, 0],
      ["1103", 0, 1_250_000],
    ],
    bandung,
  ),
});
post({
  entryDate: "2026-11-03",
  sourceType: "reversal",
  sourceId: wrongInternet.id,
  reversalOf: wrongInternet.id,
  description: "Pembalik: nominal salah ketik",
  outletId: bandung,
  postedBy: finance,
  lines: buildReversalLines(wrongInternet, null),
});
const internet = post({
  entryDate: "2026-11-03",
  sourceType: "manual",
  sourceId: fixedId("e3000000", 3),
  description: "Tagihan internet November 2026 (koreksi)",
  outletId: bandung,
  postedBy: owner,
  lines: manual(
    [
      ["6106", 1_520_000, 0],
      ["1103", 0, 1_520_000],
    ],
    bandung,
  ),
});

const ledgerLines: LedgerLine[] = journals.flatMap((entry) =>
  entry.lines.map((line) => ({
    accountId: line.accountId,
    debitIdr: line.debitIdr,
    creditIdr: line.creditIdr,
    outletId: line.outletId,
    entryDate: entry.entryDate,
  })),
);

// ---- Manual + recurring journals ----------------------------------------------

const manualJournals = [
  manualJournalSchema.parse({
    id: fixedId("e3000000", 3),
    tenantId,
    legalEntityId,
    outletId: bandung,
    entryDate: "2026-11-03",
    kind: "general",
    description: "Tagihan internet November 2026 (koreksi)",
    lines: manual(
      [
        ["6106", 1_520_000, 0],
        ["1103", 0, 1_520_000],
      ],
      bandung,
    ),
    status: "posted",
    requestedBy: finance,
    createdAt: "2026-11-03T03:00:00.000Z",
    submittedAt: "2026-11-03T03:05:00.000Z",
    decidedBy: owner,
    decidedAt: "2026-11-03T04:00:00.000Z",
    rejectionReason: null,
    postedEntryId: internet.id,
    recurringJournalId: null,
  }),
  manualJournalSchema.parse({
    id: fixedId("e3000000", 4),
    tenantId,
    legalEntityId,
    outletId: bandung,
    entryDate: "2026-11-30",
    kind: "adjustment",
    description: "Akrual sewa gedung November 2026",
    lines: manual(
      [
        ["6105", 15_000_000, 0],
        ["2101", 0, 15_000_000],
      ],
      bandung,
    ),
    status: "pending_approval",
    requestedBy: finance,
    createdAt: "2026-11-05T02:00:00.000Z",
    submittedAt: "2026-11-05T02:10:00.000Z",
    decidedBy: null,
    decidedAt: null,
    rejectionReason: null,
    postedEntryId: null,
    recurringJournalId: null,
  }),
  manualJournalSchema.parse({
    id: fixedId("e3000000", 5),
    tenantId,
    legalEntityId,
    outletId: null,
    entryDate: "2026-11-30",
    kind: "general",
    description: "Biaya pemasaran media sosial (draf)",
    lines: manual(
      [
        ["6109", 3_500_000, 0],
        ["1103", 0, 3_500_000],
      ],
      null,
    ),
    status: "draft",
    requestedBy: finance,
    createdAt: "2026-11-05T05:00:00.000Z",
    submittedAt: null,
    decidedBy: null,
    decidedAt: null,
    rejectionReason: null,
    postedEntryId: null,
    recurringJournalId: null,
  }),
];

const recurringJournals = [
  recurringJournalSchema.parse({
    id: fixedId("e4000000", 1),
    tenantId,
    legalEntityId,
    outletId: bandung,
    description: "Akrual sewa kios bulanan",
    lines: manual(
      [
        ["6105", 15_000_000, 0],
        ["2101", 0, 15_000_000],
      ],
      bandung,
    ),
    frequency: "monthly",
    dayOfMonth: 31,
    startPeriod: "2026-12",
    endPeriod: null,
    status: "active",
    requestedBy: finance,
    approvedBy: generalManager,
    approvedAt: "2026-11-05T06:00:00.000Z",
    lastGeneratedPeriod: null,
  }),
];

// ---- Bank, statement lines, deposits, cases -----------------------------------

const bankAccount = bankAccountSchema.parse({
  id: fixedId("ba000000", 1),
  tenantId,
  legalEntityId,
  bank: "BCA",
  accountName: "PT Sultan Solusi Nusantara",
  accountNumberMasked: "****4821",
  glAccountId: acc("1103"),
  isActive: true,
});
const statementImport = bankStatementImportSchema.parse({
  id: fixedId("b2000000", 1),
  tenantId,
  bankAccountId: bankAccount.id,
  fileName: "mutasi-bca-2026-11-01_04.csv",
  importedBy: finance,
  importedAt: "2026-11-05T01:00:00.000Z",
  lineCount: 4,
  duplicateCount: 0,
  autoMatchedCount: 2,
  postedFrom: "2026-11-02",
  postedTo: "2026-11-04",
});
const reconCaseId = fixedId("ca000000", 1);
const statementRows = [
  {
    postedOn: "2026-11-02",
    amountIdr: 273_075,
    description: "TRSF E-BANKING CR DOIT SETTLEMENT",
    externalRef: "DOIT-ST-20261101",
    match: {
      matchStatus: "auto_matched",
      matchedRefs: [
        { type: "gateway_settlement", id: gatewaySettlement.sourceId },
      ],
    },
  },
  {
    postedOn: "2026-11-02",
    amountIdr: 137_500,
    description: "SETORAN TUNAI BDG-01",
    externalRef: null,
    match: {
      matchStatus: "auto_matched",
      matchedRefs: [{ type: "cash_deposit", id: fixedId("cd000000", 1) }],
    },
  },
  {
    postedOn: "2026-11-04",
    amountIdr: -1_520_000,
    description: "BIAYA INTERNET NOVEMBER",
    externalRef: "INV-NET-1126",
    match: {
      matchStatus: "manually_matched",
      matchedRefs: [{ type: "journal_entry", id: internet.id }],
    },
  },
  {
    postedOn: "2026-11-04",
    amountIdr: -15_000,
    description: "BIAYA ADM",
    externalRef: null,
    match: {
      matchStatus: "in_case",
      matchedRefs: [],
      reconciliationCaseId: reconCaseId,
    },
  },
] as const;
const statementLines = statementRows.map((row, index) =>
  bankStatementLineSchema.parse({
    id: fixedId("b1000000", index + 1),
    tenantId,
    bankAccountId: bankAccount.id,
    importId: statementImport.id,
    postedOn: row.postedOn,
    amountIdr: row.amountIdr,
    description: row.description,
    externalRef: row.externalRef,
    dedupeKey: statementLineDedupeKey({ ...row, occurrence: 1 }),
    reconciliationCaseId: null,
    excludedReason: null,
    ...row.match,
  }),
);

const cashDeposits = [
  cashDepositSchema.parse({
    id: fixedId("cd000000", 1),
    tenantId,
    legalEntityId,
    outletId: bandung,
    bankAccountId: bankAccount.id,
    amountIdr: 137_500,
    coversFrom: "2026-11-01",
    coversTo: "2026-11-01",
    depositedAt: "2026-11-02T03:30:00.000Z",
    depositedBy: outletManager,
    slipReference: "SLIP-0211-01",
    bankStatementLineId: statementLines[1].id,
    reconciliationCaseId: null,
    journalEntryId: cashDepositEntry.id,
    status: "matched",
  }),
];
/** Daily cash collected per outlet (from cashier shift close), for ACC-05 alerts. */
const cashCollections: CashCollection[] = [
  { outletId: bandung, businessDate: "2026-11-01", cashIdr: idr(137_500) },
  { outletId: bandung, businessDate: "2026-11-02", cashIdr: idr(412_000) },
  { outletId: bandung, businessDate: "2026-11-03", cashIdr: idr(386_500) },
];

const reconciliationCases = [
  reconciliationCaseSchema.parse({
    id: reconCaseId,
    tenantId,
    legalEntityId,
    outletId: null,
    type: "bank_statement",
    differenceIdr: -15_000,
    ownerId: finance,
    status: "open",
    dueAt: "2026-11-09T10:00:00.000Z",
    refs: [{ type: "bank_statement_line", id: statementLines[3].id }],
    openedAt: "2026-11-05T01:00:00.000Z",
    resolvedBy: null,
    resolvedAt: null,
    resolutionNote: null,
    adjustmentJournalEntryId: null,
  }),
];

// ---- AP / AR --------------------------------------------------------------------

const openItems = [
  [
    "payable",
    "supplier",
    1,
    "CV Kopi Priangan (contoh)",
    "INV/KP/2026/0914",
    "2026-09-15",
    "2026-10-15",
    4_850_000,
    0,
  ],
  [
    "payable",
    "supplier",
    2,
    "UD Sayur Lembang (contoh)",
    "SL-1028",
    "2026-10-27",
    "2026-11-10",
    1_275_000,
    0,
  ],
  [
    "payable",
    "supplier",
    3,
    "PT Susu Segar Bandung (contoh)",
    "SSB/08/112",
    "2026-08-01",
    "2026-08-31",
    3_600_000,
    1_000_000,
  ],
  [
    "receivable",
    "event_customer",
    4,
    "Komunitas Lari Bandung (contoh)",
    "AR/2026/11/001",
    "2026-11-05",
    "2026-11-20",
    6_500_000,
    0,
  ],
] as const;
const payablesAndReceivables = openItems.map(
  ([
    kind,
    counterpartyType,
    n,
    name,
    documentNumber,
    documentDate,
    dueOn,
    original,
    settled,
  ]) =>
    openItemSchema.parse({
      id: fixedId("a9000000", n),
      tenantId,
      legalEntityId,
      outletId: bandung,
      kind,
      counterpartyType,
      counterpartyId: fixedId("c0000000", n),
      counterpartyName: name,
      documentNumber,
      documentDate,
      dueOn,
      originalIdr: original,
      settledIdr: settled,
      outstandingIdr: original - settled,
    }),
);

// ---- Fixed assets + depreciation --------------------------------------------------

const assetRow = (
  n: number,
  extra: Record<string, unknown> & {
    costIdr: Idr;
    accumulatedDepreciationIdr: Idr;
  },
) =>
  fixedAssetSchema.parse({
    id: fixedId("fa000000", n),
    tenantId,
    legalEntityId,
    outletId: bandung,
    code: `FA-${String(n).padStart(5, "0")}`,
    categoryId: null,
    categoryName: null,
    revaluationSurplusIdr: idr(0),
    revaluationLossIdr: idr(0),
    method: "straight_line",
    depreciationStartPeriod: "2026-10",
    sourceDocumentId: null,
    status: "active",
    disposedOn: null,
    disposalProceedsIdr: null,
    ...extra,
    originalCostIdr: extra.costIdr,
    ...fixedAssetDerivedFields({ ...extra, disposalProceedsIdr: null }),
  });
const fixedAssets = [
  assetRow(1, {
    name: "Mesin espresso 2 group",
    acquiredOn: "2026-09-20",
    costIdr: idr(96_000_000),
    residualValueIdr: idr(6_000_000),
    usefulLifeMonths: 60,
    accumulatedDepreciationIdr: idr(1_500_000),
  }),
  assetRow(2, {
    name: "Chiller bahan baku",
    acquiredOn: "2026-09-22",
    costIdr: idr(18_000_000),
    residualValueIdr: idr(0),
    usefulLifeMonths: 48,
    accumulatedDepreciationIdr: idr(375_000),
  }),
];
const depreciationRuns = [
  depreciationRunSchema.parse({
    id: fixedId("fd000000", 1),
    tenantId,
    legalEntityId,
    period: "2026-10",
    amountIdr: 1_875_000,
    lines: fixedAssets.map((asset) => ({
      fixedAssetId: asset.id,
      amountIdr: straightLineSchedule(asset)[0].amountIdr,
    })),
    journalEntryId: journals.find(
      (entry) => entry.sourceType === "depreciation",
    )!.id,
    postedBy: null,
    postedAt: "2026-10-31T15:00:00.000Z",
  }),
];

// ---- Budgets ------------------------------------------------------------------------

const budgets = (
  [
    ["4101", 180_000_000],
    ["5101", 63_000_000],
    ["6105", 15_000_000],
    ["6106", 2_500_000],
  ] as const
).map(([code, amount], index) =>
  budgetSchema.parse({
    id: fixedId("bd000000", index + 1),
    tenantId,
    legalEntityId,
    outletId: bandung,
    accountId: acc(code),
    period: "2026-11",
    amountIdr: amount,
  }),
);

// ---- Tax reports -----------------------------------------------------------------------

const taxReports = [
  taxReportSchema.parse({
    id: fixedId("7a000000", 1),
    tenantId,
    legalEntityId,
    type: "pph21",
    period: "2026-10",
    amountIdr: 630_000,
    lines: [
      {
        subjectType: "employee",
        subjectId: people.generalManager.id,
        subjectName: people.generalManager.displayName,
        taxIdMasked: "****3107",
        outletId: null,
        baseIdr: 18_000_000,
        taxIdr: 540_000,
        references: ["PAYROLL-2026-10"],
      },
      {
        subjectType: "employee",
        subjectId: people.outletManager.id,
        subjectName: people.outletManager.displayName,
        taxIdMasked: "****5521",
        outletId: bandung,
        baseIdr: 9_000_000,
        taxIdr: 90_000,
        references: ["PAYROLL-2026-10"],
      },
    ],
    status: "exported",
    exportFormat: "coretax_xml",
    fileKey: "tax/2026-10/pph21-coretax.xml",
    generatedBy: finance,
    generatedAt: "2026-11-04T11:00:00.000Z",
    finalizedBy: finance,
    finalizedAt: "2026-11-04T11:10:00.000Z",
    exportedAt: "2026-11-04T11:12:00.000Z",
    revisionNo: 0,
    supersedesId: null,
    supersededById: null,
    supersededAt: null,
    correctionReason: null,
    fiscalPeriodVersion: 1,
    isCurrent: true,
  }),
  taxReportSchema.parse({
    id: fixedId("7a000000", 2),
    tenantId,
    legalEntityId,
    type: "pbjt",
    period: "2026-11",
    amountIdr: 37_500,
    lines: [
      {
        subjectType: "outlet",
        subjectId: bandung,
        subjectName: outlets[0].name,
        taxIdMasked: null,
        outletId: bandung,
        baseIdr: 375_000,
        taxIdr: 37_500,
        references: [cafeLegendFixtures.orderId, "01JBQ9A2B3C4D5E6F7G8H9J0KM"],
      },
    ],
    status: "draft",
    exportFormat: null,
    fileKey: null,
    generatedBy: finance,
    generatedAt: "2026-11-05T09:00:00.000Z",
    finalizedBy: null,
    finalizedAt: null,
    exportedAt: null,
    revisionNo: null,
    supersedesId: null,
    supersededById: null,
    supersededAt: null,
    correctionReason: null,
    fiscalPeriodVersion: 1,
    isCurrent: false,
  }),
];

// ---- Statements (derived from the journals above) ----------------------------------------

const trialBalance = buildTrialBalance(
  accounts,
  ledgerLines,
  legalEntityId,
  "2026-11-30",
  fiscalPeriods,
);
const profitAndLossNovember = buildProfitAndLoss(accounts, ledgerLines, {
  legalEntityId,
  from: "2026-11-01",
  to: "2026-11-30",
  periods: fiscalPeriods,
});
const profitAndLossBandungNovember = buildProfitAndLoss(accounts, ledgerLines, {
  legalEntityId,
  from: "2026-11-01",
  to: "2026-11-30",
  outletId: bandung,
  periods: fiscalPeriods,
});
const balanceSheet = buildBalanceSheet(accounts, ledgerLines, {
  legalEntityId,
  asOf: "2026-11-30",
  periods: fiscalPeriods,
});

const cashFlowNovember = cashFlowStatementSchema.parse({
  legalEntityId,
  from: "2026-11-01",
  to: "2026-11-30",
  ...statementBasisFields(fiscalPeriods, {
    from: "2026-11-01",
    to: "2026-11-30",
    cumulative: true,
  }),
  method: "direct",
  sections: [
    {
      activity: "operating",
      rows: [
        {
          label: "Penerimaan penjualan tunai dan settlement",
          amountIdr: 410_575,
        },
        { label: "Pembayaran beban operasional", amountIdr: -1_520_000 },
      ],
      totalIdr: -1_109_425,
    },
    { activity: "investing", rows: [], totalIdr: 0 },
    { activity: "financing", rows: [], totalIdr: 0 },
  ],
  openingCashIdr: 249_650_000,
  netChangeIdr: -1_109_425,
  closingCashIdr: 248_540_575,
});
const equityChangesOctober = equityChangesSchema.parse({
  legalEntityId,
  from: "2026-10-01",
  to: "2026-10-31",
  ...statementBasisFields(fiscalPeriods, {
    from: "2026-10-01",
    to: "2026-10-31",
    cumulative: true,
  }),
  rows: [
    {
      accountId: acc("3101"),
      label: "Modal Disetor",
      openingIdr: 366_000_000,
      profitIdr: 0,
      distributionsIdr: 0,
      otherMovementsIdr: 0,
      closingIdr: 366_000_000,
    },
    {
      accountId: null,
      label: "Laba periode berjalan",
      openingIdr: 0,
      profitIdr: -48_409_000,
      distributionsIdr: 0,
      otherMovementsIdr: 0,
      closingIdr: -48_409_000,
    },
  ],
});

/** Closing snapshot of October, version 4 (re-closed after the approved reopen). */
const octoberSnapshot = periodCloseSnapshotSchema.parse({
  fiscalPeriodId: periodId("2026-10"),
  legalEntityId,
  period: "2026-10",
  version: 4,
  takenAt: "2026-11-04T10:30:00.000Z",
  takenBy: finance,
  balances: buildTrialBalance(
    accounts,
    ledgerLines,
    legalEntityId,
    "2026-10-31",
  ).rows.map((row) => ({
    accountId: row.accountId,
    debitIdr: row.debitIdr,
    creditIdr: row.creditIdr,
  })),
});

// ---- Profit share & dividends (F37, §6 I; SH-03, SH-04) --------------------
// Shareholders, versions, runs and statements are built through the same
// calculation and state-machine functions the API runs, so the fixtures cannot
// drift from the contract (like journals above). Amounts are illustrative:
// the owner confirms the real split and policy later.

/** Fixture user ids are plain strings until a schema brands them. */
const actor = (id: string) => id as UserId;

const profitShareholders = [
  shareholderSchema.parse({
    id: fixedId("5a000000", 1),
    tenantId,
    userId: owner,
    name: "Raka Pratama",
    type: "person",
    status: "active",
    npwpMasked: "****3341",
    payoutAccount: {
      bank: "BCA",
      accountNumberMasked: "****4821",
      accountHolder: "Raka Pratama",
    },
    createdAt: "2026-01-02T03:00:00.000Z",
  }),
  shareholderSchema.parse({
    id: fixedId("5a000000", 2),
    tenantId,
    userId: people.shareholder.id,
    name: "Dewi Lestari",
    type: "person",
    status: "active",
    npwpMasked: "****8820",
    payoutAccount: {
      bank: "Mandiri",
      accountNumberMasked: "****7730",
      accountHolder: "Dewi Lestari",
    },
    createdAt: "2026-01-02T03:05:00.000Z",
  }),
  shareholderSchema.parse({
    id: fixedId("5a000000", 3),
    tenantId,
    userId: null,
    name: "PT Angkasa Modal Nusantara",
    type: "company",
    status: "active",
    npwpMasked: "****7712",
    payoutAccount: {
      bank: "BNI",
      accountNumberMasked: "****2214",
      accountHolder: "PT Angkasa Modal Nusantara",
    },
    createdAt: "2026-01-02T03:10:00.000Z",
  }),
  shareholderSchema.parse({
    id: fixedId("5a000000", 4),
    tenantId,
    userId: null,
    name: "Nur Aisyah",
    type: "person",
    status: "active",
    npwpMasked: null,
    payoutAccount: {
      bank: "BJB",
      accountNumberMasked: "****9056",
      accountHolder: "Nur Aisyah",
    },
    createdAt: "2026-01-02T03:15:00.000Z",
  }),
];
const [raka, dewi, angkasa, nurAisyah] = profitShareholders;

const legalEntityProfitEntity = profitEntitySchema.parse({
  id: fixedId("5b000000", 1),
  tenantId,
  name: legalEntity.name,
  type: "legal_entity",
  legalEntityId,
  outletId: null,
  policy: {
    basis: "closed_period_net_profit",
    reserveBp: 1_000,
    frequency: "quarterly",
    taxWithholdingBp: 1_000,
  },
  isActive: true,
});
const outletProfitEntity = profitEntitySchema.parse({
  id: fixedId("5b000000", 2),
  tenantId,
  name: "Cafe Legend Bandung",
  type: "outlet",
  legalEntityId: null,
  outletId: bandung,
  policy: {
    basis: "closed_period_net_profit",
    reserveBp: 500,
    frequency: "monthly",
    taxWithholdingBp: 1_000,
  },
  isActive: true,
});
const profitEntities = [legalEntityProfitEntity, outletProfitEntity];

let shareAllocationCount = 0;
const allocRows = (pairs: readonly [string, number][]) =>
  pairs.map(([shareholderId, shareBp]) => ({
    id: fixedId("5c000000", ++shareAllocationCount),
    shareholderId,
    shareBp,
  }));

const shareVersions = [
  shareAllocationVersionSchema.parse({
    tenantId,
    profitEntityId: legalEntityProfitEntity.id,
    version: 1,
    effectiveFrom: "2026-01-01",
    status: "approved",
    allocations: allocRows([
      [raka.id, 3_000],
      [dewi.id, 2_000],
      [angkasa.id, 4_000],
      [nurAisyah.id, 1_000],
    ]),
    requestedBy: generalManager,
    requestedAt: "2025-12-18T03:00:00.000Z",
    decidedBy: owner,
    decidedAt: "2025-12-19T02:00:00.000Z",
    decisionNote: null,
  }),
  shareAllocationVersionSchema.parse({
    tenantId,
    profitEntityId: legalEntityProfitEntity.id,
    version: 2,
    effectiveFrom: "2026-07-01",
    status: "approved",
    allocations: allocRows([
      [raka.id, 3_500],
      [dewi.id, 2_500],
      [angkasa.id, 3_000],
      [nurAisyah.id, 1_000],
    ]),
    requestedBy: finance,
    requestedAt: "2026-06-20T04:00:00.000Z",
    decidedBy: owner,
    decidedAt: "2026-06-22T02:30:00.000Z",
    decisionNote: null,
  }),
  // Under-allocated draft (9,500 bp): the admin screen's live sum indicator
  // flags it, and SH-03 refuses to submit it. Not used by any distribution.
  shareAllocationVersionSchema.parse({
    tenantId,
    profitEntityId: legalEntityProfitEntity.id,
    version: 3,
    effectiveFrom: "2027-01-01",
    status: "draft",
    allocations: allocRows([
      [raka.id, 4_000],
      [dewi.id, 2_500],
      [angkasa.id, 3_000],
    ]),
    requestedBy: finance,
    requestedAt: "2026-11-05T02:00:00.000Z",
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
  }),
  shareAllocationVersionSchema.parse({
    tenantId,
    profitEntityId: outletProfitEntity.id,
    version: 1,
    effectiveFrom: "2026-01-01",
    status: "approved",
    allocations: allocRows([
      [raka.id, 6_000],
      [dewi.id, 4_000],
    ]),
    requestedBy: generalManager,
    requestedAt: "2025-12-19T03:00:00.000Z",
    decidedBy: owner,
    decidedAt: "2025-12-20T02:00:00.000Z",
    decisionNote: null,
  }),
];
const legalEntityVersion = (version: number) =>
  shareVersions.find(
    (row) =>
      row.profitEntityId === legalEntityProfitEntity.id &&
      row.version === version,
  )!;
const currentLegalEntityVersion = legalEntityVersion(2);

let distributionLineCount = 0;
const nextDistributionLineId = () =>
  fixedId("5d000000", ++distributionLineCount);

function draftDistributionRun(input: {
  id: string;
  calc: DistributionCalculation | AdjustmentCalculation;
  type: "regular" | "adjustment";
  shareVersion: number;
  requestedBy: string;
  requestedAt: string;
  adjustsRunId?: string;
  adjustmentReason?: string;
}): DistributionRun {
  const { calc } = input;
  const adjustment = input.type === "adjustment";
  const regular = calc as DistributionCalculation;
  const correction = calc as AdjustmentCalculation;
  return distributionRunSchema.parse({
    id: input.id,
    tenantId,
    profitEntityId: calc.profitEntityId,
    fiscalPeriodId: calc.fiscalPeriodId,
    period: calc.period,
    type: input.type,
    basis: calc.basis,
    status: "draft",
    shareVersion: input.shareVersion,
    periodNetProfitIdr: adjustment ? null : regular.periodNetProfitIdr,
    reserveIdr: adjustment ? 0 : regular.reserveIdr,
    distributableIdr: adjustment
      ? correction.adjustmentIdr
      : regular.distributableIdr,
    lines: calc.lines.map((line) => ({
      id: nextDistributionLineId(),
      tenantId,
      distributionRunId: input.id,
      ...line,
      paymentStatus: "pending",
      paymentRef: null,
      paidAt: null,
      statementFileKey: null,
    })),
    totalGrossIdr: calc.totalGrossIdr,
    totalTaxWithheldIdr: calc.totalTaxWithheldIdr,
    totalNetIdr: calc.totalNetIdr,
    requestedBy: input.requestedBy,
    requestedAt: input.requestedAt,
    approvedBy: null,
    approvedAt: null,
    paidAt: null,
    adjustsRunId: input.adjustsRunId ?? null,
    adjustmentReason: input.adjustmentReason ?? null,
    reversalJournalEntryId: null,
    unabsorbedIdr: 0,
    carryDeductedIdr: calc.carryDeductedIdr,
    carryDeductions: [],
  });
}

/** Approved by someone other than the requester (AUTH-06). */
function approveRun(
  draft: DistributionRun,
  approver: string,
  approvedAt: string,
): DistributionRun {
  return transitionDistributionRun(
    transitionDistributionRun(draft, {
      type: "submit",
      actorId: draft.requestedBy,
    }),
    { type: "approve", actorId: actor(approver), now: approvedAt },
  );
}

const septemberCalculation = calculateDistribution({
  profitEntityId: legalEntityProfitEntity.id,
  fiscalPeriodId: periodId("2026-09"),
  period: "2026-09",
  periodStatus: "closed",
  periodNetProfitIdr: idr(180_000_000),
  policy: legalEntityProfitEntity.policy,
  allocations: currentLegalEntityVersion.allocations,
});
const septemberDraft = draftDistributionRun({
  id: fixedId("5e000000", 1),
  calc: septemberCalculation,
  type: "regular",
  shareVersion: currentLegalEntityVersion.version,
  requestedBy: finance,
  requestedAt: "2026-10-05T03:00:00.000Z",
});
let septemberRun = approveRun(
  septemberDraft,
  owner,
  "2026-10-06T02:00:00.000Z",
);
for (const [index, line] of septemberRun.lines.entries()) {
  septemberRun = transitionDistributionRun(septemberRun, {
    type: "record_payment",
    actorId: actor(finance),
    lineId: line.id,
    paymentRef: `TRF/2026/10/Q3-${index + 1}`,
    paidAt: `2026-10-${String(7 + index).padStart(2, "0")}T04:00:00.000Z`,
  });
}
const statementKeyOf = (period: string, slug: string) =>
  `shareholder/${period}/${slug}-statement.pdf`;
for (const line of septemberRun.lines) {
  const slug =
    line.shareholderId === raka.id
      ? "raka-pratama"
      : line.shareholderId === dewi.id
        ? "dewi-lestari"
        : line.shareholderId === angkasa.id
          ? "pt-angkasa-modal-nusantara"
          : "nur-aisyah";
  septemberRun = attachDistributionStatement(
    septemberRun,
    line.id,
    statementKeyOf("2026-09", slug),
  );
}

const octoberCalculation = calculateDistribution({
  profitEntityId: legalEntityProfitEntity.id,
  fiscalPeriodId: periodId("2026-10"),
  period: "2026-10",
  periodStatus: "closed",
  periodNetProfitIdr: idr(165_000_000),
  policy: legalEntityProfitEntity.policy,
  allocations: currentLegalEntityVersion.allocations,
});
const octoberDraft = draftDistributionRun({
  id: fixedId("5e000000", 2),
  calc: octoberCalculation,
  type: "regular",
  shareVersion: currentLegalEntityVersion.version,
  requestedBy: finance,
  requestedAt: "2026-11-05T02:30:00.000Z",
});
let octoberRun = approveRun(octoberDraft, owner, "2026-11-05T06:00:00.000Z");
// Two lines paid, two pending: shows the approval → payment → statement step.
for (const [index, line] of octoberRun.lines.slice(0, 2).entries()) {
  octoberRun = transitionDistributionRun(octoberRun, {
    type: "record_payment",
    actorId: actor(finance),
    lineId: line.id,
    paymentRef: `TRF/2026/11/OKT-${index + 1}`,
    paidAt: `2026-11-05T0${7 + index}:00:00.000Z`,
  });
}
for (const line of octoberRun.lines.filter(
  (row) => row.paymentStatus === "paid",
)) {
  const slug =
    line.shareholderId === raka.id
      ? "raka-pratama"
      : line.shareholderId === dewi.id
        ? "dewi-lestari"
        : "shareholder";
  octoberRun = attachDistributionStatement(
    octoberRun,
    line.id,
    statementKeyOf("2026-10", slug),
  );
}

// SH-04: a correction of the Q3 run is a new adjustment run with its own
// approval and reversing journal, never an edit of the paid September run.
const adjustmentCalculation = calculateAdjustmentDistribution({
  profitEntityId: legalEntityProfitEntity.id,
  fiscalPeriodId: periodId("2026-10"),
  period: "2026-10",
  periodStatus: "closed",
  adjustsRunId: septemberRun.id,
  reason:
    "Koreksi lebih bayar dividen Q3 2026: tagihan listrik tercatat ganda.",
  adjustmentIdr: idr(-4_000_000),
  taxWithholdingBp: legalEntityProfitEntity.policy.taxWithholdingBp,
  allocations: currentLegalEntityVersion.allocations,
});
const adjustmentRun = draftDistributionRun({
  id: fixedId("5e000000", 3),
  calc: adjustmentCalculation,
  type: "adjustment",
  shareVersion: currentLegalEntityVersion.version,
  requestedBy: finance,
  requestedAt: "2026-11-05T03:00:00.000Z",
  adjustsRunId: septemberRun.id,
  adjustmentReason: adjustmentCalculation.reason,
});

const profitShareRuns = [septemberRun, octoberRun, adjustmentRun];
const profitEntityById = (id: string) =>
  profitEntities.find((row) => row.id === id)!;
const statementsOf = (run: DistributionRun) =>
  run.lines.map((line) =>
    buildDistributionStatement({
      run,
      line,
      shareholder: profitShareholders.find(
        (row) => row.id === line.shareholderId,
      )!,
      profitEntity: profitEntityById(run.profitEntityId),
    }),
  );
const profitShareStatements = profitShareRuns.flatMap(statementsOf);

const shareholderDocuments = [
  shareholderDocumentSchema.parse({
    id: fixedId("5f000000", 1),
    tenantId,
    profitEntityId: legalEntityProfitEntity.id,
    kind: "monthly_report",
    title: "Laporan Bulanan Oktober 2026",
    fileKey: "shareholder/2026-10/laporan-bulanan-oktober-2026.pdf",
    visibility: "shareholders",
    publishedAt: "2026-11-05T03:30:00.000Z",
    publishedBy: owner,
    createdAt: "2026-11-05T03:00:00.000Z",
  }),
  shareholderDocumentSchema.parse({
    id: fixedId("5f000000", 2),
    tenantId,
    profitEntityId: legalEntityProfitEntity.id,
    kind: "general_meeting_minutes",
    title: "Notulen RUPS Tahunan 2026",
    fileKey: "shareholder/2026-06/notulen-rups-tahunan-2026.pdf",
    visibility: "management",
    publishedAt: "2026-06-30T04:00:00.000Z",
    publishedBy: generalManager,
    createdAt: "2026-06-29T04:00:00.000Z",
  }),
  shareholderDocumentSchema.parse({
    id: fixedId("5f000000", 3),
    tenantId,
    profitEntityId: outletProfitEntity.id,
    kind: "other",
    title: "Draf Laporan Kinerja Outlet Bandung",
    fileKey: "shareholder/2026-11/draf-kinerja-outlet-bandung.pdf",
    visibility: "shareholders",
    publishedAt: null,
    publishedBy: null,
    createdAt: "2026-11-05T04:00:00.000Z",
  }),
];

// F35 "Bagi Hasil Pribadi": only Dewi's own rows (SH-01), with the November
// number labelled estimate (SH-02).
const dewiProfitShare = buildMyProfitShare({
  shareholder: dewi,
  entities: profitEntities,
  versions: shareVersions,
  statements: profitShareStatements.filter(
    (row) => row.shareholderId === dewi.id,
  ),
  estimates: [
    buildProfitShareEstimate({
      profitEntity: legalEntityProfitEntity,
      period: "2026-11",
      shareBp: 2_500,
      estimatedNetProfitIdr: idr(120_000_000),
      asOf: "2026-11-05T05:00:00.000Z",
    }),
  ],
  asOf: "2026-11-05",
});

const profitShare = {
  entities: profitEntities,
  shareholders: profitShareholders,
  versions: shareVersions,
  runs: {
    september: septemberRun,
    october: octoberRun,
    adjustment: adjustmentRun,
  },
  documents: shareholderDocuments,
  statements: profitShareStatements,
  myProfitShare: dewiProfitShare,
  shareholderById: (id: string) =>
    profitShareholders.find((row) => row.id === id)!,
  entityById: profitEntityById,
};

export const cafeLegendAccountingFixtures = {
  tenantId,
  legalEntity,
  outletId: bandung,
  users: { finance, owner, generalManager, outletManager },
  accounts,
  accountMappings,
  accountByCode: (code: string) =>
    accounts.find((account) => account.code === code)!,
  fiscalPeriods,
  periodReopenRequests,
  octoberSnapshot,
  journals,
  /** Shortcuts into `journals`. */
  entries: {
    cashSale,
    gatewaySettlement,
    cashDepositEntry,
    wrongInternet,
    internet,
    electricityOctober,
  },
  ledgerLines,
  manualJournals,
  recurringJournals,
  bankAccount,
  statementImport,
  statementLines,
  cashDeposits,
  cashCollections,
  cashDepositPolicy: { maxDaysUndeposited: 2 },
  matchingPolicy: { dateToleranceDays: 2 },
  reconciliationPolicy: { caseDueDays: 4 },
  reconciliationCases,
  agingBucketLimits: [30, 60, 90],
  openItems: payablesAndReceivables,
  fixedAssets,
  depreciationRuns,
  budgets,
  taxReports,
  statements: {
    trialBalance,
    profitAndLossNovember,
    profitAndLossBandungNovember,
    balanceSheet,
    cashFlowNovember,
    equityChangesOctober,
  },
  profitShare,
  /** "Today" for the fixtures (aging, alerts). */
  asOf: "2026-11-05",
};
