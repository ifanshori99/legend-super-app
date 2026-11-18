// legend-1089 round 5, finding P1 #2 (scratchpad so-1089.md): a MANUAL reversal
// of an automatic cash-out journal whose source is still paid re-opens GL 1102
// without any cash coming back. Written fail-first from the brief (section R2)
// and the finding's scenario, the founder rule "GL 1102 never goes negative,
// nobody is paid when the cash is not there", and the public HTTP / service
// surface, NOT from the service code.
//
// Scenario (finding): fund 1102 Rp100.000, disburse a cash kasbon A of
// Rp100.000 and deliver its outbox event to the GL (Dr 1204 / Cr 1102, key
// `payroll-gl:loan:<A>`): GL 1102 and available cash are Rp0. Finance reverses
// that journal through POST /api/accounting/journals/:id/reversal. Expected:
// refused 409 CASH_OUT_JOURNAL_LOCKED, no reversal journal, GL 1102 still Rp0,
// available still Rp0, and a second kasbon B of Rp100.000 is refused 422
// PETTY_CASH_GL_INSUFFICIENT. The same lock covers the other automatic
// cash-out journals whose source is still paid: a cash reimbursement
// (`payroll-gl:reimbursement:<id>`), the settle journal of a cash payroll
// handover (posting.journal_key, `payroll-payout:<hash>`) and a supplier
// payment (source_type `supplier_payment`).
//
// Controls (must keep working): reversal of an unrelated manual journal; a
// SYSTEM reversal (postedBy null, like the sale void / refund consumers) of the
// same kasbon journal, because it records money that really moved.
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - Refusal is HTTP 409 with error code CASH_OUT_JOURNAL_LOCKED (brief B) and a
//   non-empty message. The reversal body is { entryDate, reason, idempotencyKey }
//   (shared reverseJournalInputSchema, as the 5qqb9 waive test uses).
// - Success of the control reversal is 200 or 201 (not pinned).
// - Available cash = GL 1102 minus the net of approved cash batches that are not
//   handed over minus the kasbon / claims that still have a pending outbox event
//   (same definition as the swn0m test). Every test starts from `drain()`, so
//   the baseline is exactly 0.
// - "Reversal allowed once the source is no longer paid" (loan cancelled /
//   returned) is NOT covered: the spec gives no public way to bring a paid
//   kasbon / claim / payment back to a not-paid state, so it would need guessed
//   status values.
// - `payroll.reversed` as a system reversal is covered only by the generic
//   system-reversal control (postedBy null), not by driving the payroll
//   reversal consumer.
// - Supplier payment is tested on a bank role mapped to the 1102 account, with
//   a partial payment (Rp60.000 of Rp100.000) so the retry runs on the same
//   invoice: the retry of Rp40.000 must stay pending_approval (refused, parked)
//   because the reversal did not re-open cash.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_TEMPLATES } from "@starter/shared/access";
import { tenantIdSchema } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import {
  employeeLoanDisbursed,
  reimbursementPaid,
} from "@starter/shared/hris/payroll";
import { approvalResolvedEvent } from "@starter/shared/identity";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { reverseJournalInTransaction } from "../services/accounting-journal.service.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { deliverPayrollGlEvent } from "../services/payroll-gl-consumer.ts";
import {
  approveDisbursementBatch,
  submitDisbursementBatch,
} from "../services/payroll-payout.service.ts";
import { decideApprovalRequest } from "../services/platform-approval.service.ts";
import { handlePurchasingApprovalResolved } from "../services/purchasing-approval-consumer.ts";
import { setPurchaseReturnPostingEnabled } from "../services/purchase-return.service.ts";
import { setSupplierInvoicePostingEnabled } from "../services/purchasing-invoice.service.ts";
import { originHeader } from "./helpers.ts";
import { withLimitSharedLock } from "./helpers/cash-limit-lock.ts";
import {
  closeKit,
  daysAgo,
  key,
  owner as kitOwner,
  signedIn,
  tenantId,
  type Session,
} from "./helpers/cash-bank-world.ts";
import {
  APP,
  CASHIER,
  REQ,
  actorOf,
  cash,
  installPayoutWorld,
} from "./payroll-payout-fixtures.ts";
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
  type Session as AparSession,
  type World as AparWorld,
} from "./purchasing-apar-helpers.ts";

