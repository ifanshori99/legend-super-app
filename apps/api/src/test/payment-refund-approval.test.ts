// Refund approval and provider payout (beads legend-hvvn, legend-rbjw; PAY-04).
// A refund is only a request until a second person approves it through the
// approval matrix (PRD §3.7); money then leaves through the refund gateway port.
// Runs the real Express app, Better Auth, services and PostgreSQL (RLS on); only
// the refund provider is a fake (src/test/refund-fake-gateway.ts).
//
// Assumptions where docs/briefs/sub-refund-approval.md is not exact:
// - Fixture approval policy for `refund` (seeded here, restored afterwards):
//   every amount needs Finance at level 1; from Rp500.000 the Owner decides at
//   level 2 as well. Requesters are Owners, so the requester is never an approver.
// - Replaying an approval that is already settled answers 200 with the current
//   view; a second distinct approver racing the first may get 200 or 409.
// - `applyRefundProviderUpdate` refuses by throwing OR by returning without a
//   write; the tests assert the stored state, not the refusal mechanism.
// - Payout robustness (brief section F): a sweep "backoff" is anything between
//   0 and 60 minutes after the last update, so tests only use "just now" (must
//   wait) and "two hours ago" (must run); the attempt cap is 8, tested at 8 and 1.
// - A stale payout caller (its lease was replaced) may or may not write
//   `last_payout_error`; tests only assert the lease fields and terminal state.
// - A failing status lookup (throw) is treated as unknown: no re-send.
// - `payment_intents.status` after a completed bill refund is `refunded` when the
//   completed refunds cover the whole payment, else `partially_refunded`.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { and, eq } from "drizzle-orm";
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
import { eventEnvelopeSchema } from "@starter/shared/events";
import { createApp } from "../app";
import { db } from "../db";
import { paymentRefunds } from "../db/schema/index";
import { withTenant } from "../db/tenant";
import { outletContext } from "../services/device-pin-support";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway";
import { decideApprovalRequest } from "../services/platform-approval.service";
import {
  SYSTEM_APPROVAL_REQUESTER,
  applyRefundProviderUpdate,
  handleRefundApprovalResolved,
  openRefundChainAtRequest,
  sweepApprovedRefundPayouts,
} from "../services/payment-refund.service";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";
import { FakeRefundGateway } from "./refund-fake-gateway";

import { paymentTestScope } from "./payment-test-scope";

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
let requester: Client; // Owner: files refunds, can never approve its own
let requesterId: string;
let financeA: Client; // Finance: level 1 approver
let financeAId: string;
let financeB: Client; // a second, distinct Finance approver
let financeBId: string;
let ownerB: Client; // Owner: level 2 approver (a different person from requester)
let ownerBId: string;

const userIds: string[] = [];
const linkIds: string[] = [];
const intentIds: string[] = [];
const refundIds: string[] = [];
let savedPolicies: Record<string, unknown>[] = [];
let fake: FakeRefundGateway;

// A separate tenant with its own refunds (isolation).
const otherTenant = randomUUID();
const otherBrand = randomUUID();
const otherLegal = randomUUID();
const otherOutlet = randomUUID();
const otherLink = randomUUID();
const otherIntent = randomUUID();
const otherPendingRefund = randomUUID();
const otherApprovedRefund = randomUUID();

const key = (prefix = "k") => `${prefix}-${randomUUID()}`;

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

// Supervisor authority (`pos.refund.approve`, PRD D14) is required to decide a
// refund; Finance alone no longer pays out. The Finance approvers below
// therefore also hold the supervisor template scoped to the refund outlet.
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

async function setPolicy(
  thresholdIdr: number | null,
  templateKey: string,
  level: number,
) {
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'refund', $2, $3, $4)`,
    [tenantId, thresholdIdr, await roleIdOf(templateKey), level],
  );
}

/** A settled bill: link + paid intent + matching evidence. */
async function seedPaid(amountIdr = 100_000, evidenceIdr = amountIdr) {
  const linkId = randomUUID();
  const intentId = randomUUID();
  linkIds.push(linkId);
  intentIds.push(intentId);
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, $7)`,
    [
      linkId,
      tenantId,
      outletA,
      randomBytes(32).toString("hex"),
      `RFA-${linkId.slice(0, 8)}`,
      amountIdr,
      requesterId,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
    [intentId, tenantId, outletA, linkId, amountIdr, `rfa-${intentId}`],
  );
  const evidenceRef = `evidence-${intentId}`;
  await owner.query(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [tenantId, outletA, intentId, evidenceRef, evidenceIdr],
  );
  return { intentId, evidenceRef, amountIdr };
}

async function requestRefund(intentId: string, amountIdr: number) {
  const response = await requester
    .post(`${ADMIN}/refunds`)
    .set(originHeader)
    .send({
      idempotencyKey: key("req"),
      paymentIntentId: intentId,
      amountIdr,
      reason: "Pelanggan mengembalikan pesanan",
    });
  expect(response.status).toBe(201);
  expect(response.body.data.status).toBe("pending");
  const id = response.body.data.id as string;
  refundIds.push(id);
  return id;
}

const approve = (client: Client, id: string, idempotencyKey = key("apr")) =>
  client
    .post(`${ADMIN}/refunds/${id}/approve`)
    .set(originHeader)
    .send({ idempotencyKey });
const reject = (
  client: Client,
  id: string,
  reason = "Bukti pengembalian tidak sesuai",
) =>
  client
    .post(`${ADMIN}/refunds/${id}/reject`)
    .set(originHeader)
    .send({ idempotencyKey: key("rej"), reason });
const retry = (client: Client, id: string) =>
  client
    .post(`${ADMIN}/refunds/${id}/retry`)
    .set(originHeader)
    .send({ idempotencyKey: key("retry") });

async function refundRow(id: string) {
  const { rows } = await owner.query<{
    status: string;
    failure_reason: string | null;
    provider_ref: string | null;
    approved_by: string | null;
    decided_at: Date | null;
    completed_at: Date | null;
    payout_attempts: number;
    last_payout_error: string | null;
    approval_chain_id: string | null;
  }>(
    `SELECT status, failure_reason, provider_ref, approved_by, decided_at, completed_at,
            payout_attempts, last_payout_error, approval_chain_id
     FROM payment_refunds WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  if (!rows[0]) throw new Error("refund row missing");
  return rows[0];
}

async function intentStatus(intentId: string) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM payment_intents WHERE tenant_id = $1 AND id = $2",
    [tenantId, intentId],
  );
  return rows[0]?.status;
}

async function refundable(intentId: string) {
  const response = await requester.get(
    `${ADMIN}/refunds/refundable?outletId=${outletA}`,
  );
  expect(response.status).toBe(200);
  return response.body.data.payments.find(
    (p: { paymentIntentId: string }) => p.paymentIntentId === intentId,
  ) as
    | {
        paidAmountIdr: number;
        refundedAmountIdr: number;
        refundableAmountIdr: number;
      }
    | undefined;
}

async function decisions(refundId: string) {
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

async function attempt(run: () => Promise<unknown>) {
  try {
    await run();
    return { threw: false };
  } catch {
    return { threw: true };
  }
}

beforeAll(async () => {
  await scope.seed(owner);
  ({ client: requester, userId: requesterId } = await signedIn(
    "owner",
    "Refund requester",
  ));
  ({ client: financeA, userId: financeAId } = await signedIn(
    "finance",
    "Refund finance A",
    true,
  ));
  ({ client: financeB, userId: financeBId } = await signedIn(
    "finance",
    "Refund finance B",
    true,
  ));
  ({ client: ownerB, userId: ownerBId } = await signedIn(
    "owner",
    "Refund owner B",
  ));

  savedPolicies = (
    await owner.query(
      "SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
      [tenantId],
    )
  ).rows;
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
    [tenantId],
  );
  await setPolicy(null, "finance", 1);
  await setPolicy(500_000, "finance", 1);
  await setPolicy(500_000, "owner", 2);

  // Another tenant with a pending and an approved refund.
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
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by)
     VALUES ($1, $2, $3, $4, 10000, 'Other tenant refund', 'pending', 'other-requester')`,
    [otherPendingRefund, otherTenant, otherOutlet, otherIntent],
  );
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by, approved_by, decided_at)
     VALUES ($1, $2, $3, $4, 20000, 'Other tenant approved', 'approved', 'other-requester', 'other-approver', now())`,
    [otherApprovedRefund, otherTenant, otherOutlet, otherIntent],
  );
});

afterAll(async () => {
  const everyRefund = [...refundIds, otherPendingRefund, otherApprovedRefund];
  await owner.query(
    "DELETE FROM approval_requests WHERE object_type = 'payment_refund' AND object_id = ANY($1::text[])",
    [everyRefund],
  );
  await owner.query(
    "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
    [[...intentIds, otherIntent]],
  );
  await owner.query(
    "DELETE FROM payment_unallocated_funds WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  await owner.query(
    "DELETE FROM payment_provider_refunds WHERE payment_intent_id = ANY($1::uuid[])",
    [[...intentIds, otherIntent]],
  );
  await owner.query(
    "DELETE FROM payment_evidence WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  await owner.query(
    "DELETE FROM refund_recon_holds WHERE payment_intent_id = ANY($1::uuid[])",
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
  for (const row of savedPolicies)
    await owner.query(
      `INSERT INTO approval_policies (id, tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        row.id,
        row.tenant_id,
        row.action_type,
        row.threshold_idr,
        row.approver_role_id,
        row.levels,
        row.requires_distinct_actor,
      ],
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

