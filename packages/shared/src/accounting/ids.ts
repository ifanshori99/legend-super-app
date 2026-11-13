// Ids owned by the accounting contract (PRD v1.7 §6 F Akuntansi). Every
// accounting row is a UUID aggregate (D-CORE-1). Legal entities belong to the
// platform contract (§6 A `legal_entities`, bead legend-q88); the branded type
// is declared here too because every ledger row is keyed by it. Same brand
// name, so both declarations are one type.

import { uuidIdSchema } from "../core/index.ts";
import type { z } from "zod";

export const legalEntityIdSchema = uuidIdSchema<"LegalEntityId">();
export const accountIdSchema = uuidIdSchema<"AccountId">();
export const journalEntryIdSchema = uuidIdSchema<"JournalEntryId">();
export const journalLineIdSchema = uuidIdSchema<"JournalLineId">();
export const manualJournalIdSchema = uuidIdSchema<"ManualJournalId">();
export const recurringJournalIdSchema = uuidIdSchema<"RecurringJournalId">();
export const fiscalPeriodIdSchema = uuidIdSchema<"FiscalPeriodId">();
export const periodReopenRequestIdSchema =
  uuidIdSchema<"PeriodReopenRequestId">();
export const bankAccountIdSchema = uuidIdSchema<"BankAccountId">();
export const bankStatementImportIdSchema =
  uuidIdSchema<"BankStatementImportId">();
export const bankStatementLineIdSchema = uuidIdSchema<"BankStatementLineId">();
export const cashDepositIdSchema = uuidIdSchema<"CashDepositId">();
export const cashBankEntryIdSchema = uuidIdSchema<"CashBankEntryId">();
export const pettyCashFundIdSchema = uuidIdSchema<"PettyCashFundId">();
export const pettyCashEntryIdSchema = uuidIdSchema<"PettyCashEntryId">();
export const reconciliationCaseIdSchema =
  uuidIdSchema<"ReconciliationCaseId">();
export const fixedAssetIdSchema = uuidIdSchema<"FixedAssetId">();
export const depreciationRunIdSchema = uuidIdSchema<"DepreciationRunId">();
export const budgetIdSchema = uuidIdSchema<"BudgetId">();
export const taxReportIdSchema = uuidIdSchema<"TaxReportId">();
// Profit share & dividends (PRD §6 I).
export const profitEntityIdSchema = uuidIdSchema<"ProfitEntityId">();
export const shareholderIdSchema = uuidIdSchema<"ShareholderId">();
export const shareAllocationIdSchema = uuidIdSchema<"ShareAllocationId">();
export const distributionRunIdSchema = uuidIdSchema<"DistributionRunId">();
export const distributionLineIdSchema = uuidIdSchema<"DistributionLineId">();
export const shareholderDocumentIdSchema =
  uuidIdSchema<"ShareholderDocumentId">();

export type LegalEntityId = z.infer<typeof legalEntityIdSchema>;
export type AccountId = z.infer<typeof accountIdSchema>;
export type JournalEntryId = z.infer<typeof journalEntryIdSchema>;
export type JournalLineId = z.infer<typeof journalLineIdSchema>;
export type ManualJournalId = z.infer<typeof manualJournalIdSchema>;
export type RecurringJournalId = z.infer<typeof recurringJournalIdSchema>;
export type FiscalPeriodId = z.infer<typeof fiscalPeriodIdSchema>;
export type PeriodReopenRequestId = z.infer<typeof periodReopenRequestIdSchema>;
export type BankAccountId = z.infer<typeof bankAccountIdSchema>;
export type BankStatementImportId = z.infer<typeof bankStatementImportIdSchema>;
export type BankStatementLineId = z.infer<typeof bankStatementLineIdSchema>;
export type CashDepositId = z.infer<typeof cashDepositIdSchema>;
export type CashBankEntryId = z.infer<typeof cashBankEntryIdSchema>;
export type PettyCashFundId = z.infer<typeof pettyCashFundIdSchema>;
export type PettyCashEntryId = z.infer<typeof pettyCashEntryIdSchema>;
export type ReconciliationCaseId = z.infer<typeof reconciliationCaseIdSchema>;
export type FixedAssetId = z.infer<typeof fixedAssetIdSchema>;
export type DepreciationRunId = z.infer<typeof depreciationRunIdSchema>;
export type BudgetId = z.infer<typeof budgetIdSchema>;
export type TaxReportId = z.infer<typeof taxReportIdSchema>;
export type ProfitEntityId = z.infer<typeof profitEntityIdSchema>;
export type ShareholderId = z.infer<typeof shareholderIdSchema>;
export type ShareAllocationId = z.infer<typeof shareAllocationIdSchema>;
export type DistributionRunId = z.infer<typeof distributionRunIdSchema>;
export type DistributionLineId = z.infer<typeof distributionLineIdSchema>;
export type ShareholderDocumentId = z.infer<typeof shareholderDocumentIdSchema>;
