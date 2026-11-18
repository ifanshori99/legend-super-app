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
// - GL guard (legend-a4z2f): payroll cash, employee loans and reimbursements
//   credit petty cash (1102) without drawing the fund, so the fund can exceed
//   the books. A `return` is therefore also refused when it is above
//   `outlet fund - max(0, entity fund total - GL 1102)` (PETTY_CASH_GL_INSUFFICIENT),
//   read with the entity's fund rows locked in id order. The GL is per legal
//   entity (account map and payroll journals carry no outlet), so the entity's
//   whole shortfall is charged to the returning outlet (conservative). With no petty_cash
//   mapping the check is skipped: the return parks as before.
//   Pending 1102 credits (legend-3k9qg, SO 1036 slice E): cash can leave before
//   its credit to 1102 is posted, so GL 1102 is read net of what still waits for
//   the entity (`pendingPettyCashCreditsIdr`): cash payout postings
//   `settle_pending` / `settle_skipped` (net), and undelivered outbox events that
//   will credit petty cash (`payroll.paid` cash part unless settled per item,
//   `employee_loan.disbursed` not by bank, cash `reimbursement.paid`). An amount
//   that cannot be read refuses the return (fail closed).
//   `getPettyCashReconciliation` shows fund vs GL without changing anything.
// - Founder Q7 (13 Nov 2026): a top-up above the tenant cash limit, or one that
//   takes the creator's day total of cash outs and top-ups at the outlet past
//   it (`accounting-cash-limit.service.ts`), is NOT executed: it is stored as a
//   `petty_topup` document in `cash_bank_entries` (`pending_approval`, no
//   journal, fund and ledger untouched). The same transaction opens the
//   `cash_out` approval chain for that document (SO 1036 finding 6): the matrix
//   tiers on the creator's day total (`cashApprovalCheck`, so a split cannot pick
//   a lower tier) and `alwaysRequire` keeps a held top-up from ever having no
//   chain; with no policy the submission rolls back whole (fail closed).
//   `approveCashBankEntry` then runs the real top-up in its own transaction
//   (`approvePettyTopupInTransaction`, ledger key `pt/<entryId>`). A return
//   (fund -> bank) is never held.
// - Lock order (SO 1036 finding 3): every path that moves a fund or posts to the
//   petty cash account takes `entityLock(tenant, legalEntity)` FIRST, then (when
//   it applies) the actor's cash-limit lock, then fund / ledger rows. Payroll
//   cash posts credit 1102 under the same entity lock, so a return reads the GL
//   balance it is about to spend.
// - Writes need tenant scope (bank accounts live on the legal entity). Reads
//   are narrowed to the caller's outlets.

import { randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  max,
  ne,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  AccountingError,
  pettyCashMovementInputSchema,
  type CashBankEntry,
  type PettyCashEntry,
  type PettyCashFund,
  type PettyCashMovementInput,
  type PettyCashReconciliation,
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
  cashBankEntries,
  pettyCashEntries,
  pettyCashFunds,
  type PettyCashEntryRow,
  type PettyCashFundRow,
} from "../db/schema/accounting-cash-bank-entries.ts";
import {
  accountMappings,
  fiscalPeriods,
  journalEntries,
  journalLines,
} from "../db/schema/accounting.ts";
import { autoJournalParked } from "../db/schema/accounting-auto-journal.ts";
import { domainEventOutbox } from "../db/schema/core-events.ts";
import { employees } from "../db/schema/hris.ts";
import {
  payrollDisbursementBatches,
  payrollPayoutGlPostings,
} from "../db/schema/payroll-payout.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { openPayrollValue } from "../lib/payroll-sealed.ts";
import {
  assertTenantScope,
  auditApFa,
  idempotentCommand,
  type TenantTransaction,
} from "./accounting-ap-fa-shared.ts";
import { entityLock } from "./accounting-bank-matching.ts";
import {
  cashBankEntryDto,
  loadBankAccount,
  notFound,
} from "./accounting-cash-bank-shared.ts";
import {
  APPROVED_TOPUP_KEY_PREFIX,
  cashApprovalCheck,
} from "./accounting-cash-limit.service.ts";
import { postJournalFromRuleInTransaction } from "./accounting-journal.service.ts";
import {
  assertPeriodOpenForPosting,
  wouldPostingBeBlockedByClosedPeriod,
} from "./accounting-period.service.ts";
import { requireLegalEntity } from "./accounting-shared.ts";
import { loadOutletClock } from "./inventory-ops.shared.ts";
import { EVENT_DESTINATION } from "./payment-support.ts";
import { openApprovalRequest } from "./platform-approval.service.ts";

