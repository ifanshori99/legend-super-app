// Bank statement lines: list, manual match, exclude, unmatch, reconciliation
// summary (bead legend-fnxl.4, WS-07; PRD v1.7 §3.19 Kas & Bank, ACC-04).
// Contract: `@starter/shared/accounting` banking.ts + endpoints
// `listStatementLines`, `matchStatementLine`, `excludeStatementLine`,
// `unmatchStatementLine`, `getReconciliationSummary`.
//
// - Lines belong to a legal entity (no outlet): tenant scope only
//   (assertTenantScope). A foreign tenant's id is "not found" (RLS hides it).
// - Every write takes the entity lock first (`entityLock`), then the line row
//   FOR UPDATE, and re-reads the line after the lock so the state check and
//   the write see the same row.
// - Line state machine: manual match and exclude only from `unmatched`;
//   unmatch from matched / excluded; `in_case` lines are only moved by the
//   case workflow (INVALID_TRANSITION here). Every change bumps `version`,
//   sets status_changed_by/at and writes one audit row.
// - Unmatch restores the exact prior state: match rows deleted, the line back
//   to `unmatched` (reason cleared), cash deposits it held back to `recorded`
//   with no line id.

import {
  and,
  asc,
  eq,
  gt,
  gte,
  isNotNull,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  AccountingError,
  assertManualMatch,
  autoMatchRateBp,
  matchStatementLineInputSchema,
  excludeStatementLineInputSchema,
  type BankStatementLine,
  type MatchStatus,
} from "@starter/shared/accounting";
import {
  assertTrustedScopedContext,
  businessDateSchema,
  decodeCursor,
  encodeCursor,
  idempotencyKeySchema,
  uuidSchema,
  z,
  type CursorPage,
  type ScopedTenantContext,
  type TenantId,
  type UserId,
} from "@starter/shared/core";
import { db } from "../db";
import {
  bankStatementLineMatches,
  bankStatementLines,
  bankStatementMatchRejections,
  cashDeposits,
  type BankAccountRow,
  type BankStatementLineRow,
} from "../db/schema/accounting-cash-bank.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  assertTenantScope,
  auditApFa,
  idempotentCommand,
  type TenantTransaction,
} from "./accounting-ap-fa-shared.ts";
import {
  applyMatch,
  entityLock,
  resolveRefs,
} from "./accounting-bank-matching.ts";
import {
  loadBankAccount,
  loadMatchesByLine,
  notFound,
  statementLineDto,
} from "./accounting-cash-bank-shared.ts";

const MATCHED: readonly string[] = ["auto_matched", "manually_matched"];

const badCursor = () =>
  new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
const badRange = () =>
  new HttpError(
    422,
    "VALIDATION_ERROR",
    "Tanggal awal harus sebelum tanggal akhir.",
  );

export type ReconciliationSummary = {
  bankAccountId: string;
  from: string;
  to: string;
  lineCount: number;
  autoMatchedCount: number;
  manuallyMatchedCount: number;
  unmatchedCount: number;
  inCaseCount: number;
  excludedCount: number;
  autoMatchRateBp: number;
};

async function lineDto(
  tx: TenantTransaction,
  tenantId: TenantId,
  row: BankStatementLineRow,
): Promise<BankStatementLine> {
  const matches = await loadMatchesByLine(tx, tenantId, [row.id]);
  return statementLineDto(row, matches.get(row.id) ?? []);
}

/**
 * Entity lock first, then the line FOR UPDATE. The account (hence the entity)
 * is found from an unlocked read of the line; the line is read again under
 * the lock, so a concurrent writer is seen.
 */
async function lockLine(
  tx: TenantTransaction,
  tenantId: TenantId,
  lineId: string,
): Promise<{ line: BankStatementLineRow; account: BankAccountRow }> {
  const [probe] = await tx
    .select({ bankAccountId: bankStatementLines.bankAccountId })
    .from(bankStatementLines)
    .where(
      and(
        eq(bankStatementLines.tenantId, tenantId),
        eq(bankStatementLines.id, lineId),
      ),
    )
    .limit(1);
  if (!probe) throw notFound("Mutasi bank");
  const account = await loadBankAccount(tx, tenantId, probe.bankAccountId);
  await entityLock(tx, tenantId, account.legalEntityId);
  const [line] = await tx
    .select()
    .from(bankStatementLines)
    .where(
      and(
        eq(bankStatementLines.tenantId, tenantId),
        eq(bankStatementLines.id, lineId),
      ),
    )
    .limit(1)
    .for("update");
  if (!line) throw notFound("Mutasi bank");
  return { line, account };
}

