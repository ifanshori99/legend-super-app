// Tests for the Codex second-opinion fixes on ws/refund-approval
// (docs/briefs/sub-refund-codex-fix.md, F1 and F2), written against the
// "Tests" scenarios of that brief and PRD D14 / PRD:541 ("refund wajib PIN
// supervisor"), not against the service code. They may fail until the code
// lands. Real Express app, Better Auth, services and PostgreSQL; only the
// refund provider is the fake gateway.
//
// Self-contained on purpose (same shapes as payment-refund-review-fix.test.ts).
//
// Assumptions where the brief is not exact:
// - Scenario 1/2: the refund is filed by Finance A through a row written
//   straight into payment_refunds (requested_by = Finance A). That is the same
//   state as a request through the API, without depending on Finance holding
//   the request permission. Amount Rp50.000 is below every matrix tier, so the
//   single-approver path applies.
// - Scenario 1/2 (round 2): the matrix has NO tier covering Rp50.000 (the
//   Rp0+ finance tier is gone), so the direct path applies
//   (`opened.required === false`). Retries (scenario 6-8) go through
//   `financeSup`, a finance user who also holds the outlet-scoped supervisor
//   template, since a finance-only approver no longer pays out. `financeB`
//   stays finance-only for the F1 refusal.
// - Scenario 3/4: a chain is made by a refund requested by `system:reservation`
//   (as in payment-refund-review-fix.test.ts F). A Rp5.000.000 tier is added
//   whose two levels are both Finance; the existing Rp2.000.000 tier is
//   Finance + Supervisor. The chain settles when `handleRefundApprovalResolved`
//   consumes the `approval.resolved` event; if the refund is still `approved`
//   afterwards, one payout sweep pays it (either path is accepted).
// - Scenario 5-8: a refund is "approved" and due (updated_at 2 hours old). Retry
//   is POST /refunds/:id/retry with an optional `sourceEvidenceId`; a HOLD answers
//   409 with error code EVIDENCE_MAPPING_REQUIRED. The literal string is used
//   instead of the exported const.
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
  runRefundPayout,
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
const EVIDENCE_MAPPING_REQUIRED = "EVIDENCE_MAPPING_REQUIRED";

type Client = ReturnType<typeof agent>;
let requesterId: string; // Owner: owns the seeded payments, never approves
let financeA: Client;
let financeAId: string;
let financeB: Client;
let financeSup: Client;
let financeSupId: string;
let financeBId: string;
let financeCId: string;
let ownerB: Client;
let supervisorId: string;

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
  alsoSupervisor = false,
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

/** A settled bill: link + paid intent + one evidence row (evidence A). */
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
      `RFX-${linkId.slice(0, 8)}`,
      amountIdr,
      requesterId,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
    [intentId, tenantId, outletA, linkId, amountIdr, `rfx-${intentId}`],
  );
  const evidenceRef = `evidence-${intentId}`;
  const evidence = await owner.query<{ id: string }>(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())
     RETURNING id`,
    [tenantId, outletA, intentId, evidenceRef, amountIdr],
  );
  return {
    intentId,
    evidence: { id: evidence.rows[0]!.id, ref: evidenceRef },
  };
}

/** A refund written straight into the table, as a legacy or system caller would leave it. */
async function insertPendingRefund(
  intentId: string,
  amountIdr: number,
  requestedBy: string,
) {
  const refundId = randomUUID();
  refundIds.push(refundId);
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian uji', 'pending', $6)`,
    [refundId, tenantId, outletA, intentId, amountIdr, requestedBy],
  );
  return refundId;
}

const approve = (client: Client, id: string, idempotencyKey = key("apr")) =>
  client
    .post(`${ADMIN}/refunds/${id}/approve`)
    .set(originHeader)
    .send({ idempotencyKey });

