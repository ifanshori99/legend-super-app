// Cash & bank: bank accounts, statement import (CSV), matching, cash deposits
// and reconciliation cases (PRD v1.7 §3.19 "Kas & Bank [P0]", "Rekonsiliasi
// Gateway [P0]"; §6 F `bank_accounts`, `bank_statement_lines`,
// `cash_deposits`, `reconciliation_cases`; ACC-04, ACC-05).
//
// - Account numbers are stored encrypted (§6 F account_number_encrypted) and
//   only travel masked (`••••1234` as "****1234"). Create input carries the
//   number once.
// - Statement amounts are signed whole rupiah: positive = money in.
// - Matching, tolerance days, the overdue-deposit limit and case due days are
//   tenant data (policies below), never code.

import { z } from "zod";
import {
  businessDateSchema,
  cursorPageQuerySchema,
  idempotencyKeySchema,
  idrSchema,
  isoDateTimeSchema,
  outletIdSchema,
  tenantIdSchema,
  userIdSchema,
  uuidSchema,
} from "../core/index.ts";
import type { Idr, OutletId, UserId } from "../core/index.ts";
import { AccountingError } from "./errors.ts";
import {
  accountIdSchema,
  bankAccountIdSchema,
  bankStatementImportIdSchema,
  bankStatementLineIdSchema,
  cashBankEntryIdSchema,
  cashDepositIdSchema,
  journalEntryIdSchema,
  legalEntityIdSchema,
  pettyCashEntryIdSchema,
  pettyCashFundIdSchema,
  reconciliationCaseIdSchema,
} from "./ids.ts";
import { assertJournalBalanced } from "./journal.ts";
import type { JournalLineInput } from "./journal.ts";
import { daysBetween } from "./period-key.ts";

const positiveIdr = idrSchema.refine(
  (value) => value > 0,
  "Amount must be > 0",
);
const nonZeroIdr = idrSchema.refine(
  (value) => value !== 0,
  "Amount must not be 0",
);

// ---- Bank accounts ---------------------------------------------------------

export const maskedAccountNumberSchema = z
  .string()
  .regex(/^\*{4}\d{4}$/, "Masked as ****1234");

export const bankAccountSchema = z.strictObject({
  id: bankAccountIdSchema,
  tenantId: tenantIdSchema,
  legalEntityId: legalEntityIdSchema,
  /** Bank name as shown (BCA, Mandiri, BNI, BJB, …); a list is tenant data. */
  bank: z.string().trim().min(2).max(50),
  accountName: z.string().trim().min(1).max(150),
  accountNumberMasked: maskedAccountNumberSchema,
  /** CoA account this bank account posts to (role `bank` or another cash account). */
  glAccountId: accountIdSchema,
  isActive: z.boolean(),
});
export type BankAccount = z.infer<typeof bankAccountSchema>;

export const createBankAccountInputSchema = z.strictObject({
  legalEntityId: legalEntityIdSchema,
  bank: z.string().trim().min(2).max(50),
  accountName: z.string().trim().min(1).max(150),
  /** Digits only; encrypted at rest, never returned. */
  accountNumber: z.string().regex(/^\d{6,20}$/),
  glAccountId: accountIdSchema,
});

/** "1234567890" → "****7890". */
export function maskAccountNumber(accountNumber: string): string {
  if (!/^\d{4,}$/.test(accountNumber))
    throw new RangeError("Account number must be digits");
  return `****${accountNumber.slice(-4)}`;
}

// ---- Statement import (CSV) -----------------------------------------------

/** How one bank's CSV export is read; saved per bank account (tenant data). */
export const bankCsvMappingSchema = z.strictObject({
  hasHeader: z.boolean(),
  delimiter: z.enum([",", ";", "\t"]),
  dateColumn: z.number().int().min(0).max(50),
  dateFormat: z.enum(["DD/MM/YYYY", "DD-MM-YYYY", "YYYY-MM-DD"]),
  descriptionColumn: z.number().int().min(0).max(50),
  /** One signed amount column, or separate debit (out) / credit (in) columns. */
  amount: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("signed"),
      column: z.number().int().min(0).max(50),
    }),
    z.strictObject({
      kind: z.literal("debit_credit"),
      debitColumn: z.number().int().min(0).max(50),
      creditColumn: z.number().int().min(0).max(50),
    }),
  ]),
  decimalSeparator: z.enum([",", "."]),
  referenceColumn: z.number().int().min(0).max(50).nullable(),
});
export type BankCsvMapping = z.infer<typeof bankCsvMappingSchema>;

