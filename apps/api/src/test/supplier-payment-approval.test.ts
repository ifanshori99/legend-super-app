// Supplier payment with approval (bead legend-xxqz3, brief 991 section A).
// Written fail-first from docs/briefs/991-akuntansi-kas-supplier.md, the shared
// contract (approval matrix, posting rules, approval.resolved event) and the
// existing HTTP conventions, not from the implementation.
//
// Money rules (founder): nobody is paid more than the invoice, never twice
// (also under concurrency), above the policy limit only after a DIFFERENT
// person approved, the journal always balances, and another tenant or outlet
// is never touched. When in doubt the payment is blocked.
//
// Ids used in test names:
// - SP-1  below the limit: paid at once, one balanced journal Dr AP / Cr bank
// - SP-2  above the limit: pending until approved; the consumer pays once
// - SP-3  rejected: no journal, no money moved, the room is released
// - SP-4  the requester can never be the approver (forged decision refused)
// - SP-5  never more than the outstanding amount; bad amounts; held invoice
// - SP-6  pending requests count against the outstanding amount
// - SP-7  two parallel requests that together exceed it: one is refused
// - SP-8  two parallel direct payments that together exceed it: one is refused
// - SP-9  same idempotency key: one payment, one journal
// - SP-10 no supplier_payment policy: blocked (fail closed), nothing written
// - SP-11 other tenant / outlet / role / no session cannot see or pay
// - SP-12 outstanding is recomputed at execution (settled elsewhere meanwhile)
// - SP-14 a new tenant with no configuration pays only after another person
//         (finance or owner template role) approved: default policy, limit 0
// - SP-15 an existing tenant gets the same default from migration 0587
// - SP-16 the requester cannot approve with the default policy either
// - SP-17 even Rp 1 needs approval (limit 0); an approved payment is still
//         never paid above the outstanding amount
// - SP-13 period closed before the approval: rejected with a note, no money,
//         the reserved room is released
//
// Assumptions (the brief does not pin these down):
// - Routes: `POST /api/inventory/supplier-invoices/:id/payments` and
//   `GET /api/inventory/supplier-invoices/:id/payments`, the prefix and guards
//   of the existing supplier-invoice routes. Success answers 200 or 201 with
//   `{ data: { id, status } }`; the list answers `{ data: [...] }` (or
//   `{ data: { items: [...] } }`) of rows with `id` and `status`.
// - Body: `{ amountIdr, paidOn, idempotencyKey }`. The bank account is the
//   chart account mapped to the posting role `bank` of the legal entity (the
//   fixtures map one); no bank field is sent.
// - Over-payment answers 409 or 422 (the open-item settle refuses it); a
//   missing policy answers 409 APPROVAL_POLICY_MISSING (as the purchasing
//   flow); a reused key with another amount answers 409
//   IDEMPOTENCY_KEY_REUSED; another tenant answers 404.
// - Policy semantics follow the platform matrix: an amount at or above the
//   tier's `threshold_idr` opens an approval chain; below the lowest tier no
//   chain is needed and the payment is made at once. Limits used here (50.000)
//   keep every amount far from the boundary.
// - The approval decision alone changes nothing; the `approval.resolved`
//   consumer (`handlePurchasingApprovalResolved`) applies it, as for POs. The
//   consumer refuses (does not pay) when the approver equals `requested_by`,
//   and re-checks the outstanding amount at execution. The refused payment is
//   left unpaid (rejected or pending): only "not paid, no journal" is pinned.
// - SP-13: a payment whose period is closed when the approval executes is
//   settled by the consumer as `rejected` (it does not throw, so the outbox
//   does not retry forever) and the list shows a non-empty `note` (the shared
//   supplierPaymentSchema field) saying why. It runs in its own tenant so the
//   closed period never touches the other tests. Requesting a payment does not
//   check the period (only posting does), so the new full request is accepted.
// - CTO decision: every tenant (new via seedTenantRoleTemplates, old via
//   migration `NNNN_supplier_payment_approval_policies_data.sql`, 0587) has a
//   default `supplier_payment` policy: threshold 0, one level, distinct actor,
//   one row per approver template (at least finance and owner). The tenants of
//   SP-1..SP-13 are built by `createWorld` and are NOT seeded, so they keep
//   their explicit policies and SP-10 (no policy at all) still means blocked.
//   SP-15 runs the migration in a rolled-back transaction (it locks roles and
//   approval_policies and would touch tenants of other suites), reads the rows
//   it wrote, and recreates exactly those rows outside to pay over HTTP.
// - Table columns of `supplier_payments` follow the brief: id, tenant_id,
//   supplier_invoice_id, amount_idr, status, requested_by, approval_chain_id.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
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
import { agent, originHeader } from "./helpers.ts";
import {
  addUser,
  api,
  app,
  appPool,
  codeOf,
  contextFor,
  createInvoice,
  createWorld,
  goodsLine,
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
/** Amounts from this value on need approval (policy tier floor). */
const LIMIT = 50_000;
/** A floor nobody reaches: every payment is made directly. */
const NEVER = 1_000_000_000_000;

type Tenant = {
  world: World;
  bankAccountId: string;
  approverRoleId: string;
  buyer: Session;
  warehouse: Session;
  finance: Session;
  approver: Session;
};

let A: Tenant;
let B: Tenant;
let C: Tenant;
let E: Tenant; // new tenant, default policy from the seed
let outletTwoFinance: Session;
let nobody: Session;

// ---- fixtures --------------------------------------------------------------

async function setupTenant(
  label: string,
  options: { seeded?: boolean } = {},
): Promise<Tenant> {
  const world = await createWorld(label);
  if (options.seeded) {
    // A new tenant as platform provisioning leaves it: role templates and the
    // default approval policies, nothing configured by hand.
    const context = contextFor(world, null);
    await withTenant(db, context, (tx) =>
      seedTenantRoleTemplates(tx, world.tenantId),
    );
  }
  // The bank account that Cr of a supplier payment lands on.
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
  // The approver role named by the policy: the general manager template
  // (custom copy), or the finance template of a seeded tenant.
  const template = ROLE_TEMPLATES.find((t) => t.key === "general_manager")!;
  let approverRoleId: string;
  if (options.seeded) approverRoleId = await templateRoleId(world, "finance");
  else {
    approverRoleId = randomUUID();
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'Uji general manager', false, NULL, $3, false, $4)`,
      [
        approverRoleId,
        world.tenantId,
        JSON.stringify(template.permissions),
        JSON.stringify(["tenant", "brand", "outlet", "station"]),
      ],
    );
  }
  const approver = await addUser(world, `${label} approver`, []);
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
    [world.tenantId, approver.userId, approverRoleId],
  );
  return {
    world,
    bankAccountId,
    approverRoleId,
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
  };
}

async function templateRoleId(world: World, templateKey: string) {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [world.tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} template role`);
  return rows[0].id;
}