const retryWith = (client: Client, id: string, sourceEvidenceId?: string) =>
  client
    .post(`${ADMIN}/refunds/${id}/retry`)
    .set(originHeader)
    .send({
      idempotencyKey: key("retry"),
      ...(sourceEvidenceId ? { sourceEvidenceId } : {}),
    });

async function refundRow(id: string) {
  const { rows } = await owner.query<{
    status: string;
    failure_reason: string | null;
    provider_ref: string | null;
    payout_attempts: number;
    last_payout_error: string | null;
    approval_chain_id: string | null;
  }>(
    `SELECT status, failure_reason, provider_ref, payout_attempts,
            last_payout_error, approval_chain_id
     FROM payment_refunds WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  if (!rows[0]) throw new Error("refund row missing");
  return rows[0];
}

async function fundEvidenceId(fundId: string) {
  const { rows } = await owner.query<{ evidence_id: string | null }>(
    "SELECT evidence_id FROM payment_unallocated_funds WHERE tenant_id = $1 AND id = $2",
    [tenantId, fundId],
  );
  return rows[0]!.evidence_id;
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

/** Make the last update look old, so any backoff has elapsed. */
const ageRefund = (id: string, interval = "2 hours") =>
  owner.query(
    `UPDATE payment_refunds SET updated_at = now() - $3::interval WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, interval],
  );

const sweep = () => sweepApprovedRefundPayouts(tenantWide, new Date(), 100);

const callsOf = (refundId: string) =>
  fake.calls.filter((c) => c.refundId === refundId);

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

/**
 * A system-requested refund on a fresh paid intent: the approver submits it,
 * the first two deciders then settle the chain through the approval inbox.
 * Returns once the `approval.resolved` event was consumed (and, if the refund
 * is still approved, once one payout sweep ran).
 */
async function settleChain(
  amountIdr: number,
  level1Decider: string,
  level2Decider: string,
) {
  const intent = await seedPaid(amountIdr);
  const refundId = await insertPendingRefund(
    intent.intentId,
    amountIdr,
    "system:reservation",
  );
  const submitted = await approve(financeA, refundId);
  expect(submitted.status).toBe(200);
  expect(submitted.body.data.status).toBe("pending");
  const chainId = (await refundRow(refundId)).approval_chain_id;
  expect(chainId).not.toBeNull();

  const level1 = (await decisions(refundId)).find((d) => d.level === 1)!;
  await decide(level1Decider, level1.id, "approved");
  const level2 = (await decisions(refundId)).find((d) => d.level === 2)!;
  await decide(level2Decider, level2.id, "approved");
  expect(await decisions(refundId)).toMatchObject([
    { level: 1, status: "approved", decided_by: level1Decider },
    { level: 2, status: "approved", decided_by: level2Decider },
  ]);

  await handleRefundApprovalResolved(
    workerContext,
    await resolvedEventOfChain(chainId!),
  );
  if ((await refundRow(refundId)).status === "approved") {
    await ageRefund(refundId);
    await sweep();
  }
  return refundId;
}

/**
 * An approved, due refund of Rp20.000 against an unallocated fund whose
 * evidence_id is NULL, on an intent with `evidenceCount` evidence rows
 * (A always; B, received later, only for 2).
 */
