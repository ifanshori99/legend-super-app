// Supplier payment always needs two people (bead legend-ycb4h, finding F2 of
// docs/qa/second-opinion-supplier-payout.md). Founder decision Q27 (final): a
// supplier payment ALWAYS needs a second, different person, for every amount,
// also for a tenant with a single Owner. A threshold may only ADD levels; at
// least one approval by someone other than the requester always applies.
// Written fail-first from that decision, the shared approval matrix contract
// (packages/shared/src/access/approval.ts) and the HTTP conventions of
// supplier-payment-approval.test.ts, not from the implementation. The old file
// is left untouched.
//
// Ids used in test names:
// - TP-1 a sole Owner cannot pay a supplier alone, small or large, and cannot
//        approve their own request: pending, no settlement, no journal
// - TP-2 a threshold above 0 saved through PUT /api/access/approval-policies
//        (with a base tier that adds levels) still holds the Owner's payment
// - TP-3 a PUT that loosens (positive threshold, no tier that requires
//        approval from Rp 0) is refused and the matrix is left unchanged
// - TP-4 a tenant that already has a positive-threshold policy (legacy row)
//        still needs another person below the threshold
// - TP-5 another tenant is never touched by any of the above
//
// Assumptions (the spec does not pin these down):
// - Routes and body as in supplier-payment-approval.test.ts. The matrix is
//   saved with `PUT /api/access/approval-policies`, body `{ policies: [{
//   actionType, thresholdIdr, approverRoleId, levels }] }`, answering 200 with
//   the saved rows; a refused matrix answers 400, 409 or 422 (the existing
//   matrix test uses 422 for an invalid matrix). The control `200` calls below
//   prove the caller may use the route, so a refusal is about the matrix, not
//   about permission.
// - "Loosening" means a supplier_payment matrix where a payment of Rp 1 would
//   not open a chain: every tier has a threshold above 0 (no tier from 0 or
//   null).
// - "Sole Owner": the only user holding the `owner` template role. The tenant
//   also has its usual finance and approver users (fixtures), so the Owner is
//   the requester and the second person who could approve is someone else; the
//   point pinned is that the Owner alone never settles anything.
// - Tenants are seeded (seedTenantRoleTemplates), so the default matrix applies
//   (limit 0, finance and owner approve) until a test changes it.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_TEMPLATES } from "@starter/shared/access";
import { tenantIdSchema } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { approvalResolvedEvent } from "@starter/shared/identity";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { seedTenantRoleTemplates } from "../services/access.service.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { setPurchaseReturnPostingEnabled } from "../services/purchase-return.service.ts";
import { setSupplierInvoicePostingEnabled } from "../services/purchasing-invoice.service.ts";
import { decideApprovalRequest } from "../services/platform-approval.service.ts";
import { handlePurchasingApprovalResolved } from "../services/purchasing-approval-consumer.ts";
import { originHeader, verifySessionMfa } from "./helpers.ts";
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
/** A positive floor used to build the "threshold above 0" configurations. */
const LIMIT = 50_000;

type Tenant = {
  world: World;
  bankAccountId: string;
  financeRoleId: string;
  ownerRoleId: string;
  buyer: Session;
  warehouse: Session;
  finance: Session;
  approver: Session;
  /** The only holder of the owner template role. */
  soleOwner: Session;
};

// ---- fixtures --------------------------------------------------------------