const OPERATION = "petty_cash.movement.create";

// Approval inbox identity of a held top-up: the same chain as a held cash out
// (`CASH_BANK_APPROVAL_SOURCE_MODULE` / `CASH_BANK_ENTRY_OBJECT_TYPE` in
// accounting-cash-bank-entries.service.ts, which imports this file, so the
// values are repeated here; a test pins them equal).
export const PETTY_TOPUP_APPROVAL_SOURCE_MODULE = "accounting";
export const PETTY_TOPUP_ENTRY_OBJECT_TYPE = "cash_bank_entry";

export type PettyCashFundQuery = { legalEntityId: string; outletId?: string };
export type PettyCashReconciliationQuery = PettyCashFundQuery;
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

const PETTY_JOURNAL_SOURCES = [
  "petty_cash_topup",
  "petty_cash_return",
  "petty_purchase",
] as const;

/** The GL account the `petty_cash` role maps to for the entity, or null. */
async function pettyCashGlAccount(
  tx: TenantTransaction,
  tenantId: TenantId,
  legalEntityId: string,
): Promise<string | null> {
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
  return mapping?.accountId ?? null;
}

/**
 * Debit minus credit of the posted journal lines on the entity's petty cash
 * account, or null when the entity has no petty_cash mapping.
 */
async function pettyCashGlBalance(
  tx: TenantTransaction,
  tenantId: TenantId,
  legalEntityId: string,
): Promise<number | null> {
  const accountId = await pettyCashGlAccount(tx, tenantId, legalEntityId);
  return accountId === null
    ? null
    : glBalanceOf(tx, tenantId, legalEntityId, accountId);
}

async function glBalanceOf(
  tx: TenantTransaction,
  tenantId: TenantId,
  legalEntityId: string,
  accountId: string,
): Promise<number> {
  const [row] = await tx
    .select({
      balance: sql<string>`COALESCE(SUM(${journalLines.debitIdr}) - SUM(${journalLines.creditIdr}), 0)::text`,
    })
    .from(journalLines)
    .innerJoin(
      journalEntries,
      and(
        eq(journalEntries.tenantId, journalLines.tenantId),
        eq(journalEntries.id, journalLines.entryId),
      ),
    )
    .where(
      and(
        eq(journalLines.tenantId, tenantId),
        eq(journalLines.accountId, accountId),
        eq(journalEntries.legalEntityId, legalEntityId),
      ),
    );
  return Number(row?.balance ?? 0);
}

/** A pending credit whose amount cannot be read: the return is refused. */
const unreadablePendingCredit = (source: string) =>
  new AccountingError("PETTY_CASH_GL_INSUFFICIENT", undefined, {
    pendingCreditUnreadable: source,
  });

function readableIdr(value: unknown, source: string): number {
  const amount = Number(value);
  if (value === null || !Number.isSafeInteger(amount) || amount < 0)
    throw unreadablePendingCredit(source);
  return amount;
}

/**
 * Cash that already left, or leaves through an event not delivered yet, and
 * will credit the entity's petty cash account (1102) once its journal posts
 * (legend-3k9qg). Sum of:
 * - cash payout postings of the entity still `settle_pending` / `settle_skipped`
 *   (`settle_net_idr`, else the sealed net of the posting);
 * - undelivered `cloud-sync` outbox events (pending, retrying, dead letter):
 *   `payroll.paid` cash part (not when settled per item), `employee_loan.disbursed`
 *   unless `disbursedVia` is bank, `reimbursement.paid` with a cash payout (the
 *   employee's legal entity).
 * Counts whatever it cannot rule out; an unreadable amount throws
 * PETTY_CASH_GL_INSUFFICIENT. Call under `entityLock`.
 */