async function seedApprovedFundRefund(evidenceCount: 1 | 2) {
  const intent = await seedPaid(100_000);
  let evidenceB: { id: string; ref: string } | null = null;
  if (evidenceCount === 2) {
    const ref = `evidence-b-${intent.intentId}`;
    const inserted = await owner.query<{ id: string }>(
      `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
       VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', 20000, now())
       RETURNING id`,
      [tenantId, outletA, intent.intentId, ref],
    );
    evidenceB = { id: inserted.rows[0]!.id, ref };
  }
  const fundId = randomUUID();
  await owner.query(
    `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
     VALUES ($1, $2, $3, $4, NULL, 20000, 'overpayment')`,
    [fundId, tenantId, outletA, intent.intentId],
  );
  const refundId = randomUUID();
  refundIds.push(refundId);
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
                                  requested_by, approved_by, decided_at, payout_attempts, updated_at, unallocated_fund_id)
     VALUES ($1, $2, $3, $4, 20000, 'Kembalikan kelebihan bayar', 'approved', $5, $6, now(), 0, now() - interval '2 hours', $7)`,
    [
      refundId,
      tenantId,
      outletA,
      intent.intentId,
      requesterId,
      // Supervisor authority: payouts re-validate the approval (legend-tvhq).
      financeSupId,
      fundId,
    ],
  );
  return {
    intentId: intent.intentId,
    fundId,
    refundId,
    evidenceA: intent.evidence,
    evidenceB,
  };
}

/** A second NULL-evidence fund plus its approved, due Rp20.000 refund on an existing intent. */
async function seedExtraFundRefund(intentId: string) {
  const fundId = randomUUID();
  await owner.query(
    `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
     VALUES ($1, $2, $3, $4, NULL, 20000, 'overpayment')`,
    [fundId, tenantId, outletA, intentId],
  );
  const refundId = randomUUID();
  refundIds.push(refundId);
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
                                  requested_by, approved_by, decided_at, payout_attempts, updated_at, unallocated_fund_id)
     VALUES ($1, $2, $3, $4, 20000, 'Kembalikan kelebihan bayar', 'approved', $5, $6, now(), 0, now() - interval '2 hours', $7)`,
    [refundId, tenantId, outletA, intentId, requesterId, financeSupId, fundId],
  );
  return { fundId, refundId };
}

