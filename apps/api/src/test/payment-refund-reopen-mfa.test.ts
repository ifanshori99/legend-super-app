// legend-tx8x (brief docs/briefs/788-shared-context.md): a refund that ops
// re-opened from quarantine (audit payment.refund_quarantine_reopened) lost its
// old chain and is decided again by one approver. That second decision must
// carry MFA: an approver whose session never verified a second factor is
// refused with MFA_REQUIRED, the refund stays pending (no approver, no chain,
// no provider call), and the same refund is paid exactly once once an
// MFA-verified approver decides it. An ordinary refund below every tier keeps
// the single-supervisor path without MFA.
//
// Written from the brief and PRD D14 / AUTH-05, not from the service code.
// Real Express app, Better Auth, services and PostgreSQL; only the refund
// provider is the fake gateway. Self-contained (same shapes as
// payment-refund-codex-fix.test.ts, whose "legend-e8z5" block is the model for
// seeding a quarantined refund and re-opening it).
//
// Assumptions where the brief is silent:
// - "Below tier" = the matrix has no tier covering the amount (tiers start at Rp500.000), so the refund is
//   decided directly through POST /refunds/:id/approve with no approval chain
//   (the `opened.required === false` path of the brief).
// - A refused MFA check answers HTTP 403 with error code MFA_REQUIRED (same as
//   payment-refund-manual-settle.test.ts).
// - The approver "without MFA" is a finance user who also holds the
//   outlet-scoped supervisor template (what the approve route needs) and whose
//   session never verified MFA; the approver "with MFA" has the same roles and
//   a verified session. The same user is not used for both, so the two
//   outcomes cannot depend on session state left by the other.
// - A second approve call on an already-paid refund may answer 200 (idempotent)
//   or 4xx; tests assert only that the provider was called once and the stored
//   state is unchanged, never the refusal mechanism.
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
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway";
import {
  runRefundPayout,
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
const PAYOUT_QUARANTINED = "PAYOUT_QUARANTINED";

type Client = ReturnType<typeof agent>;
let requesterId: string; // owner: files the refunds, never approves
let financeAId: string; // finance only: the legacy approver of the quarantined row
let opsOwner: Client; // owner with MFA: re-opens from quarantine
let mfaApprover: Client; // finance + supervisor, MFA verified
let noMfaApprover: Client; // finance + supervisor, MFA never verified

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
  templateKey: "owner" | "finance",
  label: string,
  opts: { alsoSupervisor?: boolean; verifyMfa?: boolean } = {},
) {
  const client = agent(app).set("Host", scope.hostname);
  const email = await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  userIds.push(userId);
  if (opts.verifyMfa !== false) await verifySessionMfa(email);
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
    [tenantId, userId, await roleIdOf(templateKey)],
  );
  if (opts.alsoSupervisor)
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

/** A settled Rp100.000 bill: link + paid intent + one evidence row. */
async function seedPaid(amountIdr = 100_000) {
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
      `RMF-${linkId.slice(0, 8)}`,
      amountIdr,
      requesterId,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
    [intentId, tenantId, outletA, linkId, amountIdr, `rmf-${intentId}`],
  );
  await owner.query(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [tenantId, outletA, intentId, `evidence-${intentId}`, amountIdr],
  );
  return intentId;
}

/** A pending refund (below every tier) written straight into the table. */
async function insertPendingRefund(amountIdr: number) {
  const intentId = await seedPaid(100_000);
  const refundId = randomUUID();
  refundIds.push(refundId);
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian uji', 'pending', $6)`,
    [refundId, tenantId, outletA, intentId, amountIdr, requesterId],
  );
  return refundId;
}

/**
 * A Rp30.000 refund that ops re-opened from quarantine: a legacy approved row
 * decided by a finance-only approver is quarantined on its first payout, then
 * re-opened through the real endpoint (which writes the audit).
 */