/**
 * Bank CSV amount → whole rupiah. "1.250.000,00" with "," decimals → 1250000.
 * A non-zero fraction is refused (STATEMENT_VALUE_INVALID) instead of rounded:
 * IDR statements carry ",00", anything else means a misread column.
 *
 * Strict grammar (anything else is STATEMENT_VALUE_INVALID):
 *   whole    = 1-3 digits then one or more `<thousands>` + 3-digit groups, or
 *              plain digits ("1.234.567", "1234567"); at least one digit
 *   fraction = optional `<decimalSeparator>` + 1 or 2 digits (never 3+)
 * So "1.2.3", "12..3", "1,", ",5" and "" are refused, and the thousands
 * separator never doubles as a decimal one: with "," decimals "1.234" is
 * 1234, with "." decimals it is a 3-digit fraction and refused.
 */
export function parseBankCsvAmount(
  text: string,
  decimalSeparator: "," | ".",
): Idr {
  const thousands = decimalSeparator === "," ? "." : ",";
  // Sign: one "(...)" wrapper or one "-" (before or after "Rp"), never both.
  // "Rp" is only a prefix; spaces are allowed only around it and the wrapper,
  // so "12 34" (two misread columns) is refused instead of read as 1234.
  let value = text.trim();
  const wrapped = /^\(.*\)$/.test(value);
  if (wrapped) value = value.slice(1, -1).trim();
  let minus = 0;
  if (value.startsWith("-")) {
    minus += 1;
    value = value.slice(1);
  }
  value = value.replace(/^Rp\s*/i, "");
  if (value.startsWith("-")) {
    minus += 1;
    value = value.slice(1);
  }
  if (minus > 1 || (wrapped && minus > 0))
    throw new AccountingError("STATEMENT_VALUE_INVALID");
  const negative = wrapped || minus === 1;
  const escape = (separator: string) => `\\${separator}`;
  const grammar = new RegExp(
    `^(\\d{1,3}(?:${escape(thousands)}\\d{3})+|\\d+)(?:${escape(decimalSeparator)}(\\d{1,2}))?$`,
  );
  const match = grammar.exec(value);
  if (!match) throw new AccountingError("STATEMENT_VALUE_INVALID");
  const [, groupedWhole, fraction = ""] = match;
  if (/[1-9]/.test(fraction))
    throw new AccountingError("STATEMENT_VALUE_INVALID");
  const whole = groupedWhole.split(thousands).join("");
  const amount = Number(whole);
  if (!Number.isSafeInteger(amount))
    throw new AccountingError("STATEMENT_VALUE_INVALID");
  return (negative && amount !== 0 ? -amount : amount) as Idr;
}

/** Bank CSV date → YYYY-MM-DD; invalid calendar dates are refused. */
export function parseBankCsvDate(
  text: string,
  format: BankCsvMapping["dateFormat"],
): string {
  const value = text.trim();
  const parts =
    format === "YYYY-MM-DD"
      ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)?.slice(1)
      : (format === "DD/MM/YYYY"
          ? /^(\d{2})\/(\d{2})\/(\d{4})$/
          : /^(\d{2})-(\d{2})-(\d{4})$/
        )
          .exec(value)
          ?.slice(1)
          .reverse();
  const iso = parts ? `${parts[0]}-${parts[1]}-${parts[2]}` : "";
  if (!businessDateSchema.safeParse(iso).success)
    throw new AccountingError("STATEMENT_VALUE_INVALID");
  return iso;
}

/**
 * Idempotent import key of one statement line (unique per bank account).
 * `occurrence` counts identical rows inside one file (1, 2, …) so two real
 * Rp15.000 admin fees on one day are kept while a re-upload adds nothing.
 */
export function statementLineDedupeKey(line: {
  postedOn: string;
  amountIdr: number;
  description: string;
  externalRef: string | null;
  occurrence: number;
}): string {
  const description = line.description
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
  return [
    line.postedOn,
    line.amountIdr,
    description,
    line.externalRef ?? "",
    line.occurrence,
  ].join("|");
}

export const MATCH_STATUSES = [
  "unmatched",
  "auto_matched",
  "manually_matched",
  "in_case",
  "excluded",
] as const;
export const matchStatusSchema = z.enum(MATCH_STATUSES);
export type MatchStatus = z.infer<typeof matchStatusSchema>;

/** What a statement line or recon case points at. */
export const reconciliationRefSchema = z.strictObject({
  type: z.enum([
    "journal_entry",
    "cash_deposit",
    "gateway_settlement",
    "edc_settlement",
    "supplier_payment",
    "bank_statement_line",
  ]),
  id: uuidSchema,
});
export type ReconciliationRef = z.infer<typeof reconciliationRefSchema>;

