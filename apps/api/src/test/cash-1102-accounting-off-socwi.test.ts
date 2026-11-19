// legend-socwi (P1, second opinion kas payout ronde 4): the 1102 coverage guard
// must not depend on the accounting module flag when a journal that credits
// GL 1102 is posted anyway. Written fail-first from the brief
// (scratchpad brief-socwi.md), the founder rule "GL 1102 never goes negative,
// nobody is paid when the cash is not there" and the public HTTP / service
// surface, NOT from the guard code.
//
// CTO rule (restrictive): the on/off decision is read ONCE per transaction and
// used consistently for the guard AND the journal. If a journal crediting 1102
// is posted, the guard runs, whatever the module flag says.
//
// Paths covered (one describe each):
// 1. supplier payment on a bank account that is GL 1102, accounting switched off
//    before the approval consumer settles it;
// 2. retry of a parked petty cash return with accounting off;
// 3. cash out and bank transfer from a bank account that is GL 1102, accounting off;
// 4. kasbon / reimbursement cash events: emitted with accounting OFF, consumed
//    with accounting ON (never journaled: no coverage guard ever ran).
//
// Assumptions (stated so they can be contested):
// - A refusal on HTTP is 422 PETTY_CASH_GL_INSUFFICIENT (swn0m). A refused
//   supplier settle (legend-5qqb9: retryable) leaves the payment
//   `pending_approval`: no journal, no settlement, payable untouched.
// - The cash out / transfer / petty cash routes stay reachable while the
//   accounting module is off (the brief says the service posts the journal
//   regardless). If a route answered 403/404 the test fails on the status
//   assertion with the body in the message, which is a finding, not flake.
// - Replay of the supplier approval event: the consumer is idempotent, a
//   second delivery changes nothing.
// - Kasbon / reimbursement events carry `accountingOnAtEmit` (kt8em): `false`
//   when paid with accounting off. The consumer must then answer `ignored`
//   even when accounting is ON at consume time; an ignored event reserves
//   nothing (a cash batch for the full GL balance is still approvable after it).
// - The "emitted ON, consumed OFF posts" half of the toggle is the existing
//   kt8em-*-toggle-posts test in cash-1102-sync-guard-swn0m.test.ts; it is not
//   duplicated here.
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
import { HttpError } from "../lib/http-error.ts";
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
  daysAgo,
  key,
  makeBankAccount,
  makeOutlet,
  owner as kitOwner,
  short,
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
const ENTRIES = "/api/accounting/petty-cash/entries";
const CASH_BANK = "/api/accounting/cash-bank/entries";
const LOANS = "/api/hris/payroll/loans";
const CLAIMS = "/api/hris/payroll/reimbursements";
const REFUSAL = "PETTY_CASH_GL_INSUFFICIENT";
const DECIDER = randomUUID();
const W = installPayoutWorld("socwi");
const fixtureOutlet = cafeLegendPlatformFixtures.outlets[0];

let finance: Session;
let hr: Session;
let approver: Session;
let bankAccountId: string;
let pettyGlId: string;
let pettyBankId: string;
let otherBankId: string;
let expenseId: string;
let categoryId: string;
const outlets: string[] = [];
const employeeIds: string[] = [];
const loanIds: string[] = [];
const claimIds: string[] = [];
/** Net of the cash batches approved here and not handed over. */
let committed = 0;

