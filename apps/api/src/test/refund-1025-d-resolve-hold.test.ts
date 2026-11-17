// legend-vp4ta (brief 1025b, money + permission): finance can resolve an open
// refund_recon_hold. Until now nothing sets `resolved_at`, so a hold blocks
// refunds, payouts and fund refunds of its intent forever.
//
// Written from docs/briefs/1025b-resolve-refund-hold.md ("Rancangan"), the
// shared contract (packages/shared/src/payment/admin.ts) and the 1025-C / PAY-04
// fixtures, NOT from the service code. Failing first at base (route and the
// resolved_by / resolution / resolution_note columns do not exist yet).
//
// Endpoints (mount /api/payments/admin, permission payment.reconcile):
//   POST /refund-recon-holds/:holdId/resolve
//        body { idempotencyKey, resolution: "not_this_intent" | "counted_against_intent", note }
//   GET  /refund-recon-holds?status=open|resolved
//
// Assumptions (the brief does not fix them):
//  - Holds are seeded straight into refund_recon_holds (columns of migration
//    0642); the webhook pipeline that files them is covered by 1025-C.
//  - Resolving twice (new idempotency key) answers 409 with error.code
//    CONFLICT and changes nothing, no second audit row.
//  - Audit is counted tenant-wide (audit_logs rows of the tenant): the first
//    resolve writes at least one, a refused or repeated one writes none.
//  - A refund above the remaining net is refused with 409 or 422 (not asserted
//    more precisely); the refusal must leave no payment_refunds row.
//  - Remaining net of a 100.000 payment = 100.000 minus provider refunds
//    recorded for the intent.
//  - GET without `status` lists open holds; list items expose `id`.
//  - `counted_against_intent` on a `payment:<ref>` hold whose `payment:<ref>`
//    provider-refund row does NOT exist yet is not asserted (the brief leaves
//    it open).
//  - Provider-refund row written by counting: source `refund_webhook`; the
//    journal runs from the `payment.provider_refunded` outbox event (1013),
//    so "journal posts once" is asserted as exactly one such event per row.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1025-d-resolve-hold.test.ts" heavy pnpm test

import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createApp } from "../app";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";
import { paymentTestScope } from "./payment-test-scope";
import { FakeRefundGateway } from "./refund-fake-gateway";

vi.setConfig({ testTimeout: 120_000 });

const scope = paymentTestScope();
const otherScope = paymentTestScope();
const app = createApp();
const tenantId = scope.tenantId;
const outletId = scope.outletId;
const ADMIN = "/api/payments/admin";
const BILL = 100_000;
const NOTE = "Dicocokkan dengan mutasi bank provider";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

type Client = ReturnType<typeof agent>;
let staff: Client; // owner role: files refunds, resolves holds
let staffId = "";
let approverId = "";
let approver: Client; // finance + outlet supervisor: approves / retries payouts
let cashier: Client; // no payment.reconcile
let fake: FakeRefundGateway;

const userIds: string[] = [];
const linkIds: string[] = [];
const otherLinkIds: string[] = [];
const key = (prefix = "k") => `${prefix}-${randomUUID()}`;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

async function assign(
  userId: string,
  templateKey: string,
  scopeType: "tenant" | "outlet",
) {
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
    [
      tenantId,
      userId,
      await roleIdOf(templateKey),
      scopeType,
      scopeType === "outlet" ? outletId : null,
    ],
  );
}

async function signedIn(
  label: string,
): Promise<{ client: Client; id: string }> {
  const client = agent(app).set("Host", scope.hostname);
  const email = await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const id = session.body.user.id as string;
  userIds.push(id);
  await verifySessionMfa(email);
  return { client, id };
}

