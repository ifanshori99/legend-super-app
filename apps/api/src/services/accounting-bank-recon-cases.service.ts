// Reconciliation cases (bead legend-fnxl.6, WS-07; PRD v1.7 §3.19 Kas & Bank,
// ACC-04 "setiap selisih menjadi kasus dengan PIC"). Contract: banking.ts
// (`reconciliationCaseSchema`, `transitionReconciliationCase`).
//
// - Open: the owner (PIC) must hold an active role assignment in the tenant.
//   `bank_statement_line` refs must be unmatched lines of the entity (they
//   become `in_case`); `cash_deposit` refs must be `recorded` (they become
//   `discrepancy`). Other ref types are kept as opaque references (matching
//   them is legend-cs7), except `journal_entry`, which must be of the entity.
// - Actions: the case row is locked FOR UPDATE, the status change comes from
//   the shared state machine, and every action writes exactly one append-only
//   event row (seq = max + 1) with actor, from/to status and from/to owner.
// - Write-off books nothing here (automatic posting is legend-9pz9): the
//   adjustment journal is only validated (same entity, not a reversal or
//   reversed, debits = |difference|, used by no other case, deposit or match).
// - Locks: the entity lock `acc-cashbank:<tenant>:<entity>` comes first, then
//   the row locks, like every other cash & bank writer.
// - Due date: the tenant finance policy `reconciliationPolicy.caseDueDays`
//   (default 7) read when the case opens; an open case keeps its dueAt.

import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  AccountingError,
  reconciliationCaseActionInputSchema,
  transitionReconciliationCase,
  openReconciliationCaseInputSchema,
  type ReconciliationCase,
  type ReconciliationCaseAction,
  type ReconciliationCaseStatus,
} from "@starter/shared/accounting";
import {
  CoreError,
  decodeCursor,
  encodeCursor,
  outletIdsForQuery,
  uuidSchema,
  type CursorPage,
  type ScopedTenantContext,
  type TenantId,
  type UserId,
} from "@starter/shared/core";
import { db } from "../db";
import { journalEntries, journalLines } from "../db/schema/accounting.ts";
import {
  bankAccounts,
  bankReconciliationCaseEvents,
  bankReconciliationCases,
  bankStatementLineMatches,
  bankStatementLines,
  cashDeposits,
  type BankReconciliationCaseRow,
} from "../db/schema/accounting-cash-bank.ts";
import { roleAssignments } from "../db/schema/platform-access.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  assertOutletReach,
  assertTenantScope,
  auditApFa,
  idempotentCommand,
  outletVisible,
  type TenantTransaction,
} from "./accounting-ap-fa-shared.ts";
import { entityLock } from "./accounting-bank-matching.ts";
import { loadReconciliationPolicyInTx } from "./accounting-finance-policy.service.ts";
import {
  notFound,
  reconciliationCaseDto,
} from "./accounting-cash-bank-shared.ts";
import { requireLegalEntity } from "./accounting-shared.ts";

const CASE_NOT_FOUND = "Kasus rekonsiliasi";
const DAY_MS = 86_400_000;

const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const invalidCursor = () =>
  new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");

/** The PIC must hold a role assignment that is valid now in this tenant. */
async function assertActiveOwner(
  tx: TenantTransaction,
  tenantId: TenantId,
  ownerId: string,
  now: Date,
): Promise<void> {
  const [row] = await tx
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.tenantId, tenantId),
        eq(roleAssignments.userId, ownerId),
        sql`${roleAssignments.validFrom} <= ${now}`,
        or(
          isNull(roleAssignments.validUntil),
          sql`${roleAssignments.validUntil} > ${now}`,
        ),
      ),
    )
    .limit(1);
  if (!row)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Penanggung jawab kasus tidak memiliki peran aktif di tenant ini.",
    );
}

type OpenInput = ReturnType<typeof openReconciliationCaseInputSchema.parse>;