const app = createApp();
const LOANS = "/api/hris/payroll/loans";
const CLAIMS = "/api/hris/payroll/reimbursements";
const LOCKED = "CASH_OUT_JOURNAL_LOCKED";
const GL_REFUSAL = "PETTY_CASH_GL_INSUFFICIENT";
const AMOUNT = 100_000;
/** The person who approved the kasbon / claim (a user id is a UUID). */
const DECIDER = randomUUID();
const W = installPayoutWorld("1089r2");
const fixtureOutlet = cafeLegendPlatformFixtures.outlets[0];

let finance: Session;
let hr: Session;
let approver: Session;
let pettyGlId: string;
let categoryId: string;
const employeeIds: string[] = [];
const loanIds: string[] = [];
const claimIds: string[] = [];
/** Net of the cash batches approved here and not handed over. */
let committed = 0;
/** Amount of every kasbon / claim paid here whose outbox event may still be pending, by id. */
const paidAmounts = new Map<string, number>();

withLimitSharedLock();

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  finance = await signedIn(app, "1089r2 finance", [
    { role: "finance", outletId: null },
  ]);
  const gl = await kitOwner.query<{ id: string }>(
    "SELECT id FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '1102'",
    [tenantId, W.entityId()],
  );
  pettyGlId = gl.rows[0]!.id;
  const hrUser = await W.signedInClient("1089r2 HR");
  await W.grantRole(hrUser.userId, [
    "hr.employee.manage",
    "hr.employee.view",
    "hr.loan.approve",
    "payroll.view",
  ]);
  hr = hrUser;
  const approverUser = await W.signedInClient("1089r2 reimbursement approver");
  await W.grantRole(approverUser.userId, ["hr.reimbursement.approve"]);
  approver = approverUser;
  categoryId = randomUUID();
  await kitOwner.query(
    `INSERT INTO reimbursement_categories (id, tenant_id, name, receipt_required, limits)
     VALUES ($1, $2, 'Kategori 1089r2', false, $3)`,
    [
      categoryId,
      tenantId,
      JSON.stringify([
        {
          positionId: null,
          perClaimLimitIdr: 500_000_000,
          perMonthLimitIdr: null,
        },
      ]),
    ],
  );
});

afterAll(async () => {
  // Runs before the payout world's own cleanup (hooks run in reverse order).
  const client = await kitOwner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const ids = [...loanIds, ...claimIds];
    await client.query(
      "DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND event::text LIKE ANY (SELECT '%' || r || '%' FROM unnest($2::text[]) r)",
      [tenantId, ids],
    );
    await client.query(
      "DELETE FROM employee_loans WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantId, loanIds],
    );
    await client.query(
      "DELETE FROM reimbursements WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantId, claimIds],
    );
    await client.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantId, employeeIds],
    );
    await client.query(
      "DELETE FROM reimbursement_categories WHERE tenant_id = $1 AND id = $2",
      [tenantId, categoryId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  await closeKit();
});

// ---- cash helpers (same definitions as cash-1102-sync-guard-swn0m) -------------

/** Debit minus credit of GL 1102 of the payout world's entity. */
async function glBalance(): Promise<number> {
  const { rows } = await kitOwner.query<{ balance: string }>(
    `SELECT coalesce(sum(l.debit_idr - l.credit_idr), 0)::text AS balance
       FROM journal_lines l
       JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
      WHERE l.tenant_id = $1 AND e.legal_entity_id = $2 AND l.account_id = $3`,
    [tenantId, W.entityId(), pettyGlId],
  );
  return Number(rows[0]!.balance);
}

/** Sum of the kasbon / claims paid here that still have a pending event. */
async function pendingOfPaid(): Promise<number> {
  const ids = [...paidAmounts.keys()];
  if (ids.length === 0) return 0;
  const { rows } = await kitOwner.query<{ id: string }>(
    `SELECT r AS id FROM unnest($2::text[]) r
      WHERE EXISTS (SELECT 1 FROM domain_event_outbox
                     WHERE tenant_id = $1
                       AND status = 'pending'
                       AND event->>'name' IN ('employee_loan.disbursed', 'reimbursement.paid')
                       AND event::text LIKE '%' || r || '%')`,
    [tenantId, ids],
  );
  return rows.reduce((sum, row) => sum + paidAmounts.get(row.id)!, 0);
}