export const bankStatementLineSchema = z
  .strictObject({
    id: bankStatementLineIdSchema,
    tenantId: tenantIdSchema,
    bankAccountId: bankAccountIdSchema,
    importId: bankStatementImportIdSchema,
    postedOn: businessDateSchema,
    amountIdr: nonZeroIdr,
    description: z.string().trim().min(1).max(255),
    externalRef: z.string().trim().min(1).max(100).nullable(),
    dedupeKey: z.string().min(1).max(400),
    matchStatus: matchStatusSchema,
    matchedRefs: z.array(reconciliationRefSchema),
    reconciliationCaseId: reconciliationCaseIdSchema.nullable(),
    excludedReason: z.string().trim().min(1).max(200).nullable(),
  })
  .superRefine((line, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    const matched =
      line.matchStatus === "auto_matched" ||
      line.matchStatus === "manually_matched";
    if (matched !== line.matchedRefs.length > 0)
      issue("matchedRefs", "matchedRefs are set exactly when matched");
    if ((line.matchStatus === "excluded") !== (line.excludedReason !== null))
      issue("excludedReason", "excludedReason is set exactly when excluded");
    if (
      (line.matchStatus === "in_case") !==
      (line.reconciliationCaseId !== null)
    )
      issue("reconciliationCaseId", "case id is set exactly when in_case");
  });
export type BankStatementLine = z.infer<typeof bankStatementLineSchema>;

export const bankStatementImportSchema = z.strictObject({
  id: bankStatementImportIdSchema,
  tenantId: tenantIdSchema,
  bankAccountId: bankAccountIdSchema,
  fileName: z.string().trim().min(1).max(150),
  importedBy: userIdSchema,
  importedAt: isoDateTimeSchema,
  lineCount: z.number().int().min(0),
  duplicateCount: z.number().int().min(0),
  autoMatchedCount: z.number().int().min(0),
  postedFrom: businessDateSchema.nullable(),
  postedTo: businessDateSchema.nullable(),
});
export type BankStatementImport = z.infer<typeof bankStatementImportSchema>;

/** CSV body ≤ 90 kB so it fits the 100 kB API body cap. */
export const importBankStatementInputSchema = z.strictObject({
  fileName: z.string().trim().min(1).max(150),
  csv: z.string().min(1).max(90_000),
  mapping: bankCsvMappingSchema,
  idempotencyKey: idempotencyKeySchema,
});

export const matchStatementLineInputSchema = z.strictObject({
  refs: z.array(reconciliationRefSchema).min(1).max(50),
});
export const excludeStatementLineInputSchema = z.strictObject({
  reason: z.string().trim().min(1).max(200),
});

// ---- Matching (ACC-04) -----------------------------------------------------

/** Tenant data: how wide the date window for an automatic match is. */
export const matchingPolicySchema = z.strictObject({
  dateToleranceDays: z.number().int().min(0).max(14),
});
export type MatchingPolicy = z.infer<typeof matchingPolicySchema>;

export type MatchCandidate = {
  ref: ReconciliationRef;
  amountIdr: number;
  date: string;
};
export type MatchOutcome =
  | { kind: "auto"; ref: ReconciliationRef }
  | { kind: "ambiguous"; refs: ReconciliationRef[] }
  | { kind: "none" };

/**
 * Automatic match: same amount and within the date window. Exactly one
 * candidate → auto match; several → a person decides (never guess); none →
 * unmatched. Candidates already matched elsewhere are filtered by the caller.
 */
export function findStatementMatch(
  line: { amountIdr: number; postedOn: string },
  candidates: readonly MatchCandidate[],
  policy: MatchingPolicy,
): MatchOutcome {
  const hits = candidates.filter(
    (candidate) =>
      candidate.amountIdr === line.amountIdr &&
      Math.abs(daysBetween(candidate.date, line.postedOn)) <=
        policy.dateToleranceDays,
  );
  if (hits.length === 1) return { kind: "auto", ref: hits[0].ref };
  if (hits.length > 1)
    return { kind: "ambiguous", refs: hits.map((hit) => hit.ref) };
  return { kind: "none" };
}

/** Manual match: the chosen documents must add up to the line exactly. */
export function assertManualMatch(
  line: Pick<BankStatementLine, "amountIdr" | "matchStatus">,
  documents: readonly { amountIdr: number }[],
): void {
  if (
    line.matchStatus === "auto_matched" ||
    line.matchStatus === "manually_matched"
  )
    throw new AccountingError("STATEMENT_LINE_ALREADY_MATCHED");
  const total = documents.reduce((sum, doc) => sum + BigInt(doc.amountIdr), 0n);
  if (documents.length === 0 || total !== BigInt(line.amountIdr))
    throw new AccountingError("MATCH_AMOUNT_MISMATCH");
}

/** PRD ACC-04 target: ≥ 99% automatic matches. */
export const AUTO_MATCH_TARGET_BP = 9_900;

/**
 * Auto-match rate in basis points over lines that need matching (excluded
 * lines do not count). Rounded `floor`, so the rate never overstates ACC-04.
 * No lines → 10,000 (nothing left to match).
 */