/** Locks the statement lines of the entity; every one must be unmatched. */
async function lockStatementLines(
  tx: TenantTransaction,
  tenantId: TenantId,
  legalEntityId: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const lines = await tx
    .select()
    .from(bankStatementLines)
    .where(
      and(
        eq(bankStatementLines.tenantId, tenantId),
        inArray(bankStatementLines.id, ids),
      ),
    )
    .for("update");
  const accountIds = [...new Set(lines.map((line) => line.bankAccountId))];
  const accounts =
    accountIds.length === 0
      ? []
      : await tx
          .select({ id: bankAccounts.id })
          .from(bankAccounts)
          .where(
            and(
              eq(bankAccounts.tenantId, tenantId),
              eq(bankAccounts.legalEntityId, legalEntityId),
              inArray(bankAccounts.id, accountIds),
            ),
          );
  const ofEntity = new Set(accounts.map((account) => account.id));
  const byId = new Map(
    lines
      .filter((line) => ofEntity.has(line.bankAccountId))
      .map((line) => [line.id, line]),
  );
  for (const id of ids) {
    const line = byId.get(id);
    if (!line) throw notFound("Baris mutasi");
    if (line.matchStatus === "excluded")
      throw new AccountingError("INVALID_TRANSITION");
    if (line.matchStatus !== "unmatched")
      throw new AccountingError("STATEMENT_LINE_ALREADY_MATCHED");
  }
}

/** Locks the cash deposits of the entity; every one must be `recorded`. */
async function lockCashDeposits(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  legalEntityId: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const rows = await tx
    .select()
    .from(cashDeposits)
    .where(
      and(
        eq(cashDeposits.tenantId, context.tenant.tenantId),
        eq(cashDeposits.legalEntityId, legalEntityId),
        inArray(cashDeposits.id, ids),
      ),
    )
    .for("update");
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const id of ids) {
    const deposit = byId.get(id);
    if (!deposit) throw notFound("Setoran kas");
    assertOutletReach(context, deposit.outletId);
    if (deposit.status !== "recorded")
      throw new AccountingError("INVALID_TRANSITION");
  }
}

async function assertJournalsOfEntity(
  tx: TenantTransaction,
  tenantId: TenantId,
  legalEntityId: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const rows = await tx
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.tenantId, tenantId),
        eq(journalEntries.legalEntityId, legalEntityId),
        inArray(journalEntries.id, ids),
      ),
    );
  const found = new Set(rows.map((row) => row.id));
  for (const id of ids) if (!found.has(id)) throw notFound("Jurnal");
}

/** A document already matched to a statement line cannot open a case. */
async function assertNotMatched(
  tx: TenantTransaction,
  tenantId: TenantId,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const [taken] = await tx
    .select({ id: bankStatementLineMatches.id })
    .from(bankStatementLineMatches)
    .where(
      and(
        eq(bankStatementLineMatches.tenantId, tenantId),
        inArray(bankStatementLineMatches.refType, [
          "journal_entry",
          "cash_deposit",
        ]),
        inArray(bankStatementLineMatches.refId, ids),
      ),
    )
    .limit(1);
  if (taken) throw new AccountingError("STATEMENT_LINE_ALREADY_MATCHED");
}

