// legend-xd2q: manual settlement of a refund that finance paid by hand, and the
// "maybe-sent is never POSTed again" tripwire. Written from the architect brief
// (behaviour A and B), not from the service code; they may fail until the code
// lands. Real Express app, Better Auth, services and PostgreSQL; only the refund
// provider is the fake gateway.
//
// Assumptions where the brief is not exact:
// - Settle answers 200 with the refund view (like the quarantine actions); a
//   replay of the same key and body answers 200 with the same view.
// - Error codes asserted are the ones the brief names (REFUND_NOT_SETTLEABLE,
//   REFUND_AT_PROVIDER, REFUND_PAYOUT_IN_FLIGHT, SETTLEMENT_AMOUNT_MISMATCH,
//   VALIDATION_ERROR) plus the codes the quarantine routes already use
//   (PERMISSION_DENIED, APPROVER_IS_REQUESTER, MFA_REQUIRED,
//   IDEMPOTENCY_KEY_REUSED). Body validation failures answer 422.
// - An unallocated fund is open while resolved_at/resolved_by are NULL and
//   resolved by the settler once they are set.
// - Item 6 of the review round (settle with mfaVerified false although no role
//   of the actor requires MFA) is NOT tested: the harness cannot express a user
//   whose roles do not require MFA without changing the shared tenant roles.
// - A payout lease that ended within the last 10 minutes (claim token still set)
//   blocks the settlement (REFUND_PAYOUT_IN_FLIGHT); older than 10 minutes does
//   not. Tests use 1 and 5 minutes versus 15, never the boundary itself.
// - The audit `reason` of the settlement is the ops note, as in the quarantine
//   audits; the evidence and the approval defect are asserted on the serialized
//   audit event, not on a fixed field path.
// - Seeded refunds are decided by a finance-only approver (the legacy shape that
//   has no supervisor among its approvers); the defect is recorded, not blocking.
//   Tripwire refunds are decided by a finance + supervisor user so the approval
//   re-validation passes and only the lookup path is exercised.
// - "Ops" is an owner other than the requester (owners hold payment.reconcile and
//   pos.refund.approve and passed MFA in this session).
// - The retry endpoint on a flagged refund answers 200 or 409; only the stored
//   state and the gateway calls are asserted.
// - `paidAt` is generated from the JS clock, and `created_at` is seeded from the
//   JS clock too, so clock drift between the database and the host cannot move it
//   out of [createdAt, now + 5 min].
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
import { run as runPreswitchReset } from "../db/reset-preswitch-refund-payouts";
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
const SETTLED_OUTSIDE_PROVIDER = "SETTLED_OUTSIDE_PROVIDER";
const PAYOUT_NOT_FOUND_MAYBE_SENT = "PAYOUT_NOT_FOUND_MAYBE_SENT";
const PAYOUT_QUARANTINED = "PAYOUT_QUARANTINED";
const MANUAL_RECONCILIATION = "MANUAL_RECONCILIATION";
const SETTLE_ACTION = "payment.refund_settled_manually";
const NOT_FOUND_ACTION = "payment.refund_payout_not_found";
const CONFLICT_ACTION = "payment.refund_provider_conflict";

type Client = ReturnType<typeof agent>;
let requesterId: string; // owner: files every seeded refund, never settles
let opsClient: Client; // owner B: settles
let opsId: string;
let financeOnly: Client; // finance without pos.refund.approve
let financeSup: Client; // finance + supervisor, MFA verified
let financeSupId: string;
let financeAId: string; // legacy approver without supervisor authority
let noMfa: Client; // finance + supervisor, MFA never verified this session

const userIds: string[] = [];
const linkIds: string[] = [];
const intentIds: string[] = [];
const refundIds: string[] = [];
let fake: LookupGateway;

const key = (prefix = "k") => `${prefix}-${randomUUID()}`;

/** Fake provider whose status lookup can be made to fail (an unknown outcome). */
class LookupGateway extends FakeRefundGateway {
  lookupFails = false;
  /**
   * Awaited inside the next `getRefundStatus` only (after the call is recorded),
   * to hold a worker mid-lookup; later lookups (the settlement's own) are not held.
   */
  lookupGate: Promise<void> | null = null;
  override async getRefundStatus(
    input: Parameters<FakeRefundGateway["getRefundStatus"]>[0],
  ) {
    if (this.lookupGate) {
      const gate = this.lookupGate;
      this.lookupGate = null;
      this.statusCalls.push(input);
      await gate;
      const override = await super.getRefundStatus(input);
      this.statusCalls.pop();
      return override;
    }
    if (this.lookupFails) {
      this.statusCalls.push(input);
      throw new Error("fake refund provider lookup unavailable");
    }
    return super.getRefundStatus(input);
  }
}

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

beforeAll(async () => {
  await scope.seed(owner);
  ({ userId: requesterId } = await signedIn("owner", "Settle requester"));
  ({ client: opsClient, userId: opsId } = await signedIn(
    "owner",
    "Settle ops",
  ));
  ({ client: financeOnly } = await signedIn("finance", "Settle finance only"));
  ({ client: financeSup, userId: financeSupId } = await signedIn(
    "finance",
    "Settle finance supervisor",
    { alsoSupervisor: true },
  ));
  ({ userId: financeAId } = await signedIn("finance", "Settle finance A"));
  ({ client: noMfa } = await signedIn("finance", "Settle no MFA", {
    alsoSupervisor: true,
    verifyMfa: false,
  }));
});