describe("PAY-04 refund approval: request, approve, payout", () => {
  it("PAY-04 requires a session and a valid body on approve, reject and retry", async () => {
    const id = randomUUID();
    for (const action of ["approve", "reject", "retry"]) {
      const anonymous = await agent(app)
        .set("Host", scope.hostname)
        .post(`${ADMIN}/refunds/${id}/${action}`)
        .set(originHeader)
        .send({ idempotencyKey: key() });
      expect(anonymous.status).toBe(401);
    }
    const intent = await seedPaid();
    const refundId = await requestRefund(intent.intentId, 10_000);
    const tooShort = await reject(financeA, refundId, "x");
    expect(tooShort.status).toBe(422);
    const unknown = await approve(financeA, randomUUID());
    expect(unknown.status).toBe(404);
    expect((await refundRow(refundId)).status).toBe("pending");
  });

  it("PAY-04 approval by another person pays out and completes a partial refund", async () => {
    const intent = await seedPaid(100_000);
    const refundId = await requestRefund(intent.intentId, 60_000);
    // Requesting is not paying: the provider is untouched while pending.
    expect(fake.calls).toHaveLength(0);

    const response = await approve(financeA, refundId);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: refundId,
      status: "completed",
      amountIdr: 60_000,
    });
    expect(response.body.data.providerRef).toEqual(expect.any(String));
    expect(response.body.data.completedAt).toEqual(expect.any(String));
    expect(response.body.data.approvedBy).toBe(financeAId);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      refundId,
      idempotencyKey: `refund:${refundId}`,
      paymentIntentId: intent.intentId,
      amountIdr: 60_000,
    });
    const row = await refundRow(refundId);
    expect(row).toMatchObject({
      status: "completed",
      approved_by: financeAId,
      failure_reason: null,
      payout_attempts: 1,
    });
    expect(row.provider_ref).toBe(response.body.data.providerRef);
    expect(row.decided_at).not.toBeNull();
    expect(row.completed_at).not.toBeNull();
    expect(await intentStatus(intent.intentId)).toBe("partially_refunded");
    expect(await refundable(intent.intentId)).toMatchObject({
      refundedAmountIdr: 60_000,
      refundableAmountIdr: 40_000,
    });
  });

  it("PAY-04 a refund covering the whole payment marks the payment refunded", async () => {
    const intent = await seedPaid(100_000);
    const refundId = await requestRefund(intent.intentId, 100_000);
    const response = await approve(financeA, refundId);
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe("completed");
    expect(await intentStatus(intent.intentId)).toBe("refunded");
  });

  it("PAY-04 the refund list tells each viewer whether they may approve", async () => {
    const intent = await seedPaid();
    const refundId = await requestRefund(intent.intentId, 10_000);
    const before = await financeA.get(
      `${ADMIN}/refunds?outletId=${outletA}&limit=100`,
    );
    expect(before.status).toBe(200);
    const pendingView = before.body.data.find(
      (r: { id: string }) => r.id === refundId,
    );
    expect(pendingView).toMatchObject({ status: "pending" });
    // The approve button is offered to Finance, never to the requester.
    expect(pendingView.viewerCanApprove).toBe(true);
    const asRequester = await requester.get(
      `${ADMIN}/refunds?outletId=${outletA}&limit=100`,
    );
    expect(
      asRequester.body.data.find((r: { id: string }) => r.id === refundId)
        .viewerCanApprove,
    ).toBe(false);
  });
});

describe("PAY-04 refund rejection", () => {
  it("PAY-04 rejecting fails the refund with reason `rejected` and frees the amount", async () => {
    const intent = await seedPaid(100_000);
    const refundId = await requestRefund(intent.intentId, 60_000);
    expect(await refundable(intent.intentId)).toMatchObject({
      refundableAmountIdr: 40_000,
    });

    const response = await reject(financeA, refundId);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: refundId,
      status: "failed",
      failureReason: "rejected",
    });
    expect(fake.calls).toHaveLength(0);
    expect(await refundRow(refundId)).toMatchObject({
      status: "failed",
      failure_reason: "rejected",
      provider_ref: null,
    });
    expect(await refundable(intent.intentId)).toMatchObject({
      refundedAmountIdr: 0,
      refundableAmountIdr: 100_000,
    });
    expect(await intentStatus(intent.intentId)).toBe("paid");

    // A decided refund cannot be rejected, approved or retried again.
    expect((await reject(financeB, refundId)).status).toBe(409);
    expect((await retry(financeB, refundId)).status).toBe(409);
    const late = await approve(financeB, refundId);
    expect(late.status).toBe(409);
    expect((await refundRow(refundId)).status).toBe("failed");
    expect(fake.calls).toHaveLength(0);
  });

  it("PAY-04 the requester cannot reject their own request", async () => {
    const intent = await seedPaid();
    const refundId = await requestRefund(intent.intentId, 10_000);
    const response = await reject(requester, refundId);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("APPROVER_IS_REQUESTER");
    expect((await refundRow(refundId)).status).toBe("pending");
  });
});

