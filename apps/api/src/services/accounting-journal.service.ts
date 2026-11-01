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
// ACC-01 rules come from the contract and are repeated by migration 0015:
// at least two lines, debit XOR credit, equal totals, posted entries final,
// corrections only through a reversal (once, never of a reversal).
//
// `expectedVersion` lets a caller that read the period earlier fail with
// PERIOD_CHANGED instead of posting into a period that closed meanwhile.

import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  inArray,
  lt,
  lte,
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
} from "@starter/shared/accounting";
import {
  businessDateSchema,
  CoreError,
  createUlid,
  decodeCursor,
  encodeCursor,
  idempotencyKeySchema,
  outletIdsForQuery,
  type BusinessDate,
  type CursorPage,
  type OutletId,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import { db } from "../db";
import {
  accountMappings,
  chartOfAccounts,
  journalEntries,
  journalLines,
} from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { assertPeriodOpenForPosting } from "./accounting-period.service";
import {
  auditAccountingChange,
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
 * outlets. Entity-level entries (payroll, depreciation) need tenant scope.
 */
function assertPostingScope(
  context: ScopedTenantContext,
  outletId: string | null,
  lines: readonly Pick<JournalLineInput, "outletId">[],
): void {
  if (outletId !== null) {
    outletIdsForQuery(context.outletScope, [outletId]);
  }
  for (const line of lines)
    if (line.outletId !== null)
      outletIdsForQuery(context.outletScope, [line.outletId]);
  if (context.outletScope.kind !== "tenant" && outletId === null)
    throw new CoreError(
      "OUTLET_OUT_OF_SCOPE",
      "Jurnal tingkat badan usaha memerlukan akses seluruh tenant.",
    );
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
): Promise<JournalEntry | null> {
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
  return toEntry(row, await entryLines(tx, tenantId, row.id));
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
  const parsed = parsePostInput(input);
  assertPostingScope(context, parsed.outletId, parsed.lines);
  const replayed = await findByIdempotency(
    tx,
    context.tenant.tenantId,
    parsed.idempotencyKey,
  );
  if (replayed) {
    // A key identifies one business fact: reusing it for another document is a
    // caller bug, not a retry, so refuse instead of returning a foreign entry.
    if (
      replayed.legalEntityId !== parsed.legalEntityId ||
      replayed.sourceType !== parsed.sourceType
    )
      throw new HttpError(
        409,
        "CONFLICT",
        "That idempotency key belongs to another journal entry.",
      );
    return replayed;
  }
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
    if (concurrent) return concurrent;
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
  const accountMap = accountMapFor(
    mappingRows.map((row) =>
      accountMappingSchema.parse({
        tenantId: row.tenantId,
        legalEntityId: row.legalEntityId,
        role: row.role,
        accountId: row.accountId,
      }),
    ),
    input.legalEntityId as LegalEntityId,
  );
  const lines = buildJournalLinesFromRule(rule, input.amounts, accountMap, {
    outletId: input.outletId as OutletId | null,
    costCenter: input.costCenter ?? null,
  });
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

function outletScopeCondition(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  outletId: string | undefined,
): SQL | undefined {
  const scope = outletIdsForQuery(
    context.outletScope,
    outletId === undefined ? undefined : [outletId],
  );
  if (scope.kind === "all") return undefined;
  const ids = [...scope.outletIds];
  return or(
    inArray(journalEntries.outletId, ids),
    exists(
      tx
        .select({ one: sql`1` })
        .from(journalLines)
        .where(
          and(
            eq(journalLines.tenantId, context.tenant.tenantId),
            eq(journalLines.entryId, journalEntries.id),
            inArray(journalLines.outletId, ids),
          ),
        ),
    ),
  );
}

/** One page of entry summaries, newest first, keyset on (entry_date, id). */
export async function listJournals(
  context: ScopedTenantContext,
  query: ListJournalsQuery,
): Promise<CursorPage<JournalEntrySummary>> {
  return withTenant(db, context, async (tx) => {
    await requireLegalEntity(tx, context.tenant.tenantId, query.legalEntityId);
    const filters: SQL[] = [
      eq(journalEntries.tenantId, context.tenant.tenantId),
      eq(journalEntries.legalEntityId, query.legalEntityId),
      gte(journalEntries.entryDate, query.from),
      lte(journalEntries.entryDate, query.to),
    ];
    const scopeFilter = outletScopeCondition(tx, context, query.outletId);
    if (scopeFilter) filters.push(scopeFilter);
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

async function visibleToScope(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  entry: EntryRow,
): Promise<boolean> {
  if (context.outletScope.kind === "tenant") return true;
  const ids = context.outletScope.outletIds as string[];
  if (entry.outletId !== null && ids.includes(entry.outletId)) return true;
  const [line] = await tx
    .select({ one: sql`1` })
    .from(journalLines)
    .where(
      and(
        eq(journalLines.tenantId, context.tenant.tenantId),
        eq(journalLines.entryId, entry.id),
        inArray(journalLines.outletId, ids),
      ),
    )
    .limit(1);
  return line !== undefined;
}

export async function getJournal(
  context: ScopedTenantContext,
  entryId: string,
): Promise<{ entry: JournalEntry; reversedBy: string | null }> {
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
      .limit(1)
      .for("update");
    if (!row || !(await visibleToScope(tx, context, row)))
      throw new HttpError(404, "NOT_FOUND", "Journal entry not found.");
    const replayed = await findByIdempotency(
      tx,
      context.tenant.tenantId,
      request.idempotencyKey,
    );
    if (replayed) {
      if (replayed.reversalOf !== entryId)
        throw new HttpError(
          409,
          "CONFLICT",
          "That idempotency key belongs to another entry.",
        );
      return replayed;
    }
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
    assertReversible(row, reversal?.id ?? null);
    const lines = await entryLines(tx, context.tenant.tenantId, entryId);
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
      entryDate: request.entryDate,
    });
    const [reversalRow] = await tx
      .insert(journalEntries)
      .values({
        tenantId: context.tenant.tenantId,
        legalEntityId: row.legalEntityId,
        outletId: row.outletId,
        entryDate: request.entryDate,
        fiscalPeriodId: period.id,
        sourceType: "reversal",
        sourceId: null,
        description: request.reason,
        reversalOf: entryId,
        postedBy: actorId,
        postedAt: now,
        idempotencyKey: request.idempotencyKey,
      })
      .onConflictDoNothing()
      .returning();
    if (!reversalRow) {
      const concurrent = await findByIdempotency(
        tx,
        context.tenant.tenantId,
        request.idempotencyKey,
      );
      if (concurrent?.reversalOf === entryId) return concurrent;
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
      actorId,
      action: "accounting.journal.reversed",
      objectType: "journal_entry",
      objectId: entryId,
      outletId: row.outletId,
      reason: request.reason,
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
    return entry;
  });
}