afterAll(async () => {
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
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenantId, userIds],
  );
  await owner.end();
});

beforeEach(() => {
  fake = new LookupGateway();
  setPaymentRefundGateway(fake);
});
afterEach(() => {
  setPaymentRefundGateway(null);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A settled bill: link + paid intent + one evidence row. */
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
      `MST-${linkId.slice(0, 8)}`,
      amountIdr,
      requesterId,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
    [intentId, tenantId, outletA, linkId, amountIdr, `mst-${intentId}`],
  );
  await owner.query(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [tenantId, outletA, intentId, `evidence-${intentId}`, amountIdr],
  );
  return intentId;
}

type RefundSeed = {
  status?: "approved" | "pending" | "failed" | "completed";
  attempts?: number;
  lastError?: string | null;
  providerRef?: string | null;
  polls?: number;
  /** Minutes the payout lease stays live (null: no lease). */
  leaseMinutes?: number | null;
  amountIdr?: number;
  intentAmountIdr?: number;
  approver?: string;
  requestedBy?: string;
  withFund?: boolean;
};

/**
 * A refund written straight into the table. Defaults to the Rp30.000 refund of
 * a Rp100.000 bill, approved by a finance-only approver, updated two hours ago
 * (so any backoff has elapsed), created three hours ago.
 */
async function seedRefund(seed: RefundSeed = {}) {
  const intentId = await seedPaid(seed.intentAmountIdr ?? 100_000);
  const refundId = randomUUID();
  refundIds.push(refundId);
  let fundId: string | null = null;
  if (seed.withFund) {
    fundId = randomUUID();
    await owner.query(
      `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
       VALUES ($1, $2, $3, $4, NULL, $5, 'overpayment')`,
      [fundId, tenantId, outletA, intentId, seed.amountIdr ?? 30_000],
    );
  }
  const status = seed.status ?? "approved";
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
                                  requested_by, approved_by, decided_at, provider_ref, payout_pending_polls,
                                  payout_attempts, last_payout_error, payout_claimed_until, payout_claim_token,
                                  unallocated_fund_id, created_at, completed_at, failure_reason, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian uji', $6, $7, $8, $9, $10, $11, $12, $13,
             CASE WHEN $14::int IS NULL THEN NULL ELSE now() + make_interval(mins => $14::int) END,
             CASE WHEN $14::int IS NULL THEN NULL ELSE $15::uuid END,
             $16, $17,
             $18, $19,
             now() - interval '2 hours')`,
    [
      refundId,
      tenantId,
      outletA,
      intentId,
      seed.amountIdr ?? 30_000,
      status,
      seed.requestedBy ?? requesterId,
      status === "pending" ? null : (seed.approver ?? financeAId),
      // Decided just now: the supervisor assignment of the approvers below is
      // valid from one hour ago, so a decision 3 hours old would predate it.
      status === "pending" ? null : new Date(),
      seed.providerRef ?? null,
      seed.polls ?? 0,
      seed.attempts ?? 0,
      seed.lastError ?? null,
      seed.leaseMinutes ?? null,
      randomUUID(),
      fundId,
      new Date(Date.now() - 3 * 3_600_000),
      status === "completed" ? new Date() : null,
      status === "failed" ? "provider_declined" : null,
    ],
  );
  return { refundId, intentId, fundId };
}

async function refundRow(id: string) {
  const { rows } = await owner.query<{
    status: string;
    provider_ref: string | null;
    payout_attempts: number;
    payout_pending_polls: number;
    last_payout_error: string | null;
    live: boolean;
    claim_token: string | null;
    completed_at: Date | null;
  }>(
    `SELECT status, provider_ref, payout_attempts, payout_pending_polls, last_payout_error,
            COALESCE(payout_claimed_until > now(), false) AS live,
            payout_claim_token AS claim_token, completed_at
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

async function fundRow(fundId: string) {
  const { rows } = await owner.query<Record<string, unknown>>(
    "SELECT * FROM payment_unallocated_funds WHERE tenant_id = $1 AND id = $2",
    [tenantId, fundId],
  );
  return rows[0]!;
}

async function audits(refundId: string, action: string) {
  const { rows } = await owner.query<{
    actor: string | null;
    reason: string | null;
    event: unknown;
  }>(
    `SELECT event->>'actorId' AS actor, event->>'reason' AS reason, event
     FROM audit_logs
     WHERE tenant_id = $1 AND event->>'objectId' = $2 AND event->>'action' = $3`,
    [tenantId, refundId, action],
  );
  return rows;
}