describe("PAY-04 provider failures", () => {
  it("PAY-04 a provider timeout keeps the refund approved; retry only looks it up and never sends it again", async () => {
    const intent = await seedPaid(100_000);
    const refundId = await requestRefund(intent.intentId, 30_000);
    fake.enqueue("throw");

    const first = await approve(financeA, refundId);
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({
      status: "approved",
      payoutAttempts: 1,
      providerRef: null,
      completedAt: null,
    });
    // Only a short code is shown, never the provider's message.
    expect(first.body.data.lastPayoutError).toEqual(expect.any(String));
    expect(first.body.data.lastPayoutError.length).toBeLessThanOrEqual(100);
    expect(first.body.data.lastPayoutError).not.toContain("timeout");
    expect(await intentStatus(intent.intentId)).toBe("paid");
    // Still reserved: the unknown outcome must not free the money.
    expect(await refundable(intent.intentId)).toMatchObject({
      refundedAmountIdr: 30_000,
      refundableAmountIdr: 70_000,
    });

    // legend-xd2q: the retry only looks the refund up; the provider does not
    // know it, so it is flagged for ops and never sent a second time.
    const second = await retry(financeB, refundId);
    expect([200, 409]).toContain(second.status);
    expect(fake.calls).toHaveLength(1);
    expect(fake.executionCount).toBe(0);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      payout_attempts: 2,
      last_payout_error: "PAYOUT_NOT_FOUND_MAYBE_SENT",
    });
    expect(await intentStatus(intent.intentId)).toBe("paid");
    // Still reserved until ops settle it.
    expect(await refundable(intent.intentId)).toMatchObject({
      refundedAmountIdr: 30_000,
      refundableAmountIdr: 70_000,
    });
  });

  it("PAY-04 retrying a refund that was never approved is refused", async () => {
    const intent = await seedPaid();
    const refundId = await requestRefund(intent.intentId, 10_000);
    const response = await retry(financeA, refundId);
    expect(response.status).toBe(409);
    expect(fake.calls).toHaveLength(0);
    expect((await refundRow(refundId)).status).toBe("pending");
  });

  it("PAY-04 a definitive provider decline fails the refund and frees the amount", async () => {
    const intent = await seedPaid(100_000);
    const refundId = await requestRefund(intent.intentId, 70_000);
    fake.enqueue("failed");

    const response = await approve(financeA, refundId);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      status: "failed",
      failureReason: "provider_declined",
    });
    expect(await refundRow(refundId)).toMatchObject({
      status: "failed",
      failure_reason: "provider_declined",
    });
    expect(await intentStatus(intent.intentId)).toBe("paid");
    expect(await refundable(intent.intentId)).toMatchObject({
      refundedAmountIdr: 0,
      refundableAmountIdr: 100_000,
    });
    // A declined refund is final. legend-w2td5 (1045 F1): it had been sent, so
    // the intent is held until finance checks the provider: a new request is
    // refused (409) and there is exactly one open own_refund_failed_unverified
    // hold. Finance (owner) closes it `not_this_intent`; then the money can be
    // requested again.
    expect((await retry(financeA, refundId)).status).toBe(409);
    const refused = await requester
      .post(`${ADMIN}/refunds`)
      .set(originHeader)
      .send({
        idempotencyKey: key("req"),
        paymentIntentId: intent.intentId,
        amountIdr: 100_000,
        reason: "Pelanggan mengembalikan pesanan",
      });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    const { rows: holds } = await owner.query<{ id: string }>(
      `SELECT id FROM refund_recon_holds
        WHERE payment_intent_id = $1 AND reason = 'own_refund_failed_unverified'
          AND resolved_at IS NULL`,
      [intent.intentId],
    );
    expect(holds).toHaveLength(1);
    const resolved = await requester
      .post(`${ADMIN}/refund-recon-holds/${holds[0]!.id}/resolve`)
      .set(originHeader)
      .send({
        idempotencyKey: key("hold"),
        resolution: "not_this_intent",
        note: "Dicek di dashboard penyedia: refund gagal, dana masih di kami.",
      });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    await requestRefund(intent.intentId, 100_000);
  });
});

describe("PAY-04 replay and concurrency", () => {
  it("PAY-04 the same approve call twice makes one decision and one provider execution", async () => {
    const intent = await seedPaid();
    const refundId = await requestRefund(intent.intentId, 40_000);
    const idempotencyKey = key("same");

    const first = await approve(financeA, refundId, idempotencyKey);
    const replay = await approve(financeA, refundId, idempotencyKey);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body.data).toMatchObject({
      id: refundId,
      status: "completed",
      providerRef: first.body.data.providerRef,
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.executionCount).toBe(1);
    const levels = await decisions(refundId);
    expect(levels).toHaveLength(1);
    expect(levels[0]).toMatchObject({
      status: "approved",
      decided_by: financeAId,
    });
    expect((await refundRow(refundId)).payout_attempts).toBe(1);
  });

  it("PAY-04 two approvers at once cause exactly one provider execution", async () => {
    const intent = await seedPaid();
    const refundId = await requestRefund(intent.intentId, 40_000);

    const [one, two] = await Promise.all([
      approve(financeA, refundId),
      approve(financeB, refundId),
    ]);
    for (const response of [one, two])
      expect([200, 409]).toContain(response.status);
    expect([one.status, two.status]).toContain(200);
    expect(fake.executionCount).toBe(1);
    expect(new Set(fake.calls.map((c) => c.idempotencyKey))).toEqual(
      new Set([`refund:${refundId}`]),
    );
    expect(await refundRow(refundId)).toMatchObject({ status: "completed" });
    expect(await intentStatus(intent.intentId)).toBe("partially_refunded");
  });

  it("PAY-04 a second approval while the payout is in flight does not call the provider again", async () => {
    const intent = await seedPaid();
    const refundId = await requestRefund(intent.intentId, 40_000);
    let release!: () => void;
    fake.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = approve(financeA, refundId).then((response) => response);
    try {
      await expect.poll(() => fake.calls.length, { timeout: 15_000 }).toBe(1);
      let secondDone = false;
      const second = approve(financeB, refundId).then((response) => {
        secondDone = true;
        return response;
      });
      // The in-flight payout is claimed, so the second call returns without
      // waiting on (or reaching) the provider.
      await expect.poll(() => secondDone, { timeout: 15_000 }).toBe(true);
      expect(fake.calls).toHaveLength(1);
      expect([200, 409]).toContain((await second).status);
      expect((await refundRow(refundId)).status).toBe("approved");
    } finally {
      release();
    }
    const done = await first;
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe("completed");
    expect(fake.executionCount).toBe(1);
    expect(fake.calls).toHaveLength(1);
    expect((await refundRow(refundId)).status).toBe("completed");
  });
});

describe("PAY-04 pending refunds reserve the bill", () => {
  it("PAY-04 a pending refund holds back its amount from the refundable balance", async () => {
    const intent = await seedPaid(100_000);
    expect(await refundable(intent.intentId)).toMatchObject({
      paidAmountIdr: 100_000,
      refundedAmountIdr: 0,
      refundableAmountIdr: 100_000,
    });
    const first = await requestRefund(intent.intentId, 60_000);
    expect(await refundable(intent.intentId)).toMatchObject({
      refundedAmountIdr: 60_000,
      refundableAmountIdr: 40_000,
    });
    const over = await requester
      .post(`${ADMIN}/refunds`)
      .set(originHeader)
      .send({
        idempotencyKey: key("over"),
        paymentIntentId: intent.intentId,
        amountIdr: 40_001,
        reason: "Lebih dari sisa",
      });
    expect(over.status).toBe(409);
    const exact = await requestRefund(intent.intentId, 40_000);
    // Fully reserved by pending refunds: nothing left, so the payment is no
    // longer offered on the refund screen, and any further request is refused.
    expect(await refundable(intent.intentId)).toBeUndefined();
    const more = await requester
      .post(`${ADMIN}/refunds`)
      .set(originHeader)
      .send({
        idempotencyKey: key("more"),
        paymentIntentId: intent.intentId,
        amountIdr: 1,
        reason: "Sisa nol",
      });
    expect(more.status).toBe(409);

    // Rejecting one frees only its own share.
    expect((await reject(financeA, first)).status).toBe(200);
    expect(await refundable(intent.intentId)).toMatchObject({
      refundedAmountIdr: 40_000,
      refundableAmountIdr: 60_000,
    });
    expect((await refundRow(exact)).status).toBe("pending");
  });
});

