// System-requested refunds and pre-deploy pending refunds open their approval
// chain (beads legend-2dnh; PAY-04, TEN-02). PRD §3.6 / D14: a refund needs a
// supervisor's approval. Refunds the system files itself (POS, QR and
// reservation late payments: requested_by `system:pos|qr|reservation`) used to
// wait for a human to "submit" them; now their chain opens at creation with a
// reserved system user as requester, and one supervisor decides. Pending refunds
// created before this change (no chain yet) are opened by the payout sweep.
//
// Runs the real Express app, Better Auth, services and PostgreSQL (RLS on); only
// the refund provider is a fake.
//
// Assumptions where the brief is not exact:
// - The reserved system user is id 00000000-0000-4000-8000-000000000002, name
//   "Sistem", email system@legend.invalid, banned, no sign-in credentials and no
//   role assignments. `SYSTEM_APPROVAL_REQUESTER` is the exported id.
// - `openPendingRefundChains` returns how many chains it opened. Other suites
//   may leave unrelated pending refunds in the shared tenant, so the first run
//   only asserts "at least our two"; the state of every seeded row is exact.
// - "Below the floor" means below the smallest threshold of the tenant's refund
//   policy rows; this suite configures one row at Rp100.000 for that.
// - A forced chain failure is a database error raised inside
//   `openApprovalRequest` (mocked once); the savepoint must keep the caller's
//   transaction alive, shown by a later write of the caller that still commits.
// - The sweep `sweepApprovedRefundPayouts(context, now, limit)` opens pending
//   chains first; payout of approved refunds is covered in
//   payment-refund-approval.test.ts.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { and, eq, sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
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
import { paymentRefunds } from "../db/schema/index";
import { withTenant } from "../db/tenant";
import { seedTenantRoleTemplates } from "../services/access.service";
import { outletContext } from "../services/device-pin-support";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway";
import {
  openApprovalRequest,
  decideApprovalRequest,
} from "../services/platform-approval.service";
import {
  SYSTEM_APPROVAL_REQUESTER,
  handleRefundApprovalResolved,
  openPendingRefundChains,
  openRefundChainAtRequest,
  openRefundChainSafely,
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

// Passes through to the real function; one test makes it fail once.
vi.mock("../services/platform-approval.service", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../services/platform-approval.service")
    >();
  return { ...actual, openApprovalRequest: vi.fn(actual.openApprovalRequest) };
});

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const ADMIN = "/api/payments/admin";
const SYSTEM_USER_ID = "00000000-0000-4000-8000-000000000002";

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

type Client = ReturnType<typeof agent>;
let finance: Client; // payment.reconcile only: files refunds, cannot decide them
let financeId: string;
let supervisor1: Client; // pos.refund.approve, NO payment.reconcile
let supervisor1Id: string;
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
  templateKey: "finance" | "supervisor",
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

/** Back to the factory matrix (supervisor from Rp0), through the real seeding path. */
async function resetToDefaults() {
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
    [tenantId],
  );
  await withTenant(db, tenantContext(tenantId), (tx) =>
    seedTenantRoleTemplates(tx, tenantId),
  );
}

/** One refund row at Rp100.000: nothing below that amount needs approval. */
async function useFloorOf100k() {
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
    [tenantId],
  );
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
     VALUES ($1, 'refund', 100000, $2, 1, true)`,
    [tenantId, await roleIdOf("supervisor")],
  );
}

/** A settled bill in `tenant` (default: the seeded tenant). */
async function seedPaid(
  amountIdr = 300_000,
  tenant: { tenantId: string; outletId: string } = {
    tenantId,
    outletId: outletA,
  },
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
      tenant.tenantId,
      tenant.outletId,
      randomBytes(32).toString("hex"),
      `RSC-${linkId.slice(0, 8)}`,
      amountIdr,
      "seed",
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
    [
      intentId,
      tenant.tenantId,
      tenant.outletId,
      linkId,
      amountIdr,
      `rsc-${intentId}`,
    ],
  );
  await owner.query(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [
      tenant.tenantId,
      tenant.outletId,
      intentId,
      `evidence-${intentId}`,
      amountIdr,
    ],
  );
  return intentId;
}

/** A pending refund row exactly as it exists before any chain is opened. */
async function insertPendingRefund(opts: {
  requestedBy: string;
  amountIdr: number;
  tenant?: { tenantId: string; outletId: string };
  paidIdr?: number;
}) {
  const tenant = opts.tenant ?? { tenantId, outletId: outletA };
  const intentId = await seedPaid(opts.paidIdr ?? 300_000, tenant);
  const refundId = randomUUID();
  refundIds.push(refundId);
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian otomatis sistem', 'pending', $6)`,
    [
      refundId,
      tenant.tenantId,
      tenant.outletId,
      intentId,
      opts.amountIdr,
      opts.requestedBy,
    ],
  );
  return { refundId, intentId };
}

