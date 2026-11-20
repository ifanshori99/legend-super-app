// Accounting journals (PRD v1.7 §3.19 Jurnal Otomatis / Jurnal Manual; §6 F
// journal_entries + journal_lines; ACC-01; bead legend-kwxj).
//
// This module is the posting API every other module calls: inside its own
// tenant transaction it builds the lines (from a posting rule or from the
// caller's documents), guards the fiscal period, inserts the append-only entry
// and lines, and appends the `journal.posted` event through the transactional
// outbox. It never opens a transaction of its own, so the domain write and the
// journal commit or roll back together.
//
// ACC-01 rules come from the contract and are repeated by migration 0025:
// at least two lines, debit XOR credit, equal totals, posted entries final,
// corrections only through a reversal (once, never of a reversal).
//
// `expectedVersion` lets a caller that read the period earlier fail with
// PERIOD_CHANGED instead of posting into a period that closed meanwhile.
//
// Pre-review findings (legend-kwxj) fixed here:
// - disclosure scope: an outlet-scoped reader never sees a partial entry; a
//   multi-outlet journal is invisible to a single-outlet reader instead of
//   revealing the other outlets' lines (TEN-03);
// - idempotency: the key is bound to a request fingerprint, so the same key
//   with a different payload fails IDEMPOTENCY_KEY_REUSED (409);
// - every exported boundary asserts trusted context before touching rows.

import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  notExists,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  AccountingError,
  accountMapFor,
  accountMappingSchema,
  accountSchema,
  assertAccountPostable,
  assertJournalBalanced,
  assertReversible,
  buildJournalLinesFromRule,
  buildReversalLines,
  CASH_POSTING_ROLES,
  defaultPostingRules,
  dropZeroLines,
  journalEntrySchema,
  journalEntrySummarySchema,
  journalLineInputSchema,
  journalLineSchema,
  journalPostedEvent,
  journalSourceIdSchema,
  journalSourceTypeSchema,
  resolvePostingRule,
  reverseJournalInputSchema,
  type Account,
  type AccountId,
  type JournalEntry,
  type JournalEntrySummary,
  type JournalLine,
  type JournalLineInput,
  type JournalSourceType,
  type LegalEntityId,
  type PostingAccountRole,
} from "@starter/shared/accounting";
import {
  assertTrustedScopedContext,
  businessDateSchema,
  CoreError,
  createUlid,
  decodeCursor,
  encodeCursor,
  idempotencyKeySchema,
  outletIdsForQuery,
  uuidSchema,
  type BusinessDate,
  type CursorPage,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
  type UserId,
} from "@starter/shared/core";
import { db } from "../db";
import {
  accountMappings,
  chartOfAccounts,
  fixedAssetDepreciationReversals,
  employeeLoans,
  fixedAssetDepreciations,
  journalEntries,
  journalLines,
  payrollPayoutGlPostings,
  reimbursements,
  supplierPayments,
} from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { entityLock } from "./accounting-bank-matching";
import {
  assertJournalCredit1102Covered,
  pettyCashGlAccount,
} from "./accounting-petty-cash.service";
import { markMatchStaleForReversedJournal } from "./accounting-bank-recon-stale.service";
import { assertPeriodOpenForPosting } from "./accounting-period.service";
import {
  auditAccountingChange,
  journalRequestFingerprint,
  requireLegalEntity,
  requireOutlet,
  type TenantTransaction,
} from "./accounting-shared";
import { appendOutbox } from "./core-outbox";

type EntryRow = typeof journalEntries.$inferSelect;
type LineRow = typeof journalLines.$inferSelect;

/** Consumers receive accounting events through the cloud sync stream. */
const EVENT_DESTINATION = "cloud-sync";

/** Entry-producing inputs exclude "reversal": only reverseJournal posts those. */
export type PostJournalInput = {
  readonly legalEntityId: string;
  readonly outletId: string | null;
  readonly entryDate: BusinessDate;
  readonly sourceType: Exclude<JournalSourceType, "reversal">;
  readonly sourceId: string | null;
  readonly description: string;
  readonly lines: readonly JournalLineInput[];
  readonly postedBy: UserId | null;
  readonly idempotencyKey: string;
  readonly expectedPeriodVersion?: number | null;
  /** Business date the fact really happened on, when it posts into a later open period. */
  readonly lateAdjustmentFrom?: string | null;
  /** Order (uuid form) of a sale or refund journal; null for other sources. */
  readonly orderId?: string | null;
  /** Internal immutable record of the exact role identities used to post. */
  readonly postingAccountSnapshot?: Partial<
    Record<PostingAccountRole, string>
  > | null;
};

/** A module posts its event through a catalogued posting rule (contract). */
export type PostFromRuleInput = {
  readonly eventName: string;
  readonly variant?: string | null;
  readonly amounts: Readonly<Record<string, number>>;
  readonly legalEntityId: string;
  readonly outletId: string | null;
  readonly entryDate: BusinessDate;
  readonly sourceId: string | null;
  readonly description?: string;
  readonly postedBy: UserId | null;
  readonly idempotencyKey: string;
  readonly costCenter?: string | null;
  readonly expectedPeriodVersion?: number | null;
  readonly lateAdjustmentFrom?: string | null;
  readonly orderId?: string | null;
  /** Trusted internal role identities recovered from the original sale. */
  readonly accountOverrides?: Partial<Record<PostingAccountRole, string>>;
  /** Refuse a net credit to GL 1102 above the available cash (legend-5qqb9); fixed asset posters set it. */
  readonly guardPettyCash?: boolean;
};

type ParsedPost = PostJournalInput & {
  readonly sourceId: string | null;
  readonly lines: readonly JournalLineInput[];
};

function parsePostInput(input: PostJournalInput): ParsedPost {
  const sourceType = journalSourceTypeSchema.parse(input.sourceType);
  if (sourceType === "reversal")
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Post a correction through the reversal endpoint.",
    );
  const lines = journalLineInputSchema
    .array()
    .min(2)
    .max(200)
    .parse(dropZeroLines(input.lines));
  const description = input.description.trim();
  if (description.length === 0 || description.length > 255)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Description must be 1-255 characters.",
    );
  return {
    ...input,
    sourceType,
    entryDate: businessDateSchema.parse(input.entryDate),
    sourceId:
      input.sourceId === null
        ? null
        : journalSourceIdSchema.parse(input.sourceId),
    description,
    lines,
    idempotencyKey: idempotencyKeySchema.parse(input.idempotencyKey),
    lateAdjustmentFrom:
      input.lateAdjustmentFrom == null
        ? null
        : businessDateSchema.parse(input.lateAdjustmentFrom),
  };
}