describe("PAY-04 unallocated fund refunds", () => {
  it("PAY-04 resolving a fund by refund is a pending request, approved later and then resolves the fund", async () => {
    // Paid 100.000 for a 100.000 bill, 120.000 received: 20.000 is unallocated.
    const intent = await seedPaid(100_000, 120_000);
    const fundId = randomUUID();
    await owner.query(
      `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason)
       VALUES ($1, $2, $3, $4, 20000, 'overpayment')`,
      [fundId, tenantId, outletA, intent.intentId],
    );
    const resolve = await requester
      .post(`${ADMIN}/unallocated-funds/${fundId}/resolve`)
      .set(originHeader)
      .send({
        idempotencyKey: key("fund"),
        resolution: "refund",
        note: "Kembalikan kelebihan bayar",
      });
    expect(resolve.status).toBe(200);
    const pending = await owner.query<{ id: string; status: string }>(
      "SELECT id, status FROM payment_refunds WHERE tenant_id = $1 AND unallocated_fund_id = $2",
      [tenantId, fundId],
    );
    expect(pending.rows).toHaveLength(1);
    const refundId = pending.rows[0]!.id;
    refundIds.push(refundId);
    expect(pending.rows[0]!.status).toBe("pending");
    expect(fake.calls).toHaveLength(0);
    // The fund is not resolved until the money has actually left.
    const open = await owner.query<{ resolution: string | null }>(
      "SELECT resolution FROM payment_unallocated_funds WHERE id = $1",
      [fundId],
    );
    expect(open.rows[0]!.resolution).toBeNull();
    // The excess does not eat into what the bill itself can refund.
    expect(await refundable(intent.intentId)).toMatchObject({
      refundedAmountIdr: 0,
      refundableAmountIdr: 100_000,
    });

    const approved = await approve(financeA, refundId);
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({
      status: "completed",
      amountIdr: 20_000,
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      refundId,
      amountIdr: 20_000,
      paymentProviderRef: intent.evidenceRef,
    });
    const resolved = await owner.query<{
      resolution: string | null;
      resolved_at: Date | null;
    }>(
      "SELECT resolution, resolved_at FROM payment_unallocated_funds WHERE id = $1",
      [fundId],
    );
    expect(resolved.rows[0]!.resolution).toBe("refund");
    expect(resolved.rows[0]!.resolved_at).not.toBeNull();
    // Returning the excess is not a refund of the bill.
    expect(await intentStatus(intent.intentId)).toBe("paid");
    expect(await refundable(intent.intentId)).toMatchObject({
      refundedAmountIdr: 0,
      refundableAmountIdr: 100_000,
    });
  });
});

describe("TEN-02 refund tenant isolation", () => {
  it("TEN-02 another tenant's refunds cannot be approved, rejected, retried or seen", async () => {
    expect((await approve(financeA, otherPendingRefund)).status).toBe(404);
    expect((await reject(financeA, otherPendingRefund)).status).toBe(404);
    expect((await retry(financeA, otherApprovedRefund)).status).toBe(404);
    expect((await approve(financeA, otherApprovedRefund)).status).toBe(404);

    const listed = await financeA.get(`${ADMIN}/refunds?limit=100`);
    expect(listed.status).toBe(200);
    const ids = listed.body.data.map((r: { id: string }) => r.id);
    expect(ids).not.toContain(otherPendingRefund);
    expect(ids).not.toContain(otherApprovedRefund);

    expect(fake.calls).toHaveLength(0);
    const untouched = await owner.query<{ id: string; status: string }>(
      "SELECT id, status FROM payment_refunds WHERE id = ANY($1::uuid[]) ORDER BY amount_idr",
      [[otherPendingRefund, otherApprovedRefund]],
    );
    expect(untouched.rows.map((r) => r.status)).toEqual([
      "pending",
      "approved",
    ]);
  });
});

describe("PAY-04 approval matrix", () => {
  it("PAY-04 the requester cannot approve their own refund", async () => {
    const intent = await seedPaid();
    const refundId = await requestRefund(intent.intentId, 10_000);
    const response = await approve(requester, refundId);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("APPROVER_IS_REQUESTER");
    expect(fake.calls).toHaveLength(0);
    expect((await refundRow(refundId)).status).toBe("pending");
  });

  it("PAY-04 a multi-level amount needs a second distinct approver before payout", async () => {
    // 600.000 is above the Rp500.000 tier. The first signer also holds
    // outlet-manager authority for Q63's amount ceiling; the matrix still
    // requires Finance first and a distinct Owner second.
    const elevated = await owner.query<{ id: string }>(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_at, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', now() - interval '1 hour', $2) RETURNING id`,
      [tenantId, financeAId, await roleIdOf("outlet_manager"), outletA],
    );
    try {
      const intent = await seedPaid(600_000);
      const refundId = await requestRefund(intent.intentId, 600_000);

      const level1 = await approve(financeA, refundId);
      expect(level1.status).toBe(200);
      expect(level1.body.data.status).toBe("pending");
      expect(fake.calls).toHaveLength(0);
      expect(await decisions(refundId)).toMatchObject([
        { level: 1, status: "approved", decided_by: financeAId },
        { level: 2, status: "pending" },
      ]);

      // The same person cannot also give the second approval.
      const again = await approve(financeA, refundId);
      expect([403, 409]).toContain(again.status);
      // The requester cannot either.
      expect((await approve(requester, refundId)).status).toBe(403);
      expect(fake.calls).toHaveLength(0);
      expect((await refundRow(refundId)).status).toBe("pending");

      const level2 = await approve(ownerB, refundId);
      expect(level2.status).toBe(200);
      expect(level2.body.data).toMatchObject({
        status: "completed",
        approvedBy: ownerBId,
      });
      expect(fake.calls).toHaveLength(1);
      expect(fake.executionCount).toBe(1);
      expect(await intentStatus(intent.intentId)).toBe("refunded");
    } finally {
      await owner.query("DELETE FROM role_assignments WHERE id = $1", [
        elevated.rows[0]!.id,
      ]);
    }
  });

  it("PAY-04 rejecting at level 1 of a multi-level request ends it without payout", async () => {
    const intent = await seedPaid(600_000);
    const refundId = await requestRefund(intent.intentId, 550_000);
    const response = await reject(financeA, refundId);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      status: "failed",
      failureReason: "rejected",
    });
    expect(fake.calls).toHaveLength(0);
    expect(await refundable(intent.intentId)).toMatchObject({
      refundableAmountIdr: 600_000,
    });
  });
});

