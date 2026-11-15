// Unallocated funds (PAY-04) leave only through an approved refund
// (brief docs/briefs/sub-payment-approvals.md, section D; legend-hcqs).
// Runs the real Express app, Better Auth, services and PostgreSQL (RLS on);
// only the refund provider is a fake (src/test/refund-fake-gateway.ts).
// Written from the shared contract (packages/shared/src/payment/admin.ts) and
// the approval rules in the brief, not from the service code.
//
// Assumptions where the brief is not exact:
// - Resolving by `refund` only files a pending refund + approval request; the
//   fund stays open (resolution NULL, view status `open`) until the money has
//   actually left (refund `completed`).
// - Fixture policy for `refund`: one level, Finance. Approvers also hold the
//   supervisor role at the outlet (`pos.refund.approve`, as the refund suite).
//   A Finance user without that outlet authority is refused with exactly 403
//   (missing authority is not a state conflict), leaving every row unchanged.
// - A rejected or expired approval leaves the fund unresolved. Whether the
//   fund may be re-requested afterwards is NOT asserted (open product choice);
//   only that nothing was paid and no second live refund exists meanwhile.
// - Deciding an expired approval answers 409 (same as other expired requests).
// - A fund that is already resolved answers 409 on any new resolve.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway";
import { expireDueApprovalRequests } from "../services/platform-approval.service";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";
import { paymentTestScope } from "./payment-test-scope";
import { FakeRefundGateway } from "./refund-fake-gateway";

const scope = paymentTestScope();
const app = createApp();
const tenantId = scope.tenantId;
const outletA = scope.outletId;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const tenantWide: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "session" }),
  { kind: "tenant" },
);
const ADMIN = "/api/payments/admin";

type Client = ReturnType<typeof agent>;
let requester: Client; // Owner: resolves funds, can never approve its own request
let requesterId: string;
let financeA: Client; // Finance + supervisor: may approve
let financeAId: string;
let financeOnly: Client; // Finance without outlet supervisor authority
let fake: FakeRefundGateway;

const userIds: string[] = [];
const linkIds: string[] = [];
const intentIds: string[] = [];
const fundIds: string[] = [];

const otherTenant = randomUUID();
const otherBrand = randomUUID();
const otherLegal = randomUUID();
const otherOutlet = randomUUID();
const otherLink = randomUUID();
const otherIntent = randomUUID();
const otherFund = randomUUID();

const key = (prefix = "k") => `${prefix}-${randomUUID()}`;

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

async function signedIn(
  templateKey: "owner" | "finance",
  label: string,
  alsoSupervisor = false,
) {
  const client = agent(app).set("Host", scope.hostname);
  const email = await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  userIds.push(userId);
  await verifySessionMfa(email);
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
    [tenantId, userId, await roleIdOf(templateKey)],
  );
  if (alsoSupervisor)
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
      [tenantId, userId, await roleIdOf("supervisor"), outletA],
    );
  return { client, userId };
}