/** A user who holds a template role tenant-wide (exact role the matrix names). */
async function templateUser(
  t: Tenant,
  label: string,
  templateKey: string,
): Promise<Session> {
  const who = await addUser(t.world, label, []);
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
    [t.world.tenantId, who.userId, await templateRoleId(t.world, templateKey)],
  );
  return who;
}

type PolicyRow = {
  threshold: number | null;
  level: number;
  template_key: string | null;
  approver_role_id: string;
  requires_distinct_actor: boolean;
};

async function policyRows(
  t: Tenant,
  via: Pick<PoolClient, "query"> = owner,
): Promise<PolicyRow[]> {
  const { rows } = await via.query<PolicyRow>(
    `SELECT p.threshold_idr::int AS threshold, p.levels AS level, r.template_key,
            p.approver_role_id, p.requires_distinct_actor
       FROM approval_policies p JOIN roles r ON r.id = p.approver_role_id
      WHERE p.tenant_id = $1 AND p.action_type = 'supplier_payment'
      ORDER BY r.template_key`,
    [t.world.tenantId],
  );
  return rows;
}

/** The default matrix: from Rp 0, one level, distinct actor, finance and owner. */
function expectDefaultPolicy(rows: PolicyRow[]) {
  expect(rows.length).toBeGreaterThanOrEqual(2);
  for (const row of rows) {
    expect(row.threshold).toBe(0);
    expect(row.level).toBe(1);
    expect(row.requires_distinct_actor).toBe(true);
  }
  const templates = rows.map((row) => row.template_key);
  expect(templates).toContain("finance");
  expect(templates).toContain("owner");
}