function toLine(row: LineRow): JournalLine {
  return journalLineSchema.parse({
    id: row.id,
    accountId: row.accountId,
    debitIdr: row.debitIdr,
    creditIdr: row.creditIdr,
    outletId: row.outletId,
    costCenter: row.costCenter,
  });
}

function toEntry(row: EntryRow, lines: readonly LineRow[]): JournalEntry {
  return journalEntrySchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    legalEntityId: row.legalEntityId,
    outletId: row.outletId,
    entryDate: row.entryDate,
    fiscalPeriodId: row.fiscalPeriodId,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    description: row.description,
    reversalOf: row.reversalOf,
    postedBy: row.postedBy,
    postedAt: row.postedAt.toISOString(),
    lines: lines.map(toLine),
  });
}

function toSummary(
  row: EntryRow,
  totalIdr: number,
  lineCount: number,
  reversedBy: string | null,
): JournalEntrySummary {
  return journalEntrySummarySchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    legalEntityId: row.legalEntityId,
    outletId: row.outletId,
    entryDate: row.entryDate,
    fiscalPeriodId: row.fiscalPeriodId,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    description: row.description,
    reversalOf: row.reversalOf,
    postedBy: row.postedBy,
    postedAt: row.postedAt.toISOString(),
    totalIdr,
    lineCount,
    reversedBy,
  });
}

/**
 * TEN-03: an outlet-scoped caller may only post or reverse inside its
 * outlets. Entity-level entries and entity-level lines (payroll, depreciation,
 * a tax line without an outlet) need tenant scope, so an outlet reader never
 * creates a journal it could not see afterwards (disclosure scope, pre-review
 * finding).
 */
function assertPostingScope(
  context: ScopedTenantContext,
  outletId: string | null,
  lines: readonly Pick<JournalLineInput, "outletId">[],
): void {
  if (outletId !== null) {
    outletIdsForQuery(context.outletScope, [outletId]);
  }
  if (context.outletScope.kind !== "tenant") {
    if (outletId === null)
      throw new CoreError(
        "OUTLET_OUT_OF_SCOPE",
        "Jurnal tingkat badan usaha memerlukan akses seluruh tenant.",
      );
    for (const line of lines) {
      if (line.outletId === null)
        throw new CoreError(
          "OUTLET_OUT_OF_SCOPE",
          "Baris jurnal tingkat badan usaha memerlukan akses seluruh tenant.",
        );
      outletIdsForQuery(context.outletScope, [line.outletId]);
    }
    return;
  }
  for (const line of lines)
    if (line.outletId !== null)
      outletIdsForQuery(context.outletScope, [line.outletId]);
}

async function entryLines(
  tx: TenantTransaction,
  tenantId: string,
  entryId: string,
): Promise<LineRow[]> {
  return tx
    .select()
    .from(journalLines)
    .where(
      and(
        eq(journalLines.tenantId, tenantId),
        eq(journalLines.entryId, entryId),
      ),
    )
    .orderBy(asc(journalLines.lineNo));
}

/** A retried delivery returns the entry its idempotency key already posted. */
async function findByIdempotency(
  tx: TenantTransaction,
  tenantId: string,
  idempotencyKey: string,
): Promise<{ row: EntryRow; entry: JournalEntry } | null> {
  const [row] = await tx
    .select()
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.tenantId, tenantId),
        eq(journalEntries.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  if (!row) return null;
  return { row, entry: toEntry(row, await entryLines(tx, tenantId, row.id)) };
}

/**
 * A key identifies one business fact (pre-review finding): a replay that
 * carries another payload is a caller bug, so refuse instead of returning the
 * entry that belongs to a different request.
 */
function assertReplayMatches(
  replayed: { row: EntryRow; entry: JournalEntry },
  fingerprint: string,
): JournalEntry {
  if (replayed.row.requestFingerprint !== fingerprint)
    throw new CoreError(
      "IDEMPOTENCY_KEY_REUSED",
      "That idempotency key was used for a different journal request.",
    );
  return replayed.entry;
}

/** Fingerprint of a post request, after parsing (trimmed description). */
function postFingerprint(parsed: ParsedPost): string {
  return journalRequestFingerprint({
    legalEntityId: parsed.legalEntityId,
    outletId: parsed.outletId,
    entryDate: parsed.entryDate,
    sourceType: parsed.sourceType,
    sourceId: parsed.sourceId,
    description: parsed.description,
    lines: parsed.lines,
    lateAdjustmentFrom: parsed.lateAdjustmentFrom,
  });
}

async function chartForEntity(
  tx: TenantTransaction,
  tenantId: string,
  legalEntityId: string,
): Promise<Account[]> {
  const rows = await tx
    .select()
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.tenantId, tenantId),
        eq(chartOfAccounts.legalEntityId, legalEntityId),
      ),
    );
  return rows.map((row) =>
    accountSchema.parse({
      id: row.id,
      tenantId: row.tenantId,
      legalEntityId: row.legalEntityId,
      code: row.code,
      name: row.name,
      type: row.type,
      reportGroup: row.reportGroup,
      parentId: row.parentId,
      isActive: row.isActive,
    }),
  );
}

/**
 * Refuses lines whose account is missing, inactive, a header account or of
 * another legal entity, before a request (manual / recurring journal) reaches
 * approval. `postJournalInTransaction` re-checks at posting time.
 */
export async function assertJournalLinesPostable(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  legalEntityId: string,
  lines: readonly { readonly accountId: string }[],
): Promise<void> {
  const chart = await chartForEntity(
    tx,
    context.tenant.tenantId,
    legalEntityId,
  );
  for (const line of lines)
    assertAccountPostable(
      line.accountId as AccountId,
      legalEntityId as LegalEntityId,
      chart,
    );
}