withLimitSharedLock();

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  finance = await signedIn(app, "socwi finance", [
    { role: "finance", outletId: null },
  ]);
  const bankRow = await kitOwner.query<{ id: string }>(
    "SELECT id FROM bank_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 LIMIT 1",
    [tenantId, W.entityId()],
  );
  bankAccountId = bankRow.rows[0]!.id;
  const account = async (code: string) =>
    (
      await kitOwner.query<{ id: string }>(
        "SELECT id FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = $3",
        [tenantId, W.entityId(), code],
      )
    ).rows[0]!.id;
  pettyGlId = await account("1102");
  // A bank account whose GL is 1102 (it pays out of petty cash) and one on 1103.
  pettyBankId = await makeBankAccount(W.entityId(), pettyGlId);
  otherBankId = await makeBankAccount(W.entityId(), await account("1103"));
  await kitOwner.query(
    `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $2, '6992', 'Beban Uji socwi', 'expense', 'operating_expense')
     ON CONFLICT (tenant_id, legal_entity_id, code) DO NOTHING`,
    [tenantId, W.entityId()],
  );
  expenseId = await account("6992");
  const hrUser = await W.signedInClient("socwi HR");
  await W.grantRole(hrUser.userId, [
    "hr.employee.manage",
    "hr.employee.view",
    "hr.loan.approve",
    "payroll.view",
  ]);
  hr = hrUser;
  const approverUser = await W.signedInClient("socwi reimbursement approver");
  await W.grantRole(approverUser.userId, ["hr.reimbursement.approve"]);
  approver = approverUser;
  categoryId = randomUUID();
  await kitOwner.query(
    `INSERT INTO reimbursement_categories (id, tenant_id, name, receipt_required, limits)
     VALUES ($1, $2, 'Kategori socwi', false, $3)`,
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

// ---- shared helpers ------------------------------------------------------------

type Res = {
  status: number;
  body: { error?: { code?: string; message?: string }; data?: unknown };
};

function expectGlRefusal(res: Res) {
  const detail = JSON.stringify(res.body);
  expect(res.status, detail).toBe(422);
  expect(res.body.error?.code, detail).toBe(REFUSAL);
}

/** Runs `work` with the `accounting` module removed from `tenant`, then restores. */
async function withModuleOff<T>(
  pool: { query: typeof kitOwner.query },
  tenant: string,
  work: () => Promise<T>,
): Promise<T> {
  const before = await pool.query<{ flags: unknown }>(
    "SELECT feature_flags AS flags FROM tenants WHERE id = $1",
    [tenant],
  );
  const original = before.rows[0]!.flags as { modules?: string[] };
  expect(original.modules, "premise: accounting is on").toContain("accounting");
  await pool.query(
    "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
    [
      tenant,
      JSON.stringify({
        ...original,
        modules: (original.modules ?? []).filter((m) => m !== "accounting"),
      }),
    ],
  );
  try {
    return await work();
  } finally {
    await pool.query(
      "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
      [tenant, JSON.stringify(original)],
    );
  }
}

const accountingOff = <T>(work: () => Promise<T>) =>
  withModuleOff(kitOwner, tenantId, work);

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

async function journalCount(): Promise<number> {
  const { rows } = await kitOwner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    [tenantId, W.entityId()],
  );
  return Number(rows[0]!.n);
}

async function cashBankEntryCount(): Promise<number> {
  const { rows } = await kitOwner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM cash_bank_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    [tenantId, W.entityId()],
  );
  return Number(rows[0]!.n);
}

async function pendingBatch(net: number) {
  const slips = [cash(CASHIER, net)];
  const runId = await W.seedRun(slips);
  const batchId = await W.createBatch(runId, "cash");
  await W.inTx((tx) => submitDisbursementBatch(tx, actorOf(REQ), batchId));
  const hash = (await W.batchById(batchId)).content_hash as string;
  return { batchId, hash, net };
}

/** Approves a cash batch; null on success, the thrown error otherwise. */
async function tryApprove(net: number): Promise<HttpError | null> {
  const batch = await pendingBatch(net);
  const failure = await W.httpFailure(
    W.inTx((tx) =>
      approveDisbursementBatch(tx, actorOf(APP), batch.batchId, {
        contentHash: batch.hash,
        sourceBankAccountId: null,
      } as never),
    ),
  );
  if (failure === null) committed += net;
  return failure;
}

/** Approves one exact cash batch for all the GL cash: the baseline becomes 0. */
async function drain() {
  const avail = (await glBalance()) - committed;
  expect(avail, "no negative cash between tests").toBeGreaterThanOrEqual(0);
  if (avail > 0) expect(await tryApprove(avail)).toBeNull();
  expect((await glBalance()) - committed).toBe(0);
}

/** Hygiene after a test that went wrong: baseline never negative. */
async function restoreBaseline() {
  const gap = -((await glBalance()) - committed);
  if (gap > 0) await W.fundPettyCash(gap);
}

// ---- 1. supplier payment on a bank account that is GL 1102 -------------------------