/** GL 1102 minus the approved cash payroll and what was paid here and not yet booked. */
const available = async () =>
  (await glBalance()) - committed - (await pendingOfPaid());

async function journalCount(): Promise<number> {
  const { rows } = await kitOwner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    [tenantId, W.entityId()],
  );
  return Number(rows[0]!.n);
}

type Pending = { batchId: string; hash: string; net: number; runId: string };

/** A cash batch of one slip, submitted and waiting for approval. */
async function pendingBatch(net: number): Promise<Pending> {
  const slips = [cash(CASHIER, net)];
  const runId = await W.seedRun(slips);
  const batchId = await W.createBatch(runId, "cash");
  await W.inTx((tx) => submitDisbursementBatch(tx, actorOf(REQ), batchId));
  const hash = (await W.batchById(batchId)).content_hash as string;
  return { batchId, hash, net, runId };
}

/** Approves a pending cash batch; null on success, the thrown error otherwise. */
const tryApprove = (batch: Pending) =>
  W.httpFailure(
    W.inTx((tx) =>
      approveDisbursementBatch(tx, actorOf(APP), batch.batchId, {
        contentHash: batch.hash,
        sourceBankAccountId: null,
      } as never),
    ),
  );

/** Approves a cash batch that must pass: it is the reserve of a cash payroll. */
async function reserve(net: number) {
  const failure = await tryApprove(await pendingBatch(net));
  expect(failure, "the reserve batch is approved").toBeNull();
  committed += net;
}

/** Approves one exact batch for all available cash: the baseline becomes 0. */
async function drain() {
  const avail = await available();
  expect(
    avail,
    "available cash is never negative between tests",
  ).toBeGreaterThanOrEqual(0);
  if (avail > 0) await reserve(avail);
  expect(await available(), "baseline is zero").toBe(0);
}

/** Puts cash into 1102 by a seeded journal (setup only). */
const addCash = (amountIdr: number) => W.fundPettyCash(amountIdr);

type Res = {
  status: number;
  body: { error?: { code?: string; message?: string }; data?: unknown };
};

/** The refusal of the 1102 cover guard: 422 naming the code. */
function expectGlRefusal(res: Res) {
  const detail = JSON.stringify(res.body);
  expect(res.status, detail).toBe(422);
  expect(res.body.error?.code, detail).toBe(GL_REFUSAL);
}

/** The refusal of this feature: 409 CASH_OUT_JOURNAL_LOCKED with a message. */
function expectLocked(res: Res) {
  const detail = JSON.stringify(res.body);
  expect(res.status, detail).toBe(409);
  expect(res.body.error?.code, detail).toBe(LOCKED);
  expect(String(res.body.error?.message ?? ""), "a message").not.toBe("");
}

// ---- employees, kasbon, reimbursements --------------------------------------------

/** An employee of the payout entity without a bank account: paid in cash. */
async function makeEmployee() {
  const id = randomUUID();
  employeeIds.push(id);
  await kitOwner.query(
    `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                            legal_entity_id, employment_type, join_date, status)
     VALUES ($1, $2, $3, 'Karyawan 1089r2', $4, $5, 'pkwtt', '2025-03-01', 'active')`,
    [
      id,
      tenantId,
      `R2-${id.slice(0, 8).toUpperCase()}`,
      fixtureOutlet.id,
      W.entityId(),
    ],
  );
  return id;
}

/** An `approved` kasbon waiting for its disbursement. */
async function seedLoan(employeeId: string, principal: number) {
  const id = randomUUID();
  loanIds.push(id);
  await kitOwner.query(
    `INSERT INTO employee_loans
       (id, tenant_id, employee_id, principal_idr, installment_idr, installment_count,
        outstanding_idr, first_deduction_period, reason, status, decided_by, decided_at)
     VALUES ($1, $2, $3, $4, $5, 10, $4, '2026-12-01', 'Kasbon uji 1089r2', 'approved', $6, now())`,
    [id, tenantId, employeeId, principal, Math.ceil(principal / 10), DECIDER],
  );
  return id;
}