/** A settled 100.000 bill with 120.000 received: 20.000 is unallocated. */
async function seedFund(amountIdr = 20_000) {
  const linkId = randomUUID();
  const intentId = randomUUID();
  const fundId = randomUUID();
  linkIds.push(linkId);
  intentIds.push(intentId);
  fundIds.push(fundId);
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, 100000, 100000, 100000, $6)`,
    [
      linkId,
      tenantId,
      outletA,
      randomBytes(32).toString("hex"),
      `UNA-${linkId.slice(0, 8)}`,
      requesterId,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', 100000, $5, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
    [intentId, tenantId, outletA, linkId, `una-${intentId}`],
  );
  await owner.query(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [tenantId, outletA, intentId, `evidence-${intentId}`, 100_000 + amountIdr],
  );
  await owner.query(
    `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason)
     VALUES ($1, $2, $3, $4, $5, 'overpayment')`,
    [fundId, tenantId, outletA, intentId, amountIdr],
  );
  return { fundId, intentId, amountIdr };
}

const resolveFund = (
  client: Client,
  fundId: string,
  note = "Kembalikan kelebihan bayar",
) =>
  client
    .post(`${ADMIN}/unallocated-funds/${fundId}/resolve`)
    .set(originHeader)
    .send({ idempotencyKey: key("fund"), resolution: "refund", note });

const approve = (client: Client, refundId: string) =>
  client
    .post(`${ADMIN}/refunds/${refundId}/approve`)
    .set(originHeader)
    .send({ idempotencyKey: key("apr") });

const reject = (client: Client, refundId: string) =>
  client
    .post(`${ADMIN}/refunds/${refundId}/reject`)
    .set(originHeader)
    .send({
      idempotencyKey: key("rej"),
      reason: "Bukti pengembalian tidak sesuai",
    });

async function refundsOfFund(fundId: string) {
  const { rows } = await owner.query<{ id: string; status: string }>(
    "SELECT id, status FROM payment_refunds WHERE tenant_id = $1 AND unallocated_fund_id = $2 ORDER BY created_at",
    [tenantId, fundId],
  );
  return rows;
}

async function fundRow(fundId: string) {
  const { rows } = await owner.query<{
    resolution: string | null;
    resolved_at: Date | null;
  }>(
    "SELECT resolution, resolved_at FROM payment_unallocated_funds WHERE id = $1",
    [fundId],
  );
  if (!rows[0]) throw new Error("fund row missing");
  return rows[0];
}

/**
 * Everything observable about one refund request: its row, its approval
 * request, and the audit and event rows written about it. Used to prove a
 * refused attempt leaves no trace.
 */
async function refundSnapshot(refundId: string) {
  const refund = await owner.query<{ row: Record<string, unknown> }>(
    "SELECT to_jsonb(r) AS row FROM payment_refunds r WHERE r.id = $1",
    [refundId],
  );
  const approval = await owner.query<{ row: Record<string, unknown> }>(
    `SELECT to_jsonb(a) AS row FROM approval_requests a
     WHERE a.tenant_id = $1 AND a.object_type = 'payment_refund' AND a.object_id = $2`,
    [tenantId, refundId],
  );
  const audits = await owner.query<{ action: string }>(
    `SELECT event->>'action' AS action FROM audit_logs
     WHERE tenant_id = $1 AND event->>'objectId' = $2 ORDER BY id`,
    [tenantId, refundId],
  );
  const events = await owner.query<{ name: string }>(
    `SELECT event->>'name' AS name FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'aggregateId' = $2 ORDER BY id`,
    [tenantId, refundId],
  );
  return {
    refund: refund.rows[0]!.row as { status: string },
    approval: approval.rows.map((r) => r.row),
    audits: audits.rows.map((r) => r.action),
    events: events.rows.map((r) => r.name),
  };
}

/** Resolve the fund and return the single pending refund it opened. */
async function requestRefundFor(fundId: string) {
  const response = await resolveFund(requester, fundId);
  expect(response.status).toBe(200);
  const refunds = await refundsOfFund(fundId);
  expect(refunds).toHaveLength(1);
  expect(refunds[0]!.status).toBe("pending");
  return refunds[0]!.id;
}

async function listedStatus(client: Client, fundId: string) {
  const listed = await client.get(
    `${ADMIN}/unallocated-funds?outletId=${outletA}&limit=100`,
  );
  expect(listed.status).toBe(200);
  return listed.body.data.find((f: { id: string }) => f.id === fundId)?.status;
}

beforeAll(async () => {
  await scope.seed(owner);
  ({ client: requester, userId: requesterId } = await signedIn(
    "owner",
    "Unallocated requester",
  ));
  ({ client: financeA, userId: financeAId } = await signedIn(
    "finance",
    "Unallocated finance",
    true,
  ));
  ({ client: financeOnly } = await signedIn(
    "finance",
    "Unallocated finance only",
  ));
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
    [tenantId],
  );
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'refund', NULL, $2, 1)`,
    [tenantId, await roleIdOf("finance")],
  );

  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Other tenant', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', $3, $4)`,
    [
      otherTenant,
      `other-${otherTenant}`,
      JSON.stringify(cafeLegendPlatformFixtures.packages[0].defaultLimits),
      randomUUID(),
    ],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Other')",
    [otherBrand, otherTenant, `brand-${otherBrand}`],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'Other', false)",
    [otherLegal, otherTenant],
  );
  await owner.query(
    "INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours) VALUES ($1, $2, $3, $4, 'OTHER', 'Other', 'Other', '{}')",
    [otherOutlet, otherTenant, otherBrand, otherLegal],
  );
  await owner.query(
    "INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by) VALUES ($1, $2, $3, $4, 'Other', 100000, 100000, 100000, 'seed')",
    [otherLink, otherTenant, otherOutlet, randomBytes(32).toString("hex")],
  );
  await owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', 100000, $5, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
    [otherIntent, otherTenant, otherOutlet, otherLink, `other-${otherIntent}`],
  );
  await owner.query(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', 120000, now())`,
    [otherTenant, otherOutlet, otherIntent, `evidence-${otherIntent}`],
  );
  await owner.query(
    `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason)
     VALUES ($1, $2, $3, $4, 20000, 'overpayment')`,
    [otherFund, otherTenant, otherOutlet, otherIntent],
  );
});

