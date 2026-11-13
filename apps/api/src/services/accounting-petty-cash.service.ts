// Petty cash (Kas Kecil) fund per outlet (bead legend-4961, WS-07; PRD v1.7
// §3.19 Kas & Bank, §3.18 Pembelian Sederhana). Contract:
// `@starter/shared/accounting` banking.ts. Design:
// docs/briefs/ws-cash-bank-design.md.
//
// - A fund holds the outlet's petty cash balance; `petty_cash_entries` is its
//   append-only ledger: topup (bank -> fund), return (fund -> bank) and
//   purchase (a petty purchase spent it, journal owned by its own event).
// - The balance never goes below zero. Every mutation takes the fund row lock
//   (SELECT ... FOR UPDATE), then a conditional decrement
//   (`balance_idr >= amount`) refuses an overdraw with PETTY_CASH_INSUFFICIENT;
//   the table CHECK is the last line of defence.
// - Top-up and return post a journal with the catalogued `document:petty_cash_*`
//   rules: the petty cash side comes from the `petty_cash` account map, the bank
//   side from the GL account of the chosen bank account (server-derived
//   override, never from the request). A missing petty_cash mapping does not
//   guess an account: the entry is saved `parked` with ACCOUNT_MAPPING_MISSING
//   (the cash did move) and `postPettyCashEntry` posts it later, under the same
//   key `pc:<entryId>`, so one entry makes at most one journal.
// - Writes need tenant scope (bank accounts live on the legal entity). Reads
//   are narrowed to the caller's outlets.

import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, max, sql, type SQL } from "drizzle-orm";
import {
  AccountingError,
  pettyCashMovementInputSchema,
  type PettyCashEntry,
  type PettyCashFund,
  type PettyCashMovementInput,
  periodOf,
  resolveAutoJournalDate,
} from "@starter/shared/accounting";
import {
  assertTrustedScopedContext,
  businessDateOf,
  decodeCursor,
  encodeCursor,
  outletIdSchema,
  outletIdsForQuery,
  uuidSchema,
  type BusinessDate,
  type CursorPage,
  type Idr,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
  type UserId,
} from "@starter/shared/core";
import { db } from "../db";
import {
  pettyCashEntries,
  pettyCashFunds,
  type PettyCashEntryRow,
  type PettyCashFundRow,
} from "../db/schema/accounting-cash-bank-entries.ts";
import { fiscalPeriods } from "../db/schema/accounting.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  assertTenantScope,
  auditApFa,
  idempotentCommand,
  type TenantTransaction,
} from "./accounting-ap-fa-shared.ts";
import { entityLock } from "./accounting-bank-matching.ts";
import { loadBankAccount, notFound } from "./accounting-cash-bank-shared.ts";
import { postJournalFromRuleInTransaction } from "./accounting-journal.service.ts";
import { wouldPostingBeBlockedByClosedPeriod } from "./accounting-period.service.ts";
import { requireLegalEntity } from "./accounting-shared.ts";
import { loadOutletClock } from "./inventory-ops.shared.ts";

const OPERATION = "petty_cash.movement.create";

export type PettyCashFundQuery = { legalEntityId: string; outletId?: string };
export type PettyCashEntryListQuery = {
  outletId: string;
  from: string;
  to: string;
  cursor?: string;
  limit: number;
};

export function pettyCashFundDto(row: PettyCashFundRow): PettyCashFund {
  return {
    id: row.id,
    tenantId: row.tenantId,
    legalEntityId: row.legalEntityId,
    outletId: row.outletId,
    balanceIdr: row.balanceIdr,
    updatedAt: row.updatedAt.toISOString(),
  } as PettyCashFund;
}

export function pettyCashEntryDto(row: PettyCashEntryRow): PettyCashEntry {
  return {
    id: row.id,
    tenantId: row.tenantId,
    legalEntityId: row.legalEntityId,
    outletId: row.outletId,
    fundId: row.fundId,
    kind: row.kind,
    amountIdr: row.amountIdr,
    balanceAfterIdr: row.balanceAfterIdr,
    bankAccountId: row.bankAccountId,
    pettyPurchaseId: row.pettyPurchaseId,
    entryDate: row.entryDate,
    description: row.description,
    journalStatus: row.journalStatus,
    journalEntryId: row.journalEntryId,
    parkCode: row.parkCode,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  } as PettyCashEntry;
}

