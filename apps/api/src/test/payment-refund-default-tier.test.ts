// Default refund approval tier from Rp0 (beads legend-zi9o; PAY-04, TEN-02).
// PRD §3.6 / D14: a refund needs the supervisor's PIN or approval. A tenant with
// no refund policy rows gets the default matrix (one row: supervisor from Rp0;
// higher tiers are tenant configuration), the refund chain opens when the refund
// is requested, and a supervisor without payment.reconcile can decide it in the
// approval inbox.
//
// Runs the real Express app, Better Auth, services and PostgreSQL (RLS on); only
// the refund provider is a fake.
//
// Assumptions where the brief is silent:
// - "Finance requests" means a user holding only the finance template (it holds
//   payment.reconcile, not the supervisor role) can file the refund.
// - Deciding a request that is not yours (wrong tenant, wrong role, already
//   decided) refuses by throwing OR by changing nothing; tests assert the
//   stored state, not the refusal mechanism.
// - Whether the level-2 request row already exists (pending) before level 1 is
//   decided is not asserted; only that it is pending after level 1.
// - The migration is re-run inside a transaction that is rolled back, so it
//   cannot add rows to tenants owned by other suites. All reads inside it use
//   that same connection (the migration locks roles and approval_policies).
// - The request-time chain deadline is "about 7 days" (10080 minutes, the
//   maximum): asserted with a few minutes of slack.
// - A pending refund past the pending_unapproved threshold is escalated even
//   though its chain is open; the test ages the refund far past any threshold
//   (400 hours) so it does not depend on the tenant's configured hours.
// - "Funds resolve-by-refund carries approvalChainId": the HTTP response is the
//   fund (not the refund) and has no chain id, so the chain id is asserted on
//   the audit row of the request (payment.unallocated_refund_requested).
// - Tenant-scoped seeding is exercised on isolated tenants; the shared seeded
//   tenant's refund rows are saved and restored, as payment-refund-approval does.
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ROLE_TEMPLATES,
  cafeLegendAccessFixtures,
} from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { tenantIdSchema } from "@starter/shared/core";
import type { ScopedTenantContext } from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { seedTenantRoleTemplates } from "../services/access.service";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway";
import { decideApprovalRequest } from "../services/platform-approval.service";
import {
  escalateStaleRefunds,
  handleRefundApprovalResolved,
  sweepApprovedRefundPayouts,
} from "../services/payment-refund.service";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers";
import { createIsolatedTenant } from "./floor-test-helpers";
import { FakeRefundGateway } from "./refund-fake-gateway";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const ADMIN = "/api/payments/admin";

const tenantContext = (id: string): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(id),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
const sessionTenant = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});
const workerContext: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "job" }),
  { kind: "tenant" },
);
const tenantWide = tenantContext(tenantId);

// The default matrix as the spec states it (PRD §3.6, D14): the supervisor
// approves a refund from Rp0. Written out here rather than imported so a wrong
// constant cannot hide itself.
const DEFAULT_ROWS = [
  { threshold: 0, level: 1, template: "supervisor", distinct: true },
];
const DAY_MS = 24 * 60 * 60 * 1000;

type Client = ReturnType<typeof agent>;
let finance: Client; // payment.reconcile, no supervisor role: files refunds
let financeId: string;
let supervisor1: Client; // pos.refund.approve, NO payment.reconcile
let supervisor1Id: string;
let supervisor2Id: string;
let managerId: string; // outlet manager, level 2
let fake: FakeRefundGateway;

const userIds: string[] = [];
const linkIds: string[] = [];
const intentIds: string[] = [];
const refundIds: string[] = [];
let savedPolicies: Record<string, unknown>[] = [];
const key = (prefix = "k") => `${prefix}-${randomUUID()}`;

async function roleIdOf(templateKey: string, tenant: string = tenantId) {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenant, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

async function signedIn(
  templateKey: "finance" | "supervisor" | "outlet_manager",
  label: string,
  scope: "tenant" | "outlet",
) {
  const client = agent(app);
  const email = await signUp(client, label);
  await setRole(email, null);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  userIds.push(userId);
  await verifySessionMfa(email);
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
    [
      tenantId,
      userId,
      await roleIdOf(templateKey),
      scope,
      scope === "outlet" ? outletA : null,
    ],
  );
  return { client, userId };
}

