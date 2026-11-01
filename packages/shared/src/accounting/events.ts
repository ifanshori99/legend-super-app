// Accounting domain events (WS-07 line of events/catalog.ts). Payloads are
// JSON only; amounts are whole rupiah. The `distribution.*` events belong to
// the profit-share contract (bead legend-cq2, profit-share-events.ts).

import { z } from "zod";
import {
  businessDateSchema,
  idrSchema,
  isoDateTimeSchema,
  outletIdSchema,
  userIdSchema,
} from "../core/index.ts";
import { defineDomainEvent } from "../events/define.ts";
import { reconciliationCaseTypeSchema } from "./banking.ts";
import {
  bankAccountIdSchema,
  bankStatementImportIdSchema,
  bankStatementLineIdSchema,
  cashDepositIdSchema,
  depreciationRunIdSchema,
  fiscalPeriodIdSchema,
  journalEntryIdSchema,
  legalEntityIdSchema,
  periodReopenRequestIdSchema,
  reconciliationCaseIdSchema,
  taxReportIdSchema,
} from "./ids.ts";
import { journalSourceIdSchema, journalSourceTypeSchema } from "./journal.ts";
import { periodKeySchema } from "./period-key.ts";
import { taxReportTypeSchema } from "./tax.ts";

export const journalPostedEvent = defineDomainEvent({
  name: "journal.posted",
  payload: z.strictObject({
    journalEntryId: journalEntryIdSchema,
    legalEntityId: legalEntityIdSchema,
    outletId: outletIdSchema.nullable(),
    fiscalPeriodId: fiscalPeriodIdSchema,
    entryDate: businessDateSchema,
    sourceType: journalSourceTypeSchema,
    sourceId: journalSourceIdSchema.nullable(),
    reversalOf: journalEntryIdSchema.nullable(),
    totalIdr: idrSchema,
    lineCount: z.number().int().min(2),
  }),
});

export const fiscalPeriodClosedEvent = defineDomainEvent({
  name: "fiscal_period.closed",
  payload: z.strictObject({
    fiscalPeriodId: fiscalPeriodIdSchema,
    legalEntityId: legalEntityIdSchema,
    period: periodKeySchema,
    version: z.number().int().min(2),
    closedBy: userIdSchema,
    closedAt: isoDateTimeSchema,
  }),
});

export const fiscalPeriodReopenedEvent = defineDomainEvent({
  name: "fiscal_period.reopened",
  payload: z.strictObject({
    fiscalPeriodId: fiscalPeriodIdSchema,
    legalEntityId: legalEntityIdSchema,
    period: periodKeySchema,
    version: z.number().int().min(3),
    reopenRequestId: periodReopenRequestIdSchema,
    reason: z.string().min(1).max(500),
    requestedBy: userIdSchema,
    approvedBy: userIdSchema,
  }),
});

export const bankStatementImportedEvent = defineDomainEvent({
  name: "bank_statement.imported",
  payload: z.strictObject({
    importId: bankStatementImportIdSchema,
    bankAccountId: bankAccountIdSchema,
    lineCount: z.number().int().min(0),
    duplicateCount: z.number().int().min(0),
    autoMatchedCount: z.number().int().min(0),
  }),
});

export const cashDepositRecordedEvent = defineDomainEvent({
  name: "cash_deposit.recorded",
  payload: z.strictObject({
    cashDepositId: cashDepositIdSchema,
    outletId: outletIdSchema,
    bankAccountId: bankAccountIdSchema,
    amountIdr: idrSchema,
    coversFrom: businessDateSchema,
    coversTo: businessDateSchema,
  }),
});

export const cashDepositMatchedEvent = defineDomainEvent({
  name: "cash_deposit.matched",
  payload: z.strictObject({
    cashDepositId: cashDepositIdSchema,
    bankStatementLineId: bankStatementLineIdSchema,
    outletId: outletIdSchema,
    amountIdr: idrSchema,
  }),
});

export const reconciliationCaseOpenedEvent = defineDomainEvent({
  name: "reconciliation_case.opened",
  payload: z.strictObject({
    reconciliationCaseId: reconciliationCaseIdSchema,
    legalEntityId: legalEntityIdSchema,
    outletId: outletIdSchema.nullable(),
    type: reconciliationCaseTypeSchema,
    differenceIdr: idrSchema,
    ownerId: userIdSchema,
    dueAt: isoDateTimeSchema,
  }),
});

export const reconciliationCaseResolvedEvent = defineDomainEvent({
  name: "reconciliation_case.resolved",
  payload: z.strictObject({
    reconciliationCaseId: reconciliationCaseIdSchema,
    status: z.enum(["resolved", "written_off"]),
    resolvedBy: userIdSchema,
    adjustmentJournalEntryId: journalEntryIdSchema.nullable(),
  }),
});

export const depreciationRunPostedEvent = defineDomainEvent({
  name: "depreciation_run.posted",
  payload: z.strictObject({
    depreciationRunId: depreciationRunIdSchema,
    legalEntityId: legalEntityIdSchema,
    period: periodKeySchema,
    amountIdr: idrSchema,
    journalEntryId: journalEntryIdSchema.nullable(),
  }),
});

export const taxReportExportedEvent = defineDomainEvent({
  name: "tax_report.exported",
  payload: z.strictObject({
    taxReportId: taxReportIdSchema,
    legalEntityId: legalEntityIdSchema,
    type: taxReportTypeSchema,
    period: periodKeySchema,
    amountIdr: idrSchema,
  }),
});

export const ACCOUNTING_EVENTS = {
  "journal.posted": journalPostedEvent,
  "fiscal_period.closed": fiscalPeriodClosedEvent,
  "fiscal_period.reopened": fiscalPeriodReopenedEvent,
  "bank_statement.imported": bankStatementImportedEvent,
  "cash_deposit.recorded": cashDepositRecordedEvent,
  "cash_deposit.matched": cashDepositMatchedEvent,
  "reconciliation_case.opened": reconciliationCaseOpenedEvent,
  "reconciliation_case.resolved": reconciliationCaseResolvedEvent,
  "depreciation_run.posted": depreciationRunPostedEvent,
  "tax_report.exported": taxReportExportedEvent,
} as const;
export type AccountingEventName = keyof typeof ACCOUNTING_EVENTS;