/** Disburses over HTTP; the response is returned as is. */
async function disburse(loanId: string, principal: number): Promise<Res> {
  const res = await hr.client
    .post(`${LOANS}/${loanId}/disburse`)
    .set(originHeader)
    .send({ idempotencyKey: `payout-gl-1089r2-${randomUUID()}` });
  if (res.status === 200) paidAmounts.set(loanId, principal);
  return res;
}

async function eventCount(name: string, id: string) {
  const { rows } = await kitOwner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = $2 AND event::text LIKE '%' || $3 || '%'`,
    [tenantId, name, id],
  );
  return Number(rows[0]!.n);
}

async function loanState(loanId: string) {
  const row = (
    await kitOwner.query<{ status: string }>(
      "SELECT status FROM employee_loans WHERE tenant_id = $1 AND id = $2",
      [tenantId, loanId],
    )
  ).rows[0]!;
  return {
    status: row.status,
    events: await eventCount("employee_loan.disbursed", loanId),
  };
}

/** An `approved` cash reimbursement claim waiting to be paid. */
async function seedClaim(employeeId: string, amount: number) {
  const id = randomUUID();
  claimIds.push(id);
  await kitOwner.query(
    `INSERT INTO reimbursements
       (id, tenant_id, employee_id, category_id, expense_date, amount_idr, approved_amount_idr,
        description, payout, status, decided_by, decided_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6, 'Klaim uji 1089r2', 'cash', 'approved', $7, now())`,
    [id, tenantId, employeeId, categoryId, aparToday(), amount, DECIDER],
  );
  return id;
}

async function payClaim(claimId: string, amount: number): Promise<Res> {
  const res = await approver.client
    .post(`${CLAIMS}/${claimId}/pay`)
    .set(originHeader)
    .send({ idempotencyKey: `payout-gl-1089r2-${randomUUID()}` });
  if (res.status === 200) paidAmounts.set(claimId, amount);
  return res;
}

async function claimState(claimId: string) {
  const row = (
    await kitOwner.query<{ status: string }>(
      "SELECT status FROM reimbursements WHERE tenant_id = $1 AND id = $2",
      [tenantId, claimId],
    )
  ).rows[0]!;
  return {
    status: row.status,
    events: await eventCount("reimbursement.paid", claimId),
  };
}

/** The one outbox event of this name for this aggregate, as stored. */
async function outboxEventOf(name: string, id: string): Promise<unknown> {
  const { rows } = await kitOwner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = $2 AND event::text LIKE '%' || $3 || '%'`,
    [tenantId, name, id],
  );
  expect(rows, `exactly one ${name} outbox event`).toHaveLength(1);
  return rows[0]!.event;
}

/** What the worker does after a delivery: the outbox row leaves `pending`. */
async function markDelivered(name: string, id: string) {
  await kitOwner.query(
    `UPDATE domain_event_outbox SET status = 'delivered', delivered_at = now()
      WHERE tenant_id = $1 AND event->>'name' = $2 AND event::text LIKE '%' || $3 || '%'`,
    [tenantId, name, id],
  );
}

/** Delivers an outbox event to the GL consumer the way the worker does. */
function deliverToGl(event: unknown) {
  return withTenant(db, W.scope(), (tx) =>
    deliverPayrollGlEvent(
      W.scope(),
      event as Parameters<typeof deliverPayrollGlEvent>[1],
      tx,
      new Date(),
    ),
  );
}

/** Makes sure the entity maps `role` to its account `code` (setup only). */
async function ensureMapping(role: string, code: string) {
  const existing = await kitOwner.query(
    "SELECT 1 FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = $3",
    [tenantId, W.entityId(), role],
  );
  if (existing.rows.length > 0) return;
  const account = await kitOwner.query<{ id: string }>(
    "SELECT id FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = $3",
    [tenantId, W.entityId(), code],
  );
  expect(account.rows, `premise: account ${code} exists`).toHaveLength(1);
  await kitOwner.query(
    `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
     VALUES ($1, $2, $3, $4)`,
    [tenantId, W.entityId(), role, account.rows[0]!.id],
  );
}

// ---- journals and the manual reversal -----------------------------------------------

/** Id of the journal under this idempotency key (exactly one must exist). */
async function journalIdOf(idempotencyKey: string): Promise<string> {
  const { rows } = await kitOwner.query<{ id: string }>(
    "SELECT id FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2 AND idempotency_key = $3",
    [tenantId, W.entityId(), idempotencyKey],
  );
  expect(rows, `premise: one journal under ${idempotencyKey}`).toHaveLength(1);
  return rows[0]!.id;
}