type PolicyRow = {
  id: string;
  threshold: number | null;
  level: number;
  template_key: string | null;
  approver_role_id: string;
  requires_distinct_actor: boolean;
};

async function refundPolicies(
  tenant: string,
  via: Pick<PoolClient, "query"> = owner,
): Promise<PolicyRow[]> {
  const { rows } = await via.query<PolicyRow>(
    `SELECT p.id, p.threshold_idr::int AS threshold, p.levels AS level, r.template_key,
            p.approver_role_id, p.requires_distinct_actor
     FROM approval_policies p JOIN roles r ON r.id = p.approver_role_id
     WHERE p.tenant_id = $1 AND p.action_type = 'refund'
     ORDER BY p.threshold_idr NULLS FIRST, p.levels, r.template_key`,
    [tenant],
  );
  return rows;
}

const asDefaults = (rows: PolicyRow[]) =>
  rows.map((r) => ({
    threshold: r.threshold,
    level: r.level,
    template: r.template_key,
    distinct: r.requires_distinct_actor,
  }));

/** Back to the factory matrix of the seeded tenant, through the real seeding path. */
async function resetToDefaults() {
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
    [tenantId],
  );
  await withTenant(db, tenantContext(tenantId), (tx) =>
    seedTenantRoleTemplates(tx, tenantId),
  );
}

/** A tenant-configured tiered matrix: supervisor from Rp0, plus the outlet manager from Rp500.000. */
async function useTieredMatrix() {
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
    [tenantId],
  );
  const supervisorRole = await roleIdOf("supervisor");
  const managerRole = await roleIdOf("outlet_manager");
  for (const [threshold, level, role] of [
    [0, 1, supervisorRole],
    [500_000, 1, supervisorRole],
    [500_000, 2, managerRole],
  ] as const)
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
       VALUES ($1, 'refund', $2, $3, $4, true)`,
      [tenantId, threshold, role, level],
    );
}

/** A tenant of its own with the role templates, as platform provisioning gives. */
async function provisionedTenant() {
  const suffix = `rt${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const isolated = await createIsolatedTenant(suffix);
  await withTenant(db, tenantContext(isolated.tenantId), (tx) =>
    seedTenantRoleTemplates(tx, isolated.tenantId),
  );
  return isolated;
}

async function seedPaid(amountIdr: number, evidenceIdr = amountIdr) {
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
      `RDT-${linkId.slice(0, 8)}`,
      amountIdr,
      financeId,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
    [intentId, tenantId, outletA, linkId, amountIdr, `rdt-${intentId}`],
  );
  await owner.query(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [tenantId, outletA, intentId, `evidence-${intentId}`, evidenceIdr],
  );
  return intentId;
}

async function requestRefund(amountIdr: number, paidIdr = amountIdr) {
  const intentId = await seedPaid(paidIdr);
  const response = await finance
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
  const refundId = response.body.data.id as string;
  refundIds.push(refundId);
  return { refundId, intentId };
}

const approveHttp = (client: Client, id: string) =>
  client
    .post(`${ADMIN}/refunds/${id}/approve`)
    .set(originHeader)
    .send({ idempotencyKey: key("apr") });

async function refundRow(id: string) {
  const { rows } = await owner.query<{
    status: string;
    approved_by: string | null;
    approval_chain_id: string | null;
    provider_ref: string | null;
    payout_attempts: number;
  }>(
    `SELECT status, approved_by, approval_chain_id, provider_ref, payout_attempts
     FROM payment_refunds WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  if (!rows[0]) throw new Error("refund row missing");
  return rows[0];
}

async function requestsOf(refundId: string) {
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

async function pendingRequestId(refundId: string) {
  const pending = (await requestsOf(refundId)).filter(
    (r) => r.status === "pending",
  );
  expect(pending.length).toBeGreaterThan(0);
  return pending[0]!.id;
}

const decide = (
  actorId: string,
  requestId: string,
  decision: "approved" | "rejected",
  context = sessionTenant,
) =>
  decideApprovalRequest(
    context,
    actorId,
    requestId,
    { decision, reason: "Sesuai bukti pengembalian." },
    { mfaVerified: true, idempotencyKey: null },
  );

async function attempt(run: () => Promise<unknown>) {
  try {
    await run();
    return { threw: false };
  } catch {
    return { threw: true };
  }
}

async function resolvedEvents(chainId: string) {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
     WHERE tenant_id = $1 AND destination = 'cloud-sync'
       AND event->>'name' = 'approval.resolved'
       AND event->'payload'->>'chainId' = $2`,
    [tenantId, chainId],
  );
  return rows.map((r) => eventEnvelopeSchema.parse(r.event));
}

