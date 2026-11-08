// Regression tests for the K review of ws/refund-approval (docs/briefs/sub-refund-review-fix.md,
// findings A-F). Written against the "Keputusan desain" section of that brief; each
// test fails until the matching fix lands. Runs the real Express app, Better Auth,
// services and PostgreSQL; only the refund provider is the fake gateway.
//
// Self-contained on purpose: payment-refund-approval.test.ts keeps its helpers
// private and registers describes at import time, so they are re-declared here
// (same shapes) instead of changing that file.
//
// Assumptions where the brief is not exact:
// - A: error code `REFUND_SOURCE_DOCUMENT`, HTTP 409. A legacy pending refund on a
//   source-document intent ends `failed` with failure_reason `source_document`; only
//   the stored state is asserted for that path, not the HTTP status.
// - A: the refundable list hides source-document intents ("bila filter sederhana"
//   in the brief): that test is the only one that depends on the optional part.
// - B: a replay of the same approve/reject key by the same actor answers 200 with
//   the current view, never IDEMPOTENCY_KEY_REUSED / 409.
// - C: `sweepApprovedRefundPayouts(context, now, limit, budgetMs)`: the time budget
//   is a 4th positional argument in milliseconds. Only "stops before claiming every
//   refund" is asserted, never an exact count (other approved rows may be due).
// - D: `payout_pending_polls` counts provider "pending" answers; the 72 hour
//   limit runs from `decided_at`.
// - E: `payment_unallocated_funds.evidence_id` points at the evidence that
//   brought the fund in; the gateway receives that evidence's provider_ref.
// - F: the supervisor template holds `approval.request.decide` but not
//   `payment.reconcile`, and can be a policy approver through the approval inbox
//   (`decideApprovalRequest`). `handleRefundApprovalResolved` then throws and the
//   refund is never paid and ends failed (approver_unauthorized).
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
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { createApp } from "../app";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway";
import { decideApprovalRequest } from "../services/platform-approval.service";
import {
  handleRefundApprovalResolved,
  sweepApprovedRefundPayouts,
} from "../services/payment-refund.service";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";
import { FakeRefundGateway } from "./refund-fake-gateway";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const tenantWide: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "session" }),
  { kind: "tenant" },
);
const workerContext: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "job" }),
  { kind: "tenant" },
);
const sessionTenant = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});
const ADMIN = "/api/payments/admin";

type Client = ReturnType<typeof agent>;
let requester: Client; // Owner: files refunds, never approves its own
let requesterId: string;
let financeA: Client;
let financeAId: string;
let financeB: Client;
let financeBId: string;
let ownerB: Client;
let ownerBId: string;
let supervisorId: string; // approver role without payment.reconcile (finding F)

const userIds: string[] = [];
const linkIds: string[] = [];
const intentIds: string[] = [];
const refundIds: string[] = [];
let savedPolicies: Record<string, unknown>[] = [];
let fake: FakeRefundGateway;

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
  templateKey: "owner" | "finance" | "supervisor",
  label: string,
) {
  const client = agent(app);
  const email = await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  userIds.push(userId);
  await verifySessionMfa(email);
  const outletScoped = templateKey === "supervisor";
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
    [
      tenantId,
      userId,
      await roleIdOf(templateKey),
      outletScoped ? "outlet" : "tenant",
      outletScoped ? outletA : null,
    ],
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

type SourceDocument = {
  orderId?: string;
  accessTicketId?: string;
  subscriptionInvoiceId?: string;
};

/** A settled bill: link + paid intent + matching evidence, optionally bound to a source document. */
async function seedPaid(
  amountIdr = 100_000,
  evidenceIdr = amountIdr,
  source: SourceDocument = {},
) {
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
      `RFX-${linkId.slice(0, 8)}`,
      amountIdr,
      requesterId,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at,
                                  order_id, access_ticket_id, subscription_invoice_id)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now(), $7, $8, $9)`,
    [
      intentId,
      tenantId,
      outletA,
      linkId,
      amountIdr,
      `rfx-${intentId}`,
      source.orderId ?? null,
      source.accessTicketId ?? null,
      source.subscriptionInvoiceId ?? null,
    ],
  );
  const evidenceRef = `evidence-${intentId}`;
  await owner.query(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [tenantId, outletA, intentId, evidenceRef, evidenceIdr],
  );
  return { intentId, evidenceRef, amountIdr };
}

async function requestRefundRaw(intentId: string, amountIdr: number) {
  return requester
    .post(`${ADMIN}/refunds`)
    .set(originHeader)
    .send({
      idempotencyKey: key("req"),
      paymentIntentId: intentId,
      amountIdr,
      reason: "Pelanggan mengembalikan pesanan",
    });
}

async function requestRefund(intentId: string, amountIdr: number) {
  const response = await requestRefundRaw(intentId, amountIdr);
  expect(response.status).toBe(201);
  expect(response.body.data.status).toBe("pending");
  const id = response.body.data.id as string;
  refundIds.push(id);
  return id;
}

/** A refund written straight into the table, as a legacy or system caller would leave it. */
async function insertPendingRefund(
  intentId: string,
  amountIdr: number,
  requestedBy: string,
  unallocatedFundId: string | null = null,
) {
  const refundId = randomUUID();
  refundIds.push(refundId);
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by, unallocated_fund_id)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian uji', 'pending', $6, $7)`,
    [refundId, tenantId, outletA, intentId, amountIdr, requestedBy, unallocatedFundId],
  );
  return refundId;
}