/** Finance reverses a journal through the manual endpoint. */
async function reverseManually(journalId: string): Promise<Res> {
  const res = await finance.client
    .post(`/api/accounting/journals/${journalId}/reversal`)
    .set(originHeader)
    .send({
      entryDate: daysAgo(0),
      reason: "Koreksi uji 1089 R2",
      idempotencyKey: key(),
    });
  return res as Res;
}

/** A disbursed cash kasbon whose event was delivered to the GL: GL 1102 and available are 0. */
async function bookedLoan(principal: number) {
  await drain();
  await addCash(principal);
  await ensureMapping("employee_receivable", "1204");
  const loan = await seedLoan(await makeEmployee(), principal);
  const paid = await disburse(loan, principal);
  expect(paid.status, JSON.stringify(paid.body)).toBe(200);
  const event = employeeLoanDisbursed.envelopeSchema.parse(
    await outboxEventOf("employee_loan.disbursed", loan),
  );
  const posted = await deliverToGl(event);
  await markDelivered("employee_loan.disbursed", loan);
  paidAmounts.delete(loan);
  expect(posted.status, "premise: the journal is posted").toBe("posted");
  const journalKey = `payroll-gl:loan:${loan}`;
  expect(await glBalance(), "premise: 1102 is empty").toBe(0);
  expect(await available(), "premise: nothing available").toBe(0);
  return { loan, journalKey, journalId: await journalIdOf(journalKey) };
}

// ---- 1. kasbon -------------------------------------------------------------------------

describe("1089 R2 manual reversal of a paid cash kasbon journal", () => {
  it("[1089-r2-loan-reversal-locked-409] reversing the journal of a disbursed cash kasbon is refused 409 CASH_OUT_JOURNAL_LOCKED: no reversal journal, GL 1102 and available stay Rp0, the kasbon stays disbursed, and a second kasbon of the same amount is refused 422 PETTY_CASH_GL_INSUFFICIENT", async () => {
    const { loan, journalKey, journalId } = await bookedLoan(AMOUNT);
    const journals = await journalCount();

    const reversal = await reverseManually(journalId);

    expectLocked(reversal);
    expect(await journalCount(), "no reversal journal").toBe(journals);
    expect(await glBalance(), "GL 1102 unchanged").toBe(0);
    expect(await available(), "available unchanged").toBe(0);
    expect((await loanState(loan)).status).toBe("disbursed");
    expect(await journalIdOf(journalKey), "original journal intact").toBe(
      journalId,
    );

    const other = await seedLoan(await makeEmployee(), AMOUNT);
    expectGlRefusal(await disburse(other, AMOUNT));
    expect(await loanState(other)).toEqual({ status: "approved", events: 0 });
    expect(await journalCount(), "no new journal").toBe(journals);
  }, 120_000);
});

// ---- 2. cash reimbursement ----------------------------------------------------------------

describe("1089 R2 manual reversal of a paid cash reimbursement journal", () => {
  it("[1089-r2-reimbursement-reversal-locked-409] reversing the journal of a paid cash claim is refused 409 CASH_OUT_JOURNAL_LOCKED: no reversal journal, GL 1102 and available stay Rp0, the claim stays paid, and a second claim of the same amount is refused 422", async () => {
    await drain();
    await addCash(AMOUNT);
    const claim = await seedClaim(await makeEmployee(), AMOUNT);
    const paid = await payClaim(claim, AMOUNT);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const event = reimbursementPaid.envelopeSchema.parse(
      await outboxEventOf("reimbursement.paid", claim),
    );
    const posted = await deliverToGl(event);
    await markDelivered("reimbursement.paid", claim);
    paidAmounts.delete(claim);
    expect(posted.status, "premise: the journal is posted").toBe("posted");
    expect(await glBalance(), "premise: 1102 is empty").toBe(0);
    expect(await available(), "premise: nothing available").toBe(0);
    const journalId = await journalIdOf(`payroll-gl:reimbursement:${claim}`);
    const journals = await journalCount();

    const reversal = await reverseManually(journalId);

    expectLocked(reversal);
    expect(await journalCount(), "no reversal journal").toBe(journals);
    expect(await glBalance(), "GL 1102 unchanged").toBe(0);
    expect(await available(), "available unchanged").toBe(0);
    expect((await claimState(claim)).status).toBe("paid");

    const other = await seedClaim(await makeEmployee(), AMOUNT);
    expectGlRefusal(await payClaim(other, AMOUNT));
    expect(await claimState(other)).toEqual({ status: "approved", events: 0 });
    expect(await journalCount(), "no new journal").toBe(journals);
  }, 120_000);
});

