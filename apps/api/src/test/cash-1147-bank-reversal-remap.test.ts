// legend 1147 / second opinion 1147 finding P1-1
// (docs/qa/second-opinion-kas-ronde10-1147.md, brief docs/briefs/1147): the manual
// reversal of a journal that paid money OUT of a BANK account (salary paid by
// manual_bank, supplier payment) must not turn into fake petty cash after the
// mapping was swapped. Written from the brief, the SO scenario and the founder
// rule "GL 1102 never goes negative, nobody is paid when the cash is not there",
// observed over HTTP (reversal endpoint, kasbon disbursement), the payout
// services the existing payout tests drive, and the database, not from the
// guard code.
//
// SO scenario: petty_cash A has Rp0, bank B has the money. A salary is paid by
// manual_bank (posting `settle`): Dr salaries payable / Cr B. Later `bank` is
// moved B -> D and `petty_cash` A -> B. Reversing the salary journal would give
// Dr B / Cr salaries payable: GL B (now the petty cash account) rises by
// Rp100.000 although the transfer stays paid, and a cash kasbon of Rp100.000
// would be paid with no money.
//
// CTO decision 1 makes the mapping endpoint refuse such a move for accounts
// with history, so this file builds the world as LEGACY state: it pays through
// the real flows, then rewrites account_mappings rows DIRECTLY (superuser
// transaction, bypassing the endpoint). The guard of the reversal endpoint must
// still refuse (CTO decision 2: the journal's own snapshot account and today's
// mapping are judged separately).
//
// Per scenario: the HTTP result, no reversal journal on a 409, the source
// unchanged, GL of the new petty cash account unchanged (Rp0), and a following
// cash movement refused for lack of real cash.
//
// Assumptions (stated so they can be contested):
// - The refusal is HTTP 409 with error code CASH_OUT_JOURNAL_LOCKED (the
//   sibling 1089 lock, pinned in cash-1102-1089-r2-reversal-lock.test.ts).
// - A reversal body is { entryDate, reason, idempotencyKey } on
//   POST /api/accounting/journals/:id/reversal as finance.
// - A salary carried by a payroll run (including a reimbursement with payout
//   "payroll") is paid through the same bank payout flow, so the bank-paid
//   reimbursement case is the same journal shape as scenario 1; the
//   reimbursement scenario here is the cash-paid variant (petty cash snapshot A
//   remapped away to a fresh account).
// - The supplier world has no HR / kasbon path; its "no fake cash" follow-up is
//   bank put back on B (petty cash stays B, so the supplier cash cover guard
//   reads GL B) and a second payment of the same invoice, which must stay
//   pending_approval (it would be paid if the reversal had re-opened Rp60.000 on B).
// - Reversing a bank-paid salary journal with NO remap is allowed at base
//   (observed: 201), because the journal does not credit petty cash; the
//   control pins that it keeps working and does not create available cash.
// - The bank-paid payroll settle journal debits salaries payable (2103) and
//   credits the bank GL account of the payout source; B is read from that
//   journal, not assumed.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ROLE_TEMPLATES } from "@starter/shared/access";
import { tenantIdSchema } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { reimbursementPaid } from "@starter/shared/hris/payroll";
import { approvalResolvedEvent } from "@starter/shared/identity";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { deliverPayrollGlEvent } from "../services/payroll-gl-consumer.ts";
import { decideApprovalRequest } from "../services/platform-approval.service.ts";
import { handlePurchasingApprovalResolved } from "../services/purchasing-approval-consumer.ts";
import { setPurchaseReturnPostingEnabled } from "../services/purchase-return.service.ts";
import { setSupplierInvoicePostingEnabled } from "../services/purchasing-invoice.service.ts";
import { originHeader } from "./helpers.ts";
import {
  daysAgo,
  key,
  owner,
  signedIn,
  tenantId,
  type Session,
} from "./helpers/cash-bank-world.ts";
import {
  expectGlRefusal,
  installLoanCashWorld,
  type Res,
} from "./helpers/cash-1118-world.ts";
import { BUDI, bank } from "./payroll-payout-fixtures.ts";
import {
  addUser,
  api,
  appPool as aparPool,
  contextFor,
  createInvoice,
  createWorld,
  invoiceBody,
  invoiceIdOf,
  owner as aparOwner,
  receive,
  seedPo,
  today as aparToday,
  type World as AparWorld,
  type Session as AparSession,
} from "./purchasing-apar-helpers.ts";