export function autoMatchRateBp(
  lines: readonly Pick<BankStatementLine, "matchStatus">[],
): number {
  const relevant = lines.filter((line) => line.matchStatus !== "excluded");
  if (relevant.length === 0) return 10_000;
  const auto = relevant.filter((line) => line.matchStatus === "auto_matched");
  return Math.floor((auto.length * 10_000) / relevant.length);
}

// ---- Cash deposits (ACC-05) ------------------------------------------------

export const cashDepositStatusSchema = z.enum([
  "recorded",
  "matched",
  "discrepancy",
]);
export type CashDepositStatus = z.infer<typeof cashDepositStatusSchema>;

export const cashDepositSchema = z
  .strictObject({
    id: cashDepositIdSchema,
    tenantId: tenantIdSchema,
    legalEntityId: legalEntityIdSchema,
    outletId: outletIdSchema,
    bankAccountId: bankAccountIdSchema,
    amountIdr: positiveIdr,
    /** Business dates whose cash sales this deposit carries. */
    coversFrom: businessDateSchema,
    coversTo: businessDateSchema,
    depositedAt: isoDateTimeSchema,
    depositedBy: userIdSchema,
    /** Slip/receipt number from the bank teller or ATM, if any. */
    slipReference: z.string().trim().min(1).max(60).nullable(),
    bankStatementLineId: bankStatementLineIdSchema.nullable(),
    reconciliationCaseId: reconciliationCaseIdSchema.nullable(),
    journalEntryId: journalEntryIdSchema.nullable(),
    status: cashDepositStatusSchema,
  })
  .superRefine((row, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (row.coversTo < row.coversFrom)
      issue("coversTo", "coversTo must not be before coversFrom");
    if ((row.status === "matched") !== (row.bankStatementLineId !== null))
      issue(
        "bankStatementLineId",
        "statement line is set exactly when matched",
      );
    if ((row.status === "discrepancy") !== (row.reconciliationCaseId !== null))
      issue("reconciliationCaseId", "case is set exactly on discrepancy");
  });
export type CashDeposit = z.infer<typeof cashDepositSchema>;

export const createCashDepositInputSchema = z
  .strictObject({
    outletId: outletIdSchema,
    bankAccountId: bankAccountIdSchema,
    amountIdr: positiveIdr,
    coversFrom: businessDateSchema,
    coversTo: businessDateSchema,
    depositedAt: isoDateTimeSchema,
    slipReference: z.string().trim().min(1).max(60).nullable(),
    idempotencyKey: idempotencyKeySchema,
  })
  .refine((row) => row.coversTo >= row.coversFrom, {
    path: ["coversTo"],
    message: "coversTo must not be before coversFrom",
  });

/** Tenant data: how many days cash may stay undeposited (ACC-05 "batas hari"). */
export const cashDepositPolicySchema = z.strictObject({
  maxDaysUndeposited: z.number().int().min(0).max(30),
});
export type CashDepositPolicy = z.infer<typeof cashDepositPolicySchema>;

export const cashCollectionSchema = z.strictObject({
  outletId: outletIdSchema,
  businessDate: businessDateSchema,
  /** Cash sales net of cash refunds and petty cash taken from the drawer. */
  cashIdr: idrSchema.refine((value) => value >= 0, "Amount must be >= 0"),
});
export type CashCollection = z.infer<typeof cashCollectionSchema>;

export const undepositedCashAlertSchema = z.strictObject({
  outletId: outletIdSchema,
  businessDate: businessDateSchema,
  undepositedIdr: positiveIdr,
  daysOutstanding: z.number().int().min(0),
});
export type UndepositedCashAlert = z.infer<typeof undepositedCashAlertSchema>;

/**
 * ACC-05: deposits settle the oldest collected cash first (FIFO per outlet);
 * every business date with cash still undeposited for more than
 * `maxDaysUndeposited` days at `asOf` raises an alert.
 */
export function undepositedCashAlerts(
  collections: readonly CashCollection[],
  deposits: readonly { outletId: OutletId; amountIdr: number }[],
  asOf: string,
  policy: CashDepositPolicy,
): UndepositedCashAlert[] {
  const alerts: UndepositedCashAlert[] = [];
  const outlets = [...new Set(collections.map((row) => row.outletId))].sort();
  for (const outletId of outlets) {
    let deposited = deposits
      .filter((deposit) => deposit.outletId === outletId)
      .reduce((sum, deposit) => sum + BigInt(deposit.amountIdr), 0n);
    const days = collections
      .filter((row) => row.outletId === outletId)
      .sort((a, b) => a.businessDate.localeCompare(b.businessDate));
    for (const day of days) {
      const cash = BigInt(day.cashIdr);
      const covered = deposited >= cash ? cash : deposited;
      deposited -= covered;
      const remaining = cash - covered;
      const age = daysBetween(day.businessDate, asOf);
      if (remaining > 0n && age > policy.maxDaysUndeposited)
        alerts.push({
          outletId,
          businessDate: day.businessDate,
          undepositedIdr: Number(remaining) as Idr,
          daysOutstanding: age,
        });
    }
  }
  return alerts;
}