// ---- 3. cash payroll handover ----------------------------------------------------------------

describe("1089 R2 manual reversal of the settle journal of a cash payroll handover", () => {
  it("[1089-r2-payroll-settle-reversal-locked-409] reversing the settle journal of a cash batch that was handed over is refused 409 CASH_OUT_JOURNAL_LOCKED: no reversal journal, GL 1102 stays Rp0, and a new cash batch of the same net is refused at approval (409 PAYOUT_CASH_INSUFFICIENT)", async () => {
    await drain();
    const slips = [cash(CASHIER, AMOUNT)];
    const runId = await W.seedRun(slips);
    await W.postLockedJournal(runId, slips);
    await addCash(AMOUNT);
    const batchId = await W.approvedBatch(runId, "cash");
    const itemIds = (await W.itemsOf(batchId)).map((i) => i.id as string);
    await W.handover(batchId, itemIds);
    const postings = await W.postingsOf(batchId);
    expect(postings, "premise: one posting").toHaveLength(1);
    expect(postings[0]!.kind, "premise: settled").toBe("settle");
    expect(await glBalance(), "premise: 1102 is empty").toBe(0);
    expect(await available(), "premise: nothing available").toBe(0);
    const journalId = await journalIdOf(postings[0]!.journal_key as string);
    const journals = await journalCount();

    const reversal = await reverseManually(journalId);

    expectLocked(reversal);
    expect(await journalCount(), "no reversal journal").toBe(journals);
    expect(await glBalance(), "GL 1102 unchanged").toBe(0);
    expect(await available(), "available unchanged").toBe(0);
    expect((await W.postingsOf(batchId))[0]!.kind).toBe("settle");

    const next = await pendingBatch(AMOUNT);
    const failure = await tryApprove(next);
    expect(failure, "the new batch must be refused").not.toBeNull();
    expect(failure!.status).toBe(409);
    expect(failure!.code).toBe("PAYOUT_CASH_INSUFFICIENT");
    expect((await W.batchById(next.batchId)).status).toBe("pending_approval");
  }, 120_000);
});

// ---- 3b. other journals that credit 1102 (default refusal) ----------------------------------

describe("1089 R2 manual reversal of any other journal that credits the current 1102 account", () => {
  it("[1089-r2-petty-purchase-reversal-locked-409] reversing the journal of a petty purchase (source_type petty_purchase, Dr 6101 / Cr 1102) is refused 409 CASH_OUT_JOURNAL_LOCKED: no reversal journal, GL 1102 stays Rp0, and a kasbon of the same amount is refused 422 PETTY_CASH_GL_INSUFFICIENT", async () => {
    await drain();
    await addCash(AMOUNT);
    const journalId = await seedJournal(AMOUNT, {
      sourceType: "petty_purchase",
      key: `r2-petty-purchase-${randomUUID()}`,
      debitCode: "6101",
      creditCode: "1102",
    });
    expect(await glBalance(), "premise: 1102 is empty").toBe(0);
    expect(await available(), "premise: nothing available").toBe(0);
    const journals = await journalCount();

    const reversal = await reverseManually(journalId);

    expectLocked(reversal);
    expect(await journalCount(), "no reversal journal").toBe(journals);
    expect(await glBalance(), "GL 1102 unchanged").toBe(0);
    expect(await available(), "available unchanged").toBe(0);

    await ensureMapping("employee_receivable", "1204");
    const other = await seedLoan(await makeEmployee(), AMOUNT);
    expectGlRefusal(await disburse(other, AMOUNT));
    expect(await loanState(other)).toEqual({ status: "approved", events: 0 });
    expect(await journalCount(), "no new journal").toBe(journals);
  }, 120_000);

  it("[1089-r2-petty-return-journal-reversal-locked-409] reversing a petty cash return journal (source_type petty_cash_return, key pc:<entryId>, Dr 1103 / Cr 1102) is refused 409 CASH_OUT_JOURNAL_LOCKED: no reversal journal, GL 1102 stays Rp0", async () => {
    await drain();
    await addCash(AMOUNT);
    const journalId = await seedJournal(AMOUNT, {
      sourceType: "petty_cash_return",
      key: `pc:${randomUUID()}`,
      debitCode: "1103",
      creditCode: "1102",
    });
    expect(await glBalance(), "premise: 1102 is empty").toBe(0);
    const journals = await journalCount();

    const reversal = await reverseManually(journalId);

    expectLocked(reversal);
    expect(await journalCount(), "no reversal journal").toBe(journals);
    expect(await glBalance(), "GL 1102 unchanged").toBe(0);
    expect(await available(), "available unchanged").toBe(0);
  }, 120_000);
});