describe("PAY-04 system-requested refunds", () => {
  // legend-2dnh: a system refund opens its approval chain at creation, with the
  // reserved system user as requester, so one human approval settles it.
  async function insertSystemRefund(
    intentId: string,
    requestedBy = "system:reservation",
  ) {
    const refundId = randomUUID();
    refundIds.push(refundId);
    await owner.query(
      `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by)
       VALUES ($1, $2, $3, $4, 50000, 'Pengembalian DP reservasi', 'pending', $5)`,
      [refundId, tenantId, outletA, intentId, requestedBy],
    );
    return refundId;
  }

  it("PAY-04 a refund requested by the system has its chain open from creation and one approver pays it out", async () => {
    const intent = await seedPaid();
    const refundId = await insertSystemRefund(intent.intentId);

    // Creation opens the chain; the requester is the reserved system user.
    const opened = await openChainForSystemRefund(refundId);
    expect(opened.approvalChainId).not.toBeNull();
    expect(await decisions(refundId)).toMatchObject([
      { level: 1, status: "pending" },
    ]);
    const { rows } = await owner.query<{ requested_by: string }>(
      `SELECT requested_by FROM approval_requests
       WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2`,
      [tenantId, refundId],
    );
    expect(rows).toEqual([{ requested_by: SYSTEM_APPROVAL_REQUESTER }]);

    // An approver finds it in the inbox with nobody having submitted it first.
    const inbox = await financeB.get(
      "/api/approvals?status=pending&actionType=refund&limit=100",
    );
    expect(inbox.status).toBe(200);
    expect(
      (inbox.body.data as Array<{ objectId: string }>).map((r) => r.objectId),
    ).toContain(refundId);
    expect(fake.calls).toHaveLength(0);

    // One approval is enough; the first human is a real approver, not a submitter.
    const approved = await approve(financeB, refundId);
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({
      status: "completed",
      approvedBy: financeBId,
      requestedBy: "system:reservation",
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ refundId, amountIdr: 50_000 });
    expect(fake.executionCount).toBe(1);
    expect(await refundRow(refundId)).toMatchObject({
      status: "completed",
      approved_by: financeBId,
    });
    expect(await intentStatus(intent.intentId)).toBe("partially_refunded");
  });

  it("PAY-04 a refund the system filed before chains opened at creation is decided by the first approver", async () => {
    // Pre-deploy refund: no chain yet. The approver decides level 1 directly.
    const intent = await seedPaid();
    const refundId = await insertSystemRefund(intent.intentId);
    const approved = await approve(financeA, refundId);
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({
      status: "completed",
      approvedBy: financeAId,
    });
    expect(fake.calls).toHaveLength(1);
    const { rows } = await owner.query<{ requested_by: string }>(
      `SELECT requested_by FROM approval_requests
       WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2`,
      [tenantId, refundId],
    );
    // The chain was filed by the system user, not by the approver.
    expect(rows).toEqual([{ requested_by: SYSTEM_APPROVAL_REQUESTER }]);
  });

  it("PAY-04 the human who opened the chain of a system-requested refund cannot approve it, another approver can", async () => {
    // Assumption: a chain opened by a human submitter before this change is
    // reproduced by filing the refund as financeA and then marking it as
    // system-requested, which leaves a chain whose requester is financeA.
    const intent = await seedPaid();
    const filed = await financeA
      .post(`${ADMIN}/refunds`)
      .set(originHeader)
      .send({
        idempotencyKey: key("req"),
        paymentIntentId: intent.intentId,
        amountIdr: 50_000,
        reason: "Pengembalian DP reservasi",
      });
    expect(filed.status).toBe(201);
    const refundId = filed.body.data.id as string;
    refundIds.push(refundId);
    await owner.query(
      "UPDATE payment_refunds SET requested_by = 'system:reservation' WHERE tenant_id = $1 AND id = $2",
      [tenantId, refundId],
    );

    // Not a silent 200: the submitter is refused outright.
    const self = await approve(financeA, refundId);
    expect(self.status).toBe(403);
    expect(fake.calls).toHaveLength(0);
    expect((await refundRow(refundId)).status).toBe("pending");
    expect(await intentStatus(intent.intentId)).toBe("paid");

    const other = await approve(financeB, refundId);
    expect(other.status).toBe(200);
    expect(other.body.data).toMatchObject({
      status: "completed",
      approvedBy: financeBId,
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("PAY-04 a system-requested refund can be rejected by a human", async () => {
    const intent = await seedPaid();
    const refundId = randomUUID();
    refundIds.push(refundId);
    await owner.query(
      `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by)
       VALUES ($1, $2, $3, $4, 50000, 'Pengembalian DP reservasi', 'pending', 'system:reservation')`,
      [refundId, tenantId, outletA, intent.intentId],
    );
    const response = await reject(financeA, refundId);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      status: "failed",
      failureReason: "rejected",
    });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("PAY-04 approval that no longer fits the payment", () => {
  it("PAY-04 an approved chain whose amount no longer fits ends failed with cap_exceeded and pays nothing", async () => {
    // Assumption: the cap is breached by another live (non-failed) refund taking
    // the room, inserted directly, so that this refund (60.000) plus it (60.000)
    // exceeds the Rp100.000 payment once approval is decided.
    const intent = await seedPaid(100_000);
    const refundId = await requestRefund(intent.intentId, 60_000);
    const competingId = randomUUID();
    refundIds.push(competingId);
    await owner.query(
      `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by)
       VALUES ($1, $2, $3, $4, 60000, 'Pengembalian lain', 'pending', $5)`,
      [competingId, tenantId, outletA, intent.intentId, requesterId],
    );

    const response = await approve(financeA, refundId);
    expect(response.status).toBe(409);
    expect(fake.calls).toHaveLength(0);
    expect(await refundRow(refundId)).toMatchObject({
      status: "failed",
      failure_reason: "cap_exceeded",
      completed_at: null,
    });
    expect(await intentStatus(intent.intentId)).toBe("paid");

    // The failure is final: another approval is refused and nothing is paid.
    expect((await approve(financeB, refundId)).status).toBe(409);
    expect(fake.calls).toHaveLength(0);
    expect((await refundRow(refundId)).failure_reason).toBe("cap_exceeded");
  });
});

describe("PAY-04 provider updates for asynchronous payouts", () => {
  async function approvedAndPending(amountIdr: number) {
    const intent = await seedPaid(100_000);
    const refundId = await requestRefund(intent.intentId, amountIdr);
    fake.enqueue("pending");
    const response = await approve(financeA, refundId);
    expect(response.status).toBe(200);
    // Accepted by the provider but not finished: still approved, no completion.
    expect(response.body.data.status).toBe("approved");
    const providerRef = response.body.data.providerRef as string;
    expect(providerRef).toEqual(expect.any(String));
    expect((await refundRow(refundId)).completed_at).toBeNull();
    expect(await intentStatus(intent.intentId)).toBe("paid");
    return { intent, refundId, providerRef };
  }

  it("PAY-04 a provider success update completes the refund; a replay changes nothing", async () => {
    const { intent, refundId, providerRef } = await approvedAndPending(60_000);

    await applyRefundProviderUpdate(tenantWide, {
      providerRef,
      status: "succeeded",
      amountIdr: 60_000,
    });
    const done = await refundRow(refundId);
    expect(done).toMatchObject({ status: "completed", failure_reason: null });
    expect(done.completed_at).not.toBeNull();
    expect(await intentStatus(intent.intentId)).toBe("partially_refunded");

    // Same terminal state again: a no-op.
    await applyRefundProviderUpdate(tenantWide, {
      providerRef,
      status: "succeeded",
      amountIdr: 60_000,
    });
    const replayed = await refundRow(refundId);
    expect(replayed.status).toBe("completed");
    expect(replayed.completed_at?.getTime()).toBe(done.completed_at?.getTime());

    // A contradicting update is refused and writes nothing.
    await attempt(() =>
      applyRefundProviderUpdate(tenantWide, {
        providerRef,
        status: "failed",
        code: "late_decline",
      }),
    );
    const after = await refundRow(refundId);
    expect(after).toMatchObject({ status: "completed", failure_reason: null });
    expect(after.completed_at?.getTime()).toBe(done.completed_at?.getTime());
    expect(await intentStatus(intent.intentId)).toBe("partially_refunded");
  });

  it("PAY-04 a provider update with the wrong amount is refused", async () => {
    const { refundId, providerRef } = await approvedAndPending(60_000);
    await attempt(() =>
      applyRefundProviderUpdate(tenantWide, {
        providerRef,
        status: "succeeded",
        amountIdr: 59_000,
      }),
    );
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      completed_at: null,
    });
  });

  it("PAY-04 a provider update with a different reference than the stored one is refused", async () => {
    // Assumption: the update identifies the refund by its idempotency key
    // (`refund:<id>`) while carrying a providerRef that differs from the one the
    // refund already stores; it must be refused with no state change.
    const { intent, refundId, providerRef } = await approvedAndPending(60_000);
    for (const status of ["succeeded", "failed"] as const) {
      await attempt(() =>
        applyRefundProviderUpdate(tenantWide, {
          idempotencyKey: `refund:${refundId}`,
          providerRef: `other-${randomUUID()}`,
          status,
          ...(status === "failed" ? { code: "bank_rejected" } : {}),
          amountIdr: 60_000,
        }),
      );
      expect(await refundRow(refundId)).toMatchObject({
        status: "approved",
        failure_reason: null,
        provider_ref: providerRef,
        completed_at: null,
      });
    }
    expect(await intentStatus(intent.intentId)).toBe("paid");
    expect(await refundable(intent.intentId)).toMatchObject({
      refundedAmountIdr: 60_000,
      refundableAmountIdr: 40_000,
    });
  });

  it("PAY-04 an unknown provider reference changes no refund", async () => {
    const { refundId } = await approvedAndPending(60_000);
    await attempt(() =>
      applyRefundProviderUpdate(tenantWide, {
        providerRef: `unknown-${randomUUID()}`,
        status: "succeeded",
        amountIdr: 60_000,
      }),
    );
    expect((await refundRow(refundId)).status).toBe("approved");
  });

  it("PAY-04 a provider failure update fails the refund and frees the amount", async () => {
    const { intent, refundId, providerRef } = await approvedAndPending(60_000);
    await applyRefundProviderUpdate(tenantWide, {
      providerRef,
      status: "failed",
      code: "bank_rejected",
      amountIdr: 60_000,
    });
    expect(await refundRow(refundId)).toMatchObject({
      status: "failed",
      failure_reason: "provider_declined",
    });
    expect(await refundable(intent.intentId)).toMatchObject({
      refundedAmountIdr: 0,
      refundableAmountIdr: 100_000,
    });

    // A later success cannot resurrect a failed refund.
    await attempt(() =>
      applyRefundProviderUpdate(tenantWide, {
        providerRef,
        status: "succeeded",
        amountIdr: 60_000,
      }),
    );
    expect((await refundRow(refundId)).status).toBe("failed");
    expect(await intentStatus(intent.intentId)).toBe("paid");
  });

  it("PAY-04 a pending refund that was never approved ignores provider updates", async () => {
    const intent = await seedPaid();
    const refundId = await requestRefund(intent.intentId, 10_000);
    await owner.query(
      "UPDATE payment_refunds SET provider_ref = $2 WHERE id = $1",
      [refundId, `stray-${refundId}`],
    );
    await attempt(() =>
      applyRefundProviderUpdate(tenantWide, {
        providerRef: `stray-${refundId}`,
        status: "succeeded",
        amountIdr: 10_000,
      }),
    );
    expect((await refundRow(refundId)).status).toBe("pending");
    expect(await intentStatus(intent.intentId)).toBe("paid");
  });
});

// ---------------------------------------------------------------------------
// Payout robustness (brief section F)
// ---------------------------------------------------------------------------

type HoldOutcome = "succeeded" | "throw";

/**
 * Fake provider with per-call control: hold a `refund()` call until released,
 * make chosen keys time out, make the status lookup fail, and answer
 * `not_found` for keys the provider never saw.
 */
class ControlledRefundGateway extends FakeRefundGateway {
  /** `refund()` calls that have started (held ones included). */
  started = 0;
  lookupFails = false;
  readonly throwFor = new Set<string>();
  private readonly holds: Promise<HoldOutcome>[] = [];

  /** The next `refund()` call waits until the returned function is called. */
  hold(): (outcome: HoldOutcome) => void {
    let release!: (outcome: HoldOutcome) => void;
    this.holds.push(
      new Promise<HoldOutcome>((resolve) => {
        release = resolve;
      }),
    );
    return (outcome) => release(outcome);
  }

  override async refund(input: Parameters<FakeRefundGateway["refund"]>[0]) {
    this.started += 1;
    const hold = this.holds.shift();
    const outcome = hold ? await hold : null;
    if (outcome === "throw" || this.throwFor.has(input.idempotencyKey)) {
      this.calls.push(input);
      throw new Error("fake refund provider timeout");
    }
    return super.refund(input);
  }

  override async getRefundStatus(
    input: Parameters<FakeRefundGateway["getRefundStatus"]>[0],
  ) {
    if (this.lookupFails) {
      this.statusCalls.push(input);
      throw new Error("fake refund provider lookup unavailable");
    }
    try {
      return await super.getRefundStatus(input);
    } catch {
      return { status: "not_found" } as unknown as Awaited<
        ReturnType<FakeRefundGateway["getRefundStatus"]>
      >;
    }
  }

  callsFor(refundId: string) {
    return this.calls.filter((c) => c.refundId === refundId);
  }
  statusCallsFor(refundId: string) {
    return this.statusCalls.filter(
      (c) => c.idempotencyKey === `refund:${refundId}`,
    );
  }
}

function install(): ControlledRefundGateway {
  const gateway = new ControlledRefundGateway();
  fake = gateway;
  setPaymentRefundGateway(gateway);
  return gateway;
}

async function leaseRow(id: string) {
  const { rows } = await owner.query<{
    token: string | null;
    live: boolean;
    claimed_until: Date | null;
    attempts: number;
    status: string;
    provider_ref: string | null;
    last_error: string | null;
    completed_at: Date | null;
  }>(
    `SELECT payout_claim_token AS token,
            COALESCE(payout_claimed_until > now(), false) AS live,
            payout_claimed_until AS claimed_until,
            payout_attempts AS attempts, status, provider_ref,
            last_payout_error AS last_error, completed_at
     FROM payment_refunds WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  if (!rows[0]) throw new Error("refund row missing");
  return rows[0];
}

const expireLease = (id: string) =>
  owner.query(
    "UPDATE payment_refunds SET payout_claimed_until = now() - interval '1 minute' WHERE tenant_id = $1 AND id = $2",
    [tenantId, id],
  );

/** Make the last update look old, so any backoff has elapsed. */
const ageRefund = (id: string, interval = "2 hours") =>
  owner.query(
    `UPDATE payment_refunds SET updated_at = now() - $3::interval WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, interval],
  );

/** An approved refund whose payout never finished (as left by a worker crash). */
async function seedApprovedRefund(opts: {
  attempts?: number;
  amountIdr?: number;
  age?: string;
  leaseMinutes?: number;
}) {
  const intent = await seedPaid(100_000);
  const refundId = randomUUID();
  refundIds.push(refundId);
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
                                  requested_by, approved_by, decided_at, payout_attempts, payout_claimed_until, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian tertunda', 'approved', $6, $7, now(), $8,
             CASE WHEN $9::int IS NULL THEN NULL ELSE now() + make_interval(mins => $9::int) END,
             now() - $10::interval)`,
    [
      refundId,
      tenantId,
      outletA,
      intent.intentId,
      opts.amountIdr ?? 30_000,
      requesterId,
      financeAId,
      opts.attempts ?? 0,
      opts.leaseMinutes ?? null,
      opts.age ?? "2 hours",
    ],
  );
  return { intent, refundId };
}

/** Opens a system refund's chain as its creation does, in a real transaction. */
async function openChainForSystemRefund(refundId: string) {
  const context = outletContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    outletA,
  );
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.tenantId, tenantId),
          eq(paymentRefunds.id, refundId),
        ),
      );
    return openRefundChainAtRequest(tx, context, row!, new Date());
  });
}

/** A pending refund requested by the system, with its approval chain open. */
async function seedSystemRefundWithOpenChain(amountIdr = 50_000) {
  const intent = await seedPaid();
  const refundId = randomUUID();
  refundIds.push(refundId);
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian DP reservasi', 'pending', 'system:reservation')`,
    [refundId, tenantId, outletA, intent.intentId, amountIdr],
  );
  // legend-2dnh: creation opens the chain (requester: the system user), and it
  // waits for an approver.
  await openChainForSystemRefund(refundId);
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM approval_requests
     WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2 AND status = 'pending'
     ORDER BY level LIMIT 1`,
    [tenantId, refundId],
  );
  expect(rows).toHaveLength(1);
  const chainId = (await refundRow(refundId)).approval_chain_id;
  expect(chainId).not.toBeNull();
  return { intent, refundId, requestId: rows[0]!.id, chainId: chainId! };
}

async function resolvedEventOfChain(chainId: string) {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
     WHERE tenant_id = $1 AND destination = 'cloud-sync'
       AND event->>'name' = 'approval.resolved'
       AND event->'payload'->>'chainId' = $2`,
    [tenantId, chainId],
  );
  expect(rows).toHaveLength(1);
  return eventEnvelopeSchema.parse(rows[0]!.event);
}

const sessionTenant = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});
const workerContext: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "job" }),
  { kind: "tenant" },
);