// ---- Reconciliation cases (ACC-04) ----------------------------------------

export const RECONCILIATION_CASE_TYPES = [
  "bank_statement",
  "gateway_settlement",
  "edc_settlement",
  "cash_deposit",
] as const;
export const reconciliationCaseTypeSchema = z.enum(RECONCILIATION_CASE_TYPES);
export const reconciliationCaseStatusSchema = z.enum([
  "open",
  "in_progress",
  "resolved",
  "written_off",
]);
export type ReconciliationCaseStatus = z.infer<
  typeof reconciliationCaseStatusSchema
>;

/** Every difference becomes a case with a PIC (ACC-04 "setiap selisih menjadi kasus dengan PIC"). */
export const reconciliationCaseSchema = z
  .strictObject({
    id: reconciliationCaseIdSchema,
    tenantId: tenantIdSchema,
    legalEntityId: legalEntityIdSchema,
    outletId: outletIdSchema.nullable(),
    type: reconciliationCaseTypeSchema,
    /** Signed: statement/settlement minus books. */
    differenceIdr: nonZeroIdr,
    ownerId: userIdSchema,
    status: reconciliationCaseStatusSchema,
    dueAt: isoDateTimeSchema,
    refs: z.array(reconciliationRefSchema).min(1),
    openedAt: isoDateTimeSchema,
    resolvedBy: userIdSchema.nullable(),
    resolvedAt: isoDateTimeSchema.nullable(),
    resolutionNote: z.string().trim().min(1).max(500).nullable(),
    /** Write-offs book the difference through a journal. */
    adjustmentJournalEntryId: journalEntryIdSchema.nullable(),
  })
  .superRefine((row, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    const done = row.status === "resolved" || row.status === "written_off";
    if (
      done !==
      (row.resolvedBy !== null &&
        row.resolvedAt !== null &&
        row.resolutionNote !== null)
    )
      issue("resolutionNote", "resolution fields are set exactly when closed");
    if (
      (row.status === "written_off") !==
      (row.adjustmentJournalEntryId !== null)
    )
      issue(
        "adjustmentJournalEntryId",
        "a write-off needs its adjustment journal",
      );
  });
export type ReconciliationCase = z.infer<typeof reconciliationCaseSchema>;

/** Tenant data: default days until a new case is due. */
export const reconciliationPolicySchema = z.strictObject({
  caseDueDays: z.number().int().min(1).max(60),
});
export type ReconciliationPolicy = z.infer<typeof reconciliationPolicySchema>;

export type ReconciliationCaseAction =
  | { type: "start"; actorId: UserId }
  | { type: "reassign"; actorId: UserId; ownerId: UserId }
  | { type: "resolve"; actorId: UserId; note: string }
  | {
      type: "write_off";
      actorId: UserId;
      note: string;
      adjustmentJournalEntryId: string;
    };

/**
 *   open ─start→ in_progress
 *   open|in_progress ─resolve→ resolved | ─write_off→ written_off
 *   reassign keeps the status (a PIC is always set).
 */
export function transitionReconciliationCase(
  current: Pick<ReconciliationCase, "status">,
  action: ReconciliationCaseAction,
): ReconciliationCaseStatus {
  const active = current.status === "open" || current.status === "in_progress";
  if (!active) throw new AccountingError("INVALID_TRANSITION");
  switch (action.type) {
    case "start":
      if (current.status !== "open")
        throw new AccountingError("INVALID_TRANSITION");
      return "in_progress";
    case "reassign":
      return current.status;
    case "resolve":
    case "write_off":
      if (action.note.trim() === "")
        throw new AccountingError("INVALID_TRANSITION");
      return action.type === "resolve" ? "resolved" : "written_off";
  }
}

export const reconciliationCaseActionInputSchema = z.discriminatedUnion(
  "type",
  [
    z.strictObject({ type: z.literal("start") }),
    z.strictObject({ type: z.literal("reassign"), ownerId: userIdSchema }),
    z.strictObject({
      type: z.literal("resolve"),
      note: z.string().trim().min(1).max(500),
    }),
    z.strictObject({
      type: z.literal("write_off"),
      note: z.string().trim().min(1).max(500),
      adjustmentJournalEntryId: journalEntryIdSchema,
    }),
  ],
);

export const openReconciliationCaseInputSchema = z.strictObject({
  legalEntityId: legalEntityIdSchema,
  outletId: outletIdSchema.nullable(),
  type: reconciliationCaseTypeSchema,
  differenceIdr: nonZeroIdr,
  ownerId: userIdSchema,
  refs: z.array(reconciliationRefSchema).min(1).max(50),
  idempotencyKey: idempotencyKeySchema,
});