async function templateRoleId(world: World, templateKey: string) {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [world.tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} template role`);
  return rows[0].id;
}

async function assignTemplate(
  world: World,
  userId: string,
  roleId: string,
): Promise<void> {
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
    [world.tenantId, userId, roleId],
  );
}

/**
 * A seeded tenant (default supplier_payment matrix: limit 0, one level, finance
 * and owner approve) with one finance approver, a buyer, a warehouse user and a
 * sole Owner. With `legacy`, the default matrix is replaced by one positive
 * tier (the old "below the limit pays at once" configuration), written straight
 * to the database as an old tenant may still have it.
 */
async function setupTenant(
  label: string,
  options: { legacyLimit?: number } = {},
): Promise<Tenant> {
  const world = await createWorld(label);
  await withTenant(db, contextFor(world, null), (tx) =>
    seedTenantRoleTemplates(tx, world.tenantId),
  );
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
  const financeRoleId = await templateRoleId(world, "finance");
  const ownerRoleId = await templateRoleId(world, "owner");
  const approver = await addUser(world, `${label} approver`, []);
  await assignTemplate(world, approver.userId, financeRoleId);
  const soleOwner = await addUser(world, `${label} sole owner`, []);
  await assignTemplate(world, soleOwner.userId, ownerRoleId);

  if (options.legacyLimit !== undefined) {
    // Same shape as the old fixtures: one tier from `legacyLimit`, one level,
    // approver = a general manager custom role, as the old test did.
    const template = ROLE_TEMPLATES.find((t) => t.key === "general_manager")!;
    const gmRoleId = randomUUID();
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'Uji general manager', false, NULL, $3, false, $4)`,
      [
        gmRoleId,
        world.tenantId,
        JSON.stringify(template.permissions),
        JSON.stringify(["tenant", "brand", "outlet", "station"]),
      ],
    );
    const gm = await addUser(world, `${label} gm`, []);
    await assignTemplate(world, gm.userId, gmRoleId);
    await owner.query(
      "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'supplier_payment'",
      [world.tenantId],
    );
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
       VALUES ($1, 'supplier_payment', $2, $3, 1, true)`,
      [world.tenantId, options.legacyLimit, gmRoleId],
    );
    return {
      world,
      bankAccountId,
      financeRoleId,
      ownerRoleId,
      approver: gm,
      buyer: await addUser(world, `${label} buyer`, [
        { role: "purchasing", outletId: world.outletId },
      ]),
      warehouse: await addUser(world, `${label} warehouse`, [
        { role: "warehouse", outletId: world.outletId },
      ]),
      finance: await addUser(world, `${label} finance`, [
        { role: "finance", outletId: null },
      ]),
      soleOwner,
    };
  }
  return {
    world,
    bankAccountId,
    financeRoleId,
    ownerRoleId,
    approver,
    buyer: await addUser(world, `${label} buyer`, [
      { role: "purchasing", outletId: world.outletId },
    ]),
    warehouse: await addUser(world, `${label} warehouse`, [
      { role: "warehouse", outletId: world.outletId },
    ]),
    finance: await addUser(world, `${label} finance`, [
      { role: "finance", outletId: null },
    ]),
    soleOwner,
  };
}

/** A matched (payable) invoice of Rp 100.000. */
async function invoiceFor(t: Tenant): Promise<string> {
  const po = await receive(t.world, t.warehouse, await seedPo(t.world));
  const res = await createInvoice(
    t.world,
    t.buyer,
    invoiceBody(t.world, po, {}),
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return invoiceIdOf(res);
}

// ---- HTTP ------------------------------------------------------------------

const payPath = (invoiceId: string) =>
  `/supplier-invoices/${invoiceId}/payments`;

const requestPayment = (
  t: Tenant,
  who: Session,
  invoiceId: string,
  amountIdr: number,
) =>
  api.post(t.world, who, payPath(invoiceId), {
    amountIdr,
    paidOn: today(),
    idempotencyKey: key(),
  });

const dataOf = (res: { body: unknown }) =>
  (res.body as { data: { id: string; status: string } }).data;

function expectAccepted(res: { status: number; body: unknown }) {
  expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
}

type PolicyInput = {
  actionType: "supplier_payment";
  thresholdIdr: number | null;
  approverRoleId: string;
  levels: number;
};

// PUT /api/access/approval-policies is a back-office write: the session must
// have verified a second factor (403 MFA_REQUIRED otherwise). Mark it verified
// once per user, as cash-out-approve-matrix-bypass.test.ts does.
const mfaVerified = new Set<string>();

async function putPolicies(t: Tenant, who: Session, policies: PolicyInput[]) {
  if (!mfaVerified.has(who.email)) {
    await verifySessionMfa(who.email);
    mfaVerified.add(who.email);
  }
  return who.client
    .put("/api/access/approval-policies")
    .set(originHeader)
    .set("Host", t.world.hostname)
    .send({ policies });
}

const row = (
  thresholdIdr: number | null,
  approverRoleId: string,
  levels: number,
): PolicyInput => ({
  actionType: "supplier_payment",
  thresholdIdr,
  approverRoleId,
  levels,
});

/** Rejected matrix: not 2xx, and not an auth problem (the control proves that). */
function expectMatrixRefused(res: { status: number; body: unknown }) {
  expect([400, 409, 422], JSON.stringify(res.body)).toContain(res.status);
}

// ---- DB reads (migration owner, RLS bypassed) ------------------------------

type PaymentRow = {
  id: string;
  status: string;
  requested_by: string;
  approval_chain_id: string | null;
};

async function paymentRows(
  t: Tenant,
  invoiceId?: string,
): Promise<PaymentRow[]> {
  const { rows } = await owner.query<PaymentRow>(
    `SELECT id, status, requested_by, approval_chain_id
       FROM supplier_payments
      WHERE tenant_id = $1 AND ($2::uuid IS NULL OR supplier_invoice_id = $2)
      ORDER BY created_at, id`,
    [t.world.tenantId, invoiceId ?? null],
  );
  return rows;
}

const statusesOf = async (t: Tenant, invoiceId: string) =>
  (await paymentRows(t, invoiceId)).map((r) => r.status);

async function outstanding(t: Tenant, invoiceId: string): Promise<number> {
  const { rows } = await owner.query<{ outstanding: string }>(
    `SELECT (original_idr - settled_idr)::text AS outstanding
       FROM accounting_open_items
      WHERE tenant_id = $1 AND kind = 'payable' AND id = $2`,
    [t.world.tenantId, invoiceId],
  );
  return Number(rows[0]!.outstanding);
}

async function paymentJournalCount(t: Tenant): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM journal_entries
      WHERE tenant_id = $1 AND source_type = 'supplier_payment'`,
    [t.world.tenantId],
  );
  return rows[0]!.n;
}