const PAYABLE = 100_000;

type Supplier = {
  world: AparWorld;
  pettyId: string;
  buyer: AparSession;
  warehouse: AparSession;
  finance: AparSession;
  approver: AparSession;
};

/** A fresh tenant whose `bank` and `petty_cash` roles are both the 1102 account. */
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
  const template = ROLE_TEMPLATES.find((t) => t.key === "general_manager")!;
  const approverRoleId = randomUUID();
  await aparOwner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Uji general manager socwi', false, NULL, $3, false, $4)`,
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
         VALUES ($1, $2, $3, $4, 'sale', NULL, 'Saldo kas kecil uji socwi', $5, $6)
         RETURNING id`,
        [
          t.world.tenantId,
          t.world.entityId,
          aparToday(),
          period,
          `socwi-fund-${randomUUID()}`,
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

async function supplierInvoice(t: Supplier): Promise<string> {
  const po = await receive(t.world, t.warehouse, await seedPo(t.world));
  const res = await createInvoice(t.world, t.buyer, invoiceBody(t.world, po));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return invoiceIdOf(res);
}

async function paymentRow(t: Supplier, paymentId: string) {
  const { rows } = await aparOwner.query<{
    id: string;
    status: string;
    approval_chain_id: string | null;
  }>(
    `SELECT id, status, approval_chain_id FROM supplier_payments
      WHERE tenant_id = $1 AND id = $2`,
    [t.world.tenantId, paymentId],
  );
  return rows[0]!;
}

/** Requests the payment and lets the second person approve; returns the event. */
async function requestAndApprove(
  t: Supplier,
  invoiceId: string,
  amountIdr: number,
) {
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
  await decideApprovalRequest(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(t.world.tenantId),
      brandId: null,
      source: "domain",
    }),
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
  return {
    paymentId: data.id,
    event: approvalResolvedEvent.envelopeSchema.parse(rows[0]!.event),
  };
}

const consume = (
  t: Supplier,
  event: Awaited<ReturnType<typeof requestAndApprove>>["event"],
) => handlePurchasingApprovalResolved(contextFor(t.world, null), event);

describe("socwi supplier payment on a bank account that is GL 1102, accounting off at settle", () => {
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

  async function expectRefusedAndUntouched(
    t: Supplier,
    invoiceId: string,
    paymentId: string,
    journals: number,
    gl: number,
  ) {
    const row = await paymentRow(t, paymentId);
    expect(row.status, "payment is not paid, parked for retry").toBe(
      "pending_approval",
    );
    expect(await supplierJournalCount(t), "no journal").toBe(journals);
    expect(await payableOutstanding(t, invoiceId), "payable untouched").toBe(
      PAYABLE,
    );
    expect(await supplierGl(t), "1102 never negative").toBe(gl);
  }

  it("[socwi-supplier-accounting-off-refused] GL 1102 Rp30.000, a Rp50.000 payment approved, accounting switched off before the consumer runs: stays pending_approval (retryable, PETTY_CASH_GL_INSUFFICIENT), no settlement or journal, payable and GL unchanged, a replay changes nothing", async () => {
    const t = await setupSupplier("socwi-s1");
    await fundSupplier1102(t, 30_000);
    const invoiceId = await supplierInvoice(t);
    const journals = await supplierJournalCount(t);
    const { paymentId, event } = await requestAndApprove(t, invoiceId, 50_000);

    await withModuleOff(aparOwner, t.world.tenantId, async () => {
      await consume(t, event);
      await expectRefusedAndUntouched(
        t,
        invoiceId,
        paymentId,
        journals,
        30_000,
      );
      // Replay of the same event under the same state.
      await consume(t, event);
      await expectRefusedAndUntouched(
        t,
        invoiceId,
        paymentId,
        journals,
        30_000,
      );
    });
  }, 120_000);

  it("[socwi-supplier-accounting-off-reserve-refused] 100.000 in 1102 and 70.000 reserved by an approved cash payroll: a Rp50.000 payment is still refused with accounting off", async () => {
    const t = await setupSupplier("socwi-s2");
    await fundSupplier1102(t, 100_000);
    await seedPendingCashPayroll(t, 70_000); // available 30.000
    const invoiceId = await supplierInvoice(t);
    const journals = await supplierJournalCount(t);
    const { paymentId, event } = await requestAndApprove(t, invoiceId, 50_000);

    await withModuleOff(aparOwner, t.world.tenantId, async () => {
      await consume(t, event);
    });

    await expectRefusedAndUntouched(t, invoiceId, paymentId, journals, 100_000);
  }, 120_000);
});

// ---- 2. retry of a parked petty cash return, accounting off ------------------------

const movement = (
  kind: "topup" | "return",
  amountIdr: number,
  outletId: string,
) =>
  finance.client
    .post(MOVEMENTS)
    .set(originHeader)
    .send({
      kind,
      outletId,
      bankAccountId,
      amountIdr,
      description: kind === "topup" ? "Isi kas kecil socwi" : "Setor socwi",
      idempotencyKey: key(),
    });

const retryPost = (entryId: string) =>
  finance.client.post(`${ENTRIES}/${entryId}/post`).set(originHeader).send({});

async function journalsOfKey(entryId: string): Promise<number> {
  const { rows } = await kitOwner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2 AND idempotency_key = $3",
    [tenantId, W.entityId(), `pc:${entryId}`],
  );
  return Number(rows[0]!.n);
}

async function entryStatus(entryId: string): Promise<string> {
  const { rows } = await kitOwner.query<{ s: string }>(
    "SELECT journal_status AS s FROM petty_cash_entries WHERE tenant_id = $1 AND id = $2",
    [tenantId, entryId],
  );
  return rows[0]!.s;
}

/** Runs `work` with the entity's petty_cash mapping removed, then restores it. */
async function withoutPettyMapping<T>(work: () => Promise<T>): Promise<T> {
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

describe("socwi retry of a parked petty cash return does not depend on the accounting flag", () => {
  it("[socwi-return-retry-accounting-off-refused] top-up 100.000 and return 50.000 parked, mapping added, accounting off: the return retry before the top-up posts is refused, stays parked (journal 0, GL unchanged); after the top-up posts the retry succeeds exactly once", async () => {
    await drain();
    try {
      const outletId = await makeOutlet(W.entityId());
      outlets.push(outletId);
      const { topId, returnId } = await withoutPettyMapping(async () => {
        const top = await movement("topup", 100_000, outletId);
        expect(top.status, JSON.stringify(top.body)).toBe(201);
        expect(top.body.data.journalStatus).toBe("parked");
        const ret = await movement("return", 50_000, outletId);
        expect(ret.status, JSON.stringify(ret.body)).toBe(201);
        expect(ret.body.data.journalStatus).toBe("parked");
        return {
          topId: top.body.data.id as string,
          returnId: ret.body.data.id as string,
        };
      });
      const base = await glBalance();

      const early = await accountingOff(() => retryPost(returnId));
      expectGlRefusal(early);
      expect(await entryStatus(returnId), "still parked").toBe("parked");
      expect(await journalsOfKey(returnId), "no journal").toBe(0);
      expect(await glBalance(), "GL 1102 unchanged").toBe(base);

      const top = await retryPost(topId);
      expect(top.status, JSON.stringify(top.body)).toBeLessThan(300);
      expect(await glBalance(), "premise: the top-up reached 1102").toBe(
        base + 100_000,
      );

      const late = await accountingOff(() => retryPost(returnId));
      expect(late.status, JSON.stringify(late.body)).toBeLessThan(300);
      expect(late.body.data.journalStatus).toBe("posted");
      expect(await journalsOfKey(returnId), "exactly one journal").toBe(1);
      expect(await glBalance()).toBe(base + 50_000);

      const replay = await accountingOff(() => retryPost(returnId));
      expect(replay.status, JSON.stringify(replay.body)).toBeLessThan(300);
      expect(await journalsOfKey(returnId), "replay adds nothing").toBe(1);
      expect(await glBalance()).toBe(base + 50_000);
    } finally {
      // A failing run must not leave GL 1102 negative for the next test.
      await restoreBaseline();
    }
  }, 180_000);
});

// ---- 3. cash out and transfer from a bank account that is GL 1102 -------------------

const cashOutBody = (amountIdr: number) => ({
  kind: "cash_out",
  legalEntityId: W.entityId(),
  bankAccountId: pettyBankId,
  counterAccountId: expenseId,
  amountIdr,
  entryDate: daysAgo(0),
  description: "Bayar uji socwi",
  reference: `REF-${short()}`,
  idempotencyKey: key(),
});

const transferBody = (amountIdr: number) => ({
  kind: "transfer",
  legalEntityId: W.entityId(),
  fromBankAccountId: pettyBankId,
  toBankAccountId: otherBankId,
  amountIdr,
  entryDate: daysAgo(0),
  description: "Pindah uji socwi",
  reference: `REF-${short()}`,
  idempotencyKey: key(),
});

const postCashBank = (body: object) =>
  finance.client.post(CASH_BANK).set(originHeader).send(body);

describe("socwi cash out and transfer from a bank account on GL 1102, accounting off", () => {
  it("[socwi-cash-out-accounting-off-refused] a Rp50.000 cash out from a 1102 bank account while 1102 holds Rp30.000 and accounting is off is refused 422 PETTY_CASH_GL_INSUFFICIENT: no entry, no journal, GL unchanged", async () => {
    try {
      await drain();
      await W.fundPettyCash(30_000);
      const entries = await cashBankEntryCount();
      const journals = await journalCount();

      const res = await accountingOff(() => postCashBank(cashOutBody(50_000)));

      expectGlRefusal(res);
      expect(await cashBankEntryCount(), "no entry").toBe(entries);
      expect(await journalCount(), "no journal").toBe(journals);
      expect(await glBalance(), "1102 never negative").toBe(committed + 30_000);
    } finally {
      await restoreBaseline();
    }
  }, 120_000);

  it("[socwi-transfer-accounting-off-refused] a Rp50.000 transfer out of a 1102 bank account while 1102 holds Rp30.000 and accounting is off is refused 422 PETTY_CASH_GL_INSUFFICIENT: no entry, no journal, GL unchanged", async () => {
    try {
      await drain();
      await W.fundPettyCash(30_000);
      const entries = await cashBankEntryCount();
      const journals = await journalCount();

      const res = await accountingOff(() => postCashBank(transferBody(50_000)));

      expectGlRefusal(res);
      expect(await cashBankEntryCount(), "no entry").toBe(entries);
      expect(await journalCount(), "no journal").toBe(journals);
      expect(await glBalance(), "1102 never negative").toBe(committed + 30_000);
    } finally {
      await restoreBaseline();
    }
  }, 120_000);
});

// ---- 4. kasbon / reimbursement events: off at emit is never journaled ---------------

async function makeEmployee() {
  const id = randomUUID();
  employeeIds.push(id);
  await kitOwner.query(
    `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                            legal_entity_id, employment_type, join_date, status)
     VALUES ($1, $2, $3, 'Karyawan socwi', $4, $5, 'pkwtt', '2025-03-01', 'active')`,
    [
      id,
      tenantId,
      `SC-${id.slice(0, 8).toUpperCase()}`,
      fixtureOutlet.id,
      W.entityId(),
    ],
  );
  return id;
}

async function seedLoan(employeeId: string, principal: number) {
  const id = randomUUID();
  loanIds.push(id);
  await kitOwner.query(
    `INSERT INTO employee_loans
       (id, tenant_id, employee_id, principal_idr, installment_idr, installment_count,
        outstanding_idr, first_deduction_period, reason, status, decided_by, decided_at)
     VALUES ($1, $2, $3, $4, $5, 10, $4, '2026-12-01', 'Kasbon uji socwi', 'approved', $6, now())`,
    [id, tenantId, employeeId, principal, Math.ceil(principal / 10), DECIDER],
  );
  return id;
}

async function seedClaim(employeeId: string, amount: number) {
  const id = randomUUID();
  claimIds.push(id);
  await kitOwner.query(
    `INSERT INTO reimbursements
       (id, tenant_id, employee_id, category_id, expense_date, amount_idr, approved_amount_idr,
        description, payout, status, decided_by, decided_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6, 'Klaim uji socwi', 'cash', 'approved', $7, now())`,
    [id, tenantId, employeeId, categoryId, aparToday(), amount, DECIDER],
  );
  return id;
}

const disburse = (loanId: string) =>
  hr.client
    .post(`${LOANS}/${loanId}/disburse`)
    .set(originHeader)
    .send({ idempotencyKey: `payout-gl-socwi-${randomUUID()}` });

const payClaim = (claimId: string) =>
  approver.client
    .post(`${CLAIMS}/${claimId}/pay`)
    .set(originHeader)
    .send({ idempotencyKey: `payout-gl-socwi-${randomUUID()}` });

async function outboxEventOf(name: string, id: string): Promise<unknown> {
  const { rows } = await kitOwner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = $2 AND event::text LIKE '%' || $3 || '%'`,
    [tenantId, name, id],
  );
  expect(rows, `exactly one ${name} outbox event`).toHaveLength(1);
  return rows[0]!.event;
}

