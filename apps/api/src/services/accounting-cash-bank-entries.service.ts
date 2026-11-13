// Cash in, cash out and bank-to-bank transfers (bead legend-4961, WS-07; PRD
// v1.7 §3.19 Kas & Bank). Contract: `@starter/shared/accounting` banking.ts,
// endpoints `listCashBankEntries` / `getCashBankEntry` / `createCashBankEntry`.
// Design: docs/briefs/ws-cash-bank-design.md.
//
// - One document, one journal: the journal is posted in the same transaction
//   as the `cash_bank_entries` row (journal_entry_id is NOT NULL and UNIQUE),
//   under the server-derived key `cb:<entryId>`. A failed posting rolls the
//   whole request back; a cash/bank document is never parked.
// - Bank accounts live on the legal entity, so a write needs tenant scope
//   (assertTenantScope). The optional outlet tag is only a cost tag.
// - Idempotent per client key (`idempotentCommand`): a replay returns the same
//   entry, the same key with another body is IDEMPOTENCY_KEY_REUSED (409).
// - The counter account of cash in/out is chosen by the caller and must not be
//   a cash or bank account (use a transfer); the bank leg is always the GL
//   account of the chosen bank account. Nothing is guessed.
// - Reads are narrowed to the caller's outlets: an outlet-scoped caller sees
//   only entries tagged to one of its outlets (entity-level rows are hidden).

import { randomUUID } from "node:crypto";
import { and, desc, eq, or, sql, type SQL } from "drizzle-orm";
import {
  AccountingError,
  cashBankJournalLines,
  createCashBankEntryInputSchema,
  type CashBankEntry,
  type CreateCashBankEntryInput,
} from "@starter/shared/accounting";
import {
  assertTrustedScopedContext,
  decodeCursor,
  encodeCursor,
  outletIdsForQuery,
  uuidSchema,
  type BusinessDate,
  type CursorPage,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import { db } from "../db";
import { chartOfAccounts } from "../db/schema/accounting.ts";
import {
  cashBankEntries,
  type CashBankEntryRow,
} from "../db/schema/accounting-cash-bank-entries.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  assertTenantScope,
  auditApFa,
  entityToday,
  idempotentCommand,
  type TenantTransaction,
} from "./accounting-ap-fa-shared.ts";
import { entityLock } from "./accounting-bank-matching.ts";
import { loadBankAccount, notFound } from "./accounting-cash-bank-shared.ts";
import { postJournalInTransaction } from "./accounting-journal.service.ts";
import { requireLegalEntity } from "./accounting-shared.ts";

export type CashBankEntryListQuery = {
  legalEntityId: string;
  from: string;
  to: string;
  kind?: CashBankEntry["kind"];
  bankAccountId?: string;
  cursor?: string;
  limit: number;
};

const OPERATION = "cash_bank.entry.create";
const SOURCE_TYPES = {
  cash_in: "cash_receipt",
  cash_out: "cash_payment",
  transfer: "bank_transfer",
} as const;

export function cashBankEntryDto(row: CashBankEntryRow): CashBankEntry {
  return {
    id: row.id,
    tenantId: row.tenantId,
    legalEntityId: row.legalEntityId,
    outletId: row.outletId,
    kind: row.kind,
    entryDate: row.entryDate,
    amountIdr: row.amountIdr,
    bankAccountId: row.bankAccountId,
    toBankAccountId: row.toBankAccountId,
    counterAccountId: row.counterAccountId,
    description: row.description,
    reference: row.reference,
    journalEntryId: row.journalEntryId,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  } as CashBankEntry;
}

const invalid = (message: string) =>
  new HttpError(422, "VALIDATION_ERROR", message);

/** Outlet ids the caller may see: filter for SQL, or null for "all". */
function reachOf(context: ScopedTenantContext): readonly string[] | null {
  const filter = outletIdsForQuery(context.outletScope);
  return filter.kind === "all" ? null : filter.outletIds;
}

const outletIn = (ids: readonly string[]) =>
  ids.length === 0
    ? sql`FALSE`
    : sql`${cashBankEntries.outletId} IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`;