beforeAll(async () => {
  ({ userId: requesterId } = await signedIn("owner", "Codex fix requester"));
  ({ client: financeA, userId: financeAId } = await signedIn(
    "finance",
    "Codex fix finance A",
  ));
  ({ client: financeB, userId: financeBId } = await signedIn(
    "finance",
    "Codex fix finance B",
  ));
  ({ client: financeSup, userId: financeSupId } = await signedIn(
    "finance",
    "Codex fix finance supervisor",
    true,
  ));
  ({ userId: financeCId } = await signedIn("finance", "Codex fix finance C"));
  ({ client: ownerB } = await signedIn("owner", "Codex fix owner B"));
  ({ userId: supervisorId } = await signedIn(
    "supervisor",
    "Codex fix supervisor",
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
  // No tier below Rp500.000 (single-approver path for small refunds).
  // Rp500.000: Finance, Owner.
  // Rp2.000.000: Finance, Supervisor. Rp5.000.000: Finance, Finance.
  await setPolicy(500_000, "finance", 1);
  await setPolicy(500_000, "owner", 2);
  await setPolicy(2_000_000, "finance", 1);
  await setPolicy(2_000_000, "supervisor", 2);
  await setPolicy(5_000_000, "finance", 1);
  await setPolicy(5_000_000, "finance", 2);
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

describe("PAY-04 codex F1: a refund needs supervisor authority", () => {
  it("PAY-04 a finance approver without pos.refund.approve is refused with PERMISSION_DENIED; the refund stays pending and nothing is paid", async () => {
    const intent = await seedPaid();
    const refundId = await insertPendingRefund(
      intent.intentId,
      50_000,
      financeAId,
    );

    const response = await approve(financeB, refundId);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("PERMISSION_DENIED");
    expect(fake.calls).toHaveLength(0);
    expect(await refundRow(refundId)).toMatchObject({ status: "pending" });
    expect(await decisions(refundId)).toHaveLength(0);
  });

  it("PAY-04 an approver holding payment.reconcile and pos.refund.approve (owner) pays the same refund out", async () => {
    const intent = await seedPaid();
    const refundId = await insertPendingRefund(
      intent.intentId,
      50_000,
      financeAId,
    );

    const response = await approve(ownerB, refundId);
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe("completed");
    expect(callsOf(refundId)).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ refundId, amountIdr: 50_000 });
  });

  it("PAY-04 a chain where every approver is finance resolves approved but fails with approver_unauthorized and pays nothing", async () => {
    const refundId = await settleChain(5_000_000, financeBId, financeCId);
    expect(callsOf(refundId)).toHaveLength(0);
    expect(await refundRow(refundId)).toMatchObject({
      status: "failed",
      failure_reason: "approver_unauthorized",
    });
  });

  it("PAY-04 a chain with a supervisor approver plus finance resolves approved and pays out", async () => {
    const refundId = await settleChain(2_000_000, financeBId, supervisorId);
    expect(callsOf(refundId)).toHaveLength(1);
    expect(await refundRow(refundId)).toMatchObject({ status: "completed" });
  });
});

describe("PAY-04 codex F2: a fund without its own evidence never pays out", () => {
  it("PAY-04 a fund with no evidence on an intent with two evidence rows holds the payout", async () => {
    const seeded = await seedApprovedFundRefund(2);

    await sweep();

    expect(callsOf(seeded.refundId)).toHaveLength(0);
    expect(await refundRow(seeded.refundId)).toMatchObject({
      status: "approved",
      last_payout_error: EVIDENCE_MAPPING_REQUIRED,
      payout_attempts: 0,
    });
    expect(await fundEvidenceId(seeded.fundId)).toBeNull();
  });

  it("PAY-04 retry without sourceEvidenceId is refused with 409; retry mapping evidence A pays with A's provider reference, never B's", async () => {
    const seeded = await seedApprovedFundRefund(2);
    await sweep();

    const unmapped = await retryWith(financeSup, seeded.refundId);
    expect(unmapped.status).toBe(409);
    expect(unmapped.body.error.code).toBe(EVIDENCE_MAPPING_REQUIRED);
    expect(callsOf(seeded.refundId)).toHaveLength(0);
    expect(await fundEvidenceId(seeded.fundId)).toBeNull();

    const mapped = await retryWith(
      financeSup,
      seeded.refundId,
      seeded.evidenceA.id,
    );
    expect(mapped.status).toBe(200);
    expect(await fundEvidenceId(seeded.fundId)).toBe(seeded.evidenceA.id);
    expect(callsOf(seeded.refundId)).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      refundId: seeded.refundId,
      paymentProviderRef: seeded.evidenceA.ref,
    });
    expect(fake.calls[0]!.paymentProviderRef).not.toBe(seeded.evidenceB!.ref);
    expect(await refundRow(seeded.refundId)).toMatchObject({
      status: "completed",
      last_payout_error: null,
    });
  });

  it("PAY-04 a fund with no evidence on an intent with exactly one evidence row pays out with that reference", async () => {
    const seeded = await seedApprovedFundRefund(1);

    await sweep();

    expect(callsOf(seeded.refundId)).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      refundId: seeded.refundId,
      amountIdr: 20_000,
      paymentProviderRef: seeded.evidenceA.ref,
    });
    expect(await refundRow(seeded.refundId)).toMatchObject({
      status: "completed",
    });
  });

  it("PAY-04 retry mapping evidence of another intent is refused with 409 and maps nothing", async () => {
    const seeded = await seedApprovedFundRefund(2);
    const other = await seedPaid(100_000);
    await sweep();

    const response = await retryWith(
      financeSup,
      seeded.refundId,
      other.evidence.id,
    );
    expect(response.status).toBe(409);
    expect(await fundEvidenceId(seeded.fundId)).toBeNull();
    expect(fake.calls).toHaveLength(0);
    expect(await refundRow(seeded.refundId)).toMatchObject({
      status: "approved",
    });
  });

  it("PAY-04 retry mapping evidence already used by another fund is refused with 409 and maps nothing", async () => {
    const seeded = await seedApprovedFundRefund(2);
    // A second fund of the same intent already owns evidence A.
    await owner.query(
      `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
       VALUES ($1, $2, $3, $4, $5, 20000, 'overpayment')`,
      [randomUUID(), tenantId, outletA, seeded.intentId, seeded.evidenceA.id],
    );
    await sweep();

    const response = await retryWith(
      financeSup,
      seeded.refundId,
      seeded.evidenceA.id,
    );
    expect(response.status).toBe(409);
    expect(await fundEvidenceId(seeded.fundId)).toBeNull();
    expect(callsOf(seeded.refundId)).toHaveLength(0);
    expect(await refundRow(seeded.refundId)).toMatchObject({
      status: "approved",
    });
  });

  it("PAY-04 two concurrent retries mapping two funds of one intent to the same evidence: exactly one 200 and one 409, one fund owns it, the gateway is called once", async () => {
    const first = await seedApprovedFundRefund(2);
    const second = await seedExtraFundRefund(first.intentId);
    await sweep();

    const [r1, r2] = await Promise.all([
      retryWith(financeSup, first.refundId, first.evidenceA.id),
      retryWith(financeSup, second.refundId, first.evidenceA.id),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);

    const owners = [
      await fundEvidenceId(first.fundId),
      await fundEvidenceId(second.fundId),
    ];
    expect(owners.filter((id) => id === first.evidenceA.id)).toHaveLength(1);
    expect(owners.filter((id) => id === null)).toHaveLength(1);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      paymentProviderRef: first.evidenceA.ref,
    });
    const winner = r1.status === 200 ? first : second;
    const loser = r1.status === 200 ? second : first;
    expect(callsOf(winner.refundId)).toHaveLength(1);
    expect(callsOf(loser.refundId)).toHaveLength(0);
    expect(await refundRow(winner.refundId)).toMatchObject({
      status: "completed",
    });
    expect(await refundRow(loser.refundId)).toMatchObject({
      status: "approved",
    });
  });

  it("PAY-04 a fund with no evidence on an intent whose only evidence row belongs to another fund holds the payout", async () => {
    const seeded = await seedApprovedFundRefund(1);
    // Another fund of the same intent already owns the single evidence row.
    await owner.query(
      `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
       VALUES ($1, $2, $3, $4, $5, 20000, 'overpayment')`,
      [randomUUID(), tenantId, outletA, seeded.intentId, seeded.evidenceA.id],
    );

    await sweep();

    expect(callsOf(seeded.refundId)).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
    expect(await refundRow(seeded.refundId)).toMatchObject({
      status: "approved",
      last_payout_error: EVIDENCE_MAPPING_REQUIRED,
    });
    expect(await fundEvidenceId(seeded.fundId)).toBeNull();
  });
});