async function markDelivered(name: string, id: string) {
  await kitOwner.query(
    `UPDATE domain_event_outbox SET status = 'delivered', delivered_at = now()
      WHERE tenant_id = $1 AND event->>'name' = $2 AND event::text LIKE '%' || $3 || '%'`,
    [tenantId, name, id],
  );
}

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

const payloadOf = (event: unknown) =>
  (event as { payload?: Record<string, unknown> }).payload ?? {};

describe("socwi a cash payment made with accounting off is never journaled, even if accounting is on at consume time", () => {
  it("[socwi-loan-off-at-emit-on-at-consume-ignored] a cash kasbon paid with accounting off (flag false), consumed after accounting is turned on: ignored, no journal, GL 1102 untouched and not reserved", async () => {
    try {
      await drain(); // 1102 holds nothing: any credit would make it negative
      await ensureMapping("employee_receivable", "1204");
      const loan = await seedLoan(await makeEmployee(), 40_000);
      const paid = await accountingOff(() => disburse(loan));
      expect(paid.status, JSON.stringify(paid.body)).toBe(200);
      const stored = await outboxEventOf("employee_loan.disbursed", loan);
      expect(
        payloadOf(stored).accountingOnAtEmit,
        "accounting was off when paid",
      ).toBe(false);
      const event = employeeLoanDisbursed.envelopeSchema.parse(stored);
      const journals = await journalCount();
      const gl = await glBalance();

      // Accounting is ON now (the normal state of the test tenant).
      const result = await deliverToGl(event);
      await markDelivered("employee_loan.disbursed", loan);

      expect(result.status).toBe("ignored");
      expect(await W.countJournals(`payroll-gl:loan:${loan}`)).toBe(0);
      expect(await journalCount(), "no journal").toBe(journals);
      expect(await glBalance(), "1102 untouched, never negative").toBe(gl);
      // An ignored event is not kept as a pending 1102 credit: the cash in
      // 1102 can still be committed in full.
      await drain();
    } finally {
      await restoreBaseline();
    }
  }, 90_000);

  it("[socwi-reimb-off-at-emit-on-at-consume-ignored] a cash claim paid with accounting off (flag false), consumed after accounting is turned on: ignored, no journal, GL 1102 untouched and not reserved", async () => {
    try {
      await drain();
      const claim = await seedClaim(await makeEmployee(), 40_000);
      const paid = await accountingOff(() => payClaim(claim));
      expect(paid.status, JSON.stringify(paid.body)).toBe(200);
      const stored = await outboxEventOf("reimbursement.paid", claim);
      expect(
        payloadOf(stored).accountingOnAtEmit,
        "accounting was off when paid",
      ).toBe(false);
      const event = reimbursementPaid.envelopeSchema.parse(stored);
      const journals = await journalCount();
      const gl = await glBalance();

      const result = await deliverToGl(event);
      await markDelivered("reimbursement.paid", claim);

      expect(result.status).toBe("ignored");
      expect(await W.countJournals(`payroll-gl:reimbursement:${claim}`)).toBe(
        0,
      );
      expect(await journalCount(), "no journal").toBe(journals);
      expect(await glBalance(), "1102 untouched, never negative").toBe(gl);
      await drain();
    } finally {
      await restoreBaseline();
    }
  }, 90_000);
});