async function loadEntry(
  tx: TenantTransaction,
  tenantId: string,
  entryId: string,
): Promise<CashBankEntryRow> {
  const [row] = await tx
    .select()
    .from(cashBankEntries)
    .where(
      and(
        eq(cashBankEntries.tenantId, tenantId),
        eq(cashBankEntries.id, entryId),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Transaksi kas dan bank");
  return row;
}

/** Entries of one legal entity in [from, to], newest first, keyset (created_at, id). */
export async function listCashBankEntries(
  context: ScopedTenantContext,
  query: CashBankEntryListQuery,
): Promise<CursorPage<CashBankEntry>> {
  assertTrustedScopedContext(context);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    await requireLegalEntity(tx, tenantId, query.legalEntityId);
    const reach = reachOf(context);
    const filters: SQL[] = [
      eq(cashBankEntries.tenantId, tenantId),
      eq(cashBankEntries.legalEntityId, query.legalEntityId),
      sql`${cashBankEntries.entryDate} BETWEEN ${query.from}::date AND ${query.to}::date`,
    ];
    if (reach) filters.push(outletIn(reach));
    if (query.kind) filters.push(eq(cashBankEntries.kind, query.kind));
    if (query.bankAccountId)
      filters.push(
        or(
          eq(cashBankEntries.bankAccountId, query.bankAccountId),
          eq(cashBankEntries.toBankAccountId, query.bankAccountId),
        )!,
      );
    if (query.cursor) {
      let keys: ReturnType<typeof decodeCursor>;
      try {
        keys = decodeCursor(query.cursor);
      } catch {
        throw invalid("Check the cursor.");
      }
      const at = typeof keys[0] === "string" ? keys[0] : "";
      const id = uuidSchema.safeParse(keys[1]);
      if (Number.isNaN(Date.parse(at)) || !id.success)
        throw invalid("Check the cursor.");
      filters.push(
        sql`(${cashBankEntries.createdAt}, ${cashBankEntries.id}) < (${at}::timestamptz, ${id.data}::uuid)`,
      );
    }
    const rows = await tx
      .select()
      .from(cashBankEntries)
      .where(and(...filters))
      .orderBy(desc(cashBankEntries.createdAt), desc(cashBankEntries.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(cashBankEntryDto),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.createdAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

/** One entry; another tenant's id, or an entry outside the caller's outlets, is a 404. */
export async function getCashBankEntry(
  context: ScopedTenantContext,
  entryId: string,
): Promise<CashBankEntry> {
  assertTrustedScopedContext(context);
  return withTenant(db, context, async (tx) => {
    const row = await loadEntry(tx, context.tenant.tenantId, entryId);
    const reach = reachOf(context);
    if (reach && (row.outletId === null || !reach.includes(row.outletId)))
      throw notFound("Transaksi kas dan bank");
    return cashBankEntryDto(row);
  });
}

/** The counter account of cash in/out: same entity, never a cash or bank account. */
async function assertCounterAccount(
  tx: TenantTransaction,
  tenantId: string,
  legalEntityId: string,
  accountId: string,
): Promise<void> {
  const [account] = await tx
    .select({
      legalEntityId: chartOfAccounts.legalEntityId,
      reportGroup: chartOfAccounts.reportGroup,
    })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.tenantId, tenantId),
        eq(chartOfAccounts.id, accountId),
      ),
    )
    .limit(1);
  if (!account) throw notFound("Akun");
  if (account.legalEntityId !== legalEntityId)
    throw new AccountingError("ACCOUNT_ENTITY_MISMATCH");
  if (account.reportGroup === "cash_and_equivalents")
    throw new AccountingError("CASH_BANK_COUNTER_ACCOUNT_INVALID");
}

/** A bank account that can take part in a document of this legal entity. */
async function loadUsableBankAccount(
  tx: TenantTransaction,
  tenantId: string,
  legalEntityId: string,
  bankAccountId: string,
) {
  const account = await loadBankAccount(tx, tenantId, bankAccountId);
  if (account.legalEntityId !== legalEntityId)
    throw invalid("Rekening bank harus milik badan usaha dokumen ini.");
  if (!account.isActive) throw invalid("Rekening bank ini tidak aktif.");
  return account;
}

/**
 * Records a cash in/out or a transfer (contract `createCashBankEntry`): the
 * document and its single journal commit together; idempotent per key.
 */
export async function createCashBankEntry(
  context: ScopedTenantContext,
  rawInput: unknown,
  actorId: UserId,
): Promise<CashBankEntry> {
  const input: CreateCashBankEntryInput =
    createCashBankEntryInputSchema.parse(rawInput);
  assertTrustedScopedContext(context);
  assertTenantScope(context);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const { id } = await idempotentCommand(
      tx,
      context,
      { key: input.idempotencyKey, operation: OPERATION, request: input },
      async () => {
        const now = new Date();
        await requireLegalEntity(tx, tenantId, input.legalEntityId);
        if (input.entryDate > entityToday(now))
          throw invalid("Tanggal transaksi tidak boleh di masa depan.");
        const bankAccountId =
          input.kind === "transfer"
            ? input.fromBankAccountId
            : input.bankAccountId;
        const bank = await loadUsableBankAccount(
          tx,
          tenantId,
          input.legalEntityId,
          bankAccountId,
        );
        let toBank: Awaited<ReturnType<typeof loadUsableBankAccount>> | null =
          null;
        if (input.kind === "transfer") {
          toBank = await loadUsableBankAccount(
            tx,
            tenantId,
            input.legalEntityId,
            input.toBankAccountId,
          );
          if (toBank.glAccountId === bank.glAccountId)
            throw invalid(
              "Kedua rekening memakai akun buku besar yang sama, transfer tidak akan tercatat.",
            );
        } else {
          await assertCounterAccount(
            tx,
            tenantId,
            input.legalEntityId,
            input.counterAccountId,
          );
          if (input.counterAccountId === bank.glAccountId)
            throw new AccountingError("CASH_BANK_COUNTER_ACCOUNT_INVALID");
        }
        const outletId =
          input.kind === "transfer" ? null : (input.outletId ?? null);
        await entityLock(tx, tenantId, input.legalEntityId);

        const entryId = randomUUID();
        const lines = cashBankJournalLines(
          { kind: input.kind, amountIdr: input.amountIdr, outletId },
          {
            bankGl: bank.glAccountId,
            toBankGl: toBank?.glAccountId ?? null,
            counter: input.kind === "transfer" ? null : input.counterAccountId,
          },
        );
        const journal = await postJournalInTransaction(
          tx,
          context,
          {
            legalEntityId: input.legalEntityId,
            outletId,
            entryDate: input.entryDate as BusinessDate,
            sourceType: SOURCE_TYPES[input.kind],
            sourceId: entryId,
            description: input.description,
            lines,
            postedBy: actorId,
            // Server-derived: one document, one journal.
            idempotencyKey: `cb:${entryId}`,
          },
          now,
        );
        const [created] = await tx
          .insert(cashBankEntries)
          .values({
            id: entryId,
            tenantId,
            legalEntityId: input.legalEntityId,
            outletId,
            kind: input.kind,
            entryDate: input.entryDate,
            amountIdr: input.amountIdr,
            bankAccountId: bank.id,
            toBankAccountId: toBank?.id ?? null,
            counterAccountId:
              input.kind === "transfer" ? null : input.counterAccountId,
            description: input.description,
            reference: input.reference,
            idempotencyKey: input.idempotencyKey,
            journalEntryId: journal.id,
            createdBy: actorId,
          })
          .returning({ id: cashBankEntries.id });
        if (!created)
          throw new Error("Cash/bank entry insert returned no row.");
        await auditApFa(tx, context, {
          actorId,
          action: "accounting.cash_bank_entry.recorded",
          objectType: "cash_bank_entry",
          objectId: created.id,
          outletId,
          before: null,
          after: {
            kind: input.kind,
            amountIdr: input.amountIdr,
            journalEntryId: journal.id,
          },
        });
        return { id: created.id };
      },
    );
    return cashBankEntryDto(await loadEntry(tx, tenantId, id));
  });
}