/** Appends journal.posted in the caller's transaction (transactional outbox). */
async function appendJournalPosted(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  entry: JournalEntry,
  totalIdr: number,
  now: Date,
): Promise<void> {
  const event = journalPostedEvent.envelopeSchema.parse({
    id: createUlid(now.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: entry.outletId,
    name: "journal.posted",
    version: 1,
    aggregateType: "journal",
    aggregateId: entry.id,
    sequence: 1,
    occurredAt: now.toISOString(),
    actor: entry.postedBy
      ? { type: "user", id: entry.postedBy }
      : { type: "system" },
    deviceId: null,
    idempotencyKey: `journal.posted:${entry.id}`.slice(0, 100),
    payloadSchemaRef: journalPostedEvent.payloadSchemaRef,
    payload: {
      journalEntryId: entry.id,
      legalEntityId: entry.legalEntityId,
      outletId: entry.outletId,
      fiscalPeriodId: entry.fiscalPeriodId,
      entryDate: entry.entryDate,
      sourceType: entry.sourceType,
      sourceId: entry.sourceId,
      reversalOf: entry.reversalOf,
      totalIdr,
      lineCount: entry.lines.length,
    },
  });
  await appendOutbox(tx, context, {
    id: createUlid(now.getTime()),
    event,
    destination: EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
}

/**
 * Central back-stop of the petty cash lock protocol (legend-3k9qg): a journal
 * that CREDITS the account the `petty_cash` role maps to (1102) lowers the GL
 * side of the fund-vs-GL guard that the petty cash return reads under the
 * entity lock. Take that same lock before the entry is written. Lock order is
 * entity lock, then the batch/period/journal locks; callers that already hold
 * it (petty cash, cash/bank, reversal, payroll payout) make this a re-entrant
 * no-op. A poster that wants to take other locks first must take the entity
 * lock before them, never after.
 */
async function lockEntityForPettyCashCredit(
  tx: TenantTransaction,
  tenantId: string,
  legalEntityId: string,
  lines: readonly { accountId: string; creditIdr: number }[],
): Promise<void> {
  const credited = lines.filter((line) => line.creditIdr > 0);
  if (credited.length === 0) return;
  const [mapping] = await tx
    .select({ accountId: accountMappings.accountId })
    .from(accountMappings)
    .where(
      and(
        eq(accountMappings.tenantId, tenantId),
        eq(accountMappings.legalEntityId, legalEntityId),
        eq(accountMappings.role, "petty_cash"),
      ),
    )
    .limit(1);
  if (
    !mapping ||
    !credited.some((line) => line.accountId === mapping.accountId)
  )
    return;
  await entityLock(tx, tenantId, legalEntityId);
}

/**
 * The posting API all modules use, inside the caller's tenant transaction.
 * Idempotent on `idempotencyKey`; fails closed on a closed period, an
 * inactive/header/foreign account or an unbalanced entry.
 */
export async function postJournalInTransaction(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  input: PostJournalInput,
  now = new Date(),
): Promise<JournalEntry> {
  assertTrustedScopedContext(context);
  const parsed = parsePostInput(input);
  assertPostingScope(context, parsed.outletId, parsed.lines);
  const fingerprint = postFingerprint(parsed);
  const replayed = await findByIdempotency(
    tx,
    context.tenant.tenantId,
    parsed.idempotencyKey,
  );
  if (replayed) return assertReplayMatches(replayed, fingerprint);
  await requireLegalEntity(tx, context.tenant.tenantId, parsed.legalEntityId);
  if (parsed.outletId !== null)
    await requireOutlet(tx, context.tenant.tenantId, parsed.outletId);
  const chart = await chartForEntity(
    tx,
    context.tenant.tenantId,
    parsed.legalEntityId,
  );
  for (const line of parsed.lines)
    assertAccountPostable(
      line.accountId as AccountId,
      parsed.legalEntityId as LegalEntityId,
      chart,
    );
  const totalIdr = assertJournalBalanced(parsed.lines);
  // Before the period gate (entity lock first, like every other writer).
  await lockEntityForPettyCashCredit(
    tx,
    context.tenant.tenantId,
    parsed.legalEntityId,
    parsed.lines,
  );
  const period = await assertPeriodOpenForPosting(tx, context, {
    legalEntityId: parsed.legalEntityId,
    entryDate: parsed.entryDate,
    expectedVersion: parsed.expectedPeriodVersion,
  });
  const [row] = await tx
    .insert(journalEntries)
    .values({
      tenantId: context.tenant.tenantId,
      legalEntityId: parsed.legalEntityId,
      outletId: parsed.outletId,
      entryDate: parsed.entryDate,
      fiscalPeriodId: period.id,
      sourceType: parsed.sourceType,
      sourceId: parsed.sourceId,
      description: parsed.description,
      postedBy: parsed.postedBy,
      postedAt: now,
      idempotencyKey: parsed.idempotencyKey,
      requestFingerprint: fingerprint,
      lateAdjustmentFrom: parsed.lateAdjustmentFrom ?? null,
      orderId: parsed.orderId ?? null,
      postingAccountSnapshot: parsed.postingAccountSnapshot ?? null,
    })
    .onConflictDoNothing({
      target: [journalEntries.tenantId, journalEntries.idempotencyKey],
    })
    .returning();
  if (!row) {
    const concurrent = await findByIdempotency(
      tx,
      context.tenant.tenantId,
      parsed.idempotencyKey,
    );
    if (concurrent) return assertReplayMatches(concurrent, fingerprint);
    throw new Error("Journal entry conflicted without an existing entry.");
  }
  const lineRows = await tx
    .insert(journalLines)
    .values(
      parsed.lines.map((line, index) => ({
        tenantId: context.tenant.tenantId,
        entryId: row.id,
        accountId: line.accountId,
        lineNo: index + 1,
        debitIdr: line.debitIdr,
        creditIdr: line.creditIdr,
        outletId: line.outletId,
        costCenter: line.costCenter,
      })),
    )
    .returning();
  const entry = toEntry(row, lineRows);
  await appendJournalPosted(tx, context, entry, totalIdr, now);
  return entry;
}

/**
 * Resolves a catalogued posting rule for the caller's event and posts it
 * (PRD §3.19 Jurnal Otomatis). The caller supplies the rule's exact amount
 * keys; a missing rule or mapping fails closed inside the same transaction.
 */
export async function postJournalFromRuleInTransaction(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  input: PostFromRuleInput,
  now = new Date(),
): Promise<JournalEntry> {
  assertTrustedScopedContext(context);
  const rule = resolvePostingRule(
    defaultPostingRules,
    input.variant
      ? { eventName: input.eventName, variant: input.variant }
      : { eventName: input.eventName },
  );
  if (rule.sourceType === "reversal")
    throw new AccountingError(
      "POSTING_RULE_MISSING",
      `Rule ${rule.key} would post a reversal.`,
    );
  const mappingRows = await tx
    .select()
    .from(accountMappings)
    .where(
      and(
        eq(accountMappings.tenantId, context.tenant.tenantId),
        eq(accountMappings.legalEntityId, input.legalEntityId),
      ),
    )
    .orderBy(asc(accountMappings.role));
  const accountMap = new Map(
    accountMapFor(
      mappingRows.map((row) =>
        accountMappingSchema.parse({
          tenantId: row.tenantId,
          legalEntityId: row.legalEntityId,
          role: row.role,
          accountId: row.accountId,
        }),
      ),
      input.legalEntityId as LegalEntityId,
    ),
  );
  // legend-5i6k1: keep the current mapping before overrides are applied. The
  // overrides carry the historic (sale-time) accounts, so the refund guard
  // below must check both maps.
  const currentAccountMap = new Map(accountMap);
  for (const [role, accountId] of Object.entries(
    input.accountOverrides ?? {},
  )) {
    const mapping = accountMappingSchema.parse({
      tenantId: context.tenant.tenantId,
      legalEntityId: input.legalEntityId,
      role,
      accountId,
    });
    accountMap.set(mapping.role, mapping.accountId);
  }
  // legend-48ft7: the refund fact builder reads the mapping in a separate,
  // unlocked read. Re-check on the exact map the lines are built from, so a
  // payout role can never credit a sale service charge or tax account.
  if (input.eventName === "order.refunded") {
    const protectedAccountIds = new Set<string>();
    for (const role of [
      "service_charge",
      "tax_payable_pbjt",
      "tax_payable_ppn",
      "tax_payable_other",
    ] as const) {
      for (const map of [currentAccountMap, accountMap]) {
        const accountId = map.get(role);
        if (accountId !== undefined) protectedAccountIds.add(accountId);
      }
    }
    for (const role of [
      "cash_on_hand",
      "customer_deposit",
      "edc_clearing",
      "loyalty_liability",
    ] as const) {
      for (const map of [currentAccountMap, accountMap]) {
        const accountId = map.get(role);
        if (accountId !== undefined && protectedAccountIds.has(accountId))
          throw new AccountingError(
            "ACCOUNT_MAPPING_MISSING",
            "A refund payout account is mapped to a sale service charge or tax account",
          );
      }
    }
  }
  const lines = buildJournalLinesFromRule(rule, input.amounts, accountMap, {
    outletId: input.outletId as OutletId | null,
    costCenter: input.costCenter ?? null,
  });
  // Fail closed (legend 1118): a rule entry that debits and credits one cash
  // or bank account nets to zero there. A mapping that collapses two roles
  // onto one account (e.g. employee_receivable onto petty_cash) would
  // otherwise post a journal that never moves the cash the source already
  // paid out. Only cash roles: payroll rules legitimately debit and credit
  // salary_expense in one entry (a deduction credits the expense it reduces).
  const cashAccountIds = new Set<string>();
  for (const role of CASH_POSTING_ROLES) {
    const accountId = accountMap.get(role);
    if (accountId !== undefined) cashAccountIds.add(accountId);
  }
  const debited = new Set<string>();
  const credited = new Set<string>();
  for (const line of lines) {
    if (line.debitIdr > 0) debited.add(line.accountId);
    if (line.creditIdr > 0) credited.add(line.accountId);
  }
  for (const accountId of debited)
    if (credited.has(accountId) && cashAccountIds.has(accountId))
      throw new AccountingError(
        "JOURNAL_SAME_ACCOUNT_DEBIT_CREDIT",
        `Rule ${rule.key} debits and credits the same cash account`,
      );
  if (input.guardPettyCash === true)
    await assertJournalCredit1102Covered(
      tx,
      context.tenant.tenantId,
      input.legalEntityId,
      lines,
    );
  return postJournalInTransaction(
    tx,
    context,
    {
      legalEntityId: input.legalEntityId,
      outletId: input.outletId,
      entryDate: input.entryDate,
      sourceType: rule.sourceType,
      sourceId: input.sourceId,
      description: input.description ?? rule.description,
      lines,
      postedBy: input.postedBy,
      idempotencyKey: input.idempotencyKey,
      expectedPeriodVersion: input.expectedPeriodVersion,
      lateAdjustmentFrom: input.lateAdjustmentFrom ?? null,
      orderId: input.orderId ?? null,
      postingAccountSnapshot: Object.fromEntries(accountMap),
    },
    now,
  );
}

// ------------------------------------------------------------------- reads

export type ListJournalsQuery = {
  legalEntityId: string;
  from: BusinessDate;
  to: BusinessDate;
  outletId?: string;
  sourceType?: JournalSourceType;
  accountId?: string;
  limit: number;
  cursor?: string;
};

/**
 * Disclosure scope (pre-review finding, TEN-03): an outlet-scoped reader only
 * sees an entry when the whole entry is inside its outlets. A multi-outlet
 * journal is hidden, not partially disclosed, because the other outlets' lines
 * are outside the caller's assignment. An entity-level line (null outlet) is
 * tenant-only data, so it hides the entry from outlet readers as well.
 */
function scopeDisclosureCondition(
  tx: TenantTransaction,
  context: ScopedTenantContext,
): SQL | undefined {
  if (context.outletScope.kind === "tenant") return undefined;
  const ids = [...context.outletScope.outletIds];
  return and(
    or(isNull(journalEntries.outletId), inArray(journalEntries.outletId, ids)),
    notExists(
      tx
        .select({ one: sql`1` })
        .from(journalLines)
        .where(
          and(
            eq(journalLines.tenantId, context.tenant.tenantId),
            eq(journalLines.entryId, journalEntries.id),
            or(
              isNull(journalLines.outletId),
              notInArray(journalLines.outletId, ids),
            ),
          ),
        ),
    ),
  );
}

/** Query filter for an explicitly requested outlet (any scope). */
function outletFilterCondition(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  outletId: string,
): SQL {
  outletIdsForQuery(context.outletScope, [outletId]);
  return or(
    eq(journalEntries.outletId, outletId),
    exists(
      tx
        .select({ one: sql`1` })
        .from(journalLines)
        .where(
          and(
            eq(journalLines.tenantId, context.tenant.tenantId),
            eq(journalLines.entryId, journalEntries.id),
            eq(journalLines.outletId, outletId),
          ),
        ),
    ),
  ) as SQL;
}

/** One page of entry summaries, newest first, keyset on (entry_date, id). */
export async function listJournals(
  context: ScopedTenantContext,
  query: ListJournalsQuery,
): Promise<CursorPage<JournalEntrySummary>> {
  assertTrustedScopedContext(context);
  return withTenant(db, context, async (tx) => {
    await requireLegalEntity(tx, context.tenant.tenantId, query.legalEntityId);
    const filters: SQL[] = [
      eq(journalEntries.tenantId, context.tenant.tenantId),
      eq(journalEntries.legalEntityId, query.legalEntityId),
      gte(journalEntries.entryDate, query.from),
      lte(journalEntries.entryDate, query.to),
    ];
    const scopeFilter = scopeDisclosureCondition(tx, context);
    if (scopeFilter) filters.push(scopeFilter);
    if (query.outletId)
      filters.push(outletFilterCondition(tx, context, query.outletId));
    if (query.sourceType)
      filters.push(eq(journalEntries.sourceType, query.sourceType));
    if (query.accountId)
      filters.push(
        exists(
          tx
            .select({ one: sql`1` })
            .from(journalLines)
            .where(
              and(
                eq(journalLines.tenantId, context.tenant.tenantId),
                eq(journalLines.entryId, journalEntries.id),
                eq(journalLines.accountId, query.accountId),
              ),
            ),
        ),
      );
    if (query.cursor) {
      let decoded: ReturnType<typeof decodeCursor>;
      try {
        decoded = decodeCursor(query.cursor);
      } catch {
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
      }
      const [date, id] = decoded;
      if (typeof date !== "string" || typeof id !== "string")
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
      const cursorFilter = or(
        lt(journalEntries.entryDate, date),
        and(eq(journalEntries.entryDate, date), lt(journalEntries.id, id)),
      );
      if (cursorFilter) filters.push(cursorFilter);
    }
    const rows = await tx
      .select()
      .from(journalEntries)
      .where(and(...filters))
      .orderBy(desc(journalEntries.entryDate), desc(journalEntries.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    if (page.length === 0)
      return { data: [], meta: { limit: query.limit, nextCursor: null } };
    const ids = page.map((row) => row.id);
    const aggregates = await tx
      .select({
        entryId: journalLines.entryId,
        totalIdr: sql<string>`sum(${journalLines.debitIdr})`,
        lineCount: sql<number>`count(*)::int`,
      })
      .from(journalLines)
      .where(
        and(
          eq(journalLines.tenantId, context.tenant.tenantId),
          inArray(journalLines.entryId, ids),
        ),
      )
      .groupBy(journalLines.entryId);
    const reversals = await tx
      .select({ id: journalEntries.id, reversalOf: journalEntries.reversalOf })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.tenantId, context.tenant.tenantId),
          inArray(journalEntries.reversalOf, ids),
        ),
      );
    const aggregateById = new Map(
      aggregates.map((row) => [row.entryId, row] as const),
    );
    const reversedBy = new Map(
      reversals.map((row) => [row.reversalOf as string, row.id] as const),
    );
    return {
      data: page.map((row) => {
        const aggregate = aggregateById.get(row.id);
        return toSummary(
          row,
          Number(aggregate?.totalIdr ?? 0),
          aggregate?.lineCount ?? 0,
          reversedBy.get(row.id) ?? null,
        );
      }),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.entryDate, last.id])
            : null,
      },
    };
  });
}