/** Distinct events of that name that mention the refund or its bill (every test has its own bill). */
async function outboxEventCount(ids: string[], name: string) {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(DISTINCT event->>'id')::int AS n FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = $2
       AND EXISTS (SELECT 1 FROM unnest($3::text[]) AS needle WHERE event::text LIKE '%' || needle || '%')`,
    [tenantId, name, ids],
  );
  return rows[0]!.n;
}

const expireLeaseLongAgo = (id: string) =>
  owner.query(
    "UPDATE payment_refunds SET payout_claimed_until = now() - interval '15 minutes' WHERE tenant_id = $1 AND id = $2",
    [tenantId, id],
  );

const ageRefund = (id: string, interval = "2 hours") =>
  owner.query(
    "UPDATE payment_refunds SET updated_at = now() - $3::interval WHERE tenant_id = $1 AND id = $2",
    [tenantId, id, interval],
  );

const sweep = () => sweepApprovedRefundPayouts(tenantWide, new Date(), 100);
const callsOf = (refundId: string) =>
  fake.calls.filter((c) => c.refundId === refundId);
const lookupsOf = (refundId: string) =>
  fake.statusCalls.filter((c) => c.idempotencyKey === `refund:${refundId}`);

async function waitUntil(check: () => boolean, ms = 5_000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const NOTE = "Dibayar manual oleh finance lewat transfer bank.";
const minutesFromNow = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString();

/** The evidence of a hand payment; `overrides` replaces any field. */
function settlementBody(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: key("settle"),
    paidAt: minutesFromNow(-1),
    channel: "bank_transfer",
    externalReference: `TRX-${randomUUID().slice(0, 8)}`,
    amountIdr: 30_000,
    note: NOTE,
    ...overrides,
  };
}

const settle = (
  client: Client,
  refundId: string,
  body: Record<string, unknown> = settlementBody(),
) =>
  client
    .post(`${ADMIN}/refunds/${refundId}/settle-manually`)
    .set(originHeader)
    .send(body);

const retryWith = (client: Client, id: string) =>
  client
    .post(`${ADMIN}/refunds/${id}/retry`)
    .set(originHeader)
    .send({ idempotencyKey: key("retry") });

// ---------------------------------------------------------------------------
// B. Manual settlement
// ---------------------------------------------------------------------------

describe("legend-xd2q PAY-04 manual settlement of a refund finance paid by hand", () => {
  it("PAY-04 an exhausted refund (8 attempts, MANUAL_RECONCILIATION) is completed with the marker, audited with its evidence, the bill updated and the fund resolved", async () => {
    const { refundId, intentId, fundId } = await seedRefund({
      attempts: 8,
      lastError: MANUAL_RECONCILIATION,
      withFund: true,
    });
    const body = settlementBody({ externalReference: "TRX-20261109-0042" });

    const response = await settle(opsClient, refundId, body);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: refundId,
      status: "completed",
      lastPayoutError: SETTLED_OUTSIDE_PROVIDER,
    });
    expect(response.body.data.completedAt).toEqual(expect.any(String));
    const row = await refundRow(refundId);
    expect(row).toMatchObject({
      status: "completed",
      provider_ref: null,
      last_payout_error: SETTLED_OUTSIDE_PROVIDER,
      live: false,
      claim_token: null,
    });
    expect(row.completed_at).not.toBeNull();
    // (The bill status of a refund that returns an overpayment fund is not
    // asserted here: the other tests cover refunded / partially_refunded.)

    // The fund is resolved by the person who settled it.
    const fund = await fundRow(fundId!);
    expect(fund.resolved_by).toBe(opsId);
    expect(fund.resolved_at).not.toBeNull();
    expect(fund.resolution).not.toBeNull();

    // One audit with the evidence, the note, the actor and the approval defect.
    const rows = await audits(refundId, SETTLE_ACTION);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: opsId, reason: NOTE });
    // The evidence is stored readable (not masked) for the reconciliation.
    const after = (
      rows[0]!.event as {
        maskedChanges: { after: Record<string, unknown> };
      }
    ).maskedChanges.after;
    expect(after).toMatchObject({
      status: "completed",
      channel: "bank_transfer",
      externalReference: "TRX-20261109-0042",
      amountIdr: 30_000,
      approvalDefect: "supervisor_required",
    });
    expect(new Date(after.paidAt as string).getTime()).toBe(
      new Date(body.paidAt).getTime(),
    );
    expect(JSON.stringify(rows[0]!.event)).not.toContain("[REDACTED]");

    // `payment.refunded` goes out as for a normal completion.
    expect(
      await outboxEventCount([refundId, intentId], "payment.refunded"),
    ).toBe(1);
    // No payout was sent on the way; the settlement only asked the provider once
    // (legend-980: a refund with attempts is looked up first).
    expect(fake.calls).toHaveLength(0);
    expect(fake.statusCalls).toHaveLength(1);
  });

  it("PAY-04 settling a refund that covers the whole bill moves the bill to refunded", async () => {
    const { refundId, intentId } = await seedRefund({
      attempts: 8,
      lastError: MANUAL_RECONCILIATION,
      amountIdr: 100_000,
    });

    const response = await settle(
      opsClient,
      refundId,
      settlementBody({ amountIdr: 100_000 }),
    );

    expect(response.status).toBe(200);
    expect(await intentStatus(intentId)).toBe("refunded");
  });

  const eligibleShapes: [string, RefundSeed][] = [
    [
      "an exhausted refund (attempts 8, MANUAL_RECONCILIATION)",
      { attempts: 8, lastError: MANUAL_RECONCILIATION },
    ],
    [
      "a refund that timed out (attempts 3, a plain error)",
      { attempts: 3, lastError: "SERVICE_UNAVAILABLE" },
    ],
    [
      "a maybe-sent quarantined refund (PAYOUT_QUARANTINED, attempts 1)",
      { attempts: 1, lastError: PAYOUT_QUARANTINED },
    ],
    [
      "a never-sent quarantined refund (PAYOUT_QUARANTINED, attempts 0)",
      { attempts: 0, lastError: PAYOUT_QUARANTINED },
    ],
    [
      "a maybe-sent refund the provider never saw (PAYOUT_NOT_FOUND_MAYBE_SENT)",
      { attempts: 2, lastError: PAYOUT_NOT_FOUND_MAYBE_SENT },
    ],
    ["a never-attempted refund (attempts 0, no error)", { attempts: 0 }],
    [
      "a refund whose payout lease ended more than 10 minutes ago",
      { attempts: 1, lastError: "Error", leaseMinutes: -15 },
    ],
  ];
  for (const [label, seed] of eligibleShapes)
    it(`PAY-04 can be settled: ${label}; afterwards the sweep sends no payout`, async () => {
      const { refundId } = await seedRefund(seed);

      const response = await settle(opsClient, refundId);

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe("completed");
      expect(await refundRow(refundId)).toMatchObject({
        status: "completed",
        last_payout_error: SETTLED_OUTSIDE_PROVIDER,
        live: false,
        claim_token: null,
      });
      expect(await audits(refundId, SETTLE_ACTION)).toHaveLength(1);

      // legend-980: the settlement itself looked the provider up (not found, so
      // it was allowed), and the sweep watches a settled refund with a provider
      // trace read-only (one lookup, no payout); one without a trace is not asked.
      const lookupsAtSettle = fake.statusCalls.length;
      await ageRefund(refundId);
      await sweep();
      expect(fake.calls).toHaveLength(0);
      expect(fake.statusCalls).toHaveLength(
        lookupsAtSettle + ((seed.attempts ?? 0) > 0 ? 1 : 0),
      );
      expect((await refundRow(refundId)).status).toBe("completed");
    });

  it("PAY-04 the dry-run reset of pre-switch refund payouts lists the row before and nothing after the settlement", async () => {
    const { refundId } = await seedRefund({
      attempts: 8,
      lastError: MANUAL_RECONCILIATION,
    });
    const dryRun = () =>
      runPreswitchReset({
        pool: owner,
        apply: false,
        env: {},
        now: new Date(),
        log: () => undefined,
      });
    expect((await dryRun()).candidates.map((row) => row.id)).toContain(
      refundId,
    );

    expect((await settle(opsClient, refundId)).status).toBe(200);

    expect((await dryRun()).candidates.map((row) => row.id)).not.toContain(
      refundId,
    );
  });

  describe("replay and idempotency", () => {
    it("PAY-04 a replay with the same key and body returns the same view and audits once; a different body on that key is IDEMPOTENCY_KEY_REUSED", async () => {
      const { refundId, intentId } = await seedRefund({
        attempts: 8,
        lastError: MANUAL_RECONCILIATION,
      });
      const body = settlementBody();
      const first = await settle(opsClient, refundId, body);
      expect(first.status).toBe(200);

      const replay = await settle(opsClient, refundId, body);

      expect(replay.status).toBe(200);
      expect(replay.body.data).toEqual(first.body.data);
      expect(await audits(refundId, SETTLE_ACTION)).toHaveLength(1);
      expect(
        await outboxEventCount([refundId, intentId], "payment.refunded"),
      ).toBe(1);

      const reused = await settle(opsClient, refundId, {
        ...body,
        externalReference: "TRX-OTHER-REF",
      });
      expect(reused.status).toBe(409);
      expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    });

    it("PAY-04 a second settlement with a different key answers 409 REFUND_NOT_SETTLEABLE and changes nothing", async () => {
      const { refundId } = await seedRefund({
        attempts: 8,
        lastError: MANUAL_RECONCILIATION,
      });
      const first = await settle(opsClient, refundId);
      expect(first.status).toBe(200);
      const done = await refundRow(refundId);

      const second = await settle(opsClient, refundId, settlementBody());

      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe("REFUND_NOT_SETTLEABLE");
      const after = await refundRow(refundId);
      expect(after.completed_at?.getTime()).toBe(done.completed_at?.getTime());
      expect(await audits(refundId, SETTLE_ACTION)).toHaveLength(1);
    });
  });

  describe("refusals answer 409 and change nothing", () => {
    async function expectUntouched(
      refundId: string,
      before: Awaited<ReturnType<typeof refundRow>>,
      fundId: string | null = null,
    ) {
      expect(await refundRow(refundId)).toEqual(before);
      expect(await audits(refundId, SETTLE_ACTION)).toHaveLength(0);
      expect(await outboxEventCount([refundId], "payment.refunded")).toBe(0);
      if (fundId) {
        const fund = await fundRow(fundId);
        expect(fund.resolved_at).toBeNull();
        expect(fund.resolved_by).toBeNull();
      }
    }

    for (const status of ["pending", "failed", "completed"] as const)
      it(`PAY-04 a ${status} refund is REFUND_NOT_SETTLEABLE`, async () => {
        const { refundId } = await seedRefund({ status });
        const before = await refundRow(refundId);

        const response = await settle(opsClient, refundId);

        expect(response.status).toBe(409);
        expect(response.body.error.code).toBe("REFUND_NOT_SETTLEABLE");
        await expectUntouched(refundId, before);
      });

    it("PAY-04 a refund with a provider reference is REFUND_AT_PROVIDER", async () => {
      const { refundId, fundId } = await seedRefund({
        attempts: 1,
        lastError: "Error",
        providerRef: "PR-HELD-BY-PROVIDER",
        withFund: true,
      });
      const before = await refundRow(refundId);

      const response = await settle(opsClient, refundId);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("REFUND_AT_PROVIDER");
      await expectUntouched(refundId, before, fundId);
    });

    it("PAY-04 a refund the provider was polled about (pending polls > 0) is REFUND_AT_PROVIDER", async () => {
      const { refundId } = await seedRefund({ attempts: 2, polls: 1 });
      const before = await refundRow(refundId);

      const response = await settle(opsClient, refundId);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("REFUND_AT_PROVIDER");
      await expectUntouched(refundId, before);
    });

    it("PAY-04 a refund with a live payout lease is REFUND_PAYOUT_IN_FLIGHT", async () => {
      const { refundId } = await seedRefund({ attempts: 1, leaseMinutes: 5 });
      const before = await refundRow(refundId);
      expect(before.live).toBe(true);

      const response = await settle(opsClient, refundId);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("REFUND_PAYOUT_IN_FLIGHT");
      await expectUntouched(refundId, before);
    });

    it("PAY-04 a refund whose payout lease ended within the last 10 minutes (claim token still set) is REFUND_PAYOUT_IN_FLIGHT", async () => {
      // A worker may still be finishing its provider call.
      for (const leaseMinutes of [-1, -5]) {
        const { refundId } = await seedRefund({ attempts: 1, leaseMinutes });
        const before = await refundRow(refundId);
        expect(before.live).toBe(false);
        expect(before.claim_token).not.toBeNull();

        const response = await settle(opsClient, refundId);

        expect(response.status).toBe(409);
        expect(response.body.error.code).toBe("REFUND_PAYOUT_IN_FLIGHT");
        await expectUntouched(refundId, before);
      }
    });

    it("PAY-04 an amount different from the refund amount is SETTLEMENT_AMOUNT_MISMATCH", async () => {
      const { refundId, fundId } = await seedRefund({
        attempts: 8,
        lastError: MANUAL_RECONCILIATION,
        withFund: true,
      });
      const before = await refundRow(refundId);

      for (const amountIdr of [29_999, 30_001]) {
        const response = await settle(
          opsClient,
          refundId,
          settlementBody({ amountIdr }),
        );
        expect(response.status).toBe(409);
        expect(response.body.error.code).toBe("SETTLEMENT_AMOUNT_MISMATCH");
      }
      await expectUntouched(refundId, before, fundId);
    });
  });

  describe("input that cannot be right answers 422 and changes nothing", () => {
    async function expectRefusedUntouched(
      refundId: string,
      body: Record<string, unknown>,
      code?: string,
    ) {
      const before = await refundRow(refundId);
      const response = await settle(opsClient, refundId, body);
      expect(response.status).toBe(422);
      if (code) expect(response.body.error.code).toBe(code);
      expect(await refundRow(refundId)).toEqual(before);
      expect(await audits(refundId, SETTLE_ACTION)).toHaveLength(0);
    }

    it("PAY-04 paidAt in the future is a VALIDATION_ERROR", async () => {
      const { refundId } = await seedRefund({
        attempts: 8,
        lastError: MANUAL_RECONCILIATION,
      });
      await expectRefusedUntouched(
        refundId,
        settlementBody({ paidAt: minutesFromNow(60) }),
        "VALIDATION_ERROR",
      );
    });

    it("PAY-04 paidAt before the refund was created is a VALIDATION_ERROR", async () => {
      const { refundId } = await seedRefund({
        attempts: 8,
        lastError: MANUAL_RECONCILIATION,
      });
      await expectRefusedUntouched(
        refundId,
        settlementBody({ paidAt: minutesFromNow(-24 * 60) }),
        "VALIDATION_ERROR",
      );
    });

    it("PAY-04 paidAt that is not an ISO date-time is refused", async () => {
      const { refundId } = await seedRefund({
        attempts: 8,
        lastError: MANUAL_RECONCILIATION,
      });
      await expectRefusedUntouched(
        refundId,
        settlementBody({ paidAt: "kemarin sore" }),
      );
    });

    const badBodies: [string, Record<string, unknown>][] = [
      ["an unknown channel", { channel: "barter" }],
      ["a reference under 3 characters", { externalReference: "ab" }],
      [
        "a reference over 100 characters",
        { externalReference: "x".repeat(101) },
      ],
      [
        "a reference with a control character",
        { externalReference: "TRX\n001" },
      ],
      ["a zero amount", { amountIdr: 0 }],
      ["a fractional amount", { amountIdr: 30_000.5 }],
      ["a note under 3 characters", { note: "ok" }],
      ["an unexpected field", { tenantId: randomUUID() }],
    ];
    for (const [label, overrides] of badBodies)
      it(`PAY-04 ${label} is refused`, async () => {
        const { refundId } = await seedRefund({
          attempts: 8,
          lastError: MANUAL_RECONCILIATION,
        });
        await expectRefusedUntouched(refundId, settlementBody(overrides));
      });

    it("PAY-04 a body without a field is refused", async () => {
      const { refundId } = await seedRefund({
        attempts: 8,
        lastError: MANUAL_RECONCILIATION,
      });
      for (const field of [
        "idempotencyKey",
        "paidAt",
        "channel",
        "externalReference",
        "amountIdr",
        "note",
      ]) {
        const body: Record<string, unknown> = settlementBody();
        delete body[field];
        await expectRefusedUntouched(refundId, body);
      }
    });
  });

  describe("who may settle", () => {
    async function expectUntouched(refundId: string) {
      expect(await refundRow(refundId)).toMatchObject({
        status: "approved",
        last_payout_error: MANUAL_RECONCILIATION,
      });
      expect(await audits(refundId, SETTLE_ACTION)).toHaveLength(0);
    }

    it("PAY-04 an anonymous caller gets 401", async () => {
      const { refundId } = await seedRefund({
        attempts: 8,
        lastError: MANUAL_RECONCILIATION,
      });
      const response = await agent(app)
        .set("Host", scope.hostname)
        .post(`${ADMIN}/refunds/${refundId}/settle-manually`)
        .set(originHeader)
        .send(settlementBody());
      expect(response.status).toBe(401);
      await expectUntouched(refundId);
    });

    it("PAY-04 an actor without pos.refund.approve is refused with PERMISSION_DENIED", async () => {
      const { refundId } = await seedRefund({
        attempts: 8,
        lastError: MANUAL_RECONCILIATION,
      });
      const response = await settle(financeOnly, refundId);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("PERMISSION_DENIED");
      await expectUntouched(refundId);
    });

    it("PAY-04 the requester of the refund is refused with APPROVER_IS_REQUESTER", async () => {
      const { refundId } = await seedRefund({
        attempts: 8,
        lastError: MANUAL_RECONCILIATION,
        requestedBy: financeSupId,
      });
      const response = await settle(financeSup, refundId);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("APPROVER_IS_REQUESTER");
      await expectUntouched(refundId);
    });

    it("PAY-04 an actor whose dashboard MFA was not verified this session is refused with MFA_REQUIRED", async () => {
      const { refundId } = await seedRefund({
        attempts: 8,
        lastError: MANUAL_RECONCILIATION,
      });
      const response = await settle(noMfa, refundId);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("MFA_REQUIRED");
      await expectUntouched(refundId);
    });

    it("PAY-04 a finance user who also holds supervisor authority and passed MFA may settle", async () => {
      const { refundId } = await seedRefund({
        attempts: 8,
        lastError: MANUAL_RECONCILIATION,
      });
      const response = await settle(financeSup, refundId);
      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe("completed");
    });

    it("PAY-04 a refund that does not exist answers 404", async () => {
      // 403 or 404, like the quarantine actions on a refund of another tenant.
      const response = await settle(opsClient, randomUUID());
      expect([403, 404]).toContain(response.status);
    });
  });

  describe("a payout worker that is still running", () => {
    it("PAY-04 a worker whose lease ran out finishes after the settlement: its provider answer is recorded as a conflict and the refund stays completed", async () => {
      const { refundId, intentId } = await seedRefund({
        approver: financeSupId,
        attempts: 0,
      });
      let release!: () => void;
      fake.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const worker = runRefundPayout(tenantWide, refundId).catch(
        () => undefined,
      );
      await waitUntil(() => callsOf(refundId).length === 1);
      // The worker is stuck inside the provider call and its lease ended long
      // ago (a lease that ended within 10 minutes still blocks the settlement).
      await expireLeaseLongAgo(refundId);

      const response = await settle(opsClient, refundId);
      expect(response.status).toBe(200);
      const settled = await refundRow(refundId);
      expect(settled).toMatchObject({
        status: "completed",
        last_payout_error: SETTLED_OUTSIDE_PROVIDER,
      });

      release();
      await worker;

      const after = await refundRow(refundId);
      expect(after.status).toBe("completed");
      expect(after.completed_at?.getTime()).toBe(
        settled.completed_at?.getTime(),
      );
      expect(callsOf(refundId)).toHaveLength(1);
      expect(
        (await audits(refundId, CONFLICT_ACTION)).length,
      ).toBeGreaterThanOrEqual(1);
      expect(await audits(refundId, SETTLE_ACTION)).toHaveLength(1);
      // The bill counts the refund once.
      expect(await intentStatus(intentId)).toBe("partially_refunded");
    });

    it("PAY-04 a worker whose status lookup answers pending after the settlement: recorded as a conflict, the refund stays completed", async () => {
      // A maybe-sent refund: the worker looks it up before anything else.
      const { refundId, intentId } = await seedRefund({
        approver: financeSupId,
        attempts: 1,
        lastError: "Error",
      });
      let release!: () => void;
      fake.lookupGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const worker = runRefundPayout(tenantWide, refundId).catch(
        () => undefined,
      );
      await waitUntil(() => lookupsOf(refundId).length === 1);
      await expireLeaseLongAgo(refundId);

      const response = await settle(opsClient, refundId);
      expect(response.status).toBe(200);
      const settled = await refundRow(refundId);

      // The settlement's own lookup (legend-980) saw the provider not know the
      // refund, which is what allowed it. Only now does the provider answer the
      // held worker lookup: pending, after the settlement.
      fake.setStatus(`refund:${refundId}`, {
        status: "pending",
        providerRef: "PR-LATE-PENDING",
      });
      release();
      await worker;

      const after = await refundRow(refundId);
      expect(after.status).toBe("completed");
      expect(after.completed_at?.getTime()).toBe(
        settled.completed_at?.getTime(),
      );
      expect(callsOf(refundId)).toHaveLength(0);
      expect(
        (await audits(refundId, CONFLICT_ACTION)).length,
      ).toBeGreaterThanOrEqual(1);
      expect(await audits(refundId, SETTLE_ACTION)).toHaveLength(1);
      expect(await intentStatus(intentId)).toBe("partially_refunded");
    });
  });
});

// ---------------------------------------------------------------------------
// A. Tripwire: a refund that may have been sent is never POSTed again
// ---------------------------------------------------------------------------

describe("legend-xd2q PAY-04 a maybe-sent refund is never sent again", () => {
  /** Approved by a finance + supervisor user, so only the lookup path is exercised. */
  const maybeSent = (seed: RefundSeed = {}) =>
    seedRefund({
      approver: financeSupId,
      attempts: 1,
      lastError: "Error",
      ...seed,
    });

  it("PAY-04 a not_found answer on a maybe-sent refund sends nothing, flags it PAYOUT_NOT_FOUND_MAYBE_SENT and audits once, also on the next sweep", async () => {
    const { refundId } = await maybeSent();

    await sweep();

    expect(callsOf(refundId)).toHaveLength(0);
    expect(lookupsOf(refundId)).toHaveLength(1);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      payout_attempts: 2,
      last_payout_error: PAYOUT_NOT_FOUND_MAYBE_SENT,
      live: false,
      claim_token: null,
    });
    expect(await audits(refundId, NOT_FOUND_ACTION)).toHaveLength(1);

    await ageRefund(refundId);
    await sweep();

    expect(callsOf(refundId)).toHaveLength(0);
    expect(lookupsOf(refundId)).toHaveLength(2);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      last_payout_error: PAYOUT_NOT_FOUND_MAYBE_SENT,
    });
    expect(await audits(refundId, NOT_FOUND_ACTION)).toHaveLength(1);
  });

  it("PAY-04 a refund whose first send timed out is looked up, never sent a second time", async () => {
    const { refundId } = await seedRefund({
      approver: financeSupId,
      attempts: 0,
    });
    fake.enqueue("throw");

    await sweep();
    expect(callsOf(refundId)).toHaveLength(1);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      payout_attempts: 1,
    });

    await ageRefund(refundId);
    await sweep();

    expect(callsOf(refundId)).toHaveLength(1);
    expect(lookupsOf(refundId)).toHaveLength(1);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      last_payout_error: PAYOUT_NOT_FOUND_MAYBE_SENT,
    });
    expect(fake.executionCount).toBe(0);
  });

  it("PAY-04 a refund that already has a provider reference or pending polls is never sent either", async () => {
    const withRef = await maybeSent({ providerRef: "PR-KNOWN" });
    const withPolls = await maybeSent({ polls: 2 });

    await sweep();

    for (const { refundId } of [withRef, withPolls]) {
      expect(callsOf(refundId)).toHaveLength(0);
      expect(await refundRow(refundId)).toMatchObject({
        status: "approved",
        last_payout_error: PAYOUT_NOT_FOUND_MAYBE_SENT,
      });
    }
  });

  it("PAY-04 the flag is kept when a later lookup fails", async () => {
    const { refundId } = await maybeSent();
    await sweep();
    expect((await refundRow(refundId)).last_payout_error).toBe(
      PAYOUT_NOT_FOUND_MAYBE_SENT,
    );

    fake.lookupFails = true;
    await ageRefund(refundId);
    await sweep();

    expect(lookupsOf(refundId)).toHaveLength(2);
    expect(callsOf(refundId)).toHaveLength(0);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      payout_attempts: 3,
      last_payout_error: PAYOUT_NOT_FOUND_MAYBE_SENT,
    });
    expect(await audits(refundId, NOT_FOUND_ACTION)).toHaveLength(1);
  });

  it("PAY-04 the quarantine flag of a maybe-sent refund is kept when a lookup fails", async () => {
    // Finance-only approver: the approval re-validation quarantines it.
    const { refundId } = await seedRefund({
      approver: financeAId,
      attempts: 1,
      lastError: "Error",
    });
    fake.lookupFails = true;

    await sweep();
    await ageRefund(refundId);
    await sweep();

    expect(callsOf(refundId)).toHaveLength(0);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      last_payout_error: PAYOUT_QUARANTINED,
    });
  });

  it("PAY-04 a later pending answer clears the flag and keeps the provider reference", async () => {
    const { refundId } = await maybeSent();
    await sweep();
    expect((await refundRow(refundId)).last_payout_error).toBe(
      PAYOUT_NOT_FOUND_MAYBE_SENT,
    );

    fake.setStatus(`refund:${refundId}`, {
      status: "pending",
      providerRef: "PR-LATER-PENDING",
    });
    await ageRefund(refundId);
    await sweep();

    expect(callsOf(refundId)).toHaveLength(0);
    const row = await refundRow(refundId);
    expect(row).toMatchObject({
      status: "approved",
      provider_ref: "PR-LATER-PENDING",
    });
    expect(row.last_payout_error).not.toBe(PAYOUT_NOT_FOUND_MAYBE_SENT);
  });

  it("PAY-04 a later succeeded answer completes it without a send", async () => {
    const { refundId, intentId } = await maybeSent();
    await sweep();

    fake.setStatus(`refund:${refundId}`, {
      status: "succeeded",
      providerRef: "PR-LATER-OK",
    });
    await ageRefund(refundId);
    await sweep();

    expect(callsOf(refundId)).toHaveLength(0);
    expect(await refundRow(refundId)).toMatchObject({
      status: "completed",
      provider_ref: "PR-LATER-OK",
    });
    expect(await intentStatus(intentId)).toBe("partially_refunded");
  });

  it("PAY-04 the flag survives the 8th attempt and the exhausted update: it never becomes MANUAL_RECONCILIATION", async () => {
    const { refundId } = await maybeSent({
      attempts: 7,
      lastError: PAYOUT_NOT_FOUND_MAYBE_SENT,
    });

    await sweep();
    expect(await refundRow(refundId)).toMatchObject({
      payout_attempts: 8,
      last_payout_error: PAYOUT_NOT_FOUND_MAYBE_SENT,
    });

    await ageRefund(refundId);
    await sweep();
    await ageRefund(refundId);
    await sweep();

    expect(callsOf(refundId)).toHaveLength(0);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      payout_attempts: 8,
      last_payout_error: PAYOUT_NOT_FOUND_MAYBE_SENT,
    });
  });

  it("PAY-04 a refund spent without the flag still ends MANUAL_RECONCILIATION", async () => {
    const { refundId } = await maybeSent({ attempts: 8 });

    await sweep();

    expect(callsOf(refundId)).toHaveLength(0);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      payout_attempts: 8,
      last_payout_error: MANUAL_RECONCILIATION,
    });
  });

  it("PAY-04 retry on a flagged refund runs the lookup only, never a send", async () => {
    const { refundId } = await maybeSent();
    await sweep();
    expect(lookupsOf(refundId)).toHaveLength(1);

    const response = await retryWith(financeSup, refundId);

    expect([200, 409]).toContain(response.status);
    expect(callsOf(refundId)).toHaveLength(0);
    expect(lookupsOf(refundId)).toHaveLength(2);
    expect(await refundRow(refundId)).toMatchObject({
      status: "approved",
      last_payout_error: PAYOUT_NOT_FOUND_MAYBE_SENT,
    });
  });

  it("PAY-04 once finance paid a flagged refund by hand, ops close it with settle-manually and nothing is sent", async () => {
    const { refundId, intentId } = await maybeSent();
    await sweep();
    expect((await refundRow(refundId)).last_payout_error).toBe(
      PAYOUT_NOT_FOUND_MAYBE_SENT,
    );

    const response = await settle(opsClient, refundId);

    expect(response.status).toBe(200);
    expect(await refundRow(refundId)).toMatchObject({
      status: "completed",
      last_payout_error: SETTLED_OUTSIDE_PROVIDER,
    });
    expect(await intentStatus(intentId)).toBe("partially_refunded");
    await ageRefund(refundId);
    await sweep();
    expect(callsOf(refundId)).toHaveLength(0);
  });

  it("PAY-04 a fresh refund (no attempt, no poll, no provider reference) is still sent exactly once, without a lookup", async () => {
    const { refundId, intentId } = await seedRefund({
      approver: financeSupId,
      attempts: 0,
    });

    await sweep();
    await sweep();

    expect(callsOf(refundId)).toHaveLength(1);
    expect(lookupsOf(refundId)).toHaveLength(0);
    expect(fake.executionCount).toBe(1);
    expect(await refundRow(refundId)).toMatchObject({
      status: "completed",
      payout_attempts: 1,
      last_payout_error: null,
    });
    expect(await intentStatus(intentId)).toBe("partially_refunded");
  });
});
