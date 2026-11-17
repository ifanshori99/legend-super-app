// Cash in, cash out and bank-to-bank transfers (bead legend-4961, WS-07; PRD
// v1.7 §3.19 Kas & Bank). Contract: `@starter/shared/accounting` banking.ts,
// endpoints `listCashBankEntries` / `getCashBankEntry` / `createCashBankEntry`.
// Design: docs/briefs/ws-cash-bank-design.md.
//
// - One document, one journal: the journal is posted in the same transaction
//   as the `cash_bank_entries` row (journal_entry_id is UNIQUE), under the
//   server-derived key `cb:<entryId>`. A failed posting rolls the whole
//   request back; a cash/bank document is never parked.
// - Founder Q7 (13 Nov 2026): a cash_out with amount > the tenant limit
//   (strictly above; default Rp5.000.000, `finance_policies`) is stored
//   `pending_approval` with NO journal. `approveCashBankEntry` (not its
//   creator, `accounting.cash_bank.approve`) posts the journal once under the
//   same key in one transaction with a row lock; `rejectCashBankEntry` ends it
//   with no journal. Bank balance and reconciliation read the GL, so a pending
//   entry never counts.
// - Inbox (legend-4qowr): a pending cash out also opens an approval chain
//   (action `cash_out`, object `cash_bank_entry`, default matrix = Finance).
//   `settleCashBankEntryForApproval` (worker consumer) applies the chain's
//   outcome from the database under the entry's row lock, through the same
//   approve/reject code as the direct endpoints: one journal, one key. A chain
//   that expires, is cancelled or whose approver may not decide leaves the
//   entry pending (no journal). The direct approve posts only when the chain
//   is fully approved (CASH_OUT_CHAIN_OPEN / CASH_OUT_CHAIN_MISSING otherwise,
//   legend-3bkvl); the direct reject still works and cancels the open chain.
//   The matrix tiers on the creator's day total (anti-split) and a pending
//   entry always has a chain (`alwaysRequire`, fail closed; legend-lhyt0). A tenant with no cash_out policy
//   cannot submit above the limit (APPROVAL_POLICY_MISSING 409, fail closed).
// - Bank accounts live on the legal entity, so a write needs tenant scope
//   (assertTenantScope). The optional outlet tag is only a cost tag.
// - Idempotent per client key (`idempotentCommand`): a replay returns the same
//   entry, the same key with another body is IDEMPOTENCY_KEY_REUSED (409).
// - The counter account of cash in/out is chosen by the caller and must not be
//   a cash or bank account (use a transfer), the GL account of any bank account
//   of the entity, or an account mapped to a role a subledger owns (receivable,
//   payable, salaries, tax, deposit, clearing, inventory, cash roles); the
//   bank leg is always the GL account of the chosen bank account. Nothing is
//   guessed.
// - Reads are narrowed to the caller's outlets: an outlet-scoped caller sees
//   only entries tagged to one of its outlets (entity-level rows are hidden).

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  AccountingError,
  type PostingAccountRole,
  cashBankJournalLines,
  createCashBankEntryInputSchema,
  putCashOutApprovalLimitInputSchema,
  rejectCashBankEntryInputSchema,
  type CashBankEntry,
  type CashOutApprovalLimit,
  type CreateCashBankEntryInput,
} from "@starter/shared/accounting";
import {
  assertTrustedScopedContext,
  decodeCursor,
  encodeCursor,
  outletIdsForQuery,
  uuidSchema,
  idr,
  type BusinessDate,
  type CursorPage,
  type ScopedTenantContext,
  type TenantId,
  userIdSchema,
  type UserId,
} from "@starter/shared/core";
import { db } from "../db";
import { accountMappings, chartOfAccounts } from "../db/schema/accounting.ts";
import { financePolicies } from "../db/schema/accounting-ap-fa.ts";
import { bankAccounts } from "../db/schema/accounting-cash-bank.ts";
import {
  cashBankEntries,
  type CashBankEntryRow,
} from "../db/schema/accounting-cash-bank-entries.ts";
import { approvalRequests } from "../db/schema/platform-approval.ts";
import { outlets } from "../db/schema/platform-org.ts";
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
import {
  cashBankEntryDto,
  loadBankAccount,
  notFound,
} from "./accounting-cash-bank-shared.ts";
import {
  readLimitIdr,
  cashApprovalCheck,
} from "./accounting-cash-limit.service.ts";
import { postJournalInTransaction } from "./accounting-journal.service.ts";
import { assertPeriodOpenForPosting } from "./accounting-period.service.ts";
import { approvePettyTopupInTransaction } from "./accounting-petty-cash.service.ts";
import { requireLegalEntity } from "./accounting-shared.ts";
import {
  loadTenantAccessInTransaction,
  resolveAccessSnapshot,
} from "./permission-resolver.ts";
import {
  cancelApprovalRequest,
  openApprovalRequest,
  resolveApprovalChainOutcome,
} from "./platform-approval.service.ts";