/**
 * Point-read twin of scopeDisclosureCondition: true only when the whole entry
 * is inside the caller's outlets. Never disclose a partial entry.
 */
async function visibleToScope(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  entry: EntryRow,
): Promise<boolean> {
  if (context.outletScope.kind === "tenant") return true;
  const ids = context.outletScope.outletIds as string[];
  if (entry.outletId !== null && !ids.includes(entry.outletId)) return false;
  const [outside] = await tx
    .select({ one: sql`1` })
    .from(journalLines)
    .where(
      and(
        eq(journalLines.tenantId, context.tenant.tenantId),
        eq(journalLines.entryId, entry.id),
        or(
          isNull(journalLines.outletId),
          notInArray(journalLines.outletId, ids),
        ),
      ),
    )
    .limit(1);
  return outside === undefined;
}

export async function getJournal(
  context: ScopedTenantContext,
  entryId: string,
): Promise<{ entry: JournalEntry; reversedBy: string | null }> {
  assertTrustedScopedContext(context);
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.tenantId, context.tenant.tenantId),
          eq(journalEntries.id, entryId),
        ),
      )
      .limit(1);
    // An entry outside the caller's outlet scope is indistinguishable from a
    // missing one (TEN-03: no existence leak).
    if (!row || !(await visibleToScope(tx, context, row)))
      throw new HttpError(404, "NOT_FOUND", "Journal entry not found.");
    const [reversal] = await tx
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.tenantId, context.tenant.tenantId),
          eq(journalEntries.reversalOf, entryId),
        ),
      )
      .limit(1);
    return {
      entry: toEntry(
        row,
        await entryLines(tx, context.tenant.tenantId, entryId),
      ),
      reversedBy: reversal?.id ?? null,
    };
  });
}