/** Opens the chain the way a system refund's creation does, in a real transaction. */
async function openChainAtCreation(refundId: string) {
  return withTenant(db, outletContext(sessionTenant, outletA), async (tx) => {
    const context = outletContext(sessionTenant, outletA);
    const [row] = await tx
      .select()
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.tenantId, tenantId),
          eq(paymentRefunds.id, refundId),
        ),
      );
    if (!row) throw new Error("refund row missing");
    return openRefundChainAtRequest(tx, context, row, new Date());
  });
}

async function refundRow(id: string) {
  const { rows } = await owner.query<{
    status: string;
    approved_by: string | null;
    approval_chain_id: string | null;
    requested_by: string;
    failure_reason: string | null;
    provider_ref: string | null;
    reason: string;
  }>(
    `SELECT status, approved_by, approval_chain_id, requested_by, failure_reason, provider_ref, reason
     FROM payment_refunds WHERE id = $1`,
    [id],
  );
  if (!rows[0]) throw new Error("refund row missing");
  return rows[0];
}

async function requestsOf(refundId: string) {
  const { rows } = await owner.query<{
    id: string;
    level: number;
    status: string;
    requested_by: string;
    decided_by: string | null;
  }>(
    `SELECT id, level, status, requested_by, decided_by FROM approval_requests
     WHERE object_type = 'payment_refund' AND object_id = $1
     ORDER BY level`,
    [refundId],
  );
  return rows;
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

async function attempt(run: () => Promise<unknown>) {
  try {
    await run();
    return { threw: false };
  } catch {
    return { threw: true };
  }
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

const intentStatus = async (intentId: string) =>
  (
    await owner.query<{ status: string }>(
      "SELECT status FROM payment_intents WHERE id = $1",
      [intentId],
    )
  ).rows[0]?.status;

let tenantB: Awaited<ReturnType<typeof createIsolatedTenant>>;

beforeAll(async () => {
  ({ client: finance, userId: financeId } = await signedIn(
    "finance",
    "System chain finance",
    "tenant",
  ));
  ({ client: supervisor1, userId: supervisor1Id } = await signedIn(
    "supervisor",
    "System chain supervisor",
    "outlet",
  ));
  savedPolicies = (
    await owner.query(
      "SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
      [tenantId],
    )
  ).rows;
  await resetToDefaults();

  // Tenant B: its own default matrix, so its pending refunds are eligible too.
  tenantB = await createIsolatedTenant(
    `sc${randomUUID().replaceAll("-", "").slice(0, 10)}`,
  );
  await withTenant(db, tenantContext(tenantB.tenantId), (tx) =>
    seedTenantRoleTemplates(tx, tenantB.tenantId),
  );
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

describe("PAY-04 a system refund opens its approval chain at creation", () => {
  beforeEach(resetToDefaults);

  it("PAY-04 the reserved system user is the requester and a supervisor sees it in the inbox", async () => {
    expect(SYSTEM_APPROVAL_REQUESTER).toBe(SYSTEM_USER_ID);
    const { refundId } = await insertPendingRefund({
      requestedBy: "system:reservation",
      amountIdr: 50_000,
    });
    const opened = await openChainAtCreation(refundId);
    expect(opened.approvalChainId).not.toBeNull();

    // The refund keeps its system origin; the chain's requester is the system user.
    expect(await refundRow(refundId)).toMatchObject({
      status: "pending",
      requested_by: "system:reservation",
      approval_chain_id: opened.approvalChainId,
    });
    const requests = await requestsOf(refundId);
    expect(requests).toMatchObject([
      { level: 1, status: "pending", requested_by: SYSTEM_USER_ID },
    ]);

    // A supervisor (no payment.reconcile) finds it without any reconcile holder acting first.
    const inbox = await supervisor1.get(
      "/api/approvals?status=pending&actionType=refund&limit=100",
    );
    expect(inbox.status).toBe(200);
    expect(
      (inbox.body.data as Array<{ objectId: string }>).map((r) => r.objectId),
    ).toContain(refundId);
  });

  it.each(["system:pos", "system:qr", "system:reservation"])(
    "PAY-04 a %s refund gets a pending supervisor step requested by the system user",
    async (requestedBy) => {
      const { refundId } = await insertPendingRefund({
        requestedBy,
        amountIdr: 40_000,
      });
      await openChainAtCreation(refundId);
      expect(await requestsOf(refundId)).toMatchObject([
        { level: 1, status: "pending", requested_by: SYSTEM_USER_ID },
      ]);
      expect((await refundRow(refundId)).status).toBe("pending");
    },
  );

  it("PAY-04 one supervisor approval settles a system refund and it pays out once", async () => {
    const { refundId, intentId } = await insertPendingRefund({
      requestedBy: "system:reservation",
      amountIdr: 50_000,
    });
    const opened = await openChainAtCreation(refundId);
    const chainId = opened.approvalChainId!;
    const [request] = await requestsOf(refundId);

    await decide(supervisor1Id, request!.id, "approved");
    // The decision alone does not move the refund; the resolved event does.
    expect((await refundRow(refundId)).status).toBe("pending");
    const event = await resolvedEventOfChain(chainId);
    await handleRefundApprovalResolved(workerContext, event);
    await handleRefundApprovalResolved(workerContext, event);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      approved_by: supervisor1Id,
    });
    expect(fake.calls).toHaveLength(0);

    await owner.query(
      "UPDATE payment_refunds SET updated_at = now() - interval '2 hours' WHERE id = $1",
      [refundId],
    );
    await sweepApprovedRefundPayouts(tenantWide, new Date(), 100);
    await sweepApprovedRefundPayouts(tenantWide, new Date(), 100);
    expect(fake.calls.filter((c) => c.refundId === refundId)).toHaveLength(1);
    expect((await refundRow(refundId)).status).toBe("completed");
    expect(await intentStatus(intentId)).toBe("partially_refunded");
  });

  it("PAY-04 a supervisor rejecting a system refund fails it without payout", async () => {
    const { refundId, intentId } = await insertPendingRefund({
      requestedBy: "system:qr",
      amountIdr: 50_000,
    });
    const opened = await openChainAtCreation(refundId);
    const [request] = await requestsOf(refundId);
    await decide(supervisor1Id, request!.id, "rejected");
    await handleRefundApprovalResolved(
      workerContext,
      await resolvedEventOfChain(opened.approvalChainId!),
    );
    expect(await refundRow(refundId)).toMatchObject({
      status: "failed",
      failure_reason: "rejected",
    });
    expect(fake.calls).toHaveLength(0);
    expect(await intentStatus(intentId)).toBe("paid");
  });

  it("PAY-04 the system user can never decide a request", async () => {
    const { refundId } = await insertPendingRefund({
      requestedBy: "system:pos",
      amountIdr: 50_000,
    });
    await openChainAtCreation(refundId);
    const [request] = await requestsOf(refundId);
    await attempt(() => decide(SYSTEM_USER_ID, request!.id, "approved"));
    expect(await requestsOf(refundId)).toMatchObject([
      { status: "pending", decided_by: null },
    ]);
    expect((await refundRow(refundId)).status).toBe("pending");
  });
});

describe("PAY-04 the system account cannot be used to sign in", () => {
  it("PAY-04 the reserved user exists, is banned, and holds no credentials or roles", async () => {
    const { rows } = await owner.query<{
      name: string;
      email: string;
      banned: boolean;
      role: string | null;
    }>('SELECT name, email, banned, role FROM "user" WHERE id = $1', [
      SYSTEM_USER_ID,
    ]);
    expect(rows).toEqual([
      {
        name: "Sistem",
        email: "system@legend.invalid",
        banned: true,
        role: null,
      },
    ]);
    const accounts = await owner.query(
      'SELECT 1 FROM "account" WHERE user_id = $1',
      [SYSTEM_USER_ID],
    );
    expect(accounts.rowCount).toBe(0);
    const assignments = await owner.query(
      "SELECT 1 FROM role_assignments WHERE user_id = $1",
      [SYSTEM_USER_ID],
    );
    expect(assignments.rowCount).toBe(0);
  });

  it("PAY-04 signing in as the system user fails and starts no session", async () => {
    const client = agent(app);
    for (const password of ["Test-password-123!", "system", ""]) {
      const response = await client
        .post("/api/auth/sign-in/email")
        .set(originHeader)
        .send({ email: "system@legend.invalid", password });
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    const session = await client.get("/api/auth/get-session");
    expect(session.body?.user ?? null).toBeNull();
  });
});

describe("PAY-04 pending refunds from before the change get their chain from the sweep", () => {
  beforeEach(useFloorOf100k);

  it("PAY-04 TEN-02 openPendingRefundChains opens each eligible refund exactly once and leaves the rest alone", async () => {
    const byUser = await insertPendingRefund({
      requestedBy: financeId,
      amountIdr: 150_000,
    });
    const bySystem = await insertPendingRefund({
      requestedBy: "system:pos",
      amountIdr: 150_000,
    });
    const belowFloor = await insertPendingRefund({
      requestedBy: "system:qr",
      amountIdr: 50_000,
    });
    // Already has a chain: filed through the API after the change.
    const chainedIntent = await seedPaid(300_000);
    const chainedResponse = await finance
      .post(`${ADMIN}/refunds`)
      .set(originHeader)
      .send({
        idempotencyKey: key("req"),
        paymentIntentId: chainedIntent,
        amountIdr: 150_000,
        reason: "Pelanggan mengembalikan pesanan",
      });
    expect(chainedResponse.status).toBe(201);
    const chainedId = chainedResponse.body.data.id as string;
    refundIds.push(chainedId);
    const chainedBefore = await refundRow(chainedId);
    expect(chainedBefore.approval_chain_id).not.toBeNull();
    expect(await requestsOf(chainedId)).toHaveLength(1);
    // Tenant B has its own eligible pending refund.
    const other = await insertPendingRefund({
      requestedBy: "system:reservation",
      amountIdr: 150_000,
      tenant: tenantB,
    });
    expect((await refundRow(byUser.refundId)).approval_chain_id).toBeNull();
    expect((await refundRow(bySystem.refundId)).approval_chain_id).toBeNull();

    const opened = await openPendingRefundChains(tenantWide, new Date());
    expect(opened).toBeGreaterThanOrEqual(2);

    expect((await refundRow(byUser.refundId)).approval_chain_id).not.toBeNull();
    expect(await requestsOf(byUser.refundId)).toMatchObject([
      { level: 1, status: "pending", requested_by: financeId },
    ]);
    expect(
      (await refundRow(bySystem.refundId)).approval_chain_id,
    ).not.toBeNull();
    expect(await requestsOf(bySystem.refundId)).toMatchObject([
      { level: 1, status: "pending", requested_by: SYSTEM_USER_ID },
    ]);
    // Below the policy floor: nobody needs to approve it, so no chain.
    expect((await refundRow(belowFloor.refundId)).approval_chain_id).toBeNull();
    expect(await requestsOf(belowFloor.refundId)).toHaveLength(0);
    // An existing chain is not touched or duplicated.
    expect(await refundRow(chainedId)).toMatchObject({
      approval_chain_id: chainedBefore.approval_chain_id,
    });
    expect(await requestsOf(chainedId)).toHaveLength(1);
    // TEN-02: the other tenant's refund is not opened by this tenant's run.
    expect((await refundRow(other.refundId)).approval_chain_id).toBeNull();
    expect(await requestsOf(other.refundId)).toHaveLength(0);

    // A second run does nothing.
    const chainsAfterFirst = {
      user: (await refundRow(byUser.refundId)).approval_chain_id,
      system: (await refundRow(bySystem.refundId)).approval_chain_id,
    };
    expect(await openPendingRefundChains(tenantWide, new Date())).toBe(0);
    expect(await requestsOf(byUser.refundId)).toHaveLength(1);
    expect(await requestsOf(bySystem.refundId)).toHaveLength(1);
    expect({
      user: (await refundRow(byUser.refundId)).approval_chain_id,
      system: (await refundRow(bySystem.refundId)).approval_chain_id,
    }).toEqual(chainsAfterFirst);

    // Tenant B is opened by its own run (and it was eligible all along).
    expect(
      await openPendingRefundChains(
        tenantContext(tenantB.tenantId),
        new Date(),
      ),
    ).toBeGreaterThanOrEqual(1);
    expect((await refundRow(other.refundId)).approval_chain_id).not.toBeNull();
    expect(await requestsOf(other.refundId)).toMatchObject([
      { level: 1, status: "pending", requested_by: SYSTEM_USER_ID },
    ]);
  });

  it("PAY-04 a pending refund opened by the sweep is approved by a supervisor and paid", async () => {
    const { refundId, intentId } = await insertPendingRefund({
      requestedBy: "system:reservation",
      amountIdr: 150_000,
    });
    await sweepApprovedRefundPayouts(tenantWide, new Date(), 100);
    const row = await refundRow(refundId);
    expect(row.approval_chain_id).not.toBeNull();
    const [request] = await requestsOf(refundId);
    expect(request).toMatchObject({
      status: "pending",
      requested_by: SYSTEM_USER_ID,
    });

    await decide(supervisor1Id, request!.id, "approved");
    await handleRefundApprovalResolved(
      workerContext,
      await resolvedEventOfChain(row.approval_chain_id!),
    );
    await owner.query(
      "UPDATE payment_refunds SET updated_at = now() - interval '2 hours' WHERE id = $1",
      [refundId],
    );
    await sweepApprovedRefundPayouts(tenantWide, new Date(), 100);
    expect((await refundRow(refundId)).status).toBe("completed");
    expect(fake.calls.filter((c) => c.refundId === refundId)).toHaveLength(1);
    expect(await intentStatus(intentId)).toBe("partially_refunded");
  });
});

// Keep last: it makes the mocked `openApprovalRequest` fail once.
describe("PAY-04 a failing chain never rolls back the caller's transaction", () => {
  beforeEach(resetToDefaults);

  it("PAY-04 openRefundChainSafely opens the chain when nothing goes wrong", async () => {
    const { refundId } = await insertPendingRefund({
      requestedBy: "system:pos",
      amountIdr: 50_000,
    });
    const context = outletContext(sessionTenant, outletA);
    const result = await withTenant(db, context, async (tx) => {
      const [row] = await tx
        .select()
        .from(paymentRefunds)
        .where(eq(paymentRefunds.id, refundId));
      return openRefundChainSafely(tx, context, row!, new Date());
    });
    expect(result.approvalChainId).not.toBeNull();
    expect((await refundRow(refundId)).approval_chain_id).toBe(
      result.approvalChainId,
    );
    expect(await requestsOf(refundId)).toHaveLength(1);
  });

  it("PAY-04 when opening the chain fails, the refund is still committed with no chain", async () => {
    const { refundId } = await insertPendingRefund({
      requestedBy: "system:pos",
      amountIdr: 50_000,
    });
    vi.mocked(openApprovalRequest).mockImplementationOnce(async (tx) => {
      // A real database error: it aborts the transaction unless it is isolated.
      await tx.execute(sql`SELECT 1 / 0`);
      throw new Error("unreachable");
    });
    const context = outletContext(sessionTenant, outletA);
    const result = await withTenant(db, context, async (tx) => {
      const [row] = await tx
        .select()
        .from(paymentRefunds)
        .where(eq(paymentRefunds.id, refundId));
      const safe = await openRefundChainSafely(tx, context, row!, new Date());
      // The caller keeps working in the same transaction afterwards.
      await tx.execute(
        sql`UPDATE payment_refunds SET reason = 'Setelah chain gagal' WHERE id = ${refundId}`,
      );
      return safe;
    });
    expect(result.approvalChainId).toBeNull();
    expect(await refundRow(refundId)).toMatchObject({
      status: "pending",
      approval_chain_id: null,
      reason: "Setelah chain gagal",
    });
    expect(await requestsOf(refundId)).toHaveLength(0);
  });
});
