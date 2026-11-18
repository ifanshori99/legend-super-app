// SO 1036 finding 2 (bead legend-j6v6v, founder Q27): a supplier payment is
// ALWAYS a two-person action. A tenant matrix whose lowest tier is a positive
// amount (here Rp 50.000) must not let a smaller payment skip the chain.
// Written from docs/qa/second-opinion-payout-kas-1036.md, the shared contract
// (PUT /api/access/approval-policies, approvalRequirementFor semantics, the
// approval.resolved event) and the HTTP conventions of
// supplier-payment-approval.test.ts, not from the implementation.
//
// Ids used in test names:
// - SO2-1 matrix changed via API to a min tier of Rp 50.000; a Rp 10.000
//         payment is NOT paid, no journal, no money moved, a chain exists
// - SO2-2 the requester cannot approve their own payment (even holding the
//         approver role); still nothing paid
// - SO2-3 another person approves: paid once, exactly one balanced journal,
//         paid amount == requested amount (no overpay); replay pays nothing
// - SO2-4 another tenant keeps its own matrix, is not touched, and cannot
//         decide this tenant's chain
//
// Assumptions (the contract is silent):
// - The matrix is saved through `PUT /api/access/approval-policies` by a user
//   holding `access.approval_policy.manage` (custom role, no MFA required).
//   The PUT replaces the whole matrix of the tenant, so it carries only the
//   supplier_payment tier.
// - The below-tier payment answers 200/201 with status `pending_approval`
//   (the SP-14/SP-17 convention) rather than being refused.
// - The approval decision is made through `decideApprovalRequest` and applied
//   by `handlePurchasingApprovalResolved`, as in supplier-payment-approval.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_TEMPLATES } from "@starter/shared/access";
import { tenantIdSchema } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { approvalResolvedEvent } from "@starter/shared/identity";
import { originHeader } from "./helpers.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { setPurchaseReturnPostingEnabled } from "../services/purchase-return.service.ts";
import { setSupplierInvoicePostingEnabled } from "../services/purchasing-invoice.service.ts";
import { decideApprovalRequest } from "../services/platform-approval.service.ts";
import { handlePurchasingApprovalResolved } from "../services/purchasing-approval-consumer.ts";
import {
  addUser,
  api,
  appPool,
  contextFor,
  createInvoice,
  createWorld,
  invoiceBody,
  invoiceIdOf,
  key,
  owner,
  receive,
  seedPo,
  today,
  type Session,
  type World,
} from "./purchasing-apar-helpers.ts";

/** Invoice of 10 kg x Rp 10.000, no tax: payable is Rp 100.000. */
const PAYABLE = 100_000;
/** The lowest (and only) tier of the matrix: from Rp 50.000. */
const MIN_TIER = 50_000;
/** A payment below the tier. */
const SMALL = 10_000;

type Tenant = {
  world: World;
  bankAccountId: string;
  approverRoleId: string;
  /** Requests payments (finance permission). */
  finance: Session;
  /** Requests payments AND holds the approver role (to try self-approval). */
  financeApprover: Session;
  buyer: Session;
  warehouse: Session;
  /** A different person who holds the approver role. */
  approver: Session;
  /** Holds access.approval_policy.manage. */
  admin: Session;
};

let A: Tenant;
let B: Tenant;

// ---- fixtures --------------------------------------------------------------

async function assignRole(t: World, userId: string, roleId: string) {
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
    [t.tenantId, userId, roleId],
  );
}