async function resolvedEventOfChain(chainId: string) {
  const events = await resolvedEvents(chainId);
  expect(events).toHaveLength(1);
  return events[0]!;
}

const chainOf = async (refundId: string) => {
  const chainId = (await refundRow(refundId)).approval_chain_id;
  expect(chainId).not.toBeNull();
  return chainId!;
};

beforeAll(async () => {
  ({ client: finance, userId: financeId } = await signedIn(
    "finance",
    "Default tier finance",
    "tenant",
  ));
  ({ client: supervisor1, userId: supervisor1Id } = await signedIn(
    "supervisor",
    "Default tier supervisor 1",
    "outlet",
  ));
  ({ userId: supervisor2Id } = await signedIn(
    "supervisor",
    "Default tier supervisor 2",
    "outlet",
  ));
  ({ userId: managerId } = await signedIn(
    "outlet_manager",
    "Default tier manager",
    "outlet",
  ));

  savedPolicies = (
    await owner.query(
      "SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
      [tenantId],
    )
  ).rows;
  await resetToDefaults();
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
  await owner.query(
    "DELETE FROM platform_admins WHERE user_id = ANY($1::text[])",
    [userIds],
  );
  await owner.end();
});

beforeEach(() => {
  fake = new FakeRefundGateway();
  setPaymentRefundGateway(fake);
});