async function seedReopenedRefund() {
  const intentId = await seedPaid(100_000);
  const refundId = randomUUID();
  refundIds.push(refundId);
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
                                  requested_by, approved_by, decided_at, payout_attempts, updated_at)
     VALUES ($1, $2, $3, $4, 30000, 'Pengembalian lama', 'approved', $5, $6, now() - interval '3 hours', 0, now() - interval '2 hours')`,
    [refundId, tenantId, outletA, intentId, requesterId, financeAId],
  );
  await runRefundPayout(tenantWide, refundId);
  expect(await refundRow(refundId)).toMatchObject({
    status: "approved",
    last_payout_error: PAYOUT_QUARANTINED,
  });
  const reopened = await opsOwner
    .post(`${ADMIN}/refunds/${refundId}/quarantine/reopen`)
    .set(originHeader)
    .send({
      idempotencyKey: key("reopen"),
      note: "Persetujuan lama tidak sah, diputuskan ops.",
    });
  expect(reopened.status).toBe(200);
  expect(reopened.body.data.status).toBe("pending");
  expect(await reopenAudits(refundId)).toBe(1);
  return refundId;
}

const approve = (client: Client, id: string, idempotencyKey = key("apr")) =>
  client
    .post(`${ADMIN}/refunds/${id}/approve`)
    .set(originHeader)
    .send({ idempotencyKey });

async function refundRow(id: string) {
  const { rows } = await owner.query<{
    status: string;
    approved_by: string | null;
    approval_chain_id: string | null;
    payout_attempts: number;
    provider_ref: string | null;
    last_payout_error: string | null;
  }>(
    `SELECT status, approved_by, approval_chain_id, payout_attempts, provider_ref, last_payout_error
     FROM payment_refunds WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  if (!rows[0]) throw new Error("refund row missing");
  return rows[0];
}

async function reopenAudits(refundId: string) {
  const { rows } = await owner.query(
    `SELECT 1 FROM audit_logs
     WHERE tenant_id = $1 AND event->>'objectId' = $2
       AND event->>'action' = 'payment.refund_quarantine_reopened'`,
    [tenantId, refundId],
  );
  return rows.length;
}

async function decisionCount(refundId: string) {
  const { rows } = await owner.query(
    `SELECT 1 FROM approval_requests
     WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2`,
    [tenantId, refundId],
  );
  return rows.length;
}

const callsOf = (refundId: string) =>
  fake.calls.filter((c) => c.refundId === refundId);