/** Inputs of one reversal: the manual endpoint and the auto-journal void share it. */
export type ReverseJournalTxInput = {
  readonly entryDate: BusinessDate;
  readonly reason: string;
  readonly idempotencyKey: string;
  /** Business date the voided fact really happened on, when the reversal posts into a later open period. */
  readonly lateAdjustmentFrom?: string | null;
  /** Null records a system reversal (auto-journal void). */
  readonly postedBy: UserId | null;
  /**
   * True only for the manual endpoint: a reversal that credits GL 1102 is
   * refused above the available cash (legend-5qqb9). System reversals mirror
   * cash that already moved and stay unguarded.
   */
  readonly guardPettyCash?: boolean;
  /**
   * True only for the manual endpoint: an auto cash-out journal that credits
   * GL 1102 is refused while its source is still paid (legend-5qqb9, bead
   * 1091). System reversals (void, refund, payroll.reversed) stay allowed.
   */
  readonly manualReversal?: boolean;
};

/**
 * ACC-01: the only correction path for a posted entry. Posts the mirrored
 * entry in an open period, at most once, and never reverses a reversal.
 */
export async function reverseJournal(
  context: ScopedTenantContext,
  entryId: string,
  input: unknown,
  actorId: UserId,
  now = new Date(),
): Promise<JournalEntry> {
  const request = reverseJournalInputSchema.parse(input);
  assertTrustedScopedContext(context);
  return withTenant(db, context, (tx) =>
    reverseJournalInTransaction(
      tx,
      context,
      entryId,
      {
        ...request,
        lateAdjustmentFrom: null,
        postedBy: actorId,
        guardPettyCash: true,
        manualReversal: true,
      },
      now,
    ),
  );
}