export { cashBankEntryDto };

export type CashBankEntryListQuery = {
  legalEntityId: string;
  from: string;
  to: string;
  kind?: CashBankEntry["kind"];
  bankAccountId?: string;
  cursor?: string;
  limit: number;
};

/** Approval inbox identity of a pending cash out (legend-4qowr). */
export const CASH_BANK_APPROVAL_SOURCE_MODULE = "accounting";
export const CASH_BANK_ENTRY_OBJECT_TYPE = "cash_bank_entry";
const CASH_OUT_APPROVE_PERMISSION = "accounting.cash_bank.approve";

const OPERATION = "cash_bank.entry.create";
const SOURCE_TYPES = {
  cash_in: "cash_receipt",
  cash_out: "cash_payment",
  transfer: "bank_transfer",
} as const;
type DocumentKind = keyof typeof SOURCE_TYPES;

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
  tenantId: TenantId,
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

/**
 * Posting roles whose balance a subledger or a dedicated flow owns: a free
 * cash in/out line on them would drift the control account from its subledger.
 * Local list: no shared const names these roles (every role verified in
 * `POSTING_ACCOUNT_ROLES`); restrictive by design, add a role when unsure.
 */
const COUNTER_ACCOUNT_DENIED_ROLES: readonly PostingAccountRole[] = [
  "accounts_receivable",
  "accounts_payable",
  "salaries_payable",
  "tax_payable_pbjt",
  "tax_payable_ppn",
  "tax_payable_other",
  "customer_deposit",
  "pph21_payable",
  "pph23_payable",
  "dividend_tax_payable",
  "bpjs_payable",
  "loyalty_liability",
  "gateway_clearing",
  "employee_receivable",
  "grni",
  "edc_clearing",
  "inventory",
  "inventory_semi_finished",
  "inventory_adjustment",
  "ppn_input",
  "fixed_assets",
  "accumulated_depreciation",
  "loyalty_points_deferral",
  "retained_earnings",
  "opening_balance_equity",
  "petty_cash",
  "cash_on_hand",
  "bank",
];

/**
 * The counter account of cash in/out: same entity, never a cash or bank
 * account, the GL account of any bank account of the entity, or an account
 * mapped to a subledger-owned role (one denylist query per entity).
 */
async function assertCounterAccount(
  tx: TenantTransaction,
  tenantId: TenantId,
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
  const [denied] = await tx
    .select({ id: accountMappings.accountId })
    .from(accountMappings)
    .where(
      and(
        eq(accountMappings.tenantId, tenantId),
        eq(accountMappings.legalEntityId, legalEntityId),
        eq(accountMappings.accountId, accountId),
        inArray(accountMappings.role, [...COUNTER_ACCOUNT_DENIED_ROLES]),
      ),
    )
    .union(
      tx
        .select({ id: bankAccounts.glAccountId })
        .from(bankAccounts)
        .where(
          and(
            eq(bankAccounts.tenantId, tenantId),
            eq(bankAccounts.legalEntityId, legalEntityId),
            eq(bankAccounts.glAccountId, accountId),
          ),
        ),
    )
    .limit(1);
  if (denied) throw new AccountingError("CASH_BANK_COUNTER_ACCOUNT_INVALID");
}