// legend-tvhq: an approval recorded before the supervisor rule (status
// approved, no supervisor among its approvers) is re-validated before every
// payout send (first send, sweep, retry). It fails: no provider call, the
// refund is quarantined (PAYOUT_QUARANTINED) and audited once.
const PAYOUT_QUARANTINED = "PAYOUT_QUARANTINED";

async function quarantineAudits(refundId: string) {
  const { rows } = await owner.query<{ reason: string | null }>(
    `SELECT event->>'reason' AS reason FROM audit_logs
     WHERE tenant_id = $1 AND event->>'objectId' = $2
       AND event->>'action' = 'payment.refund_payout_quarantined'`,
    [tenantId, refundId],
  );
  return rows;
}

/** A legacy approved refund decided by a finance-only approver; `attempts` gateway calls already failed (unknown outcome). */
async function seedLegacyApprovedRefund(attempts: number) {
  const intent = await seedPaid(100_000);
  const refundId = randomUUID();
  refundIds.push(refundId);
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
                                  requested_by, approved_by, decided_at, payout_attempts, last_payout_error, updated_at)
     VALUES ($1, $2, $3, $4, 30000, 'Pengembalian lama', 'approved', $5, $6, now() - interval '3 hours', $7::int,
             CASE WHEN $7::int > 0 THEN 'Error' ELSE NULL END, now() - interval '2 hours')`,
    [
      refundId,
      tenantId,
      outletA,
      intent.intentId,
      requesterId,
      financeAId,
      attempts,
    ],
  );
  return refundId;
}

describe("PAY-04 legend-tvhq: every payout send re-validates the approval", () => {
  // An earlier attempt may have reached the provider, so sweep and retry only
  // look it up (lookup-only); `not_found` is never re-sent and stays quarantined.
  it("PAY-04 a legacy approved refund without supervisor whose gateway call failed is quarantined by sweep and retry, looked up but never sent", async () => {
    const refundId = await seedLegacyApprovedRefund(1);
    const lookups = () =>
      fake.statusCalls.filter((c) => c.idempotencyKey === `refund:${refundId}`);

    await sweep();
    expect(fake.calls).toHaveLength(0);
    expect(lookups()).toHaveLength(1);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      payout_attempts: 2,
      last_payout_error: PAYOUT_QUARANTINED,
    });
    expect(await quarantineAudits(refundId)).toEqual([
      { reason: "supervisor_required" },
    ]);

    await ageRefund(refundId);
    await sweep();
    const retried = await retryWith(financeSup, refundId);
    expect(retried.status).toBe(409);
    expect(retried.body.error.code).toBe(PAYOUT_QUARANTINED);
    expect(fake.calls).toHaveLength(0);
    expect(lookups()).toHaveLength(3);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      payout_attempts: 4,
      last_payout_error: PAYOUT_QUARANTINED,
    });
    expect(await quarantineAudits(refundId)).toHaveLength(1);
  });

  it("PAY-04 the first send of a legacy approved refund without supervisor is quarantined, not sent", async () => {
    const refundId = await seedLegacyApprovedRefund(0);

    await sweep();

    expect(fake.calls).toHaveLength(0);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      payout_attempts: 0,
      last_payout_error: PAYOUT_QUARANTINED,
    });
    expect(await quarantineAudits(refundId)).toHaveLength(1);
  });

  it("PAY-04 a chain approved only by finance and left approved (before the rule) is quarantined, not sent", async () => {
    const intent = await seedPaid(5_000_000);
    const refundId = await insertPendingRefund(
      intent.intentId,
      5_000_000,
      "system:reservation",
    );
    expect((await approve(financeA, refundId)).status).toBe(200);
    const level1 = (await decisions(refundId)).find((d) => d.level === 1)!;
    await decide(financeBId, level1.id, "approved");
    const level2 = (await decisions(refundId)).find((d) => d.level === 2)!;
    await decide(financeCId, level2.id, "approved");
    // The old settle step approved it without the supervisor check.
    await owner.query(
      `UPDATE payment_refunds SET status = 'approved', approved_by = $3, decided_at = now(),
              updated_at = now() - interval '2 hours'
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, refundId, financeCId],
    );

    await sweep();

    expect(callsOf(refundId)).toHaveLength(0);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      last_payout_error: PAYOUT_QUARANTINED,
    });
    expect(await quarantineAudits(refundId)).toEqual([
      { reason: "supervisor_required" },
    ]);
  });
});