/** Run statements with the tenant RLS context set (as the services do). */
async function asTenantTx<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await scope.seed(owner);
  await otherScope.seed(owner);

  ({ client: staff, id: staffId } = await signedIn("Hold1025d owner"));
  await assign(staffId, "owner", "tenant");

  const fin = await signedIn("Hold1025d finance");
  approver = fin.client;
  approverId = fin.id;
  await assign(fin.id, "finance", "tenant");
  await assign(fin.id, "supervisor", "outlet");

  const till = await signedIn("Hold1025d cashier");
  cashier = till.client;
  await assign(till.id, "cashier", "outlet");

  // Refund approvals need a policy: one level, Finance.
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
    [tenantId],
  );
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'refund', NULL, $2, 1)`,
    [tenantId, await roleIdOf("finance")],
  );
});

afterAll(async () => {
  setPaymentRefundGateway(null);
  for (const [tenant, links] of [
    [tenantId, linkIds],
    [otherScope.tenantId, otherLinkIds],
  ] as const) {
    if (links.length === 0) continue;
    const intents =
      "SELECT id FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])";
    await owner.query(
      `DELETE FROM approval_requests WHERE tenant_id = $1 AND object_type = 'payment_refund'
         AND object_id IN (SELECT id::text FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id IN (${intents}))`,
      [tenant, links],
    );
    for (const table of [
      "payment_refunds",
      "refund_recon_holds",
      "payment_provider_refunds",
      "payment_unallocated_funds",
      "payment_evidence",
    ])
      await owner.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
        [tenant, links],
      );
    await owner.query(
      "DELETE FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])",
      [tenant, links],
    );
    await owner.query(
      "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant, links],
    );
  }
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenantId, userIds],
  );
  await owner.end();
});

beforeEach(() => {
  fake = new FakeRefundGateway();
  setPaymentRefundGateway(fake);
});
afterEach(() => {
  setPaymentRefundGateway(null);
});

type Intent = { id: string; providerRef: string; linkId: string };

/** A settled 100.000 bill of `tenant`, with evidence for the whole amount. */
async function seedIntent(
  s: typeof scope = scope,
  links: string[] = linkIds,
): Promise<Intent> {
  const linkId = randomUUID();
  const id = randomUUID();
  const providerRef = `dp_1025d_${randomBytes(8).toString("hex")}`;
  links.push(linkId);
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'refund-1025d-test')`,
    [
      linkId,
      s.tenantId,
      s.outletId,
      randomBytes(32).toString("hex"),
      `H1025-${linkId.slice(0, 8)}`,
      BILL,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at, provider_ref)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now() + interval '1 hour', $7)`,
    [id, s.tenantId, s.outletId, linkId, BILL, `h1025-${id}`, providerRef],
  );
  await owner.query(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [s.tenantId, s.outletId, id, providerRef, BILL],
  );
  return { id, providerRef, linkId };
}

/** An open hold (provider refund `refundId`, `amountIdr`) on the intent. */
async function seedHold(
  intent: Intent,
  {
    refundId = `rf_${randomBytes(6).toString("hex")}` as string | null,
    amountIdr = 30_000,
    tenant = tenantId,
    providerPaymentRef,
  }: {
    refundId?: string | null;
    amountIdr?: number;
    tenant?: string;
    /** The provider payment id the refund names (new column, 1025-d). */
    providerPaymentRef?: string;
  } = {},
): Promise<string> {
  const holdId = randomUUID();
  const base = [holdId, tenant, intent.id, randomUUID(), refundId, amountIdr];
  await asTenantTx(tenant, (client) =>
    providerPaymentRef === undefined
      ? client.query(
          `INSERT INTO refund_recon_holds
             (id, tenant_id, payment_intent_id, webhook_event_id, provider_refund_id, amount_idr, reason)
           VALUES ($1, $2, $3, $4, $5, $6, 'Reference names another intent')`,
          base,
        )
      : client.query(
          `INSERT INTO refund_recon_holds
             (id, tenant_id, payment_intent_id, webhook_event_id, provider_refund_id, amount_idr, reason, provider_payment_ref)
           VALUES ($1, $2, $3, $4, $5, $6, 'Reference names another intent', $7)`,
          [...base, providerPaymentRef],
        ),
  );
  return holdId;
}

/**
 * An extra provider transaction Y of the intent (evidence) whose money is
 * parked as an unallocated fund, as the webhook pipeline leaves it (1020).
 */
async function seedExtraTxn(
  intent: Intent,
  amountIdr = 30_000,
): Promise<{ providerRef: string; fundId: string }> {
  const providerRef = `dp_extra_${randomBytes(8).toString("hex")}`;
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())
     RETURNING id`,
    [tenantId, outletId, intent.id, providerRef, amountIdr],
  );
  const fundId = randomUUID();
  await owner.query(
    `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
     VALUES ($1, $2, $3, $4, $5, $6, 'double_payment')`,
    [fundId, tenantId, outletId, intent.id, rows[0]!.id, amountIdr],
  );
  return { providerRef, fundId };
}

const resolveFund = (fundId: string) =>
  staff
    .post(`${ADMIN}/unallocated-funds/${fundId}/resolve`)
    .set(originHeader)
    .send({
      idempotencyKey: key("fund"),
      resolution: "refund",
      note: "Kembalikan dana yang belum teralokasi",
    });

const fundRefundRows = (fundId: string) =>
  count(
    "SELECT count(*)::text AS n FROM payment_refunds WHERE tenant_id = $1 AND unallocated_fund_id = $2",
    [tenantId, fundId],
  );

/** The provider-refund row our own recorder would have written. */
async function seedProviderRow(
  intent: Intent,
  providerRefundId: string,
  amountIdr: number,
) {
  await asTenantTx(tenantId, (client) =>
    client.query(
      `INSERT INTO payment_provider_refunds
         (id, tenant_id, outlet_id, payment_intent_id, provider, provider_refund_id,
          provider_payment_ref, amount_idr, source)
       VALUES ($1, $2, $3, $4, 'doit', $5, $6, $7, 'refund_webhook')`,
      [
        randomUUID(),
        tenantId,
        outletId,
        intent.id,
        providerRefundId,
        intent.providerRef,
        amountIdr,
      ],
    ),
  );
}

type HoldRow = {
  resolved_at: Date | null;
  resolved_by: string | null;
  resolution: string | null;
  resolution_note: string | null;
};

/** Open/closed state of a hold. Needs the 1025-d columns (fails at base). */
async function holdRow(holdId: string): Promise<HoldRow> {
  const { rows } = await owner.query<HoldRow>(
    `SELECT resolved_at, resolved_by::text AS resolved_by, resolution, resolution_note
       FROM refund_recon_holds WHERE id = $1`,
    [holdId],
  );
  if (!rows[0]) throw new Error("hold row missing");
  return rows[0];
}

/** Plain "is it still open" read that works before the new columns exist. */
async function isOpen(holdId: string): Promise<boolean> {
  const { rows } = await owner.query<{ resolved_at: Date | null }>(
    "SELECT resolved_at FROM refund_recon_holds WHERE id = $1",
    [holdId],
  );
  return rows[0]!.resolved_at === null;
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(sql, params);
  return Number(rows[0]?.n);
}

const providerRows = async (intentId: string) => {
  const { rows } = await owner.query<{
    provider_refund_id: string;
    amount_idr: string;
    source: string;
  }>(
    `SELECT provider_refund_id, amount_idr::text AS amount_idr, source
       FROM payment_provider_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2 ORDER BY provider_refund_id`,
    [tenantId, intentId],
  );
  return rows;
};