/**
 * A journal a depreciation row or a depreciation reversal points at is owned
 * by the fixed-asset service: reversing it by hand would book the value twice
 * (bead legend-k048r).
 */
async function assertNotDepreciationJournal(
  tx: TenantTransaction,
  tenantId: TenantId,
  entryId: string,
): Promise<void> {
  const [depreciation] = await tx
    .select({ id: fixedAssetDepreciations.id })
    .from(fixedAssetDepreciations)
    .where(
      and(
        eq(fixedAssetDepreciations.tenantId, tenantId),
        eq(fixedAssetDepreciations.journalEntryId, entryId),
      ),
    )
    .limit(1);
  const [depreciationReversal] = depreciation
    ? []
    : await tx
        .select({ id: fixedAssetDepreciationReversals.id })
        .from(fixedAssetDepreciationReversals)
        .where(
          and(
            eq(fixedAssetDepreciationReversals.tenantId, tenantId),
            eq(fixedAssetDepreciationReversals.journalEntryId, entryId),
          ),
        )
        .limit(1);
  if (depreciation || depreciationReversal)
    throw new HttpError(
      409,
      "DEPRECIATION_JOURNAL_LOCKED",
      "This journal belongs to fixed-asset depreciation; correct it through the fixed asset.",
    );
}

/**
 * Automatic expense accruals whose source owns the correction (SO 1216 F-P1b):
 * reversing one by hand removes the expense, raises the profit and so the
 * profit share. The payroll run-lock accrual is undone by cancelling the run
 * (payroll.reversed); the inventory GL journals (HPP and waste/count) by a
 * stock movement. Depreciation has its own guard above. Sales, receipts,
 * payouts and fees stay reversible here (CTO decision, deny list). Petty cash
 * purchases and cash-out expenses are held by assertAutoCashOutSourceNotPaid.
 */
const INVENTORY_GL_SOURCES: ReadonlySet<string> = new Set([
  "cogs",
  "stock_adjustment",
]);

function assertNotSourceOwnedAccrual(row: {
  sourceType: string;
  idempotencyKey: string | null;
}): void {
  const payrollAccrual =
    row.sourceType === "payroll" &&
    // payrollGlKeys.locked in payroll-gl-consumer (it imports this module).
    row.idempotencyKey?.startsWith("payroll-gl:locked:") === true;
  if (payrollAccrual)
    throw new HttpError(
      409,
      "AUTO_JOURNAL_LOCKED",
      "Jurnal akrual payroll ini dibuat otomatis dan tidak bisa dibalik manual; batalkan payroll run-nya.",
    );
  if (INVENTORY_GL_SOURCES.has(row.sourceType))
    throw new HttpError(
      409,
      "AUTO_JOURNAL_LOCKED",
      "Jurnal HPP atau penyesuaian stok ini dibuat otomatis dan tidak bisa dibalik manual; perbaiki lewat pergerakan stoknya.",
    );
}

/**
 * A manual reversal of a journal that credits the entity's CURRENT petty cash
 * account (GL 1102) would reopen cash that already left the till
 * (legend-5qqb9, bead 1091). Refused by default: only journals the finance user
 * writes by hand (source `manual`, `recurring`) pass, and the known cash-out
 * sources (loan, cash reimbursement, cash payroll settle posting, supplier
 * payment) pass once their source is no longer paid. Every other journal that
 * credits 1102 (petty purchase, petty cash return `pc:<entryId>`, old
 * `payroll-gl:paid:<run>`) is refused: the correction goes through its own
 * flow. A known source row that is missing or unknown is refused. Caller holds
 * the entity lock and the journal row lock.
 */