/** A bank account that can take part in a document of this legal entity. */
async function loadUsableBankAccount(
  tx: TenantTransaction,
  tenantId: TenantId,
  legalEntityId: string,
  bankAccountId: string,
) {
  const account = await loadBankAccount(tx, tenantId, bankAccountId);
  if (account.legalEntityId !== legalEntityId)
    throw invalid("Rekening bank harus milik badan usaha dokumen ini.");
  if (!account.isActive) throw invalid("Rekening bank ini tidak aktif.");
  return account;
}

/** The cost-tag outlet must belong to the legal entity of the document. */
async function assertOutletOfEntity(
  tx: TenantTransaction,
  tenantId: TenantId,
  legalEntityId: string,
  outletId: string,
): Promise<void> {
  const [outlet] = await tx
    .select({ legalEntityId: outlets.legalEntityId })
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)))
    .limit(1);
  if (!outlet) throw notFound("Outlet");
  if (outlet.legalEntityId !== legalEntityId)
    throw invalid("Outlet harus milik badan usaha dokumen ini.");
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
        // Length checks and what is stored use the trimmed text, like the
        // approval request does (the schema already trims; kept explicit).
        const description = input.description.trim();
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
        }
        const outletId =
          input.kind === "transfer" ? null : (input.outletId ?? null);
        if (outletId)
          await assertOutletOfEntity(
            tx,
            tenantId,
            input.legalEntityId,
            outletId,
          );
        await entityLock(tx, tenantId, input.legalEntityId);

        const entryId = randomUUID();
        const approval =
          input.kind === "cash_out"
            ? await cashApprovalCheck(tx, {
                tenantId,
                actorId,
                amountIdr: input.amountIdr,
              })
            : null;
        if (input.kind === "cash_out" && approval?.required) {
          // Above the tenant limit, or the creator's cash outs and top-ups of
          // the day (all outlets) add up past it (anti-split): validated like a
          // posting (period open, accounts usable) but parked without a
          // journal until approved.
          await assertPeriodOpenForPosting(tx, context, {
            legalEntityId: input.legalEntityId,
            entryDate: input.entryDate as BusinessDate,
          });
          await tx.insert(cashBankEntries).values({
            id: entryId,
            tenantId,
            legalEntityId: input.legalEntityId,
            outletId,
            kind: input.kind,
            entryDate: input.entryDate,
            amountIdr: input.amountIdr,
            bankAccountId: bank.id,
            toBankAccountId: null,
            counterAccountId: input.counterAccountId,
            description,
            reference: input.reference,
            idempotencyKey: input.idempotencyKey,
            journalEntryId: null,
            status: "pending_approval",
            createdBy: actorId,
          });
          await auditApFa(tx, context, {
            actorId,
            action: "accounting.cash_bank_entry.pending_approval",
            objectType: "cash_bank_entry",
            objectId: entryId,
            outletId,
            before: null,
            after: {
              kind: input.kind,
              amountIdr: input.amountIdr,
              status: "pending_approval",
            },
          });
          // APPROVAL_POLICY_MISSING (409) propagates: with no cash_out policy
          // nobody may decide, so the submission rolls back whole (no entry,
          // no request, no journal). Fail closed.
          // The matrix tiers on the creator's day total (anti-split, SO 1036
          // finding 5), not on this fragment; the entry's own amount rides in
          // the payload. `alwaysRequire`: a pending entry always has a chain.
          const opened = await openApprovalRequest(tx, context, {
            sourceModule: CASH_BANK_APPROVAL_SOURCE_MODULE,
            actionType: "cash_out",
            objectType: CASH_BANK_ENTRY_OBJECT_TYPE,
            objectId: entryId,
            amountIdr: approval.dayTotalIdr,
            outletId,
            requestedBy: actorId,
            source: "user",
            requestReason:
              description.length >= 3
                ? description.slice(0, 500)
                : `Kas keluar: ${description}`,
            payload: {
              entryAmountIdr: input.amountIdr,
              dayTotalIdr: approval.dayTotalIdr,
            },
            alwaysRequire: true,
            now,
          });
          // Fail closed: a pending entry without a chain could never be
          // decided by the matrix. Roll the whole submission back.
          if (!opened.required)
            throw new AccountingError("CASH_OUT_CHAIN_MISSING");
          return { id: entryId };
        }
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
            description,
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
            description,
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