export async function openReconciliationCase(
  context: ScopedTenantContext,
  rawInput: unknown,
  actorId: UserId,
): Promise<ReconciliationCase> {
  const input: OpenInput = openReconciliationCaseInputSchema.parse(rawInput);
  const keys = input.refs.map((ref) => `${ref.type}:${ref.id}`);
  if (new Set(keys).size !== keys.length)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Satu dokumen hanya boleh muncul sekali dalam kasus.",
    );
  const idsOf = (type: string) =>
    input.refs.filter((ref) => ref.type === type).map((ref) => ref.id);
  const lineIds = idsOf("bank_statement_line");
  const depositIds = idsOf("cash_deposit");
  const journalIds = idsOf("journal_entry");
  assertOutletReach(context, input.outletId);
  // Statement lines belong to the entity, not to an outlet.
  if (lineIds.length > 0) assertTenantScope(context);

  return withTenant(db, context, async (tx) =>
    idempotentCommand(
      tx,
      context,
      {
        key: input.idempotencyKey,
        operation: "reconciliation_case.open",
        request: {
          legalEntityId: input.legalEntityId,
          outletId: input.outletId,
          type: input.type,
          differenceIdr: input.differenceIdr,
          ownerId: input.ownerId,
          refs: input.refs,
        },
      },
      async () => {
        const tenantId = context.tenant.tenantId;
        const now = new Date();
        const { caseDueDays } = await loadReconciliationPolicyInTx(
          tx,
          tenantId,
        );
        await requireLegalEntity(tx, tenantId, input.legalEntityId);
        if (input.outletId !== null) {
          const [outlet] = await tx
            .select({ id: outlets.id })
            .from(outlets)
            .where(
              and(
                eq(outlets.tenantId, tenantId),
                eq(outlets.id, input.outletId),
                eq(outlets.legalEntityId, input.legalEntityId),
              ),
            )
            .limit(1);
          if (!outlet)
            throw new HttpError(
              422,
              "VALIDATION_ERROR",
              "Outlet bukan milik badan usaha ini.",
            );
        }
        await assertActiveOwner(tx, tenantId, input.ownerId, now);

        await entityLock(tx, tenantId, input.legalEntityId);
        await lockStatementLines(tx, tenantId, input.legalEntityId, lineIds);
        await lockCashDeposits(tx, context, input.legalEntityId, depositIds);
        await assertJournalsOfEntity(
          tx,
          tenantId,
          input.legalEntityId,
          journalIds,
        );
        await assertNotMatched(tx, tenantId, [...journalIds, ...depositIds]);

        const [row] = await tx
          .insert(bankReconciliationCases)
          .values({
            tenantId,
            legalEntityId: input.legalEntityId,
            outletId: input.outletId,
            type: input.type,
            differenceIdr: input.differenceIdr,
            ownerId: input.ownerId,
            status: "open",
            dueAt: new Date(now.getTime() + caseDueDays * DAY_MS),
            refs: input.refs,
            idempotencyKey: input.idempotencyKey,
            openedBy: actorId,
            openedAt: now,
          })
          .returning();
        if (!row) throw new Error("Reconciliation case insert returned no row");

        if (lineIds.length > 0) {
          await tx
            .update(bankStatementLines)
            .set({
              matchStatus: "in_case",
              reconciliationCaseId: row.id,
              statusChangedBy: actorId,
              statusChangedAt: now,
              version: sql`${bankStatementLines.version} + 1`,
            })
            .where(
              and(
                eq(bankStatementLines.tenantId, tenantId),
                inArray(bankStatementLines.id, lineIds),
              ),
            );
          for (const id of lineIds)
            await auditApFa(tx, context, {
              actorId,
              action: "accounting.bank_statement_line.in_case",
              objectType: "bank_statement_line",
              objectId: id,
              before: { status: "unmatched" },
              after: { status: "in_case" },
            });
        }
        if (depositIds.length > 0) {
          await tx
            .update(cashDeposits)
            .set({
              status: "discrepancy",
              reconciliationCaseId: row.id,
              version: sql`${cashDeposits.version} + 1`,
            })
            .where(
              and(
                eq(cashDeposits.tenantId, tenantId),
                inArray(cashDeposits.id, depositIds),
              ),
            );
          for (const id of depositIds)
            await auditApFa(tx, context, {
              actorId,
              action: "accounting.cash_deposit.discrepancy",
              objectType: "cash_deposit",
              objectId: id,
              before: { status: "recorded" },
              after: { status: "discrepancy" },
            });
        }
        await tx.insert(bankReconciliationCaseEvents).values({
          tenantId,
          caseId: row.id,
          seq: 1,
          action: "open",
          actorId,
          fromStatus: null,
          toStatus: "open",
          fromOwnerId: null,
          toOwnerId: input.ownerId,
          note: null,
          at: now,
        });
        await auditApFa(tx, context, {
          actorId,
          action: "accounting.reconciliation_case.opened",
          objectType: "reconciliation_case",
          objectId: row.id,
          outletId: input.outletId,
          before: null,
          after: { status: "open", count: input.refs.length },
        });
        return reconciliationCaseDto(row);
      },
    ),
  );
}

export type ReconciliationCaseListQuery = {
  legalEntityId: string;
  status?: ReconciliationCaseStatus;
  outletId?: string;
  cursor?: string;
  limit: number;
};

