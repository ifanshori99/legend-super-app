// legend-5qqb9 P1: a supplier payment refused because GL 1102 is short must
// stay retryable, never end as a final `rejected`. Written fail-first from the
// brief (scratchpad brief-5qqb9.md, Design P1), the founder rule "GL 1102 never
// goes negative, nobody is paid when the cash is not there, nobody is paid
// twice" and the public HTTP / service surface, NOT from the settle code.
//
// Rules:
// - The refusal PETTY_CASH_GL_INSUFFICIENT at settle leaves the payment
//   `pending_approval` (parked): no journal, no settlement, payable and GL
//   untouched. The guard itself is NOT loosened (still short = still parked).
// - A retry trigger exists: POST /api/inventory/supplier-payments/:id/retry-settlement
//   { idempotencyKey }. It re-runs the settlement of a pending_approval payment
//   whose approval chain is already approved; 409 otherwise. After a top-up it
//   pays exactly once; a second or parallel retry never pays twice.
// - Redelivery of the approval event by the consumer keeps working.
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - Path: the brief says /api/purchasing/supplier-payments/:id/retry-settlement,
//   but every sibling supplier-payment route (shared endpoints.ts, the
//   `transitions` route) lives under /api/inventory/supplier-payments, and no
//   /api/purchasing prefix exists. The sibling prefix is used.
// - Body: `{ idempotencyKey }` like the sibling `transitions` endpoint.
// - A retry that is still short answers 200 with the payment unchanged
//   (pending_approval) OR 422 PETTY_CASH_GL_INSUFFICIENT; the brief says the
//   settle "returns it unchanged", so 200 is expected, 422 is tolerated. What
//   is asserted is that nothing changed. Never 5xx.
// - A retry of an already paid payment answers 200 (no-op) or 409 (status
//   guard); asserted: one journal, GL unchanged.
// - Two parallel retries: one pays, the other answers 200 (no-op) or 409; at
//   least one 200; exactly one journal, GL reduced once.
// - Retry of a payment whose chain is not approved yet: 409, nothing changes.
// - Other tenant: 404 (as the other supplier-payment routes). A user without
//   the purchasing/finance payment permission (warehouse): 403.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_TEMPLATES } from "@starter/shared/access";
import { tenantIdSchema } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { approvalResolvedEvent } from "@starter/shared/identity";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { decideApprovalRequest } from "../services/platform-approval.service.ts";
import { handlePurchasingApprovalResolved } from "../services/purchasing-approval-consumer.ts";
import { setPurchaseReturnPostingEnabled } from "../services/purchase-return.service.ts";
import { setSupplierInvoicePostingEnabled } from "../services/purchasing-invoice.service.ts";
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