/** An approved, due Rp30.000 refund decided by `approver` at `now() - decidedAgo`. */
async function seedApprovedRefund(
  approver: string,
  decidedAgo = "0 seconds",
  attempts = 0,
) {
  const intent = await seedPaid(100_000);
  const refundId = randomUUID();
  refundIds.push(refundId);
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
                                  requested_by, approved_by, decided_at, payout_attempts, updated_at)
     VALUES ($1, $2, $3, $4, 30000, 'Pengembalian uji', 'approved', $5, $6, now() - $7::interval, $8::int,
             now() - interval '2 hours')`,
    [
      refundId,
      tenantId,
      outletA,
      intent.intentId,
      requesterId,
      approver,
      decidedAgo,
      attempts,
    ],
  );
  return refundId;
}

async function waitUntil(check: () => boolean, ms = 5_000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("PAY-04 legend-tvhq review: quarantine survives a stale worker", () => {
  it("PAY-04 worker A's lease expires, a sweep quarantines, A's late finish leaves the flag and one quarantine audit", async () => {
    const refundId = await seedApprovedRefund(financeSupId);
    let release!: () => void;
    fake.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.enqueue("throw");
    const workerA = runRefundPayout(tenantWide, refundId);
    await waitUntil(() => callsOf(refundId).length === 1);

    // A's lease expires; the approval is found defective (finance-only approver).
    await owner.query(
      `UPDATE payment_refunds SET payout_claimed_until = now() - interval '1 second',
              approved_by = $3, updated_at = now() - interval '2 hours'
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, refundId, financeAId],
    );
    await runRefundPayout(tenantWide, refundId);
    expect((await refundRow(refundId)).last_payout_error).toBe(
      PAYOUT_QUARANTINED,
    );

    release();
    await workerA;
    fake.gate = null;

    expect(callsOf(refundId)).toHaveLength(1);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      last_payout_error: PAYOUT_QUARANTINED,
    });
    expect(await quarantineAudits(refundId)).toEqual([
      { reason: "supervisor_required" },
    ]);
  });
});