// ---- Cash in/out and bank transfers (legend-4961, PRD v1.7 §3.19) -----------
//
// One document per row, one journal per document (journal_entry_id is NOT NULL
// and unique). The bank leg is the GL account of the bank account; the counter
// account of a cash in/out is chosen explicitly by the user, never guessed.

export const CASH_BANK_ENTRY_KINDS = [
  "cash_in",
  "cash_out",
  "transfer",
  /** Petty cash top-up held for approval (above the limit); never a posted cash/bank document by itself. */
  "petty_topup",
] as const;
export const cashBankEntryKindSchema = z.enum(CASH_BANK_ENTRY_KINDS);
export type CashBankEntryKind = z.infer<typeof cashBankEntryKindSchema>;
/** Kinds a user can create directly; `petty_topup` only appears via the petty cash movement. */
export type CreatableCashBankEntryKind = Exclude<
  CashBankEntryKind,
  "petty_topup"
>;

export const CASH_BANK_ENTRY_STATUSES = [
  "pending_approval",
  "approved",
  "rejected",
] as const;
export const cashBankEntryStatusSchema = z.enum(CASH_BANK_ENTRY_STATUSES);
export type CashBankEntryStatus = z.infer<typeof cashBankEntryStatusSchema>;

/**
 * Founder Q7 (13 Nov 2026): a cash_out or a petty cash top-up above this
 * (strictly) needs approval, and so does one that makes the creator's total of
 * cash outs and top-ups at one outlet on one business day pass it (anti-split);
 * default Rp5.000.000.
 */
export const DEFAULT_CASH_OUT_APPROVAL_LIMIT_IDR = 5_000_000;
export const MAX_CASH_OUT_APPROVAL_LIMIT_IDR = 100_000_000_000;

export const cashOutApprovalLimitSchema = z.strictObject({
  limitIdr: z.number().int().min(1).max(MAX_CASH_OUT_APPROVAL_LIMIT_IDR),
  /** True while the tenant never set a limit (the default applies). */
  isDefault: z.boolean(),
});
export type CashOutApprovalLimit = z.infer<typeof cashOutApprovalLimitSchema>;

export const putCashOutApprovalLimitInputSchema = z.strictObject({
  limitIdr: z.number().int().min(1).max(MAX_CASH_OUT_APPROVAL_LIMIT_IDR),
});

export const rejectCashBankEntryInputSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500),
});

const entryDescriptionSchema = z.string().trim().min(1).max(255);
const entryReferenceSchema = z.string().trim().min(1).max(60).nullable();

export const cashBankEntrySchema = z
  .strictObject({
    id: cashBankEntryIdSchema,
    tenantId: tenantIdSchema,
    legalEntityId: legalEntityIdSchema,
    /** Optional cost tag; null = whole legal entity. */
    outletId: outletIdSchema.nullable(),
    kind: cashBankEntryKindSchema,
    entryDate: businessDateSchema,
    amountIdr: positiveIdr,
    /** The account money leaves (cash_out, transfer) or enters (cash_in). */
    bankAccountId: bankAccountIdSchema,
    /** Transfer only: the account that receives the money. */
    toBankAccountId: bankAccountIdSchema.nullable(),
    /** Cash in/out only: the other side of the journal. */
    counterAccountId: accountIdSchema.nullable(),
    description: entryDescriptionSchema,
    reference: entryReferenceSchema,
    /** Founder Q7: a cash_out / petty_topup above the tenant limit is `pending_approval` (no journal yet). */
    status: cashBankEntryStatusSchema,
    approverId: userIdSchema.nullable(),
    decidedAt: isoDateTimeSchema.nullable(),
    decisionReason: z.string().nullable(),
    /** Null until the entry is approved and its journal is posted. */
    journalEntryId: journalEntryIdSchema.nullable(),
    createdBy: userIdSchema,
    createdAt: isoDateTimeSchema,
  })
  .superRefine((row, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if ((row.status === "approved") !== (row.journalEntryId !== null))
      issue("journalEntryId", "only an approved entry has a journal");
    if (
      row.status !== "approved" &&
      row.kind !== "cash_out" &&
      row.kind !== "petty_topup"
    )
      issue(
        "status",
        "only a cash out or a petty cash top-up waits for approval",
      );
    if (row.kind === "petty_topup") {
      if (row.outletId === null)
        issue("outletId", "a petty cash top-up names its outlet");
      if (row.counterAccountId !== null)
        issue("counterAccountId", "a petty cash top-up has no counter account");
      if (row.toBankAccountId !== null)
        issue("toBankAccountId", "only a transfer has a destination account");
    } else if (row.kind === "transfer") {
      if (row.toBankAccountId === null)
        issue("toBankAccountId", "a transfer names its destination account");
      else if (row.toBankAccountId === row.bankAccountId)
        issue("toBankAccountId", "a transfer needs two different accounts");
      if (row.counterAccountId !== null)
        issue("counterAccountId", "a transfer has no counter account");
    } else {
      if (row.counterAccountId === null)
        issue("counterAccountId", "cash in/out names its counter account");
      if (row.toBankAccountId !== null)
        issue("toBankAccountId", "only a transfer has a destination account");
    }
  });
