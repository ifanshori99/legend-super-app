// legend-swn0m: synchronous 1102 (petty cash) cover check on three approve paths:
// a cash kasbon disbursement, a cash reimbursement payment and a supplier payment
// whose bank account is the petty cash account. Written fail-first from the brief
// (scratchpad brief-swn0m.md), the founder rule "GL 1102 never goes negative,
// nobody is paid when the cash is not there", the shared validators and the
// public HTTP / service surface, NOT from the guard code.
//
// Rule: the same rule as a petty purchase. A payment that credits GL 1102 is
// refused PETTY_CASH_GL_INSUFFICIENT (HTTP 422) when its amount is above the
// available 1102 cash: GL 1102 minus every credit that is still waiting (an
// approved cash payroll batch, a pending kasbon / reimbursement / purchase).
// Nothing is paid, nothing is written. The check is skipped when accounting is
// off, when the entity has no petty_cash mapping, and when the credit does not
// land on the petty cash account (a kasbon paid by bank, a supplier payment on
// a bank account that is not 1102).
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - Status of the refusal on HTTP: 422 (brief + shared error table). The
//   message must not be empty; its figures are not pinned.
// - Cash kasbon: the disburse route takes no payment channel; an employee
//   WITHOUT a bank account on file is paid in cash (the 972 kasbon tests rely on
//   the same). A kasbon paid by bank is not covered here: nothing on the public
//   surface lets a test make one, and the pending counter's bank exclusion is
//   pinned by payroll-payout-1053-cash-approve-guard.test.ts.
// - A refused kasbon stays `approved` with no disbursed_at and has no
//   employee_loan.disbursed event; a refused reimbursement stays `approved`,
//   no paid_at and no reimbursement.paid event. Per the brief a successful one
//   leaves a pending outbox event (employee_loan.disbursed / reimbursement.paid)
//   that counts as a pending 1102 credit (nobody delivers outbox events in these
//   tests). Only the two `...-counts-as-pending` tests and the races depend on
//   that event; the other tests keep their bookkeeping right whether or not it
//   is emitted (they count the events that really exist). Reimbursements are
//   seeded with the approved amount equal to the claimed amount, so "the
//   amount" is unambiguous.
// - Available cash = GL 1102 (debit - credit of the payout world's entity)
//   minus the net of cash batches approved here and not handed over
//   (`committed`) minus the pending credits created here: purchases and the
//   kasbon / reimbursements that have a pending outbox event (`spentNow`).
//   Every test starts from `drain()`, which approves one exact cash batch for
//   whatever is available, so the baseline is exactly 0.
// - Supplier payment: the payment waits for a second person (founder Q27), the
//   approval consumer settles it. A refused settle leaves the payment
//   `rejected` with a note that names PETTY_CASH_GL_INSUFFICIENT (brief:
//   `posting_refused:PETTY_CASH_GL_INSUFFICIENT`), no journal, the payable
//   untouched. The "bank role = petty_cash account" setup maps both roles to
//   one 1102 account of a fresh tenant. Its pending reserve is a seeded
//   `payroll.paid` cash outbox event of that entity.
// - Not covered here: accounting-off for the supplier path (the settle itself
//   changes shape when accounting is off, the brief gives no outcome) and a
//   supplier-vs-purchase race (needs two worlds in one entity). The two races
//   below run kasbon and reimbursement against a petty purchase.
// - The race outcome is not fixed (either claimant may win); only invariants
//   are asserted: exactly one of the two gets the cash, the loser gets a
//   business refusal (409 / 422, never 5xx), and GL 1102 never goes below zero.
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
import { deliverPayrollGlEvent } from "../services/payroll-gl-consumer.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { decideApprovalRequest } from "../services/platform-approval.service.ts";
import {
  approveDisbursementBatch,
  submitDisbursementBatch,
} from "../services/payroll-payout.service.ts";
import { handlePurchasingApprovalResolved } from "../services/purchasing-approval-consumer.ts";
import { setPurchaseReturnPostingEnabled } from "../services/purchase-return.service.ts";
import { setSupplierInvoicePostingEnabled } from "../services/purchasing-invoice.service.ts";
import { originHeader } from "./helpers.ts";
import { withLimitSharedLock } from "./helpers/cash-limit-lock.ts";
import {
  closeKit,
  key,
  makeOutlet,
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
const MOVEMENTS = "/api/accounting/petty-cash/movements";
const PURCHASES = "/api/inventory/petty-purchases";
const POLICY = "/api/inventory/petty-purchase-policy";
const LOANS = "/api/hris/payroll/loans";
const CLAIMS = "/api/hris/payroll/reimbursements";
const REFUSAL = "PETTY_CASH_GL_INSUFFICIENT";
/** The person who approved the kasbon / claim (a user id is a UUID). */
const DECIDER = randomUUID();
const W = installPayoutWorld("swn0m");
const fixtureOutlet = cafeLegendPlatformFixtures.outlets[0];

let finance: Session;
let hr: Session;
let approver: Session;
let bankAccountId: string;
let pettyGlId: string;
const outlets: string[] = [];
const photoIds: string[] = [];
const usedKeys: string[] = [];
const employeeIds: string[] = [];
const loanIds: string[] = [];
const claimIds: string[] = [];
let categoryId: string;
/** Net of the cash batches approved here and not handed over or cancelled. */
let committed = 0;
/** Petty purchases recorded here (each leaves a pending outbox event). */
let purchased = 0;
/** Amount of every kasbon / claim paid here, by id. */
const paidAmounts = new Map<string, number>();

withLimitSharedLock();

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  finance = await signedIn(app, "swn0m finance", [
    { role: "finance", outletId: null },
  ]);
  const bankRow = await kitOwner.query<{ id: string }>(
    "SELECT id FROM bank_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 LIMIT 1",
    [tenantId, W.entityId()],
  );
  bankAccountId = bankRow.rows[0]!.id;
  const gl = await kitOwner.query<{ id: string }>(
    "SELECT id FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '1102'",
    [tenantId, W.entityId()],
  );
  pettyGlId = gl.rows[0]!.id;
  // HR disburses kasbon (never the borrower); the approver pays reimbursements.
  const hrUser = await W.signedInClient("swn0m HR");
  await W.grantRole(hrUser.userId, [
    "hr.employee.manage",
    "hr.employee.view",
    "hr.loan.approve",
    "payroll.view",
  ]);
  hr = hrUser;
  const approverUser = await W.signedInClient("swn0m reimbursement approver");
  await W.grantRole(approverUser.userId, ["hr.reimbursement.approve"]);
  approver = approverUser;
  categoryId = randomUUID();
  await kitOwner.query(
    `INSERT INTO reimbursement_categories (id, tenant_id, name, receipt_required, limits)
     VALUES ($1, $2, 'Kategori swn0m', false, $3)`,
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
    const purchases = `(SELECT id FROM petty_purchases WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[]))`;
    await client.query(
      `DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_id IN ${purchases}`,
      [tenantId, outlets],
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
    await client.query(
      "DELETE FROM petty_purchases WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      [tenantId, outlets],
    );
    await client.query(
      "DELETE FROM petty_purchase_policies WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      [tenantId, outlets],
    );
    await client.query(
      "DELETE FROM purchasing_idempotency WHERE tenant_id = $1 AND operation LIKE 'petty_purchase%' AND idempotency_key = ANY($2::text[])",
      [tenantId, usedKeys],
    );
    await client.query(
      "DELETE FROM core_storage_objects WHERE id = ANY($1::uuid[])",
      [photoIds],
    );
    for (const outletId of outlets) {
      await client.query(
        "DELETE FROM petty_cash_entries WHERE tenant_id = $1 AND outlet_id = $2",
        [tenantId, outletId],
      );
      await client.query(
        "DELETE FROM petty_cash_funds WHERE tenant_id = $1 AND outlet_id = $2",
        [tenantId, outletId],
      );
      await client.query("DELETE FROM outlets WHERE id = $1", [outletId]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  await closeKit();
});

// ---- cash helpers ------------------------------------------------------------

async function topUp(amountIdr: number, outletId: string) {
  const res = await finance.client.post(MOVEMENTS).set(originHeader).send({
    kind: "topup",
    outletId,
    bankAccountId,
    amountIdr,
    description: "Isi kas kecil swn0m",
    idempotencyKey: key(),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

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

/** GL 1102 minus the approved cash payroll and what was paid here. */
const available = async () =>
  (await glBalance()) - committed - purchased - (await pendingOfPaid());

/** Sum of the kasbon / claims paid here that really left a pending event. */
async function pendingOfPaid(): Promise<number> {
  const ids = [...paidAmounts.keys()];
  if (ids.length === 0) return 0;
  const { rows } = await kitOwner.query<{ id: string }>(
    `SELECT r AS id FROM unnest($2::text[]) r
      WHERE EXISTS (SELECT 1 FROM domain_event_outbox
                     WHERE tenant_id = $1
                       AND event->>'name' IN ('employee_loan.disbursed', 'reimbursement.paid')
                       AND event::text LIKE '%' || r || '%')`,
    [tenantId, ids],
  );
  return rows.reduce((sum, row) => sum + paidAmounts.get(row.id)!, 0);
}

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

/** Approves a cash batch that must pass: it is the reserve of a cash payroll. */
async function reserve(net: number) {
  const batch = await pendingBatch(net);
  const failure = await W.httpFailure(
    W.inTx((tx) =>
      approveDisbursementBatch(tx, actorOf(APP), batch.batchId, {
        contentHash: batch.hash,
        sourceBankAccountId: null,
      } as never),
    ),
  );
  expect(failure, "the reserve batch is approved").toBeNull();
  committed += net;
  return batch;
}

/** Approves one exact batch for all available cash: the baseline becomes 0. */
async function drain() {
  const avail = await available();
  expect(
    avail,
    "available cash is never negative between tests",
  ).toBeGreaterThanOrEqual(0);
  if (avail > 0) await reserve(avail);
  expect(await available()).toBe(0);
}

/** Puts cash into 1102 by a seeded journal (setup only). */
const addCash = (amountIdr: number) => W.fundPettyCash(amountIdr);

/** Hygiene after a test that spent while the check was off: baseline 0 again. */
async function restoreBaseline() {
  const gap = -(await available());
  if (gap > 0) await addCash(gap);
}

async function withAccountingOff<T>(work: () => Promise<T>) {
  const before = await kitOwner.query<{ flags: unknown }>(
    "SELECT feature_flags AS flags FROM tenants WHERE id = $1",
    [tenantId],
  );
  const original = before.rows[0]!.flags as { modules?: string[] };
  expect(original.modules, "premise: accounting is on").toContain("accounting");
  await kitOwner.query(
    "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
    [
      tenantId,
      JSON.stringify({
        ...original,
        modules: (original.modules ?? []).filter((m) => m !== "accounting"),
      }),
    ],
  );
  try {
    return await work();
  } finally {
    await kitOwner.query(
      "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
      [tenantId, JSON.stringify(original)],
    );
  }
}

/** Runs `work` with the entity's petty_cash mapping removed, then restores it. */
async function withoutPettyMapping<T>(work: () => Promise<T>) {
  const { rows } = await kitOwner.query<{ account_id: string }>(
    "SELECT account_id FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'petty_cash'",
    [tenantId, W.entityId()],
  );
  expect(rows, "premise: the entity maps petty_cash").toHaveLength(1);
  await kitOwner.query(
    "DELETE FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'petty_cash'",
    [tenantId, W.entityId()],
  );
  try {
    return await work();
  } finally {
    await kitOwner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, 'petty_cash', $3)`,
      [tenantId, W.entityId(), rows[0]!.account_id],
    );
  }
}

type Res = {
  status: number;
  body: { error?: { code?: string; message?: string }; data?: unknown };
};

/** The refusal of the new guard: 422 naming the code, with a message. */
function expectGlRefusal(res: Res) {
  const detail = JSON.stringify(res.body);
  expect(res.status, detail).toBe(422);
  expect(res.body.error?.code, detail).toBe(REFUSAL);
  expect(String(res.body.error?.message ?? ""), "a message").not.toBe("");
}

function expectBusinessLoss(status: number, what: string) {
  expect(
    [409, 422],
    `${what} must be a business refusal, got ${status}`,
  ).toContain(status);
}

// ---- employees, kasbon, reimbursements ---------------------------------------------

/** An employee of the payout entity without a bank account: paid in cash. */
async function makeEmployee() {
  const id = randomUUID();
  employeeIds.push(id);
  await kitOwner.query(
    `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                            legal_entity_id, employment_type, join_date, status)
     VALUES ($1, $2, $3, 'Karyawan swn0m', $4, $5, 'pkwtt', '2025-03-01', 'active')`,
    [
      id,
      tenantId,
      `SW-${id.slice(0, 8).toUpperCase()}`,
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
     VALUES ($1, $2, $3, $4, $5, 10, $4, '2026-12-01', 'Kasbon uji swn0m', 'approved', $6, now())`,
    [id, tenantId, employeeId, principal, Math.ceil(principal / 10), DECIDER],
  );
  return id;
}

/** Disburses over HTTP; the response is returned as is. */
async function disburse(loanId: string, principal: number): Promise<Res> {
  const res = await hr.client
    .post(`${LOANS}/${loanId}/disburse`)
    .set(originHeader)
    .send({ idempotencyKey: `payout-gl-swn0m-${randomUUID()}` });
  if (res.status === 200) paidAmounts.set(loanId, principal);
  return res;
}

async function loanState(loanId: string) {
  const row = (
    await kitOwner.query<{ status: string; disbursed_at: string | null }>(
      "SELECT status, disbursed_at FROM employee_loans WHERE tenant_id = $1 AND id = $2",
      [tenantId, loanId],
    )
  ).rows[0]!;
  return {
    status: row.status,
    disbursed: row.disbursed_at !== null,
    events: await eventCount("employee_loan.disbursed", loanId),
  };
}

async function eventCount(name: string, id: string) {
  const { rows } = await kitOwner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = $2 AND event::text LIKE '%' || $3 || '%'`,
    [tenantId, name, id],
  );
  return Number(rows[0]!.n);
}

/** An `approved` cash reimbursement claim waiting to be paid. */
async function seedClaim(employeeId: string, amount: number) {
  const id = randomUUID();
  claimIds.push(id);
  await kitOwner.query(
    `INSERT INTO reimbursements
       (id, tenant_id, employee_id, category_id, expense_date, amount_idr, approved_amount_idr,
        description, payout, status, decided_by, decided_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6, 'Klaim uji swn0m', 'cash', 'approved', $7, now())`,
    [id, tenantId, employeeId, categoryId, aparToday(), amount, DECIDER],
  );
  return id;
}

async function payClaim(claimId: string, amount: number): Promise<Res> {
  const res = await approver.client
    .post(`${CLAIMS}/${claimId}/pay`)
    .set(originHeader)
    .send({ idempotencyKey: `payout-gl-swn0m-${randomUUID()}` });
  if (res.status === 200) paidAmounts.set(claimId, amount);
  return res;
}

async function claimState(claimId: string) {
  const row = (
    await kitOwner.query<{ status: string; paid_at: string | null }>(
      "SELECT status, paid_at FROM reimbursements WHERE tenant_id = $1 AND id = $2",
      [tenantId, claimId],
    )
  ).rows[0]!;
  return {
    status: row.status,
    paid: row.paid_at !== null,
    events: await eventCount("reimbursement.paid", claimId),
  };
}

// ---- shop (outlet + recorder) and purchase, for the races --------------------------

type Shop = { outletId: string; recorder: Session };

function pkey() {
  const value = `k-${randomUUID()}`;
  usedKeys.push(value);
  return value;
}

async function makeShop(): Promise<Shop> {
  const outletId = await makeOutlet(W.entityId());
  outlets.push(outletId);
  const recorder = await signedIn(app, "swn0m recorder", [
    { role: "outlet_manager", outletId },
  ]);
  const policy = await finance.client
    .put(POLICY)
    .set(originHeader)
    .send({ outletId, limitIdr: 1_000_000, idempotencyKey: pkey() });
  expect(policy.status, JSON.stringify(policy.body)).toBe(200);
  return { outletId, recorder };
}

async function buy(shop: Shop, amountIdr: number): Promise<Res> {
  const photoId = randomUUID();
  await kitOwner.query(
    `INSERT INTO core_storage_objects
       (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes, owner_user_id)
     VALUES ($1, $2, $3, 'receipt', $4, 'image/webp', 1024, $5)`,
    [
      tenantId,
      shop.outletId,
      photoId,
      `legend-swn0m/${photoId}.webp`,
      shop.recorder.userId,
    ],
  );
  photoIds.push(photoId);
  const res = await shop.recorder.client
    .post(PURCHASES)
    .set(originHeader)
    .send({
      outletId: shop.outletId,
      vendorName: "Pasar Induk",
      description: "Cabai dan bawang",
      amountIdr,
      photoMediaId: photoId,
      idempotencyKey: pkey(),
    });
  if (res.status === 201) purchased += amountIdr;
  return res;
}

/**
 * A shop fund of 200.000 and an approved cash batch of 50.000: 150.000 are
 * available, so a claim of 100.000 fits alone but no two do.
 */
async function crowdedScene() {
  await drain();
  const shop = await makeShop();
  await topUp(200_000, shop.outletId);
  await reserve(50_000);
  expect(await available()).toBe(150_000);
  return shop;
}

// ---- 1. kasbon disbursement -------------------------------------------------------

describe("swn0m cash kasbon disbursement respects the available 1102 cash", () => {
  it("[swn0m-loan-refused-by-reserve] a cash kasbon above the available 1102 cash (after the approved cash payroll) is refused 422 PETTY_CASH_GL_INSUFFICIENT: the kasbon stays approved, no event, no journal", async () => {
    await drain();
    await addCash(100_000);
    await reserve(70_000); // available 30.000
    expect(await available()).toBe(30_000);
    const employee = await makeEmployee();
    const loan = await seedLoan(employee, 50_000);
    const journals = await journalCount();
    const gl = await glBalance();

    const res = await disburse(loan, 50_000);

    expectGlRefusal(res);
    expect(await loanState(loan)).toEqual({
      status: "approved",
      disbursed: false,
      events: 0,
    });
    expect(await journalCount(), "no journal").toBe(journals);
    expect(await glBalance()).toBe(gl);
    expect(await available(), "nothing was paid").toBe(30_000);
  }, 90_000);

  it("[swn0m-loan-refused-no-reserve] a cash kasbon above plain GL 1102 (no payroll reserve at all) is refused", async () => {
    await drain();
    await addCash(20_000);
    const loan = await seedLoan(await makeEmployee(), 30_000);

    const res = await disburse(loan, 30_000);

    expectGlRefusal(res);
    expect((await loanState(loan)).status).toBe("approved");
    // Hygiene: baseline back to zero for the next tests.
    await drain();
  }, 90_000);

  it("[swn0m-loan-fits-boundary] a kasbon equal to the available cash is disbursed (it does not count against itself)", async () => {
    await drain();
    await addCash(100_000);
    await reserve(70_000); // available 30.000
    const exact = await seedLoan(await makeEmployee(), 30_000);

    const ok = await disburse(exact, 30_000);

    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const state = await loanState(exact);
    expect(state.status).toBe("disbursed");
    expect(state.disbursed).toBe(true);
    await restoreBaseline();
  }, 90_000);

  it("[swn0m-loan-counts-as-pending] a disbursed cash kasbon is a pending 1102 credit: it leaves an employee_loan.disbursed event, and one rupiah more is then refused", async () => {
    await drain();
    await addCash(100_000);
    await reserve(70_000); // available 30.000
    const exact = await seedLoan(await makeEmployee(), 30_000);
    expect((await disburse(exact, 30_000)).status).toBe(200);

    expect((await loanState(exact)).events, "one pending event").toBe(1);
    expect(await available()).toBe(0);
    const more = await seedLoan(await makeEmployee(), 10_000);
    expectGlRefusal(await disburse(more, 10_000));
    expect((await loanState(more)).events).toBe(0);
  }, 90_000);

  it("[swn0m-loan-accounting-off-skips-check] while accounting is off the check is skipped: the same oversized cash kasbon is disbursed", async () => {
    await drain();
    const loan = await seedLoan(await makeEmployee(), 50_000);

    const res = await withAccountingOff(() => disburse(loan, 50_000));
    await restoreBaseline();

    expect(
      res.status,
      `accounting off: the 1102 check is skipped, ${JSON.stringify(res.body)}`,
    ).toBe(200);
    expect((await loanState(loan)).status).toBe("disbursed");
  }, 90_000);

  it("[swn0m-loan-no-mapping-skips-check] an entity without a petty_cash mapping has no 1102 to protect: the same oversized cash kasbon is disbursed", async () => {
    await drain();
    const loan = await seedLoan(await makeEmployee(), 50_000);

    const res = await withoutPettyMapping(() => disburse(loan, 50_000));
    await restoreBaseline();

    expect(
      res.status,
      `no mapping: the 1102 check is skipped, ${JSON.stringify(res.body)}`,
    ).toBe(200);
    expect((await loanState(loan)).status).toBe("disbursed");
  }, 90_000);
});

// ---- 2. cash reimbursement --------------------------------------------------------

describe("swn0m cash reimbursement payment respects the available 1102 cash", () => {
  it("[swn0m-reimb-refused-by-reserve] a cash claim above the available 1102 cash (after the approved cash payroll) is refused 422 PETTY_CASH_GL_INSUFFICIENT: the claim stays approved, no event, no journal", async () => {
    await drain();
    await addCash(100_000);
    await reserve(70_000); // available 30.000
    const claim = await seedClaim(await makeEmployee(), 50_000);
    const journals = await journalCount();
    const gl = await glBalance();

    const res = await payClaim(claim, 50_000);

    expectGlRefusal(res);
    expect(await claimState(claim)).toEqual({
      status: "approved",
      paid: false,
      events: 0,
    });
    expect(await journalCount(), "no journal").toBe(journals);
    expect(await glBalance()).toBe(gl);
    expect(await available(), "nothing was paid").toBe(30_000);
  }, 90_000);

  it("[swn0m-reimb-refused-no-reserve] a cash claim above plain GL 1102 (no payroll reserve at all) is refused", async () => {
    await drain();
    await addCash(20_000);
    const claim = await seedClaim(await makeEmployee(), 30_000);

    const res = await payClaim(claim, 30_000);

    expectGlRefusal(res);
    expect((await claimState(claim)).status).toBe("approved");
    await drain();
  }, 90_000);

  it("[swn0m-reimb-fits-boundary] a claim equal to the available cash is paid (it does not count against itself)", async () => {
    await drain();
    await addCash(100_000);
    await reserve(70_000); // available 30.000
    const exact = await seedClaim(await makeEmployee(), 30_000);

    const ok = await payClaim(exact, 30_000);

    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const state = await claimState(exact);
    expect(state.status).toBe("paid");
    expect(state.paid).toBe(true);
    await restoreBaseline();
  }, 90_000);

  it("[swn0m-reimb-counts-as-pending] a paid cash claim is a pending 1102 credit: it leaves a reimbursement.paid event, and Rp10 more is then refused", async () => {
    await drain();
    await addCash(100_000);
    await reserve(70_000); // available 30.000
    const exact = await seedClaim(await makeEmployee(), 30_000);
    expect((await payClaim(exact, 30_000)).status).toBe(200);

    expect((await claimState(exact)).events, "one pending event").toBe(1);
    expect(await available()).toBe(0);
    const more = await seedClaim(await makeEmployee(), 10);
    expectGlRefusal(await payClaim(more, 10));
    expect((await claimState(more)).events).toBe(0);
  }, 90_000);

  it("[swn0m-reimb-accounting-off-skips-check] while accounting is off the check is skipped: the same oversized cash claim is paid", async () => {
    await drain();
    const claim = await seedClaim(await makeEmployee(), 50_000);

    const res = await withAccountingOff(() => payClaim(claim, 50_000));
    await restoreBaseline();

    expect(
      res.status,
      `accounting off: the 1102 check is skipped, ${JSON.stringify(res.body)}`,
    ).toBe(200);
    expect((await claimState(claim)).status).toBe("paid");
  }, 90_000);

  it("[swn0m-reimb-no-mapping-skips-check] an entity without a petty_cash mapping has no 1102 to protect: the same oversized cash claim is paid", async () => {
    await drain();
    const claim = await seedClaim(await makeEmployee(), 50_000);

    const res = await withoutPettyMapping(() => payClaim(claim, 50_000));
    await restoreBaseline();

    expect(
      res.status,
      `no mapping: the 1102 check is skipped, ${JSON.stringify(res.body)}`,
    ).toBe(200);
    expect((await claimState(claim)).status).toBe("paid");
  }, 90_000);
});

// ---- races ---------------------------------------------------------------------------

describe("swn0m concurrent claims on the same 1102 cash", () => {
  it("[swn0m-race-loan-vs-purchase] a cash kasbon disbursement and a petty purchase that each fit alone but not together: exactly one gets the cash, the other a business refusal, 1102 never negative, no deadlock", async () => {
    for (let round = 0; round < 3; round++) {
      const shop = await crowdedScene();
      const loan = await seedLoan(await makeEmployee(), 100_000);

      const [disbursed, purchase] = await Promise.all([
        disburse(loan, 100_000),
        buy(shop, 100_000),
      ]);

      const detail = `round ${round}: loan=${JSON.stringify(disbursed.body)} purchase=${JSON.stringify(purchase.body)}`;
      const loanWon = disbursed.status === 200;
      const purchaseWon = purchase.status === 201;
      expect(Number(loanWon) + Number(purchaseWon), detail).toBe(1);
      if (!loanWon) {
        expectBusinessLoss(disbursed.status, "the kasbon");
        expect(disbursed.body.error?.code, detail).toBe(REFUSAL);
        expect((await loanState(loan)).status).toBe("approved");
      } else {
        expect((await loanState(loan)).status).toBe("disbursed");
      }
      if (!purchaseWon) {
        expectBusinessLoss(purchase.status, "the purchase");
        expect(purchase.body.error?.code, detail).toBe(REFUSAL);
      }
      expect(await glBalance(), "GL 1102 not negative").toBeGreaterThanOrEqual(
        0,
      );
      expect(
        await available(),
        "no cash promised that is not there",
      ).toBeGreaterThanOrEqual(0);
    }
  }, 180_000);

  it("[swn0m-race-reimb-vs-purchase] a cash reimbursement payment and a petty purchase that each fit alone but not together: exactly one gets the cash, the other a business refusal, 1102 never negative, no deadlock", async () => {
    for (let round = 0; round < 3; round++) {
      const shop = await crowdedScene();
      const claim = await seedClaim(await makeEmployee(), 100_000);

      const [paid, purchase] = await Promise.all([
        payClaim(claim, 100_000),
        buy(shop, 100_000),
      ]);

      const detail = `round ${round}: claim=${JSON.stringify(paid.body)} purchase=${JSON.stringify(purchase.body)}`;
      const claimWon = paid.status === 200;
      const purchaseWon = purchase.status === 201;
      expect(Number(claimWon) + Number(purchaseWon), detail).toBe(1);
      if (!claimWon) {
        expectBusinessLoss(paid.status, "the claim");
        expect(paid.body.error?.code, detail).toBe(REFUSAL);
        expect((await claimState(claim)).status).toBe("approved");
      } else {
        expect((await claimState(claim)).status).toBe("paid");
      }
      if (!purchaseWon) {
        expectBusinessLoss(purchase.status, "the purchase");
        expect(purchase.body.error?.code, detail).toBe(REFUSAL);
      }
      expect(await glBalance(), "GL 1102 not negative").toBeGreaterThanOrEqual(
        0,
      );
      expect(
        await available(),
        "no cash promised that is not there",
      ).toBeGreaterThanOrEqual(0);
    }
  }, 180_000);
});

// ---- 2b. legend-xf7pt: exactly one outbox event and one journal per payment ---------
//
// Assumptions: a replay (same idempotencyKey) returns the stored response with
// status 200 and the same body even though the first payment already consumed
// every rupiah of the funded cash (so the replay must not be re-judged by the
// 1102 guard). "One status change" is read as: the row stays `disbursed` / `paid`
// and its disbursed_at / paid_at is not rewritten by the replay. The GL journal
// is posted by delivering the real outbox event to the GL consumer, twice.

async function disburseWithKey(
  loanId: string,
  principal: number,
  idempotencyKey: string,
): Promise<Res> {
  const res = await hr.client
    .post(`${LOANS}/${loanId}/disburse`)
    .set(originHeader)
    .send({ idempotencyKey });
  if (res.status === 200) paidAmounts.set(loanId, principal);
  return res;
}

async function payClaimWithKey(
  claimId: string,
  amount: number,
  idempotencyKey: string,
): Promise<Res> {
  const res = await approver.client
    .post(`${CLAIMS}/${claimId}/pay`)
    .set(originHeader)
    .send({ idempotencyKey });
  if (res.status === 200) paidAmounts.set(claimId, amount);
  return res;
}

async function stampOf(table: "employee_loans" | "reimbursements", id: string) {
  const column = table === "employee_loans" ? "disbursed_at" : "paid_at";
  const { rows } = await kitOwner.query<{ stamp: string | null }>(
    `SELECT ${column}::text AS stamp FROM ${table} WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return rows[0]!.stamp;
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

describe("xf7pt one outbox event and one GL journal per cash payment", () => {
  it("[xf7pt-loan-replay-one-event] disbursing the same kasbon twice with the same idempotency key gives the same response and exactly one employee_loan.disbursed event", async () => {
    await drain();
    await addCash(40_000);
    const loan = await seedLoan(await makeEmployee(), 40_000);
    const idempotencyKey = `payout-gl-swn0m-${randomUUID()}`;

    const first = await disburseWithKey(loan, 40_000, idempotencyKey);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const stamp = await stampOf("employee_loans", loan);
    const second = await disburseWithKey(loan, 40_000, idempotencyKey);

    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(await loanState(loan)).toEqual({
      status: "disbursed",
      disbursed: true,
      events: 1,
    });
    expect(
      await stampOf("employee_loans", loan),
      "no second status change",
    ).toBe(stamp);
  }, 90_000);

  it("[xf7pt-reimb-replay-one-event] paying the same claim twice with the same idempotency key gives the same response and exactly one reimbursement.paid event", async () => {
    await drain();
    await addCash(40_000);
    const claim = await seedClaim(await makeEmployee(), 40_000);
    const idempotencyKey = `payout-gl-swn0m-${randomUUID()}`;

    const first = await payClaimWithKey(claim, 40_000, idempotencyKey);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const stamp = await stampOf("reimbursements", claim);
    const second = await payClaimWithKey(claim, 40_000, idempotencyKey);

    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(await claimState(claim)).toEqual({
      status: "paid",
      paid: true,
      events: 1,
    });
    expect(
      await stampOf("reimbursements", claim),
      "no second status change",
    ).toBe(stamp);
  }, 90_000);

  it("[xf7pt-loan-journal-once] the real employee_loan.disbursed event delivered to the GL twice posts exactly one journal payroll-gl:loan:<id>, Dr 1204 / Cr 1102 for the principal", async () => {
    await drain();
    await addCash(40_000);
    await ensureMapping("employee_receivable", "1204");
    const loan = await seedLoan(await makeEmployee(), 40_000);
    expect((await disburse(loan, 40_000)).status).toBe(200);
    const event = employeeLoanDisbursed.envelopeSchema.parse(
      await outboxEventOf("employee_loan.disbursed", loan),
    );
    const glBefore = await glBalance();

    const first = await deliverToGl(event);
    const second = await deliverToGl(event);
    await markDelivered("employee_loan.disbursed", loan);

    expect(first.status).toBe("posted");
    expect(second).toEqual(first);
    const gl = `payroll-gl:loan:${loan}`;
    expect(await W.countJournals(gl), "exactly one journal").toBe(1);
    expect(await W.journalByKey(gl)).toEqual({
      "1204": { debit: 40_000, credit: 0 },
      "1102": { debit: 0, credit: 40_000 },
    });
    expect(await glBalance(), "1102 credited once").toBe(glBefore - 40_000);
    // The journal now holds the credit and the event is delivered: it no longer
    // counts as a pending credit.
    paidAmounts.delete(loan);
    expect(await available()).toBe(0);
  }, 90_000);

  it("[xf7pt-reimb-journal-once] the real reimbursement.paid event of a cash claim delivered to the GL twice posts exactly one journal payroll-gl:reimbursement:<id>, Dr 6110 / Cr 1102 on the employee's entity", async () => {
    await drain();
    await addCash(40_000);
    const claim = await seedClaim(await makeEmployee(), 40_000);
    const paid = await payClaim(claim, 40_000);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const event = reimbursementPaid.envelopeSchema.parse(
      await outboxEventOf("reimbursement.paid", claim),
    );
    const glBefore = await glBalance();

    const first = await deliverToGl(event);
    const second = await deliverToGl(event);
    await markDelivered("reimbursement.paid", claim);

    expect(first.status).toBe("posted");
    expect(second).toEqual(first);
    const gl = `payroll-gl:reimbursement:${claim}`;
    expect(await W.countJournals(gl), "exactly one journal").toBe(1);
    expect(await W.journalByKey(gl)).toEqual({
      "6110": { debit: 40_000, credit: 0 },
      "1102": { debit: 0, credit: 40_000 },
    });
    expect(await glBalance(), "1102 credited once").toBe(glBefore - 40_000);
    paidAmounts.delete(claim);
    expect(await available()).toBe(0);
  }, 90_000);
});

// ---- 2c. legend-kt8em / legend-cv00j: accounting toggle and missing entity -----------
//
// Assumptions: the flag is read from the stored outbox event at
// `event.payload.accountingOnAtEmit`; "accounting off" is the tenant's
// `accounting` module removed from feature_flags (withAccountingOff), both when
// paying and when delivering to the GL consumer; the `ignored` status of the
// consumer is the string "ignored". A cash payment of an employee without a
// legal entity is refused with HTTP 422 and the code below. The reimbursement
// journal debits 6110, as in [xf7pt-reimb-journal-once].

const ENTITY_MISSING = "PAYROLL_CASH_ENTITY_MISSING";

/** An active employee whose legal_entity_id is NULL. */
async function makeEmployeeWithoutEntity() {
  const id = randomUUID();
  employeeIds.push(id);
  await kitOwner.query(
    `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                            legal_entity_id, employment_type, join_date, status)
     VALUES ($1, $2, $3, 'Karyawan tanpa entitas swn0m', $4, NULL, 'pkwtt', '2025-03-01', 'active')`,
    [id, tenantId, `SN-${id.slice(0, 8).toUpperCase()}`, fixtureOutlet.id],
  );
  return id;
}

/** The payload of a stored outbox event, as the database holds it. */
function payloadOf(event: unknown): Record<string, unknown> {
  return (event as { payload?: Record<string, unknown> }).payload ?? {};
}

/** The same event without the accountingOnAtEmit field (an old event). */
function withoutFlag(event: unknown) {
  const rest = { ...payloadOf(event) };
  delete rest.accountingOnAtEmit;
  return { ...(event as object), payload: rest };
}

describe("kt8em the GL consumer follows the accounting state at the time of payment", () => {
  it("[kt8em-loan-toggle-posts] a cash kasbon paid while accounting is on still posts Dr 1204 / Cr 1102 when accounting is switched off before the event is consumed", async () => {
    await drain();
    await addCash(40_000);
    await ensureMapping("employee_receivable", "1204");
    const loan = await seedLoan(await makeEmployee(), 40_000);
    expect((await disburse(loan, 40_000)).status).toBe(200);
    const stored = await outboxEventOf("employee_loan.disbursed", loan);
    expect(
      payloadOf(stored).accountingOnAtEmit,
      "the event records that accounting was on when paid",
    ).toBe(true);
    const event = employeeLoanDisbursed.envelopeSchema.parse(stored);
    const glBefore = await glBalance();

    const result = await withAccountingOff(() => deliverToGl(event));
    await markDelivered("employee_loan.disbursed", loan);

    expect(result.status).toBe("posted");
    const gl = `payroll-gl:loan:${loan}`;
    expect(await W.countJournals(gl), "exactly one journal").toBe(1);
    expect(await W.journalByKey(gl)).toEqual({
      "1204": { debit: 40_000, credit: 0 },
      "1102": { debit: 0, credit: 40_000 },
    });
    expect(await glBalance(), "1102 credited once").toBe(glBefore - 40_000);
    paidAmounts.delete(loan);
    expect(await available()).toBe(0);
  }, 90_000);

  it("[kt8em-reimb-toggle-posts] a cash claim paid while accounting is on still posts Dr 6110 / Cr 1102 when accounting is switched off before the event is consumed", async () => {
    await drain();
    await addCash(40_000);
    const claim = await seedClaim(await makeEmployee(), 40_000);
    const paid = await payClaim(claim, 40_000);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const stored = await outboxEventOf("reimbursement.paid", claim);
    expect(
      payloadOf(stored).accountingOnAtEmit,
      "the event records that accounting was on when paid",
    ).toBe(true);
    const event = reimbursementPaid.envelopeSchema.parse(stored);
    const glBefore = await glBalance();

    const result = await withAccountingOff(() => deliverToGl(event));
    await markDelivered("reimbursement.paid", claim);

    expect(result.status).toBe("posted");
    const gl = `payroll-gl:reimbursement:${claim}`;
    expect(await W.countJournals(gl), "exactly one journal").toBe(1);
    expect(await W.journalByKey(gl)).toEqual({
      "6110": { debit: 40_000, credit: 0 },
      "1102": { debit: 0, credit: 40_000 },
    });
    expect(await glBalance(), "1102 credited once").toBe(glBefore - 40_000);
    paidAmounts.delete(claim);
    expect(await available()).toBe(0);
  }, 90_000);

  it("[kt8em-off-at-emit-ignored] a cash kasbon paid while accounting is off is not flagged on, and the GL consumer ignores it while accounting is still off", async () => {
    await drain();
    const loan = await seedLoan(await makeEmployee(), 40_000);
    const paid = await withAccountingOff(() => disburse(loan, 40_000));
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const stored = await outboxEventOf("employee_loan.disbursed", loan);
    expect(
      payloadOf(stored).accountingOnAtEmit,
      "accounting was off when paid",
    ).not.toBe(true);
    const event = employeeLoanDisbursed.envelopeSchema.parse(stored);
    const journals = await journalCount();

    const result = await withAccountingOff(() => deliverToGl(event));
    await markDelivered("employee_loan.disbursed", loan);
    paidAmounts.delete(loan);

    expect(result.status).toBe("ignored");
    expect(await W.countJournals(`payroll-gl:loan:${loan}`)).toBe(0);
    expect(await journalCount(), "no journal").toBe(journals);
    expect(await available(), "baseline unchanged").toBe(0);
  }, 90_000);

  it("[kt8em-off-at-emit-ignored-reimb] a cash claim paid while accounting is off is not flagged on, and the GL consumer ignores it while accounting is still off", async () => {
    await drain();
    const claim = await seedClaim(await makeEmployee(), 40_000);
    const paid = await withAccountingOff(() => payClaim(claim, 40_000));
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const stored = await outboxEventOf("reimbursement.paid", claim);
    expect(
      payloadOf(stored).accountingOnAtEmit,
      "accounting was off when paid",
    ).not.toBe(true);
    const event = reimbursementPaid.envelopeSchema.parse(stored);
    const journals = await journalCount();

    const result = await withAccountingOff(() => deliverToGl(event));
    await markDelivered("reimbursement.paid", claim);
    paidAmounts.delete(claim);

    expect(result.status).toBe("ignored");
    expect(await W.countJournals(`payroll-gl:reimbursement:${claim}`)).toBe(0);
    expect(await journalCount(), "no journal").toBe(journals);
    expect(await available(), "baseline unchanged").toBe(0);
  }, 90_000);

  it("[kt8em-legacy-no-flag-ignored] an old event without accountingOnAtEmit is ignored while accounting is off (no journal)", async () => {
    await drain();
    await addCash(40_000);
    const loan = await seedLoan(await makeEmployee(), 40_000);
    expect((await disburse(loan, 40_000)).status).toBe(200);
    const stored = await outboxEventOf("employee_loan.disbursed", loan);
    const legacy = employeeLoanDisbursed.envelopeSchema.parse(
      withoutFlag(stored),
    );
    expect(payloadOf(legacy)).not.toHaveProperty("accountingOnAtEmit");
    const journals = await journalCount();

    const result = await withAccountingOff(() => deliverToGl(legacy));
    await markDelivered("employee_loan.disbursed", loan);
    paidAmounts.delete(loan);

    expect(result.status).toBe("ignored");
    expect(await W.countJournals(`payroll-gl:loan:${loan}`)).toBe(0);
    expect(await journalCount(), "no journal").toBe(journals);
    await drain();
  }, 90_000);
});

describe("cv00j a cash payment needs the employee's legal entity while accounting is on", () => {
  it("[cv00j-loan-no-entity-refused] a cash kasbon of an employee without a legal entity is refused 422 PAYROLL_CASH_ENTITY_MISSING: still approved, no event, no journal, GL 1102 unchanged", async () => {
    await drain();
    await addCash(100_000);
    const loan = await seedLoan(await makeEmployeeWithoutEntity(), 30_000);
    const journals = await journalCount();
    const gl = await glBalance();

    const res = await disburse(loan, 30_000);

    const detail = JSON.stringify(res.body);
    expect(res.status, detail).toBe(422);
    expect(res.body.error?.code, detail).toBe(ENTITY_MISSING);
    expect(await loanState(loan)).toEqual({
      status: "approved",
      disbursed: false,
      events: 0,
    });
    expect(await journalCount(), "no journal").toBe(journals);
    expect(await glBalance(), "1102 unchanged").toBe(gl);
    await drain();
  }, 90_000);

  it("[cv00j-reimb-no-entity-refused] a cash claim of an employee without a legal entity is refused 422 PAYROLL_CASH_ENTITY_MISSING: still approved, no event, no journal, GL 1102 unchanged", async () => {
    await drain();
    await addCash(100_000);
    const claim = await seedClaim(await makeEmployeeWithoutEntity(), 30_000);
    const journals = await journalCount();
    const gl = await glBalance();

    const res = await payClaim(claim, 30_000);

    const detail = JSON.stringify(res.body);
    expect(res.status, detail).toBe(422);
    expect(res.body.error?.code, detail).toBe(ENTITY_MISSING);
    expect(await claimState(claim)).toEqual({
      status: "approved",
      paid: false,
      events: 0,
    });
    expect(await journalCount(), "no journal").toBe(journals);
    expect(await glBalance(), "1102 unchanged").toBe(gl);
    await drain();
  }, 90_000);

  it("[cv00j-accounting-off-allowed] while accounting is off an employee without a legal entity is still paid a cash kasbon and a cash claim (200)", async () => {
    await drain();
    const employee = await makeEmployeeWithoutEntity();
    const loan = await seedLoan(employee, 20_000);
    const claim = await seedClaim(employee, 20_000);

    const loanRes = await withAccountingOff(() => disburse(loan, 20_000));
    const claimRes = await withAccountingOff(() => payClaim(claim, 20_000));
    await restoreBaseline();

    expect(
      loanRes.status,
      `accounting off: the kasbon is paid, ${JSON.stringify(loanRes.body)}`,
    ).toBe(200);
    expect(
      claimRes.status,
      `accounting off: the claim is paid, ${JSON.stringify(claimRes.body)}`,
    ).toBe(200);
    expect((await loanState(loan)).status).toBe("disbursed");
    expect((await claimState(claim)).status).toBe("paid");
  }, 90_000);
});

// ---- 3. supplier payment on a bank account that is GL 1102 -------------------------
//
// Own fresh tenants (the purchasing/AP helpers), so nothing here touches the
// payout world. The invoice payable is Rp 100.000; every payment waits for a
// second person and is settled by the approval consumer.

const PAYABLE = 100_000;

type Supplier = {
  world: AparWorld;
  pettyId: string;
  bankId: string;
  buyer: AparSession;
  warehouse: AparSession;
  finance: AparSession;
  approver: AparSession;
};

/**
 * A tenant whose supplier payments credit the `bank` role. `bankOn1102`: the
 * `bank` mapping is the 1102 account (else a separate 1103); `pettyMapping`:
 * the `petty_cash` role is mapped to 1102 at all.
 */
async function setupSupplier(
  label: string,
  options: { bankOn1102: boolean; pettyMapping: boolean },
): Promise<Supplier> {
  const world = await createWorld(label);
  const account = async (code: string, name: string) =>
    (
      await aparOwner.query<{ id: string }>(
        `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
         VALUES ($1, $2, $3, $4, 'asset', 'cash_and_equivalents') RETURNING id`,
        [world.tenantId, world.entityId, code, name],
      )
    ).rows[0]!.id;
  const pettyId = await account("1102", "Kas Kecil");
  const bankId = options.bankOn1102 ? pettyId : await account("1103", "Bank");
  const map = (role: string, accountId: string) =>
    aparOwner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [world.tenantId, world.entityId, role, accountId],
    );
  if (options.pettyMapping) await map("petty_cash", pettyId);
  await map("bank", bankId);
  // The approver role named by the policy: a general manager copy.
  const template = ROLE_TEMPLATES.find((t) => t.key === "general_manager")!;
  const approverRoleId = randomUUID();
  await aparOwner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Uji general manager swn0m', false, NULL, $3, false, $4)`,
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
    bankId,
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
         VALUES ($1, $2, $3, $4, 'sale', NULL, 'Saldo kas kecil uji swn0m', $5, $6)
         RETURNING id`,
        [
          t.world.tenantId,
          t.world.entityId,
          aparToday(),
          period,
          `swn0m-fund-${randomUUID()}`,
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

/** A pending cash payroll credit of the tenant's entity: a reserve on 1102. */
async function seedPendingCashPayroll(t: Supplier, cashIdr: number) {
  const payrollRunId = randomUUID();
  await aparOwner.query(
    `INSERT INTO domain_event_outbox
       (tenant_id, id, event_id, aggregate_type, aggregate_id, sequence, event, destination, status)
     VALUES ($1, $2, $3, 'payroll_run', $4, 1, $5, 'cloud-sync', 'pending')`,
    [
      t.world.tenantId,
      randomUUID(),
      randomUUID(),
      payrollRunId,
      JSON.stringify({
        name: "payroll.paid",
        tenantId: t.world.tenantId,
        aggregateType: "payroll_run",
        sequence: 1,
        payload: {
          payrollRunId,
          legalEntityId: t.world.entityId,
          netIdr: cashIdr,
          bankTransferIdr: 0,
          cashIdr,
        },
      }),
    ],
  );
}

async function supplierGl(t: Supplier): Promise<number> {
  const { rows } = await aparOwner.query<{ balance: string }>(
    `SELECT coalesce(sum(debit_idr - credit_idr), 0)::text AS balance
       FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
    [t.world.tenantId, t.pettyId],
  );
  return Number(rows[0]!.balance);
}

async function supplierJournalCount(t: Supplier): Promise<number> {
  const { rows } = await aparOwner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND source_type = 'supplier_payment'",
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

type PaymentRow = {
  id: string;
  status: string;
  note: string | null;
  approval_chain_id: string | null;
};

/** The payments of an invoice as the list route shows them (with the note). */
async function listedPayment(t: Supplier, invoiceId: string, id: string) {
  const res = await api.get(
    t.world,
    t.finance,
    `/supplier-invoices/${invoiceId}/payments`,
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const data = (res.body as { data: unknown }).data;
  const rows = (
    Array.isArray(data) ? data : (data as { items: unknown[] }).items
  ) as {
    id: string;
    note?: string | null;
  }[];
  return rows.find((row) => row.id === id)!;
}

async function paymentRow(
  t: Supplier,
  paymentId: string,
): Promise<Omit<PaymentRow, "note">> {
  const { rows } = await aparOwner.query<PaymentRow>(
    `SELECT id, status, approval_chain_id FROM supplier_payments
      WHERE tenant_id = $1 AND id = $2`,
    [t.world.tenantId, paymentId],
  );
  return rows[0]!;
}

/** Requests the payment, lets the second person approve, applies the decision. */
async function payViaSecondPerson(
  t: Supplier,
  invoiceId: string,
  amountIdr: number,
): Promise<PaymentRow> {
  const res = await api.post(
    t.world,
    t.finance,
    `/supplier-invoices/${invoiceId}/payments`,
    { amountIdr, paidOn: aparToday(), idempotencyKey: `k-${randomUUID()}` },
  );
  expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
  const data = (res.body as { data: { id: string; status: string } }).data;
  expect(data.status).toBe("pending_approval");
  const chainId = (await paymentRow(t, data.id)).approval_chain_id!;
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
  const row = await paymentRow(t, data.id);
  return {
    ...row,
    note: (await listedPayment(t, invoiceId, data.id)).note ?? null,
  };
}

describe("swn0m supplier payment on a bank account that is GL 1102", () => {
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

  it("[swn0m-supplier-refused-when-1102-short] a payment above the cash in 1102 (the bank role is the petty cash account) is rejected with PETTY_CASH_GL_INSUFFICIENT: no journal, the payable untouched, 1102 untouched, a replay changes nothing", async () => {
    const t = await setupSupplier("swn0m-s1", {
      bankOn1102: true,
      pettyMapping: true,
    });
    await fundSupplier1102(t, 30_000);
    const invoiceId = await supplierInvoice(t);
    const journals = await supplierJournalCount(t);

    const row = await payViaSecondPerson(t, invoiceId, 50_000);

    expect(row.status).toBe("rejected");
    expect(row.note ?? "", "the note names the refusal").toContain(REFUSAL);
    expect(await supplierJournalCount(t), "no journal").toBe(journals);
    expect(await payableOutstanding(t, invoiceId)).toBe(PAYABLE);
    expect(await supplierGl(t)).toBe(30_000);
  }, 120_000);

  it("[swn0m-supplier-fits-and-boundary] a payment equal to the cash in 1102 is paid (one journal Dr AP / Cr 1102); then one rupiah more is rejected because 1102 is empty", async () => {
    const t = await setupSupplier("swn0m-s2", {
      bankOn1102: true,
      pettyMapping: true,
    });
    await fundSupplier1102(t, 50_000);
    const invoiceId = await supplierInvoice(t);
    const journals = await supplierJournalCount(t);

    const paid = await payViaSecondPerson(t, invoiceId, 50_000);

    expect(paid.status).toBe("paid");
    expect(await supplierJournalCount(t)).toBe(journals + 1);
    expect(await payableOutstanding(t, invoiceId)).toBe(PAYABLE - 50_000);
    expect(await supplierGl(t), "1102 reduced by the payment").toBe(0);

    const more = await payViaSecondPerson(t, invoiceId, 1);
    expect(more.status).toBe("rejected");
    expect(more.note ?? "").toContain(REFUSAL);
    expect(await supplierGl(t), "1102 never negative").toBe(0);
    expect(await payableOutstanding(t, invoiceId)).toBe(PAYABLE - 50_000);
  }, 120_000);

  it("[swn0m-supplier-reserve-counted] a pending cash payroll credit of the entity is a reserve: with 100.000 in 1102 and 70.000 reserved, 50.000 is rejected and 30.000 is paid", async () => {
    const t = await setupSupplier("swn0m-s3", {
      bankOn1102: true,
      pettyMapping: true,
    });
    await fundSupplier1102(t, 100_000);
    await seedPendingCashPayroll(t, 70_000); // available 30.000
    const invoiceId = await supplierInvoice(t);

    const refused = await payViaSecondPerson(t, invoiceId, 50_000);
    expect(refused.status).toBe("rejected");
    expect(refused.note ?? "").toContain(REFUSAL);
    expect(await supplierGl(t)).toBe(100_000);
    expect(await payableOutstanding(t, invoiceId)).toBe(PAYABLE);

    const paid = await payViaSecondPerson(t, invoiceId, 30_000);
    expect(paid.status).toBe("paid");
    expect(await supplierGl(t)).toBe(70_000);
    expect(await payableOutstanding(t, invoiceId)).toBe(PAYABLE - 30_000);
  }, 120_000);

  it("[swn0m-supplier-bank-not-1102-unchecked] when the bank role is NOT the petty cash account the credit does not hit 1102: the payment is paid although 1102 is empty", async () => {
    const t = await setupSupplier("swn0m-s4", {
      bankOn1102: false,
      pettyMapping: true,
    });
    const invoiceId = await supplierInvoice(t);

    const paid = await payViaSecondPerson(t, invoiceId, 50_000);

    expect(paid.status).toBe("paid");
    expect(await payableOutstanding(t, invoiceId)).toBe(PAYABLE - 50_000);
    expect(await supplierGl(t), "1102 untouched").toBe(0);
  }, 120_000);

  it("[swn0m-supplier-no-mapping-skips-check] an entity without a petty_cash mapping has no 1102 to protect: the payment is not refused for lack of cash", async () => {
    const t = await setupSupplier("swn0m-s5", {
      bankOn1102: true,
      pettyMapping: false,
    });
    const invoiceId = await supplierInvoice(t);

    const paid = await payViaSecondPerson(t, invoiceId, 50_000);

    expect(paid.status, paid.note ?? "").toBe("paid");
    expect(await payableOutstanding(t, invoiceId)).toBe(PAYABLE - 50_000);
  }, 120_000);
});