const REFUSAL = "PETTY_CASH_GL_INSUFFICIENT";
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
     VALUES ($1, $2, 'Uji general manager 5qqb9', false, NULL, $3, false, $4)`,
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
         VALUES ($1, $2, $3, $4, 'sale', NULL, 'Saldo kas kecil uji 5qqb9', $5, $6)
         RETURNING id`,
        [
          t.world.tenantId,
          t.world.entityId,
          aparToday(),
          period,
          `5qqb9-fund-${randomUUID()}`,
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

/** Requests the payment (waits for the second person). */
async function requestPayment(
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
  return { paymentId: data.id, chainId };
}

/** The second person approves; the approval event is returned, NOT consumed. */
async function approveChain(t: Supplier, chainId: string) {
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
  return approvalResolvedEvent.envelopeSchema.parse(rows[0]!.event);
}

type ResolvedEvent = Awaited<ReturnType<typeof approveChain>>;

const consume = (t: Supplier, event: ResolvedEvent) =>
  handlePurchasingApprovalResolved(contextFor(t.world, null), event);

/** Requested, approved and consumed by the real consumer. */
async function requestApproveConsume(
  t: Supplier,
  invoiceId: string,
  amountIdr: number,
) {
  const { paymentId, chainId } = await requestPayment(t, invoiceId, amountIdr);
  const event = await approveChain(t, chainId);
  await consume(t, event);
  return { paymentId, chainId, event };
}

const retry = (
  t: Supplier,
  paymentId: string,
  who: AparSession = t.finance,
  world: AparWorld = t.world,
) =>
  api.post(world, who, `/supplier-payments/${paymentId}/retry-settlement`, {
    idempotencyKey: `k-${randomUUID()}`,
  });

type Res = { status: number; body: unknown };
const detail = (res: Res) => `${res.status} ${JSON.stringify(res.body)}`;
const dataOf = (res: Res) =>
  (res.body as { data?: { status?: string } }).data ?? {};
const errorCode = (res: Res) =>
  (res.body as { error?: { code?: string } }).error?.code;

/** The refusal is parked: pending_approval, nothing moved. */
async function expectParked(
  t: Supplier,
  invoiceId: string,
  paymentId: string,
  journals: number,
  gl: number,
) {
  expect((await paymentRow(t, paymentId)).status, "parked, retryable").toBe(
    "pending_approval",
  );
  expect(await supplierJournalCount(t), "no journal").toBe(journals);
  expect(await payableOutstanding(t, invoiceId), "payable untouched").toBe(
    PAYABLE,
  );
  expect(await supplierGl(t), "1102 untouched, never negative").toBe(gl);
}

/** A retry that is still short: 200 unchanged or 422 refusal, never anything else. */
function expectStillShort(res: Res) {
  if (res.status === 200)
    expect(dataOf(res).status, detail(res)).toBe("pending_approval");
  else {
    expect(res.status, detail(res)).toBe(422);
    expect(errorCode(res), detail(res)).toBe(REFUSAL);
  }
}

describe("5qqb9 supplier payment refused for short 1102 is retryable", () => {
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

  it("[5qqb9-supplier-refusal-parked] GL 1102 Rp30.000, a Rp50.000 payment approved: the consumer refuses (short) and the payment stays pending_approval, no journal, payable and GL unchanged, a replay of the event changes nothing", async () => {
    const t = await setupSupplier("5qqb9-p1");
    await fundSupplier1102(t, 30_000);
    const invoiceId = await supplierInvoice(t);
    const journals = await supplierJournalCount(t);

    const { paymentId, event } = await requestApproveConsume(
      t,
      invoiceId,
      50_000,
    );
    await expectParked(t, invoiceId, paymentId, journals, 30_000);

    await consume(t, event);
    await expectParked(t, invoiceId, paymentId, journals, 30_000);
  }, 120_000);

  it("[5qqb9-supplier-retry-endpoint-settles-approved-pending] an approved chain whose event was not consumed yet: the retry endpoint settles it (200, paid, one journal Dr AP / Cr 1102, payable and GL reduced once)", async () => {
    const t = await setupSupplier("5qqb9-p2");
    await fundSupplier1102(t, 100_000);
    const invoiceId = await supplierInvoice(t);
    const journals = await supplierJournalCount(t);
    const { paymentId, chainId } = await requestPayment(t, invoiceId, 50_000);
    await approveChain(t, chainId); // decided, event not consumed

    const res = await retry(t, paymentId);

    expect(res.status, detail(res)).toBe(200);
    expect(dataOf(res).status, detail(res)).toBe("paid");
    expect((await paymentRow(t, paymentId)).status).toBe("paid");
    expect(await supplierJournalCount(t)).toBe(journals + 1);
    expect(await payableOutstanding(t, invoiceId)).toBe(PAYABLE - 50_000);
    expect(await supplierGl(t)).toBe(50_000);
  }, 120_000);

  it("[5qqb9-supplier-retry-still-short] a retry while 1102 is still short changes nothing: still pending_approval, no journal, GL and payable unchanged, never a 5xx", async () => {
    const t = await setupSupplier("5qqb9-p3");
    await fundSupplier1102(t, 30_000);
    const invoiceId = await supplierInvoice(t);
    const journals = await supplierJournalCount(t);
    const { paymentId } = await requestApproveConsume(t, invoiceId, 50_000);
    await expectParked(t, invoiceId, paymentId, journals, 30_000);

    const res = await retry(t, paymentId);
    expectStillShort(res);
    await expectParked(t, invoiceId, paymentId, journals, 30_000);

    const again = await retry(t, paymentId);
    expectStillShort(again);
    await expectParked(t, invoiceId, paymentId, journals, 30_000);
  }, 120_000);

  it("[5qqb9-supplier-retry-after-topup-pays-once] after a top-up the retry pays exactly once (one journal, 1102 down by the payment); a second retry adds nothing", async () => {
    const t = await setupSupplier("5qqb9-p4");
    await fundSupplier1102(t, 30_000);
    const invoiceId = await supplierInvoice(t);
    const journals = await supplierJournalCount(t);
    const { paymentId } = await requestApproveConsume(t, invoiceId, 50_000);
    await expectParked(t, invoiceId, paymentId, journals, 30_000);

    await fundSupplier1102(t, 40_000); // 70.000 now
    const res = await retry(t, paymentId);
    expect(res.status, detail(res)).toBe(200);
    expect(dataOf(res).status, detail(res)).toBe("paid");
    expect((await paymentRow(t, paymentId)).status).toBe("paid");
    expect(await supplierJournalCount(t)).toBe(journals + 1);
    expect(await payableOutstanding(t, invoiceId)).toBe(PAYABLE - 50_000);
    expect(await supplierGl(t), "1102 reduced once").toBe(20_000);

    const second = await retry(t, paymentId);
    expect([200, 409], detail(second)).toContain(second.status);
    expect((await paymentRow(t, paymentId)).status).toBe("paid");
    expect(await supplierJournalCount(t), "no double payment").toBe(
      journals + 1,
    );
    expect(await payableOutstanding(t, invoiceId)).toBe(PAYABLE - 50_000);
    expect(await supplierGl(t)).toBe(20_000);
  }, 120_000);

  it("[5qqb9-supplier-redelivery-after-topup-pays] the approval event delivered again after a top-up pays the parked payment once; a further redelivery adds nothing", async () => {
    const t = await setupSupplier("5qqb9-p5");
    await fundSupplier1102(t, 30_000);
    const invoiceId = await supplierInvoice(t);
    const journals = await supplierJournalCount(t);
    const { paymentId, event } = await requestApproveConsume(
      t,
      invoiceId,
      50_000,
    );
    await expectParked(t, invoiceId, paymentId, journals, 30_000);

    await fundSupplier1102(t, 40_000);
    await consume(t, event);
    expect((await paymentRow(t, paymentId)).status).toBe("paid");
    expect(await supplierJournalCount(t)).toBe(journals + 1);
    expect(await supplierGl(t)).toBe(20_000);

    await consume(t, event);
    expect(await supplierJournalCount(t), "no double payment").toBe(
      journals + 1,
    );
    expect(await supplierGl(t)).toBe(20_000);
  }, 120_000);

  it("[5qqb9-supplier-retry-concurrent-one-payment] two retries at the same time after a top-up: exactly one journal, 1102 reduced once, payable reduced once", async () => {
    const t = await setupSupplier("5qqb9-p6");
    await fundSupplier1102(t, 30_000);
    const invoiceId = await supplierInvoice(t);
    const journals = await supplierJournalCount(t);
    const { paymentId } = await requestApproveConsume(t, invoiceId, 50_000);
    await expectParked(t, invoiceId, paymentId, journals, 30_000);
    await fundSupplier1102(t, 40_000);

    const [a, b] = await Promise.all([
      retry(t, paymentId),
      retry(t, paymentId),
    ]);

    for (const res of [a, b])
      expect([200, 409], detail(res)).toContain(res.status);
    expect(
      [a, b].some((res) => res.status === 200),
      `one retry succeeds: ${detail(a)} / ${detail(b)}`,
    ).toBe(true);
    expect((await paymentRow(t, paymentId)).status).toBe("paid");
    expect(await supplierJournalCount(t), "one payment").toBe(journals + 1);
    expect(await payableOutstanding(t, invoiceId)).toBe(PAYABLE - 50_000);
    expect(await supplierGl(t)).toBe(20_000);
  }, 120_000);

  it("[5qqb9-supplier-reserve-still-counted] a payroll cash reserve keeps counting: 100.000 in 1102 and 70.000 reserved, a Rp50.000 payment is parked (not rejected), and a retry stays refused while the reserve holds", async () => {
    const t = await setupSupplier("5qqb9-p7");
    await fundSupplier1102(t, 100_000);
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
            netIdr: 70_000,
            bankTransferIdr: 0,
            cashIdr: 70_000,
          },
        }),
      ],
    ); // available 30.000
    const invoiceId = await supplierInvoice(t);
    const journals = await supplierJournalCount(t);

    const { paymentId } = await requestApproveConsume(t, invoiceId, 50_000);
    await expectParked(t, invoiceId, paymentId, journals, 100_000);

    expectStillShort(await retry(t, paymentId));
    await expectParked(t, invoiceId, paymentId, journals, 100_000);
  }, 120_000);

  it("[5qqb9-supplier-module-off-parked-then-retry] accounting switched off before the consumer runs: parked (not rejected), a retry with accounting off stays refused and changes nothing; with accounting on and cash topped up the retry pays once", async () => {
    const t = await setupSupplier("5qqb9-p8");
    await fundSupplier1102(t, 30_000);
    const invoiceId = await supplierInvoice(t);
    const journals = await supplierJournalCount(t);
    const { paymentId, chainId } = await requestPayment(t, invoiceId, 50_000);
    const event = await approveChain(t, chainId);

    const flags = (
      await aparOwner.query<{ flags: { modules?: string[] } }>(
        "SELECT feature_flags AS flags FROM tenants WHERE id = $1",
        [t.world.tenantId],
      )
    ).rows[0]!.flags;
    expect(flags.modules, "premise: accounting is on").toContain("accounting");
    const setModules = (modules: string[]) =>
      aparOwner.query(
        "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
        [t.world.tenantId, JSON.stringify({ ...flags, modules })],
      );
    await setModules(flags.modules!.filter((m) => m !== "accounting"));
    try {
      await consume(t, event);
      await expectParked(t, invoiceId, paymentId, journals, 30_000);
      // The retry route may be unreachable while the module is off (403/404/409)
      // or answer unchanged/refused; in every case nothing moves and no 5xx.
      const off = await retry(t, paymentId);
      expect(off.status, detail(off)).toBeLessThan(500);
      expect(off.status, detail(off)).not.toBe(201);
      if (off.status === 200)
        expect(dataOf(off).status, detail(off)).toBe("pending_approval");
      await expectParked(t, invoiceId, paymentId, journals, 30_000);
    } finally {
      await aparOwner.query(
        "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
        [t.world.tenantId, JSON.stringify(flags)],
      );
    }

    await fundSupplier1102(t, 40_000);
    const res = await retry(t, paymentId);
    expect(res.status, detail(res)).toBe(200);
    expect(dataOf(res).status, detail(res)).toBe("paid");
    expect(await supplierJournalCount(t)).toBe(journals + 1);
    expect(await supplierGl(t)).toBe(20_000);
  }, 120_000);

  it("[5qqb9-supplier-retry-chain-not-approved-409] a pending payment whose approval chain is still open cannot be retried: 409, nothing paid, still pending_approval", async () => {
    const t = await setupSupplier("5qqb9-p9");
    await fundSupplier1102(t, 100_000);
    const invoiceId = await supplierInvoice(t);
    const journals = await supplierJournalCount(t);
    const { paymentId } = await requestPayment(t, invoiceId, 50_000);

    const res = await retry(t, paymentId);

    expect(res.status, detail(res)).toBe(409);
    await expectParked(t, invoiceId, paymentId, journals, 100_000);
  }, 120_000);

  it("[5qqb9-supplier-retry-guards] a user without the payment permission gets 403, another tenant gets 404, an unknown id 404: nothing is paid", async () => {
    const t = await setupSupplier("5qqb9-p10");
    const other = await setupSupplier("5qqb9-p10-other");
    await fundSupplier1102(t, 30_000);
    const invoiceId = await supplierInvoice(t);
    const journals = await supplierJournalCount(t);
    const { paymentId } = await requestApproveConsume(t, invoiceId, 50_000);
    await expectParked(t, invoiceId, paymentId, journals, 30_000);
    await fundSupplier1102(t, 40_000);

    const forbidden = await retry(t, paymentId, t.warehouse);
    expect(forbidden.status, detail(forbidden)).toBe(403);

    const foreign = await retry(t, paymentId, other.finance, other.world);
    expect(foreign.status, detail(foreign)).toBe(404);

    const unknown = await retry(t, randomUUID());
    expect(unknown.status, detail(unknown)).toBe(404);

    expect((await paymentRow(t, paymentId)).status).toBe("pending_approval");
    expect(await supplierJournalCount(t)).toBe(journals);
    expect(await supplierGl(t)).toBe(70_000);
  }, 120_000);
});