const refundRowCount = (intentId: string) =>
  count(
    "SELECT count(*)::text AS n FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantId, intentId],
  );

const refundStatuses = async (intentId: string) => {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantId, intentId],
  );
  return rows.map((row) => row.status);
};

const auditCount = () =>
  count("SELECT count(*)::text AS n FROM audit_logs WHERE tenant_id = $1", [
    tenantId,
  ]);

const providerRefundedEvents = (intentId: string) =>
  count(
    `SELECT count(DISTINCT event->>'id')::text AS n FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'payment.provider_refunded'
        AND event->'payload'->>'paymentIntentId' = $2`,
    [tenantId, intentId],
  );

const stampOf = async (intentId: string) => {
  const { rows } = await owner.query<{ stamp: Date | null }>(
    "SELECT provider_refunded_after_paid_at AS stamp FROM payment_intents WHERE id = $1",
    [intentId],
  );
  return rows[0]!.stamp;
};

const manualRefund = (intentId: string, amountIdr: number) =>
  staff
    .post(`${ADMIN}/refunds`)
    .set(originHeader)
    .send({
      idempotencyKey: key("req"),
      paymentIntentId: intentId,
      amountIdr,
      reason: "Pelanggan minta uang kembali",
    });

const retryRefund = (refundId: string) =>
  approver
    .post(`${ADMIN}/refunds/${refundId}/retry`)
    .set(originHeader)
    .send({ idempotencyKey: key("retry") });