const invalid = (message: string) =>
  new HttpError(422, "VALIDATION_ERROR", message);

const insufficient = (balanceIdr: number, deltaIdr: number) =>
  new AccountingError("PETTY_CASH_INSUFFICIENT", undefined, {
    balanceIdr,
    deltaIdr,
  });

/** Outlet ids the caller may see (a requested outlet outside scope is a 403). */
function reachOf(
  context: ScopedTenantContext,
  outletId?: string,
): readonly OutletId[] | null {
  const filter = outletIdsForQuery(
    context.outletScope,
    outletId ? [outletId] : undefined,
  );
  return filter.kind === "all" ? null : filter.outletIds;
}

async function loadEntry(
  tx: TenantTransaction,
  tenantId: TenantId,
  entryId: string,
  options: { forUpdate?: boolean } = {},
): Promise<PettyCashEntryRow> {
  const query = tx
    .select()
    .from(pettyCashEntries)
    .where(
      and(
        eq(pettyCashEntries.tenantId, tenantId),
        eq(pettyCashEntries.id, entryId),
      ),
    )
    .limit(1);
  const [row] = options.forUpdate ? await query.for("update") : await query;
  if (!row) throw notFound("Entri kas kecil");
  return row;
}

/** The outlet's fund row, locked until the transaction ends; null when none. */
async function lockFund(
  tx: TenantTransaction,
  tenantId: TenantId,
  outletId: string,
): Promise<PettyCashFundRow | null> {
  const outlet = outletIdSchema.parse(outletId);
  const [fund] = await tx
    .select()
    .from(pettyCashFunds)
    .where(
      and(
        eq(pettyCashFunds.tenantId, tenantId),
        eq(pettyCashFunds.outletId, outlet),
      ),
    )
    .limit(1)
    .for("update");
  return fund ?? null;
}

/**
 * Moves the balance of a locked fund. A decrease only happens while
 * `balance_idr >= amount`; otherwise PETTY_CASH_INSUFFICIENT.
 */