async function assertAutoCashOutSourceNotPaid(
  tx: TenantTransaction,
  tenantId: TenantId,
  row: EntryRow,
  lines: readonly { accountId: string; debitIdr: number; creditIdr: number }[],
): Promise<void> {
  if (row.sourceType === "manual" || row.sourceType === "recurring") return;
  // Two cash accounts are judged, each on its own net credit, never summed:
  // the petty cash account the journal was posted on (its snapshot) and the one
  // petty_cash maps to today. Summing lets a remap cancel a real credit: Dr C /
  // Cr A then petty_cash A -> C nets to zero (legend 1142). Judging the snapshot
  // alone lets a remap onto a bank account turn a bank payment into a "cash"
  // credit nobody checks (legend 1147: salary Cr bank B, then petty_cash A -> B,
  // reversal Dr B would raise available cash). Either side crediting is enough
  // to check the source; when in doubt the payment stays held.
  const snapshotPettyCashId = row.postingAccountSnapshot?.petty_cash;
  const cashAccountIds = new Set<string>();
  if (typeof snapshotPettyCashId === "string")
    cashAccountIds.add(snapshotPettyCashId);
  const currentPettyCashId = await pettyCashGlAccount(
    tx,
    tenantId,
    row.legalEntityId,
  );
  if (currentPettyCashId !== null) cashAccountIds.add(currentPettyCashId);
  const key = row.idempotencyKey;
  // A journal without a snapshot (posted before the snapshot existed) has no
  // record of its cash account, and today's mapping may have moved since. For
  // the known cash-out sources the source row decides, not the mapping: when
  // in doubt the cash stays held (legend 1140, CTO decision).
  const knownCashOutSource =
    key !== null &&
    (key.startsWith("payroll-gl:loan:") ||
      key.startsWith("payroll-gl:reimbursement:") ||
      key.startsWith("ap-pay:") ||
      key.startsWith("payroll-payout:"));
  const judgeOnSourceOnly =
    (row.postingAccountSnapshot === null ||
      row.postingAccountSnapshot === undefined) &&
    knownCashOutSource;
  if (!judgeOnSourceOnly) {
    if (cashAccountIds.size === 0) return;
    const creditsCash = [...cashAccountIds].some(
      (accountId) =>
        lines
          .filter((line) => line.accountId === accountId)
          .reduce((sum, line) => sum + line.creditIdr - line.debitIdr, 0) > 0,
    );
    if (!creditsCash) return;
  }
  const uuidPart = (prefix: string): string | null | undefined => {
    if (key === null || !key.startsWith(prefix)) return undefined;
    const id = uuidSchema.safeParse(key.slice(prefix.length));
    return id.success ? id.data : null;
  };
  const loanId = uuidPart("payroll-gl:loan:");
  const reimbursementId = uuidPart("payroll-gl:reimbursement:");
  const settlementId = uuidPart("ap-pay:");
  const payoutSettle = key !== null && key.startsWith("payroll-payout:");
  let paid: boolean;
  if (loanId !== undefined) {
    // Loan disbursed (or settled later): the cash left the till.
    const [loan] =
      loanId === null
        ? []
        : await tx
            .select({ status: employeeLoans.status })
            .from(employeeLoans)
            .where(
              and(
                eq(employeeLoans.tenantId, tenantId),
                eq(
                  employeeLoans.id,
                  loanId as (typeof employeeLoans.$inferSelect)["id"],
                ),
              ),
            )
            .limit(1);
    paid = !loan || ["disbursed", "settled"].includes(loan.status);
  } else if (reimbursementId !== undefined) {
    // Cash reimbursement in status paid.
    const [claim] =
      reimbursementId === null
        ? []
        : await tx
            .select({
              status: reimbursements.status,
              payout: reimbursements.payout,
            })
            .from(reimbursements)
            .where(
              and(
                eq(reimbursements.tenantId, tenantId),
                eq(
                  reimbursements.id,
                  reimbursementId as (typeof reimbursements.$inferSelect)["id"],
                ),
              ),
            )
            .limit(1);
    paid = !claim || (claim.status === "paid" && claim.payout === "cash");
  } else if (payoutSettle) {
    // Cash payroll settle journal: its posting row (journal_key) in kind settle.
    const [posting] = await tx
      .select({ kind: payrollPayoutGlPostings.kind })
      .from(payrollPayoutGlPostings)
      .where(
        and(
          eq(payrollPayoutGlPostings.tenantId, tenantId),
          eq(payrollPayoutGlPostings.journalKey, key),
        ),
      )
      .limit(1);
    paid = !posting || posting.kind === "settle";
  } else if (settlementId !== undefined) {
    // Supplier payment journal: the payment row that points at it, status paid.
    const [payment] = await tx
      .select({ status: supplierPayments.status })
      .from(supplierPayments)
      .where(
        and(
          eq(supplierPayments.tenantId, tenantId),
          eq(supplierPayments.journalEntryId, row.id),
        ),
      )
      .limit(1);
    paid = !payment || payment.status === "paid";
  } else {
    // No known source says the cash came back: the default is refusal.
    paid = true;
  }
  if (paid)
    throw new HttpError(
      409,
      "CASH_OUT_JOURNAL_LOCKED",
      "This journal takes cash out of petty cash and cannot be reversed by hand; correct it through its source (return flow).",
    );
}

/**
 * A restoring DP-return entry cannot be removed after its connected DP has
 * funded a booked payout (legend-ayz7q). The caller already holds this source
 * journal FOR UPDATE, as does sessionDepositAt while validating and posting
 * consumers. No intent lock is acquired here: consumers lock intents before
 * source journals. A payout journal reversal alone does not recover cash, so
 * it does not release this guard; finance must reconcile the paid refund.
 */
async function assertReturnBackingNotPaidOut(
  tx: TenantTransaction,
  tenantId: TenantId,
  row: EntryRow,
): Promise<void> {
  if (
    row.sourceType !== "refund" ||
    row.sourceId === null ||
    row.idempotencyKey !== `aj:order-refund:${row.sourceId}`
  )
    return;
  // Journal sources also accept ULIDs (for example legacy refund events).
  // Q81's pos_order_refunds uses UUIDs; other sources have no Q81 release.
  const sourceId = uuidSchema.safeParse(row.sourceId);
  if (!sourceId.success) return;
  // Follow all historical credit-use edges too: Q82 can move the same DP to
  // another session, where a different intent's payout consumes shared room.
  // Refuse conservatively once any later payout of that component was booked.
  const paid = await tx.execute(sql`
    WITH RECURSIVE releases AS (
      SELECT payment_intent_id, released_at
        FROM pos_deposit_refunds
       WHERE tenant_id = ${tenantId}::uuid
         AND pos_refund_id = ${sourceId.data}::uuid
    ), sources AS (
      SELECT table_session_id AS session_id, payment_intent_id AS intent_id
        FROM reservation_deposit_allocations
       WHERE tenant_id = ${tenantId}::uuid
      UNION
      SELECT u.table_session_id, r.payment_intent_id
        FROM reservation_customer_credit_uses u
        JOIN reservation_deposit_remainders r
          ON r.tenant_id = u.tenant_id AND r.id = u.remainder_id
       WHERE u.tenant_id = ${tenantId}::uuid
    ), connected(node) AS (
      SELECT 'i:' || payment_intent_id::text FROM releases
      UNION
      SELECT CASE WHEN c.node = 's:' || s.session_id::text
                  THEN 'i:' || s.intent_id::text
                  ELSE 's:' || s.session_id::text END
        FROM connected c
        JOIN sources s ON c.node = 's:' || s.session_id::text
                       OR c.node = 'i:' || s.intent_id::text
    )
    SELECT 1 FROM payment_refunds p
      JOIN journal_entries j
        ON j.tenant_id = p.tenant_id
       AND j.idempotency_key = 'aj:payout:' || p.id::text
     WHERE p.tenant_id = ${tenantId}::uuid
       AND p.status = 'completed' AND p.unallocated_fund_id IS NULL
       AND 'i:' || p.payment_intent_id::text IN (SELECT node FROM connected)
       AND p.completed_at >= (SELECT min(released_at) FROM releases)
     LIMIT 1
  `);
  if (paid.rows.length > 0)
    throw new HttpError(
      409,
      "JOURNAL_BACKING_IN_USE",
      "DP return journal backs a completed payout; reconcile that refund before correcting its backing.",
    );
}

/**
 * Reversal inside the caller's tenant transaction. Idempotent on
 * `idempotencyKey`; fails closed on a closed period, a double reversal or a
 * reversal of a reversal.
 */