const AMOUNT = 100_000;
const LOCKED = "CASH_OUT_JOURNAL_LOCKED";
const app = createApp();
const H = installLoanCashWorld("1147bk");
let finance: Session;
/** Original cash-role mappings of the payroll world, restored after each test. */
let originalBank: string;
let originalPetty: string;
/** Kasbon / claims paid by a test only because the fix is missing: dropped in cleanup. */
const leaked: string[] = [];
/** Reversal journals created by a (wrongly) accepted reversal. */
const reversalIds: string[] = [];

beforeAll(async () => {
  finance = await signedIn(app, "1147bk finance", [
    { role: "finance", outletId: null },
  ]);
  originalBank = await H.mappedAccountId("bank");
  originalPetty = await H.mappedAccountId("petty_cash");
});

afterEach(async () => {
  await legacyRemap(H.W.entityId(), tenantId, owner, [
    ["petty_cash", originalPetty],
    ["bank", originalBank],
  ]);
  while (leaked.length > 0) await H.forget(leaked.pop()!);
  await dropReversalJournals();
  await H.restoreBaseline();
});

// ---- setup helpers -------------------------------------------------------------

type Pool = typeof owner;

/**
 * Rewrites cash-role mapping rows straight in the database, in the given order
 * (triggers off): the LEGACY state the mapping endpoint no longer produces.
 */
async function legacyRemap(
  entityId: string,
  tenant: string,
  pool: Pool,
  moves: [role: string, accountId: string][],
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const [role, accountId] of moves)
      await client.query(
        `UPDATE account_mappings SET account_id = $4
          WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = $3`,
        [tenant, entityId, role, accountId],
      );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Setup hygiene only: removes reversal journals a wrongly accepted reversal left. */
async function dropReversalJournals() {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "DELETE FROM journal_lines WHERE tenant_id = $1 AND entry_id = ANY($2::uuid[])",
      [tenantId, reversalIds],
    );
    await client.query(
      "DELETE FROM journal_entries WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantId, reversalIds],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  reversalIds.length = 0;
}

/** Debit minus credit of one GL account of the payout entity. */
async function glOf(accountId: string): Promise<number> {
  const { rows } = await owner.query<{ balance: string }>(
    `SELECT coalesce(sum(l.debit_idr - l.credit_idr), 0)::text AS balance
       FROM journal_lines l
       JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
      WHERE l.tenant_id = $1 AND e.legal_entity_id = $2 AND l.account_id = $3`,
    [tenantId, H.W.entityId(), accountId],
  );
  return Number(rows[0]!.balance);
}