const approve = (client: Client, id: string, idempotencyKey = key("apr")) =>
  client
    .post(`${ADMIN}/refunds/${id}/approve`)
    .set(originHeader)
    .send({ idempotencyKey });
const rejectWith = (client: Client, id: string, idempotencyKey: string) =>
  client
    .post(`${ADMIN}/refunds/${id}/reject`)
    .set(originHeader)
    .send({ idempotencyKey, reason: "Bukti pengembalian tidak sesuai" });

async function refundRow(id: string) {
  const { rows } = await owner.query<{
    status: string;
    failure_reason: string | null;
    provider_ref: string | null;
    approved_by: string | null;
    payout_attempts: number;
    last_payout_error: string | null;
    approval_chain_id: string | null;
    payout_pending_polls: number | null;
  }>(
    `SELECT status, failure_reason, provider_ref, approved_by, payout_attempts,
            last_payout_error, approval_chain_id, payout_pending_polls
     FROM payment_refunds WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  if (!rows[0]) throw new Error("refund row missing");
  return rows[0];
}

async function refundsOfIntent(intentId: string) {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantId, intentId],
  );
  return rows;
}

async function refundablePayments() {
  const response = await requester.get(
    `${ADMIN}/refunds/refundable?outletId=${outletA}`,
  );
  expect(response.status).toBe(200);
  return response.body.data.payments as { paymentIntentId: string }[];
}

async function decisions(refundId: string) {
  const { rows } = await owner.query<{
    id: string;
    level: number;
    status: string;
    decided_by: string | null;
  }>(
    `SELECT id, level, status, decided_by FROM approval_requests
     WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2
     ORDER BY level`,
    [tenantId, refundId],
  );
  return rows;
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

/** An approved refund whose payout never started (as left by the approval consumer). */
async function seedApprovedRefund(age = "2 hours") {
  const intent = await seedPaid(100_000);
  const refundId = randomUUID();
  refundIds.push(refundId);
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
                                  requested_by, approved_by, decided_at, payout_attempts, updated_at)
     VALUES ($1, $2, $3, $4, 30000, 'Pengembalian tertunda', 'approved', $5, $6, now(), 0, now() - $7::interval)`,
    [refundId, tenantId, outletA, intent.intentId, requesterId, financeAId, age],
  );
  return { intent, refundId };
}

/** The time budget is the 4th argument (assumption C). */
const sweepWithBudget = (budgetMs: number) =>
  sweepApprovedRefundPayouts(tenantWide, new Date(), 100, budgetMs);

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