const decide = (
  actorId: string,
  requestId: string,
  decision: "approved" | "rejected",
) =>
  decideApprovalRequest(
    sessionTenant,
    actorId,
    requestId,
    { decision, reason: "Sesuai bukti pengembalian." },
    { mfaVerified: true, idempotencyKey: null },
  );

describe("PAY-04 payout lease: a stale caller cannot clear a newer lease", () => {
  // legend-xd2q: caller 2 (retry) only looks the refund up, it never sends, so it
  // holds no provider call; the stale caller 1 must still not undo its outcome.
  it("PAY-04 a caller whose lease was replaced leaves the newer outcome intact", async () => {
    const gateway = install();
    const intent = await seedPaid(100_000);
    const refundId = await requestRefund(intent.intentId, 30_000);
    const releaseOld = gateway.hold();

    // Caller 1 claims the payout and hangs inside the provider call.
    const oldCaller = approve(financeA, refundId).then((response) => response);
    await expect.poll(() => gateway.started, { timeout: 15_000 }).toBe(1);
    const first = await leaseRow(refundId);
    expect(first).toMatchObject({
      status: "approved",
      attempts: 1,
      live: true,
    });
    expect(first.token).not.toBeNull();

    // Its lease runs out; caller 2 takes over, asks the provider, finds nothing
    // and flags the refund instead of sending.
    await expireLease(refundId);
    const second = await retry(financeB, refundId);
    expect([200, 409]).toContain(second.status);
    expect(gateway.statusCallsFor(refundId)).toHaveLength(1);
    expect(gateway.started).toBe(1);
    const flagged = await leaseRow(refundId);
    expect(flagged).toMatchObject({
      status: "approved",
      attempts: 2,
      live: false,
      last_error: "PAYOUT_NOT_FOUND_MAYBE_SENT",
    });

    // Caller 1 now times out. It must not clear the flag or take a lease back.
    releaseOld("throw");
    const oldDone = await oldCaller;
    expect(oldDone.status).toBe(200);
    const afterStale = await leaseRow(refundId);
    expect(afterStale).toMatchObject({
      status: "approved",
      live: false,
      last_error: "PAYOUT_NOT_FOUND_MAYBE_SENT",
    });
    expect(gateway.started).toBe(1);
    expect(gateway.executionCount).toBe(0);
    expect(await intentStatus(intent.intentId)).toBe("paid");
  });

  it("PAY-04 a stale timeout never downgrades a refund another caller completed", async () => {
    const gateway = install();
    const intent = await seedPaid(100_000);
    const refundId = await requestRefund(intent.intentId, 30_000);
    const releaseOld = gateway.hold();

    const oldCaller = approve(financeA, refundId).then((response) => response);
    await expect.poll(() => gateway.started, { timeout: 15_000 }).toBe(1);
    await expireLease(refundId);

    // Caller 2 asks the provider, which paid (legend-xd2q: a retry never
    // sends), and completes the refund while caller 1 hangs.
    gateway.setStatus(`refund:${refundId}`, {
      status: "succeeded",
      providerRef: "PR-LOOKUP-DONE",
    });
    const newDone = await retry(financeB, refundId);
    expect(newDone.status).toBe(200);
    expect(newDone.body.data.status).toBe("completed");
    const completed = await leaseRow(refundId);
    expect(completed.status).toBe("completed");

    releaseOld("throw");
    expect((await oldCaller).status).toBe(200);

    const after = await leaseRow(refundId);
    expect(after).toMatchObject({
      status: "completed",
      provider_ref: completed.provider_ref,
      live: false,
    });
    expect(after.completed_at?.getTime()).toBe(
      completed.completed_at?.getTime(),
    );
    expect(await intentStatus(intent.intentId)).toBe("partially_refunded");
    expect(await refundable(intent.intentId)).toMatchObject({
      refundedAmountIdr: 30_000,
      refundableAmountIdr: 70_000,
    });
  });
});