/** Make the last update look old, so any payout backoff has elapsed. */
const ageRefund = (id: string) =>
  owner.query(
    `UPDATE payment_refunds SET updated_at = now() - interval '2 hours' WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );

beforeAll(async () => {
  await scope.seed(owner);
  ({ userId: requesterId } = await signedIn("owner", "Reopen MFA requester"));
  ({ userId: financeAId } = await signedIn("finance", "Reopen MFA finance A"));
  ({ client: opsOwner } = await signedIn("owner", "Reopen MFA ops owner"));
  ({ client: mfaApprover } = await signedIn("finance", "Reopen MFA approver", {
    alsoSupervisor: true,
  }));
  ({ client: noMfaApprover } = await signedIn(
    "finance",
    "Reopen no MFA approver",
    { alsoSupervisor: true, verifyMfa: false },
  ));

  savedPolicies = (
    await owner.query(
      "SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
      [tenantId],
    )
  ).rows;
  // No tier below Rp500.000 (same matrix as payment-refund-codex-fix.test.ts):
  // the Rp30.000-Rp50.000 refunds below are decided directly, with no chain.
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
    [tenantId],
  );
  await setPolicy(500_000, "finance", 1);
  await setPolicy(500_000, "owner", 2);
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

describe("PAY-04 legend-tx8x: a refund re-opened from quarantine needs MFA to be approved", () => {
  it("PAY-04 an approver without MFA is refused with MFA_REQUIRED; the refund stays pending, has no approver or chain, and nothing is paid", async () => {
    const refundId = await seedReopenedRefund();

    const response = await approve(noMfaApprover, refundId);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("MFA_REQUIRED");

    expect(await refundRow(refundId)).toMatchObject({
      status: "pending",
      approved_by: null,
      approval_chain_id: null,
      payout_attempts: 0,
      provider_ref: null,
    });
    expect(await decisionCount(refundId)).toBe(0);
    expect(fake.calls).toHaveLength(0);

    // The refused attempt does not open a back door: a payout sweep and a
    // second refused attempt still pay nothing.
    await ageRefund(refundId);
    await sweepApprovedRefundPayouts(tenantWide, new Date(), 100);
    const again = await approve(noMfaApprover, refundId);
    expect(again.status).toBe(403);
    expect(again.body.error.code).toBe("MFA_REQUIRED");
    expect(callsOf(refundId)).toHaveLength(0);
    expect((await refundRow(refundId)).status).toBe("pending");
  });

  it("PAY-04 after the refusal, an MFA-verified approver decides the same refund and it is paid once, even if approved or swept again", async () => {
    const refundId = await seedReopenedRefund();
    const refused = await approve(noMfaApprover, refundId);
    expect(refused.status).toBe(403);
    expect(callsOf(refundId)).toHaveLength(0);

    const paid = await approve(mfaApprover, refundId);
    expect(paid.status).toBe(200);
    expect(paid.body.data.status).toBe("completed");
    expect(callsOf(refundId)).toHaveLength(1);
    expect(callsOf(refundId)[0]).toMatchObject({ amountIdr: 30_000 });

    // A second approval with a new key, a concurrent pair, and a sweep never
    // pay the refund again.
    await Promise.all([
      approve(mfaApprover, refundId),
      approve(mfaApprover, refundId),
    ]);
    await ageRefund(refundId);
    await sweepApprovedRefundPayouts(tenantWide, new Date(), 100);
    expect(callsOf(refundId)).toHaveLength(1);
    expect(await refundRow(refundId)).toMatchObject({ status: "completed" });
  });

  it("PAY-04 two MFA-verified approvals at the same moment on a re-opened refund pay it exactly once", async () => {
    const refundId = await seedReopenedRefund();

    await Promise.all([
      approve(mfaApprover, refundId),
      approve(mfaApprover, refundId),
    ]);

    expect(callsOf(refundId)).toHaveLength(1);
    expect(await refundRow(refundId)).toMatchObject({ status: "completed" });
  });

  it("PAY-04 an ordinary refund below every tier is still approved by one supervisor without MFA, and paid once", async () => {
    const refundId = await insertPendingRefund(50_000);
    expect(await reopenAudits(refundId)).toBe(0);

    const response = await approve(noMfaApprover, refundId);
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe("completed");
    expect(callsOf(refundId)).toHaveLength(1);
    expect(callsOf(refundId)[0]).toMatchObject({ amountIdr: 50_000 });

    await approve(noMfaApprover, refundId);
    await ageRefund(refundId);
    await sweepApprovedRefundPayouts(tenantWide, new Date(), 100);
    expect(callsOf(refundId)).toHaveLength(1);
  });

  it("PAY-04 re-opening one refund does not demand MFA for another, ordinary refund approved afterwards", async () => {
    const reopenedId = await seedReopenedRefund();
    const ordinaryId = await insertPendingRefund(40_000);

    const ordinary = await approve(noMfaApprover, ordinaryId);
    expect(ordinary.status).toBe(200);
    expect(ordinary.body.data.status).toBe("completed");

    const reopened = await approve(noMfaApprover, reopenedId);
    expect(reopened.status).toBe(403);
    expect(reopened.body.error.code).toBe("MFA_REQUIRED");
    expect(callsOf(ordinaryId)).toHaveLength(1);
    expect(callsOf(reopenedId)).toHaveLength(0);
  });
});