// ---- 4. controls ----------------------------------------------------------------------------

describe("1089 R2 controls: reversals that must keep working", () => {
  it("[1089-r2-control-unrelated-manual-journal-reversal-works] reversing an unrelated manual journal (no cash-out source, 1102 untouched) still posts one reversal journal", async () => {
    await drain();
    const original = await seedManualJournal(5_000);
    const journals = await journalCount();

    const reversal = await reverseManually(original);

    expect([200, 201], JSON.stringify(reversal.body)).toContain(
      reversal.status,
    );
    expect(
      (reversal.body.data as { reversalOf?: string } | undefined)?.reversalOf,
    ).toBe(original);
    expect(await journalCount(), "one reversal journal").toBe(journals + 1);
    expect(await glBalance(), "1102 untouched").toBe(0);
  }, 120_000);

  it("[1089-r2-control-system-reversal-of-loan-journal-posts] a system reversal (postedBy null, like the sale void and refund consumers) of the same paid kasbon journal still posts: the cash really moved, so GL 1102 is re-credited", async () => {
    const { journalId } = await bookedLoan(AMOUNT);
    const journals = await journalCount();

    const entry = await withTenant(db, W.scope(), (tx) =>
      reverseJournalInTransaction(
        tx,
        W.scope(),
        journalId,
        {
          entryDate: daysAgo(0) as never,
          reason: "Void sistem uji 1089 R2",
          idempotencyKey: `aj-void-${randomUUID()}`,
          postedBy: null,
        },
        new Date(),
      ),
    );

    expect(entry.reversalOf).toBe(journalId);
    expect(await journalCount(), "one reversal journal").toBe(journals + 1);
    expect(await glBalance(), "1102 re-credited by the system reversal").toBe(
      AMOUNT,
    );
  }, 120_000);
});

type SeedShape = {
  sourceType: string;
  key: string;
  debitCode: string;
  creditCode: string;
};

/** A balanced journal of source `manual` (Dr 1103 / Cr 6101-class expense), seeded by SQL; returns its id. */
const seedManualJournal = (amountIdr: number) =>
  seedJournal(amountIdr, {
    sourceType: "manual",
    key: `r2-manual-${randomUUID()}`,
    debitCode: "1103",
    creditCode: "6101",
  });