export type CashBankEntry = z.infer<typeof cashBankEntrySchema>;

const cashInOutInputSchema = z.strictObject({
  legalEntityId: legalEntityIdSchema,
  bankAccountId: bankAccountIdSchema,
  counterAccountId: accountIdSchema,
  amountIdr: positiveIdr,
  entryDate: businessDateSchema,
  description: entryDescriptionSchema,
  reference: entryReferenceSchema,
  outletId: outletIdSchema.optional(),
  idempotencyKey: idempotencyKeySchema,
});

export const createCashBankEntryInputSchema = z
  .discriminatedUnion("kind", [
    cashInOutInputSchema.extend({ kind: z.literal("cash_in") }),
    cashInOutInputSchema.extend({ kind: z.literal("cash_out") }),
    z.strictObject({
      kind: z.literal("transfer"),
      legalEntityId: legalEntityIdSchema,
      fromBankAccountId: bankAccountIdSchema,
      toBankAccountId: bankAccountIdSchema,
      amountIdr: positiveIdr,
      entryDate: businessDateSchema,
      description: entryDescriptionSchema,
      reference: entryReferenceSchema,
      idempotencyKey: idempotencyKeySchema,
    }),
  ])
  .superRefine((input, ctx) => {
    if (
      input.kind === "transfer" &&
      input.fromBankAccountId === input.toBankAccountId
    )
      ctx.addIssue({
        code: "custom",
        path: ["toBankAccountId"],
        message: "a transfer needs two different accounts",
      });
  });
export type CreateCashBankEntryInput = z.infer<
  typeof createCashBankEntryInputSchema
>;

export const cashBankEntryQuerySchema = cursorPageQuerySchema.extend({
  legalEntityId: legalEntityIdSchema,
  from: businessDateSchema,
  to: businessDateSchema,
  kind: cashBankEntryKindSchema.optional(),
  bankAccountId: bankAccountIdSchema.optional(),
});

/** GL accounts a cash/bank document posts to, resolved by the service. */
export type CashBankJournalAccounts = {
  /** GL account of the document's bank account (the source for a transfer). */
  bankGl: string;
  /** Transfer: GL account of the destination bank account. */
  toBankGl?: string | null;
  /** Cash in/out: the user-chosen counter account. */
  counter?: string | null;
};

/**
 * Journal lines of a cash/bank document. cash_in: Dr bank / Cr counter.
 * cash_out: Dr counter / Cr bank. transfer: Dr destination / Cr source.
 * Always balanced (throws JOURNAL_UNBALANCED / JOURNAL_LINE_INVALID otherwise).
 */
export function cashBankJournalLines(
  entry: {
    kind: CashBankEntryKind;
    amountIdr: number;
    outletId?: OutletId | null;
  },
  accounts: CashBankJournalAccounts,
): JournalLineInput[] {
  const { kind, amountIdr } = entry;
  const outletId = entry.outletId ?? null;
  const line = (
    accountId: string,
    side: "debit" | "credit",
  ): JournalLineInput =>
    ({
      accountId,
      debitIdr: side === "debit" ? amountIdr : 0,
      creditIdr: side === "credit" ? amountIdr : 0,
      outletId,
      costCenter: null,
    }) as JournalLineInput;
  let lines: JournalLineInput[];
  if (kind === "transfer") {
    const { toBankGl } = accounts;
    if (!toBankGl)
      throw new AccountingError(
        "JOURNAL_LINE_INVALID",
        "A transfer needs the destination GL account",
      );
    if (toBankGl === accounts.bankGl)
      throw new AccountingError(
        "JOURNAL_LINE_INVALID",
        "A transfer needs two different GL accounts",
      );
    lines = [line(toBankGl, "debit"), line(accounts.bankGl, "credit")];
  } else {
    const { counter } = accounts;
    if (!counter)
      throw new AccountingError(
        "JOURNAL_LINE_INVALID",
        "Cash in/out needs a counter account",
      );
    lines =
      kind === "cash_in"
        ? [line(accounts.bankGl, "debit"), line(counter, "credit")]
        : [line(counter, "debit"), line(accounts.bankGl, "credit")];
  }
  assertJournalBalanced(lines);
  return lines;
}

// ---- Petty cash fund (legend-4961) -------------------------------------------
//
// One fund per outlet. The balance never goes below zero: every movement
// changes it through `applyPettyCashDelta` (and the API under a row lock).