// ------------------------------------------------- approval limit (Q7)

/** Contract `getCashOutApprovalLimit`: reads are not outlet-narrowed (one tenant value). */
export async function getCashOutApprovalLimit(
  context: ScopedTenantContext,
): Promise<CashOutApprovalLimit> {
  assertTrustedScopedContext(context);
  return withTenant(db, context, (tx) =>
    readLimitIdr(tx, context.tenant.tenantId),
  );
}

/** Contract `putCashOutApprovalLimit`: tenant scope, audited; 1..100.000.000.000. */
export async function putCashOutApprovalLimit(
  context: ScopedTenantContext,
  rawInput: unknown,
  actorId: UserId,
  now: Date = new Date(),
): Promise<CashOutApprovalLimit> {
  const input = putCashOutApprovalLimitInputSchema.parse(rawInput);
  assertTrustedScopedContext(context);
  assertTenantScope(context);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const before = await readLimitIdr(tx, tenantId);
    const values = {
      cashOutApprovalLimitIdr: idr(input.limitIdr),
      updatedBy: actorId,
      updatedAt: now,
    };
    await tx
      .insert(financePolicies)
      .values({ tenantId, ...values, createdAt: now })
      .onConflictDoUpdate({ target: financePolicies.tenantId, set: values });
    await auditApFa(tx, context, {
      actorId,
      action: "accounting.cash_bank_limit.changed",
      objectType: "cash_bank_approval_limit",
      objectId: tenantId,
      before: { limitIdr: before.limitIdr, isDefault: before.isDefault },
      after: { limitIdr: input.limitIdr, isDefault: false },
    });
    return { limitIdr: input.limitIdr, isDefault: false };
  });
}

// ------------------------------------------------- approve / reject (Q7)

/** Row lock: concurrent decisions on one entry run one after the other. */
async function loadEntryForUpdate(
  tx: TenantTransaction,
  tenantId: TenantId,
  entryId: string,
): Promise<CashBankEntryRow | null> {
  const [row] = await tx
    .select()
    .from(cashBankEntries)
    .where(
      and(
        eq(cashBankEntries.tenantId, tenantId),
        eq(cashBankEntries.id, entryId),
      ),
    )
    .limit(1)
    .for("update");
  return row ?? null;
}

async function lockEntryForDecision(
  tx: TenantTransaction,
  tenantId: TenantId,
  entryId: string,
  actorId: UserId,
): Promise<CashBankEntryRow> {
  const row = await loadEntryForUpdate(tx, tenantId, entryId);
  if (!row) throw new AccountingError("CASH_ENTRY_NOT_FOUND");
  // Nobody decides their own document, whatever its status.
  if (row.createdBy === actorId)
    throw new AccountingError("CASH_OUT_SELF_APPROVAL");
  return row;
}

/** Chain of the entry's inbox request; null when it never opened one. */
async function inboxChainOf(
  tx: TenantTransaction,
  tenantId: TenantId,
  entryId: string,
): Promise<string | null> {
  const [head] = await tx
    .select({ chainId: approvalRequests.chainId })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, tenantId),
        eq(approvalRequests.sourceModule, CASH_BANK_APPROVAL_SOURCE_MODULE),
        eq(approvalRequests.actionType, "cash_out"),
        eq(approvalRequests.objectType, CASH_BANK_ENTRY_OBJECT_TYPE),
        eq(approvalRequests.objectId, entryId),
      ),
    )
    .orderBy(desc(approvalRequests.createdAt))
    .limit(1);
  return head?.chainId ?? null;
}

/** A decision made on the direct endpoints also withdraws the inbox request. */
async function closeInboxChain(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  entryId: string,
  actorId: UserId,
  now: Date,
): Promise<void> {
  const chainId = await inboxChainOf(tx, context.tenant.tenantId, entryId);
  if (chainId === null) return;
  await cancelApprovalRequest(tx, context, {
    chainId,
    sourceModule: CASH_BANK_APPROVAL_SOURCE_MODULE,
    actorUserId: actorId,
    now,
  });
}