type PolicyRow = {
  threshold: number | null;
  level: number;
  approver_role_id: string;
};

async function policyRows(t: Tenant): Promise<PolicyRow[]> {
  const { rows } = await owner.query<PolicyRow>(
    `SELECT threshold_idr::int AS threshold, levels AS level, approver_role_id
       FROM approval_policies
      WHERE tenant_id = $1 AND action_type = 'supplier_payment'
      ORDER BY threshold_idr NULLS FIRST, levels, approver_role_id`,
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

function decide(
  t: Tenant,
  who: Session,
  chainId: string,
  decision: "approved" | "rejected",
) {
  return decideApprovalRequest(
    tenantContextOf(t),
    who.userId,
    chainId,
    { decision, reason: "Sesuai tagihan dan bukti pemasok." },
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

/** The requester must wait: pending, chain open, nothing settled or journalled. */
async function expectHeld(
  t: Tenant,
  who: Session,
  invoiceId: string,
  amountIdr: number,
): Promise<string> {
  const journalsBefore = await paymentJournalCount(t);
  const outstandingBefore = await outstanding(t, invoiceId);
  const res = await requestPayment(t, who, invoiceId, amountIdr);
  expectAccepted(res);
  expect(dataOf(res).status, `amount ${amountIdr}`).toBe("pending_approval");
  const created = (await paymentRows(t, invoiceId)).find(
    (r) => r.id === dataOf(res).id,
  );
  expect(created?.requested_by).toBe(who.userId);
  expect(created?.approval_chain_id).toBeTruthy();
  expect(await paymentJournalCount(t)).toBe(journalsBefore);
  expect(await outstanding(t, invoiceId)).toBe(outstandingBefore);
  return created!.approval_chain_id!;
}

/** The requester's own decision is refused and nothing moves. */
async function expectCannotSelfApprove(
  t: Tenant,
  who: Session,
  chainId: string,
  invoiceId: string,
) {
  const journalsBefore = await paymentJournalCount(t);
  const error = await decide(t, who, chainId, "approved").then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "self approval must be refused").not.toBeNull();
  expect(await statusesOf(t, invoiceId)).not.toContain("paid");
  expect(await paymentJournalCount(t)).toBe(journalsBefore);
}

// ---- setup -----------------------------------------------------------------

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  setPurchaseReturnPostingEnabled(true);
  setSupplierInvoicePostingEnabled(true);
});

afterAll(async () => {
  setSupplierInvoicePostingEnabled(null);
  setPurchaseReturnPostingEnabled(null);
  setAuditWriter(null);
  await appPool.end();
  await owner.end();
});

describe("legend-ycb4h supplier payment always needs a second person", () => {
  it("TP-1 a sole Owner cannot pay a supplier alone, at any amount, and cannot approve their own request", async () => {
    const t = await setupTenant("tp-1");
    const invoiceId = await invoiceFor(t);

    // Rp 1, a small and a large amount: all wait for another person.
    const first = await expectHeld(t, t.soleOwner, invoiceId, 1);
    await expectHeld(t, t.soleOwner, invoiceId, 20_000);
    await expectHeld(t, t.soleOwner, invoiceId, 70_000);
    expect(await statusesOf(t, invoiceId)).toEqual([
      "pending_approval",
      "pending_approval",
      "pending_approval",
    ]);
    expect(await paymentJournalCount(t)).toBe(0);
    expect(await outstanding(t, invoiceId)).toBe(PAYABLE);

    // The Owner cannot approve their own request: still nothing settled.
    await expectCannotSelfApprove(t, t.soleOwner, first, invoiceId);
    expect(await statusesOf(t, invoiceId)).not.toContain("paid");
    expect(await paymentJournalCount(t)).toBe(0);
    expect(await outstanding(t, invoiceId)).toBe(PAYABLE);

    // Control: a different person approves, and exactly one journal is posted.
    await decide(t, t.approver, first, "approved");
    await applyResolved(t, first);
    expect(await paymentJournalCount(t)).toBe(1);
    expect(await outstanding(t, invoiceId)).toBe(PAYABLE - 1);
  });

  it("TP-2 a positive threshold saved through PUT approval-policies still holds the Owner's payment", async () => {
    const t = await setupTenant("tp-2");
    const invoiceId = await invoiceFor(t);

    // A threshold may only ADD a level: from Rp 0 one approver (finance or
    // owner), from LIMIT two levels. Assumed valid: contiguous levels, base tier.
    const saved = await putPolicies(t, t.soleOwner, [
      row(0, t.financeRoleId, 1),
      row(0, t.ownerRoleId, 1),
      row(LIMIT, t.financeRoleId, 1),
      row(LIMIT, t.ownerRoleId, 2),
    ]);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);

    // Below and above the positive threshold the sole Owner still cannot pay.
    const small = await expectHeld(t, t.soleOwner, invoiceId, 20_000);
    await expectHeld(t, t.soleOwner, invoiceId, 30_000);
    expect(await paymentJournalCount(t)).toBe(0);
    expect(await outstanding(t, invoiceId)).toBe(PAYABLE);
    await expectCannotSelfApprove(t, t.soleOwner, small, invoiceId);

    expect(await paymentRows(t, invoiceId)).toHaveLength(2);
  });

  it("TP-3 a PUT that lets one person pay alone is refused and the matrix stays as it was", async () => {
    const t = await setupTenant("tp-3");
    const invoiceId = await invoiceFor(t);

    // Control: a valid matrix (everything from Rp 0 needs one approval) is
    // accepted, so a refusal below is about the matrix, not permission.
    const control = await putPolicies(t, t.soleOwner, [
      row(0, t.financeRoleId, 1),
      row(0, t.ownerRoleId, 1),
    ]);
    expect(control.status, JSON.stringify(control.body)).toBe(200);
    const before = await policyRows(t);
    expect(before.length).toBeGreaterThanOrEqual(2);
    for (const r of before) expect(r.threshold).toBe(0);

    // Loosening: a payment below LIMIT would need nobody. Refused.
    expectMatrixRefused(
      await putPolicies(t, t.soleOwner, [row(LIMIT, t.financeRoleId, 1)]),
    );
    expectMatrixRefused(
      await putPolicies(t, t.soleOwner, [
        row(LIMIT, t.financeRoleId, 1),
        row(LIMIT, t.ownerRoleId, 1),
      ]),
    );
    // Very high floor: the same loophole in disguise.
    expectMatrixRefused(
      await putPolicies(t, t.soleOwner, [
        row(1_000_000_000_000, t.ownerRoleId, 1),
      ]),
    );
    expect(await policyRows(t)).toEqual(before);

    // The payment rule is unchanged: the Owner's Rp 20.000 still waits.
    await expectHeld(t, t.soleOwner, invoiceId, 20_000);
    expect(await paymentJournalCount(t)).toBe(0);
  });

  it("TP-4 a tenant with an old positive-threshold policy still needs another person below the threshold", async () => {
    const t = await setupTenant("tp-4", { legacyLimit: LIMIT });
    const invoiceId = await invoiceFor(t);

    // Below the threshold the payment used to settle at once with one person.
    const chainId = await expectHeld(t, t.finance, invoiceId, 20_000);
    expect(await statusesOf(t, invoiceId)).toEqual(["pending_approval"]);
    expect(await paymentJournalCount(t)).toBe(0);
    expect(await outstanding(t, invoiceId)).toBe(PAYABLE);

    // The requester cannot approve; another person does, then one journal.
    await expectCannotSelfApprove(t, t.finance, chainId, invoiceId);
    await decide(t, t.approver, chainId, "approved");
    await applyResolved(t, chainId);
    expect(await statusesOf(t, invoiceId)).toEqual(["paid"]);
    expect(await paymentJournalCount(t)).toBe(1);
    expect(await outstanding(t, invoiceId)).toBe(PAYABLE - 20_000);
  });

  it("TP-5 another tenant is never touched: its matrix, payments and journals stay the same", async () => {
    const mine = await setupTenant("tp-5-mine");
    const other = await setupTenant("tp-5-other");
    const otherInvoice = await invoiceFor(other);
    const myInvoice = await invoiceFor(mine);

    const otherPolicies = await policyRows(other);
    expect(otherPolicies.length).toBeGreaterThanOrEqual(2);
    const otherPayments = await paymentRows(other);
    const otherJournals = await paymentJournalCount(other);
    const otherOutstanding = await outstanding(other, otherInvoice);

    // My tenant: a valid change, a refused loosening, an Owner payment.
    expect(
      (
        await putPolicies(mine, mine.soleOwner, [
          row(0, mine.financeRoleId, 1),
          row(0, mine.ownerRoleId, 1),
          row(LIMIT, mine.financeRoleId, 1),
          row(LIMIT, mine.ownerRoleId, 2),
        ])
      ).status,
    ).toBe(200);
    expectMatrixRefused(
      await putPolicies(mine, mine.soleOwner, [
        row(LIMIT, mine.financeRoleId, 1),
      ]),
    );
    await expectHeld(mine, mine.soleOwner, myInvoice, 20_000);

    // The other tenant's Owner cannot reach my tenant through the PUT route:
    // their own host and session only ever change their own matrix.
    expectMatrixRefused(
      await putPolicies(other, other.soleOwner, [
        row(LIMIT, other.financeRoleId, 1),
      ]),
    );

    expect(await policyRows(other)).toEqual(otherPolicies);
    expect(await paymentRows(other)).toEqual(otherPayments);
    expect(await paymentJournalCount(other)).toBe(otherJournals);
    expect(await outstanding(other, otherInvoice)).toBe(otherOutstanding);
    // And the other tenant still behaves by the default: needs a second person.
    await expectHeld(other, other.soleOwner, otherInvoice, 20_000);
  });
});