/** Statement lines of one bank account in a posting window, keyset-paged. */
export async function listStatementLines(
  context: ScopedTenantContext,
  bankAccountId: string,
  query: {
    from: string;
    to: string;
    matchStatus?: MatchStatus;
    cursor?: string;
    limit: number;
  },
): Promise<CursorPage<BankStatementLine>> {
  assertTrustedScopedContext(context);
  assertTenantScope(context);
  if (query.from > query.to) throw badRange();
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    await loadBankAccount(tx, tenantId, bankAccountId);
    const filters: SQL[] = [
      eq(bankStatementLines.tenantId, tenantId),
      eq(bankStatementLines.bankAccountId, bankAccountId),
      gte(bankStatementLines.postedOn, query.from),
      lte(bankStatementLines.postedOn, query.to),
    ];
    if (query.matchStatus)
      filters.push(eq(bankStatementLines.matchStatus, query.matchStatus));
    if (query.cursor) {
      let keys: ReturnType<typeof decodeCursor>;
      try {
        keys = decodeCursor(query.cursor);
      } catch {
        throw badCursor();
      }
      const postedOn = businessDateSchema.safeParse(keys[0]);
      const id = uuidSchema.safeParse(keys[1]);
      if (!postedOn.success || !id.success) throw badCursor();
      const after = or(
        gt(bankStatementLines.postedOn, postedOn.data),
        and(
          eq(bankStatementLines.postedOn, postedOn.data),
          gt(bankStatementLines.id, id.data),
        ),
      );
      if (after) filters.push(after);
    }
    const rows = await tx
      .select()
      .from(bankStatementLines)
      .where(and(...filters))
      .orderBy(asc(bankStatementLines.postedOn), asc(bankStatementLines.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const matches = await loadMatchesByLine(
      tx,
      tenantId,
      page.map((row) => row.id),
    );
    return {
      data: page.map((row) => statementLineDto(row, matches.get(row.id) ?? [])),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.postedOn, last.id])
            : null,
      },
    };
  });
}

/** Manual match (contract `matchStatementLine`): documents must add up exactly. */
export async function matchStatementLine(
  context: ScopedTenantContext,
  lineId: string,
  rawInput: unknown,
  actorId: UserId,
): Promise<BankStatementLine> {
  const input = matchStatementLineInputSchema.parse(rawInput);
  assertTrustedScopedContext(context);
  assertTenantScope(context);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const { line, account } = await lockLine(tx, tenantId, lineId);
    if (MATCHED.includes(line.matchStatus))
      throw new AccountingError("STATEMENT_LINE_ALREADY_MATCHED");
    if (line.matchStatus !== "unmatched")
      throw new AccountingError("INVALID_TRANSITION");
    const documents = await resolveRefs(tx, tenantId, account, input.refs);
    assertManualMatch(
      {
        amountIdr: line.amountIdr,
        matchStatus: line.matchStatus as MatchStatus,
      },
      documents,
    );
    await applyMatch(tx, tenantId, {
      bankAccountId: account.id,
      lineId: line.id,
      documents,
      source: "manual",
      actorId,
    });
    await auditApFa(tx, context, {
      actorId,
      action: "accounting.bank_statement_line.matched",
      objectType: "bank_statement_line",
      objectId: line.id,
      before: { status: line.matchStatus },
      after: {
        status: "manually_matched",
        count: documents.length,
        amountIdr: line.amountIdr,
      },
    });
    const [updated] = await tx
      .select()
      .from(bankStatementLines)
      .where(
        and(
          eq(bankStatementLines.tenantId, tenantId),
          eq(bankStatementLines.id, line.id),
        ),
      )
      .limit(1);
    return lineDto(tx, tenantId, updated!);
  });
}

/** Excludes an unmatched line from reconciliation with a reason. */
export async function excludeStatementLine(
  context: ScopedTenantContext,
  lineId: string,
  rawInput: unknown,
  actorId: UserId,
): Promise<BankStatementLine> {
  const input = excludeStatementLineInputSchema.parse(rawInput);
  assertTrustedScopedContext(context);
  assertTenantScope(context);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const { line } = await lockLine(tx, tenantId, lineId);
    if (line.matchStatus !== "unmatched")
      throw new AccountingError("INVALID_TRANSITION");
    const [updated] = await tx
      .update(bankStatementLines)
      .set({
        matchStatus: "excluded",
        excludedReason: input.reason,
        version: sql`${bankStatementLines.version} + 1`,
        statusChangedBy: actorId,
        statusChangedAt: sql`now()`,
      })
      .where(
        and(
          eq(bankStatementLines.tenantId, tenantId),
          eq(bankStatementLines.id, line.id),
          eq(bankStatementLines.matchStatus, "unmatched"),
        ),
      )
      .returning();
    if (!updated) throw new AccountingError("INVALID_TRANSITION");
    await auditApFa(tx, context, {
      actorId,
      action: "accounting.bank_statement_line.excluded",
      objectType: "bank_statement_line",
      objectId: line.id,
      reason: input.reason,
      before: { status: line.matchStatus },
      after: { status: "excluded", amountIdr: line.amountIdr },
    });
    return lineDto(tx, tenantId, updated);
  });
}

const unmatchInputSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
});

/**
 * Unmatch (matched or excluded → unmatched), idempotent. Deletes the match
 * rows and puts the cash deposits that were matched to the line back to
 * `recorded`. Each removed (line, document) pair is remembered as a rejection
 * so auto-match skips it. A line in a case is refused (INVALID_TRANSITION).
 */