/** A balanced journal of the given shape, seeded by SQL (setup only); returns its id. */
async function seedJournal(
  amountIdr: number,
  shape: SeedShape,
): Promise<string> {
  const client = await kitOwner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const code = async (c: string) =>
      (
        await client.query<{ id: string }>(
          "SELECT id FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = $3",
          [tenantId, W.entityId(), c],
        )
      ).rows[0]!.id;
    const date = daysAgo(0);
    const period = (
      await client.query<{ id: string }>(
        "SELECT id FROM fiscal_periods WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = $3",
        [tenantId, W.entityId(), date.slice(0, 7)],
      )
    ).rows[0]!.id;
    const entry = (
      await client.query<{ id: string }>(
        `INSERT INTO journal_entries
           (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
            source_id, description, idempotency_key, request_fingerprint)
         VALUES ($1, $2, $3, $4, $7, NULL, 'Jurnal uji 1089 R2', $5, $6)
         RETURNING id`,
        [
          tenantId,
          W.entityId(),
          date,
          period,
          shape.key,
          randomBytes(32).toString("hex"),
          shape.sourceType,
        ],
      )
    ).rows[0]!.id;
    await client.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
       VALUES ($1, $2, $3, 1, $5, 0), ($1, $2, $4, 2, 0, $5)`,
      [
        tenantId,
        entry,
        await code(shape.debitCode),
        await code(shape.creditCode),
        amountIdr,
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

// ---- 5. supplier payment on a bank account that is GL 1102 -----------------------------------
//
// Own fresh tenant (the purchasing/AP helpers), nothing here touches the payout
// world. The invoice payable is Rp 100.000; every payment waits for a second
// person and is settled by the approval consumer.

const PAYABLE = 100_000;

type Supplier = {
  world: AparWorld;
  pettyId: string;
  buyer: AparSession;
  warehouse: AparSession;
  finance: AparSession;
  approver: AparSession;
};

/** A tenant whose supplier payments credit the `bank` role, mapped to the 1102 account. */
async function setupSupplier(label: string): Promise<Supplier> {
  const world = await createWorld(label);
  const pettyId = (
    await aparOwner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, '1102', 'Kas Kecil', 'asset', 'cash_and_equivalents') RETURNING id`,
      [world.tenantId, world.entityId],
    )
  ).rows[0]!.id;
  for (const role of ["petty_cash", "bank"])
    await aparOwner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [world.tenantId, world.entityId, role, pettyId],
    );
  // The approver role named by the policy: a general manager copy.
  const template = ROLE_TEMPLATES.find((t) => t.key === "general_manager")!;
  const approverRoleId = randomUUID();
  await aparOwner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Uji general manager 1089r2', false, NULL, $3, false, $4)`,
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
    pettyId,
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

/** Puts cash into the tenant's 1102 by a seeded journal (setup only). */
async function fundSupplier1102(t: Supplier, amountIdr: number) {
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
         VALUES ($1, $2, $3, $4, 'sale', NULL, 'Saldo kas kecil uji 1089 R2', $5, $6)
         RETURNING id`,
        [
          t.world.tenantId,
          t.world.entityId,
          aparToday(),
          period,
          `r2-fund-${randomUUID()}`,
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
        t.pettyId,
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

async function supplierGl(t: Supplier): Promise<number> {
  const { rows } = await aparOwner.query<{ balance: string }>(
    `SELECT coalesce(sum(debit_idr - credit_idr), 0)::text AS balance
       FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
    [t.world.tenantId, t.pettyId],
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

/** A matched invoice of Rp 100.000. */
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

describe("1089 R2 manual reversal of a paid supplier payment journal", () => {
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

  it("[1089-r2-supplier-reversal-locked-409] reversing the journal of a paid supplier payment on a 1102 bank account is refused 409 CASH_OUT_JOURNAL_LOCKED: no reversal journal, GL 1102 stays Rp0, the payable stays paid down, and the next payment on the same invoice stays pending_approval (refused for lack of cash)", async () => {
    const t = await setupSupplier("1089r2-s1");
    await fundSupplier1102(t, 60_000);
    const invoiceId = await supplierInvoice(t);
    expect(await payViaSecondPerson(t, invoiceId, 60_000)).toBe("paid");
    expect(await supplierGl(t), "premise: 1102 is empty").toBe(0);
    const [journalId, ...rest] = await supplierJournalIds(t);
    expect(journalId, "premise: one supplier payment journal").toBeDefined();
    expect(rest).toHaveLength(0);
    const journals = await totalJournalCount(t);

    const reversal = (await t.finance.client
      .post(`/api/accounting/journals/${journalId}/reversal`)
      .set(originHeader)
      .set("Host", t.world.hostname)
      .send({
        entryDate: aparToday(),
        reason: "Koreksi uji 1089 R2",
        idempotencyKey: key(),
      })) as Res;

    expectLocked(reversal);
    expect(await totalJournalCount(t), "no reversal journal").toBe(journals);
    expect(await supplierGl(t), "GL 1102 unchanged").toBe(0);
    expect(await payableOutstanding(t, invoiceId)).toBe(PAYABLE - 60_000);

    expect(await payViaSecondPerson(t, invoiceId, 40_000)).toBe(
      "pending_approval",
    );
    expect(await supplierGl(t), "1102 never negative").toBe(0);
    expect(await payableOutstanding(t, invoiceId)).toBe(PAYABLE - 60_000);
    expect(await totalJournalCount(t), "no new journal").toBe(journals);
  }, 180_000);
});
