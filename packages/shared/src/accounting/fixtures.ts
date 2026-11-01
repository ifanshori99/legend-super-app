// Cafe Legend accounting mock data (FE mock mode + contract tests). PRD facts:
// tenant Cafe Legend, legal entity PT Sultan Solusi Nusantara, PBJT 10%.
// Everything else is illustrative sample data: the real chart, opening
// balances, bank accounts and PKP status come from the owner (PRD A14), so the
// entity is shown as non-PKP here and no PPN report exists. Suppliers and
// customers are fictional. Journals are built through the posting rules, so
// the fixtures exercise the same code the BE runs and always balance.

import { cafeLegendFixtures, idr } from "../core/index.ts";
import type { OutletId } from "../core/index.ts";
import { cafeLegendAccessFixtures } from "../access/fixtures.ts";
import {
  straightLineSchedule,
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
    { eventName: "payroll_run.completed" },
    {
      grossPayIdr: 42_000_000,
      employerBpjsIdr: 2_184_000,
      netPayIdr: 40_530_000,
      totalBpjsIdr: 3_024_000,
      pph21Idr: 630_000,
    },
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
// QRIS sale through the gateway, then its settlement with MDR (illustrative 0.7%).
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
      paidGatewayIdr: 275_000,
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

const assetRow = (n: number, extra: Record<string, unknown>) =>
  fixedAssetSchema.parse({
    id: fixedId("fa000000", n),
    tenantId,
    legalEntityId,
    outletId: bandung,
    method: "straight_line",
    depreciationStartPeriod: "2026-10",
    sourceDocumentId: null,
    status: "active",
    disposedOn: null,
    disposalProceedsIdr: null,
    ...extra,
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
  }),
];

// ---- Statements (derived from the journals above) ----------------------------------------

const trialBalance = buildTrialBalance(
  accounts,
  ledgerLines,
  legalEntityId,
  "2026-11-30",
);
const profitAndLossNovember = buildProfitAndLoss(accounts, ledgerLines, {
  legalEntityId,
  from: "2026-11-01",
  to: "2026-11-30",
});
const profitAndLossBandungNovember = buildProfitAndLoss(accounts, ledgerLines, {
  legalEntityId,
  from: "2026-11-01",
  to: "2026-11-30",
  outletId: bandung,
});
const balanceSheet = buildBalanceSheet(accounts, ledgerLines, {
  legalEntityId,
  asOf: "2026-11-30",
});

const cashFlowNovember = cashFlowStatementSchema.parse({
  legalEntityId,
  from: "2026-11-01",
  to: "2026-11-30",
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
  /** "Today" for the fixtures (aging, alerts). */
  asOf: "2026-11-05",
};