export async function unmatchStatementLine(
  context: ScopedTenantContext,
  lineId: string,
  rawInput: unknown,
  actorId: UserId,
): Promise<BankStatementLine> {
  const input = unmatchInputSchema.parse(rawInput);
  assertTrustedScopedContext(context);
  assertTenantScope(context);
  return withTenant(db, context, (tx) =>
    idempotentCommand(
      tx,
      context,
      {
        key: input.idempotencyKey,
        operation: "bank_statement_line.unmatch",
        request: { lineId },
      },
      async () => {
        const tenantId = context.tenant.tenantId;
        const { line } = await lockLine(tx, tenantId, lineId);
        if (
          !MATCHED.includes(line.matchStatus) &&
          line.matchStatus !== "excluded"
        )
          throw new AccountingError("INVALID_TRANSITION");
        const removed = await tx
          .delete(bankStatementLineMatches)
          .where(
            and(
              eq(bankStatementLineMatches.tenantId, tenantId),
              eq(bankStatementLineMatches.lineId, line.id),
            ),
          )
          .returning({
            refType: bankStatementLineMatches.refType,
            refId: bankStatementLineMatches.refId,
          });
        // Remember "not this one" so auto-match does not put it back.
        if (removed.length > 0)
          await tx
            .insert(bankStatementMatchRejections)
            .values(
              removed.map((row) => ({
                tenantId,
                bankAccountId: line.bankAccountId,
                lineId: line.id,
                refType: row.refType,
                refId: row.refId,
                rejectedBy: actorId,
              })),
            )
            .onConflictDoNothing();
        const restored = await tx
          .update(cashDeposits)
          .set({
            status: "recorded",
            bankStatementLineId: null,
            version: sql`${cashDeposits.version} + 1`,
          })
          .where(
            and(
              eq(cashDeposits.tenantId, tenantId),
              eq(cashDeposits.bankStatementLineId, line.id),
            ),
          )
          .returning({ id: cashDeposits.id });
        const [updated] = await tx
          .update(bankStatementLines)
          .set({
            matchStatus: "unmatched",
            excludedReason: null,
            version: sql`${bankStatementLines.version} + 1`,
            statusChangedBy: actorId,
            statusChangedAt: sql`now()`,
          })
          .where(
            and(
              eq(bankStatementLines.tenantId, tenantId),
              eq(bankStatementLines.id, line.id),
            ),
          )
          .returning();
        if (!updated) throw notFound("Mutasi bank");
        await auditApFa(tx, context, {
          actorId,
          action: "accounting.bank_statement_line.unmatched",
          objectType: "bank_statement_line",
          objectId: line.id,
          before: { status: line.matchStatus, count: removed.length },
          after: { status: "unmatched", count: restored.length },
        });
        return lineDto(tx, tenantId, updated);
      },
    ),
  );
}

/** Counts by match status in a posting window, with the ACC-04 auto rate. */
export async function getReconciliationSummary(
  context: ScopedTenantContext,
  bankAccountId: string,
  query: { from: string; to: string },
): Promise<ReconciliationSummary> {
  assertTrustedScopedContext(context);
  assertTenantScope(context);
  if (query.from > query.to) throw badRange();
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    await loadBankAccount(tx, tenantId, bankAccountId);
    const raw = await tx
      .select({
        id: bankStatementLines.id,
        matchStatus: bankStatementLines.matchStatus,
      })
      .from(bankStatementLines)
      .where(
        and(
          eq(bankStatementLines.tenantId, tenantId),
          eq(bankStatementLines.bankAccountId, bankAccountId),
          gte(bankStatementLines.postedOn, query.from),
          lte(bankStatementLines.postedOn, query.to),
        ),
      );
    const staleLines = await tx
      .select({ lineId: bankStatementLineMatches.lineId })
      .from(bankStatementLineMatches)
      .where(
        and(
          eq(bankStatementLineMatches.tenantId, tenantId),
          eq(bankStatementLineMatches.bankAccountId, bankAccountId),
          isNotNull(bankStatementLineMatches.staleAt),
        ),
      );
    const staleLineIds = new Set(staleLines.map((row) => row.lineId));
    // A match whose journal was reversed (stale) is no clean match: the line
    // waits for a person, so it counts as in a case (a case was opened with it).
    const rows = raw.map((row) => ({
      matchStatus: (MATCHED.includes(row.matchStatus) &&
      staleLineIds.has(row.id)
        ? "in_case"
        : row.matchStatus) as MatchStatus,
    }));
    const count = (status: MatchStatus) =>
      rows.filter((row) => row.matchStatus === status).length;
    return {
      bankAccountId,
      from: query.from,
      to: query.to,
      lineCount: rows.length,
      autoMatchedCount: count("auto_matched"),
      manuallyMatchedCount: count("manually_matched"),
      unmatchedCount: count("unmatched"),
      inCaseCount: count("in_case"),
      excludedCount: count("excluded"),
      autoMatchRateBp: autoMatchRateBp(rows as { matchStatus: MatchStatus }[]),
    };
  });
}