async function approveWithoutSending(refundId: string) {
  await owner.query(
    `UPDATE payment_refunds
        SET status = 'approved', approved_by = $3, decided_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, refundId, approverId],
  );
}

type Resolution = "not_this_intent" | "counted_against_intent";

const resolveHold = (
  client: Client,
  holdId: string,
  resolution: Resolution,
  note: string = NOTE,
) =>
  client
    .post(`${ADMIN}/refund-recon-holds/${holdId}/resolve`)
    .set(originHeader)
    .send({ idempotencyKey: key("hold"), resolution, note });

const listHolds = (client: Client, query = "") =>
  client.get(`${ADMIN}/refund-recon-holds${query}`);

const idsOf = (response: { body: { data: { id: string }[] } }) =>
  response.body.data.map((item) => item.id);

// ---------------------------------------------------------------------------
// Controls: the harness itself (these pass at base)
// ---------------------------------------------------------------------------

describe("1025-d controls: the blocks the resolve is meant to lift", () => {
  it("1025-d control: without a hold a refund of the intent is accepted", async () => {
    const intent = await seedIntent();
    const filed = await manualRefund(intent.id, 10_000);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  });

  it("1025-d control: an open hold refuses a new refund with 409 PROVIDER_REFUNDED and pays nothing", async () => {
    const intent = await seedIntent();
    await seedHold(intent);
    const refused = await manualRefund(intent.id, 10_000);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("PROVIDER_REFUNDED");
    expect(await refundRowCount(intent.id)).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// not_this_intent
// ---------------------------------------------------------------------------

describe("1025-d not_this_intent closes the hold and lifts the block, once", () => {
  it("1025-d-01 closes the hold with who, what and why, writes an audit row, and moves no money", async () => {
    const intent = await seedIntent();
    const holdId = await seedHold(intent);
    const auditBefore = await auditCount();

    const response = await resolveHold(staff, holdId, "not_this_intent");
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const row = await holdRow(holdId);
    expect(row.resolved_at).not.toBeNull();
    expect(row.resolved_by).toBe(staffId);
    expect(row.resolution).toBe("not_this_intent");
    expect(row.resolution_note).toBe(NOTE);
    expect(await auditCount()).toBeGreaterThan(auditBefore);

    // Closing a hold is not a payment: no refund, no provider row, no stamp.
    expect(await providerRows(intent.id)).toEqual([]);
    expect(await refundRowCount(intent.id)).toBe(0);
    expect(await stampOf(intent.id)).toBeNull();
    expect(await providerRefundedEvents(intent.id)).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });

  it("1025-d-02 a refund of the intent is accepted again after the resolve", async () => {
    const intent = await seedIntent();
    const holdId = await seedHold(intent);
    expect((await manualRefund(intent.id, 10_000)).status).toBe(409);

    expect((await resolveHold(staff, holdId, "not_this_intent")).status).toBe(
      200,
    );

    const filed = await manualRefund(intent.id, 10_000);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    expect(await refundRowCount(intent.id)).toBe(1);
  });

  it("1025-d-03 a refund quarantined while the hold was open stays unpaid after the resolve; a NEW refund within the remaining net goes out exactly once", async () => {
    // Decision (coordinator): the payout path quarantines a refund of a
    // hold-blocked intent for good (PAYOUT_QUARANTINED); resolving the hold
    // does not release it (restrictive, no money-path change).
    const intent = await seedIntent();
    const filed = await manualRefund(intent.id, 10_000);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    const oldRefundId = filed.body.data.id as string;
    await approveWithoutSending(oldRefundId);
    const holdId = await seedHold(intent);

    // Blocked while the hold is open: nothing leaves.
    const blocked = await retryRefund(oldRefundId);
    expect(blocked.status, JSON.stringify(blocked.body)).toBeLessThan(500);
    expect(fake.calls, "no payout while the hold is open").toHaveLength(0);
    expect(await refundStatuses(intent.id)).not.toContain("completed");

    expect((await resolveHold(staff, holdId, "not_this_intent")).status).toBe(
      200,
    );

    // The quarantined refund is NOT sent, however often it is retried.
    await retryRefund(oldRefundId);
    await retryRefund(oldRefundId);
    expect(fake.calls, "quarantined refund stays unpaid").toHaveLength(0);
    expect(await refundStatuses(intent.id)).not.toContain("completed");

    // A NEW refund of the intent is accepted and pays out exactly once.
    const fresh = await manualRefund(intent.id, 10_000);
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(201);
    const newRefundId = fresh.body.data.id as string;
    expect(newRefundId).not.toBe(oldRefundId);
    const approved = await approver
      .post(`${ADMIN}/refunds/${newRefundId}/approve`)
      .set(originHeader)
      .send({ idempotencyKey: key("apr") });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data).toMatchObject({
      status: "completed",
      amountIdr: 10_000,
    });
    expect(fake.calls, "the new refund paid exactly once").toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      refundId: newRefundId,
      amountIdr: 10_000,
    });

    // Retrying either refund or resolving again never pays a second time.
    await retryRefund(newRefundId);
    await retryRefund(oldRefundId);
    await resolveHold(staff, holdId, "not_this_intent");
    expect(fake.calls).toHaveLength(1);
  });

  it("1025-d-04 a second open hold on the same intent keeps blocking until it is resolved too", async () => {
    const intent = await seedIntent();
    const first = await seedHold(intent);
    const second = await seedHold(intent);

    expect((await resolveHold(staff, first, "not_this_intent")).status).toBe(
      200,
    );
    expect(await isOpen(second)).toBe(true);
    const stillBlocked = await manualRefund(intent.id, 10_000);
    expect(stillBlocked.status, JSON.stringify(stillBlocked.body)).toBe(409);
    expect(stillBlocked.body.error.code).toBe("PROVIDER_REFUNDED");
    expect(await refundRowCount(intent.id)).toBe(0);

    expect((await resolveHold(staff, second, "not_this_intent")).status).toBe(
      200,
    );
    const filed = await manualRefund(intent.id, 10_000);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  });

  it("1025-d-04b resolving a hold of one intent leaves another intent's hold open and blocking", async () => {
    const a = await seedIntent();
    const b = await seedIntent();
    const holdA = await seedHold(a);
    const holdB = await seedHold(b);

    expect((await resolveHold(staff, holdA, "not_this_intent")).status).toBe(
      200,
    );

    expect(await isOpen(holdB)).toBe(true);
    expect((await manualRefund(b.id, 10_000)).status).toBe(409);
    expect((await manualRefund(a.id, 10_000)).status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// counted_against_intent: the money is recorded BEFORE the block is lifted
// ---------------------------------------------------------------------------

describe("1025-d counted_against_intent records the provider refund first, so nothing is paid twice", () => {
  it("1025-d-05 writes the provider refund row of the hold (idr, refund_webhook), closes the hold, and journals once", async () => {
    const intent = await seedIntent();
    const holdId = await seedHold(intent, {
      refundId: "rf_counted_1",
      amountIdr: 30_000,
    });

    const response = await resolveHold(staff, holdId, "counted_against_intent");
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const rows = await providerRows(intent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider_refund_id: "rf_counted_1",
      amount_idr: "30000",
      source: "refund_webhook",
    });
    const row = await holdRow(holdId);
    expect(row.resolved_at).not.toBeNull();
    expect(row.resolved_by).toBe(staffId);
    expect(row.resolution).toBe("counted_against_intent");
    expect(row.resolution_note).toBe(NOTE);
    expect(
      await providerRefundedEvents(intent.id),
      "one journal event for the one row",
    ).toBe(1);
    expect(fake.calls, "counting is not a payout").toHaveLength(0);
    expect(await refundRowCount(intent.id)).toBe(0);
  });

  it("1025-d-06 a refund above the remaining net is still refused (no overpay), the remaining net is still refundable", async () => {
    const intent = await seedIntent();
    const holdId = await seedHold(intent, { amountIdr: 30_000 });
    expect(
      (await resolveHold(staff, holdId, "counted_against_intent")).status,
    ).toBe(200);

    // 100.000 paid, 30.000 already went back at the provider: 70.000 remain.
    const over = await manualRefund(intent.id, 80_000);
    expect([409, 422], JSON.stringify(over.body)).toContain(over.status);
    expect(
      await refundRowCount(intent.id),
      "no refund row for the overpay",
    ).toBe(0);

    const within = await manualRefund(intent.id, 70_000);
    expect(within.status, JSON.stringify(within.body)).toBe(201);
    expect(fake.calls).toHaveLength(0);
  });

  it("1025-d-07 when the same provider refund is already recorded, counting writes no second row and the net is not reduced twice", async () => {
    const intent = await seedIntent();
    await seedProviderRow(intent, "rf_counted_2", 30_000);
    const holdId = await seedHold(intent, {
      refundId: "rf_counted_2",
      amountIdr: 30_000,
    });

    const response = await resolveHold(staff, holdId, "counted_against_intent");
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    expect(await providerRows(intent.id)).toHaveLength(1);
    expect((await holdRow(holdId)).resolution).toBe("counted_against_intent");
    // 30.000 counted once leaves 70.000. Counted twice it would leave 40.000.
    const within = await manualRefund(intent.id, 70_000);
    expect(within.status, JSON.stringify(within.body)).toBe(201);
  });

  it("1025-d-08 the guest is never refunded twice: a hold covering the whole payment, once counted, leaves nothing to refund", async () => {
    const intent = await seedIntent();
    const holdId = await seedHold(intent, { amountIdr: BILL });
    expect(
      (await resolveHold(staff, holdId, "counted_against_intent")).status,
    ).toBe(200);

    for (const amount of [BILL, 50_000, 1_000]) {
      const refused = await manualRefund(intent.id, amount);
      expect(
        [409, 422],
        `${amount}: ${JSON.stringify(refused.body)}`,
      ).toContain(refused.status);
    }
    // A repeated resolve neither re-opens the hold nor adds money.
    expect(
      (await resolveHold(staff, holdId, "counted_against_intent")).status,
    ).toBe(409);
    expect(await refundRowCount(intent.id)).toBe(0);
    expect(await providerRows(intent.id)).toHaveLength(1);
    expect(fake.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Double resolve
// ---------------------------------------------------------------------------

describe("1025-d resolving twice changes nothing", () => {
  it.each(["not_this_intent", "counted_against_intent"] as const)(
    "1025-d-09 a second resolve (%s first) answers 409 CONFLICT, even with the other decision; no second audit row, no second provider row or event",
    async (first) => {
      const intent = await seedIntent();
      const holdId = await seedHold(intent, {
        refundId: "rf_double",
        amountIdr: 30_000,
      });
      expect((await resolveHold(staff, holdId, first)).status).toBe(200);
      const closed = await holdRow(holdId);
      const auditAfterFirst = await auditCount();
      const rowsAfterFirst = await providerRows(intent.id);
      const eventsAfterFirst = await providerRefundedEvents(intent.id);

      for (const again of [
        first,
        first === "not_this_intent"
          ? "counted_against_intent"
          : "not_this_intent",
      ] as const) {
        const second = await resolveHold(
          staff,
          holdId,
          again,
          "Alasan kedua yang berbeda",
        );
        expect(second.status, JSON.stringify(second.body)).toBe(409);
        expect(second.body.error.code).toBe("CONFLICT");
      }

      expect(await holdRow(holdId), "hold untouched").toEqual(closed);
      expect(await auditCount(), "no second audit row").toBe(auditAfterFirst);
      expect(await providerRows(intent.id)).toEqual(rowsAfterFirst);
      expect(await providerRefundedEvents(intent.id)).toBe(eventsAfterFirst);
      expect(fake.calls).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------------------
// Guards: tenant, permission, session, validation
// ---------------------------------------------------------------------------

describe("1025-d who may resolve, and what is refused", () => {
  it("1025-d-10 another tenant's hold is 404 and stays open, with no row written", async () => {
    const foreign = await seedIntent(otherScope, otherLinkIds);
    const foreignHold = await asTenantTx(
      otherScope.tenantId,
      async (client) => {
        const id = randomUUID();
        await client.query(
          `INSERT INTO refund_recon_holds
           (id, tenant_id, payment_intent_id, webhook_event_id, provider_refund_id, amount_idr, reason)
         VALUES ($1, $2, $3, $4, 'rf_foreign', 30000, 'Reference names another intent')`,
          [id, otherScope.tenantId, foreign.id, randomUUID()],
        );
        return id;
      },
    );
    // Own hold resolves (the route exists), the foreign one is invisible.
    const own = await seedHold(await seedIntent());
    expect((await resolveHold(staff, own, "not_this_intent")).status).toBe(200);
    const auditBefore = await auditCount();

    for (const resolution of [
      "not_this_intent",
      "counted_against_intent",
    ] as const) {
      const response = await resolveHold(staff, foreignHold, resolution);
      expect(response.status, JSON.stringify(response.body)).toBe(404);
    }
    expect(await isOpen(foreignHold)).toBe(true);
    const { rows } = await owner.query(
      "SELECT 1 FROM payment_provider_refunds WHERE payment_intent_id = $1",
      [foreign.id],
    );
    expect(rows).toHaveLength(0);
    expect(await auditCount()).toBe(auditBefore);
  });

  it("1025-d-11 a hold that does not exist is 404", async () => {
    const own = await seedHold(await seedIntent());
    expect((await resolveHold(staff, own, "not_this_intent")).status).toBe(200);
    const response = await resolveHold(staff, randomUUID(), "not_this_intent");
    expect(response.status, JSON.stringify(response.body)).toBe(404);
  });

  it("1025-d-12 a user without payment.reconcile gets 403, an anonymous caller 401; the hold stays open", async () => {
    const intent = await seedIntent();
    const holdId = await seedHold(intent);
    const auditBefore = await auditCount();

    const forbidden = await resolveHold(cashier, holdId, "not_this_intent");
    expect(forbidden.status, JSON.stringify(forbidden.body)).toBe(403);

    const anonymous = await agent(app)
      .set("Host", scope.hostname)
      .post(`${ADMIN}/refund-recon-holds/${holdId}/resolve`)
      .set(originHeader)
      .send({
        idempotencyKey: key("hold"),
        resolution: "not_this_intent",
        note: NOTE,
      });
    expect(anonymous.status).toBe(401);

    expect(await isOpen(holdId)).toBe(true);
    expect(await auditCount()).toBe(auditBefore);
    expect((await manualRefund(intent.id, 10_000)).status).toBe(409);
  });

  it.each([
    ["an empty note", { note: "" }],
    ["a too short note", { note: "ok" }],
    ["a note of only spaces", { note: "          " }],
    ["a note that is short once trimmed", { note: "  ab  " }],
    ["a missing note", { note: undefined }],
    ["an unknown decision", { resolution: "matched_no_action" }],
    ["a missing idempotency key", { idempotencyKey: undefined }],
    ["an unknown extra field", { amountIdr: 1 }],
  ])("1025-d-13 %s is 422 and the hold stays open", async (_label, patch) => {
    const intent = await seedIntent();
    const holdId = await seedHold(intent);
    const auditBefore = await auditCount();

    const response = await staff
      .post(`${ADMIN}/refund-recon-holds/${holdId}/resolve`)
      .set(originHeader)
      .send({
        idempotencyKey: key("hold"),
        resolution: "not_this_intent",
        note: NOTE,
        ...patch,
      });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(await isOpen(holdId)).toBe(true);
    expect(await auditCount()).toBe(auditBefore);
    expect(await providerRows(intent.id)).toEqual([]);
  });

  it("1025-d-14 not_this_intent on a hold with no provider refund id just closes it, no provider row", async () => {
    const intent = await seedIntent();
    const holdId = await seedHold(intent, {
      refundId: null,
      amountIdr: 30_000,
    });

    const response = await resolveHold(staff, holdId, "not_this_intent");
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await holdRow(holdId)).resolution).toBe("not_this_intent");
    expect(await providerRows(intent.id)).toEqual([]);
  });

  it("1025-d-15 counted_against_intent on a hold of 0 rupiah is 422", async () => {
    const intent = await seedIntent();
    const holdId = await seedHold(intent, { amountIdr: 0 });

    const response = await resolveHold(staff, holdId, "counted_against_intent");
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(await isOpen(holdId)).toBe(true);
    expect(await providerRows(intent.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// payment:<ref> holds (our own refund ran while the full refund was recorded)
// ---------------------------------------------------------------------------

describe("1025-d holds filed for our own refund (payment:<ref>) are restrictive", () => {
  it("1025-d-16 not_this_intent is refused with 422: the money may already have gone back", async () => {
    const intent = await seedIntent();
    const holdId = await seedHold(intent, {
      refundId: `payment:${"dp_x"}`,
      amountIdr: BILL,
    });
    const auditBefore = await auditCount();

    const response = await resolveHold(staff, holdId, "not_this_intent");
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(await isOpen(holdId)).toBe(true);
    expect(await auditCount()).toBe(auditBefore);
    expect((await manualRefund(intent.id, 10_000)).status).toBe(409);
  });

  it("1025-d-17 counted_against_intent with the payment:<ref> row already recorded closes the hold without a second row", async () => {
    const intent = await seedIntent();
    const refundId = `payment:${intent.providerRef}`;
    await seedProviderRow(intent, refundId, BILL);
    const holdId = await seedHold(intent, { refundId, amountIdr: BILL });

    const response = await resolveHold(staff, holdId, "counted_against_intent");
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    expect(await providerRows(intent.id)).toHaveLength(1);
    expect((await holdRow(holdId)).resolution).toBe("counted_against_intent");
    // The whole payment is already back at the provider: nothing to refund.
    const refused = await manualRefund(intent.id, 1_000);
    expect([409, 422], JSON.stringify(refused.body)).toContain(refused.status);
    expect(fake.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GET list
// ---------------------------------------------------------------------------

describe("1025-d the list of holds", () => {
  it("1025-d-18 lists the open holds of this tenant only; resolved ones move to status=resolved; another tenant's hold never shows", async () => {
    // Start from an empty list for this tenant (earlier tests leave holds).
    await owner.query("DELETE FROM refund_recon_holds WHERE tenant_id = $1", [
      tenantId,
    ]);
    const open1 = await seedHold(await seedIntent());
    const open2 = await seedHold(await seedIntent());
    const closedIntent = await seedIntent();
    const closed = await seedHold(closedIntent);
    const foreign = await seedIntent(otherScope, otherLinkIds);
    const foreignHold = await asTenantTx(
      otherScope.tenantId,
      async (client) => {
        const id = randomUUID();
        await client.query(
          `INSERT INTO refund_recon_holds
           (id, tenant_id, payment_intent_id, webhook_event_id, provider_refund_id, amount_idr, reason)
         VALUES ($1, $2, $3, $4, 'rf_foreign_list', 30000, 'Reference names another intent')`,
          [id, otherScope.tenantId, foreign.id, randomUUID()],
        );
        return id;
      },
    );
    expect((await resolveHold(staff, closed, "not_this_intent")).status).toBe(
      200,
    );

    const open = await listHolds(staff, "?status=open");
    expect(open.status, JSON.stringify(open.body)).toBe(200);
    expect(idsOf(open).sort()).toEqual([open1, open2].sort());
    expect(idsOf(open)).not.toContain(foreignHold);

    const byDefault = await listHolds(staff);
    expect(byDefault.status, JSON.stringify(byDefault.body)).toBe(200);
    expect(idsOf(byDefault).sort()).toEqual([open1, open2].sort());

    const resolved = await listHolds(staff, "?status=resolved");
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(idsOf(resolved)).toEqual([closed]);
  });

  it("1025-d-19 needs payment.reconcile (403) and a session (401)", async () => {
    const forbidden = await listHolds(cashier);
    expect(forbidden.status).toBe(403);
    const anonymous = await agent(app)
      .set("Host", scope.hostname)
      .get(`${ADMIN}/refund-recon-holds`);
    expect(anonymous.status).toBe(401);
  });

  it("1025-d-20 an unknown status filter is 422", async () => {
    const response = await listHolds(staff, "?status=everything");
    expect(response.status, JSON.stringify(response.body)).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Architect round: three money gaps (coordinator decisions).
//  (1) A hold from a REFERENCE_MISMATCH names the provider payment id Y of an
//      extra transaction (new column refund_recon_holds.provider_payment_ref).
//      Counting records the refund against Y, so the fund of Y stays blocked.
//      Without that column filled: 422 when the intent has more than one
//      evidence row or any parked fund.
//  (2) payment:<ref> holds close with counted_against_intent only when no own
//      refund of the intent is in flight (status pending or approved: the
//      payment_refunds status check has no 'processing') AND provider rows plus
//      completed own refunds cover the transaction amount (no new row then).
//  (3) A hold with NULL provider_refund_id is countable: the refund is
//      recorded under `hold:<holdId>` for the hold amount, or for the whole
//      remaining paid amount when the hold amount is 0.
// Assumption: "transaction amount" of a payment:<ref> hold = the hold amount
// (BILL here); a fully covered, nothing-in-flight hold closes with
// counted_against_intent (not_this_intent stays refused for payment:<ref>).
// ---------------------------------------------------------------------------

/** File a refund and let a second person approve it: pays out, completed. */
async function completeOwnRefund(intent: Intent, amountIdr: number) {
  const filed = await manualRefund(intent.id, amountIdr);
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  const refundId = filed.body.data.id as string;
  const approved = await approver
    .post(`${ADMIN}/refunds/${refundId}/approve`)
    .set(originHeader)
    .send({ idempotencyKey: key("apr") });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  expect(await refundStatuses(intent.id)).toContain("completed");
  return refundId;
}

const providerRefsOf = async (intentId: string) => {
  const { rows } = await owner.query<{
    provider_refund_id: string;
    provider_payment_ref: string | null;
  }>(
    `SELECT provider_refund_id, provider_payment_ref
       FROM payment_provider_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2 ORDER BY provider_refund_id`,
    [tenantId, intentId],
  );
  return rows;
};

describe("1025-d (1) a hold naming an extra transaction Y is counted against Y, not the intent's own payment", () => {
  it("1025-d-21 control: without a hold the parked fund of Y can be refunded", async () => {
    const intent = await seedIntent();
    const y = await seedExtraTxn(intent);
    const fund = await resolveFund(y.fundId);
    expect(fund.status, JSON.stringify(fund.body)).toBe(200);
    expect(await fundRefundRows(y.fundId)).toBe(1);
  });

  it("1025-d-22 counted_against_intent writes the provider refund against Y; the fund of Y stays blocked and cannot be refunded again", async () => {
    const intent = await seedIntent();
    const y = await seedExtraTxn(intent, 30_000);
    const holdId = await seedHold(intent, {
      refundId: "rf_for_y",
      amountIdr: 30_000,
      providerPaymentRef: y.providerRef,
    });

    const response = await resolveHold(staff, holdId, "counted_against_intent");
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const rows = await providerRefsOf(intent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider_refund_id).toBe("rf_for_y");
    expect(rows[0]!.provider_payment_ref, "recorded against Y").toBe(
      y.providerRef,
    );
    expect(rows[0]!.provider_payment_ref).not.toBe(intent.providerRef);

    // The provider already gave Y's money back: the parked fund cannot go out.
    const again = await resolveFund(y.fundId);
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(again.body.error.code).toBe("PROVIDER_REFUNDED");
    expect(await fundRefundRows(y.fundId)).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });

  it("1025-d-23 a hold without provider_payment_ref on an intent with an extra evidence row is 422 and stays open", async () => {
    const intent = await seedIntent();
    await owner.query(
      `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
       VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', 30000, now())`,
      [
        tenantId,
        outletId,
        intent.id,
        `dp_extra_${randomBytes(6).toString("hex")}`,
      ],
    );
    const holdId = await seedHold(intent, { amountIdr: 30_000 });
    const auditBefore = await auditCount();

    const response = await resolveHold(staff, holdId, "counted_against_intent");
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(await isOpen(holdId)).toBe(true);
    expect(await providerRows(intent.id)).toEqual([]);
    expect(await auditCount()).toBe(auditBefore);

    // Closing without counting is still possible.
    expect((await resolveHold(staff, holdId, "not_this_intent")).status).toBe(
      200,
    );
  });

  it("1025-d-24 a hold without provider_payment_ref on an intent with a parked fund is 422 and stays open", async () => {
    const intent = await seedIntent();
    await owner.query(
      `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason)
       VALUES ($1, $2, $3, $4, 20000, 'overpayment')`,
      [randomUUID(), tenantId, outletId, intent.id],
    );
    const holdId = await seedHold(intent, { amountIdr: 30_000 });

    const response = await resolveHold(staff, holdId, "counted_against_intent");
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(await isOpen(holdId)).toBe(true);
    expect(await providerRows(intent.id)).toEqual([]);
  });
});