/**
 * Posts the journal of a locked pending entry once (key `cb:<entryId>`) and
 * marks it approved by `actorId`, on the caller's transaction. Counter account,
 * bank account and period are checked again; a refusal leaves it pending.
 */
async function approvePendingEntry(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  row: CashBankEntryRow,
  actorId: UserId,
  now: Date,
): Promise<CashBankEntryRow> {
  const tenantId = context.tenant.tenantId;
  await entityLock(tx, tenantId, row.legalEntityId);
  const bank = await loadUsableBankAccount(
    tx,
    tenantId,
    row.legalEntityId,
    row.bankAccountId,
  );
  let journal: { id: string };
  if (row.kind === "petty_topup") {
    // The real top-up runs here, in this transaction: the fund balance and
    // its ledger row move once, the journal is booked (never parked). A
    // closed period or a missing mapping fails the request, entry stays pending.
    if (row.outletId === null)
      throw new AccountingError("CASH_ENTRY_NOT_PENDING");
    journal = await approvePettyTopupInTransaction(tx, context, {
      cashBankEntryId: row.id,
      legalEntityId: row.legalEntityId,
      outletId: row.outletId,
      entryDate: row.entryDate,
      amountIdr: row.amountIdr,
      description: row.description,
      bank,
      createdBy: row.createdBy,
      approverId: actorId,
    });
  } else {
    const kind = row.kind as DocumentKind;
    if (row.counterAccountId === null)
      throw new AccountingError("CASH_ENTRY_NOT_PENDING");
    await assertCounterAccount(
      tx,
      tenantId,
      row.legalEntityId,
      row.counterAccountId,
    );
    journal = await postJournalInTransaction(
      tx,
      context,
      {
        legalEntityId: row.legalEntityId,
        outletId: row.outletId,
        entryDate: row.entryDate as BusinessDate,
        sourceType: SOURCE_TYPES[kind],
        sourceId: row.id,
        description: row.description,
        lines: cashBankJournalLines(
          {
            kind,
            amountIdr: row.amountIdr,
            outletId: row.outletId,
          },
          { bankGl: bank.glAccountId, counter: row.counterAccountId },
        ),
        postedBy: actorId,
        idempotencyKey: `cb:${row.id}`,
      },
      now,
    );
  }
  const [updated] = await tx
    .update(cashBankEntries)
    .set({
      status: "approved",
      approverId: actorId,
      decidedAt: now,
      journalEntryId: journal.id,
    })
    .where(
      and(
        eq(cashBankEntries.tenantId, tenantId),
        eq(cashBankEntries.id, row.id),
        eq(cashBankEntries.status, "pending_approval"),
      ),
    )
    .returning();
  if (!updated) throw new AccountingError("CASH_ENTRY_NOT_PENDING");
  await auditApFa(tx, context, {
    actorId,
    action: "accounting.cash_bank_entry.approved",
    objectType: "cash_bank_entry",
    objectId: row.id,
    outletId: row.outletId,
    before: { status: "pending_approval" },
    after: {
      status: "approved",
      amountIdr: row.amountIdr,
      journalEntryId: journal.id,
    },
  });
  return updated;
}

/** Ends a locked pending entry as rejected by `actorId`: no journal, final. */
async function rejectPendingEntry(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  row: CashBankEntryRow,
  actorId: UserId,
  reason: string,
  now: Date,
): Promise<CashBankEntryRow> {
  const tenantId = context.tenant.tenantId;
  const [updated] = await tx
    .update(cashBankEntries)
    .set({
      status: "rejected",
      approverId: actorId,
      decidedAt: now,
      decisionReason: reason,
    })
    .where(
      and(
        eq(cashBankEntries.tenantId, tenantId),
        eq(cashBankEntries.id, row.id),
        eq(cashBankEntries.status, "pending_approval"),
      ),
    )
    .returning();
  if (!updated) throw new AccountingError("CASH_ENTRY_NOT_PENDING");
  await auditApFa(tx, context, {
    actorId,
    action: "accounting.cash_bank_entry.rejected",
    objectType: "cash_bank_entry",
    objectId: row.id,
    outletId: row.outletId,
    reason,
    before: { status: "pending_approval" },
    after: { status: "rejected", amountIdr: row.amountIdr },
  });
  return updated;
}