async function setupTenant(label: string): Promise<Tenant> {
  const world = await createWorld(label);
  const bank = await owner.query<{ id: string }>(
    `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $2, '1103', 'Bank Operasional', 'asset', 'cash_and_equivalents') RETURNING id`,
    [world.tenantId, world.entityId],
  );
  const bankAccountId = bank.rows[0]!.id;
  await owner.query(
    `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
     VALUES ($1, $2, 'bank', $3)`,
    [world.tenantId, world.entityId, bankAccountId],
  );
  const gm = ROLE_TEMPLATES.find((t) => t.key === "general_manager")!;
  const approverRoleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Uji general manager', false, NULL, $3, false, $4)`,
    [
      approverRoleId,
      world.tenantId,
      JSON.stringify(gm.permissions),
      JSON.stringify(["tenant", "brand", "outlet", "station"]),
    ],
  );
  const adminRoleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Uji admin matriks', false, NULL, $3, false, $4)`,
    [
      adminRoleId,
      world.tenantId,
      JSON.stringify([
        "access.approval_policy.manage",
        "access.role.view",
      ]),
      JSON.stringify(["tenant"]),
    ],
  );
  const approver = await addUser(world, `${label} approver`, []);
  await assignRole(world, approver.userId, approverRoleId);
  const admin = await addUser(world, `${label} admin`, []);
  await assignRole(world, admin.userId, adminRoleId);
  const financeApprover = await addUser(world, `${label} finance approver`, [
    { role: "finance", outletId: null },
  ]);
  await assignRole(world, financeApprover.userId, approverRoleId);
  return {
    world,
    bankAccountId,
    approverRoleId,
    approver,
    admin,
    financeApprover,
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

/** Saves the whole matrix through the public API: one supplier_payment tier. */
async function saveMatrixViaApi(t: Tenant, thresholdIdr: number) {
  const res = await t.admin.client
    .put("/api/access/approval-policies")
    .set(originHeader)
    .set("Host", t.world.hostname)
    .send({
      policies: [
        {
          actionType: "supplier_payment",
          thresholdIdr,
          approverRoleId: t.approverRoleId,
          levels: 1,
        },
      ],
    });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const rows = (res.body as { data: { thresholdIdr: number | null }[] }).data;
  expect(rows.map((row) => row.thresholdIdr)).toEqual([thresholdIdr]);
}

/** A matched (payable) invoice of Rp 100.000. */
async function invoiceFor(t: Tenant): Promise<string> {
  const po = await receive(t.world, t.warehouse, await seedPo(t.world));
  const res = await createInvoice(t.world, t.buyer, invoiceBody(t.world, po));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return invoiceIdOf(res);
}

// ---- HTTP + DB reads -------------------------------------------------------

const requestPayment = (
  t: Tenant,
  who: Session,
  invoiceId: string,
  amountIdr: number,
) =>
  api.post(t.world, who, `/supplier-invoices/${invoiceId}/payments`, {
    amountIdr,
    paidOn: today(),
    idempotencyKey: key(),
  });

type PaymentRow = {
  id: string;
  status: string;
  amount_idr: string;
  requested_by: string;
  approval_chain_id: string | null;
};

async function paymentRows(t: Tenant, invoiceId: string) {
  const { rows } = await owner.query<PaymentRow>(
    `SELECT id, status, amount_idr::text, requested_by, approval_chain_id
       FROM supplier_payments
      WHERE tenant_id = $1 AND supplier_invoice_id = $2 ORDER BY created_at`,
    [t.world.tenantId, invoiceId],
  );
  return rows;
}

async function outstanding(t: Tenant, invoiceId: string): Promise<number> {
  const { rows } = await owner.query<{ outstanding: string }>(
    `SELECT (original_idr - settled_idr)::text AS outstanding
       FROM accounting_open_items
      WHERE tenant_id = $1 AND kind = 'payable' AND id = $2`,
    [t.world.tenantId, invoiceId],
  );
  return Number(rows[0]!.outstanding);
}

async function paymentJournals(t: Tenant) {
  const { rows } = await owner.query<{
    id: string;
    debit: string;
    credit: string;
    ap_debit: string;
    bank_credit: string;
  }>(
    `SELECT e.id,
            sum(l.debit_idr)::text AS debit,
            sum(l.credit_idr)::text AS credit,
            coalesce(sum(l.debit_idr) FILTER (WHERE l.account_id = $2), 0)::text AS ap_debit,
            coalesce(sum(l.credit_idr) FILTER (WHERE l.account_id = $3), 0)::text AS bank_credit
       FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
      WHERE e.tenant_id = $1 AND e.source_type = 'supplier_payment'
      GROUP BY e.id`,
    [t.world.tenantId, t.world.accounts.accounts_payable, t.bankAccountId],
  );
  return rows.map((row) => ({
    id: row.id,
    debit: Number(row.debit),
    credit: Number(row.credit),
    apDebit: Number(row.ap_debit),
    bankCredit: Number(row.bank_credit),
  }));
}

async function matrixOf(t: Tenant) {
  const { rows } = await owner.query<{ threshold: number; levels: number }>(
    `SELECT threshold_idr::int AS threshold, levels FROM approval_policies
      WHERE tenant_id = $1 AND action_type = 'supplier_payment'
      ORDER BY threshold_idr, levels`,
    [t.world.tenantId],
  );
  return rows;
}

// ---- approval chain --------------------------------------------------------

const tenantContextOf = (t: Tenant) =>
  establishTenantContext({
    tenantId: tenantIdSchema.parse(t.world.tenantId),
    brandId: null,
    source: "domain",
  });

function decide(t: Tenant, who: Session, chainId: string) {
  return decideApprovalRequest(
    tenantContextOf(t),
    who.userId,
    chainId,
    { decision: "approved", reason: "Sesuai tagihan dan bukti pemasok." },
    { mfaVerified: true, idempotencyKey: null },
  );
}

async function applyResolved(t: Tenant, chainId: string) {
  const { rows } = await owner.query<{ event: unknown }>(
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
}

// ---- setup -----------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  setPurchaseReturnPostingEnabled(true);
  setSupplierInvoicePostingEnabled(true);
  A = await setupTenant("so2-a");
  B = await setupTenant("so2-b");
});