describe("PAY-04 default refund matrix for a new tenant", () => {
  it("PAY-04 the role templates give supervisors refund approval but not payment reconcile", () => {
    // Precondition of the whole file: a supervisor decides refunds only through
    // the approval inbox because the template has no payment.reconcile.
    const supervisor = ROLE_TEMPLATES.find((t) => t.key === "supervisor")!;
    expect(supervisor.permissions).toContain("pos.refund.approve");
    expect(supervisor.permissions).not.toContain("payment.reconcile");
    const financeTemplate = ROLE_TEMPLATES.find((t) => t.key === "finance")!;
    expect(financeTemplate.permissions).toContain("payment.reconcile");
    expect(financeTemplate.permissions).not.toContain("pos.refund.approve");
  });

  it("PAY-04 a tenant created in the platform panel has exactly the 1 default refund rule", async () => {
    const admin = agent(app);
    const email = await signUp(admin, "Default tier platform admin");
    await setRole(email, "admin");
    const session = await admin.get("/api/auth/get-session");
    const adminId = session.body.user.id as string;
    userIds.push(adminId);
    await owner.query(
      "INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [adminId],
    );
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
       SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
       WHERE tenant_id = $1 AND template_key = 'owner'`,
      [tenantId, adminId],
    );
    await verifySessionMfa(email);

    const created = await admin
      .post("/api/platform/tenants")
      .set(originHeader)
      .send({
        slug: `uji-${randomBytes(4).toString("hex")}`,
        name: "Uji Refund Default",
        plan: "lengkap",
        deploymentMode: "shared",
        featureFlags: { modules: ["pos"], integrationProviders: [] },
        limits: {
          maxOutlets: 5,
          maxActiveEmployees: 30,
          maxDevices: 10,
          aiRequestsPerMonth: 100,
          whatsappCostCapIdr: 0,
          aiCostCapIdr: 50_000,
          emailCostCapIdr: 10_000,
        },
        firstAdmin: {
          name: "Admin Pertama",
          whatsapp: "6281234567890",
          email: null,
        },
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const newTenant = created.body.data.id as string;

    const rows = await refundPolicies(newTenant);
    expect(asDefaults(rows)).toEqual(DEFAULT_ROWS);
    // The row points at this tenant's own role, not another tenant's.
    const supervisorRole = await roleIdOf("supervisor", newTenant);
    expect(rows.map((r) => r.approver_role_id)).toEqual([supervisorRole]);
  });

  it("PAY-04 seeding an existing tenant without refund rules adds the default once", async () => {
    const tenant = await provisionedTenant();
    await owner.query(
      "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
      [tenant.tenantId],
    );
    expect(await refundPolicies(tenant.tenantId)).toHaveLength(0);
    for (let run = 0; run < 3; run += 1)
      await withTenant(db, tenantContext(tenant.tenantId), (tx) =>
        seedTenantRoleTemplates(tx, tenant.tenantId),
      );
    expect(asDefaults(await refundPolicies(tenant.tenantId))).toEqual(
      DEFAULT_ROWS,
    );
  });
});

describe("PAY-04 refund below Rp500.000 goes to the supervisor inbox", () => {
  beforeEach(resetToDefaults);

  it("PAY-04 a supervisor without payment.reconcile approves a Rp100.000 refund from the inbox", async () => {
    // The payment (Rp300.000) is larger than the refund, so it is partial.
    const { refundId, intentId } = await requestRefund(100_000, 300_000);

    // The chain is open as soon as the refund is requested: no reconcile
    // holder had to decide first.
    const chainId = await chainOf(refundId);
    const requests = await requestsOf(refundId);
    expect(requests).toMatchObject([{ level: 1, status: "pending" }]);
    expect((await refundRow(refundId)).status).toBe("pending");

    // The requester (finance) is not a supervisor and cannot decide the step.
    const requestId = requests[0]!.id;
    await attempt(() => decide(financeId, requestId, "approved"));
    expect(await requestsOf(refundId)).toMatchObject([{ status: "pending" }]);

    await decide(supervisor1Id, requestId, "approved");
    expect(await requestsOf(refundId)).toMatchObject([
      { level: 1, status: "approved", decided_by: supervisor1Id },
    ]);
    // The decision alone does not move the refund; the resolved event does.
    expect((await refundRow(refundId)).status).toBe("pending");

    await handleRefundApprovalResolved(
      workerContext,
      await resolvedEventOfChain(chainId),
    );
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      approved_by: supervisor1Id,
    });
    expect(fake.calls).toHaveLength(0);

    // The payout sweeper then pays once.
    await owner.query(
      "UPDATE payment_refunds SET updated_at = now() - interval '2 hours' WHERE tenant_id = $1 AND id = $2",
      [tenantId, refundId],
    );
    await sweepApprovedRefundPayouts(tenantWide, new Date(), 100);
    expect((await refundRow(refundId)).status).toBe("completed");
    expect(fake.calls.length).toBeGreaterThan(0);
    const { rows } = await owner.query<{ status: string }>(
      "SELECT status FROM payment_intents WHERE tenant_id = $1 AND id = $2",
      [tenantId, intentId],
    );
    expect(rows[0]?.status).toBe("partially_refunded");
  });

  it("PAY-04 a supervisor can also reject it from the inbox and the refund ends failed", async () => {
    const { refundId } = await requestRefund(100_000, 300_000);
    const chainId = await chainOf(refundId);
    await decide(supervisor1Id, await pendingRequestId(refundId), "rejected");
    await handleRefundApprovalResolved(
      workerContext,
      await resolvedEventOfChain(chainId),
    );
    expect(await refundRow(refundId)).toMatchObject({ status: "failed" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("PAY-04 the default matrix needs only the supervisor, whatever the amount", () => {
  beforeEach(resetToDefaults);

  it("PAY-04 a Rp600.000 refund on the default matrix has a single supervisor step", async () => {
    const { refundId } = await requestRefund(600_000);
    const chainId = await chainOf(refundId);
    const requests = await requestsOf(refundId);
    expect(requests).toMatchObject([{ level: 1, status: "pending" }]);
    await decide(supervisor1Id, requests[0]!.id, "approved");
    await handleRefundApprovalResolved(
      workerContext,
      await resolvedEventOfChain(chainId),
    );
    expect(await requestsOf(refundId)).toHaveLength(1);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      approved_by: supervisor1Id,
    });
  });
});

describe("PAY-04 a request opens its approval chain with a long deadline", () => {
  beforeEach(resetToDefaults);

  it("PAY-04 the chain of a new refund is due in about 7 days", async () => {
    const before = Date.now();
    const { refundId } = await requestRefund(100_000, 300_000);
    const { rows } = await owner.query<{ deadline_at: Date }>(
      `SELECT deadline_at FROM approval_requests
       WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2`,
      [tenantId, refundId],
    );
    expect(rows).toHaveLength(1);
    const left = rows[0]!.deadline_at.getTime() - before;
    // 7 days (10080 minutes), minus a little for the time the request took.
    expect(left).toBeGreaterThan(7 * DAY_MS - 10 * 60_000);
    expect(left).toBeLessThanOrEqual(7 * DAY_MS + 60_000);
  });
});

describe("PAY-04 a refund waiting in the inbox is escalated when it is overdue", () => {
  beforeEach(resetToDefaults);

  it("PAY-04 a chained pending refund past the threshold is escalated, stays pending and can still be approved", async () => {
    const { refundId } = await requestRefund(100_000, 300_000);
    const chainId = await chainOf(refundId);
    await owner.query(
      "UPDATE payment_refunds SET created_at = now() - interval '400 hours' WHERE tenant_id = $1 AND id = $2",
      [tenantId, refundId],
    );

    const escalated = await escalateStaleRefunds(tenantWide, new Date(), 100);
    expect(escalated).toBeGreaterThanOrEqual(1);

    const { rows } = await owner.query<{
      status: string;
      escalated_at: Date | null;
      escalation_reason: string | null;
      approval_chain_id: string | null;
    }>(
      `SELECT status, escalated_at, escalation_reason, approval_chain_id
       FROM payment_refunds WHERE tenant_id = $1 AND id = $2`,
      [tenantId, refundId],
    );
    expect(rows[0]).toMatchObject({
      status: "pending",
      escalation_reason: "pending_unapproved",
      approval_chain_id: chainId,
    });
    expect(rows[0]!.escalated_at).not.toBeNull();
    // The chain is untouched: the supervisor can still decide it.
    expect(await requestsOf(refundId)).toMatchObject([
      { level: 1, status: "pending", decided_by: null },
    ]);
    await decide(supervisor1Id, await pendingRequestId(refundId), "approved");
    await handleRefundApprovalResolved(
      workerContext,
      await resolvedEventOfChain(chainId),
    );
    expect((await refundRow(refundId)).status).toBe("approved");
  });
});

describe("PAY-04 refunding an unallocated fund opens the chain at once", () => {
  beforeEach(resetToDefaults);

  it("PAY-04 the audit row of the fund refund carries the approval chain id", async () => {
    // Paid Rp100.000 for a Rp100.000 bill, Rp120.000 received: Rp20.000 is unallocated.
    const intentId = await seedPaid(100_000, 120_000);
    const fundId = randomUUID();
    await owner.query(
      `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason)
       VALUES ($1, $2, $3, $4, 20000, 'overpayment')`,
      [fundId, tenantId, outletA, intentId],
    );
    const response = await finance
      .post(`${ADMIN}/unallocated-funds/${fundId}/resolve`)
      .set(originHeader)
      .send({
        idempotencyKey: key("fund"),
        resolution: "refund",
        note: "Kembalikan kelebihan bayar",
      });
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const { rows } = await owner.query<{
      id: string;
      approval_chain_id: string | null;
    }>(
      "SELECT id, approval_chain_id FROM payment_refunds WHERE tenant_id = $1 AND unallocated_fund_id = $2",
      [tenantId, fundId],
    );
    expect(rows).toHaveLength(1);
    const refundId = rows[0]!.id;
    refundIds.push(refundId);
    const chainId = rows[0]!.approval_chain_id;
    expect(chainId).not.toBeNull();
    // The supervisor's step exists right away.
    expect(await requestsOf(refundId)).toMatchObject([
      { level: 1, status: "pending" },
    ]);

    // The response is the fund itself: still open, as the money has not left.
    expect(response.body.data).toMatchObject({ id: fundId, resolution: null });

    // The audit row of the request carries the chain id of the refund.
    const audit = await owner.query<{ after: Record<string, unknown> | null }>(
      `SELECT event->'maskedChanges'->'after' AS after FROM audit_logs
       WHERE tenant_id = $1 AND event->>'objectId' = $2
         AND event->>'action' = 'payment.unallocated_refund_requested'`,
      [tenantId, refundId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.after).toMatchObject({
      approvalChainId: chainId,
      status: "pending",
    });
  });
});

describe("PAY-04 a configured tier above the default still needs both steps", () => {
  beforeEach(useTieredMatrix);

  it("PAY-04 supervisor decides level 1, the outlet manager level 2; one level is not enough", async () => {
    const { refundId } = await requestRefund(600_000);
    const chainId = await chainOf(refundId);

    const first = await requestsOf(refundId);
    expect(first[0]).toMatchObject({ level: 1, status: "pending" });

    await decide(supervisor1Id, first[0]!.id, "approved");
    // Not approved after level 1 only: no resolved event, refund still pending.
    expect(await resolvedEvents(chainId)).toHaveLength(0);
    expect((await refundRow(refundId)).status).toBe("pending");
    const afterL1 = await requestsOf(refundId);
    expect(afterL1[0]).toMatchObject({
      level: 1,
      status: "approved",
      decided_by: supervisor1Id,
    });
    expect(afterL1[1]).toMatchObject({ level: 2, status: "pending" });

    // Level 2 is the outlet manager's: a supervisor (even another one) cannot
    // stand in for them, and neither can the requester.
    await attempt(() => decide(supervisor2Id, afterL1[1]!.id, "approved"));
    await attempt(() => decide(financeId, afterL1[1]!.id, "approved"));
    expect((await requestsOf(refundId))[1]).toMatchObject({
      status: "pending",
    });
    expect(await resolvedEvents(chainId)).toHaveLength(0);

    await decide(managerId, afterL1[1]!.id, "approved");
    expect(await requestsOf(refundId)).toMatchObject([
      { level: 1, status: "approved", decided_by: supervisor1Id },
      { level: 2, status: "approved", decided_by: managerId },
    ]);
    await handleRefundApprovalResolved(
      workerContext,
      await resolvedEventOfChain(chainId),
    );
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      approved_by: managerId,
    });
  });

  it("PAY-04 a refund of exactly Rp499.999 needs only the supervisor", async () => {
    const { refundId } = await requestRefund(499_999);
    expect(await requestsOf(refundId)).toMatchObject([
      { level: 1, status: "pending" },
    ]);
    await chainOf(refundId);
    expect(
      (await requestsOf(refundId)).filter((r) => r.level === 2),
    ).toHaveLength(0);
  });

  it("PAY-04 a refund of exactly Rp500.000 also needs the outlet manager", async () => {
    const { refundId } = await requestRefund(500_000);
    const requestId = await pendingRequestId(refundId);
    await decide(supervisor1Id, requestId, "approved");
    expect((await requestsOf(refundId))[1]).toMatchObject({
      level: 2,
      status: "pending",
    });
    expect((await refundRow(refundId)).status).toBe("pending");
  });
});

describe("PAY-04 a supervisor without payment.reconcile cannot use the payment-admin approve path", () => {
  it("PAY-04 default matrix: approve is refused with 403 and nothing moves", async () => {
    await resetToDefaults();
    const { refundId } = await requestRefund(100_000);
    const response = await approveHttp(supervisor1, refundId);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("PERMISSION_DENIED");
    expect(await refundRow(refundId)).toMatchObject({
      status: "pending",
      approved_by: null,
    });
    expect(await requestsOf(refundId)).toMatchObject([{ status: "pending" }]);
    expect(fake.calls).toHaveLength(0);
  });

  it("PAY-04 custom matrix with the amount below every tier: still refused with 403", async () => {
    // Only a Rp500.000 tier: a Rp100.000 refund needs no chain (direct path),
    // which still requires payment.reconcile plus pos.refund.approve.
    await owner.query(
      "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
      [tenantId],
    );
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
       VALUES ($1, 'refund', 500000, $2, 1, true)`,
      [tenantId, await roleIdOf("supervisor")],
    );
    try {
      const { refundId } = await requestRefund(100_000);
      const response = await approveHttp(supervisor1, refundId);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("PERMISSION_DENIED");
      expect(await refundRow(refundId)).toMatchObject({
        status: "pending",
        approved_by: null,
      });
      expect(fake.calls).toHaveLength(0);
    } finally {
      await resetToDefaults();
    }
  });
});

