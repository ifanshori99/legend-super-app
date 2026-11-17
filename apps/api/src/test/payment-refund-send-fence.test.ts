// legend-3usn8: the refund POST is fenced against a manual settlement. The
// worker takes the send right with one atomic UPDATE and anchors its send budget
// to the deadline that UPDATE validated, so a worker suspended right after the
// check can never POST after `settleRefundManually` completed the refund.
//
// The stall is simulated deterministically: `withTenant` is wrapped so a hook
// runs right before or right after the SECOND tenant transaction of
// `runRefundPayout` (the first is the claim, the second is the send-right check).
// Real Express app, Better Auth, services and PostgreSQL; only the refund
// provider is the fake gateway.
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
  vi,
} from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import * as tenantModule from "../db/tenant";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway";
import { runRefundPayout } from "../services/payment-refund.service";
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
const ADMIN = "/api/payments/admin";
const SETTLED_OUTSIDE_PROVIDER = "SETTLED_OUTSIDE_PROVIDER";

type Client = ReturnType<typeof agent>;
let requesterId: string;
let opsClient: Client;
let financeSupId: string;

const userIds: string[] = [];
const linkIds: string[] = [];
const intentIds: string[] = [];
let fake: FakeRefundGateway;

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
  opts: { alsoSupervisor?: boolean } = {},
) {
  const client = agent(app);
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
  if (opts.alsoSupervisor)
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
      [tenantId, userId, await roleIdOf("supervisor"), outletA],
    );
  return { client, userId };
}

beforeAll(async () => {
  ({ userId: requesterId } = await signedIn("owner", "Fence requester"));
  ({ client: opsClient } = await signedIn("owner", "Fence ops"));
  ({ userId: financeSupId } = await signedIn(
    "finance",
    "Fence finance supervisor",
    { alsoSupervisor: true },
  ));
});

afterAll(async () => {
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
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenantId, userIds],
  );
  await owner.end();
});

beforeEach(() => {
  fake = new FakeRefundGateway();
  // A settlement by hand needs a definitive "declined" answer (legend-980).
  fake.defaultStatus = {
    status: "failed",
    providerRef: "PR-DECLINED",
    code: "declined",
  };
  setPaymentRefundGateway(fake);
});
afterEach(() => {
  setPaymentRefundGateway(null);
  vi.restoreAllMocks();
});

/** A paid Rp100.000 bill with one approved Rp30.000 refund that was never attempted. */
async function seedApprovedRefund() {
  const linkId = randomUUID();
  const intentId = randomUUID();
  const refundId = randomUUID();
  linkIds.push(linkId);
  intentIds.push(intentId);
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, 100000, 100000, 100000, $6)`,
    [
      linkId,
      tenantId,
      outletA,
      randomBytes(32).toString("hex"),
      `FNC-${linkId.slice(0, 8)}`,
      requesterId,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', 100000, $5, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
    [intentId, tenantId, outletA, linkId, `fnc-${intentId}`],
  );
  await owner.query(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', 100000, now())`,
    [tenantId, outletA, intentId, `evidence-${intentId}`],
  );
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
                                  requested_by, approved_by, decided_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 30000, 'Pengembalian uji', 'approved', $5, $6, now(), $7,
             now() - interval '2 hours')`,
    [
      refundId,
      tenantId,
      outletA,
      intentId,
      requesterId,
      financeSupId,
      new Date(Date.now() - 3 * 3_600_000),
    ],
  );
  return { refundId, intentId };
}

async function refundRow(id: string) {
  const { rows } = await owner.query<{
    status: string;
    last_payout_error: string | null;
    payout_attempts: number;
    completed_at: Date | null;
  }>(
    `SELECT status, last_payout_error, payout_attempts, completed_at
     FROM payment_refunds WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  if (!rows[0]) throw new Error("refund row missing");
  return rows[0];
}

const expireLeaseLongAgo = (id: string) =>
  owner.query(
    "UPDATE payment_refunds SET payout_claimed_until = now() - interval '15 minutes' WHERE tenant_id = $1 AND id = $2",
    [tenantId, id],
  );

const callsOf = (refundId: string) =>
  fake.calls.filter((c) => c.refundId === refundId);