/** A balanced journal by SQL (setup only), with an optional account snapshot. */
async function seedJournal(input: {
  key: string;
  sourceType: string;
  debitAccountId: string;
  creditAccountId: string;
  amount: number;
  snapshot?: Record<string, string> | null;
}): Promise<string> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const date = daysAgo(0);
    const period = (
      await client.query<{ id: string }>(
        "SELECT id FROM fiscal_periods WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = $3",
        [tenantId, H.W.entityId(), date.slice(0, 7)],
      )
    ).rows[0]!.id;
    const entry = (
      await client.query<{ id: string }>(
        `INSERT INTO journal_entries
           (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
            source_id, description, idempotency_key, request_fingerprint,
            posting_account_snapshot)
         VALUES ($1, $2, $3, $4, $5, NULL, 'Jurnal uji 1147', $6, $7, $8)
         RETURNING id`,
        [
          tenantId,
          H.W.entityId(),
          date,
          period,
          input.sourceType,
          input.key,
          randomBytes(32).toString("hex"),
          input.snapshot ? JSON.stringify(input.snapshot) : null,
        ],
      )
    ).rows[0]!.id;
    await client.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
       VALUES ($1, $2, $3, 1, $5, 0), ($1, $2, $4, 2, 0, $5)`,
      [
        tenantId,
        entry,
        input.debitAccountId,
        input.creditAccountId,
        input.amount,
      ],
    );
    await client.query("COMMIT");
    return entry;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Brings one account to exactly Rp0 with a plain journal against opening balance equity (setup only). */
async function zeroBalance(accountId: string) {
  const balance = await glOf(accountId);
  if (balance < 0) await H.fundAccount(accountId, -balance);
  if (balance > 0)
    await seedJournal({
      key: `zero-1147-${randomUUID()}`,
      sourceType: "manual",
      debitAccountId: await H.mappedAccountId("opening_balance_equity"),
      creditAccountId: accountId,
      amount: balance,
    });
  expect(await glOf(accountId), "premise: account is at Rp0").toBe(0);
}

async function journalIdOf(idempotencyKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2 AND idempotency_key = $3",
    [tenantId, H.W.entityId(), idempotencyKey],
  );
  expect(rows, `premise: one journal under ${idempotencyKey}`).toHaveLength(1);
  return rows[0]!.id;
}

async function reverse(journalId: string): Promise<Res> {
  const res = (await finance.client
    .post(`/api/accounting/journals/${journalId}/reversal`)
    .set(originHeader)
    .send({
      entryDate: daysAgo(0),
      reason: "Koreksi uji 1147 P1-1",
      idempotencyKey: key(),
    })) as Res;
  const created = (res.body.data as { id?: string } | undefined)?.id;
  if (res.status < 300 && created) reversalIds.push(created);
  return res;
}

function expectLocked(res: Res) {
  const detail = JSON.stringify(res.body);
  expect(res.status, detail).toBe(409);
  expect(res.body.error?.code, detail).toBe(LOCKED);
  expect(String(res.body.error?.message ?? ""), "a message").not.toBe("");
}

/** Account the settle journal credits and account it debits, read from its lines. */
async function sidesOf(journalId: string) {
  const { rows } = await owner.query<{
    account_id: string;
    code: string;
    debit: string;
    credit: string;
  }>(
    `SELECT l.account_id, a.code, l.debit_idr::text AS debit, l.credit_idr::text AS credit
       FROM journal_lines l
       JOIN chart_of_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
      WHERE l.tenant_id = $1 AND l.entry_id = $2`,
    [tenantId, journalId],
  );
  const credit = rows.find((row) => Number(row.credit) > 0);
  const debit = rows.find((row) => Number(row.debit) > 0);
  expect(credit, "premise: the journal credits an account").toBeDefined();
  expect(debit, "premise: the journal debits an account").toBeDefined();
  return {
    creditAccountId: credit!.account_id,
    debitCode: debit!.code,
  };
}

/** A following cash kasbon of the same amount must be refused: no real cash anywhere. */
async function expectNoFakeCash() {
  const second = await H.seedLoan(AMOUNT);
  const res = await H.disburse(second, AMOUNT);
  if (res.status === 200) leaked.push(second);
  expectGlRefusal(res);
  expect((await H.loanState(second)).events).toBe(0);
  await H.expectNoCashAvailable();
}

/** A salary of Rp100.000 paid by manual_bank, confirmed and settled; returns the settle journal. */
async function bankPaidSalary() {
  const slips = [bank(BUDI, AMOUNT)];
  const runId = await H.W.seedRun(slips);
  await H.W.postLockedJournal(runId, slips);
  const batchId = await H.W.exportedBatch(runId);
  const items = await H.W.itemsOf(batchId);
  await H.W.confirm(batchId, H.W.succeedItems(batchId, items));
  const postings = await H.W.postingsOf(batchId);
  expect(postings, "premise: one posting").toHaveLength(1);
  expect(postings[0]!.kind, "premise: settled").toBe("settle");
  const journalId = await journalIdOf(postings[0]!.journal_key as string);
  const { creditAccountId, debitCode } = await sidesOf(journalId);
  expect(debitCode, "premise: salaries payable is debited").toBe("2103");
  return { batchId, journalId, bankAccountId: creditAccountId };
}

async function itemStatuses(batchId: string) {
  return (await H.W.itemsOf(batchId)).map((item) => item.status);
}

async function snapshotOf(journalId: string) {
  const { rows } = await owner.query<{ snapshot: Record<string, string> }>(
    "SELECT posting_account_snapshot AS snapshot FROM journal_entries WHERE tenant_id = $1 AND id = $2",
    [tenantId, journalId],
  );
  return rows[0]!.snapshot;
}

// ---- 1. salary paid by bank ------------------------------------------------------

describe("1147 P1-1 reversal of a bank-paid salary journal after a legacy bank/petty_cash swap", () => {
  it("[1147-bank-salary-reversal-remap-409] salary paid by manual_bank (Dr 2103 / Cr bank B, posting settle), then legacy rows bank B->D and petty_cash A->B: the reversal is refused 409 CASH_OUT_JOURNAL_LOCKED, no reversal journal, the transfer stays settled, GL B (now petty cash) stays Rp0, and a following Rp100.000 cash kasbon is refused 422 PETTY_CASH_GL_INSUFFICIENT", async () => {
    await H.drain();
    const { batchId, journalId, bankAccountId } = await bankPaidSalary();
    expect(bankAccountId, "premise: bank role is account B").toBe(originalBank);
    expect(
      (await snapshotOf(journalId)).petty_cash,
      "premise: snapshot A",
    ).toBe(originalPetty);
    await zeroBalance(bankAccountId);
    expect(await H.glBalance(), "premise: petty cash A is Rp0").toBe(0);
    expect(await H.available(), "premise: nothing available on A").toBe(0);
    const cleanD = await H.createCashAccount("1147");
    expect(await glOf(cleanD), "premise: D is clean").toBe(0);
    await legacyRemap(H.W.entityId(), tenantId, owner, [
      ["bank", cleanD],
      ["petty_cash", bankAccountId],
    ]);
    const journals = await H.journalCount();
    const statuses = await itemStatuses(batchId);

    const reversal = await reverse(journalId);

    expectLocked(reversal);
    expect(await H.journalCount(), "no reversal journal").toBe(journals);
    expect(await glOf(bankAccountId), "GL B (petty cash) stays Rp0").toBe(0);
    expect((await H.W.postingsOf(batchId))[0]!.kind).toBe("settle");
    expect(await itemStatuses(batchId), "transfer items unchanged").toEqual(
      statuses,
    );
    await expectNoFakeCash();
  }, 180_000);

  it("[1147-bank-salary-reversal-no-remap-control] control: without any remap the mapping is unchanged, so reversing the bank-paid salary journal (Dr bank B, petty cash A untouched) is allowed as at base (200/201, one reversal journal); petty cash A stays Rp0 and a Rp100.000 cash kasbon is still refused 422", async () => {
    await H.drain();
    const { batchId, journalId, bankAccountId } = await bankPaidSalary();
    await zeroBalance(bankAccountId);
    const journals = await H.journalCount();

    const reversal = await reverse(journalId);

    // Observed at base: petty cash A (the mapping and the snapshot) is not
    // credited by the journal, so the correction is not a cash-out of A.
    expect([200, 201], JSON.stringify(reversal.body)).toContain(
      reversal.status,
    );
    expect(await H.journalCount(), "one reversal journal").toBe(journals + 1);
    expect(await glOf(bankAccountId), "bank B is credited back").toBe(AMOUNT);
    expect((await H.W.postingsOf(batchId))[0]!.kind).toBe("settle");
    expect(await H.glBalance(), "petty cash A stays Rp0").toBe(0);
    await expectNoFakeCash();
  }, 180_000);
});

// ---- 3. cash reimbursement, petty cash remapped away ------------------------------

describe("1147 P1-1 reversal of a paid cash reimbursement journal after a legacy petty_cash move", () => {
  it("[1147-cash-reimbursement-reversal-remap-409] cash claim paid and delivered (Dr 6110 / Cr A, snapshot petty_cash A), legacy row petty_cash A->new account N: the reversal is refused 409 CASH_OUT_JOURNAL_LOCKED, no reversal journal, the claim stays paid, GL A and N stay Rp0, and after the mapping returns to A a second claim is refused 422", async () => {
    await H.drain();
    await H.W.fundPettyCash(AMOUNT);
    const claim = await H.seedClaim(AMOUNT);
    const paid = await H.payClaim(claim, AMOUNT);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const { rows } = await owner.query<{ event: unknown }>(
      `SELECT event FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = 'reimbursement.paid'
          AND event::text LIKE '%' || $2 || '%'`,
      [tenantId, claim],
    );
    expect(rows, "exactly one reimbursement.paid event").toHaveLength(1);
    const event = reimbursementPaid.envelopeSchema.parse(rows[0]!.event);
    const posted = await withTenant(db, H.W.scope(), (tx) =>
      deliverPayrollGlEvent(H.W.scope(), event, tx, new Date()),
    );
    await H.markDelivered(claim);
    expect(posted.status, "premise: the journal is posted").toBe("posted");
    expect(await H.glBalance(), "premise: petty cash A is Rp0").toBe(0);
    expect(await H.available(), "premise: nothing available").toBe(0);
    const journalId = await journalIdOf(`payroll-gl:reimbursement:${claim}`);
    const fresh = await H.createCashAccount("1148");
    expect(await glOf(fresh), "premise: N is clean").toBe(0);
    await legacyRemap(H.W.entityId(), tenantId, owner, [["petty_cash", fresh]]);
    const journals = await H.journalCount();

    const reversal = await reverse(journalId);

    expectLocked(reversal);
    expect(await H.journalCount(), "no reversal journal").toBe(journals);
    expect(await H.glBalance(), "GL A stays Rp0").toBe(0);
    expect(await glOf(fresh), "GL N stays Rp0").toBe(0);
    const status = (
      await owner.query<{ status: string }>(
        "SELECT status FROM reimbursements WHERE tenant_id = $1 AND id = $2",
        [tenantId, claim],
      )
    ).rows[0]!.status;
    expect(status).toBe("paid");

    await legacyRemap(H.W.entityId(), tenantId, owner, [
      ["petty_cash", originalPetty],
    ]);
    const second = await H.seedClaim(AMOUNT);
    const res = await H.payClaim(second, AMOUNT);
    if (res.status === 200) leaked.push(second);
    expectGlRefusal(res);
    expect(await H.claimEvents(second)).toBe(0);
    await H.expectNoCashAvailable();
  }, 180_000);
});

// ---- 4. control: unrelated manual journal ------------------------------------------

describe("1147 control: reversals unrelated to cash keep working after a legacy bank/petty_cash swap", () => {
  it("[1147-control-manual-journal-reversal-after-remap] after legacy rows bank B->D and petty_cash A->B, reversing an unrelated manual journal (Dr 6110 / Cr 2103, no cash-out key, no cash account) still succeeds and posts exactly one reversal journal", async () => {
    await H.drain();
    const snapshot: Record<string, string> = {};
    for (const mapping of await H.listMappings())
      snapshot[mapping.role] = mapping.accountId;
    const original = await seedJournal({
      key: `manual-1147-${randomUUID()}`,
      sourceType: "manual",
      debitAccountId: await H.accountId("6110"),
      creditAccountId: await H.accountId("2103"),
      amount: 5_000,
      snapshot,
    });
    const cleanD = await H.createCashAccount("1147");
    await legacyRemap(H.W.entityId(), tenantId, owner, [
      ["bank", cleanD],
      ["petty_cash", originalBank],
    ]);
    const journals = await H.journalCount();
    const cashBefore = await glOf(originalBank);

    const reversal = await reverse(original);

    expect([200, 201], JSON.stringify(reversal.body)).toContain(
      reversal.status,
    );
    expect(
      (reversal.body.data as { reversalOf?: string } | undefined)?.reversalOf,
    ).toBe(original);
    expect(await H.journalCount(), "one reversal journal").toBe(journals + 1);
    expect(await glOf(originalBank), "cash account untouched").toBe(cashBefore);
  }, 180_000);
});

// ---- 2. supplier payment paid from bank B -----------------------------------------

const PAYABLE = 100_000;

type Supplier = {
  world: AparWorld;
  petty: string;
  bank: string;
  spare: string;
  buyer: AparSession;
  warehouse: AparSession;
  finance: AparSession;
  approver: AparSession;
};

/** A tenant whose petty_cash role is account A and whose bank role is a different account B. */
async function setupSupplier(label: string): Promise<Supplier> {
  const world = await createWorld(label);
  const cashAccount = async (code: string, name: string) =>
    (
      await aparOwner.query<{ id: string }>(
        `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
         VALUES ($1, $2, $3, $4, 'asset', 'cash_and_equivalents') RETURNING id`,
        [world.tenantId, world.entityId, code, name],
      )
    ).rows[0]!.id;
  const petty = await cashAccount("1102", "Kas Kecil");
  const bankAccount = await cashAccount("1103", "Bank Operasional");
  const spare = await cashAccount("1105", "Bank Baru");
  for (const [role, account] of [
    ["petty_cash", petty],
    ["bank", bankAccount],
  ] as const)
    await aparOwner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [world.tenantId, world.entityId, role, account],
    );
  const template = ROLE_TEMPLATES.find((t) => t.key === "general_manager")!;
  const approverRoleId = randomUUID();
  await aparOwner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Uji general manager 1147', false, NULL, $3, false, $4)`,
    [
      approverRoleId,
      world.tenantId,
      JSON.stringify(template.permissions),
      JSON.stringify(["tenant", "brand", "outlet", "station"]),
    ],
  );
  const approverUser = await addUser(world, `${label} approver`, []);
  await aparOwner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
    [world.tenantId, approverUser.userId, approverRoleId],
  );
  // Every supplier payment needs approval (limit 0), by a different person.
  await aparOwner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
     VALUES ($1, 'supplier_payment', 0, $2, 1, true)`,
    [world.tenantId, approverRoleId],
  );
  return {
    world,
    petty,
    bank: bankAccount,
    spare,
    approver: approverUser,
    buyer: await addUser(world, `${label} buyer`, [
      { role: "purchasing", outletId: world.outletId },
    ]),
    warehouse: await addUser(world, `${label} warehouse`, [
      { role: "warehouse", outletId: world.outletId },
    ]),
    finance: await addUser(world, `${label} finance`, [
      { role: "finance", outletId: null },
    ]),
  };
}

/** Puts cash on bank B by a seeded journal (setup only). */
async function fundBank(t: Supplier, amountIdr: number) {
  const client = await aparOwner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const period = (
      await client.query<{ id: string }>(
        "SELECT id FROM fiscal_periods WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = $3",
        [t.world.tenantId, t.world.entityId, aparToday().slice(0, 7)],
      )
    ).rows[0]!.id;
    const entry = (
      await client.query<{ id: string }>(
        `INSERT INTO journal_entries
           (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
            source_id, description, idempotency_key, request_fingerprint)
         VALUES ($1, $2, $3, $4, 'sale', NULL, 'Saldo bank uji 1147', $5, $6)
         RETURNING id`,
        [
          t.world.tenantId,
          t.world.entityId,
          aparToday(),
          period,
          `fund-1147-${randomUUID()}`,
          randomBytes(32).toString("hex"),
        ],
      )
    ).rows[0]!.id;
    await client.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
       VALUES ($1, $2, $3, 1, $5, 0), ($1, $2, $4, 2, 0, $5)`,
      [
        t.world.tenantId,
        entry,
        t.bank,
        t.world.accounts.service_expense,
        amountIdr,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function supplierGl(t: Supplier, accountId: string): Promise<number> {
  const { rows } = await aparOwner.query<{ balance: string }>(
    `SELECT coalesce(sum(debit_idr - credit_idr), 0)::text AS balance
       FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
    [t.world.tenantId, accountId],
  );
  return Number(rows[0]!.balance);
}

async function supplierJournalIds(t: Supplier): Promise<string[]> {
  const { rows } = await aparOwner.query<{ id: string }>(
    "SELECT id FROM journal_entries WHERE tenant_id = $1 AND source_type = 'supplier_payment'",
    [t.world.tenantId],
  );
  return rows.map((row) => row.id);
}

async function totalJournalCount(t: Supplier): Promise<number> {
  const { rows } = await aparOwner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1",
    [t.world.tenantId],
  );
  return Number(rows[0]!.n);
}

async function payableOutstanding(t: Supplier, invoiceId: string) {
  const { rows } = await aparOwner.query<{ outstanding: string }>(
    `SELECT (original_idr - settled_idr)::text AS outstanding
       FROM accounting_open_items
      WHERE tenant_id = $1 AND kind = 'payable' AND id = $2`,
    [t.world.tenantId, invoiceId],
  );
  return Number(rows[0]!.outstanding);
}

async function supplierInvoice(t: Supplier): Promise<string> {
  const po = await receive(t.world, t.warehouse, await seedPo(t.world));
  const res = await createInvoice(t.world, t.buyer, invoiceBody(t.world, po));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return invoiceIdOf(res);
}

/** Requests the payment, lets the second person approve, applies the decision; returns the final status. */
async function payViaSecondPerson(
  t: Supplier,
  invoiceId: string,
  amountIdr: number,
): Promise<string> {
  const res = await api.post(
    t.world,
    t.finance,
    `/supplier-invoices/${invoiceId}/payments`,
    { amountIdr, paidOn: aparToday(), idempotencyKey: `k-${randomUUID()}` },
  );
  expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
  const data = (res.body as { data: { id: string; status: string } }).data;
  expect(data.status).toBe("pending_approval");
  const chainId = (
    await aparOwner.query<{ approval_chain_id: string }>(
      "SELECT approval_chain_id FROM supplier_payments WHERE tenant_id = $1 AND id = $2",
      [t.world.tenantId, data.id],
    )
  ).rows[0]!.approval_chain_id;
  expect(chainId).toBeTruthy();
  const context = establishTenantContext({
    tenantId: tenantIdSchema.parse(t.world.tenantId),
    brandId: null,
    source: "domain",
  });
  await decideApprovalRequest(
    context,
    t.approver.userId,
    chainId,
    { decision: "approved", reason: "Sesuai tagihan dan bukti pemasok." },
    { mfaVerified: true, idempotencyKey: null },
  );
  const { rows } = await aparOwner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND destination = 'cloud-sync'
        AND event->>'name' = 'approval.resolved'
        AND event->'payload'->>'chainId' = $2`,
    [t.world.tenantId, chainId],
  );
  expect(rows).toHaveLength(1);
  await handlePurchasingApprovalResolved(
    contextFor(t.world, null),
    approvalResolvedEvent.envelopeSchema.parse(rows[0]!.event),
  );
  return (
    await aparOwner.query<{ status: string }>(
      "SELECT status FROM supplier_payments WHERE tenant_id = $1 AND id = $2",
      [t.world.tenantId, data.id],
    )
  ).rows[0]!.status;
}

describe("1147 P1-1 reversal of a supplier payment paid from bank B after a legacy bank/petty_cash swap", () => {
  beforeAll(() => {
    setAuditWriter(coreAuditWriter);
    setPurchaseReturnPostingEnabled(true);
    setSupplierInvoicePostingEnabled(true);
  });

  afterAll(async () => {
    setSupplierInvoicePostingEnabled(null);
    setPurchaseReturnPostingEnabled(null);
    await aparPool.end();
    await aparOwner.end();
  });

  it("[1147-supplier-bank-reversal-remap-409] supplier payment of Rp60.000 paid from bank B (petty_cash A), then legacy rows bank B->D and petty_cash A->B: the reversal is refused 409 CASH_OUT_JOURNAL_LOCKED while the payment is paid, no reversal journal, GL B stays Rp0, the payable stays paid down, and after bank returns to B (shared with petty cash) the next payment of the invoice stays pending_approval", async () => {
    const t = await setupSupplier("1147-s1");
    await fundBank(t, 60_000);
    const invoiceId = await supplierInvoice(t);
    expect(await payViaSecondPerson(t, invoiceId, 60_000)).toBe("paid");
    expect(await supplierGl(t, t.bank), "premise: bank B is Rp0").toBe(0);
    expect(await supplierGl(t, t.petty), "premise: petty cash A is Rp0").toBe(
      0,
    );
    const [journalId, ...rest] = await supplierJournalIds(t);
    expect(journalId, "premise: one supplier payment journal").toBeDefined();
    expect(rest).toHaveLength(0);
    await legacyRemap(t.world.entityId, t.world.tenantId, aparOwner, [
      ["bank", t.spare],
      ["petty_cash", t.bank],
    ]);
    const journals = await totalJournalCount(t);

    const reversal = (await t.finance.client
      .post(`/api/accounting/journals/${journalId}/reversal`)
      .set(originHeader)
      .set("Host", t.world.hostname)
      .send({
        entryDate: aparToday(),
        reason: "Koreksi uji 1147 P1-1",
        idempotencyKey: key(),
      })) as Res;

    expectLocked(reversal);
    expect(await totalJournalCount(t), "no reversal journal").toBe(journals);
    expect(await supplierGl(t, t.bank), "GL B (petty cash) stays Rp0").toBe(0);
    expect(await payableOutstanding(t, invoiceId)).toBe(PAYABLE - 60_000);

    // Bank back on B, petty cash stays on B: the supplier cash cover guard
    // (bank credit covered by the petty cash account) now reads GL B.
    await legacyRemap(t.world.entityId, t.world.tenantId, aparOwner, [
      ["bank", t.bank],
    ]);
    expect(await payViaSecondPerson(t, invoiceId, 40_000)).toBe(
      "pending_approval",
    );
    expect(await supplierGl(t, t.bank), "bank B never positive").toBe(0);
    expect(await payableOutstanding(t, invoiceId)).toBe(PAYABLE - 60_000);
    expect(await totalJournalCount(t), "no new journal").toBe(journals);
  }, 240_000);
});