async function pendingPettyCashCreditsIdr(
  tx: TenantTransaction,
  tenantId: TenantId,
  legalEntityId: string,
): Promise<number> {
  let total = 0;

  const postings = await tx
    .select({
      id: payrollPayoutGlPostings.id,
      settleNetIdr: payrollPayoutGlPostings.settleNetIdr,
      totalEncrypted: payrollPayoutGlPostings.totalEncrypted,
      piiKeyVersion: payrollPayoutGlPostings.piiKeyVersion,
    })
    .from(payrollPayoutGlPostings)
    .innerJoin(
      payrollDisbursementBatches,
      and(
        eq(
          payrollDisbursementBatches.tenantId,
          payrollPayoutGlPostings.tenantId,
        ),
        eq(payrollDisbursementBatches.id, payrollPayoutGlPostings.batchId),
      ),
    )
    .where(
      and(
        eq(payrollPayoutGlPostings.tenantId, tenantId),
        inArray(payrollPayoutGlPostings.kind, [
          "settle_pending",
          "settle_skipped",
        ]),
        eq(payrollDisbursementBatches.legalEntityId, legalEntityId),
        eq(payrollDisbursementBatches.channel, "cash"),
      ),
    );
  for (const posting of postings) {
    if (posting.settleNetIdr !== null) {
      total += readableIdr(posting.settleNetIdr, "payout_posting");
      continue;
    }
    // Written before migration 0392: only the sealed total holds the net.
    try {
      const sealed = JSON.parse(
        openPayrollValue(
          posting.totalEncrypted,
          {
            tenantId,
            table: "payroll_payout_gl_postings",
            rowId: posting.id,
            field: "total",
          },
          posting.piiKeyVersion,
        ),
      ) as Record<string, unknown>;
      total += readableIdr(sealed.netIdr, "payout_posting");
    } catch (error) {
      if (error instanceof AccountingError) throw error;
      throw unreadablePendingCredit("payout_posting");
    }
  }

  const eventName = sql<string>`${domainEventOutbox.event}->>'name'`;
  const undelivered = await tx
    .select({
      name: eventName,
      payload: sql<unknown>`${domainEventOutbox.event}->'payload'`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.destination, EVENT_DESTINATION),
        ne(domainEventOutbox.status, "delivered"),
        inArray(eventName, [
          "payroll.paid",
          "employee_loan.disbursed",
          "reimbursement.paid",
        ]),
      ),
    );
  const reimbursements: { employeeId: string; amountIdr: number }[] = [];
  for (const row of undelivered) {
    const payload =
      row.payload !== null && typeof row.payload === "object"
        ? (row.payload as Record<string, unknown>)
        : null;
    if (!payload) throw unreadablePendingCredit(row.name);
    if (row.name === "reimbursement.paid") {
      // A payroll payout is carried by the run journal. A cash one belongs to
      // the employee's entity: resolved below in one query.
      if (payload.payout === "payroll") continue;
      if (typeof payload.employeeId !== "string")
        throw unreadablePendingCredit(row.name);
      reimbursements.push({
        employeeId: payload.employeeId,
        amountIdr: readableIdr(payload.amountIdr, row.name),
      });
      continue;
    }
    if (typeof payload.legalEntityId !== "string")
      throw unreadablePendingCredit(row.name);
    if (payload.legalEntityId !== legalEntityId) continue;
    if (row.name === "payroll.paid") {
      // Settled per item: the payout journals carry it, nothing more posts.
      if (payload.settledPerItem === true) continue;
      total += readableIdr(payload.cashIdr, row.name);
    } else if (payload.disbursedVia !== "bank") {
      total += readableIdr(payload.principalIdr, row.name);
    }
  }
  if (reimbursements.length > 0) {
    const inEntity = await tx
      .select({ id: employees.id })
      .from(employees)
      .where(
        and(
          eq(employees.tenantId, tenantId),
          eq(employees.legalEntityId, legalEntityId),
          inArray(
            employees.id,
            reimbursements.map((row) => row.employeeId),
          ),
        ),
      );
    const ids = new Set<string>(inEntity.map((row) => row.id));
    for (const row of reimbursements)
      if (ids.has(row.employeeId)) total += row.amountIdr;
  }
  return total;
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