describe("1025-d (2) holds of our own refund (payment:<ref>) close only when nothing is in flight and the amount is covered", () => {
  const OWN = (intent: Intent) => `payment:${intent.providerRef}`;

  it.each(["pending", "approved"] as const)(
    "1025-d-25 an own refund still %s: counted_against_intent is 422 even when the provider row exists",
    async (status) => {
      const intent = await seedIntent();
      const filed = await manualRefund(intent.id, 10_000);
      expect(filed.status, JSON.stringify(filed.body)).toBe(201);
      await owner.query(
        "UPDATE payment_refunds SET status = $3 WHERE tenant_id = $1 AND id = $2",
        [tenantId, filed.body.data.id as string, status],
      );
      await seedProviderRow(intent, OWN(intent), BILL);
      const holdId = await seedHold(intent, {
        refundId: OWN(intent),
        amountIdr: BILL,
      });
      const auditBefore = await auditCount();

      const response = await resolveHold(
        staff,
        holdId,
        "counted_against_intent",
      );
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(await isOpen(holdId)).toBe(true);
      expect(await providerRows(intent.id)).toHaveLength(1);
      expect(await auditCount()).toBe(auditBefore);
    },
  );

  it("1025-d-26 nothing recorded and nothing refunded by us: the amount is not covered, counted_against_intent is 422", async () => {
    const intent = await seedIntent();
    const holdId = await seedHold(intent, {
      refundId: OWN(intent),
      amountIdr: BILL,
    });

    const response = await resolveHold(staff, holdId, "counted_against_intent");
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(await isOpen(holdId)).toBe(true);
    expect(await providerRows(intent.id)).toEqual([]);
  });

  it("1025-d-27 provider rows plus completed own refunds are summed: below the amount is 422, once they reach it the hold closes without a new row", async () => {
    const intent = await seedIntent();
    await completeOwnRefund(intent, 20_000);
    await seedProviderRow(intent, "rf_part_1", 40_000);
    const holdId = await seedHold(intent, {
      refundId: OWN(intent),
      amountIdr: BILL,
    });

    // 20.000 (ours) + 40.000 (provider) = 60.000 < 100.000.
    const short = await resolveHold(staff, holdId, "counted_against_intent");
    expect(short.status, JSON.stringify(short.body)).toBe(422);
    expect(await isOpen(holdId)).toBe(true);

    await seedProviderRow(intent, "rf_part_2", 40_000);
    // 20.000 + 80.000 = 100.000: covered.
    const covered = await resolveHold(staff, holdId, "counted_against_intent");
    expect(covered.status, JSON.stringify(covered.body)).toBe(200);
    expect((await holdRow(holdId)).resolution).toBe("counted_against_intent");
    expect(await providerRows(intent.id), "no new row").toHaveLength(2);
  });

  it("1025-d-28 our own refund already completed and covered everything (no provider row written): the hold is resolvable, no new row", async () => {
    const intent = await seedIntent();
    await completeOwnRefund(intent, BILL);
    expect(await providerRows(intent.id)).toEqual([]);
    const holdId = await seedHold(intent, {
      refundId: OWN(intent),
      amountIdr: BILL,
    });

    const response = await resolveHold(staff, holdId, "counted_against_intent");
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const row = await holdRow(holdId);
    expect(row.resolved_at).not.toBeNull();
    expect(row.resolution).toBe("counted_against_intent");
    expect(await providerRows(intent.id), "no new row").toEqual([]);
    expect(fake.calls, "nothing paid by the resolve").toHaveLength(1);
  });
});