async function changeBalance(
  tx: TenantTransaction,
  fund: PettyCashFundRow,
  delta: number,
): Promise<Idr> {
  const decrease = delta < 0;
  const [updated] = await tx
    .update(pettyCashFunds)
    .set({
      balanceIdr: sql`${pettyCashFunds.balanceIdr} + ${delta}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(pettyCashFunds.tenantId, fund.tenantId),
        eq(pettyCashFunds.id, fund.id),
        ...(decrease ? [gte(pettyCashFunds.balanceIdr, -delta as Idr)] : []),
      ),
    )
    .returning({ balanceIdr: pettyCashFunds.balanceIdr });
  if (!updated) throw insufficient(fund.balanceIdr, delta);
  return updated.balanceIdr;
}

// ------------------------------------------------------------------- reads

/** Funds of one legal entity (optionally one outlet) in the caller's outlets. */
export async function listPettyCashFunds(
  context: ScopedTenantContext,
  query: PettyCashFundQuery,
): Promise<PettyCashFund[]> {
  assertTrustedScopedContext(context);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    await requireLegalEntity(tx, tenantId, query.legalEntityId);
    const reach = reachOf(context, query.outletId);
    const filters: SQL[] = [
      eq(pettyCashFunds.tenantId, tenantId),
      eq(pettyCashFunds.legalEntityId, query.legalEntityId),
    ];
    if (query.outletId)
      filters.push(
        eq(pettyCashFunds.outletId, outletIdSchema.parse(query.outletId)),
      );
    if (reach)
      filters.push(
        reach.length === 0
          ? sql`FALSE`
          : inArray(pettyCashFunds.outletId, [...reach]),
      );
    const rows = await tx
      .select()
      .from(pettyCashFunds)
      .where(and(...filters))
      .orderBy(pettyCashFunds.outletId);
    return rows.map(pettyCashFundDto);
  });
}

/** Ledger of one outlet in [from, to] (outlet business date), newest first. */
export async function listPettyCashEntries(
  context: ScopedTenantContext,
  query: PettyCashEntryListQuery,
): Promise<CursorPage<PettyCashEntry>> {
  assertTrustedScopedContext(context);
  // Throws OUTLET_OUT_OF_SCOPE for an outlet the caller does not reach.
  reachOf(context, query.outletId);
  return withTenant(db, context, async (tx) => {
    const filters: SQL[] = [
      eq(pettyCashEntries.tenantId, context.tenant.tenantId),
      eq(pettyCashEntries.outletId, outletIdSchema.parse(query.outletId)),
      sql`${pettyCashEntries.entryDate} BETWEEN ${query.from}::date AND ${query.to}::date`,
    ];
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
        sql`(${pettyCashEntries.createdAt}, ${pettyCashEntries.id}) < (${at}::timestamptz, ${id.data}::uuid)`,
      );
    }
    const rows = await tx
      .select()
      .from(pettyCashEntries)
      .where(and(...filters))
      .orderBy(desc(pettyCashEntries.createdAt), desc(pettyCashEntries.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(pettyCashEntryDto),
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

// ------------------------------------------------------------------ posting

type Posted =
  | { status: "posted"; journalEntryId: string }
  | { status: "parked"; code: string };

/**
 * Posts the journal of a topup/return under `pc:<entryId>`. Only a missing
 * account mapping is parked (rolled back to a savepoint); every other error
 * aborts the whole request.
 */
async function postMovementJournal(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  input: {
    entryId: string;
    kind: "topup" | "return";
    legalEntityId: string;
    outletId: string;
    entryDate: string;
    /** Natural date of a retried entry whose period closed; null otherwise. */
    lateAdjustmentFrom?: string | null;
    amountIdr: number;
    description: string;
    bankGlAccountId: string;
    actorId: UserId;
  },
  options: { park: boolean },
): Promise<Posted> {
  const post = (executor: TenantTransaction) =>
    postJournalFromRuleInTransaction(executor, context, {
      eventName: `document:petty_cash_${input.kind}`,
      amounts: { amountIdr: input.amountIdr },
      legalEntityId: input.legalEntityId,
      outletId: input.outletId,
      entryDate: input.entryDate as BusinessDate,
      lateAdjustmentFrom: input.lateAdjustmentFrom ?? null,
      sourceId: input.entryId,
      description: input.description,
      postedBy: input.actorId,
      // Server-derived: one entry, one journal, also across retries.
      idempotencyKey: `pc:${input.entryId}`,
      // The bank side is the chosen account's own GL, never the role map.
      accountOverrides: { bank: input.bankGlAccountId },
    });
  if (!options.park)
    return { status: "posted", journalEntryId: (await post(tx)).id };
  try {
    const entry = await tx.transaction((savepoint) => post(savepoint));
    return { status: "posted", journalEntryId: entry.id };
  } catch (error) {
    if (
      error instanceof AccountingError &&
      error.code === "ACCOUNT_MAPPING_MISSING"
    )
      return { status: "parked", code: error.code };
    throw error;
  }
}

// ---------------------------------------------------------------- movements

/**
 * Top-up from / return to a bank account (contract `createPettyCashMovement`).
 * Idempotent per key; a return above the balance is PETTY_CASH_INSUFFICIENT.
 */
export async function createPettyCashMovement(
  context: ScopedTenantContext,
  rawInput: unknown,
  actorId: UserId,
): Promise<PettyCashEntry> {
  const input: PettyCashMovementInput =
    pettyCashMovementInputSchema.parse(rawInput);
  assertTrustedScopedContext(context);
  assertTenantScope(context);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const [outlet] = await tx
      .select({ legalEntityId: outlets.legalEntityId })
      .from(outlets)
      .where(
        and(eq(outlets.tenantId, tenantId), eq(outlets.id, input.outletId)),
      )
      .limit(1);
    if (!outlet) throw notFound("Outlet");
    const { id } = await idempotentCommand(
      tx,
      context,
      { key: input.idempotencyKey, operation: OPERATION, request: input },
      async () => {
        const now = new Date();
        const bank = await loadBankAccount(tx, tenantId, input.bankAccountId);
        if (bank.legalEntityId !== outlet.legalEntityId)
          throw invalid(
            "Outlet dan rekening bank harus milik badan usaha yang sama.",
          );
        if (!bank.isActive) throw invalid("Rekening bank ini tidak aktif.");
        await entityLock(tx, tenantId, bank.legalEntityId);

        if (input.kind === "topup")
          await tx
            .insert(pettyCashFunds)
            .values({
              tenantId,
              legalEntityId: outlet.legalEntityId,
              outletId: input.outletId,
              createdBy: actorId,
            })
            .onConflictDoNothing({
              target: [pettyCashFunds.tenantId, pettyCashFunds.outletId],
            });
        const fund = await lockFund(tx, tenantId, input.outletId);
        // A return from an outlet with no fund has nothing to give back.
        if (!fund) throw insufficient(0, -input.amountIdr);
        const delta =
          input.kind === "topup" ? input.amountIdr : -input.amountIdr;
        const balanceAfter = await changeBalance(tx, fund, delta);

        const clock = await loadOutletClock(tx, input.outletId);
        const entryDate = businessDateOf(now, clock);
        const entryId = randomUUID();
        const posted = await postMovementJournal(
          tx,
          context,
          {
            entryId,
            kind: input.kind,
            legalEntityId: outlet.legalEntityId,
            outletId: input.outletId,
            entryDate,
            amountIdr: input.amountIdr,
            description: input.description,
            bankGlAccountId: bank.glAccountId,
            actorId,
          },
          { park: true },
        );
        const [created] = await tx
          .insert(pettyCashEntries)
          .values({
            id: entryId,
            tenantId,
            legalEntityId: outlet.legalEntityId,
            outletId: input.outletId,
            fundId: fund.id,
            kind: input.kind,
            amountIdr: input.amountIdr,
            balanceAfterIdr: balanceAfter,
            bankAccountId: bank.id,
            entryDate,
            description: input.description,
            idempotencyKey: input.idempotencyKey,
            journalStatus: posted.status,
            journalEntryId:
              posted.status === "posted" ? posted.journalEntryId : null,
            parkCode: posted.status === "parked" ? posted.code : null,
            parkAttempts: posted.status === "parked" ? 1 : 0,
            createdBy: actorId,
          })
          .returning({ id: pettyCashEntries.id });
        if (!created)
          throw new Error("Petty cash entry insert returned no row.");
        await auditApFa(tx, context, {
          actorId,
          action: "accounting.petty_cash.movement_recorded",
          objectType: "petty_cash_entry",
          objectId: created.id,
          outletId: input.outletId,
          before: null,
          after: {
            kind: input.kind,
            amountIdr: input.amountIdr,
            balanceAfterIdr: balanceAfter,
            journalStatus: posted.status,
            ...(posted.status === "parked" ? { parkCode: posted.code } : {}),
          },
        });
        return { id: created.id };
      },
    );
    // Read the current state: a replay shows a parked entry that got posted.
    return pettyCashEntryDto(await loadEntry(tx, tenantId, id));
  });
}

/** Latest closed month of the entity, or null (read under the entity lock). */
async function latestClosedPeriod(
  tx: TenantTransaction,
  tenantId: string,
  legalEntityId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ period: max(fiscalPeriods.period) })
    .from(fiscalPeriods)
    .where(
      and(
        eq(fiscalPeriods.tenantId, tenantId),
        eq(fiscalPeriods.legalEntityId, legalEntityId),
        eq(fiscalPeriods.status, "closed"),
      ),
    );
  return row?.period ?? null;
}

/**
 * Posts the journal of a parked top-up/return once the account map is fixed
 * (contract `postPettyCashEntry`). Locks the entry row, posts under the same
 * `pc:<entryId>` key; a posted entry is returned as it is. When the entry's
 * month was closed while it was parked, the journal goes to the first open
 * period with `lateAdjustmentFrom` = the entry date (like the auto-journal);
 * the ledger row keeps its natural date.
 */
export async function postPettyCashEntry(
  context: ScopedTenantContext,
  entryId: string,
  actorId: UserId,
): Promise<PettyCashEntry> {
  assertTrustedScopedContext(context);
  assertTenantScope(context);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const row = await loadEntry(tx, tenantId, entryId, { forUpdate: true });
    if (
      row.journalStatus !== "parked" ||
      row.bankAccountId === null ||
      (row.kind !== "topup" && row.kind !== "return")
    )
      return pettyCashEntryDto(row);
    const bank = await loadBankAccount(tx, tenantId, row.bankAccountId);
    // Takes the entity FOR SHARE lock: close/reopen cannot race this post.
    const blocked = await wouldPostingBeBlockedByClosedPeriod(
      tx,
      tenantId,
      row.legalEntityId,
      periodOf(row.entryDate),
    );
    const { entryDate, lateAdjustmentFrom } = resolveAutoJournalDate(
      row.entryDate,
      blocked
        ? await latestClosedPeriod(tx, tenantId, row.legalEntityId)
        : null,
    );
    const posted = await postMovementJournal(
      tx,
      context,
      {
        entryId: row.id,
        kind: row.kind,
        legalEntityId: row.legalEntityId,
        outletId: row.outletId,
        entryDate,
        lateAdjustmentFrom,
        amountIdr: row.amountIdr,
        description: row.description,
        bankGlAccountId: bank.glAccountId,
        actorId,
      },
      { park: false },
    );
    if (posted.status !== "posted")
      throw new Error("A retried petty cash post must book its journal.");
    const [updated] = await tx
      .update(pettyCashEntries)
      .set({
        journalStatus: "posted",
        journalEntryId: posted.journalEntryId,
        parkCode: null,
        parkAttempts: sql`${pettyCashEntries.parkAttempts} + 1`,
      })
      .where(
        and(
          eq(pettyCashEntries.tenantId, tenantId),
          eq(pettyCashEntries.id, row.id),
          eq(pettyCashEntries.journalStatus, "parked"),
        ),
      )
      .returning();
    if (!updated) throw new Error("Parked petty cash entry was not updated.");
    await auditApFa(tx, context, {
      actorId,
      action: "accounting.petty_cash.entry_posted",
      objectType: "petty_cash_entry",
      objectId: row.id,
      outletId: row.outletId,
      before: { journalStatus: "parked", parkCode: row.parkCode },
      after: {
        journalStatus: "posted",
        journalEntryId: posted.journalEntryId,
      },
    });
    return pettyCashEntryDto(updated);
  });
}

// ----------------------------------------------------------------- purchase

/**
 * A petty purchase spends the outlet's fund (called from
 * `createPettyPurchase`, same transaction). An outlet without a fund keeps the
 * old behavior (no effect); with a fund, a purchase above the balance is
 * PETTY_CASH_INSUFFICIENT and the whole purchase is rolled back. The ledger row
 * is `external`: its journal belongs to `petty_purchase.recorded`.
 */
export async function drawPettyCashForPurchase(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  input: {
    outletId: string;
    purchaseId: string;
    amountIdr: number;
    businessDate: string;
    description: string;
    actorId: string;
  },
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const outletId = outletIdSchema.parse(input.outletId);
  const fund = await lockFund(tx, tenantId, outletId);
  if (!fund) return;
  const balanceAfter = await changeBalance(tx, fund, -input.amountIdr);
  await tx.insert(pettyCashEntries).values({
    tenantId,
    legalEntityId: fund.legalEntityId,
    outletId,
    fundId: fund.id,
    kind: "purchase",
    amountIdr: input.amountIdr as Idr,
    balanceAfterIdr: balanceAfter,
    pettyPurchaseId: input.purchaseId,
    entryDate: input.businessDate,
    description: input.description.slice(0, 255),
    idempotencyKey: `pp:${input.purchaseId}`,
    journalStatus: "external",
    createdBy: input.actorId,
  });
}
