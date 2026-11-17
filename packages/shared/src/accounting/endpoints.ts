// Accounting HTTP contracts (defineEndpoint). The FE beads (legend-mzg,
// legend-53q, legend-m4zn, legend-rx0h, legend-5fdy) build screens and mock
// mode on these; the BE beads implement them. Tenant comes from the session
// (TEN-02), never from params or bodies: every body schema is strict and has
// no tenantId. Outlet filters are checked against the caller's scope with
// outletIdsForQuery (TEN-03).

import {
  businessDateSchema,
  cursorPageQuerySchema,
  cursorPageSchema,
  dataResponseSchema,
  idempotencyKeySchema,
  idrSchema,
  outletIdSchema,
  uuidSchema,
  z,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import {
  assetCategorySchema,
  createAssetCategoryInputSchema,
  fixedAssetSchema,
  createFixedAssetInputSchema,
  depreciationRunSchema,
  disposeFixedAssetInputSchema,
  revalueFixedAssetInputSchema,
  runDepreciationInputSchema,
} from "./assets.ts";
import {
  bankAccountSchema,
  bankStatementImportSchema,
  bankStatementLineSchema,
  cashBankEntryQuerySchema,
  cashBankEntrySchema,
  cashDepositSchema,
  createBankAccountInputSchema,
  createCashBankEntryInputSchema,
  cashOutApprovalLimitSchema,
  putCashOutApprovalLimitInputSchema,
  rejectCashBankEntryInputSchema,
  createCashDepositInputSchema,
  excludeStatementLineInputSchema,
  importBankStatementInputSchema,
  matchStatementLineInputSchema,
  matchStatusSchema,
  openReconciliationCaseInputSchema,
  pettyCashEntryQuerySchema,
  pettyCashEntrySchema,
  pettyCashFundQuerySchema,
  pettyCashFundSchema,
  pettyCashMovementInputSchema,
  pettyCashReconciliationQuerySchema,
  pettyCashReconciliationSchema,
  reconciliationCaseActionInputSchema,
  reconciliationCaseSchema,
  reconciliationCaseStatusSchema,
  undepositedCashAlertSchema,
} from "./banking.ts";
import {
  budgetSchema,
  budgetVsActualRowSchema,
  upsertBudgetsInputSchema,
} from "./budgets.ts";
import {
  financePolicySchema,
  putFinancePolicyInputSchema,
} from "./finance-policy.ts";
import {
  accountCodeSchema,
  accountMappingSchema,
  accountSchema,
  accountTypeSchema,
  postingAccountRoleSchema,
  reportGroupSchema,
} from "./coa.ts";
import {
  accountIdSchema,
  bankAccountIdSchema,
  bankStatementLineIdSchema,
  cashBankEntryIdSchema,
  fiscalPeriodIdSchema,
  fixedAssetIdSchema,
  journalEntryIdSchema,
  legalEntityIdSchema,
  manualJournalIdSchema,
  periodReopenRequestIdSchema,
  pettyCashEntryIdSchema,
  reconciliationCaseIdSchema,
  recurringJournalIdSchema,
  taxReportIdSchema,
} from "./ids.ts";
import {
  createManualJournalInputSchema,
  journalEntrySchema,
  journalEntrySummarySchema,
  journalLineInputSchema,
  journalSourceTypeSchema,
  manualJournalSchema,
  manualJournalStatusSchema,
  recurringJournalSchema,
  rejectInputSchema,
  reverseJournalInputSchema,
  updateManualJournalInputSchema,
} from "./journal.ts";
import {
  agingReportSchema,
  openItemKindSchema,
  openItemListRowSchema,
} from "./payables.ts";
import { periodKeySchema } from "./period-key.ts";
import {
  fiscalPeriodSchema,
  periodCloseSnapshotSchema,
  periodReopenRequestSchema,
  requestPeriodReopenInputSchema,
} from "./period.ts";
import {
  balanceSheetSchema,
  cashFlowStatementSchema,
  drillDownLineSchema,
  drillDownQuerySchema,
  equityChangesSchema,
  multiEntityProfitAndLossSchema,
  profitAndLossSchema,
  statementQuerySchema,
  trialBalanceSchema,
} from "./statements.ts";
import {
  finalizeTaxReportBodySchema,
  generateTaxReportInputSchema,
  taxReportDownloadSchema,
  taxReportExportSchema,
  taxReportSchema,
  taxReportStatusSchema,
  taxReportTypeSchema,
} from "./tax.ts";

const BASE = "/api/accounting";
const entityParams = z.strictObject({ legalEntityId: legalEntityIdSchema });
const list = <T extends z.ZodType>(item: T) =>
  dataResponseSchema(z.array(item));
const commandBody = z.strictObject({ idempotencyKey: idempotencyKeySchema });

// ---- Legal entities (finance picker) -----------------------------------------

/** Read model for the finance screens' entity picker (legend-bddb): only what
 * a report needs to label an entity. The NPWP stays masked to its last four
 * digits; address, tenant id and bank accounts are not part of it. */
export const accountingLegalEntitySchema = z.strictObject({
  id: legalEntityIdSchema,
  name: z.string().trim().min(1).max(150),
  npwpLast4: z
    .string()
    .regex(/^\d{4}$/)
    .nullable(),
  isPkp: z.boolean(),
});
export type AccountingLegalEntity = z.infer<typeof accountingLegalEntitySchema>;

/** Tenant-wide, `accounting.journal.view`; the org route stays
 * `org.structure.manage`. */
export const listLegalEntities = defineEndpoint({
  method: "GET",
  path: `${BASE}/legal-entities`,
  response: list(accountingLegalEntitySchema),
});

// ---- Chart of accounts -----------------------------------------------------

export const listAccounts = defineEndpoint({
  method: "GET",
  path: `${BASE}/legal-entities/:legalEntityId/accounts`,
  params: entityParams,
  response: list(accountSchema),
});
export const createAccountInputSchema = z.strictObject({
  code: accountCodeSchema,
  name: z.string().trim().min(1).max(150),
  type: accountTypeSchema,
  reportGroup: reportGroupSchema,
  parentId: accountIdSchema.nullable(),
});
export const createAccount = defineEndpoint({
  method: "POST",
  path: `${BASE}/legal-entities/:legalEntityId/accounts`,
  params: entityParams,
  body: createAccountInputSchema,
  response: dataResponseSchema(accountSchema),
});
/** Type cannot change once created (statements would move history). */
export const updateAccount = defineEndpoint({
  method: "PATCH",
  path: `${BASE}/accounts/:accountId`,
  params: z.strictObject({ accountId: accountIdSchema }),
  body: z
    .strictObject({
      name: z.string().trim().min(1).max(150),
      reportGroup: reportGroupSchema,
      parentId: accountIdSchema.nullable(),
      isActive: z.boolean(),
    })
    .partial(),
  response: dataResponseSchema(accountSchema),
});
export const listAccountMappings = defineEndpoint({
  method: "GET",
  path: `${BASE}/legal-entities/:legalEntityId/account-mappings`,
  params: entityParams,
  response: list(accountMappingSchema),
});
export const replaceAccountMappings = defineEndpoint({
  method: "PUT",
  path: `${BASE}/legal-entities/:legalEntityId/account-mappings`,
  params: entityParams,
  body: z.strictObject({
    mappings: z
      .array(
        z.strictObject({
          role: postingAccountRoleSchema,
          accountId: accountIdSchema,
        }),
      )
      .max(100),
  }),
  response: list(accountMappingSchema),
});

// ---- Journals --------------------------------------------------------------

export const listJournalsQuerySchema = cursorPageQuerySchema.extend({
  legalEntityId: legalEntityIdSchema,
  from: businessDateSchema,
  to: businessDateSchema,
  outletId: outletIdSchema.optional(),
  sourceType: journalSourceTypeSchema.optional(),
  accountId: accountIdSchema.optional(),
});
export const listJournals = defineEndpoint({
  method: "GET",
  path: `${BASE}/journals`,
  query: listJournalsQuerySchema,
  response: cursorPageSchema(journalEntrySummarySchema),
});
export const getJournal = defineEndpoint({
  method: "GET",
  path: `${BASE}/journals/:journalEntryId`,
  params: z.strictObject({ journalEntryId: journalEntryIdSchema }),
  response: dataResponseSchema(
    z.strictObject({
      entry: journalEntrySchema,
      reversedBy: journalEntryIdSchema.nullable(),
    }),
  ),
});
/** ACC-01: the only correction path for a posted entry. */
export const reverseJournal = defineEndpoint({
  method: "POST",
  path: `${BASE}/journals/:journalEntryId/reversal`,
  params: z.strictObject({ journalEntryId: journalEntryIdSchema }),
  body: reverseJournalInputSchema,
  response: dataResponseSchema(journalEntrySchema),
});

const manualParams = z.strictObject({ manualJournalId: manualJournalIdSchema });
export const listManualJournals = defineEndpoint({
  method: "GET",
  path: `${BASE}/manual-journals`,
  query: cursorPageQuerySchema.extend({
    legalEntityId: legalEntityIdSchema,
    status: manualJournalStatusSchema.optional(),
  }),
  response: cursorPageSchema(manualJournalSchema),
});
export const createManualJournal = defineEndpoint({
  method: "POST",
  path: `${BASE}/manual-journals`,
  body: createManualJournalInputSchema,
  response: dataResponseSchema(manualJournalSchema),
});
export const getManualJournal = defineEndpoint({
  method: "GET",
  path: `${BASE}/manual-journals/:manualJournalId`,
  params: manualParams,
  response: dataResponseSchema(manualJournalSchema),
});
export const updateManualJournal = defineEndpoint({
  method: "PATCH",
  path: `${BASE}/manual-journals/:manualJournalId`,
  params: manualParams,
  body: updateManualJournalInputSchema,
  response: dataResponseSchema(manualJournalSchema),
});
const manualCommand = (action: "submit" | "withdraw" | "approve" | "cancel") =>
  defineEndpoint({
    method: "POST",
    path: `${BASE}/manual-journals/:manualJournalId/${action}`,
    params: manualParams,
    body: commandBody,
    response: dataResponseSchema(manualJournalSchema),
  });
export const submitManualJournal = manualCommand("submit");
export const withdrawManualJournal = manualCommand("withdraw");
/** Approval posts the entry in the same transaction (needs an open period). */
export const approveManualJournal = manualCommand("approve");
export const cancelManualJournal = manualCommand("cancel");
export const rejectManualJournal = defineEndpoint({
  method: "POST",
  path: `${BASE}/manual-journals/:manualJournalId/reject`,
  params: manualParams,
  body: rejectInputSchema,
  response: dataResponseSchema(manualJournalSchema),
});

const recurringParams = z.strictObject({
  recurringJournalId: recurringJournalIdSchema,
});
export const listRecurringJournals = defineEndpoint({
  method: "GET",
  path: `${BASE}/recurring-journals`,
  query: z.strictObject({ legalEntityId: legalEntityIdSchema }),
  response: list(recurringJournalSchema),
});
export const createRecurringJournal = defineEndpoint({
  method: "POST",
  path: `${BASE}/recurring-journals`,
  body: z.strictObject({
    legalEntityId: legalEntityIdSchema,
    outletId: outletIdSchema.nullable(),
    description: z.string().trim().min(1).max(255),
    lines: z.array(journalLineInputSchema).min(2).max(200),
    dayOfMonth: z.number().int().min(1).max(31),
    startPeriod: periodKeySchema,
    endPeriod: periodKeySchema.nullable(),
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(recurringJournalSchema),
});
export const transitionRecurringJournalEndpoint = defineEndpoint({
  method: "POST",
  path: `${BASE}/recurring-journals/:recurringJournalId/transition`,
  params: recurringParams,
  body: z.discriminatedUnion("type", [
    z.strictObject({
      type: z.enum(["submit", "approve", "pause", "resume", "end"]),
    }),
    z.strictObject({
      type: z.literal("reject"),
      reason: z.string().trim().min(1).max(500),
    }),
  ]),
  response: dataResponseSchema(recurringJournalSchema),
});

export const skipRecurringJournalPeriodEndpoint = defineEndpoint({
  method: "POST",
  path: `${BASE}/recurring-journals/:recurringJournalId/skip-period`,
  params: recurringParams,
  body: z.strictObject({
    period: periodKeySchema,
    reason: z.string().trim().min(1).max(500),
  }),
  response: dataResponseSchema(recurringJournalSchema),
});

// ---- Fiscal periods --------------------------------------------------------

const periodParams = z.strictObject({ fiscalPeriodId: fiscalPeriodIdSchema });
export const listFiscalPeriods = defineEndpoint({
  method: "GET",
  path: `${BASE}/legal-entities/:legalEntityId/fiscal-periods`,
  params: entityParams,
  response: list(fiscalPeriodSchema),
});
/** `expectedVersion` turns a stale screen into PERIOD_CHANGED. */
export const closeFiscalPeriod = defineEndpoint({
  method: "POST",
  path: `${BASE}/fiscal-periods/:fiscalPeriodId/close`,
  params: periodParams,
  body: z.strictObject({
    expectedVersion: z.number().int().min(1),
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(fiscalPeriodSchema),
});
export const getPeriodSnapshot = defineEndpoint({
  method: "GET",
  path: `${BASE}/fiscal-periods/:fiscalPeriodId/snapshot`,
  params: periodParams,
  response: dataResponseSchema(periodCloseSnapshotSchema),
});
export const requestPeriodReopen = defineEndpoint({
  method: "POST",
  path: `${BASE}/fiscal-periods/:fiscalPeriodId/reopen-requests`,
  params: periodParams,
  body: requestPeriodReopenInputSchema,
  response: dataResponseSchema(periodReopenRequestSchema),
});
export const listPeriodReopenRequests = defineEndpoint({
  method: "GET",
  path: `${BASE}/legal-entities/:legalEntityId/period-reopen-requests`,
  params: entityParams,
  response: list(periodReopenRequestSchema),
});
const reopenParams = z.strictObject({ requestId: periodReopenRequestIdSchema });
export const approvePeriodReopen = defineEndpoint({
  method: "POST",
  path: `${BASE}/period-reopen-requests/:requestId/approve`,
  params: reopenParams,
  body: z.strictObject({ note: z.string().trim().min(1).max(500).nullable() }),
  response: dataResponseSchema(
    z.strictObject({
      request: periodReopenRequestSchema,
      period: fiscalPeriodSchema,
    }),
  ),
});
export const rejectPeriodReopen = defineEndpoint({
  method: "POST",
  path: `${BASE}/period-reopen-requests/:requestId/reject`,
  params: reopenParams,
  body: rejectInputSchema,
  response: dataResponseSchema(periodReopenRequestSchema),
});

// ---- Cash & bank -----------------------------------------------------------

export const listBankAccounts = defineEndpoint({
  method: "GET",
  path: `${BASE}/legal-entities/:legalEntityId/bank-accounts`,
  params: entityParams,
  response: list(bankAccountSchema),
});
export const createBankAccount = defineEndpoint({
  method: "POST",
  path: `${BASE}/bank-accounts`,
  body: createBankAccountInputSchema,
  response: dataResponseSchema(bankAccountSchema),
});
const bankParams = z.strictObject({ bankAccountId: bankAccountIdSchema });
export const importBankStatement = defineEndpoint({
  method: "POST",
  path: `${BASE}/bank-accounts/:bankAccountId/statement-imports`,
  params: bankParams,
  body: importBankStatementInputSchema,
  response: dataResponseSchema(bankStatementImportSchema),
});
export const listStatementLines = defineEndpoint({
  method: "GET",
  path: `${BASE}/bank-accounts/:bankAccountId/statement-lines`,
  params: bankParams,
  query: cursorPageQuerySchema.extend({
    from: businessDateSchema,
    to: businessDateSchema,
    matchStatus: matchStatusSchema.optional(),
  }),
  response: cursorPageSchema(bankStatementLineSchema),
});
const lineParams = z.strictObject({ lineId: bankStatementLineIdSchema });
export const matchStatementLine = defineEndpoint({
  method: "POST",
  path: `${BASE}/statement-lines/:lineId/match`,
  params: lineParams,
  body: matchStatementLineInputSchema,
  response: dataResponseSchema(bankStatementLineSchema),
});
export const excludeStatementLine = defineEndpoint({
  method: "POST",
  path: `${BASE}/statement-lines/:lineId/exclude`,
  params: lineParams,
  body: excludeStatementLineInputSchema,
  response: dataResponseSchema(bankStatementLineSchema),
});
export const unmatchStatementLine = defineEndpoint({
  method: "POST",
  path: `${BASE}/statement-lines/:lineId/unmatch`,
  params: lineParams,
  body: commandBody,
  response: dataResponseSchema(bankStatementLineSchema),
});
export const reconciliationSummarySchema = z.strictObject({
  bankAccountId: bankAccountIdSchema,
  from: businessDateSchema,
  to: businessDateSchema,
  lineCount: z.number().int().min(0),
  autoMatchedCount: z.number().int().min(0),
  manuallyMatchedCount: z.number().int().min(0),
  unmatchedCount: z.number().int().min(0),
  inCaseCount: z.number().int().min(0),
  excludedCount: z.number().int().min(0),
  /** ACC-04 progress: auto matches / lines needing a match, in basis points (floor). */
  autoMatchRateBp: z.number().int().min(0).max(10_000),
});
export const getReconciliationSummary = defineEndpoint({
  method: "GET",
  path: `${BASE}/bank-accounts/:bankAccountId/reconciliation-summary`,
  params: bankParams,
  query: z.strictObject({ from: businessDateSchema, to: businessDateSchema }),
  response: dataResponseSchema(reconciliationSummarySchema),
});

/** One gateway settlement journal as the recon screen shows it (PRD §3.19
 * "Rekonsiliasi Gateway"). Computed on the server: gross = credit lines, each
 * non-bank debit line is a fee, net = the bank GL account's debit - credit.
 * `settlementId` is the journal's sourceId (the journal id when it has none). */
export const gatewaySettlementReconRowSchema = z.strictObject({
  journalId: journalEntryIdSchema,
  settlementId: z.string().min(1),
  entryDate: businessDateSchema,
  description: z.string().min(1).max(255),
  grossIdr: idrSchema,
  fees: z.array(
    z.strictObject({ accountId: accountIdSchema, amountIdr: idrSchema }),
  ),
  /** Sum of `fees`. */
  feeIdr: idrSchema,
  netIdr: idrSchema,
  statementLineId: bankStatementLineIdSchema.nullable(),
  /** Amount of the matched bank statement line; 0 when there is none. */
  matchedAmountIdr: idrSchema,
  /** netIdr - matchedAmountIdr; non-zero is a settlement difference. */
  varianceIdr: idrSchema,
});
export const gatewaySettlementReconSchema = z.strictObject({
  rows: z.array(gatewaySettlementReconRowSchema),
  /** True when more than the 500 newest journals matched the period. */
  truncated: z.boolean(),
});
export const getGatewaySettlementRecon = defineEndpoint({
  method: "GET",
  path: `${BASE}/gateway-settlement-recon`,
  query: z.strictObject({
    legalEntityId: legalEntityIdSchema,
    bankAccountId: bankAccountIdSchema,
    from: businessDateSchema,
    to: businessDateSchema,
  }),
  response: dataResponseSchema(gatewaySettlementReconSchema),
});

export const listCashDeposits = defineEndpoint({
  method: "GET",
  path: `${BASE}/cash-deposits`,
  query: cursorPageQuerySchema.extend({
    legalEntityId: legalEntityIdSchema,
    outletId: outletIdSchema.optional(),
    from: businessDateSchema,
    to: businessDateSchema,
  }),
  response: cursorPageSchema(cashDepositSchema),
});
export const createCashDeposit = defineEndpoint({
  method: "POST",
  path: `${BASE}/cash-deposits`,
  body: createCashDepositInputSchema,
  response: dataResponseSchema(cashDepositSchema),
});
/** ACC-05 warnings for the caller's outlets. */
export const listUndepositedCashAlerts = defineEndpoint({
  method: "GET",
  path: `${BASE}/cash-deposits/alerts`,
  query: z.strictObject({
    legalEntityId: legalEntityIdSchema,
    outletId: outletIdSchema.optional(),
    asOf: businessDateSchema,
  }),
  response: list(undepositedCashAlertSchema),
});

// ---- Cash in/out, transfers and petty cash (legend-4961) ------------------------
// Cash/bank documents need `accounting.cash_bank.record` (approve/reject of a
// cash out above the limit: `accounting.cash_bank.approve`; the limit:
// `accounting.cash_bank.limit.manage`); the petty cash fund
// needs `accounting.petty_cash.manage`. Writes are tenant-scoped (bank accounts
// live on the legal entity); reads are narrowed to the caller's outlets.

const cashBankEntryParams = z.strictObject({
  entryId: cashBankEntryIdSchema,
});
export const listCashBankEntries = defineEndpoint({
  method: "GET",
  path: `${BASE}/cash-bank/entries`,
  query: cashBankEntryQuerySchema,
  response: cursorPageSchema(cashBankEntrySchema),
});
export const getCashBankEntry = defineEndpoint({
  method: "GET",
  path: `${BASE}/cash-bank/entries/:entryId`,
  params: cashBankEntryParams,
  response: dataResponseSchema(cashBankEntrySchema),
});
/** Cash in, cash out or a transfer between two bank accounts: one document, one journal. */
export const createCashBankEntry = defineEndpoint({
  method: "POST",
  path: `${BASE}/cash-bank/entries`,
  body: createCashBankEntryInputSchema,
  response: dataResponseSchema(cashBankEntrySchema),
});
/**
 * Approves a pending cash out (needs `accounting.cash_bank.approve`, not the
 * creator): posts its journal once; approving an approved entry returns it.
 */
export const approveCashBankEntry = defineEndpoint({
  method: "POST",
  path: `${BASE}/cash-bank/entries/:entryId/approve`,
  params: cashBankEntryParams,
  body: z.strictObject({}),
  response: dataResponseSchema(cashBankEntrySchema),
});
/** Rejects a pending cash out with a reason: no journal, final. */
export const rejectCashBankEntry = defineEndpoint({
  method: "POST",
  path: `${BASE}/cash-bank/entries/:entryId/reject`,
  params: cashBankEntryParams,
  body: rejectCashBankEntryInputSchema,
  response: dataResponseSchema(cashBankEntrySchema),
});
/** Cash-out approval limit of the tenant (record, approve or limit.manage). */
export const getCashOutApprovalLimit = defineEndpoint({
  method: "GET",
  path: `${BASE}/cash-bank/approval-limit`,
  response: dataResponseSchema(cashOutApprovalLimitSchema),
});
/** Sets the limit (needs `accounting.cash_bank.limit.manage`). */
export const putCashOutApprovalLimit = defineEndpoint({
  method: "PUT",
  path: `${BASE}/cash-bank/approval-limit`,
  body: putCashOutApprovalLimitInputSchema,
  response: dataResponseSchema(cashOutApprovalLimitSchema),
});

export const listPettyCashFunds = defineEndpoint({
  method: "GET",
  path: `${BASE}/petty-cash/funds`,
  query: pettyCashFundQuerySchema,
  response: list(pettyCashFundSchema),
});
export const listPettyCashEntries = defineEndpoint({
  method: "GET",
  path: `${BASE}/petty-cash/entries`,
  query: pettyCashEntryQuerySchema,
  response: cursorPageSchema(pettyCashEntrySchema),
});
/** Fund balances vs GL 1102 of one legal entity (read-only; tenant scope). */
export const getPettyCashReconciliation = defineEndpoint({
  method: "GET",
  path: `${BASE}/petty-cash/reconciliation`,
  query: pettyCashReconciliationQuerySchema,
  response: dataResponseSchema(pettyCashReconciliationSchema),
});
/**
 * Top-up from a bank account or return to it; the fund never goes below zero.
 * 201 + the ledger entry; a top-up held by the cash limit (Q7, anti-split) is
 * 202 + a `petty_topup` cash/bank entry in `pending_approval`.
 */
export const createPettyCashMovement = defineEndpoint({
  method: "POST",
  path: `${BASE}/petty-cash/movements`,
  body: pettyCashMovementInputSchema,
  response: dataResponseSchema(
    z.union([pettyCashEntrySchema, cashBankEntrySchema]),
  ),
});
/** Retry the journal of a parked top-up/return once the account map is fixed. */
export const postPettyCashEntry = defineEndpoint({
  method: "POST",
  path: `${BASE}/petty-cash/entries/:entryId/post`,
  params: z.strictObject({ entryId: pettyCashEntryIdSchema }),
  body: z.strictObject({}),
  response: dataResponseSchema(pettyCashEntrySchema),
});

const caseParams = z.strictObject({ caseId: reconciliationCaseIdSchema });
export const listReconciliationCases = defineEndpoint({
  method: "GET",
  path: `${BASE}/reconciliation-cases`,
  query: cursorPageQuerySchema.extend({
    legalEntityId: legalEntityIdSchema,
    status: reconciliationCaseStatusSchema.optional(),
    outletId: outletIdSchema.optional(),
  }),
  response: cursorPageSchema(reconciliationCaseSchema),
});
export const openReconciliationCase = defineEndpoint({
  method: "POST",
  path: `${BASE}/reconciliation-cases`,
  body: openReconciliationCaseInputSchema,
  response: dataResponseSchema(reconciliationCaseSchema),
});
export const getReconciliationCase = defineEndpoint({
  method: "GET",
  path: `${BASE}/reconciliation-cases/:caseId`,
  params: caseParams,
  response: dataResponseSchema(reconciliationCaseSchema),
});
export const actOnReconciliationCase = defineEndpoint({
  method: "POST",
  path: `${BASE}/reconciliation-cases/:caseId/actions`,
  params: caseParams,
  body: reconciliationCaseActionInputSchema,
  response: dataResponseSchema(reconciliationCaseSchema),
});

// ---- AP / AR ---------------------------------------------------------------

export const getAgingReport = defineEndpoint({
  method: "GET",
  path: `${BASE}/aging`,
  query: z.strictObject({
    legalEntityId: legalEntityIdSchema,
    kind: openItemKindSchema,
    asOf: businessDateSchema,
    outletId: outletIdSchema.optional(),
  }),
  response: dataResponseSchema(agingReportSchema),
});
/**
 * Open invoices behind the aging report: one row per document with money
 * still outstanding, oldest due date first (ties by id). `asOf` replays the
 * past like the aging report; omitted = today's state.
 */
export const listOpenItems = defineEndpoint({
  method: "GET",
  path: `${BASE}/open-items`,
  query: cursorPageQuerySchema.extend({
    legalEntityId: legalEntityIdSchema,
    kind: openItemKindSchema,
    counterpartyId: uuidSchema.optional(),
    outletId: outletIdSchema.optional(),
    asOf: businessDateSchema.optional(),
  }),
  response: cursorPageSchema(openItemListRowSchema),
});

// ---- Fixed assets ----------------------------------------------------------

const assetParams = z.strictObject({ fixedAssetId: fixedAssetIdSchema });
export const fixedAssetDetailSchema = z.strictObject({
  asset: fixedAssetSchema,
  schedule: z.array(
    z.strictObject({ period: periodKeySchema, amountIdr: z.number().int() }),
  ),
});
export const listFixedAssets = defineEndpoint({
  method: "GET",
  path: `${BASE}/legal-entities/:legalEntityId/fixed-assets`,
  params: entityParams,
  response: list(fixedAssetSchema),
});
export const createFixedAsset = defineEndpoint({
  method: "POST",
  path: `${BASE}/fixed-assets`,
  body: createFixedAssetInputSchema,
  response: dataResponseSchema(fixedAssetSchema),
});
export const getFixedAsset = defineEndpoint({
  method: "GET",
  path: `${BASE}/fixed-assets/:fixedAssetId`,
  params: assetParams,
  response: dataResponseSchema(fixedAssetDetailSchema),
});
export const disposeFixedAsset = defineEndpoint({
  method: "POST",
  path: `${BASE}/fixed-assets/:fixedAssetId/dispose`,
  params: assetParams,
  body: disposeFixedAssetInputSchema,
  response: dataResponseSchema(fixedAssetSchema),
});
export const revalueFixedAsset = defineEndpoint({
  method: "POST",
  path: `${BASE}/fixed-assets/:fixedAssetId/revalue`,
  params: assetParams,
  body: revalueFixedAssetInputSchema,
  response: dataResponseSchema(fixedAssetSchema),
});
export const listAssetCategories = defineEndpoint({
  method: "GET",
  path: `${BASE}/asset-categories`,
  response: list(assetCategorySchema),
});
export const createAssetCategory = defineEndpoint({
  method: "POST",
  path: `${BASE}/asset-categories`,
  body: createAssetCategoryInputSchema,
  response: dataResponseSchema(assetCategorySchema),
});
export const listDepreciationRuns = defineEndpoint({
  method: "GET",
  path: `${BASE}/legal-entities/:legalEntityId/depreciation-runs`,
  params: entityParams,
  response: list(depreciationRunSchema),
});
export const runDepreciation = defineEndpoint({
  method: "POST",
  path: `${BASE}/depreciation-runs`,
  body: runDepreciationInputSchema,
  response: dataResponseSchema(depreciationRunSchema),
});

// ---- Budgets ---------------------------------------------------------------

export const listBudgets = defineEndpoint({
  method: "GET",
  path: `${BASE}/budgets`,
  query: z.strictObject({
    legalEntityId: legalEntityIdSchema,
    period: periodKeySchema,
    outletId: outletIdSchema.optional(),
  }),
  response: list(budgetSchema),
});
export const upsertBudgets = defineEndpoint({
  method: "PUT",
  path: `${BASE}/budgets`,
  body: upsertBudgetsInputSchema,
  response: list(budgetSchema),
});
export const getBudgetVsActual = defineEndpoint({
  method: "GET",
  path: `${BASE}/budgets/vs-actual`,
  query: z.strictObject({
    legalEntityId: legalEntityIdSchema,
    period: periodKeySchema,
    outletId: outletIdSchema.optional(),
  }),
  response: list(budgetVsActualRowSchema),
});

// ---- Finance policy ----------------------------------------------------------

/** Tenant policy: bank matching date tolerance + ACC-05 undeposited-cash limit. */
export const getFinancePolicy = defineEndpoint({
  method: "GET",
  path: `${BASE}/finance-policy`,
  response: dataResponseSchema(financePolicySchema),
});
export const putFinancePolicy = defineEndpoint({
  method: "PUT",
  path: `${BASE}/finance-policy`,
  body: putFinancePolicyInputSchema,
  response: dataResponseSchema(financePolicySchema),
});

// ---- Statements --------------------------------------------------------------

export const getTrialBalance = defineEndpoint({
  method: "GET",
  path: `${BASE}/statements/trial-balance`,
  query: z.strictObject({
    legalEntityId: legalEntityIdSchema,
    asOf: businessDateSchema,
  }),
  response: dataResponseSchema(trialBalanceSchema),
});
export const getBalanceSheet = defineEndpoint({
  method: "GET",
  path: `${BASE}/statements/balance-sheet`,
  query: z.strictObject({
    legalEntityId: legalEntityIdSchema,
    asOf: businessDateSchema,
  }),
  response: dataResponseSchema(balanceSheetSchema),
});
export const getProfitAndLoss = defineEndpoint({
  method: "GET",
  path: `${BASE}/statements/profit-and-loss`,
  query: statementQuerySchema,
  response: dataResponseSchema(profitAndLossSchema),
});
export const getMultiEntityProfitAndLoss = defineEndpoint({
  method: "GET",
  path: `${BASE}/statements/profit-and-loss/multi-entity`,
  query: z.strictObject({ from: businessDateSchema, to: businessDateSchema }),
  response: dataResponseSchema(multiEntityProfitAndLossSchema),
});
export const getCashFlow = defineEndpoint({
  method: "GET",
  path: `${BASE}/statements/cash-flow`,
  query: statementQuerySchema.omit({ outletId: true }),
  response: dataResponseSchema(cashFlowStatementSchema),
});
export const getEquityChanges = defineEndpoint({
  method: "GET",
  path: `${BASE}/statements/equity-changes`,
  query: statementQuerySchema.omit({ outletId: true }),
  response: dataResponseSchema(equityChangesSchema),
});
/** ACC-03: statement row → journal lines → source document. */
export const getStatementDrillDown = defineEndpoint({
  method: "GET",
  path: `${BASE}/statements/drill-down`,
  query: drillDownQuerySchema,
  response: cursorPageSchema(drillDownLineSchema),
});

// ---- Tax ---------------------------------------------------------------------

const taxParams = z.strictObject({ taxReportId: taxReportIdSchema });
export const listTaxReports = defineEndpoint({
  method: "GET",
  path: `${BASE}/tax-reports`,
  query: z.strictObject({
    legalEntityId: legalEntityIdSchema,
    type: taxReportTypeSchema.optional(),
    status: taxReportStatusSchema.optional(),
    /** Superseded revisions are hidden unless asked for (audit history). */
    includeSuperseded: z.stringbool().optional(),
  }),
  response: list(taxReportSchema),
});
export const generateTaxReport = defineEndpoint({
  method: "POST",
  path: `${BASE}/tax-reports`,
  body: generateTaxReportInputSchema,
  response: dataResponseSchema(taxReportSchema),
});
export const finalizeTaxReport = defineEndpoint({
  method: "POST",
  path: `${BASE}/tax-reports/:taxReportId/finalize`,
  params: taxParams,
  body: finalizeTaxReportBodySchema,
  response: dataResponseSchema(taxReportSchema),
});
export const exportTaxReport = defineEndpoint({
  method: "POST",
  path: `${BASE}/tax-reports/:taxReportId/export`,
  params: taxParams,
  body: commandBody,
  response: dataResponseSchema(taxReportExportSchema),
});
export const downloadTaxReport = defineEndpoint({
  method: "GET",
  path: `${BASE}/tax-reports/:taxReportId/download`,
  params: taxParams,
  response: dataResponseSchema(taxReportDownloadSchema),
});

/** Every accounting endpoint, for registries and route-coverage tests. */
export const accountingEndpoints = Object.freeze({
  listLegalEntities,
  listAccounts,
  createAccount,
  updateAccount,
  listAccountMappings,
  replaceAccountMappings,
  listJournals,
  getJournal,
  reverseJournal,
  listManualJournals,
  createManualJournal,
  getManualJournal,
  updateManualJournal,
  submitManualJournal,
  withdrawManualJournal,
  approveManualJournal,
  cancelManualJournal,
  rejectManualJournal,
  listRecurringJournals,
  createRecurringJournal,
  transitionRecurringJournalEndpoint,
  skipRecurringJournalPeriodEndpoint,
  listFiscalPeriods,
  closeFiscalPeriod,
  getPeriodSnapshot,
  requestPeriodReopen,
  listPeriodReopenRequests,
  approvePeriodReopen,
  rejectPeriodReopen,
  listBankAccounts,
  createBankAccount,
  importBankStatement,
  listStatementLines,
  matchStatementLine,
  excludeStatementLine,
  unmatchStatementLine,
  getReconciliationSummary,
  getGatewaySettlementRecon,
  listCashDeposits,
  createCashDeposit,
  listUndepositedCashAlerts,
  listCashBankEntries,
  getCashBankEntry,
  createCashBankEntry,
  approveCashBankEntry,
  rejectCashBankEntry,
  getCashOutApprovalLimit,
  putCashOutApprovalLimit,
  listPettyCashFunds,
  listPettyCashEntries,
  getPettyCashReconciliation,
  createPettyCashMovement,
  postPettyCashEntry,
  listReconciliationCases,
  openReconciliationCase,
  getReconciliationCase,
  actOnReconciliationCase,
  getAgingReport,
  listOpenItems,
  listFixedAssets,
  createFixedAsset,
  getFixedAsset,
  disposeFixedAsset,
  revalueFixedAsset,
  listAssetCategories,
  createAssetCategory,
  listDepreciationRuns,
  runDepreciation,
  listBudgets,
  upsertBudgets,
  getBudgetVsActual,
  getFinancePolicy,
  putFinancePolicy,
  getTrialBalance,
  getBalanceSheet,
  getProfitAndLoss,
  getMultiEntityProfitAndLoss,
  getCashFlow,
  getEquityChanges,
  getStatementDrillDown,
  listTaxReports,
  generateTaxReport,
  finalizeTaxReport,
  exportTaxReport,
  downloadTaxReport,
});