describe("PAY-04 retry after an unknown outcome asks the provider first", () => {
  it("PAY-04 the first payout attempt sends the refund without a status lookup", async () => {
    const gateway = install();
    const intent = await seedPaid();
    const refundId = await requestRefund(intent.intentId, 30_000);
    const response = await approve(financeA, refundId);
    expect(response.body.data.status).toBe("completed");
    expect(gateway.callsFor(refundId)).toHaveLength(1);
    expect(gateway.statusCalls).toHaveLength(0);
  });

  // legend-xd2q: a refund that may have been sent is never POSTed again. A
  // `not_found` answer is not proof the provider never saw it (the provider may
  // not have indexed it yet), so the refund stays approved and is flagged for
  // ops, who close it with a manual settlement once it is paid.
  it("PAY-04 not_found on a maybe-sent refund is never sent again: it stays approved, flagged PAYOUT_NOT_FOUND_MAYBE_SENT", async () => {
    const gateway = install();
    const intent = await seedPaid();
    const refundId = await requestRefund(intent.intentId, 30_000);
    gateway.enqueue("throw");
    expect((await approve(financeA, refundId)).body.data.status).toBe(
      "approved",
    );

    // The retry answers the current view (200) or a refusal (409); only the
    // stored state and the provider calls are asserted.
    const response = await retry(financeB, refundId);
    expect([200, 409]).toContain(response.status);
    expect(gateway.statusCallsFor(refundId)).toHaveLength(1);
    expect(gateway.statusCalls[0]).toMatchObject({
      idempotencyKey: `refund:${refundId}`,
    });
    expect(gateway.callsFor(refundId)).toHaveLength(1); // only the first, timed-out call
    expect(gateway.executionCount).toBe(0);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      payout_attempts: 2,
      last_payout_error: "PAYOUT_NOT_FOUND_MAYBE_SENT",
    });
    expect(await intentStatus(intent.intentId)).toBe("paid");
  });

  it("PAY-04 a lookup that finds the refund succeeded completes it without sending again", async () => {
    const gateway = install();
    const intent = await seedPaid();
    const refundId = await requestRefund(intent.intentId, 30_000);
    gateway.enqueue("throw"); // the request timed out, but the provider paid
    expect((await approve(financeA, refundId)).body.data.status).toBe(
      "approved",
    );
    gateway.setStatus(`refund:${refundId}`, {
      status: "succeeded",
      providerRef: "PR-LOOKUP-OK",
    });

    const response = await retry(financeB, refundId);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      status: "completed",
      providerRef: "PR-LOOKUP-OK",
    });
    expect(gateway.statusCallsFor(refundId)).toHaveLength(1);
    expect(gateway.callsFor(refundId)).toHaveLength(1); // only the first, timed-out call
    expect(gateway.executionCount).toBe(0);
    expect(await intentStatus(intent.intentId)).toBe("partially_refunded");
  });

  it("PAY-04 a lookup that finds the refund still pending keeps it approved without sending again", async () => {
    const gateway = install();
    const intent = await seedPaid();
    const refundId = await requestRefund(intent.intentId, 30_000);
    gateway.enqueue("throw");
    await approve(financeA, refundId);
    gateway.setStatus(`refund:${refundId}`, {
      status: "pending",
      providerRef: "PR-LOOKUP-PENDING",
    });

    const response = await retry(financeB, refundId);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      status: "approved",
      providerRef: "PR-LOOKUP-PENDING",
      completedAt: null,
    });
    expect(gateway.callsFor(refundId)).toHaveLength(1);
    expect(await intentStatus(intent.intentId)).toBe("paid");
  });

  it("PAY-04 a lookup that finds the refund declined fails it and frees the amount", async () => {
    const gateway = install();
    const intent = await seedPaid();
    const refundId = await requestRefund(intent.intentId, 30_000);
    gateway.enqueue("throw");
    await approve(financeA, refundId);
    gateway.setStatus(`refund:${refundId}`, {
      status: "failed",
      providerRef: "PR-LOOKUP-DECLINED",
      code: "declined",
    });

    const response = await retry(financeB, refundId);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      status: "failed",
      failureReason: "provider_declined",
    });
    expect(gateway.callsFor(refundId)).toHaveLength(1);
    expect(await refundable(intent.intentId)).toMatchObject({
      refundedAmountIdr: 0,
      refundableAmountIdr: 100_000,
    });
  });

  it("PAY-04 when the lookup itself fails the refund is not sent again, and a later not_found does not send it either", async () => {
    const gateway = install();
    const intent = await seedPaid();
    const refundId = await requestRefund(intent.intentId, 30_000);
    gateway.enqueue("throw");
    await approve(financeA, refundId);
    gateway.lookupFails = true;

    const stuck = await retry(financeB, refundId);
    expect(stuck.status).toBe(200);
    expect(stuck.body.data.status).toBe("approved");
    expect(gateway.callsFor(refundId)).toHaveLength(1);
    expect(gateway.statusCallsFor(refundId)).toHaveLength(1);
    expect((await refundRow(refundId)).payout_attempts).toBe(2);

    // The provider recovers: the lookup says not_found. The refund may still
    // have been sent, so it is not sent again; it is flagged for ops instead.
    gateway.lookupFails = false;
    const done = await retry(financeB, refundId);
    expect([200, 409]).toContain(done.status);
    expect(gateway.callsFor(refundId)).toHaveLength(1);
    expect(gateway.statusCallsFor(refundId)).toHaveLength(2);
    expect(gateway.executionCount).toBe(0);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      last_payout_error: "PAYOUT_NOT_FOUND_MAYBE_SENT",
    });
  });
});