beforeAll(async () => {
  ({ client: requester, userId: requesterId } = await signedIn(
    "owner",
    "Review fix requester",
  ));
  ({ client: financeA, userId: financeAId } = await signedIn(
    "finance",
    "Review fix finance A",
  ));
  ({ client: financeB, userId: financeBId } = await signedIn(
    "finance",
    "Review fix finance B",
  ));
  ({ client: ownerB, userId: ownerBId } = await signedIn(
    "owner",
    "Review fix owner B",
  ));
  ({ userId: supervisorId } = await signedIn(
    "supervisor",
    "Review fix supervisor",
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
  // Same matrix as payment-refund-approval.test.ts, plus a Rp2.000.000 tier whose
  // second approver (Supervisor) cannot reconcile payments (finding F).
  await setPolicy(null, "finance", 1);
  await setPolicy(500_000, "finance", 1);
  await setPolicy(500_000, "owner", 2);
  await setPolicy(2_000_000, "finance", 1);
  await setPolicy(2_000_000, "supervisor", 2);
});

afterAll(async () => {
  await owner.query(
    "DELETE FROM approval_requests WHERE object_type = 'payment_refund' AND object_id = ANY($1::text[])",
    [refundIds],
  );
  await owner.query(
    "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  await owner.query(
    "DELETE FROM payment_unallocated_funds WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  await owner.query(
    "DELETE FROM payment_evidence WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  await owner.query("DELETE FROM payment_intents WHERE id = ANY($1::uuid[])", [
    intentIds,
  ]);
  await owner.query("DELETE FROM payment_links WHERE id = ANY($1::uuid[])", [
    linkIds,
  ]);
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

describe("PAY-04 review A: refunds of sales documents go through the owning module", () => {
  const documents: [string, SourceDocument][] = [
    ["orderId", { orderId: randomUUID() }],
    ["accessTicketId", { accessTicketId: randomUUID() }],
    ["subscriptionInvoiceId", { subscriptionInvoiceId: randomUUID() }],
  ];

  it.each(documents)(
    "PAY-04 an admin refund of a payment bound to %s is refused with REFUND_SOURCE_DOCUMENT and nothing is stored",
    async (_name, source) => {
      const intent = await seedPaid(100_000, 100_000, source);
      const response = await requestRefundRaw(intent.intentId, 40_000);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("REFUND_SOURCE_DOCUMENT");
      expect(await refundsOfIntent(intent.intentId)).toHaveLength(0);
      expect(fake.calls).toHaveLength(0);
    },
  );

  it("PAY-04 a payment bound to a sales document is not offered as refundable", async () => {
    const bound = await seedPaid(100_000, 100_000, { orderId: randomUUID() });
    const plain = await seedPaid(100_000);
    const offered = (await refundablePayments()).map((p) => p.paymentIntentId);
    expect(offered).toContain(plain.intentId);
    expect(offered).not.toContain(bound.intentId);
  });

  it("PAY-04 a payment without a source document can still be refunded by an admin", async () => {
    const intent = await seedPaid();
    const refundId = await requestRefund(intent.intentId, 40_000);
    const approved = await approve(financeA, refundId);
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe("completed");
    expect(fake.calls).toHaveLength(1);
  });

  it("PAY-04 a user refund left pending on a sales-document payment fails with source_document and pays nothing", async () => {
    const intent = await seedPaid(100_000, 100_000, { orderId: randomUUID() });
    const refundId = await insertPendingRefund(
      intent.intentId,
      40_000,
      requesterId,
    );
    const response = await approve(financeA, refundId);
    // Review: the caller is told why, not "exceeds available paid amount".
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("REFUND_SOURCE_DOCUMENT");
    expect(fake.calls).toHaveLength(0);
    expect(await refundRow(refundId)).toMatchObject({
      status: "failed",
      failure_reason: "source_document",
    });
  });

  it("PAY-04 a refund requested by system:pos on a sales-document payment still needs two humans and pays out", async () => {
    const intent = await seedPaid(100_000, 100_000, { orderId: randomUUID() });
    const refundId = await insertPendingRefund(
      intent.intentId,
      50_000,
      "system:pos",
    );
    const submitKey = key("submit");
    const submitted = await approve(financeA, refundId, submitKey);
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.status).toBe("pending");
    expect(fake.calls).toHaveLength(0);
    // Review: a retried submit (same key) replays, never APPROVER_IS_REQUESTER.
    const resubmitted = await approve(financeA, refundId, submitKey);
    expect(resubmitted.status).toBe(200);
    expect(resubmitted.body.data.status).toBe("pending");

    const approved = await approve(financeB, refundId);
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({
      status: "completed",
      requestedBy: "system:pos",
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ refundId, amountIdr: 50_000 });
  });

  it("PAY-04 an unallocated fund on a sales-document payment can still be refunded", async () => {
    // 120.000 received for a 100.000 order payment: 20.000 belongs to no sale.
    const intent = await seedPaid(100_000, 120_000, { orderId: randomUUID() });
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
    const created = await owner.query<{ id: string }>(
      "SELECT id FROM payment_refunds WHERE tenant_id = $1 AND unallocated_fund_id = $2",
      [tenantId, fundId],
    );
    expect(created.rows).toHaveLength(1);
    const refundId = created.rows[0]!.id;
    refundIds.push(refundId);

    const approved = await approve(financeA, refundId);
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({
      status: "completed",
      amountIdr: 20_000,
    });
    expect(fake.calls).toHaveLength(1);
  });
});

describe("PAY-04 review B: approve and reject are idempotent per actor", () => {
  it("PAY-04 repeating the level 1 approval of a two level refund answers the same view and decides once", async () => {
    const intent = await seedPaid(600_000);
    const refundId = await requestRefund(intent.intentId, 600_000);
    const level1Key = key("lvl1");

    const first = await approve(financeA, refundId, level1Key);
    expect(first.status).toBe(200);
    expect(first.body.data.status).toBe("pending");
    const replay = await approve(financeA, refundId, level1Key);
    expect(replay.status).toBe(200);
    expect(replay.body.error?.code).not.toBe("IDEMPOTENCY_KEY_REUSED");
    expect(replay.body.data).toMatchObject({ id: refundId, status: "pending" });

    expect(await decisions(refundId)).toMatchObject([
      { level: 1, status: "approved", decided_by: financeAId },
      { level: 2, status: "pending", decided_by: null },
    ]);
    expect(fake.calls).toHaveLength(0);
  });

  it("PAY-04 repeating the level 2 approval answers the completed view without a second payout", async () => {
    const intent = await seedPaid(600_000);
    const refundId = await requestRefund(intent.intentId, 600_000);
    expect((await approve(financeA, refundId)).status).toBe(200);
    const level2Key = key("lvl2");

    const first = await approve(ownerB, refundId, level2Key);
    expect(first.status).toBe(200);
    expect(first.body.data.status).toBe("completed");
    const replay = await approve(ownerB, refundId, level2Key);
    expect(replay.status).toBe(200);
    expect(replay.body.data).toMatchObject({
      id: refundId,
      status: "completed",
      providerRef: first.body.data.providerRef,
      approvedBy: ownerBId,
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.executionCount).toBe(1);
    expect(await decisions(refundId)).toMatchObject([
      { level: 1, status: "approved", decided_by: financeAId },
      { level: 2, status: "approved", decided_by: ownerBId },
    ]);
  });

  it("PAY-04 repeating a rejection with the same key answers the failed view instead of 409", async () => {
    const intent = await seedPaid();
    const refundId = await requestRefund(intent.intentId, 40_000);
    const rejectKey = key("rej");

    const first = await rejectWith(financeA, refundId, rejectKey);
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({
      status: "failed",
      failureReason: "rejected",
    });
    const replay = await rejectWith(financeA, refundId, rejectKey);
    expect(replay.status).toBe(200);
    expect(replay.body.data).toMatchObject({
      id: refundId,
      status: "failed",
      failureReason: "rejected",
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("PAY-04 a different person approving a finished refund is still refused", async () => {
    // Guard against the replay fix being too loose: only same key AND same actor replays.
    const intent = await seedPaid();
    const refundId = await requestRefund(intent.intentId, 40_000);
    const sharedKey = key("shared");
    expect((await approve(financeA, refundId, sharedKey)).status).toBe(200);
    const other = await approve(financeB, refundId, sharedKey);
    expect(other.status).toBeGreaterThanOrEqual(400);
    expect(fake.calls).toHaveLength(1);
  });

  it("PAY-04 the same key with another approval note is refused as a reused key", async () => {
    const intent = await seedPaid();
    const refundId = await requestRefund(intent.intentId, 40_000);
    const sameKey = key("note");
    expect((await approve(financeA, refundId, sameKey)).status).toBe(200);
    const changed = await financeA
      .post(`${ADMIN}/refunds/${refundId}/approve`)
      .set(originHeader)
      .send({ idempotencyKey: sameKey, note: "Catatan lain" });
    expect(changed.status).toBeGreaterThanOrEqual(400);
    expect(changed.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(fake.calls).toHaveLength(1);
  });
});

describe("PAY-04 review C: the payout sweep respects a time budget", () => {
  it("PAY-04 a sweep whose budget runs out stops claiming new refunds; a later sweep finishes them", async () => {
    // Every provider call takes 400 ms; the budget is 150 ms, so after the first
    // payout the sweep must stop instead of walking through all three.
    fake.delayMs = 400;
    const seeded = [
      await seedApprovedRefund("5 hours"),
      await seedApprovedRefund("4 hours"),
      await seedApprovedRefund("3 hours"),
    ];

    await sweepWithBudget(150);

    const afterBudget = await Promise.all(
      seeded.map((s) => refundRow(s.refundId)),
    );
    const untouched = afterBudget.filter((r) => r.status === "approved");
    expect(untouched.length).toBeGreaterThanOrEqual(1);
    for (const row of untouched) expect(row.payout_attempts).toBe(0);
    // Whatever did run was sent exactly once.
    for (const s of seeded)
      expect(
        fake.calls.filter((c) => c.refundId === s.refundId).length,
      ).toBeLessThanOrEqual(1);

    // Nothing is lost: with time to spare the rest is paid.
    fake.delayMs = 0;
    await sweepWithBudget(60_000);
    for (const s of seeded)
      expect((await refundRow(s.refundId)).status).toBe("completed");
    for (const s of seeded)
      expect(fake.calls.filter((c) => c.refundId === s.refundId)).toHaveLength(
        1,
      );
  });
});

describe("PAY-04 review D: waiting for the provider is not an unknown outcome", () => {
  it("PAY-04 ten pending answers never flag manual reconciliation and a later success completes the refund", async () => {
    const { refundId } = await seedApprovedRefund();
    fake.enqueue("pending");
    await sweepApprovedRefundPayouts(tenantWide, new Date(), 100);
    const sent = await refundRow(refundId);
    expect(sent.status).toBe("approved");
    expect(sent.provider_ref).toEqual(expect.any(String));
    fake.setStatus(`refund:${refundId}`, {
      status: "pending",
      providerRef: sent.provider_ref!,
    });

    for (let poll = 0; poll < 10; poll += 1) {
      await expireLease(refundId);
      await ageRefund(refundId);
      await sweepApprovedRefundPayouts(tenantWide, new Date(), 100);
    }
    const waiting = await refundRow(refundId);
    expect(waiting.status).toBe("approved");
    expect(waiting.last_payout_error).not.toBe("MANUAL_RECONCILIATION");
    // Only unknown outcomes (errors, timeouts) spend the attempt budget of 8.
    expect(waiting.payout_attempts).toBeLessThan(8);
    expect(waiting.payout_pending_polls).toBeGreaterThanOrEqual(8);
    expect(fake.executionCount).toBe(1);

    fake.setStatus(`refund:${refundId}`, {
      status: "succeeded",
      providerRef: sent.provider_ref!,
    });
    await expireLease(refundId);
    await ageRefund(refundId);
    await sweepApprovedRefundPayouts(tenantWide, new Date(), 100);
    expect((await refundRow(refundId)).status).toBe("completed");
    expect(fake.executionCount).toBe(1);
  });

  it("PAY-04 a refund still pending more than 72 hours after approval is flagged for manual reconciliation", async () => {
    const { refundId } = await seedApprovedRefund();
    fake.enqueue("pending");
    await sweepApprovedRefundPayouts(tenantWide, new Date(), 100);
    const sent = await refundRow(refundId);
    fake.setStatus(`refund:${refundId}`, {
      status: "pending",
      providerRef: sent.provider_ref!,
    });

    await owner.query(
      "UPDATE payment_refunds SET decided_at = now() - interval '73 hours' WHERE tenant_id = $1 AND id = $2",
      [tenantId, refundId],
    );
    await expireLease(refundId);
    await ageRefund(refundId);
    await sweepApprovedRefundPayouts(tenantWide, new Date(), 100);
    // Still approved (money may be on its way) but ops are told.
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      last_payout_error: "MANUAL_RECONCILIATION",
    });
  });
});

describe("PAY-04 review E: an unallocated fund is refunded against its own evidence", () => {
  it("PAY-04 the payout of a fund refund uses the provider reference of the evidence that brought the fund in", async () => {
    // Intent: 100.000 bill, evidence A (latest) for 100.000. The fund of 20.000
    // arrived earlier through evidence B; A must not be used for it.
    const intent = await seedPaid(100_000);
    const fundEvidenceRef = `fund-evidence-${randomUUID()}`;
    const evidence = await owner.query<{ id: string }>(
      `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
       VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', 20000, now() - interval '1 hour')
       RETURNING id`,
      [tenantId, outletA, intent.intentId, fundEvidenceRef],
    );
    const fundId = randomUUID();
    await owner.query(
      `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
       VALUES ($1, $2, $3, $4, $5, 20000, 'overpayment')`,
      [fundId, tenantId, outletA, intent.intentId, evidence.rows[0]!.id],
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
    const created = await owner.query<{ id: string }>(
      "SELECT id FROM payment_refunds WHERE tenant_id = $1 AND unallocated_fund_id = $2",
      [tenantId, fundId],
    );
    expect(created.rows).toHaveLength(1);
    const refundId = created.rows[0]!.id;
    refundIds.push(refundId);

    const approved = await approve(financeA, refundId);
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe("completed");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      refundId,
      amountIdr: 20_000,
      paymentProviderRef: fundEvidenceRef,
    });
    expect(fake.calls[0]!.paymentProviderRef).not.toBe(intent.evidenceRef);
  });
});

describe("PAY-04 review F: every approver of the chain must be allowed to reconcile payments", () => {
  it("PAY-04 a chain whose last approver lacks payment.reconcile at the outlet is never paid", async () => {
    const intent = await seedPaid(2_000_000);
    const refundId = await insertPendingRefund(
      intent.intentId,
      2_000_000,
      "system:reservation",
    );
    // The first human only files the chain; Finance then decides level 1 and the
    // Supervisor (no payment.reconcile) level 2, both through the approval inbox.
    const submitted = await approve(financeA, refundId);
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.status).toBe("pending");
    const chainId = (await refundRow(refundId)).approval_chain_id;
    expect(chainId).not.toBeNull();

    const level1 = (await decisions(refundId)).find((d) => d.level === 1)!;
    await decide(financeBId, level1.id, "approved");
    const level2 = (await decisions(refundId)).find((d) => d.level === 2)!;
    await decide(supervisorId, level2.id, "approved");
    expect(await decisions(refundId)).toMatchObject([
      { level: 1, status: "approved", decided_by: financeBId },
      { level: 2, status: "approved", decided_by: supervisorId },
    ]);

    const event = await resolvedEventOfChain(chainId!);
    // The consumer settles without throwing (no poison event): the refund
    // ends failed closed, never paid.
    await handleRefundApprovalResolved(workerContext, event);
    expect(fake.calls).toHaveLength(0);
    expect(await refundRow(refundId)).toMatchObject({
      status: "failed",
      failure_reason: "approver_unauthorized",
    });
    // A replayed event leaves it as is.
    await handleRefundApprovalResolved(workerContext, event);
    expect((await refundRow(refundId)).status).toBe("failed");
    await ageRefund(refundId);
    await sweepApprovedRefundPayouts(tenantWide, new Date(), 100);
    expect(fake.calls.filter((c) => c.refundId === refundId)).toHaveLength(0);
    expect((await refundRow(refundId)).status).not.toBe("completed");
  });
});