export const pettyCashFundSchema = z.strictObject({
  id: pettyCashFundIdSchema,
  tenantId: tenantIdSchema,
  legalEntityId: legalEntityIdSchema,
  outletId: outletIdSchema,
  balanceIdr: idrSchema.refine((value) => value >= 0, "Balance must be >= 0"),
  updatedAt: isoDateTimeSchema,
});
export type PettyCashFund = z.infer<typeof pettyCashFundSchema>;

export const PETTY_CASH_ENTRY_KINDS = ["topup", "return", "purchase"] as const;
export const pettyCashEntryKindSchema = z.enum(PETTY_CASH_ENTRY_KINDS);
export type PettyCashEntryKind = z.infer<typeof pettyCashEntryKindSchema>;

/** posted = journal booked; parked = account mapping missing, retry later;
 * external = a purchase, whose journal belongs to `petty_purchase.recorded`. */
export const pettyCashJournalStatusSchema = z.enum([
  "posted",
  "parked",
  "external",
]);
export type PettyCashJournalStatus = z.infer<
  typeof pettyCashJournalStatusSchema
>;

export const pettyCashEntrySchema = z
  .strictObject({
    id: pettyCashEntryIdSchema,
    tenantId: tenantIdSchema,
    legalEntityId: legalEntityIdSchema,
    outletId: outletIdSchema,
    fundId: pettyCashFundIdSchema,
    kind: pettyCashEntryKindSchema,
    amountIdr: positiveIdr,
    balanceAfterIdr: idrSchema.refine(
      (value) => value >= 0,
      "Balance must be >= 0",
    ),
    /** topup/return: the bank account on the other side. */
    bankAccountId: bankAccountIdSchema.nullable(),
    /** purchase: the petty purchase that spent the money. */
    pettyPurchaseId: uuidSchema.nullable(),
    entryDate: businessDateSchema,
    description: z.string().trim().min(1).max(255),
    journalStatus: pettyCashJournalStatusSchema,
    journalEntryId: journalEntryIdSchema.nullable(),
    parkCode: z.string().trim().min(1).max(60).nullable(),
    createdBy: userIdSchema,
    createdAt: isoDateTimeSchema,
  })
  .superRefine((row, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (row.kind === "purchase") {
      if (row.pettyPurchaseId === null)
        issue("pettyPurchaseId", "a purchase names its petty purchase");
      if (row.bankAccountId !== null)
        issue("bankAccountId", "a purchase has no bank account");
      if (row.journalStatus !== "external")
        issue("journalStatus", "a purchase journal is external");
    } else {
      if (row.bankAccountId === null)
        issue("bankAccountId", "top-up/return names its bank account");
      if (row.pettyPurchaseId !== null)
        issue("pettyPurchaseId", "only a purchase has a petty purchase");
      if (row.journalStatus === "external")
        issue("journalStatus", "top-up/return journals are posted or parked");
    }
    if ((row.journalStatus === "posted") !== (row.journalEntryId !== null))
      issue("journalEntryId", "journal is set exactly when posted");
    if ((row.journalStatus === "parked") !== (row.parkCode !== null))
      issue("parkCode", "park code is set exactly when parked");
  });
export type PettyCashEntry = z.infer<typeof pettyCashEntrySchema>;

export const pettyCashFundQuerySchema = z.strictObject({
  legalEntityId: legalEntityIdSchema,
  outletId: outletIdSchema.optional(),
});

export const pettyCashEntryQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema,
  from: businessDateSchema,
  to: businessDateSchema,
});

const pettyCashMovementShape = {
  outletId: outletIdSchema,
  bankAccountId: bankAccountIdSchema,
  amountIdr: positiveIdr,
  description: z.string().trim().min(1).max(255),
  idempotencyKey: idempotencyKeySchema,
};
export const pettyCashMovementInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("topup"), ...pettyCashMovementShape }),
  z.strictObject({ kind: z.literal("return"), ...pettyCashMovementShape }),
]);
export type PettyCashMovementInput = z.infer<
  typeof pettyCashMovementInputSchema
>;

/**
 * New fund balance after a signed movement. Throws PETTY_CASH_INSUFFICIENT
 * when the result would be below zero: a petty cash fund never goes negative.
 */
export function applyPettyCashDelta(balance: number, delta: number): Idr {
  if (!Number.isSafeInteger(balance) || !Number.isSafeInteger(delta))
    throw new AccountingError(
      "JOURNAL_LINE_INVALID",
      "Petty cash amounts are whole rupiah",
    );
  const next = balance + delta;
  if (balance < 0 || next < 0)
    throw new AccountingError("PETTY_CASH_INSUFFICIENT", undefined, {
      balanceIdr: balance,
      deltaIdr: delta,
    });
  if (!Number.isSafeInteger(next))
    throw new AccountingError(
      "JOURNAL_LINE_INVALID",
      "Petty cash balance exceeds the safe rupiah range",
    );
  return next as Idr;
}