/** Runs the 0587 backfill body in a transaction that is always rolled back. */
async function inRolledBackBackfill<T>(
  inspect: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const dir = fileURLToPath(new URL("../../drizzle/", import.meta.url));
  const file = readdirSync(dir).find((name) =>
    /^\d{4}_supplier_payment_approval_policies_data\.sql$/.test(name),
  );
  if (!file)
    throw new Error(
      "Migration supplier_payment_approval_policies_data is missing",
    );
  const statements = readFileSync(`${dir}${file}`, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    for (const statement of statements) await client.query(statement);
    return await inspect(client);
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

/** One tier from `thresholdIdr`, one level, approver = general manager. */
async function setPolicy(t: Tenant, thresholdIdr: number): Promise<void> {
  await clearPolicy(t);
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
     VALUES ($1, 'supplier_payment', $2, $3, 1, true)`,
    [t.world.tenantId, thresholdIdr, t.approverRoleId],
  );
}

async function clearPolicy(t: Tenant): Promise<void> {
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'supplier_payment'",
    [t.world.tenantId],
  );
}

/** A matched (payable) invoice of Rp 100.000, or a held one (price +50%). */
async function invoiceFor(
  t: Tenant,
  options: { held?: boolean } = {},
): Promise<string> {
  const po = await receive(t.world, t.warehouse, await seedPo(t.world));
  const res = await createInvoice(
    t.world,
    t.buyer,
    invoiceBody(
      t.world,
      po,
      options.held ? { lines: [goodsLine(po, po.quantity, "15000.0000")] } : {},
    ),
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return invoiceIdOf(res);
}

// ---- HTTP ------------------------------------------------------------------

const payPath = (invoiceId: string) =>
  `/supplier-invoices/${invoiceId}/payments`;

const payBody = (
  amountIdr: number,
  overrides: Record<string, unknown> = {},
) => ({
  amountIdr,
  paidOn: today(),
  idempotencyKey: key(),
  ...overrides,
});

const requestPayment = (
  t: Tenant,
  who: Session,
  invoiceId: string,
  amountIdr: number,
  overrides: Record<string, unknown> = {},
) => api.post(t.world, who, payPath(invoiceId), payBody(amountIdr, overrides));

const listPayments = (t: Tenant, who: Session, invoiceId: string) =>
  api.get(t.world, who, payPath(invoiceId));

const dataOf = (res: { body: unknown }) =>
  (res.body as { data: { id: string; status: string } }).data;

function rowsOf(res: { body: unknown }): { id: string; status: string }[] {
  const data = (res.body as { data: unknown }).data;
  return (
    Array.isArray(data) ? data : (data as { items: unknown[] }).items
  ) as { id: string; status: string }[];
}

function expectAccepted(res: { status: number; body: unknown }) {
  expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
}

/** Over-payment and parallel loser: refused by the settle rule or the guard. */
function expectRefused(res: { status: number; body: unknown }) {
  expect([409, 422], JSON.stringify(res.body)).toContain(res.status);
}

// ---- DB reads (migration owner, RLS bypassed) ------------------------------

type PaymentRow = {
  id: string;
  status: string;
  amount_idr: string;
  requested_by: string;
  approval_chain_id: string | null;
};

async function paymentRows(
  t: Tenant,
  invoiceId: string,
): Promise<PaymentRow[]> {
  const { rows } = await owner.query<PaymentRow>(
    `SELECT id, status, amount_idr::text, requested_by, approval_chain_id
       FROM supplier_payments
      WHERE tenant_id = $1 AND supplier_invoice_id = $2 ORDER BY created_at`,
    [t.world.tenantId, invoiceId],
  );
  return rows;
}

const statusesOf = async (t: Tenant, invoiceId: string) =>
  (await paymentRows(t, invoiceId)).map((row) => row.status);

async function outstanding(t: Tenant, invoiceId: string): Promise<number> {
  const { rows } = await owner.query<{ outstanding: string }>(
    `SELECT (original_idr - settled_idr)::text AS outstanding
       FROM accounting_open_items
      WHERE tenant_id = $1 AND kind = 'payable' AND id = $2`,
    [t.world.tenantId, invoiceId],
  );
  return Number(rows[0]!.outstanding);
}

async function paymentEntryIds(t: Tenant): Promise<string[]> {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM journal_entries
      WHERE tenant_id = $1 AND source_type = 'supplier_payment' ORDER BY id`,
    [t.world.tenantId],
  );
  return rows.map((row) => row.id);
}

/** Supplier-payment journals written since `before`, with their totals. */
async function newPaymentJournals(t: Tenant, before: string[]) {
  const ids = (await paymentEntryIds(t)).filter((id) => !before.includes(id));
  const { rows } = await owner.query<{
    account_id: string;
    debit: string;
    credit: string;
  }>(
    `SELECT account_id, sum(debit_idr)::text AS debit, sum(credit_idr)::text AS credit
       FROM journal_lines WHERE tenant_id = $1 AND entry_id = ANY($2::uuid[])
      GROUP BY account_id`,
    [t.world.tenantId, ids],
  );
  const of = (accountId: string) => {
    const row = rows.find((r) => r.account_id === accountId);
    return { debit: Number(row?.debit ?? 0), credit: Number(row?.credit ?? 0) };
  };
  return {
    count: ids.length,
    debit: rows.reduce((sum, r) => sum + Number(r.debit), 0),
    credit: rows.reduce((sum, r) => sum + Number(r.credit), 0),
    ap: of(t.world.accounts.accounts_payable),
    bank: of(t.bankAccountId),
  };
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

/** The `approval.resolved` envelope the approval service appended. */
async function resolvedEventOf(t: Tenant, chainId: string) {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND destination = 'cloud-sync'
        AND event->>'name' = 'approval.resolved'
        AND event->'payload'->>'chainId' = $2`,
    [t.world.tenantId, chainId],
  );
  expect(rows).toHaveLength(1);
  return approvalResolvedEvent.envelopeSchema.parse(rows[0]!.event);
}

/** Delivers the resolved event of a chain to the consumer, as the worker does. */
async function applyResolved(t: Tenant, chainId: string) {
  await handlePurchasingApprovalResolved(
    contextFor(t.world, null),
    await resolvedEventOf(t, chainId),
  );
}

/** Requests above the limit, returns the payment id and its chain. */
async function pendingPayment(
  t: Tenant,
  invoiceId: string,
  amountIdr: number,
): Promise<{ id: string; chainId: string }> {
  const res = await requestPayment(t, t.finance, invoiceId, amountIdr);
  expectAccepted(res);
  expect(dataOf(res).status).toBe("pending_approval");
  const row = (await paymentRows(t, invoiceId)).find(
    (r) => r.id === dataOf(res).id,
  );
  expect(row?.approval_chain_id).toBeTruthy();
  return { id: row!.id, chainId: row!.approval_chain_id! };
}

/** Approver decides in the inbox, then the consumer applies it. */
async function approveAndApply(t: Tenant, chainId: string) {
  await decide(t, t.approver, chainId, "approved");
  await applyResolved(t, chainId);
}

// ---- setup -----------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  setPurchaseReturnPostingEnabled(true);
  setSupplierInvoicePostingEnabled(true);
  A = await setupTenant("sp-a");
  B = await setupTenant("sp-b");
  C = await setupTenant("sp-c"); // never gets a supplier_payment policy
  outletTwoFinance = await addUser(A.world, "SP finance outlet 2", [
    { role: "finance", outletId: A.world.outletTwoId },
  ]);
  nobody = await addUser(A.world, "SP nobody", []);
  E = await setupTenant("sp-e", { seeded: true });
  await setPolicy(A, LIMIT);
  await setPolicy(B, LIMIT);
});

afterAll(async () => {
  setSupplierInvoicePostingEnabled(null);
  setPurchaseReturnPostingEnabled(null);
  setAuditWriter(null);
  await appPool.end();
  await owner.end();
});

describe("legend-xxqz3 supplier payment with approval", () => {
  it("SP-1 below the limit the payment is made at once: one balanced journal Dr AP / Cr bank", async () => {
    await setPolicy(A, LIMIT);
    const invoiceId = await invoiceFor(A);
    const before = await paymentEntryIds(A);

    const res = await requestPayment(A, A.finance, invoiceId, 20_000);
    expectAccepted(res);
    expect(dataOf(res).status).toBe("paid");

    const rows = await paymentRows(A, invoiceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: dataOf(res).id,
      status: "paid",
      amount_idr: "20000",
      requested_by: A.finance.userId,
      approval_chain_id: null,
    });
    const journals = await newPaymentJournals(A, before);
    expect(journals.count).toBe(1);
    expect(journals.debit).toBe(20_000);
    expect(journals.credit).toBe(20_000);
    expect(journals.ap).toEqual({ debit: 20_000, credit: 0 });
    expect(journals.bank).toEqual({ debit: 0, credit: 20_000 });
    expect(await outstanding(A, invoiceId)).toBe(PAYABLE - 20_000);
  });

  it("SP-2 above the limit the payment waits for approval; the consumer pays it exactly once", async () => {
    await setPolicy(A, LIMIT);
    const invoiceId = await invoiceFor(A);
    const before = await paymentEntryIds(A);

    const { id, chainId } = await pendingPayment(A, invoiceId, 60_000);
    // Pending: no money moved, nothing journalled, the card is untouched.
    expect((await newPaymentJournals(A, before)).count).toBe(0);
    expect(await outstanding(A, invoiceId)).toBe(PAYABLE);
    const listed = rowsOf(await listPayments(A, A.finance, invoiceId));
    expect(listed).toEqual([
      expect.objectContaining({ id, status: "pending_approval" }),
    ]);

    // The inbox decision alone changes nothing: the consumer applies it.
    await decide(A, A.approver, chainId, "approved");
    expect(await statusesOf(A, invoiceId)).toEqual(["pending_approval"]);
    expect((await newPaymentJournals(A, before)).count).toBe(0);

    await applyResolved(A, chainId);
    expect(await statusesOf(A, invoiceId)).toEqual(["paid"]);
    const journals = await newPaymentJournals(A, before);
    expect(journals.count).toBe(1);
    expect(journals.debit).toBe(60_000);
    expect(journals.credit).toBe(60_000);
    expect(journals.ap).toEqual({ debit: 60_000, credit: 0 });
    expect(journals.bank).toEqual({ debit: 0, credit: 60_000 });
    expect(await outstanding(A, invoiceId)).toBe(PAYABLE - 60_000);
    expect(
      rowsOf(await listPayments(A, A.finance, invoiceId)).map((r) => r.status),
    ).toEqual(["paid"]);

    // Replay of the same resolved event pays nothing twice.
    await applyResolved(A, chainId);
    expect(await statusesOf(A, invoiceId)).toEqual(["paid"]);
    expect((await newPaymentJournals(A, before)).count).toBe(1);
    expect(await outstanding(A, invoiceId)).toBe(PAYABLE - 60_000);
  });

  it("SP-3 a rejected request is never paid, writes no journal, and frees the room", async () => {
    await setPolicy(A, LIMIT);
    const invoiceId = await invoiceFor(A);
    const before = await paymentEntryIds(A);

    const { chainId } = await pendingPayment(A, invoiceId, 60_000);
    await decide(A, A.approver, chainId, "rejected");
    await applyResolved(A, chainId);

    expect(await statusesOf(A, invoiceId)).toEqual(["rejected"]);
    expect((await newPaymentJournals(A, before)).count).toBe(0);
    expect(await outstanding(A, invoiceId)).toBe(PAYABLE);
    // Replay changes nothing.
    await applyResolved(A, chainId);
    expect(await statusesOf(A, invoiceId)).toEqual(["rejected"]);

    // The rejected request no longer counts: the full amount can be requested.
    const again = await requestPayment(A, A.finance, invoiceId, PAYABLE);
    expectAccepted(again);
    expect(dataOf(again).status).toBe("pending_approval");
  });

  it("SP-4 the person who requested a payment can never approve it", async () => {
    await setPolicy(A, LIMIT);
    const invoiceId = await invoiceFor(A);
    const before = await paymentEntryIds(A);
    const { chainId } = await pendingPayment(A, invoiceId, 60_000);

    // A legitimate approver decides; then the decision is forged to say that
    // the requester decided it (the DB distinct-actor check only compares with
    // the row's own requester, so that is rewritten too), event included.
    await decide(A, A.approver, chainId, "approved");
    await owner.query(
      "UPDATE approval_requests SET decided_by = $2, requested_by = $3 WHERE chain_id = $1",
      [chainId, A.finance.userId, A.approver.userId],
    );
    const event = await resolvedEventOf(A, chainId);
    const forged = {
      ...event,
      payload: { ...event.payload, decidedBy: A.finance.userId },
    };
    await handlePurchasingApprovalResolved(
      contextFor(A.world, null),
      forged as never,
    );

    expect(await statusesOf(A, invoiceId)).not.toContain("paid");
    expect((await newPaymentJournals(A, before)).count).toBe(0);
    expect(await outstanding(A, invoiceId)).toBe(PAYABLE);
  });

  it("SP-5 nobody is paid more than the invoice: over-payment, bad amounts and a held invoice are refused", async () => {
    // Direct path (no chain): one rupiah over the outstanding amount.
    await setPolicy(A, NEVER);
    const invoiceId = await invoiceFor(A);
    const before = await paymentEntryIds(A);
    expectRefused(await requestPayment(A, A.finance, invoiceId, PAYABLE + 1));
    // Approval path: refused at request time, no chain left behind.
    await setPolicy(A, LIMIT);
    expectRefused(await requestPayment(A, A.finance, invoiceId, PAYABLE + 1));
    expect(await paymentRows(A, invoiceId)).toHaveLength(0);
    expect((await newPaymentJournals(A, before)).count).toBe(0);
    expect(await outstanding(A, invoiceId)).toBe(PAYABLE);

    // Invalid amounts are 422 and write nothing.
    for (const amountIdr of [0, -5_000, 1.5])
      expect(
        (await requestPayment(A, A.finance, invoiceId, amountIdr)).status,
        String(amountIdr),
      ).toBe(422);
    expect(await paymentRows(A, invoiceId)).toHaveLength(0);

    // Partial payments add up to the outstanding amount, never beyond it.
    await setPolicy(A, NEVER);
    expectAccepted(await requestPayment(A, A.finance, invoiceId, 40_000));
    expect(await outstanding(A, invoiceId)).toBe(60_000);
    expectRefused(await requestPayment(A, A.finance, invoiceId, 70_000));
    expectAccepted(await requestPayment(A, A.finance, invoiceId, 60_000));
    expect(await outstanding(A, invoiceId)).toBe(0);
    expectRefused(await requestPayment(A, A.finance, invoiceId, 1));
    expect(await statusesOf(A, invoiceId)).toEqual(["paid", "paid"]);
    const journals = await newPaymentJournals(A, before);
    expect(journals.count).toBe(2);
    expect(journals.debit).toBe(journals.credit);
    expect(journals.ap.debit).toBe(PAYABLE);
    expect(journals.bank.credit).toBe(PAYABLE);

    // A held invoice has nothing outstanding: it cannot be paid.
    const held = await invoiceFor(A, { held: true });
    const heldRes = await requestPayment(A, A.finance, held, 10_000);
    expect(heldRes.status, JSON.stringify(heldRes.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect(await paymentRows(A, held)).toHaveLength(0);
    expect((await newPaymentJournals(A, before)).count).toBe(2);
  });

  it("SP-6 requests waiting for approval count against the outstanding amount", async () => {
    await setPolicy(A, LIMIT);
    const invoiceId = await invoiceFor(A);
    const before = await paymentEntryIds(A);

    const first = await pendingPayment(A, invoiceId, 60_000);
    // 60.000 pending + 50.000 would exceed Rp 100.000: refused.
    expectRefused(await requestPayment(A, A.finance, invoiceId, 50_000));
    expect(await paymentRows(A, invoiceId)).toHaveLength(1);
    // Exactly the rest is allowed.
    const second = await pendingPayment(A, invoiceId, 40_000);
    expectRefused(await requestPayment(A, A.finance, invoiceId, 1));

    await approveAndApply(A, first.chainId);
    await approveAndApply(A, second.chainId);
    expect(await statusesOf(A, invoiceId)).toEqual(["paid", "paid"]);
    expect(await outstanding(A, invoiceId)).toBe(0);
    const journals = await newPaymentJournals(A, before);
    expect(journals.count).toBe(2);
    expect(journals.debit).toBe(PAYABLE);
    expect(journals.credit).toBe(PAYABLE);
  });

  it("SP-7 two parallel requests that together exceed the outstanding amount: only one is accepted", async () => {
    await setPolicy(A, LIMIT);
    const invoiceId = await invoiceFor(A);
    const before = await paymentEntryIds(A);

    const results = await Promise.all([
      requestPayment(A, A.finance, invoiceId, 60_000),
      requestPayment(A, A.finance, invoiceId, 60_000),
    ]);
    const accepted = results.filter((r) => [200, 201].includes(r.status));
    const refused = results.filter((r) => ![200, 201].includes(r.status));
    expect(accepted, JSON.stringify(results.map((r) => r.body))).toHaveLength(
      1,
    );
    expect(refused).toHaveLength(1);
    expectRefused(refused[0]!);
    const rows = await paymentRows(A, invoiceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: dataOf(accepted[0]!).id });

    // The accepted one is paid once, and the card ends at 40.000.
    await approveAndApply(A, rows[0]!.approval_chain_id!);
    expect(await statusesOf(A, invoiceId)).toEqual(["paid"]);
    expect((await newPaymentJournals(A, before)).count).toBe(1);
    expect(await outstanding(A, invoiceId)).toBe(40_000);
  });

  it("SP-8 two parallel direct payments that together exceed the outstanding amount: only one is paid", async () => {
    await setPolicy(A, NEVER);
    const invoiceId = await invoiceFor(A);
    const before = await paymentEntryIds(A);

    const results = await Promise.all([
      requestPayment(A, A.finance, invoiceId, 60_000),
      requestPayment(A, A.finance, invoiceId, 60_000),
    ]);
    const accepted = results.filter((r) => [200, 201].includes(r.status));
    expect(accepted, JSON.stringify(results.map((r) => r.body))).toHaveLength(
      1,
    );
    expectRefused(results.find((r) => ![200, 201].includes(r.status))!);

    expect(await statusesOf(A, invoiceId)).toEqual(["paid"]);
    const journals = await newPaymentJournals(A, before);
    expect(journals.count).toBe(1);
    expect(journals.debit).toBe(60_000);
    expect(journals.credit).toBe(60_000);
    expect(await outstanding(A, invoiceId)).toBe(40_000);
  });

  it("SP-9 the same idempotency key makes one payment and one journal, direct or pending", async () => {
    // Direct, sequential replay returns the first payment.
    await setPolicy(A, NEVER);
    const invoiceId = await invoiceFor(A);
    const before = await paymentEntryIds(A);
    const sameKey = key();
    const first = await requestPayment(A, A.finance, invoiceId, 20_000, {
      idempotencyKey: sameKey,
    });
    expectAccepted(first);
    const replay = await requestPayment(A, A.finance, invoiceId, 20_000, {
      idempotencyKey: sameKey,
    });
    expectAccepted(replay);
    expect(dataOf(replay).id).toBe(dataOf(first).id);
    expect(await paymentRows(A, invoiceId)).toHaveLength(1);
    expect((await newPaymentJournals(A, before)).count).toBe(1);
    expect(await outstanding(A, invoiceId)).toBe(80_000);

    // The same key with another amount is a conflict and writes nothing.
    const changed = await requestPayment(A, A.finance, invoiceId, 30_000, {
      idempotencyKey: sameKey,
    });
    expect(changed.status).toBe(409);
    expect(codeOf(changed)).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await paymentRows(A, invoiceId)).toHaveLength(1);
    expect(await outstanding(A, invoiceId)).toBe(80_000);

    // Parallel with the same key: still one payment and one journal.
    const parallelInvoice = await invoiceFor(A);
    const parallelKey = key();
    const parallel = await Promise.all([
      requestPayment(A, A.finance, parallelInvoice, 20_000, {
        idempotencyKey: parallelKey,
      }),
      requestPayment(A, A.finance, parallelInvoice, 20_000, {
        idempotencyKey: parallelKey,
      }),
    ]);
    expect(
      parallel.some((r) => [200, 201].includes(r.status)),
      JSON.stringify(parallel.map((r) => r.body)),
    ).toBe(true);
    expect(await paymentRows(A, parallelInvoice)).toHaveLength(1);
    expect(await outstanding(A, parallelInvoice)).toBe(80_000);
    expect((await newPaymentJournals(A, before)).count).toBe(2);

    // Pending path: one waiting payment for one key.
    await setPolicy(A, LIMIT);
    const pendingInvoice = await invoiceFor(A);
    const pendingKey = key();
    const one = await requestPayment(A, A.finance, pendingInvoice, 60_000, {
      idempotencyKey: pendingKey,
    });
    expectAccepted(one);
    const two = await requestPayment(A, A.finance, pendingInvoice, 60_000, {
      idempotencyKey: pendingKey,
    });
    expectAccepted(two);
    expect(dataOf(two).id).toBe(dataOf(one).id);
    expect(await statusesOf(A, pendingInvoice)).toEqual(["pending_approval"]);
  });

  it("SP-10 with no supplier_payment policy the payment is blocked, nothing is written", async () => {
    // C is built by createWorld (not seeded): no default row exists, and any
    // is removed here so the test never depends on a default.
    await clearPolicy(C);
    expect(await policyRows(C)).toEqual([]);
    const invoiceId = await invoiceFor(C);
    const before = await paymentEntryIds(C);

    for (const amountIdr of [20_000, 60_000]) {
      const res = await requestPayment(C, C.finance, invoiceId, amountIdr);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(codeOf(res)).toBe("APPROVAL_POLICY_MISSING");
    }
    expect(await paymentRows(C, invoiceId)).toHaveLength(0);
    expect((await newPaymentJournals(C, before)).count).toBe(0);
    expect(await outstanding(C, invoiceId)).toBe(PAYABLE);
  });

  it("SP-11 another tenant, another outlet, a user without the permission and a visitor cannot see or pay", async () => {
    await setPolicy(A, NEVER);
    const invoiceId = await invoiceFor(A);
    const before = await paymentEntryIds(A);
    // Control: the right finance user pays 20.000 and sees it.
    const mine = await requestPayment(A, A.finance, invoiceId, 20_000);
    expectAccepted(mine);
    expect(
      rowsOf(await listPayments(A, A.finance, invoiceId)).map((r) => r.id),
    ).toEqual([dataOf(mine).id]);

    // Another tenant (its own finance user, its own host): 404 both ways.
    const asB = (path: string) =>
      B.finance.client
        .get(`/api/inventory${path}`)
        .set(originHeader)
        .set("Host", B.world.hostname);
    expect((await asB(payPath(invoiceId))).status).toBe(404);
    const postB = await api.post(
      B.world,
      B.finance,
      payPath(invoiceId),
      payBody(10_000),
    );
    expect(postB.status).toBe(404);

    // Finance of the other outlet of the same tenant.
    const postOutlet = await requestPayment(
      A,
      outletTwoFinance,
      invoiceId,
      10_000,
    );
    expect([403, 404], JSON.stringify(postOutlet.body)).toContain(
      postOutlet.status,
    );
    const listOutlet = await listPayments(A, outletTwoFinance, invoiceId);
    if (listOutlet.status < 400) expect(rowsOf(listOutlet)).toEqual([]);

    // A buyer has no `accounting.supplier_payment.process`; a user with no
    // role at all and a visitor with no session are refused (403 / 401).
    expect((await requestPayment(A, A.buyer, invoiceId, 10_000)).status).toBe(
      403,
    );
    expect((await requestPayment(A, nobody, invoiceId, 10_000)).status).toBe(
      403,
    );
    const visitor = await agent(app)
      .post(`/api/inventory${payPath(invoiceId)}`)
      .set(originHeader)
      .set("Host", A.world.hostname)
      .send(payBody(10_000));
    expect(visitor.status).toBe(401);

    // Nothing changed: still the one 20.000 payment of the control.
    expect(await paymentRows(A, invoiceId)).toHaveLength(1);
    expect((await newPaymentJournals(A, before)).count).toBe(1);
    expect(await outstanding(A, invoiceId)).toBe(80_000);
    expect(await paymentRows(B, invoiceId)).toHaveLength(0);
  });

  it("SP-12 the outstanding amount is recomputed at execution: an approval never overpays", async () => {
    await setPolicy(A, LIMIT);
    const invoiceId = await invoiceFor(A);
    const before = await paymentEntryIds(A);
    const { chainId } = await pendingPayment(A, invoiceId, 70_000);

    // Meanwhile the invoice is settled elsewhere (60.000): only 40.000 is left,
    // so approving the 70.000 request must not pay it.
    await owner.query(
      `UPDATE accounting_open_items SET settled_idr = 60000
        WHERE tenant_id = $1 AND kind = 'payable' AND id = $2`,
      [A.world.tenantId, invoiceId],
    );
    await approveAndApply(A, chainId);

    expect(await statusesOf(A, invoiceId)).not.toContain("paid");
    expect((await newPaymentJournals(A, before)).count).toBe(0);
    expect(await outstanding(A, invoiceId)).toBe(40_000);
  });

  it("SP-13 the period is closed before the approval: the payment is rejected with a note, no money leaves, the room is released", async () => {
    // Own tenant: closing the current month must not affect the other tests.
    const D = await setupTenant("sp-d");
    await setPolicy(D, LIMIT);
    const invoiceId = await invoiceFor(D);
    const before = await paymentEntryIds(D);
    const { id, chainId } = await pendingPayment(D, invoiceId, 60_000);

    // The month of the payment date is closed while the request waits.
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period, status, closed_by, closed_at)
       VALUES ($1, $2, $3, 'closed', $4, now())
       ON CONFLICT (tenant_id, legal_entity_id, period)
       DO UPDATE SET status = 'closed', closed_by = $4, closed_at = now(),
           version = fiscal_periods.version + (CASE WHEN fiscal_periods.status = 'closed' THEN 0 ELSE 1 END)`,
      [
        D.world.tenantId,
        D.world.entityId,
        today().slice(0, 7),
        D.world.creatorId,
      ],
    );

    // The approval is decided; the consumer must settle it without throwing.
    await expect(approveAndApply(D, chainId)).resolves.toBeUndefined();

    expect(await statusesOf(D, invoiceId)).toEqual(["rejected"]);
    expect((await newPaymentJournals(D, before)).count).toBe(0);
    expect(await outstanding(D, invoiceId)).toBe(PAYABLE);
    const listed = rowsOf(await listPayments(D, D.finance, invoiceId)) as {
      id: string;
      status: string;
      note?: string | null;
    }[];
    expect(listed).toEqual([
      expect.objectContaining({ id, status: "rejected" }),
    ]);
    expect(listed[0]!.note?.trim().length ?? 0).toBeGreaterThan(0);

    // Replay changes nothing.
    await applyResolved(D, chainId);
    expect(await statusesOf(D, invoiceId)).toEqual(["rejected"]);
    expect((await newPaymentJournals(D, before)).count).toBe(0);

    // The reservation is gone: the full amount can be requested again.
    const again = await requestPayment(D, D.finance, invoiceId, PAYABLE);
    expectAccepted(again);
    expect(dataOf(again).status).toBe("pending_approval");
    expect(await statusesOf(D, invoiceId)).toEqual([
      "rejected",
      "pending_approval",
    ]);
  });

  it("SP-14 a new tenant with no configuration pays a supplier only after someone else approved", async () => {
    expectDefaultPolicy(await policyRows(E));
    const invoiceId = await invoiceFor(E);
    const before = await paymentEntryIds(E);

    const { chainId } = await pendingPayment(E, invoiceId, 20_000);
    expect(await statusesOf(E, invoiceId)).toEqual(["pending_approval"]);
    expect((await newPaymentJournals(E, before)).count).toBe(0);
    expect(await outstanding(E, invoiceId)).toBe(PAYABLE);

    await approveAndApply(E, chainId);
    expect(await statusesOf(E, invoiceId)).toEqual(["paid"]);
    const journals = await newPaymentJournals(E, before);
    expect(journals.count).toBe(1);
    expect(journals.debit).toBe(20_000);
    expect(journals.credit).toBe(20_000);
    expect(journals.ap).toEqual({ debit: 20_000, credit: 0 });
    expect(journals.bank).toEqual({ debit: 0, credit: 20_000 });
    expect(await outstanding(E, invoiceId)).toBe(80_000);

    // An owner may approve as well (finance/owner are the default approvers).
    const owner2 = await templateUser(E, "SP owner approver", "owner");
    const second = await pendingPayment(E, invoiceId, 30_000);
    await decide(E, owner2, second.chainId, "approved");
    await applyResolved(E, second.chainId);
    expect(await statusesOf(E, invoiceId)).toEqual(["paid", "paid"]);
    expect(await outstanding(E, invoiceId)).toBe(50_000);
  });

  it("SP-15 an existing tenant gets the same default from the 0587 backfill, once, and can then pay", async () => {
    const old = await setupTenant("sp-f", { seeded: true });
    await clearPolicy(old);
    expect(await policyRows(old)).toEqual([]);
    const customBefore = await policyRows(A); // A configured its own matrix

    const backfilled = await inRolledBackBackfill(async (client) => {
      const rows = await policyRows(old, client);
      expectDefaultPolicy(rows);
      // A tenant that configured its own matrix is never touched.
      expect(await policyRows(A, client)).toEqual(customBefore);
      // Running it again adds nothing.
      const dir = fileURLToPath(new URL("../../drizzle/", import.meta.url));
      const file = readdirSync(dir).find((name) =>
        /^\d{4}_supplier_payment_approval_policies_data\.sql$/.test(name),
      )!;
      for (const statement of readFileSync(`${dir}${file}`, "utf8")
        .split("--> statement-breakpoint")
        .map((x) => x.trim())
        .filter(Boolean))
        await client.query(statement);
      expect(await policyRows(old, client)).toEqual(rows);
      return rows;
    });
    // Rolled back: nothing leaked into the shared database.
    expect(await policyRows(old)).toEqual([]);

    // The rows the backfill writes make the tenant able to pay with approval.
    for (const row of backfilled)
      await owner.query(
        `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
         VALUES ($1, 'supplier_payment', $2, $3, $4, $5)`,
        [
          old.world.tenantId,
          row.threshold,
          row.approver_role_id,
          row.level,
          row.requires_distinct_actor,
        ],
      );
    const invoiceId = await invoiceFor(old);
    const before = await paymentEntryIds(old);
    const { chainId } = await pendingPayment(old, invoiceId, 20_000);
    await approveAndApply(old, chainId);
    expect(await statusesOf(old, invoiceId)).toEqual(["paid"]);
    const journals = await newPaymentJournals(old, before);
    expect(journals.count).toBe(1);
    expect(journals.debit).toBe(journals.credit);
    expect(await outstanding(old, invoiceId)).toBe(80_000);
  });

  it("SP-16 with the default policy the requester cannot approve their own payment", async () => {
    // A user who may both request (finance permission) and approve (holds the
    // template role the default names).
    const both = await addUser(E.world, "SP finance who approves", [
      { role: "finance", outletId: null },
    ]);
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
      [E.world.tenantId, both.userId, E.approverRoleId],
    );
    const invoiceId = await invoiceFor(E);
    const before = await paymentEntryIds(E);
    const res = await requestPayment(E, both, invoiceId, 20_000);
    expectAccepted(res);
    expect(dataOf(res).status).toBe("pending_approval");
    const chainId = (await paymentRows(E, invoiceId))[0]!.approval_chain_id!;

    // The inbox refuses the requester's own decision ...
    const own = await decide(E, both, chainId, "approved").then(
      () => null,
      (error: unknown) => error,
    );
    expect(own).not.toBeNull();
    // ... so nothing is paid and no resolved event reaches the consumer.
    expect(await statusesOf(E, invoiceId)).toEqual(["pending_approval"]);
    expect((await newPaymentJournals(E, before)).count).toBe(0);
    expect(await outstanding(E, invoiceId)).toBe(PAYABLE);

    // Control: another person with the same role approves and it is paid.
    await approveAndApply(E, chainId);
    expect(await statusesOf(E, invoiceId)).toEqual(["paid"]);
    expect((await newPaymentJournals(E, before)).count).toBe(1);
  });

  it("SP-17 with limit 0 even Rp 1 needs approval, and an approval never pays above the invoice", async () => {
    const invoiceId = await invoiceFor(E);
    const before = await paymentEntryIds(E);

    // Rp 1 is not paid at once: it waits for an approver.
    const tiny = await pendingPayment(E, invoiceId, 1);
    expect(await statusesOf(E, invoiceId)).toEqual(["pending_approval"]);
    expect((await newPaymentJournals(E, before)).count).toBe(0);
    expect(await outstanding(E, invoiceId)).toBe(PAYABLE);

    // One rupiah above what is left (the Rp 1 reserves) is refused up front.
    expectRefused(await requestPayment(E, E.finance, invoiceId, PAYABLE));
    expect(await paymentRows(E, invoiceId)).toHaveLength(1);
    await approveAndApply(E, tiny.chainId);
    expect(await outstanding(E, invoiceId)).toBe(PAYABLE - 1);
    expectRefused(await requestPayment(E, E.finance, invoiceId, PAYABLE));

    // Approved but settled elsewhere meanwhile: still not paid above the rest.
    const { chainId } = await pendingPayment(E, invoiceId, 70_000);
    await owner.query(
      `UPDATE accounting_open_items SET settled_idr = settled_idr + 60000
        WHERE tenant_id = $1 AND kind = 'payable' AND id = $2`,
      [E.world.tenantId, invoiceId],
    );
    await approveAndApply(E, chainId);
    // The refused 70.000 is left unpaid (rejected or still pending).
    expect(
      (await statusesOf(E, invoiceId)).filter((x) => x === "paid"),
    ).toHaveLength(1);
    const journals = await newPaymentJournals(E, before);
    expect(journals.count).toBe(1); // only the Rp 1
    expect(journals.debit).toBe(1);
    expect(journals.credit).toBe(1);
    expect(await outstanding(E, invoiceId)).toBe(PAYABLE - 1 - 60_000);
  });
});