afterAll(async () => {
  setSupplierInvoicePostingEnabled(null);
  setPurchaseReturnPostingEnabled(null);
  setAuditWriter(null);
  await appPool.end();
  await owner.end();
});

describe("SO 1036 finding 2: supplier payment is always two-person", () => {
  it("SO2-1 with a minimum tier of Rp 50.000 a Rp 10.000 payment is not paid: no journal, no money moved, a chain exists", async () => {
    await saveMatrixViaApi(A, MIN_TIER);
    const invoiceId = await invoiceFor(A);

    const res = await requestPayment(A, A.finance, invoiceId, SMALL);
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    const data = (res.body as { data: { id: string; status: string } }).data;
    expect(data.status).toBe("pending_approval");

    const rows = await paymentRows(A, invoiceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "pending_approval",
      amount_idr: String(SMALL),
      requested_by: A.finance.userId,
    });
    expect(rows[0]!.approval_chain_id).toBeTruthy();
    expect(await paymentJournals(A)).toEqual([]);
    expect(await outstanding(A, invoiceId)).toBe(PAYABLE);
  });

  it("SO2-2 the requester cannot approve their own payment, even holding the approver role", async () => {
    await saveMatrixViaApi(A, MIN_TIER);
    const invoiceId = await invoiceFor(A);
    const journalsBefore = (await paymentJournals(A)).length;

    const res = await requestPayment(A, A.financeApprover, invoiceId, SMALL);
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    const [row] = await paymentRows(A, invoiceId);
    expect(row!.status).toBe("pending_approval");
    expect(row!.approval_chain_id).toBeTruthy();

    const own = await decide(A, A.financeApprover, row!.approval_chain_id!).then(
      () => null,
      (error: unknown) => error,
    );
    expect(own).not.toBeNull();
    expect((await paymentRows(A, invoiceId)).map((r) => r.status)).toEqual([
      "pending_approval",
    ]);
    expect((await paymentJournals(A)).length).toBe(journalsBefore);
    expect(await outstanding(A, invoiceId)).toBe(PAYABLE);
  });

  it("SO2-3 another person approves: paid once, exactly one balanced journal, paid amount equals the requested amount", async () => {
    await saveMatrixViaApi(A, MIN_TIER);
    const invoiceId = await invoiceFor(A);
    const journalsBefore = (await paymentJournals(A)).map((j) => j.id);

    const res = await requestPayment(A, A.finance, invoiceId, SMALL);
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    const [pending] = await paymentRows(A, invoiceId);
    expect(pending!.status).toBe("pending_approval");
    const chainId = pending!.approval_chain_id;
    expect(chainId).toBeTruthy();

    // The inbox decision of a different person, then the consumer applies it.
    await decide(A, A.approver, chainId!);
    await applyResolved(A, chainId!);

    const rows = await paymentRows(A, invoiceId);
    expect(rows.map((row) => row.status)).toEqual(["paid"]);
    expect(rows[0]!.amount_idr).toBe(String(SMALL));
    const journals = (await paymentJournals(A)).filter(
      (j) => !journalsBefore.includes(j.id),
    );
    expect(journals).toHaveLength(1);
    expect(journals[0]).toMatchObject({
      debit: SMALL,
      credit: SMALL,
      apDebit: SMALL,
      bankCredit: SMALL,
    });
    // No overpay: exactly what was requested left the payable.
    expect(await outstanding(A, invoiceId)).toBe(PAYABLE - SMALL);

    // Replay of the same resolved event pays nothing twice.
    await applyResolved(A, chainId!);
    expect((await paymentRows(A, invoiceId)).map((r) => r.status)).toEqual([
      "paid",
    ]);
    expect(
      (await paymentJournals(A)).filter((j) => !journalsBefore.includes(j.id)),
    ).toHaveLength(1);
    expect(await outstanding(A, invoiceId)).toBe(PAYABLE - SMALL);
  });

  it("SO2-4 another tenant keeps its own matrix and payments, and cannot decide this tenant's chain", async () => {
    // B keeps a matrix of its own (from Rp 0): A's change must not touch it.
    await saveMatrixViaApi(B, 0);
    const bMatrix = await matrixOf(B);
    await saveMatrixViaApi(A, MIN_TIER);
    expect(await matrixOf(B)).toEqual(bMatrix);
    expect(await matrixOf(A)).toEqual([{ threshold: MIN_TIER, levels: 1 }]);

    const invoiceA = await invoiceFor(A);
    const invoiceB = await invoiceFor(B);
    const bJournalsBefore = (await paymentJournals(B)).length;
    const resA = await requestPayment(A, A.finance, invoiceA, SMALL);
    expect([200, 201], JSON.stringify(resA.body)).toContain(resA.status);
    const resB = await requestPayment(B, B.finance, invoiceB, SMALL);
    expect([200, 201], JSON.stringify(resB.body)).toContain(resB.status);
    const [rowA] = await paymentRows(A, invoiceA);
    const [rowB] = await paymentRows(B, invoiceB);
    expect(rowA!.status).toBe("pending_approval");
    expect(rowB!.status).toBe("pending_approval");

    // A's chain is invisible to B's approver (tenant context of B).
    const foreign = await decide(B, B.approver, rowA!.approval_chain_id!).then(
      () => null,
      (error: unknown) => error,
    );
    expect(foreign).not.toBeNull();
    expect((await paymentRows(A, invoiceA)).map((r) => r.status)).toEqual([
      "pending_approval",
    ]);

    // B's own payment is applied in B only; A stays untouched.
    await decide(B, B.approver, rowB!.approval_chain_id!);
    await applyResolved(B, rowB!.approval_chain_id!);
    expect((await paymentRows(B, invoiceB)).map((r) => r.status)).toEqual([
      "paid",
    ]);
    expect((await paymentJournals(B)).length).toBe(bJournalsBefore + 1);
    expect(await outstanding(B, invoiceB)).toBe(PAYABLE - SMALL);
    expect((await paymentRows(A, invoiceA)).map((r) => r.status)).toEqual([
      "pending_approval",
    ]);
    expect(await outstanding(A, invoiceA)).toBe(PAYABLE);
  });
});