afterAll(async () => {
  const refunds = await owner.query<{ id: string }>(
    "SELECT id FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
    [[...intentIds, otherIntent]],
  );
  await owner.query(
    "DELETE FROM approval_requests WHERE object_type = 'payment_refund' AND object_id = ANY($1::text[])",
    [refunds.rows.map((r) => r.id)],
  );
  await owner.query(
    "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
    [[...intentIds, otherIntent]],
  );
  await owner.query(
    "DELETE FROM payment_unallocated_funds WHERE payment_intent_id = ANY($1::uuid[])",
    [[...intentIds, otherIntent]],
  );
  await owner.query(
    "DELETE FROM payment_evidence WHERE payment_intent_id = ANY($1::uuid[])",
    [[...intentIds, otherIntent]],
  );
  await owner.query("DELETE FROM payment_intents WHERE id = ANY($1::uuid[])", [
    [...intentIds, otherIntent],
  ]);
  await owner.query("DELETE FROM payment_links WHERE id = ANY($1::uuid[])", [
    [...linkIds, otherLink],
  ]);
  await owner.query("DELETE FROM outlets WHERE id = $1", [otherOutlet]);
  await owner.query("DELETE FROM legal_entities WHERE id = $1", [otherLegal]);
  await owner.query("DELETE FROM brands WHERE id = $1", [otherBrand]);
  await owner.query("DELETE FROM tenants WHERE id = $1", [otherTenant]);
  await owner.query(
    "DELETE FROM approval_requests WHERE tenant_id = $1 AND requested_by = ANY($2::text[])",
    [tenantId, userIds],
  );
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
    [tenantId],
  );
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

describe("PAY-04 unallocated fund: request", () => {
  it("PAY-04 resolving by refund only files a pending request; no money moves and the fund stays open", async () => {
    const { fundId, amountIdr } = await seedFund();
    const refundId = await requestRefundFor(fundId);

    expect(fake.calls).toHaveLength(0);
    expect(await fundRow(fundId)).toMatchObject({
      resolution: null,
      resolved_at: null,
    });
    expect(await listedStatus(requester, fundId)).toBe("open");
    const approvals = await owner.query<{
      status: string;
      requested_by: string;
    }>(
      `SELECT status, requested_by FROM approval_requests
       WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2`,
      [tenantId, refundId],
    );
    expect(approvals.rows).toEqual([
      { status: "pending", requested_by: requesterId },
    ]);
    const refund = await owner.query<{ amount_idr: string }>(
      "SELECT amount_idr::text FROM payment_refunds WHERE id = $1",
      [refundId],
    );
    expect(refund.rows[0]!.amount_idr).toBe(String(amountIdr));
  });

  it("PAY-04 a fund cannot be resolved twice while a request is pending", async () => {
    const { fundId } = await seedFund();
    await requestRefundFor(fundId);
    const again = await resolveFund(financeA, fundId, "Dobel pencairan");
    expect(again.status).toBe(409);
    const byOwnerAgain = await resolveFund(requester, fundId);
    expect(byOwnerAgain.status).toBe(409);
    expect(await refundsOfFund(fundId)).toHaveLength(1);
    expect(fake.calls).toHaveLength(0);
  });

  it("PAY-04 an already resolved fund is refused", async () => {
    const { fundId } = await seedFund();
    await owner.query(
      `UPDATE payment_unallocated_funds SET resolution = 'refund', resolved_at = now(), resolved_by = $2, note = 'Sudah dicairkan' WHERE id = $1`,
      [fundId, requesterId],
    );
    const response = await resolveFund(requester, fundId);
    expect(response.status).toBe(409);
    expect(await refundsOfFund(fundId)).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
  });

  it("PAY-04 the note is required and a session is needed", async () => {
    const { fundId } = await seedFund();
    const noNote = await requester
      .post(`${ADMIN}/unallocated-funds/${fundId}/resolve`)
      .set(originHeader)
      .send({ idempotencyKey: key("fund"), resolution: "refund", note: "" });
    expect(noNote.status).toBe(422);
    const anonymous = await agent(app)
      .set("Host", scope.hostname)
      .post(`${ADMIN}/unallocated-funds/${fundId}/resolve`)
      .set(originHeader)
      .send({
        idempotencyKey: key("fund"),
        resolution: "refund",
        note: "Tanpa sesi",
      });
    expect(anonymous.status).toBe(401);
    expect(await refundsOfFund(fundId)).toHaveLength(0);
  });
});

describe("PAY-04 unallocated fund: approval decides", () => {
  it("PAY-04 the requester cannot approve their own fund refund", async () => {
    const { fundId } = await seedFund();
    const refundId = await requestRefundFor(fundId);
    const response = await approve(requester, refundId);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("APPROVER_IS_REQUESTER");
    expect(fake.calls).toHaveLength(0);
    expect((await refundsOfFund(fundId))[0]!.status).toBe("pending");
    expect((await fundRow(fundId)).resolution).toBeNull();
  });

  it("PAY-04 a Finance user without outlet supervisor authority is refused with 403 and nothing changes; the supervisor can still approve", async () => {
    const { fundId, amountIdr } = await seedFund();
    const refundId = await requestRefundFor(fundId);
    const before = await refundSnapshot(refundId);

    const response = await approve(financeOnly, refundId);
    // Missing authority is a plain refusal (403), not a conflict: the attempt
    // must not end the refund as failed or leave any trace.
    expect(response.status).toBe(403);
    expect(fake.calls).toHaveLength(0);

    const after = await refundSnapshot(refundId);
    expect(after.refund.status).toBe("pending");
    // Refund row, approval request, audit log and event outbox are untouched.
    expect(after).toEqual(before);
    expect((await refundsOfFund(fundId)).map((r) => [r.id, r.status])).toEqual([
      [refundId, "pending"],
    ]);
    // The fund stays unresolved and open: no money has left.
    expect(await fundRow(fundId)).toMatchObject({
      resolution: null,
      resolved_at: null,
    });
    expect(await listedStatus(requester, fundId)).toBe("open");

    // The refused attempt did not poison the request: the legitimate
    // supervisor still approves and the payout happens exactly once.
    const approved = await approve(financeA, refundId);
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({
      status: "completed",
      amountIdr,
      approvedBy: financeAId,
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ refundId, amountIdr });
    expect((await fundRow(fundId)).resolution).toBe("refund");
  });

  it("PAY-04 approval by another person pays out once and resolves the fund, which then cannot be paid again", async () => {
    const { fundId, intentId, amountIdr } = await seedFund();
    const refundId = await requestRefundFor(fundId);

    const approved = await approve(financeA, refundId);
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({
      status: "completed",
      amountIdr,
      approvedBy: financeAId,
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ refundId, amountIdr });

    const resolved = await fundRow(fundId);
    expect(resolved.resolution).toBe("refund");
    expect(resolved.resolved_at).not.toBeNull();
    expect(await listedStatus(requester, fundId)).toBe("resolved");

    // Returning the excess is not a refund of the bill itself.
    const intent = await owner.query<{ status: string }>(
      "SELECT status FROM payment_intents WHERE id = $1",
      [intentId],
    );
    expect(intent.rows[0]!.status).toBe("paid");

    // Neither a new resolve nor a replayed approval pays a second time.
    expect((await resolveFund(requester, fundId)).status).toBe(409);
    const replay = await approve(financeA, refundId);
    expect([200, 409]).toContain(replay.status);
    expect(await refundsOfFund(fundId)).toHaveLength(1);
    expect(fake.calls).toHaveLength(1);
  });

  it("PAY-04 a rejected request pays nothing and leaves the fund unresolved", async () => {
    const { fundId } = await seedFund();
    const refundId = await requestRefundFor(fundId);

    const rejected = await reject(financeA, refundId);
    expect(rejected.status).toBe(200);
    expect(rejected.body.data).toMatchObject({
      status: "failed",
      failureReason: "rejected",
    });
    expect(fake.calls).toHaveLength(0);
    expect((await fundRow(fundId)).resolution).toBeNull();
    expect((await fundRow(fundId)).resolved_at).toBeNull();
    expect(await listedStatus(requester, fundId)).toBe("open");
    // A rejected request can no longer be approved into a payout.
    const late = await approve(financeA, refundId);
    expect(late.status).toBeGreaterThanOrEqual(400);
    expect(fake.calls).toHaveLength(0);
    expect((await refundsOfFund(fundId))[0]!.status).toBe("failed");
  });

  it("PAY-04 an expired request pays nothing and leaves the fund unresolved", async () => {
    const { fundId } = await seedFund();
    const refundId = await requestRefundFor(fundId);
    await owner.query(
      `UPDATE approval_requests
       SET created_at = now() - interval '2 hours', deadline_at = now() - interval '1 minute'
       WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2`,
      [tenantId, refundId],
    );
    await expireDueApprovalRequests(tenantWide);

    const late = await approve(financeA, refundId);
    expect(late.status).toBe(409);
    expect(fake.calls).toHaveLength(0);
    expect((await refundsOfFund(fundId))[0]!.status).not.toBe("completed");
    expect((await fundRow(fundId)).resolution).toBeNull();
    expect(await listedStatus(requester, fundId)).toBe("open");
  });
});

// Multi-level chains: the outlet supervisor authority (`pos.refund.approve`)
// is a property of the whole chain, not of every step.
// Assumptions: a chain is seeded as one `approval_policies` row per level
// (same threshold, `levels` = the level number), as the refund suites do.
// The supervisor authority must come from at least one approver of the chain;
// a non-final approver without it is accepted (200) and only the last step is
// refused (403) when nobody in the chain held it. The level-2 approver below
// also holds Finance because the payment-admin approve path needs
// `payment.reconcile` for every caller.
describe("PAY-04 unallocated fund: multi-level approval chain", () => {
  let financeOnly2: Client; // second Finance without supervisor authority

  async function useTwoLevelChain(level2Template: "supervisor" | "finance") {
    await owner.query(
      "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
      [tenantId],
    );
    for (const [level, template] of [
      [1, "finance"],
      [2, level2Template],
    ] as const)
      await owner.query(
        `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
         VALUES ($1, 'refund', NULL, $2, $3)`,
        [tenantId, await roleIdOf(template), level],
      );
  }

  async function requestsOf(refundId: string) {
    const { rows } = await owner.query<{
      level: number;
      status: string;
      decided_by: string | null;
    }>(
      `SELECT level, status, decided_by FROM approval_requests
       WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2
       ORDER BY level`,
      [tenantId, refundId],
    );
    return rows;
  }

  beforeAll(async () => {
    ({ client: financeOnly2 } = await signedIn(
      "finance",
      "Unallocated finance only 2",
    ));
  });

  afterAll(async () => {
    // Back to the one-level Finance policy the other suites rely on.
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

  it("PAY-04 a Finance approver without supervisor authority passes level 1; the supervisor at level 2 completes the refund with one payout", async () => {
    await useTwoLevelChain("supervisor");
    const { fundId, amountIdr } = await seedFund();
    const refundId = await requestRefundFor(fundId);

    // Level 1 is not the last step: no supervisor authority is needed yet.
    const first = await approve(financeOnly, refundId);
    expect(first.status).toBe(200);
    expect(fake.calls).toHaveLength(0);
    expect((await refundsOfFund(fundId))[0]!.status).toBe("pending");
    expect(await requestsOf(refundId)).toMatchObject([
      { level: 1, status: "approved" },
      { level: 2, status: "pending" },
    ]);
    expect((await fundRow(fundId)).resolution).toBeNull();

    const second = await approve(financeA, refundId);
    expect(second.status).toBe(200);
    expect(second.body.data).toMatchObject({
      status: "completed",
      amountIdr,
      approvedBy: financeAId,
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ refundId, amountIdr });
    expect((await fundRow(fundId)).resolution).toBe("refund");
  });

  it("PAY-04 a chain where nobody has supervisor authority is refused at the last step with 403 and nothing is written", async () => {
    await useTwoLevelChain("finance");
    const { fundId, amountIdr } = await seedFund();
    const refundId = await requestRefundFor(fundId);

    expect((await approve(financeOnly, refundId)).status).toBe(200);
    const before = await refundSnapshot(refundId);
    expect(before.refund.status).toBe("pending");

    const refused = await approve(financeOnly2, refundId);
    expect(refused.status).toBe(403);
    expect(fake.calls).toHaveLength(0);
    expect(await refundSnapshot(refundId)).toEqual(before);
    expect(await requestsOf(refundId)).toMatchObject([
      { level: 1, status: "approved" },
      { level: 2, status: "pending", decided_by: null },
    ]);
    expect((await refundsOfFund(fundId)).map((r) => r.status)).toEqual([
      "pending",
    ]);
    expect((await fundRow(fundId)).resolution).toBeNull();

    // The refusal did not poison the request: an approver with supervisor
    // authority still completes it, paying out exactly once.
    const approved = await approve(financeA, refundId);
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({
      status: "completed",
      amountIdr,
    });
    expect(fake.calls).toHaveLength(1);
  });
});

describe("TEN-02 unallocated fund tenant isolation", () => {
  it("TEN-02 another tenant's fund cannot be resolved or seen", async () => {
    const response = await resolveFund(requester, otherFund);
    expect(response.status).toBe(404);
    const listed = await requester.get(`${ADMIN}/unallocated-funds?limit=100`);
    expect(listed.status).toBe(200);
    expect(listed.body.data.map((f: { id: string }) => f.id)).not.toContain(
      otherFund,
    );
    const untouched = await owner.query(
      "SELECT 1 FROM payment_refunds WHERE unallocated_fund_id = $1",
      [otherFund],
    );
    expect(untouched.rows).toHaveLength(0);
    expect((await fundRow(otherFund)).resolution).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });
});