describe("1025-d (3) a hold without a provider refund id can be counted under hold:<holdId>", () => {
  it("1025-d-29 counts the hold amount under hold:<holdId>, closes the hold, journals once", async () => {
    const intent = await seedIntent();
    const holdId = await seedHold(intent, {
      refundId: null,
      amountIdr: 30_000,
    });

    const response = await resolveHold(staff, holdId, "counted_against_intent");
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const rows = await providerRows(intent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider_refund_id: `hold:${holdId}`,
      amount_idr: "30000",
    });
    expect((await holdRow(holdId)).resolution).toBe("counted_against_intent");
    expect(await providerRefundedEvents(intent.id)).toBe(1);
    expect(fake.calls).toHaveLength(0);
  });

  it("1025-d-30 a hold amount of 0 counts the whole remaining paid amount (restrictive): after an earlier 40.000 that is 60.000, then nothing is left to refund", async () => {
    const intent = await seedIntent();
    await seedProviderRow(intent, "rf_before", 40_000);
    const holdId = await seedHold(intent, { refundId: null, amountIdr: 0 });

    const response = await resolveHold(staff, holdId, "counted_against_intent");
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const rows = await providerRows(intent.id);
    expect(rows).toHaveLength(2);
    expect(
      rows.find((r) => r.provider_refund_id === `hold:${holdId}`),
    ).toMatchObject({ amount_idr: "60000" });
    const refused = await manualRefund(intent.id, 1_000);
    expect([409, 422], JSON.stringify(refused.body)).toContain(refused.status);
    expect(await refundRowCount(intent.id)).toBe(0);
  });

  it("1025-d-31 a hold amount of 0 on an untouched payment counts the whole 100.000", async () => {
    const intent = await seedIntent();
    const holdId = await seedHold(intent, { refundId: null, amountIdr: 0 });

    expect(
      (await resolveHold(staff, holdId, "counted_against_intent")).status,
    ).toBe(200);
    const rows = await providerRows(intent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider_refund_id: `hold:${holdId}`,
      amount_idr: String(BILL),
    });
  });

  it("1025-d-32 idempotent: an already written hold:<holdId> row is not doubled, and a repeated resolve is 409 with no second row or event", async () => {
    const intent = await seedIntent();
    const holdId = await seedHold(intent, {
      refundId: null,
      amountIdr: 30_000,
    });
    await seedProviderRow(intent, `hold:${holdId}`, 30_000);

    const first = await resolveHold(staff, holdId, "counted_against_intent");
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(await providerRows(intent.id)).toHaveLength(1);
    const events = await providerRefundedEvents(intent.id);

    const second = await resolveHold(staff, holdId, "counted_against_intent");
    expect(second.status).toBe(409);
    expect(await providerRows(intent.id)).toHaveLength(1);
    expect(await providerRefundedEvents(intent.id)).toBe(events);
    // 30.000 counted once leaves 70.000.
    expect((await manualRefund(intent.id, 70_000)).status).toBe(201);
  });

  it("1025-d-33 a refund beyond the remainder is still refused after counting", async () => {
    const intent = await seedIntent();
    const holdId = await seedHold(intent, {
      refundId: null,
      amountIdr: 30_000,
    });
    expect(
      (await resolveHold(staff, holdId, "counted_against_intent")).status,
    ).toBe(200);

    const over = await manualRefund(intent.id, 80_000);
    expect([409, 422], JSON.stringify(over.body)).toContain(over.status);
    expect(await refundRowCount(intent.id)).toBe(0);
    expect((await manualRefund(intent.id, 70_000)).status).toBe(201);
  });
});