/**
 * Approves a pending cash out (or petty cash top-up): counter account and period are checked again,
 * the journal is posted once (key `cb:<entryId>`) and the entry turns
 * `approved` in the same transaction. An approved entry is returned as it is
 * (no second journal); a rejected one is CASH_ENTRY_NOT_PENDING (409). A
 * closed period or an unusable account fails the request and the entry stays
 * pending.
 */
export async function approveCashBankEntry(
  context: ScopedTenantContext,
  entryId: string,
  actorId: UserId,
): Promise<CashBankEntry> {
  assertTrustedScopedContext(context);
  assertTenantScope(context);
  const result = await withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const row = await lockEntryForDecision(tx, tenantId, entryId, actorId);
    if (row.status === "approved")
      return { entry: cashBankEntryDto(row), refused: false };
    if (row.status !== "pending_approval")
      throw new AccountingError("CASH_ENTRY_NOT_PENDING");
    const now = new Date();
    // The inbox already said no (rejected, expired or cancelled chain): the
    // direct endpoint must not override it. Apply the rejection (when a
    // distinct rejecter exists) and commit it, then refuse after the commit.
    const chainId = await inboxChainOf(tx, tenantId, row.id);
    // No chain: nothing proves the matrix levels (roles, order) were met, so
    // there is no journal (SO 1036 finding 1). Fail closed.
    if (chainId === null) throw new AccountingError("CASH_OUT_CHAIN_MISSING");
    const outcome = await resolveApprovalChainOutcome(tx, context, {
      chainId,
      sourceModule: CASH_BANK_APPROVAL_SOURCE_MODULE,
      now,
    });
    if (
      outcome === "rejected" ||
      outcome === "expired" ||
      outcome === "cancelled"
    ) {
      await settleCashBankEntryForApproval(tx, context, row.id, now);
      return { entry: null, refused: true };
    }
    // Still open: the direct endpoint may not post before every level of the
    // chain has approved (the inbox does that, through the consumer). The
    // chain is left open.
    if (outcome !== "approved") throw new AccountingError("CASH_OUT_CHAIN_OPEN");
    const updated = await approvePendingEntry(tx, context, row, actorId, now);
    await closeInboxChain(tx, context, row.id, actorId, now);
    return { entry: cashBankEntryDto(updated), refused: false };
  });
  if (result.refused || result.entry === null)
    throw new AccountingError("CASH_ENTRY_NOT_PENDING");
  return result.entry;
}

/**
 * Rejects a pending cash out with a reason: no journal, final. Rejecting a
 * rejected entry returns it; an approved one is CASH_ENTRY_NOT_PENDING (its
 * journal is posted: correct it with a reversing document).
 */
export async function rejectCashBankEntry(
  context: ScopedTenantContext,
  entryId: string,
  rawInput: unknown,
  actorId: UserId,
): Promise<CashBankEntry> {
  const input = rejectCashBankEntryInputSchema.parse(rawInput);
  assertTrustedScopedContext(context);
  assertTenantScope(context);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const row = await lockEntryForDecision(tx, tenantId, entryId, actorId);
    if (row.status === "rejected") return cashBankEntryDto(row);
    if (row.status !== "pending_approval")
      throw new AccountingError("CASH_ENTRY_NOT_PENDING");
    const now = new Date();
    const updated = await rejectPendingEntry(
      tx,
      context,
      row,
      actorId,
      input.reason,
      now,
    );
    await closeInboxChain(tx, context, row.id, actorId, now);
    return cashBankEntryDto(updated);
  });
}

// ------------------------------------------------- inbox settle (legend-4qowr)