describe("PAY-04 legend-tvhq review: permissions are read as of the decision", () => {
  it("PAY-04 an approver whose roles ended after the approval still pays out", async () => {
    const { userId } = await signedIn("finance", "Codex fix ended", true);
    await owner.query(
      `UPDATE role_assignments SET assigned_at = now() - interval '2 hours',
              valid_until = now() - interval '1 minute'
       WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId],
    );
    const refundId = await seedApprovedRefund(userId, "30 minutes");

    await runRefundPayout(tenantWide, refundId);

    expect(callsOf(refundId)).toHaveLength(1);
    expect(await refundRow(refundId)).toMatchObject({ status: "completed" });
    expect(await quarantineAudits(refundId)).toHaveLength(0);
  });

  it("PAY-04 a grant assigned after the approval, with valid_from backdated before it, does not pass that approval", async () => {
    // assigned_at = now(), valid_from = now() - 1 hour (see signedIn).
    const { userId } = await signedIn("finance", "Codex fix backdated", true);
    const refundId = await seedApprovedRefund(userId, "30 minutes");

    await runRefundPayout(tenantWide, refundId);

    expect(callsOf(refundId)).toHaveLength(0);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      last_payout_error: PAYOUT_QUARANTINED,
    });
    expect(await quarantineAudits(refundId)).toEqual([
      { reason: "supervisor_required" },
    ]);
  });
});

describe("PAY-04 legend-tvhq review: a maybe-sent quarantined refund keeps its lookup", () => {
  const providerKey = (refundId: string) => `refund:${refundId}`;

  it("PAY-04 maybe-sent + lookup succeeded completes the refund without a send", async () => {
    const refundId = await seedLegacyApprovedRefund(1);
    fake.setStatus(providerKey(refundId), {
      status: "succeeded",
      providerRef: `PRV-OK-${refundId}`,
    });

    await sweep();

    expect(callsOf(refundId)).toHaveLength(0);
    expect(await refundRow(refundId)).toMatchObject({
      status: "completed",
      provider_ref: `PRV-OK-${refundId}`,
      last_payout_error: null,
    });
    expect(await quarantineAudits(refundId)).toHaveLength(1);
  });

  it("PAY-04 maybe-sent + lookup failed fails the refund through retry", async () => {
    const refundId = await seedLegacyApprovedRefund(1);
    fake.setStatus(providerKey(refundId), {
      status: "failed",
      providerRef: `PRV-NO-${refundId}`,
      code: "declined",
    });

    const retried = await retryWith(financeSup, refundId);

    expect(retried.status).toBe(200);
    expect(callsOf(refundId)).toHaveLength(0);
    expect(await refundRow(refundId)).toMatchObject({
      status: "failed",
      failure_reason: "provider_declined",
    });
  });

  it("PAY-04 maybe-sent + lookup pending keeps polling, stays quarantined, then completes", async () => {
    const refundId = await seedLegacyApprovedRefund(1);
    fake.setStatus(providerKey(refundId), {
      status: "pending",
      providerRef: `PRV-P-${refundId}`,
    });

    await sweep();
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      provider_ref: `PRV-P-${refundId}`,
      last_payout_error: PAYOUT_QUARANTINED,
    });

    fake.setStatus(providerKey(refundId), {
      status: "succeeded",
      providerRef: `PRV-P-${refundId}`,
    });
    await ageRefund(refundId);
    await sweep();

    expect(callsOf(refundId)).toHaveLength(0);
    expect(await refundRow(refundId)).toMatchObject({ status: "completed" });
  });

  it("PAY-04 maybe-sent + lookup not_found makes zero sends and stays quarantined", async () => {
    const refundId = await seedLegacyApprovedRefund(1);

    await sweep();
    await ageRefund(refundId);
    const retried = await retryWith(financeSup, refundId);

    expect(retried.status).toBe(409);
    expect(retried.body.error.code).toBe(PAYOUT_QUARANTINED);
    expect(callsOf(refundId)).toHaveLength(0);
    expect(
      fake.statusCalls.filter(
        (c) => c.idempotencyKey === providerKey(refundId),
      ),
    ).toHaveLength(2);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      last_payout_error: PAYOUT_QUARANTINED,
    });
  });

  it("PAY-04 a never-sent quarantined refund is still skipped by the sweep and refused by retry", async () => {
    const refundId = await seedLegacyApprovedRefund(0);
    await sweep();
    expect((await refundRow(refundId)).last_payout_error).toBe(
      PAYOUT_QUARANTINED,
    );
    await ageRefund(refundId);

    await sweep();
    const retried = await retryWith(financeSup, refundId);

    expect(retried.status).toBe(409);
    expect(retried.body.error.code).toBe(PAYOUT_QUARANTINED);
    expect(callsOf(refundId)).toHaveLength(0);
    expect(
      fake.statusCalls.filter(
        (c) => c.idempotencyKey === providerKey(refundId),
      ),
    ).toHaveLength(0);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      payout_attempts: 0,
    });
  });
});

describe("PAY-04 legend-wam2: the single-evidence fallback is persisted before the first payout", () => {
  it("PAY-04 payout from the only evidence E1 is pending, evidence E2 arrives, the next poll reads the provider result and completes", async () => {
    const seeded = await seedApprovedFundRefund(1);
    fake.enqueue("pending");

    await sweep();
    expect(callsOf(seeded.refundId)).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      paymentProviderRef: seeded.evidenceA.ref,
    });
    expect(await refundRow(seeded.refundId)).toMatchObject({
      status: "approved",
    });

    // A second evidence row for the same intent arrives later.
    await owner.query(
      `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
       VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', 20000, now())`,
      [tenantId, outletA, seeded.intentId, `evidence-e2-${seeded.intentId}`],
    );
    const idempotencyKey = `refund:${seeded.refundId}`;
    const providerRef = fake.storedResult(idempotencyKey)!.providerRef!;
    fake.setStatus(idempotencyKey, { status: "succeeded", providerRef });
    await ageRefund(seeded.refundId);

    await sweep();

    expect(callsOf(seeded.refundId)).toHaveLength(1);
    expect(
      fake.statusCalls.filter((c) => c.idempotencyKey === idempotencyKey),
    ).toHaveLength(1);
    expect(await refundRow(seeded.refundId)).toMatchObject({
      status: "completed",
      provider_ref: providerRef,
      last_payout_error: null,
    });
    // The fallback mapping was stored with the first send.
    expect(await fundEvidenceId(seeded.fundId)).toBe(seeded.evidenceA.id);
  });
});