const settle = (refundId: string) =>
  opsClient
    .post(`${ADMIN}/refunds/${refundId}/settle-manually`)
    .set(originHeader)
    .send({
      idempotencyKey: `settle-${randomUUID()}`,
      paidAt: new Date(Date.now() - 60_000).toISOString(),
      channel: "bank_transfer",
      externalReference: `TRX-${randomUUID().slice(0, 8)}`,
      amountIdr: 30_000,
      note: "Dibayar manual oleh finance lewat transfer bank.",
    });

/**
 * Runs `hook` right before or right after the second tenant transaction of the
 * worker (the send-right step). Transactions the hook itself opens (settle goes
 * through the same service layer) are not counted.
 */
function atSendRightStep(
  when: "before" | "after",
  hook: () => Promise<void>,
): void {
  const original = tenantModule.withTenant;
  let calls = 0;
  let inHook = false;
  vi.spyOn(tenantModule, "withTenant").mockImplementation(((
    ...args: Parameters<typeof original>
  ) => {
    if (inHook) return original(...args);
    calls += 1;
    if (calls !== 2) return original(...args);
    return (async () => {
      inHook = true;
      try {
        if (when === "before") await hook();
      } finally {
        inHook = false;
      }
      const result = await original(...args);
      inHook = true;
      try {
        if (when === "after") await hook();
      } finally {
        inHook = false;
      }
      return result;
    })();
  }) as typeof original);
}

describe("legend-3usn8 the refund POST is fenced against a manual settlement", () => {
  it("a worker suspended after taking the send right, resumed past the deadline, never POSTs", async () => {
    const { refundId, intentId } = await seedApprovedRefund();
    let settledAt: Date | null = null;
    atSendRightStep("after", async () => {
      // The worker is suspended; time passes beyond its lease and the settle
      // margin, so ops may settle the refund by hand.
      await expireLeaseLongAgo(refundId);
      const response = await settle(refundId);
      expect(response.status).toBe(200);
      settledAt = (await refundRow(refundId)).completed_at;
      // The worker wakes 60 s later: past its 30 s send deadline, while the
      // lease it read still looks live to a plain SELECT (base code POSTs).
      const resumedAt = Date.now() + 60_000;
      vi.spyOn(Date, "now").mockImplementation(() => resumedAt);
    });

    await runRefundPayout(tenantWide, refundId).catch(() => undefined);

    // Base code: the stale worker POSTs with a fresh 30 s budget (paid twice).
    expect(callsOf(refundId)).toHaveLength(0);
    expect(fake.executionCount).toBe(0);
    const after = await refundRow(refundId);
    expect(after).toMatchObject({
      status: "completed",
      last_payout_error: SETTLED_OUTSIDE_PROVIDER,
      payout_attempts: 1,
    });
    expect(after.completed_at?.getTime()).toBe(settledAt!.getTime());
    const { rows } = await owner.query<{ status: string }>(
      "SELECT status FROM payment_intents WHERE tenant_id = $1 AND id = $2",
      [tenantId, intentId],
    );
    expect(rows[0]?.status).toBe("partially_refunded");
  });

  it("while the worker holds the send right, a manual settlement is REFUND_PAYOUT_IN_FLIGHT", async () => {
    const { refundId } = await seedApprovedRefund();
    let refused: { status: number; code?: string } | null = null;
    atSendRightStep("after", async () => {
      const response = await settle(refundId);
      refused = { status: response.status, code: response.body.error?.code };
    });

    await runRefundPayout(tenantWide, refundId);

    expect(refused).toEqual({ status: 409, code: "REFUND_PAYOUT_IN_FLIGHT" });
    expect(callsOf(refundId)).toHaveLength(1);
    expect(fake.executionCount).toBe(1);
    expect((await refundRow(refundId)).status).toBe("completed");
  });

  it("a settlement that commits before the worker reaches the send step: no POST", async () => {
    const { refundId } = await seedApprovedRefund();
    atSendRightStep("before", async () => {
      await expireLeaseLongAgo(refundId);
      const response = await settle(refundId);
      expect(response.status).toBe(200);
    });

    await runRefundPayout(tenantWide, refundId).catch(() => undefined);

    expect(callsOf(refundId)).toHaveLength(0);
    expect(fake.executionCount).toBe(0);
    expect(await refundRow(refundId)).toMatchObject({
      status: "completed",
      last_payout_error: SETTLED_OUTSIDE_PROVIDER,
      payout_attempts: 1,
    });
  });
});