/** Newest first, keyset-paged on (opened_at, id); outlet visibility as TEN-03. */
export async function listReconciliationCases(
  context: ScopedTenantContext,
  query: ReconciliationCaseListQuery,
): Promise<CursorPage<ReconciliationCase>> {
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    await requireLegalEntity(tx, tenantId, query.legalEntityId);
    const filters: SQL[] = [
      eq(bankReconciliationCases.tenantId, tenantId),
      eq(bankReconciliationCases.legalEntityId, query.legalEntityId),
    ];
    if (query.status)
      filters.push(eq(bankReconciliationCases.status, query.status));
    const reach = outletIdsForQuery(
      context.outletScope,
      query.outletId ? [query.outletId] : undefined,
    );
    if (reach.kind === "outlets")
      filters.push(
        inArray(bankReconciliationCases.outletId, [...reach.outletIds]),
      );
    if (query.cursor) {
      let keys: ReturnType<typeof decodeCursor>;
      try {
        keys = decodeCursor(query.cursor);
      } catch {
        throw invalidCursor();
      }
      const openedAt = typeof keys[0] === "string" ? keys[0] : "";
      const id = uuidSchema.safeParse(keys[1]);
      if (!CURSOR_AT.test(openedAt) || !id.success) throw invalidCursor();
      const before = or(
        sql`${bankReconciliationCases.openedAt} < ${openedAt}::timestamptz`,
        and(
          sql`${bankReconciliationCases.openedAt} = ${openedAt}::timestamptz`,
          lt(bankReconciliationCases.id, id.data),
        ),
      );
      if (before) filters.push(before);
    }
    const rows = await tx
      .select({
        row: bankReconciliationCases,
        openedKey: sql<string>`to_char(${bankReconciliationCases.openedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(bankReconciliationCases)
      .where(and(...filters))
      .orderBy(
        desc(bankReconciliationCases.openedAt),
        desc(bankReconciliationCases.id),
      )
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(({ row }) => reconciliationCaseDto(row)),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.openedKey, last.row.id])
            : null,
      },
    };
  });
}

async function loadCase(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  caseId: string,
  options: { forUpdate?: boolean } = {},
): Promise<BankReconciliationCaseRow> {
  const query = tx
    .select()
    .from(bankReconciliationCases)
    .where(
      and(
        eq(bankReconciliationCases.tenantId, context.tenant.tenantId),
        eq(bankReconciliationCases.id, caseId),
      ),
    )
    .limit(1);
  const [row] = options.forUpdate ? await query.for("update") : await query;
  // A case the caller cannot reach is "not found", never "forbidden".
  if (!row || !outletVisible(context, row.outletId))
    throw notFound(CASE_NOT_FOUND);
  return row;
}

export async function getReconciliationCase(
  context: ScopedTenantContext,
  caseId: string,
): Promise<ReconciliationCase> {
  return withTenant(db, context, async (tx) =>
    reconciliationCaseDto(await loadCase(tx, context, caseId)),
  );
}

const conflict = (message: string) => new CoreError("CONFLICT", message);

/** Q5: validates the adjustment journal of a write-off; posts nothing. */
async function assertWriteOffJournal(
  tx: TenantTransaction,
  tenantId: TenantId,
  current: BankReconciliationCaseRow,
  journalId: string,
): Promise<void> {
  const [entry] = await tx
    .select()
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.tenantId, tenantId),
        eq(journalEntries.id, journalId),
      ),
    )
    .limit(1);
  if (!entry) throw notFound("Jurnal");
  if (entry.legalEntityId !== current.legalEntityId)
    throw new AccountingError("ACCOUNT_ENTITY_MISMATCH");
  const [reversed] = await tx
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.tenantId, tenantId),
        eq(journalEntries.reversalOf, journalId),
      ),
    )
    .limit(1);
  if (entry.reversalOf !== null || reversed)
    throw new AccountingError("JOURNAL_ALREADY_REVERSED");
  const [totals] = await tx
    .select({ debit: sql<string>`coalesce(sum(${journalLines.debitIdr}), 0)` })
    .from(journalLines)
    .where(
      and(
        eq(journalLines.tenantId, tenantId),
        eq(journalLines.entryId, journalId),
      ),
    );
  if (Number(totals?.debit ?? 0) !== Math.abs(current.differenceIdr))
    throw new AccountingError("POSTING_AMOUNTS_MISMATCH");
  const [otherCase] = await tx
    .select({ id: bankReconciliationCases.id })
    .from(bankReconciliationCases)
    .where(
      and(
        eq(bankReconciliationCases.tenantId, tenantId),
        eq(bankReconciliationCases.adjustmentJournalEntryId, journalId),
      ),
    )
    .limit(1);
  if (otherCase)
    throw conflict("Jurnal ini sudah dipakai kasus rekonsiliasi lain.");
  const [deposit] = await tx
    .select({ id: cashDeposits.id })
    .from(cashDeposits)
    .where(
      and(
        eq(cashDeposits.tenantId, tenantId),
        eq(cashDeposits.journalEntryId, journalId),
      ),
    )
    .limit(1);
  if (deposit) throw conflict("Jurnal ini adalah jurnal setoran kas.");
  const [matched] = await tx
    .select({ id: bankStatementLineMatches.id })
    .from(bankStatementLineMatches)
    .where(
      and(
        eq(bankStatementLineMatches.tenantId, tenantId),
        eq(bankStatementLineMatches.refType, "journal_entry"),
        eq(bankStatementLineMatches.refId, journalId),
      ),
    )
    .limit(1);
  if (matched)
    throw conflict("Jurnal ini sudah dicocokkan dengan mutasi bank.");
}

export async function actOnReconciliationCase(
  context: ScopedTenantContext,
  caseId: string,
  rawInput: unknown,
  actorId: UserId,
): Promise<ReconciliationCase> {
  const input = reconciliationCaseActionInputSchema.parse(rawInput);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const now = new Date();
    const seen = await loadCase(tx, context, caseId);
    assertOutletReach(context, seen.outletId);
    await entityLock(tx, tenantId, seen.legalEntityId);
    const current = await loadCase(tx, context, caseId, { forUpdate: true });

    let action: ReconciliationCaseAction;
    switch (input.type) {
      case "start":
        action = { type: "start", actorId };
        break;
      case "reassign":
        action = { type: "reassign", actorId, ownerId: input.ownerId };
        break;
      case "resolve":
        action = { type: "resolve", actorId, note: input.note };
        break;
      case "write_off":
        action = {
          type: "write_off",
          actorId,
          note: input.note,
          adjustmentJournalEntryId: input.adjustmentJournalEntryId,
        };
        break;
    }
    const toStatus = transitionReconciliationCase(
      { status: current.status as ReconciliationCaseStatus },
      action,
    );
    if (input.type === "reassign")
      await assertActiveOwner(tx, tenantId, input.ownerId, now);
    if (input.type === "write_off")
      await assertWriteOffJournal(
        tx,
        tenantId,
        current,
        input.adjustmentJournalEntryId,
      );

    const toOwnerId =
      input.type === "reassign" ? input.ownerId : current.ownerId;
    const closing = input.type === "resolve" || input.type === "write_off";
    const [updated] = await tx
      .update(bankReconciliationCases)
      .set({
        status: toStatus,
        ownerId: toOwnerId,
        version: sql`${bankReconciliationCases.version} + 1`,
        ...(closing
          ? {
              resolvedBy: actorId,
              resolvedAt: now,
              resolutionNote: input.note,
            }
          : {}),
        ...(input.type === "write_off"
          ? { adjustmentJournalEntryId: input.adjustmentJournalEntryId }
          : {}),
      })
      .where(
        and(
          eq(bankReconciliationCases.tenantId, tenantId),
          eq(bankReconciliationCases.id, caseId),
        ),
      )
      .returning();
    if (!updated) throw notFound(CASE_NOT_FOUND);

    const [last] = await tx
      .select({
        seq: sql<number>`coalesce(max(${bankReconciliationCaseEvents.seq}), 0)`,
      })
      .from(bankReconciliationCaseEvents)
      .where(
        and(
          eq(bankReconciliationCaseEvents.tenantId, tenantId),
          eq(bankReconciliationCaseEvents.caseId, caseId),
        ),
      );
    await tx.insert(bankReconciliationCaseEvents).values({
      tenantId,
      caseId,
      seq: Number(last?.seq ?? 0) + 1,
      action: input.type,
      actorId,
      fromStatus: current.status,
      toStatus,
      fromOwnerId: current.ownerId,
      toOwnerId,
      note: closing ? input.note : null,
      at: now,
    });
    await auditApFa(tx, context, {
      actorId,
      action: `accounting.reconciliation_case.${input.type}`,
      objectType: "reconciliation_case",
      objectId: caseId,
      outletId: current.outletId,
      before: { status: current.status },
      after: {
        status: toStatus,
        ...(input.type === "write_off"
          ? { journalEntryId: input.adjustmentJournalEntryId }
          : {}),
      },
    });
    return reconciliationCaseDto(updated);
  });
}
