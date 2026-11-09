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
//   "Sistem", an email matching system-approval-%@legend.invalid (random part,
//   so it never collides with a person's address), banned, no sign-in
//   credentials and no role assignments. `SYSTEM_APPROVAL_REQUESTER` is the id.
// - `openPendingRefundChains` returns how many chains it opened. Other suites
//   may leave unrelated pending refunds in the shared tenant, so the first run
//   only asserts "at least our two"; the state of every seeded row is exact.
// - "Below the floor" means below the smallest threshold of the tenant's refund
//   policy rows; this suite configures one row at Rp100.000 for that.
// - A forced chain failure is a database error raised inside
//   `openApprovalRequest` (mocked once); the savepoint must keep the caller's
//   transaction alive, shown by a later write of the caller that still commits.
// - Re-running migration 0135 is tested by executing its SQL file statement by
//   statement (split on `--> statement-breakpoint`) on a dedicated connection
//   inside BEGIN ... ROLLBACK, so the shared database is never changed. The
//   CREATE TRIGGER statements are skipped on a re-run because the triggers
//   already exist; the trigger tests below exercise them directly.
// - "No adoption" renames the system user (a plain name change passes the
//   user_role_guard trigger, so it needs no ALTER TABLE ... DISABLE TRIGGER and
//   no table-wide lock) and runs only the migration's DO block: it must raise.
// - Trigger violations are asserted by SQLSTATE 23514 (check_violation).
// - The starvation, lock-timeout and reason cases run in their own fresh
//   isolated tenants (default matrix, floor Rp0), so refunds left by other
//   cases cannot change which candidates a batch sees. A permanently failing
//   chain is made by opening a refund's chain and then clearing
//   approval_chain_id: the orphaned pending approval request makes the next
//   open refuse.
// - The lock-timeout bounds (6 s / 12 s) are loose on purpose: the lock wait is
//   2 s per candidate; only a missing lock timeout (a wait that never ends)
//   should fail them.
// - `openPendingRefundChains(ctx, now, limit, budgetMs, shouldStop)`: a
//   `shouldStop` that returns true makes it open nothing. `shouldStop` is asked
//   once before each candidate, so "stops after one candidate was tried" is a
//   `shouldStop` whose second call returns true.
// - A ban is active when banned = true AND (ban_expires IS NULL OR ban_expires >
//   now()), as Better Auth reads it. A person banned with an expiry in the past
//   can be given a role again; one banned until a future time cannot.
// - The sweep `sweepApprovedRefundPayouts(context, now, limit)` opens pending
//   chains first; payout of approved refunds is covered in
//   payment-refund-approval.test.ts.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  resetPendingRefundChainCursor,
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
let ownerClient: Client; // tenant owner: can grant role assignments
let bannedUserId: string; // an ordinary person whose account is banned
let expiredBanUserId: string; // banned, but the ban expired yesterday
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
  templateKey: "finance" | "supervisor" | "owner",
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
  reason?: string;
}) {
  const tenant = opts.tenant ?? { tenantId, outletId: outletA };
  const intentId = await seedPaid(opts.paidIdr ?? 300_000, tenant);
  const refundId = randomUUID();
  refundIds.push(refundId);
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by)
     VALUES ($1, $2, $3, $4, $5, $7, 'pending', $6)`,
    [
      refundId,
      tenant.tenantId,
      tenant.outletId,
      intentId,
      opts.amountIdr,
      opts.requestedBy,
      opts.reason ?? "Pengembalian otomatis sistem",
    ],
  );
  return { refundId, intentId };
}

/** Opens the chain the way a system refund's creation does, in a real transaction. */
async function openChainAtCreation(
  refundId: string,
  tenant: { tenantId: string; outletId: string } = {
    tenantId,
    outletId: outletA,
  },
) {
  const session = establishTenantContext({
    tenantId: tenantIdSchema.parse(tenant.tenantId),
    brandId: null,
    source: "session",
  });
  const context = outletContext(session, tenant.outletId);
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.tenantId, session.tenantId),
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

/** A new tenant with the factory refund matrix (supervisor from Rp0). */
async function freshTenant() {
  const created = await createIsolatedTenant(
    `sc${randomUUID().replaceAll("-", "").slice(0, 10)}`,
  );
  await withTenant(db, tenantContext(created.tenantId), (tx) =>
    seedTenantRoleTemplates(tx, created.tenantId),
  );
  return created;
}

async function systemEmail() {
  const { rows } = await owner.query<{ email: string }>(
    'SELECT email FROM "user" WHERE id = $1',
    [SYSTEM_USER_ID],
  );
  return rows[0]!.email;
}

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
  ({ client: ownerClient } = await signedIn(
    "owner",
    "System chain owner",
    "tenant",
  ));
  {
    // An ordinary person whose account was banned: no role, never signs in.
    const client = agent(app);
    const email = await signUp(client, "System chain banned");
    await setRole(email, null);
    const session = await client.get("/api/auth/get-session");
    bannedUserId = session.body.user.id as string;
    userIds.push(bannedUserId);
    await owner.query(
      "UPDATE \"user\" SET banned = true, ban_reason = 'test' WHERE id = $1",
      [bannedUserId],
    );
  }
  {
    // Banned with an expiry in the past: the ban no longer applies.
    const client = agent(app);
    const email = await signUp(client, "System chain expired ban");
    await setRole(email, null);
    const session = await client.get("/api/auth/get-session");
    expiredBanUserId = session.body.user.id as string;
    userIds.push(expiredBanUserId);
    await owner.query(
      "UPDATE \"user\" SET banned = true, ban_reason = 'test', ban_expires = now() - interval '1 day' WHERE id = $1",
      [expiredBanUserId],
    );
  }
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
      ban_expires: Date | null;
    }>(
      'SELECT name, email, banned, role, ban_expires FROM "user" WHERE id = $1',
      [SYSTEM_USER_ID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "Sistem",
      banned: true,
      role: null,
      ban_expires: null,
    });
    // The address has a random part: it never collides with a person's address.
    expect(rows[0]!.email).toMatch(/^system-approval-.+@legend\.invalid$/);
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
    const addresses = [await systemEmail(), "system@legend.invalid"];
    for (const email of addresses)
      for (const password of ["Test-password-123!", "system", ""]) {
        const response = await client
          .post("/api/auth/sign-in/email")
          .set(originHeader)
          .send({ email, password });
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

describe("PAY-04 migration 0135 and its guards keep the system user locked down", () => {
  const migrationSql = readFileSync(
    fileURLToPath(
      new URL(
        "../../drizzle/0135_system_approval_requester.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  // The INSERT, the DO block, and the rest (functions and triggers).
  const insertStatement = statements.find((s) => /INSERT INTO "user"/.test(s))!;
  const doStatement = statements.find((s) => /^DO \$\$/m.test(s))!;
  // The triggers already exist on a migrated database: skip CREATE TRIGGER.
  const rerunnable = statements.filter((s) => !/^\s*CREATE TRIGGER/m.test(s));

  type Run = (
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;

  async function inRolledBackTx(body: (run: Run) => Promise<void>) {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await body((text, values) => client.query(text, values));
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }

  async function failureOf(run: () => Promise<unknown>) {
    try {
      await run();
    } catch (error) {
      return error as Error & { code?: string };
    }
    return null;
  }

  /** Each case runs in its own rolled-back transaction and must raise 23514. */
  async function expectViolation(
    statement: string,
    values: unknown[],
    message: RegExp,
    setup?: (run: Run) => Promise<void>,
  ) {
    await inRolledBackTx(async (run) => {
      await setup?.(run);
      const failure = await failureOf(() => run(statement, values));
      expect(failure).toBeInstanceOf(Error);
      expect(failure!.code).toBe("23514");
      expect(failure!.message).toMatch(message);
    });
  }

  const assignmentInsert = `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
    VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $4)`;

  it("PAY-04 the migration file has the insert, the check and both guard triggers", () => {
    expect(insertStatement).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
    expect(doStatement).toMatch(/RAISE EXCEPTION/);
    expect(rerunnable.length).toBeGreaterThanOrEqual(3);
  });

  it("PAY-04 TEN-02 the guard triggers are installed on a migrated database", async () => {
    const { rows } = await owner.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
       WHERE NOT tgisinternal AND tgname IN ('user_role_guard', 'role_assignments_grantee_guard')`,
    );
    expect(rows.map((r) => r.tgname).sort()).toEqual([
      "role_assignments_grantee_guard",
      "user_role_guard",
    ]);
  });

  it("PAY-04 re-running the migration is a no-op for the committed system user", async () => {
    const before = await owner.query('SELECT * FROM "user" WHERE id = $1', [
      SYSTEM_USER_ID,
    ]);
    await inRolledBackTx(async (run) => {
      for (const statement of rerunnable) await run(statement);
      const after = await run('SELECT * FROM "user" WHERE id = $1', [
        SYSTEM_USER_ID,
      ]);
      // ON CONFLICT DO NOTHING: no new random email, nothing else changed.
      expect(after.rows).toEqual(before.rows);
    });
  });

  it("PAY-04 a person who signed up as system@legend.invalid does not block the migration", async () => {
    await inRolledBackTx(async (run) => {
      await run(
        `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
         VALUES ($1, 'Orang Biasa', 'system@legend.invalid', false, now(), now())`,
        [randomUUID()],
      );
      // The old fixed address is taken, but the system row has a random one.
      for (const statement of rerunnable) await run(statement);
      const system = await run('SELECT email FROM "user" WHERE id = $1', [
        SYSTEM_USER_ID,
      ]);
      expect(system.rows).toHaveLength(1);
      expect(system.rows[0]!.email).not.toBe("system@legend.invalid");
    });
    // The committed row carries the random-address pattern.
    expect(await systemEmail()).toMatch(/^system-approval-.+@legend\.invalid$/);
  });

  it("PAY-04 the migration refuses to adopt a user row that is not the system account", async () => {
    await inRolledBackTx(async (run) => {
      // Rename only: banned, no role and no account stay as they were, so only
      // the name check can catch it.
      await run('UPDATE "user" SET name = $2 WHERE id = $1', [
        SYSTEM_USER_ID,
        "Budi",
      ]);
      const failure = await failureOf(() => run(doStatement));
      expect(failure).toBeInstanceOf(Error);
      expect(failure!.message).toMatch(/is not the reserved system account/);
    });
    const { rows } = await owner.query(
      'SELECT name FROM "user" WHERE id = $1',
      [SYSTEM_USER_ID],
    );
    expect(rows).toEqual([{ name: "Sistem" }]);
  });

  it("PAY-04 the migration check fails when the system user has a sign-in account", async () => {
    await inRolledBackTx(async (run) => {
      await run(
        `INSERT INTO "account" (id, account_id, provider_id, user_id, password)
         VALUES ($1, $2, 'credential', $3, 'fake-hash')`,
        [`fake-${randomUUID()}`, SYSTEM_USER_ID, SYSTEM_USER_ID],
      );
      const failure = await failureOf(() => run(doStatement));
      expect(failure).toBeInstanceOf(Error);
      expect(failure!.message).toMatch(/is not the reserved system account/);
    });
    const accounts = await owner.query(
      'SELECT 1 FROM "account" WHERE user_id = $1',
      [SYSTEM_USER_ID],
    );
    expect(accounts.rowCount).toBe(0);
  });

  it("PAY-04 the system user cannot be unbanned", async () => {
    await expectViolation(
      'UPDATE "user" SET banned = false WHERE id = $1',
      [SYSTEM_USER_ID],
      /stays banned with no role/,
    );
  });

  it("PAY-04 the system user cannot be given a role", async () => {
    await expectViolation(
      "UPDATE \"user\" SET role = 'admin' WHERE id = $1",
      [SYSTEM_USER_ID],
      /stays banned with no role/,
    );
  });

  it("PAY-04 a banned person cannot be given a role", async () => {
    await expectViolation(
      "UPDATE \"user\" SET role = 'admin' WHERE id = $1",
      [bannedUserId],
      /banned account cannot be given a role/,
    );
  });

  it("PAY-04 the system user cannot be given a tenant role assignment", async () => {
    await expectViolation(
      assignmentInsert,
      [tenantId, SYSTEM_USER_ID, await roleIdOf("cashier"), financeId],
      /banned or system account cannot be given a role/,
    );
  });

  it("PAY-04 a banned person cannot be given a tenant role assignment", async () => {
    await expectViolation(
      assignmentInsert,
      [tenantId, bannedUserId, await roleIdOf("cashier"), financeId],
      /banned or system account cannot be given a role/,
    );
  });

  it("PAY-04 an assignment already held cannot be moved onto the system user", async () => {
    const roleId = await roleIdOf("cashier");
    await expectViolation(
      "UPDATE role_assignments SET user_id = $1 WHERE user_id = $2 AND role_id = $3",
      [SYSTEM_USER_ID, financeId, roleId],
      /banned or system account cannot be given a role/,
      async (run) => {
        // Give the case a row to move (rolled back with the rest).
        await run(
          `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
           VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
          [tenantId, financeId, roleId],
        );
      },
    );
  });
});

describe("PAY-04 an expired ban no longer blocks roles, an active one still does", () => {
  type Run = (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  async function inRolledBackTx(body: (run: Run) => Promise<void>) {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await body((text, values) => client.query(text, values));
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }
  const failureOf = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      return error as Error & { code?: string };
    }
    return null;
  };

  it("PAY-04 a person whose ban expired can be given a tenant role assignment", async () => {
    await inRolledBackTx(async (run) => {
      const inserted = await run(
        `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
         VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $4)`,
        [tenantId, expiredBanUserId, await roleIdOf("cashier"), financeId],
      );
      expect(inserted.rowCount).toBe(1);
    });
  });

  it("PAY-04 a person whose ban expired can be given a global role", async () => {
    await inRolledBackTx(async (run) => {
      const updated = await run(
        "UPDATE \"user\" SET role = 'admin' WHERE id = $1 RETURNING role",
        [expiredBanUserId],
      );
      expect(updated.rows).toEqual([{ role: "admin" }]);
    });
  });

  it("PAY-04 a person banned until a future time cannot be given a global role or a tenant role", async () => {
    await inRolledBackTx(async (run) => {
      await run(
        "UPDATE \"user\" SET ban_expires = now() + interval '1 day' WHERE id = $1",
        [expiredBanUserId],
      );
      const role = await failureOf(() =>
        run("UPDATE \"user\" SET role = 'admin' WHERE id = $1", [expiredBanUserId]),
      );
      expect(role).toBeInstanceOf(Error);
      expect(role!.code).toBe("23514");
      // The failed statement aborts the transaction: assert the second case alone.
    });
    await inRolledBackTx(async (run) => {
      await run(
        "UPDATE \"user\" SET ban_expires = now() + interval '1 day' WHERE id = $1",
        [expiredBanUserId],
      );
      const assignment = await failureOf(async () =>
        run(
          `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
           VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $4)`,
          [tenantId, expiredBanUserId, await roleIdOf("cashier"), financeId],
        ),
      );
      expect(assignment).toBeInstanceOf(Error);
      expect(assignment!.code).toBe("23514");
    });
  });

  it("PAY-04 the system user stays locked even though its ban has no expiry to wait for", async () => {
    await inRolledBackTx(async (run) => {
      const failure = await failureOf(() =>
        run(
          "UPDATE \"user\" SET ban_expires = now() - interval '1 day' WHERE id = $1",
          [SYSTEM_USER_ID],
        ),
      );
      expect(failure).toBeInstanceOf(Error);
      expect(failure!.code).toBe("23514");
    });
  });

  it("PAY-04 granting a role over the API to a person whose ban expired works with 201", async () => {
    const response = await ownerClient
      .post("/api/access/role-assignments")
      .set(originHeader)
      .send({
        userId: expiredBanUserId,
        roleId: await roleIdOf("cashier"),
        scope: { type: "outlet", id: outletA },
      });
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ userId: expiredBanUserId });
  });
});

describe("PAY-04 role assignments over the API never reach the system user or a banned person", () => {
  const assignmentCount = async (userId: string) =>
    (
      await owner.query("SELECT 1 FROM role_assignments WHERE user_id = $1", [
        userId,
      ])
    ).rowCount;

  async function post(userId: string) {
    return ownerClient
      .post("/api/access/role-assignments")
      .set(originHeader)
      .send({
        userId,
        roleId: await roleIdOf("cashier"),
        scope: { type: "outlet", id: outletA },
      });
  }

  it("PAY-04 an owner granting a role to a person works (control)", async () => {
    const control = await signedIn("finance", "System chain control", "tenant");
    // That helper already assigned finance: grant the cashier role on top.
    const response = await post(control.userId);
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ userId: control.userId });
  });

  it("PAY-04 granting a role to the system user is refused with 422", async () => {
    const response = await post(SYSTEM_USER_ID);
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(await assignmentCount(SYSTEM_USER_ID)).toBe(0);
  });

  it("PAY-04 granting a role to a banned person is refused with 422", async () => {
    const response = await post(bannedUserId);
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(await assignmentCount(bannedUserId)).toBe(0);
  });
});

describe("PAY-04 the sweep stops when told to", () => {
  beforeEach(useFloorOf100k);

  it("PAY-04 TEN-02 openPendingRefundChains opens nothing while shouldStop is true, then opens the refund once it is false", async () => {
    const { refundId } = await insertPendingRefund({
      requestedBy: "system:pos",
      amountIdr: 150_000,
    });
    expect((await refundRow(refundId)).approval_chain_id).toBeNull();

    const stopped = await openPendingRefundChains(
      tenantWide,
      new Date(),
      50,
      60_000,
      () => true,
    );
    expect(stopped).toBe(0);
    expect((await refundRow(refundId)).approval_chain_id).toBeNull();
    expect(await requestsOf(refundId)).toHaveLength(0);

    const running = await openPendingRefundChains(
      tenantWide,
      new Date(),
      50,
      60_000,
      () => false,
    );
    expect(running).toBeGreaterThanOrEqual(1);
    expect((await refundRow(refundId)).approval_chain_id).not.toBeNull();
    expect(await requestsOf(refundId)).toMatchObject([
      { level: 1, status: "pending", requested_by: SYSTEM_USER_ID },
    ]);
  });
});

describe("PAY-04 TEN-02 the sweep copes with odd pending refunds", () => {
  it("PAY-04 a pending refund whose reason is only emoji gets its chain with a valid request reason", async () => {
    const fresh = await freshTenant();
    // Two code points (4 UTF-16 units): shorter than the 3-character minimum, so
    // the request reason gets the "Refund " prefix.
    const { refundId } = await insertPendingRefund({
      requestedBy: "system:pos",
      amountIdr: 50_000,
      tenant: fresh,
      reason: "\u{1F44D}\u{1F44D}",
    });
    resetPendingRefundChainCursor(fresh.tenantId);
    const opened = await openPendingRefundChains(
      tenantContext(fresh.tenantId),
      new Date(),
    );
    expect(opened).toBe(1);
    expect((await refundRow(refundId)).approval_chain_id).not.toBeNull();
    const { rows } = await owner.query<{ request_reason: string }>(
      `SELECT request_reason FROM approval_requests
       WHERE object_type = 'payment_refund' AND object_id = $1`,
      [refundId],
    );
    expect(rows).toEqual([{ request_reason: "Refund \u{1F44D}\u{1F44D}" }]);
  });

  it("PAY-04 refunds whose chain can never open do not starve newer ones", async () => {
    const fresh = await freshTenant();
    const context = tenantContext(fresh.tenantId);
    const stuck: string[] = [];
    for (const age of ["3 days", "2 days"]) {
      const { refundId } = await insertPendingRefund({
        requestedBy: "system:qr",
        amountIdr: 50_000,
        tenant: fresh,
      });
      // Open its chain, then detach it: the pending approval request stays as an
      // orphan and every later open for this refund is refused.
      await openChainAtCreation(refundId, fresh);
      await owner.query(
        `UPDATE payment_refunds SET approval_chain_id = NULL, created_at = now() - $2::interval
         WHERE id = $1`,
        [refundId, age],
      );
      stuck.push(refundId);
    }
    const { refundId: newer } = await insertPendingRefund({
      requestedBy: "system:qr",
      amountIdr: 50_000,
      tenant: fresh,
    });
    await owner.query(
      "UPDATE payment_refunds SET created_at = now() - interval '1 day' WHERE id = $1",
      [newer],
    );

    resetPendingRefundChainCursor(fresh.tenantId);
    // Batch of 2 sees only the two stuck refunds, and opens nothing.
    expect(await openPendingRefundChains(context, new Date(), 2)).toBe(0);
    expect((await refundRow(newer)).approval_chain_id).toBeNull();
    // The next round moves on to the newer refund.
    expect(await openPendingRefundChains(context, new Date(), 2)).toBe(1);
    expect((await refundRow(newer)).approval_chain_id).not.toBeNull();
    expect(await requestsOf(newer)).toMatchObject([
      { level: 1, status: "pending", requested_by: SYSTEM_USER_ID },
    ]);
    for (const id of stuck)
      expect((await refundRow(id)).approval_chain_id).toBeNull();
  });

  it("PAY-04 a refund locked elsewhere is skipped within seconds and the rest still open", async () => {
    const fresh = await freshTenant();
    const context = tenantContext(fresh.tenantId);
    const locked = await insertPendingRefund({
      requestedBy: "system:pos",
      amountIdr: 50_000,
      tenant: fresh,
    });
    await owner.query(
      "UPDATE payment_refunds SET created_at = now() - interval '2 days' WHERE id = $1",
      [locked.refundId],
    );
    const free = await insertPendingRefund({
      requestedBy: "system:reservation",
      amountIdr: 50_000,
      tenant: fresh,
    });
    await owner.query(
      "UPDATE payment_refunds SET created_at = now() - interval '1 day' WHERE id = $1",
      [free.refundId],
    );
    resetPendingRefundChainCursor(fresh.tenantId);

    // Another connection holds the locked refund's payment intent row.
    const holder = await owner.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT id FROM payment_intents WHERE id = $1 FOR UPDATE",
        [locked.intentId],
      );

      const started = Date.now();
      const opened = await openPendingRefundChains(context, new Date());
      expect(Date.now() - started).toBeLessThan(6_000);
      expect(opened).toBe(1);
      expect((await refundRow(free.refundId)).approval_chain_id).not.toBeNull();
      expect((await refundRow(locked.refundId)).approval_chain_id).toBeNull();
      expect(await requestsOf(locked.refundId)).toHaveLength(0);

      // The payout sweep (which opens pending chains first) is not held up either.
      resetPendingRefundChainCursor(fresh.tenantId);
      const sweepStarted = Date.now();
      await sweepApprovedRefundPayouts(context, new Date(), 100);
      expect(Date.now() - sweepStarted).toBeLessThan(12_000);
      expect((await refundRow(locked.refundId)).approval_chain_id).toBeNull();
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }

    // Lock released: the next round opens it.
    resetPendingRefundChainCursor(fresh.tenantId);
    expect(await openPendingRefundChains(context, new Date())).toBe(1);
    expect((await refundRow(locked.refundId)).approval_chain_id).not.toBeNull();
  });
});

describe("PAY-04 TEN-02 a sweep cut short resumes where it stopped", () => {
  it("PAY-04 an early stop keeps the cursor, so the next round moves past the refund that was tried", async () => {
    const fresh = await freshTenant();
    const context = tenantContext(fresh.tenantId);

    // A (oldest): its chain can never open (orphaned pending request). B, C: fine.
    const a = await insertPendingRefund({
      requestedBy: "system:qr",
      amountIdr: 50_000,
      tenant: fresh,
    });
    await openChainAtCreation(a.refundId, fresh);
    const ages: [string, string][] = [];
    const b = await insertPendingRefund({
      requestedBy: "system:qr",
      amountIdr: 50_000,
      tenant: fresh,
    });
    const c = await insertPendingRefund({
      requestedBy: "system:qr",
      amountIdr: 50_000,
      tenant: fresh,
    });
    ages.push([a.refundId, "3 days"], [b.refundId, "2 days"], [c.refundId, "1 day"]);
    for (const [id, age] of ages)
      await owner.query(
        "UPDATE payment_refunds SET created_at = now() - $2::interval WHERE id = $1",
        [id, age],
      );
    await owner.query(
      "UPDATE payment_refunds SET approval_chain_id = NULL WHERE id = $1",
      [a.refundId],
    );

    // True from the second question on: exactly one candidate gets tried.
    const stopAfterOne = () => {
      let asked = 0;
      return () => ++asked > 1;
    };

    resetPendingRefundChainCursor(fresh.tenantId);
    // Round 1 (short page: limit 50, 3 candidates): A is tried and fails; stop.
    expect(
      await openPendingRefundChains(context, new Date(), 50, 60_000, stopAfterOne()),
    ).toBe(0);
    expect((await refundRow(a.refundId)).approval_chain_id).toBeNull();
    expect((await refundRow(b.refundId)).approval_chain_id).toBeNull();
    expect((await refundRow(c.refundId)).approval_chain_id).toBeNull();

    // Round 2 resumes after A: B gets its chain, C waits for the next round.
    expect(
      await openPendingRefundChains(context, new Date(), 50, 60_000, stopAfterOne()),
    ).toBe(1);
    expect((await refundRow(b.refundId)).approval_chain_id).not.toBeNull();
    expect(await requestsOf(b.refundId)).toMatchObject([
      { level: 1, status: "pending", requested_by: SYSTEM_USER_ID },
    ]);
    expect((await refundRow(a.refundId)).approval_chain_id).toBeNull();
    expect((await refundRow(c.refundId)).approval_chain_id).toBeNull();
  });

  it("PAY-04 a very long emoji reason gets its chain with a request reason that is capped and never splits a character", async () => {
    const fresh = await freshTenant();
    // 300 code points = 600 UTF-16 units: over the 500-unit cap.
    const { refundId } = await insertPendingRefund({
      requestedBy: "system:pos",
      amountIdr: 50_000,
      tenant: fresh,
      reason: "\u{1F44D}".repeat(300),
    });
    resetPendingRefundChainCursor(fresh.tenantId);
    expect(
      await openPendingRefundChains(tenantContext(fresh.tenantId), new Date()),
    ).toBe(1);
    expect((await refundRow(refundId)).approval_chain_id).not.toBeNull();
    const { rows } = await owner.query<{ request_reason: string }>(
      `SELECT request_reason FROM approval_requests
       WHERE object_type = 'payment_refund' AND object_id = $1`,
      [refundId],
    );
    expect(rows).toHaveLength(1);
    const reason = rows[0]!.request_reason;
    expect(reason.length).toBeGreaterThan(0);
    expect(reason.length).toBeLessThanOrEqual(500);
    expect([...reason].length).toBeLessThanOrEqual(500);
    // No lone high or low surrogate: the cap did not cut a pair in half.
    expect(reason).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
    expect(reason).toBe(reason.normalize("NFC"));
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