export async function reverseJournalInTransaction(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  entryId: string,
  input: ReverseJournalTxInput,
  now = new Date(),
): Promise<JournalEntry> {
  assertTrustedScopedContext(context);
  const lateAdjustmentFrom =
    input.lateAdjustmentFrom == null
      ? null
      : businessDateSchema.parse(input.lateAdjustmentFrom);
  // Lock order is entity lock, then journal row (bank recon write_off takes
  // them in that order). Read the entity with a plain select, take the entity
  // lock, and only then lock the journal row; the stale-match hook below
  // takes the same entity lock again, which is a re-entrant no-op.
  const [owner] = await tx
    .select({ legalEntityId: journalEntries.legalEntityId })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.tenantId, context.tenant.tenantId),
        eq(journalEntries.id, entryId),
      ),
    )
    .limit(1);
  if (!owner) throw new HttpError(404, "NOT_FOUND", "Journal entry not found.");
  await entityLock(tx, context.tenant.tenantId, owner.legalEntityId);
  const [row] = await tx
    .select()
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.tenantId, context.tenant.tenantId),
        eq(journalEntries.id, entryId),
      ),
    )
    .limit(1)
    .for("update");
  if (!row || !(await visibleToScope(tx, context, row)))
    throw new HttpError(404, "NOT_FOUND", "Journal entry not found.");
  // Fail closed if the entity moved between the plain read and the lock.
  if (row.legalEntityId !== owner.legalEntityId)
    throw new HttpError(
      409,
      "CONFLICT",
      "Journal entry changed while reversing; retry.",
    );
  const lines = await entryLines(tx, context.tenant.tenantId, entryId);
  // The request fingerprint covers the target entry, the reversal date and
  // the reason, so a reused key with another correction is refused.
  const fingerprint = journalRequestFingerprint({
    legalEntityId: row.legalEntityId,
    outletId: row.outletId,
    entryDate: input.entryDate,
    sourceType: "reversal",
    sourceId: entryId,
    description: input.reason,
    lines: lines.map(toLine),
    lateAdjustmentFrom,
  });
  const replayed = await findByIdempotency(
    tx,
    context.tenant.tenantId,
    input.idempotencyKey,
  );
  if (replayed) return assertReplayMatches(replayed, fingerprint);
  const [reversal] = await tx
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.tenantId, context.tenant.tenantId),
        eq(journalEntries.reversalOf, entryId),
      ),
    )
    .limit(1);
  await assertNotDepreciationJournal(tx, context.tenant.tenantId, entryId);
  // The correction of a waived cash handover (legend-5qqb9): reversing it would
  // open cash that the employee already holds again.
  if (row.idempotencyKey?.startsWith("payroll-payout-waive:"))
    throw new HttpError(
      409,
      "PAYOUT_WAIVE_JOURNAL_LOCKED",
      "This journal corrects a waived cash payroll handover and cannot be reversed.",
    );
  if (input.manualReversal === true)
    await assertAutoCashOutSourceNotPaid(
      tx,
      context.tenant.tenantId,
      row,
      lines.map(toLine),
    );
  assertReversible(row, reversal?.id ?? null);
  if (input.manualReversal === true) assertNotSourceOwnedAccrual(row);
  await assertReturnBackingNotPaidOut(tx, context.tenant.tenantId, row);
  const reversalLines = buildReversalLines(
    {
      lines: lines.map(toLine),
      reversalOf: row.reversalOf as JournalEntry["reversalOf"],
    },
    reversal?.id ?? null,
  );
  assertPostingScope(context, row.outletId, reversalLines);
  const totalIdr = assertJournalBalanced(reversalLines);
  const period = await assertPeriodOpenForPosting(tx, context, {
    legalEntityId: row.legalEntityId,
    entryDate: input.entryDate,
  });
  // The manual endpoint only: a reversal that mirrors a debit to 1102 credits
  // it, pays out of petty cash and is refused when the cash is short
  // (legend-5qqb9). Entity lock is held.
  if (input.guardPettyCash === true)
    await assertJournalCredit1102Covered(
      tx,
      context.tenant.tenantId,
      row.legalEntityId,
      reversalLines,
    );
  const [reversalRow] = await tx
    .insert(journalEntries)
    .values({
      tenantId: context.tenant.tenantId,
      legalEntityId: row.legalEntityId,
      outletId: row.outletId,
      entryDate: input.entryDate,
      fiscalPeriodId: period.id,
      sourceType: "reversal",
      sourceId: null,
      description: input.reason,
      reversalOf: entryId,
      postedBy: input.postedBy,
      postedAt: now,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint,
      lateAdjustmentFrom,
    })
    .onConflictDoNothing()
    .returning();
  if (!reversalRow) {
    const concurrent = await findByIdempotency(
      tx,
      context.tenant.tenantId,
      input.idempotencyKey,
    );
    if (concurrent) return assertReplayMatches(concurrent, fingerprint);
    throw new AccountingError("JOURNAL_ALREADY_REVERSED");
  }
  const lineRows = await tx
    .insert(journalLines)
    .values(
      reversalLines.map((line, index) => ({
        tenantId: context.tenant.tenantId,
        entryId: reversalRow.id,
        accountId: line.accountId,
        lineNo: index + 1,
        debitIdr: line.debitIdr,
        creditIdr: line.creditIdr,
        outletId: line.outletId,
        costCenter: line.costCenter,
      })),
    )
    .returning();
  const entry = toEntry(reversalRow, lineRows);
  await appendJournalPosted(tx, context, entry, totalIdr, now);
  await auditAccountingChange(tx, context, {
    actorId: input.postedBy,
    action: "accounting.journal.reversed",
    objectType: "journal_entry",
    objectId: entryId,
    outletId: row.outletId,
    reason: input.reason,
    before: {
      entryDate: row.entryDate,
      sourceType: row.sourceType,
      reversalEntryId: null,
    },
    after: {
      entryDate: entry.entryDate,
      sourceType: entry.sourceType,
      reversalEntryId: entry.id,
    },
  });
  // ACC-04: a bank match of the reversed journal turns stale and opens a case.
  await markMatchStaleForReversedJournal(
    tx,
    context,
    {
      legalEntityId: row.legalEntityId,
      outletId: row.outletId,
      journalEntryId: entryId,
      reversalEntryId: entry.id,
      reversedBy: input.postedBy,
      reason: input.reason,
    },
    now,
  );
  return entry;
}