describe("PAY-04 the payout sweeper finishes approved refunds", () => {
  // legend-xd2q: the sweeper asks the provider after an unknown outcome but never
  // sends again; a not_found answer flags the refund for ops (manual settlement).
  it("PAY-04 an approved refund left by a provider timeout is looked up by the sweeper once its backoff has passed, never sent again, and flagged when the provider does not know it", async () => {
    const gateway = install();
    const intent = await seedPaid(100_000);
    const refundId = await requestRefund(intent.intentId, 30_000);
    gateway.enqueue("throw");
    const first = await approve(financeA, refundId);
    expect(first.body.data.status).toBe("approved");

    // Just failed: the sweeper waits (backoff), the provider is not touched.
    await sweepApprovedRefundPayouts(tenantWide, new Date(), 100);
    expect(gateway.callsFor(refundId)).toHaveLength(1);
    expect(gateway.statusCallsFor(refundId)).toHaveLength(0);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      payout_attempts: 1,
    });

    // Backoff elapsed: it asks the provider, finds nothing, and does NOT send.
    await ageRefund(refundId);
    await sweepApprovedRefundPayouts(tenantWide, new Date(), 100);
    expect(gateway.statusCallsFor(refundId)).toHaveLength(1);
    expect(gateway.callsFor(refundId)).toHaveLength(1);
    expect(gateway.executionCount).toBe(0);
    const row = await refundRow(refundId);
    expect(row).toMatchObject({
      status: "approved",
      payout_attempts: 2,
      last_payout_error: "PAYOUT_NOT_FOUND_MAYBE_SENT",
    });
    expect(row.completed_at).toBeNull();
    expect(await intentStatus(intent.intentId)).toBe("paid");

    // Still no send on a further sweep.
    await ageRefund(refundId);
    await sweepApprovedRefundPayouts(tenantWide, new Date(), 100);
    expect(gateway.callsFor(refundId)).toHaveLength(1);
  });

  it("PAY-04 a never-attempted approved refund is sent by the sweeper without a status lookup", async () => {
    const gateway = install();
    const { intent, refundId } = await seedApprovedRefund({ attempts: 0 });
    await sweepApprovedRefundPayouts(tenantWide, new Date(), 100);
    expect(gateway.callsFor(refundId)).toHaveLength(1);
    expect(gateway.callsFor(refundId)[0]).toMatchObject({
      idempotencyKey: `refund:${refundId}`,
      amountIdr: 30_000,
    });
    expect(gateway.statusCallsFor(refundId)).toHaveLength(0);
    expect(await refundRow(refundId)).toMatchObject({
      status: "completed",
      payout_attempts: 1,
    });
    expect(await intentStatus(intent.intentId)).toBe("partially_refunded");
  });

  it("PAY-04 the sweeper skips a refund whose payout lease is still live", async () => {
    const gateway = install();
    const { refundId } = await seedApprovedRefund({
      attempts: 1,
      leaseMinutes: 5,
    });
    await sweepApprovedRefundPayouts(tenantWide, new Date(), 100);
    expect(gateway.callsFor(refundId)).toHaveLength(0);
    expect(gateway.statusCallsFor(refundId)).toHaveLength(0);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      payout_attempts: 1,
    });

    // Once the lease has run out the refund is picked up: it was attempted
    // before, so it is only looked up (never sent); an unknown refund is
    // flagged for ops (legend-xd2q).
    await expireLease(refundId);
    await sweepApprovedRefundPayouts(tenantWide, new Date(), 100);
    expect(gateway.statusCallsFor(refundId)).toHaveLength(1);
    expect(gateway.callsFor(refundId)).toHaveLength(0);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      last_payout_error: "PAYOUT_NOT_FOUND_MAYBE_SENT",
    });
  });

  it("PAY-04 the sweeper stops after 8 attempts and flags the refund for manual reconciliation", async () => {
    const gateway = install();
    const { intent, refundId } = await seedApprovedRefund({ attempts: 8 });
    await sweepApprovedRefundPayouts(tenantWide, new Date(), 100);
    await sweepApprovedRefundPayouts(tenantWide, new Date(), 100);
    expect(gateway.callsFor(refundId)).toHaveLength(0);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      payout_attempts: 8,
      last_payout_error: "MANUAL_RECONCILIATION",
    });
    // The money stays reserved until someone reconciles it.
    expect(await intentStatus(intent.intentId)).toBe("paid");
    expect(await refundable(intent.intentId)).toMatchObject({
      refundedAmountIdr: 30_000,
      refundableAmountIdr: 70_000,
    });
  });

  it("PAY-04 one refund timing out in a sweep does not stop the others", async () => {
    const gateway = install();
    const stuck = await seedApprovedRefund({ attempts: 0, age: "3 hours" });
    const fine = await seedApprovedRefund({ attempts: 0, age: "2 hours" });
    gateway.throwFor.add(`refund:${stuck.refundId}`);

    await sweepApprovedRefundPayouts(tenantWide, new Date(), 100);
    expect(await refundRow(fine.refundId)).toMatchObject({
      status: "completed",
    });
    const timedOut = await refundRow(stuck.refundId);
    expect(timedOut).toMatchObject({ status: "approved", payout_attempts: 1 });
    expect(timedOut.last_payout_error).toEqual(expect.any(String));
    expect(timedOut.provider_ref).toBeNull();
  });
});

describe("PAY-04 the approval consumer only settles", () => {
  it("PAY-04 an approved chain settles the refund to approved without calling the provider; the sweeper pays it", async () => {
    const gateway = install();
    const { intent, refundId, requestId, chainId } =
      await seedSystemRefundWithOpenChain();
    await decide(financeBId, requestId, "approved");
    // The decision alone does not move the refund; the consumer does.
    expect((await refundRow(refundId)).status).toBe("pending");

    const event = await resolvedEventOfChain(chainId);
    await handleRefundApprovalResolved(workerContext, event);
    const settled = await refundRow(refundId);
    expect(settled).toMatchObject({
      status: "approved",
      approved_by: financeBId,
      payout_attempts: 0,
      provider_ref: null,
      completed_at: null,
    });
    expect(settled.decided_at).not.toBeNull();
    expect(gateway.calls).toHaveLength(0);
    expect(gateway.statusCalls).toHaveLength(0);

    // At-least-once delivery: the same event again changes nothing.
    await handleRefundApprovalResolved(workerContext, event);
    await handleRefundApprovalResolved(workerContext, event);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      approved_by: financeBId,
      payout_attempts: 0,
    });
    expect(gateway.calls).toHaveLength(0);
    expect(await intentStatus(intent.intentId)).toBe("paid");

    // Money moves only when the payout sweeper picks the approved refund up.
    await ageRefund(refundId);
    await sweepApprovedRefundPayouts(tenantWide, new Date(), 100);
    expect(gateway.callsFor(refundId)).toHaveLength(1);
    expect((await refundRow(refundId)).status).toBe("completed");
    expect(await intentStatus(intent.intentId)).toBe("partially_refunded");
  });

  it("PAY-04 a rejected chain settles the refund to failed/rejected without calling the provider", async () => {
    const gateway = install();
    const { intent, refundId, requestId, chainId } =
      await seedSystemRefundWithOpenChain();
    await decide(financeBId, requestId, "rejected");

    const event = await resolvedEventOfChain(chainId);
    await handleRefundApprovalResolved(workerContext, event);
    await handleRefundApprovalResolved(workerContext, event);
    expect(await refundRow(refundId)).toMatchObject({
      status: "failed",
      failure_reason: "rejected",
      provider_ref: null,
    });
    expect(gateway.calls).toHaveLength(0);
    expect(gateway.statusCalls).toHaveLength(0);
    expect(await intentStatus(intent.intentId)).toBe("paid");
    expect(await refundable(intent.intentId)).toMatchObject({
      refundedAmountIdr: 0,
      refundableAmountIdr: 100_000,
    });
  });
});