/**
 * Fund vs GL 1102 of one legal entity (contract `getPettyCashReconciliation`).
 * Read-only. Entity wide (see header): needs tenant scope, since the GL side
 * cannot be narrowed to an outlet's lines. `outletId` only adds that outlet's
 * own fund balance.
 */
export async function getPettyCashReconciliation(
  context: ScopedTenantContext,
  query: PettyCashReconciliationQuery,
): Promise<PettyCashReconciliation> {
  assertTrustedScopedContext(context);
  assertTenantScope(context);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    await requireLegalEntity(tx, tenantId, query.legalEntityId);
    let outletFundIdr: number | null = null;
    if (query.outletId) {
      const outletId = outletIdSchema.parse(query.outletId);
      const [outlet] = await tx
        .select({ id: outlets.id })
        .from(outlets)
        .where(
          and(
            eq(outlets.tenantId, tenantId),
            eq(outlets.id, outletId),
            eq(outlets.legalEntityId, query.legalEntityId),
          ),
        )
        .limit(1);
      if (!outlet) throw notFound("Outlet");
      const [fund] = await tx
        .select({ balanceIdr: pettyCashFunds.balanceIdr })
        .from(pettyCashFunds)
        .where(
          and(
            eq(pettyCashFunds.tenantId, tenantId),
            eq(pettyCashFunds.outletId, outletId),
          ),
        )
        .limit(1);
      outletFundIdr = fund?.balanceIdr ?? 0;
    }
    const accountId = await pettyCashGlAccount(
      tx,
      tenantId,
      query.legalEntityId,
    );
    // No petty_cash mapping: there is no GL side to compare, do not guess one.
    if (accountId === null)
      throw new AccountingError(
        "ACCOUNT_MAPPING_MISSING",
        "No account mapped for petty_cash",
      );
    const glIdr = await glBalanceOf(
      tx,
      tenantId,
      query.legalEntityId,
      accountId,
    );
    const [funds] = await tx
      .select({
        total: sql<string>`COALESCE(SUM(${pettyCashFunds.balanceIdr}), 0)::text`,
      })
      .from(pettyCashFunds)
      .where(
        and(
          eq(pettyCashFunds.tenantId, tenantId),
          eq(pettyCashFunds.legalEntityId, query.legalEntityId),
        ),
      );
    const fundIdr = Number(funds?.total ?? 0);

    const [parkedLedger] = await tx
      .select({ count: sql<string>`COUNT(*)::text` })
      .from(pettyCashEntries)
      .where(
        and(
          eq(pettyCashEntries.tenantId, tenantId),
          eq(pettyCashEntries.legalEntityId, query.legalEntityId),
          eq(pettyCashEntries.journalStatus, "parked"),
        ),
      );
    // A petty purchase books its journal later, through the auto-journal; the
    // ones still waiting leave the GL behind the fund.
    const [parkedPurchases] = await tx
      .select({ count: sql<string>`COUNT(*)::text` })
      .from(autoJournalParked)
      .innerJoin(
        outlets,
        and(
          eq(outlets.tenantId, autoJournalParked.tenantId),
          eq(outlets.id, autoJournalParked.outletId),
        ),
      )
      .where(
        and(
          eq(autoJournalParked.tenantId, tenantId),
          eq(outlets.legalEntityId, query.legalEntityId),
          eq(autoJournalParked.eventName, "petty_purchase.recorded"),
        ),
      );

    const [nonPetty] = await tx
      .select({
        total: sql<string>`COALESCE(SUM(${journalLines.creditIdr}), 0)::text`,
        entries: sql<string>`COUNT(DISTINCT ${journalEntries.id})::text`,
      })
      .from(journalLines)
      .innerJoin(
        journalEntries,
        and(
          eq(journalEntries.tenantId, journalLines.tenantId),
          eq(journalEntries.id, journalLines.entryId),
        ),
      )
      .where(
        and(
          eq(journalLines.tenantId, tenantId),
          eq(journalLines.accountId, accountId),
          eq(journalEntries.legalEntityId, query.legalEntityId),
          sql`${journalLines.creditIdr} > 0`,
          sql`${journalEntries.sourceType} NOT IN (${sql.join(
            PETTY_JOURNAL_SOURCES.map((source) => sql`${source}`),
            sql`, `,
          )})`,
        ),
      );

    return {
      legalEntityId: query.legalEntityId,
      outletId: query.outletId ?? null,
      fundIdr,
      outletFundIdr,
      glIdr,
      diffIdr: fundIdr - glIdr,
      parkedEntries:
        Number(parkedLedger?.count ?? 0) + Number(parkedPurchases?.count ?? 0),
      nonPettyCredits1102: Number(nonPetty?.total ?? 0),
      nonPettyCreditEntries: Number(nonPetty?.entries ?? 0),
    } as PettyCashReconciliation;
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

type BankForMovement = { id: string; glAccountId: string };

/**
 * One top-up/return, the part shared by a direct movement and an approved
 * `petty_topup`: fund row (created by a top-up), balance, journal, ledger row.
 * `park` lets a missing account mapping save the entry parked; an approval never
 * parks (a failure aborts and the document stays pending).
 */
async function applyMovement(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  input: {
    kind: "topup" | "return";
    legalEntityId: string;
    outletId: string;
    bank: BankForMovement;
    amountIdr: number;
    description: string;
    entryDate: BusinessDate;
    idempotencyKey: string;
    /** Owner of the ledger row (the requester, not the approver). */
    createdBy: string;
    /** Poster of the journal. */
    actorId: UserId;
    park: boolean;
  },
): Promise<{ id: string; balanceAfter: Idr; posted: Posted }> {
  const tenantId = context.tenant.tenantId;
  const outletId = outletIdSchema.parse(input.outletId);
  // Entity lock before any fund row or GL read (no-op when the caller already
  // holds it): payroll cash posts to 1102 under the same lock.
  await entityLock(tx, tenantId, input.legalEntityId);
  if (input.kind === "topup")
    await tx
      .insert(pettyCashFunds)
      .values({
        tenantId,
        legalEntityId: input.legalEntityId,
        outletId,
        createdBy: input.actorId,
      })
      .onConflictDoNothing({
        target: [pettyCashFunds.tenantId, pettyCashFunds.outletId],
      });
  // A return locks every fund row of the entity in id order first (one fixed
  // order, so two returns cannot deadlock; the entity lock already serialises
  // them), so the entity total below is read consistently with this fund.
  let entityFundTotal = 0;
  if (input.kind === "return") {
    const entityFunds = await tx
      .select({ balanceIdr: pettyCashFunds.balanceIdr })
      .from(pettyCashFunds)
      .where(
        and(
          eq(pettyCashFunds.tenantId, tenantId),
          eq(pettyCashFunds.legalEntityId, input.legalEntityId),
        ),
      )
      .orderBy(pettyCashFunds.id)
      .for("update");
    entityFundTotal = entityFunds.reduce((sum, row) => sum + row.balanceIdr, 0);
  }
  const fund = await lockFund(tx, tenantId, outletId);
  // A return from an outlet with no fund has nothing to give back.
  if (!fund) throw insufficient(0, -input.amountIdr);
  // A return of money the books do not show is refused (legend-a4z2f, CTO:
  // conservative). The GL is per entity, so the shortfall of the whole entity
  // (funds above the GL) is charged to this outlet in full:
  //   allowed = outlet fund - max(0, total entity funds - GL 1102).
  // Fund shortage keeps its own code (changeBalance below); the GL check only
  // runs when a petty_cash account is mapped.
  if (input.kind === "return" && input.amountIdr <= fund.balanceIdr) {
    const glIdr = await pettyCashGlBalance(tx, tenantId, input.legalEntityId);
    if (glIdr !== null) {
      // Cash credits not on the GL yet (legend-3k9qg), read under the entity
      // lock taken above.
      const pendingCreditIdr = await pendingPettyCashCreditsIdr(
        tx,
        tenantId,
        input.legalEntityId,
      );
      const allowedIdr =
        fund.balanceIdr -
        Math.max(0, entityFundTotal - (glIdr - pendingCreditIdr));
      if (input.amountIdr > allowedIdr)
        throw new AccountingError("PETTY_CASH_GL_INSUFFICIENT", undefined, {
          balanceIdr: fund.balanceIdr,
          glIdr,
          pendingCreditIdr,
          entityFundIdr: entityFundTotal,
          allowedIdr: Math.max(0, allowedIdr),
          deltaIdr: -input.amountIdr,
        });
    }
  }
  const delta = input.kind === "topup" ? input.amountIdr : -input.amountIdr;
  const balanceAfter = await changeBalance(tx, fund, delta);

  const entryId = randomUUID();
  const posted = await postMovementJournal(
    tx,
    context,
    {
      entryId,
      kind: input.kind,
      legalEntityId: input.legalEntityId,
      outletId,
      entryDate: input.entryDate,
      amountIdr: input.amountIdr,
      description: input.description,
      bankGlAccountId: input.bank.glAccountId,
      actorId: input.actorId,
    },
    { park: input.park },
  );
  const [created] = await tx
    .insert(pettyCashEntries)
    .values({
      id: entryId,
      tenantId,
      legalEntityId: input.legalEntityId,
      outletId,
      fundId: fund.id,
      kind: input.kind,
      amountIdr: input.amountIdr as Idr,
      balanceAfterIdr: balanceAfter,
      bankAccountId: input.bank.id,
      entryDate: input.entryDate,
      description: input.description,
      idempotencyKey: input.idempotencyKey,
      journalStatus: posted.status,
      journalEntryId: posted.status === "posted" ? posted.journalEntryId : null,
      parkCode: posted.status === "parked" ? posted.code : null,
      parkAttempts: posted.status === "parked" ? 1 : 0,
      createdBy: input.createdBy,
    })
    .returning({ id: pettyCashEntries.id });
  if (!created) throw new Error("Petty cash entry insert returned no row.");
  return { id: created.id, balanceAfter, posted };
}

/**
 * Runs the top-up of an approved `petty_topup` document inside the caller's
 * transaction (`approveCashBankEntry`, entity lock and row lock held). Fund
 * balance and ledger row move exactly once: the document only leaves
 * `pending_approval` in the same transaction, and a repeat approval returns
 * before reaching here. The journal is booked, never parked: a closed period
 * (PERIOD_CLOSED) or a missing petty cash mapping fails the request and the
 * document stays pending. Returns the journal the document links to.
 */
export async function approvePettyTopupInTransaction(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  input: {
    cashBankEntryId: string;
    legalEntityId: string;
    outletId: string;
    entryDate: string;
    amountIdr: number;
    description: string;
    bank: BankForMovement;
    createdBy: string;
    approverId: UserId;
  },
): Promise<{ id: string }> {
  const moved = await applyMovement(tx, context, {
    kind: "topup",
    legalEntityId: input.legalEntityId,
    outletId: input.outletId,
    bank: input.bank,
    amountIdr: input.amountIdr,
    description: input.description,
    entryDate: input.entryDate as BusinessDate,
    // Marks the ledger row: the anti-split sum counts the document, not this.
    idempotencyKey: `${APPROVED_TOPUP_KEY_PREFIX}${input.cashBankEntryId}`,
    createdBy: input.createdBy,
    actorId: input.approverId,
    park: false,
  });
  if (moved.posted.status !== "posted")
    throw new Error("An approved petty cash top-up must book its journal.");
  await auditApFa(tx, context, {
    actorId: input.approverId,
    action: "accounting.petty_cash.movement_recorded",
    objectType: "petty_cash_entry",
    objectId: moved.id,
    outletId: input.outletId,
    before: null,
    after: {
      kind: "topup",
      amountIdr: input.amountIdr,
      balanceAfterIdr: moved.balanceAfter,
      journalStatus: "posted",
      cashBankEntryId: input.cashBankEntryId,
    },
  });
  return { id: moved.posted.journalEntryId };
}

export type PettyCashMovementResult =
  | { pending: false; entry: PettyCashEntry }
  | { pending: true; entry: CashBankEntry };

/**
 * Top-up from / return to a bank account (contract `createPettyCashMovement`).
 * Idempotent per key; a return above the balance is PETTY_CASH_INSUFFICIENT. A
 * top-up held by the cash limit (see header) comes back `pending: true` with
 * its `petty_topup` document and changes nothing else.
 */
export async function createPettyCashMovement(
  context: ScopedTenantContext,
  rawInput: unknown,
  actorId: UserId,
): Promise<PettyCashMovementResult> {
  const input: PettyCashMovementInput =
    pettyCashMovementInputSchema.parse(rawInput);
  assertTrustedScopedContext(context);
  assertTenantScope(context);
  // "pt/" marks the ledger row of an approved top-up (server-derived); "pt:" is
  // refused too so no client key can look like one.
  if (/^pt[:/]/.test(input.idempotencyKey))
    throw invalid("Kunci idempotensi tidak boleh diawali pt: atau pt/.");
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
    const stored = await idempotentCommand<{ id: string; pending: boolean }>(
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

        const clock = await loadOutletClock(tx, input.outletId);
        const entryDate = businessDateOf(now, clock);

        const cashCheck =
          input.kind === "topup"
            ? await cashApprovalCheck(tx, {
                tenantId,
                actorId,
                amountIdr: input.amountIdr,
              })
            : null;
        if (cashCheck?.required) {
          // Held for approval: validated like a posting (period open) but no
          // fund, ledger row or journal until a second person approves.
          await assertPeriodOpenForPosting(tx, context, {
            legalEntityId: outlet.legalEntityId,
            entryDate,
          });
          // Approval later posts Dr petty cash: refuse now when that role has
          // no account, or the document would sit pending and fail on approve.
          const [pettyCashMapping] = await tx
            .select({ accountId: accountMappings.accountId })
            .from(accountMappings)
            .where(
              and(
                eq(accountMappings.tenantId, tenantId),
                eq(accountMappings.legalEntityId, outlet.legalEntityId),
                eq(accountMappings.role, "petty_cash"),
              ),
            )
            .limit(1);
          if (!pettyCashMapping)
            throw new AccountingError(
              "ACCOUNT_MAPPING_MISSING",
              "No account mapped for petty_cash",
            );
          const documentId = randomUUID();
          await tx.insert(cashBankEntries).values({
            id: documentId,
            tenantId,
            legalEntityId: outlet.legalEntityId,
            outletId: input.outletId,
            kind: "petty_topup",
            entryDate,
            amountIdr: input.amountIdr,
            bankAccountId: bank.id,
            toBankAccountId: null,
            counterAccountId: null,
            description: input.description,
            reference: null,
            idempotencyKey: input.idempotencyKey,
            journalEntryId: null,
            status: "pending_approval",
            createdBy: actorId,
          });
          await auditApFa(tx, context, {
            actorId,
            action: "accounting.cash_bank_entry.pending_approval",
            objectType: "cash_bank_entry",
            objectId: documentId,
            outletId: input.outletId,
            before: null,
            after: {
              kind: "petty_topup",
              amountIdr: input.amountIdr,
              status: "pending_approval",
            },
          });
          // Same transaction as the document: no document without a chain. The
          // matrix tiers on the day total (anti-split), the real amount rides in
          // the payload. APPROVAL_POLICY_MISSING (409) propagates and rolls the
          // submission back whole; a result without a chain fails closed too.
          const opened = await openApprovalRequest(tx, context, {
            sourceModule: PETTY_TOPUP_APPROVAL_SOURCE_MODULE,
            actionType: "cash_out",
            objectType: PETTY_TOPUP_ENTRY_OBJECT_TYPE,
            objectId: documentId,
            amountIdr: cashCheck.dayTotalIdr,
            outletId: input.outletId,
            requestedBy: actorId,
            source: "user",
            requestReason:
              input.description.length >= 3
                ? input.description.slice(0, 500)
                : `Isi kas kecil: ${input.description}`,
            payload: {
              kind: "petty_topup",
              amountIdr: input.amountIdr,
              dayTotalIdr: cashCheck.dayTotalIdr,
            },
            alwaysRequire: true,
            now,
          });
          if (!opened.required)
            throw new HttpError(
              409,
              "PETTY_TOPUP_CHAIN_MISSING",
              "Isi kas kecil yang tertahan harus punya rantai persetujuan.",
            );
          return { id: documentId, pending: true };
        }

        const moved = await applyMovement(tx, context, {
          kind: input.kind,
          legalEntityId: outlet.legalEntityId,
          outletId: input.outletId,
          bank,
          amountIdr: input.amountIdr,
          description: input.description,
          entryDate,
          idempotencyKey: input.idempotencyKey,
          createdBy: actorId,
          actorId,
          park: true,
        });
        await auditApFa(tx, context, {
          actorId,
          action: "accounting.petty_cash.movement_recorded",
          objectType: "petty_cash_entry",
          objectId: moved.id,
          outletId: input.outletId,
          before: null,
          after: {
            kind: input.kind,
            amountIdr: input.amountIdr,
            balanceAfterIdr: moved.balanceAfter,
            journalStatus: moved.posted.status,
            ...(moved.posted.status === "parked"
              ? { parkCode: moved.posted.code }
              : {}),
          },
        });
        return { id: moved.id, pending: false };
      },
    );
    if (stored.pending) {
      const [document] = await tx
        .select()
        .from(cashBankEntries)
        .where(
          and(
            eq(cashBankEntries.tenantId, tenantId),
            eq(cashBankEntries.id, stored.id),
          ),
        )
        .limit(1);
      if (!document) throw notFound("Transaksi kas dan bank");
      return { pending: true, entry: cashBankEntryDto(document) };
    }
    // Read the current state: a replay shows a parked entry that got posted.
    return {
      pending: false,
      entry: pettyCashEntryDto(await loadEntry(tx, tenantId, stored.id)),
    };
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
    // Entity lock first, then the entry row: read the entry unlocked for its
    // legal entity, lock the entity, then re-read under the row lock (a retry
    // that lost the race sees the entry already posted and returns it).
    const unlocked = await loadEntry(tx, tenantId, entryId);
    await entityLock(tx, tenantId, unlocked.legalEntityId);
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
 * `createPettyPurchase`, same transaction). An outlet without a fund is refused
 * with PETTY_CASH_FUND_REQUIRED (founder Q8); with a fund, a purchase above the
 * balance is PETTY_CASH_INSUFFICIENT. Either way the whole purchase is rolled
 * back. The ledger row is `external`: its journal belongs to
 * `petty_purchase.recorded`.
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
  // Entity lock before the fund row, same order as every other petty cash path
  // (the entity comes from the outlet: the fund may not exist yet).
  const [outlet] = await tx
    .select({ legalEntityId: outlets.legalEntityId })
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)))
    .limit(1);
  if (!outlet) throw notFound("Outlet");
  await entityLock(tx, tenantId, outlet.legalEntityId);
  const fund = await lockFund(tx, tenantId, outletId);
  if (!fund) throw new AccountingError("PETTY_CASH_FUND_REQUIRED");
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