/**
 * Business refusals of the posting guards. A chain that already ended
 * "approved" cannot wait for them to clear, so the entry stays pending (no
 * journal, decidable on the direct endpoints); any other error (infra, lock
 * timeout) is rethrown so the outbox retries.
 */
const POSTING_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "PERIOD_CLOSED",
  "PERIOD_MISMATCH",
  "ACCOUNT_INACTIVE",
  "ACCOUNT_NOT_POSTABLE",
  "ACCOUNT_ENTITY_MISMATCH",
]);

function isPostingRefusal(error: unknown): boolean {
  if (error instanceof AccountingError)
    return POSTING_REFUSAL_CODES.has(error.code);
  // Unusable bank or counter account (loadUsableBankAccount, assertCounterAccount).
  return error instanceof HttpError && error.status === 422;
}

/** The inbox role can decide; the ledger still needs the approve permission. */
async function approverMayApproveCashOut(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  userId: UserId,
  now: Date,
): Promise<boolean> {
  const data = await loadTenantAccessInTransaction(tx, context, userId);
  const snapshot = resolveAccessSnapshot({
    tenant: context.tenant,
    userId,
    ...data,
    mfaVerified: false,
    now,
  });
  return snapshot.allows(CASH_OUT_APPROVE_PERMISSION, { type: "tenant" });
}

/**
 * Applies the approval chain's outcome to a pending entry, on the caller's
 * transaction (entry row locked FOR UPDATE, then the chain). The chain row in
 * the database is the authority, never the event. Idempotent: an entry that is
 * no longer pending, has no chain or whose chain is still open is returned
 * unchanged, so a replay posts nothing twice (journal key `cb:<entryId>`).
 * - approved by someone other than the creator who holds
 *   `accounting.cash_bank.approve`: posts through the same code as the direct
 *   approve (savepoint: a refused posting leaves no partial write and the entry
 *   stays pending);
 * - rejected by someone other than the creator: ends rejected with the inbox
 *   reason, no journal;
 * - expired, cancelled or an approver who may not decide: stays pending.
 * Returns null when the tenant has no such entry.
 */
export async function settleCashBankEntryForApproval(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  entryId: string,
  now: Date = new Date(),
): Promise<CashBankEntry | null> {
  const tenantId = context.tenant.tenantId;
  const row = await loadEntryForUpdate(tx, tenantId, entryId);
  if (!row) return null;
  if (row.status !== "pending_approval") return cashBankEntryDto(row);
  const chainId = await inboxChainOf(tx, tenantId, row.id);
  if (chainId === null) return cashBankEntryDto(row);
  const outcome = await resolveApprovalChainOutcome(tx, context, {
    chainId,
    sourceModule: CASH_BANK_APPROVAL_SOURCE_MODULE,
    now,
  });
  if (outcome !== "approved" && outcome !== "rejected")
    return cashBankEntryDto(row);
  const [last] = await tx
    .select({
      decidedBy: approvalRequests.decidedBy,
      reason: approvalRequests.reason,
    })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, tenantId),
        eq(approvalRequests.chainId, chainId),
      ),
    )
    .orderBy(desc(approvalRequests.level))
    .limit(1);
  const deciderRaw = last?.decidedBy ?? null;
  if (
    deciderRaw === null ||
    deciderRaw.toLowerCase() === row.createdBy.toLowerCase()
  )
    return cashBankEntryDto(row);
  const decider = userIdSchema.parse(deciderRaw);
  if (outcome === "rejected")
    return cashBankEntryDto(
      await rejectPendingEntry(
        tx,
        context,
        row,
        decider,
        (last?.reason ?? "Ditolak di kotak masuk persetujuan.").slice(0, 500),
        now,
      ),
    );
  if (!(await approverMayApproveCashOut(tx, context, decider, now)))
    return cashBankEntryDto(row);
  try {
    // Savepoint: a refused posting leaves no partial ledger write behind.
    return cashBankEntryDto(
      await tx.transaction((sp) =>
        approvePendingEntry(sp, context, row, decider, now),
      ),
    );
  } catch (error) {
    if (!isPostingRefusal(error)) throw error;
    return cashBankEntryDto(row);
  }
}