describe("PAY-04 a tenant that configured its own refund matrix keeps it", () => {
  // A custom matrix. requires_distinct_actor must be true: the table refuses
  // false for these rows (approval_policies_distinct_actor_check).
  const CUSTOM = [
    { threshold: 250_000, template: "outlet_manager" },
    { threshold: 1_000_000, template: "general_manager" },
  ];

  /**
   * Run the refund_approval_policies_data migration body on a dedicated connection inside a transaction
   * that is always rolled back. The migration locks roles and approval_policies,
   * so every read inside goes through this same connection: a read on another
   * connection would wait for the lock and never return.
   */
  async function inRolledBackMigration<T>(
    inspect: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const dir = fileURLToPath(new URL("../../drizzle/", import.meta.url));
    const file = readdirSync(dir).find((name) =>
      /^\d{4}_refund_approval_policies_data\.sql$/.test(name),
    );
    if (!file)
      throw new Error("Migration refund_approval_policies_data is missing");
    const statements = readFileSync(`${dir}${file}`, "utf8")
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      // Fail fast instead of hanging if another session holds a lock.
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

  it("PAY-04 rows are unchanged after seeding again and after re-running the migration", async () => {
    const custom = await provisionedTenant();
    const legacy = await provisionedTenant(); // an existing tenant with no refund rows
    const partial = await provisionedTenant(); // a tenant without a supervisor role
    const id = custom.tenantId;

    await owner.query(
      "DELETE FROM approval_policies WHERE tenant_id = ANY($1::uuid[]) AND action_type = 'refund'",
      [[id, legacy.tenantId, partial.tenantId]],
    );
    for (const row of CUSTOM)
      await owner.query(
        `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
         VALUES ($1, 'refund', $2, $3, 1, true)`,
        [id, row.threshold, await roleIdOf(row.template, id)],
      );
    const partialSupervisor = await roleIdOf("supervisor", partial.tenantId);
    await owner.query(
      "DELETE FROM approval_policies WHERE tenant_id = $1 AND approver_role_id = $2",
      [partial.tenantId, partialSupervisor],
    );
    await owner.query("DELETE FROM roles WHERE id = $1", [partialSupervisor]);
    const before = await refundPolicies(id);
    expect(before).toHaveLength(2);

    await withTenant(db, tenantContext(id), (tx) =>
      seedTenantRoleTemplates(tx, id),
    );
    expect(await refundPolicies(id)).toEqual(before);

    await inRolledBackMigration(async (client) => {
      // The custom tenant is not touched ...
      expect(await refundPolicies(id, client)).toEqual(before);
      // ... an existing tenant with no refund rules gets the default ...
      expect(asDefaults(await refundPolicies(legacy.tenantId, client))).toEqual(
        DEFAULT_ROWS,
      );
      // ... and a tenant without a supervisor role gets nothing.
      expect(await refundPolicies(partial.tenantId, client)).toHaveLength(0);
    });
    // Rolled back: the migration left no trace for the suites that follow.
    expect(await refundPolicies(legacy.tenantId)).toHaveLength(0);
    expect(await refundPolicies(id)).toEqual(before);
  });

  it("PAY-04 the seeded tenant's matrix survives the migration being re-run", async () => {
    await resetToDefaults();
    const before = await refundPolicies(tenantId);
    expect(asDefaults(before)).toEqual(DEFAULT_ROWS);
    await inRolledBackMigration(async (client) => {
      expect(await refundPolicies(tenantId, client)).toEqual(before);
    });
    expect(await refundPolicies(tenantId)).toEqual(before);
  });
});

describe("TEN-02 refund approval never crosses tenants", () => {
  beforeEach(resetToDefaults);

  it("TEN-02 a supervisor of tenant B cannot decide tenant A's refund chain", async () => {
    const tenantB = await provisionedTenant();
    const { refundId } = await requestRefund(100_000);
    const requestId = await pendingRequestId(refundId);

    // A real supervisor of tenant B.
    const bClient = agent(app);
    const email = await signUp(bClient, "Tenant B supervisor");
    const session = await bClient.get("/api/auth/get-session");
    const bUserId = session.body.user.id as string;
    userIds.push(bUserId);
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
      [
        tenantB.tenantId,
        bUserId,
        await roleIdOf("supervisor", tenantB.tenantId),
        tenantB.outletId,
      ],
    );
    expect(email).toContain("@");

    const outcome = await attempt(() =>
      decide(bUserId, requestId, "approved", {
        ...establishTenantContext({
          tenantId: tenantIdSchema.parse(tenantB.tenantId),
          brandId: null,
          source: "session",
        }),
      }),
    );
    expect(outcome.threw).toBe(true);
    expect(await requestsOf(refundId)).toMatchObject([
      { level: 1, status: "pending", decided_by: null },
    ]);
    expect(await refundRow(refundId)).toMatchObject({ status: "pending" });
  });

  it("TEN-02 seeding the defaults for tenant B does not touch tenant A", async () => {
    const aBefore = await refundPolicies(tenantId);
    const aRoles = (
      await owner.query<{ id: string }>(
        "SELECT id FROM roles WHERE tenant_id = $1",
        [tenantId],
      )
    ).rows.map((r) => r.id);

    const tenantB = await provisionedTenant();
    await owner.query(
      "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
      [tenantB.tenantId],
    );
    await withTenant(db, tenantContext(tenantB.tenantId), (tx) =>
      seedTenantRoleTemplates(tx, tenantB.tenantId),
    );

    expect(asDefaults(await refundPolicies(tenantB.tenantId))).toEqual(
      DEFAULT_ROWS,
    );
    expect(await refundPolicies(tenantId)).toEqual(aBefore);
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM approval_policies
       WHERE tenant_id = $1 AND approver_role_id = ANY($2::uuid[])`,
      [tenantB.tenantId, aRoles],
    );
    expect(rows[0]!.n).toBe("0");
  });
});

describe("PAY-04 an approval is used once", () => {
  beforeEach(resetToDefaults);

  it("PAY-04 deciding twice and replaying approval.resolved changes nothing; one payout", async () => {
    const first = await requestRefund(100_000);
    const chainId = await chainOf(first.refundId);
    const requestId = await pendingRequestId(first.refundId);

    await decide(supervisor1Id, requestId, "approved");
    // Deciding the same step again, by the same or another supervisor, or the
    // opposite way, leaves the chain as it is.
    await attempt(() => decide(supervisor1Id, requestId, "approved"));
    await attempt(() => decide(supervisor2Id, requestId, "approved"));
    await attempt(() => decide(supervisor2Id, requestId, "rejected"));
    expect(await requestsOf(first.refundId)).toMatchObject([
      { level: 1, status: "approved", decided_by: supervisor1Id },
    ]);

    const event = await resolvedEventOfChain(chainId);
    await handleRefundApprovalResolved(workerContext, event);
    await handleRefundApprovalResolved(workerContext, event);
    await handleRefundApprovalResolved(workerContext, event);
    expect(await refundRow(first.refundId)).toMatchObject({
      status: "approved",
      approved_by: supervisor1Id,
      payout_attempts: 0,
    });
    expect(await resolvedEvents(chainId)).toHaveLength(1);

    // A second refund with a chain of its own, still waiting for a decision.
    const second = await requestRefund(50_000);
    const secondChain = await chainOf(second.refundId);
    expect(secondChain).not.toBe(chainId);

    // Replaying the first chain's event does not settle the second refund.
    await handleRefundApprovalResolved(workerContext, event);
    expect(await refundRow(second.refundId)).toMatchObject({
      status: "pending",
      approved_by: null,
    });
    expect(await requestsOf(second.refundId)).toMatchObject([
      { status: "pending" },
    ]);

    // One payout for the approved refund, however often the sweeper runs; the
    // pending one is never paid.
    await owner.query(
      "UPDATE payment_refunds SET updated_at = now() - interval '2 hours' WHERE tenant_id = $1 AND id = $2",
      [tenantId, first.refundId],
    );
    await sweepApprovedRefundPayouts(tenantWide, new Date(), 100);
    await sweepApprovedRefundPayouts(tenantWide, new Date(), 100);
    expect((await refundRow(first.refundId)).status).toBe("completed");
    expect(fake.executionCount).toBe(1);
    expect(await refundRow(second.refundId)).toMatchObject({
      status: "pending",
      provider_ref: null,
    });
  });
});
