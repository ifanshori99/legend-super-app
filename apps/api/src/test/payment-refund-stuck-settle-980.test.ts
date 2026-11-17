// legend-17ml (batch 980, refund sisa): finance may settle by hand a refund that is
// stuck at the provider (the provider holds a reference or was polled) once the
// refund is flagged MANUAL_RECONCILIATION or PAYOUT_NOT_FOUND_MAYBE_SENT. Written
// from the card text and the existing settle contract (payment-refund-manual-settle
// .test.ts), not from the service code; they must fail until the guard is relaxed.
// Real Express app, Better Auth, services and PostgreSQL; only the refund
// provider is the fake gateway.
//
// "Jangan sampai rugi" proof 3: a stuck refund closed by hand is never paid again
// by the poller, the retry, the webhook or the sweep, and the books get exactly
// one `payment.refunded` event.
//
// Assumptions where the card is not exact:
// - Only the two flags above lift the "provider holds it" refusal. A refund with
//   a provider reference and any other error (or none) is still
//   REFUND_AT_PROVIDER (doubt: the rule that limits payment).
// - The provider reference is KEPT on the row after the settlement (so a late
//   webhook that names the provider reference still finds the refund and is
//   recorded as a conflict instead of "unknown reference").
// - Settle answers 200; same key and body replays 200; a second settle with a new
//   key is 409 REFUND_NOT_SETTLEABLE (as in the existing settle tests).
// - A late provider "succeeded" after the settlement is recorded as a conflict
//   audit (payment.refund_provider_conflict) and writes nothing else; a late
//   "failed" writes nothing. Whether the service throws or resolves is not
//   asserted; only the stored state is.
// - The retry endpoint on a completed refund answers a client error or 200 (no
//   payout); only "not 5xx", the stored state and the gateway calls are asserted.
// - The bill ends partially_refunded (Rp30.000 of a Rp100.000 bill), and the
//   refund counts once in the sum of completed refunds.
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
  ALLOW_MANUAL_SETTLE_WHILE_PROVIDER_PENDING,
  applyRefundProviderUpdate,
  runRefundPayout,
  sweepApprovedRefundPayouts,
  type RefundProviderUpdate,
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
const MANUAL_RECONCILIATION = "MANUAL_RECONCILIATION";
const SETTLE_ACTION = "payment.refund_settled_manually";
const CONFLICT_ACTION = "payment.refund_provider_conflict";

type Client = ReturnType<typeof agent>;
let requesterId: string; // owner: files every seeded refund, never settles
let opsClient: Client; // owner B: settles
let opsId: string;
let financeAId: string; // legacy approver without supervisor authority

const userIds: string[] = [];
const linkIds: string[] = [];
const intentIds: string[] = [];
const refundIds: string[] = [];
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

async function signedIn(templateKey: "owner" | "finance", label: string) {
  const client = agent(app).set("Host", scope.hostname);
  const email = await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId: string = session.body.user.id;
  userIds.push(userId);
  await verifySessionMfa(email);
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
    [tenantId, userId, await roleIdOf(templateKey)],
  );
  return { client, userId };
}

beforeAll(async () => {
  await scope.seed(owner);
  ({ userId: requesterId } = await signedIn("owner", "Stuck requester"));
  ({ client: opsClient, userId: opsId } = await signedIn("owner", "Stuck ops"));
  ({ userId: financeAId } = await signedIn("finance", "Stuck finance A"));
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
  fake = new FakeRefundGateway();
  setPaymentRefundGateway(fake);
});
afterEach(() => {
  setPaymentRefundGateway(null);
});

// ---------------------------------------------------------------------------
// Fixtures (same shape as payment-refund-manual-settle.test.ts)
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
      `STK-${linkId.slice(0, 8)}`,
      amountIdr,
      requesterId,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
    [intentId, tenantId, outletA, linkId, amountIdr, `stk-${intentId}`],
  );
  await owner.query(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [tenantId, outletA, intentId, `evidence-${intentId}`, amountIdr],
  );
  return intentId;
}

type RefundSeed = {
  attempts?: number;
  lastError?: string | null;
  providerRef?: string | null;
  polls?: number;
  /** Minutes the payout lease stays live (null: no lease). */
  leaseMinutes?: number | null;
};

/**
 * An approved refund of Rp30.000 of a Rp100.000 bill, written straight into the
 * table, approved by a finance-only approver (the approval defect is recorded,
 * not blocking), updated two hours ago so any backoff has elapsed.
 */
async function seedRefund(seed: RefundSeed = {}) {
  const intentId = await seedPaid(100_000);
  const refundId = randomUUID();
  refundIds.push(refundId);
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
                                  requested_by, approved_by, decided_at, provider_ref, payout_pending_polls,
                                  payout_attempts, last_payout_error, payout_claimed_until, payout_claim_token,
                                  created_at, updated_at)
     VALUES ($1, $2, $3, $4, 30000, 'Pengembalian uji', 'approved', $5, $6, now(), $7, $8, $9, $10,
             CASE WHEN $11::int IS NULL THEN NULL ELSE now() + make_interval(mins => $11::int) END,
             CASE WHEN $11::int IS NULL THEN NULL ELSE $12::uuid END,
             $13, now() - interval '2 hours')`,
    [
      refundId,
      tenantId,
      outletA,
      intentId,
      requesterId,
      financeAId,
      seed.providerRef ?? null,
      seed.polls ?? 0,
      seed.attempts ?? 0,
      seed.lastError ?? null,
      seed.leaseMinutes ?? null,
      randomUUID(),
      new Date(Date.now() - 3 * 3_600_000),
    ],
  );
  return { refundId, intentId };
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

/** Completed refunds of the bill: how many rows and how much money. */
async function completedRefunds(intentId: string) {
  const { rows } = await owner.query<{ n: number; total: number }>(
    `SELECT count(*)::int AS n, COALESCE(sum(amount_idr), 0)::int AS total
     FROM payment_refunds
     WHERE tenant_id = $1 AND payment_intent_id = $2 AND status = 'completed'`,
    [tenantId, intentId],
  );
  return rows[0]!;
}

async function audits(refundId: string, action: string) {
  const { rows } = await owner.query<{ actor: string | null }>(
    `SELECT event->>'actorId' AS actor
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

const ageRefund = (id: string, interval = "2 hours") =>
  owner.query(
    "UPDATE payment_refunds SET updated_at = now() - $3::interval WHERE tenant_id = $1 AND id = $2",
    [tenantId, id, interval],
  );

const sweep = () => sweepApprovedRefundPayouts(tenantWide, new Date(), 100);

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

/** A provider webhook or poll result; the error (if any) is returned, not thrown. */
const providerUpdate = (update: RefundProviderUpdate) =>
  applyRefundProviderUpdate(tenantWide, update).then(
    () => null,
    (error: unknown) => error,
  );

const stuckProviderRef = () => `PR-STUCK-${randomUUID()}`;

/** The two flags that allow settling, and the "provider holds it" shapes to settle. */
const flags: [string, string][] = [
  ["MANUAL_RECONCILIATION", MANUAL_RECONCILIATION],
  ["PAYOUT_NOT_FOUND_MAYBE_SENT", PAYOUT_NOT_FOUND_MAYBE_SENT],
];
const stuckShapes: [string, () => RefundSeed][] = [
  ["a provider reference", () => ({ providerRef: stuckProviderRef() })],
  ["pending polls", () => ({ polls: 3 })],
  [
    "a provider reference and pending polls",
    () => ({ providerRef: stuckProviderRef(), polls: 3 }),
  ],
];

// ---------------------------------------------------------------------------
// Settle a refund that is stuck at the provider
// ---------------------------------------------------------------------------

describe("legend-17ml PAY-04 settling a refund stuck at the provider", () => {
  for (const [flagName, flag] of flags)
    for (const [shapeName, shape] of stuckShapes)
      it(`PAY-04 ${flagName} with ${shapeName} can be settled by hand: completed, audited once, one payment.refunded, no provider call`, async () => {
        const seed = shape();
        const { refundId, intentId } = await seedRefund({
          attempts: 8,
          lastError: flag,
          ...seed,
        });

        const response = await settle(opsClient, refundId);

        expect(response.status).toBe(200);
        expect(response.body.data).toMatchObject({
          id: refundId,
          status: "completed",
          lastPayoutError: SETTLED_OUTSIDE_PROVIDER,
        });
        const row = await refundRow(refundId);
        expect(row).toMatchObject({
          status: "completed",
          last_payout_error: SETTLED_OUTSIDE_PROVIDER,
          live: false,
          claim_token: null,
          // The provider reference is kept: a late webhook by provider
          // reference must still find this refund.
          provider_ref: seed.providerRef ?? null,
        });
        expect(row.completed_at).not.toBeNull();
        expect(await intentStatus(intentId)).toBe("partially_refunded");
        expect(await completedRefunds(intentId)).toEqual({
          n: 1,
          total: 30_000,
        });
        const rows = await audits(refundId, SETTLE_ACTION);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.actor).toBe(opsId);
        expect(
          await outboxEventCount([refundId, intentId], "payment.refunded"),
        ).toBe(1);
        expect(fake.calls).toHaveLength(0);
        // legend-980: the provider was asked once (read-only) before settling.
        expect(fake.statusCalls).toHaveLength(1);
        expect(fake.statusCalls[0]?.idempotencyKey).toBe(`refund:${refundId}`);
        expect(fake.statusCalls[0]?.providerRef).toBe(seed.providerRef ?? null);
      });

  it("PAY-04 the provider reference stays on the settled row (not wiped to null) for both flags", async () => {
    for (const [, flag] of flags) {
      const providerRef = stuckProviderRef();
      const { refundId } = await seedRefund({
        attempts: 8,
        lastError: flag,
        providerRef,
        polls: 2,
      });

      expect((await settle(opsClient, refundId)).status).toBe(200);

      expect((await refundRow(refundId)).provider_ref).toBe(providerRef);
    }
  });

  describe("refusals that stay", () => {
    it("PAY-04 a refund with a provider reference and any other error is still REFUND_AT_PROVIDER and changes nothing", async () => {
      for (const lastError of ["Error", "SERVICE_UNAVAILABLE", null]) {
        const { refundId, intentId } = await seedRefund({
          attempts: 1,
          lastError,
          providerRef: stuckProviderRef(),
        });
        const before = await refundRow(refundId);

        const response = await settle(opsClient, refundId);

        expect(response.status).toBe(409);
        expect(response.body.error.code).toBe("REFUND_AT_PROVIDER");
        expect(await refundRow(refundId)).toEqual(before);
        expect(await audits(refundId, SETTLE_ACTION)).toHaveLength(0);
        expect(
          await outboxEventCount([refundId, intentId], "payment.refunded"),
        ).toBe(0);
      }
    });

    for (const [flagName, flag] of flags)
      it(`PAY-04 ${flagName} with a provider reference and a live or just-ended payout lease is still REFUND_PAYOUT_IN_FLIGHT and changes nothing`, async () => {
        // A worker may still be finishing its provider call.
        for (const leaseMinutes of [5, -1, -5]) {
          const { refundId, intentId } = await seedRefund({
            attempts: 8,
            lastError: flag,
            providerRef: stuckProviderRef(),
            polls: 1,
            leaseMinutes,
          });
          const before = await refundRow(refundId);
          expect(before.claim_token).not.toBeNull();

          const response = await settle(opsClient, refundId);

          expect(response.status).toBe(409);
          expect(response.body.error.code).toBe("REFUND_PAYOUT_IN_FLIGHT");
          expect(await refundRow(refundId)).toEqual(before);
          expect(await audits(refundId, SETTLE_ACTION)).toHaveLength(0);
          expect(
            await outboxEventCount([refundId, intentId], "payment.refunded"),
          ).toBe(0);
        }
      });

    it("PAY-04 an amount different from the refund amount is still SETTLEMENT_AMOUNT_MISMATCH for a stuck refund", async () => {
      const { refundId } = await seedRefund({
        attempts: 8,
        lastError: MANUAL_RECONCILIATION,
        providerRef: stuckProviderRef(),
      });
      const before = await refundRow(refundId);

      const response = await settle(
        opsClient,
        refundId,
        settlementBody({ amountIdr: 30_001 }),
      );

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("SETTLEMENT_AMOUNT_MISMATCH");
      expect(await refundRow(refundId)).toEqual(before);
    });
  });

  describe("second settlement", () => {
    for (const [flagName, flag] of flags)
      it(`PAY-04 ${flagName}: a replay returns the same view; a new key is REFUND_NOT_SETTLEABLE; one audit, one payment.refunded, reference kept`, async () => {
        const providerRef = stuckProviderRef();
        const { refundId, intentId } = await seedRefund({
          attempts: 8,
          lastError: flag,
          providerRef,
          polls: 2,
        });
        const body = settlementBody();
        const first = await settle(opsClient, refundId, body);
        expect(first.status).toBe(200);
        const done = await refundRow(refundId);

        const replay = await settle(opsClient, refundId, body);
        expect(replay.status).toBe(200);
        expect(replay.body.data).toEqual(first.body.data);

        const second = await settle(opsClient, refundId, settlementBody());
        expect(second.status).toBe(409);
        expect(second.body.error.code).toBe("REFUND_NOT_SETTLEABLE");

        const after = await refundRow(refundId);
        expect(after.completed_at?.getTime()).toBe(
          done.completed_at?.getTime(),
        );
        expect(after.provider_ref).toBe(providerRef);
        expect(await audits(refundId, SETTLE_ACTION)).toHaveLength(1);
        expect(
          await outboxEventCount([refundId, intentId], "payment.refunded"),
        ).toBe(1);
        expect(await completedRefunds(intentId)).toEqual({
          n: 1,
          total: 30_000,
        });
      });
  });
});

// ---------------------------------------------------------------------------
// Proof 3: a stuck refund closed by hand is never paid again
// ---------------------------------------------------------------------------

describe("legend-17ml PAY-04 proof 3: a stuck refund settled by hand is never paid again", () => {
  /** A stuck refund, settled by hand; returns its ids and the kept provider reference. */
  async function settledStuck(flag: string) {
    const providerRef = stuckProviderRef();
    const { refundId, intentId } = await seedRefund({
      attempts: 8,
      lastError: flag,
      providerRef,
      polls: 2,
    });
    expect((await settle(opsClient, refundId)).status).toBe(200);
    const done = await refundRow(refundId);
    expect(done.status).toBe("completed");
    // The settlement itself looked the provider up once (legend-980).
    expect(statusCallsFor(refundId)).toHaveLength(1);
    return { refundId, intentId, providerRef, done };
  }

  /** Provider status lookups made for one refund (the sweep is tenant-wide). */
  const statusCallsFor = (refundId: string) =>
    fake.statusCalls.filter((c) => c.idempotencyKey === `refund:${refundId}`);

  async function expectPaidOnce(
    refundId: string,
    intentId: string,
    done: Awaited<ReturnType<typeof refundRow>>,
  ) {
    const after = await refundRow(refundId);
    expect(after.status).toBe("completed");
    expect(after.completed_at?.getTime()).toBe(done.completed_at?.getTime());
    expect(after.last_payout_error).toBe(SETTLED_OUTSIDE_PROVIDER);
    expect(await intentStatus(intentId)).toBe("partially_refunded");
    expect(await completedRefunds(intentId)).toEqual({ n: 1, total: 30_000 });
    expect(await audits(refundId, SETTLE_ACTION)).toHaveLength(1);
    expect(
      await outboxEventCount([refundId, intentId], "payment.refunded"),
    ).toBe(1);
    expect(fake.calls).toHaveLength(0);
  }

  for (const [flagName, flag] of flags) {
    it(`PAY-04 ${flagName}: the sweep (also aged, also repeated) only looks a settled refund up, never sends it`, async () => {
      const { refundId, intentId, done } = await settledStuck(flag);

      for (let round = 0; round < 3; round++) {
        await ageRefund(refundId);
        await sweep();
      }

      // legend-980: the follow-up asks the provider once per aged round (the
      // settlement's own lookup came first) and writes no conflict while the
      // provider has no payout; nothing is ever sent.
      expect(statusCallsFor(refundId)).toHaveLength(1 + 3);
      expect(await audits(refundId, CONFLICT_ACTION)).toHaveLength(0);
      await expectPaidOnce(refundId, intentId, done);
    });

    it(`PAY-04 ${flagName}: a direct payout run (worker or poller) never sends a settled refund`, async () => {
      const { refundId, intentId, done } = await settledStuck(flag);
      await ageRefund(refundId);

      await runRefundPayout(tenantWide, refundId).catch(() => undefined);
      await runRefundPayout(tenantWide, refundId).catch(() => undefined);

      await expectPaidOnce(refundId, intentId, done);
    });

    it(`PAY-04 ${flagName}: the retry endpoint on a settled refund pays nothing`, async () => {
      const { refundId, intentId, done } = await settledStuck(flag);
      await ageRefund(refundId);

      const response = await retryWith(opsClient, refundId);

      expect(response.status).toBeLessThan(500);
      await expectPaidOnce(refundId, intentId, done);
    });

    it(`PAY-04 ${flagName}: a late provider success by provider reference is a recorded conflict, not a second payment`, async () => {
      const { refundId, intentId, providerRef, done } =
        await settledStuck(flag);
      expect(await audits(refundId, CONFLICT_ACTION)).toHaveLength(0);

      await providerUpdate({
        providerRef,
        status: "succeeded",
        amountIdr: 30_000,
      });

      // Finance is told the provider also says "paid" (the refund went out twice
      // in the real world), instead of "unknown reference".
      expect(
        (await audits(refundId, CONFLICT_ACTION)).length,
      ).toBeGreaterThanOrEqual(1);
      await expectPaidOnce(refundId, intentId, done);
    });

    it(`PAY-04 ${flagName}: a late provider success by refund key (poll) is a recorded conflict, not a second payment`, async () => {
      const { refundId, intentId, done } = await settledStuck(flag);

      await providerUpdate({
        idempotencyKey: `refund:${refundId}`,
        status: "succeeded",
        amountIdr: 30_000,
      });

      expect(
        (await audits(refundId, CONFLICT_ACTION)).length,
      ).toBeGreaterThanOrEqual(1);
      await expectPaidOnce(refundId, intentId, done);
    });

    it(`PAY-04 ${flagName}: a late provider failure writes nothing and the refund stays completed`, async () => {
      const { refundId, intentId, providerRef, done } =
        await settledStuck(flag);

      await providerUpdate({
        providerRef,
        status: "failed",
        code: "late_decline",
      });
      await providerUpdate({
        idempotencyKey: `refund:${refundId}`,
        status: "failed",
        code: "late_decline",
      });

      await expectPaidOnce(refundId, intentId, done);
    });
  }

  it("PAY-04 every channel in a row (sweep, payout run, retry, webhook, poll, replayed settle): the books get one payment.refunded and the provider is never asked to pay", async () => {
    const { refundId, intentId, providerRef, done } = await settledStuck(
      MANUAL_RECONCILIATION,
    );

    await ageRefund(refundId);
    await sweep();
    await runRefundPayout(tenantWide, refundId).catch(() => undefined);
    expect((await retryWith(opsClient, refundId)).status).toBeLessThan(500);
    await providerUpdate({
      providerRef,
      status: "succeeded",
      amountIdr: 30_000,
    });
    await providerUpdate({
      idempotencyKey: `refund:${refundId}`,
      status: "succeeded",
      amountIdr: 30_000,
    });
    await ageRefund(refundId);
    await sweep();

    expect(fake.executionCount).toBe(0);
    // The settlement's lookup, then one follow-up lookup (the first sweep); the
    // webhook conflict then stops the follow-up.
    expect(statusCallsFor(refundId)).toHaveLength(2);
    await expectPaidOnce(refundId, intentId, done);
  });
});

// ---------------------------------------------------------------------------
// legend-980 High 2: settle looks the provider up first (restrictive policy)
// ---------------------------------------------------------------------------

describe("legend-980 settle-manually asks the provider first", () => {
  const lookupFor = (refundId: string) => `refund:${refundId}`;

  /** A stuck refund with a provider reference, flagged `flag`. */
  const seedStuck = (flag: string) =>
    seedRefund({
      attempts: 8,
      lastError: flag,
      providerRef: stuckProviderRef(),
      polls: 1,
    });

  /** The settle was refused: nothing moved, nothing was paid or booked. */
  async function expectUntouched(
    refundId: string,
    intentId: string,
    before: Awaited<ReturnType<typeof refundRow>>,
  ) {
    expect(await refundRow(refundId)).toEqual(before);
    expect(await audits(refundId, SETTLE_ACTION)).toHaveLength(0);
    expect(
      await outboxEventCount([refundId, intentId], "payment.refunded"),
    ).toBe(0);
    expect(await completedRefunds(intentId)).toEqual({ n: 0, total: 0 });
    expect(fake.calls).toHaveLength(0);
  }

  for (const [flagName, flag] of flags) {
    it(`${flagName}: a provider that already paid refuses the settlement (REFUND_PROVIDER_PAID) and changes nothing`, async () => {
      const { refundId, intentId } = await seedStuck(flag);
      fake.setStatus(lookupFor(refundId), {
        status: "succeeded",
        providerRef: "PR-PAID-BY-PROVIDER",
      });
      const before = await refundRow(refundId);

      const response = await settle(opsClient, refundId);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("REFUND_PROVIDER_PAID");
      await expectUntouched(refundId, intentId, before);
    });

    it(`${flagName}: a provider that declined or does not know the refund allows the settlement`, async () => {
      const declined = await seedStuck(flag);
      fake.setStatus(lookupFor(declined.refundId), {
        status: "failed",
        providerRef: "PR-DECLINED",
        code: "declined",
      });
      const unknown = await seedStuck(flag);
      // No stored result: the fake answers not_found.

      expect((await settle(opsClient, declined.refundId)).status).toBe(200);
      expect((await settle(opsClient, unknown.refundId)).status).toBe(200);

      expect((await refundRow(declined.refundId)).status).toBe("completed");
      expect((await refundRow(unknown.refundId)).status).toBe("completed");
      expect(fake.calls).toHaveLength(0);
    });

    it(`${flagName}: a provider that cannot be reached refuses the settlement (REFUND_PROVIDER_LOOKUP_FAILED) and changes nothing`, async () => {
      const { refundId, intentId } = await seedStuck(flag);
      fake.statusError = new Error("fake provider unreachable");
      const before = await refundRow(refundId);

      const response = await settle(opsClient, refundId);

      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe("REFUND_PROVIDER_LOOKUP_FAILED");
      await expectUntouched(refundId, intentId, before);

      // The same request goes through once the provider answers again.
      fake.statusError = null;
      expect((await settle(opsClient, refundId)).status).toBe(200);
    });
  }

  // legend-980 M4 (founder decision legend-17ml, default false): a provider
  // that still holds the payout refuses the settlement for BOTH stuck flags.
  it("the restrictive default: manual settle while the provider is pending is not allowed", () => {
    expect(ALLOW_MANUAL_SETTLE_WHILE_PROVIDER_PENDING).toBe(false);
  });

  for (const [flagName, flag] of flags)
    it(`${flagName}: a pending provider payout refuses the settlement (REFUND_PROVIDER_PENDING) and changes nothing`, async () => {
      const { refundId, intentId } = await seedStuck(flag);
      fake.setStatus(lookupFor(refundId), {
        status: "pending",
        providerRef: "PR-STILL-PENDING",
      });
      const before = await refundRow(refundId);

      const refused = await settle(opsClient, refundId);

      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe("REFUND_PROVIDER_PENDING");
      await expectUntouched(refundId, intentId, before);
    });

  // legend-980 M3: the answer is only good for the row it was asked about.
  const staleChanges: [string, string][] = [
    ["a poll was counted", "payout_pending_polls = payout_pending_polls + 1"],
    ["an attempt was counted", "payout_attempts = payout_attempts + 1"],
    ["only updated_at moved", "updated_at = now()"],
  ];
  for (const [changeName, assignment] of staleChanges)
    it(`the row changed while the provider was asked (${changeName}): refused as REFUND_LOOKUP_STALE, settles on retry`, async () => {
      const { refundId, intentId } = await seedStuck(MANUAL_RECONCILIATION);
      fake.onStatus = async () => {
        fake.onStatus = null;
        await owner.query(
          `UPDATE payment_refunds SET ${assignment} WHERE tenant_id = $1 AND id = $2`,
          [tenantId, refundId],
        );
      };

      const refused = await settle(opsClient, refundId);

      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe("REFUND_LOOKUP_STALE");
      expect((await refundRow(refundId)).status).toBe("approved");
      expect(await audits(refundId, SETTLE_ACTION)).toHaveLength(0);
      expect(
        await outboxEventCount([refundId, intentId], "payment.refunded"),
      ).toBe(0);
      expect(await completedRefunds(intentId)).toEqual({ n: 0, total: 0 });
      expect(fake.calls).toHaveLength(0);

      // A fresh lookup of the changed row goes through.
      expect((await settle(opsClient, refundId)).status).toBe(200);
      expect(await completedRefunds(intentId)).toEqual({ n: 1, total: 30_000 });
    });

  it("a refund with no provider reference, no polls and no attempt is settled without any lookup", async () => {
    const { refundId } = await seedRefund({ lastError: MANUAL_RECONCILIATION });

    expect((await settle(opsClient, refundId)).status).toBe(200);

    expect(fake.statusCalls).toHaveLength(0);
  });

  // legend-980 M5: the usual maybe-sent shape (attempts, no reference, no poll)
  // is asked by its key before finance may pay it by hand.
  for (const [flagName, flag] of flags) {
    const maybeSent = () => seedRefund({ attempts: 8, lastError: flag });

    for (const answer of ["succeeded", "pending"] as const)
      it(`${flagName}: attempts but no reference and no poll, provider answers ${answer}: settlement refused, nothing changes`, async () => {
        const { refundId, intentId } = await maybeSent();
        fake.setStatus(lookupFor(refundId), {
          status: answer,
          providerRef: "PR-MAYBE-SENT",
        });
        const before = await refundRow(refundId);

        const response = await settle(opsClient, refundId);

        expect(response.status).toBe(409);
        expect(response.body.error.code).toBe(
          answer === "succeeded"
            ? "REFUND_PROVIDER_PAID"
            : "REFUND_PROVIDER_PENDING",
        );
        expect(fake.statusCalls[0]?.idempotencyKey).toBe(lookupFor(refundId));
        expect(fake.statusCalls[0]?.providerRef).toBeNull();
        await expectUntouched(refundId, intentId, before);
      });

    it(`${flagName}: attempts but no reference and no poll, provider unreachable: refused; then settled once it answers`, async () => {
      const { refundId } = await maybeSent();
      fake.statusError = new Error("fake provider unreachable");
      const refused = await settle(opsClient, refundId);
      expect(refused.status).toBe(503);
      expect(refused.body.error.code).toBe("REFUND_PROVIDER_LOOKUP_FAILED");

      fake.statusError = null;
      expect((await settle(opsClient, refundId)).status).toBe(200);
      expect(
        fake.statusCalls.filter(
          (c) => c.idempotencyKey === lookupFor(refundId),
        ),
      ).toHaveLength(2);
    });
  }

  it("a refund that is not flagged stuck is refused as REFUND_AT_PROVIDER without a lookup", async () => {
    const { refundId } = await seedRefund({
      attempts: 1,
      providerRef: stuckProviderRef(),
    });

    const response = await settle(opsClient, refundId);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("REFUND_AT_PROVIDER");
    expect(fake.statusCalls).toHaveLength(0);
  });

  // legend-980 H1: a payout with an unknown outcome leaves attempts, no
  // reference, no poll and an error that is not a stuck flag. It is looked up by
  // its key all the same: finance never pays by hand what the provider may have paid.
  describe("an unflagged refund with attempts but no reference and no poll", () => {
    const unflaggedErrors: (string | null)[] = [null, "UNKNOWN", "Error"];

    for (const lastError of unflaggedErrors) {
      const unknownOutcome = () => seedRefund({ attempts: 2, lastError });
      const label = lastError ?? "no error";

      for (const answer of ["succeeded", "pending"] as const)
        it(`${label}: provider answers ${answer}: settlement refused, nothing changes`, async () => {
          const { refundId, intentId } = await unknownOutcome();
          fake.setStatus(lookupFor(refundId), {
            status: answer,
            providerRef: "PR-UNKNOWN-OUTCOME",
          });
          const before = await refundRow(refundId);

          const response = await settle(opsClient, refundId);

          expect(response.status).toBe(409);
          expect(response.body.error.code).toBe(
            answer === "succeeded"
              ? "REFUND_PROVIDER_PAID"
              : "REFUND_PROVIDER_PENDING",
          );
          expect(fake.statusCalls[0]?.idempotencyKey).toBe(lookupFor(refundId));
          expect(fake.statusCalls[0]?.providerRef).toBeNull();
          await expectUntouched(refundId, intentId, before);
        });

      it(`${label}: provider unreachable: refused (REFUND_PROVIDER_LOOKUP_FAILED), nothing changes`, async () => {
        const { refundId, intentId } = await unknownOutcome();
        fake.statusError = new Error("fake provider unreachable");
        const before = await refundRow(refundId);

        const response = await settle(opsClient, refundId);

        expect(response.status).toBe(503);
        expect(response.body.error.code).toBe("REFUND_PROVIDER_LOOKUP_FAILED");
        await expectUntouched(refundId, intentId, before);
      });

      it(`${label}: provider does not know the refund (not found) or declined it: settlement allowed after one lookup each`, async () => {
        const notFound = await unknownOutcome();
        const declined = await unknownOutcome();
        fake.setStatus(lookupFor(declined.refundId), {
          status: "failed",
          providerRef: "PR-DECLINED",
          code: "declined",
        });

        expect((await settle(opsClient, notFound.refundId)).status).toBe(200);
        expect((await settle(opsClient, declined.refundId)).status).toBe(200);

        for (const { refundId } of [notFound, declined]) {
          expect((await refundRow(refundId)).status).toBe("completed");
          expect(
            fake.statusCalls.filter(
              (c) => c.idempotencyKey === lookupFor(refundId),
            ),
          ).toHaveLength(1);
        }
        expect(fake.calls).toHaveLength(0);
      });
    }
  });

  it("a replay of a settled refund returns the stored view without asking the provider again", async () => {
    const { refundId } = await seedStuck(MANUAL_RECONCILIATION);
    const body = settlementBody();
    expect((await settle(opsClient, refundId, body)).status).toBe(200);
    // The provider paid in the meantime: the replay still answers from storage.
    fake.setStatus(lookupFor(refundId), {
      status: "succeeded",
      providerRef: "PR-LATE",
    });

    const replay = await settle(opsClient, refundId, body);

    expect(replay.status).toBe(200);
    expect(
      fake.statusCalls.filter((c) => c.idempotencyKey === lookupFor(refundId)),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// legend-980 High 2 follow-up: the sweep watches a hand-settled refund
// ---------------------------------------------------------------------------

describe("legend-980 the sweep watches a refund settled by hand for a late provider payout", () => {
  async function settledWithRef(flag = MANUAL_RECONCILIATION) {
    const { refundId, intentId } = await seedRefund({
      attempts: 8,
      lastError: flag,
      providerRef: stuckProviderRef(),
      polls: 1,
    });
    expect((await settle(opsClient, refundId)).status).toBe(200);
    return { refundId, intentId };
  }
  const lookupsOf = (refundId: string) =>
    fake.statusCalls.filter((c) => c.idempotencyKey === `refund:${refundId}`)
      .length;

  async function expectStillPaidOnce(refundId: string, intentId: string) {
    const row = await refundRow(refundId);
    expect(row.status).toBe("completed");
    expect(row.last_payout_error).toBe(SETTLED_OUTSIDE_PROVIDER);
    expect(await completedRefunds(intentId)).toEqual({ n: 1, total: 30_000 });
    expect(await audits(refundId, SETTLE_ACTION)).toHaveLength(1);
    expect(
      await outboxEventCount([refundId, intentId], "payment.refunded"),
    ).toBe(1);
    expect(fake.calls).toHaveLength(0);
    expect(fake.executionCount).toBe(0);
  }

  it("a provider payout found by the sweep is recorded once as a conflict: no payout, no state change, no repeat alert", async () => {
    const { refundId, intentId } = await settledWithRef();
    const settled = await refundRow(refundId);
    fake.setStatus(`refund:${refundId}`, {
      status: "succeeded",
      providerRef: "PR-PAID-LATER",
    });
    const asked = lookupsOf(refundId);

    await ageRefund(refundId);
    await sweep();
    expect(lookupsOf(refundId)).toBe(asked + 1);
    expect(await audits(refundId, CONFLICT_ACTION)).toHaveLength(1);

    await ageRefund(refundId);
    await sweep();
    await ageRefund(refundId);
    await sweep();
    expect(lookupsOf(refundId)).toBe(asked + 1);
    expect(await audits(refundId, CONFLICT_ACTION)).toHaveLength(1);
    expect((await refundRow(refundId)).completed_at?.getTime()).toBe(
      settled.completed_at?.getTime(),
    );
    await expectStillPaidOnce(refundId, intentId);
  });

  it("a provider that never paid leaves no conflict; checks are at most hourly", async () => {
    const { refundId, intentId } = await settledWithRef();
    const asked = lookupsOf(refundId);

    // Right after the settlement (and after any check) it is not due again.
    await sweep();
    expect(lookupsOf(refundId)).toBe(asked);

    await ageRefund(refundId);
    await sweep();
    expect(lookupsOf(refundId)).toBe(asked + 1);
    await sweep();
    expect(lookupsOf(refundId)).toBe(asked + 1);

    expect(await audits(refundId, CONFLICT_ACTION)).toHaveLength(0);
    await expectStillPaidOnce(refundId, intentId);
  });

  it("a lookup that fails records nothing, moves only the backoff stamp and is retried when due", async () => {
    const { refundId, intentId } = await settledWithRef();
    const asked = lookupsOf(refundId);
    fake.statusError = new Error("fake provider unreachable");

    await ageRefund(refundId);
    await sweep();
    expect(lookupsOf(refundId)).toBe(asked + 1);
    await sweep();
    expect(lookupsOf(refundId)).toBe(asked + 1);
    expect(await audits(refundId, CONFLICT_ACTION)).toHaveLength(0);

    fake.statusError = null;
    fake.setStatus(`refund:${refundId}`, {
      status: "succeeded",
      providerRef: "PR-PAID-AFTER-OUTAGE",
    });
    await ageRefund(refundId);
    await sweep();
    expect(await audits(refundId, CONFLICT_ACTION)).toHaveLength(1);
    await expectStillPaidOnce(refundId, intentId);
  });

  it("a provider that answers pending is recorded once as a conflict (it may still pay): no payout, no state change", async () => {
    const { refundId, intentId } = await settledWithRef();
    fake.setStatus(`refund:${refundId}`, {
      status: "pending",
      providerRef: "PR-PENDING-LATER",
    });
    const asked = lookupsOf(refundId);

    await ageRefund(refundId);
    await sweep();
    expect(lookupsOf(refundId)).toBe(asked + 1);
    expect(await audits(refundId, CONFLICT_ACTION)).toHaveLength(1);

    // The watch goes on after `pending` (it may succeed later), but a second
    // `pending` answer is not a second alert.
    await ageRefund(refundId);
    await sweep();
    expect(lookupsOf(refundId)).toBe(asked + 2);
    expect(await audits(refundId, CONFLICT_ACTION)).toHaveLength(1);
    await expectStillPaidOnce(refundId, intentId);
  });

  // legend-980 L7: one alert per kind (pending, succeeded).
  const conflictCodes = async (refundId: string) => {
    const { rows } = await owner.query<{ code: string }>(
      `SELECT event->'maskedChanges'->'after'->>'providerCode' AS code
       FROM audit_logs
       WHERE tenant_id = $1 AND event->>'objectId' = $2 AND event->>'action' = $3
       ORDER BY created_at, id`,
      [tenantId, refundId, CONFLICT_ACTION],
    );
    return rows.map((r) => r.code);
  };

  /**
   * Copies the settlement audit row as a conflict row of `code`, `age` old. The
   * audit table stamps every insert with the current time (trigger
   * audit_logs_creation_time), so an old row is written with triggers off for
   * this one transaction only (session_replication_role = replica).
   */
  const insertConflictAlert = async (
    refundId: string,
    code: string,
    age = "0",
  ) => {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `INSERT INTO audit_logs (tenant_id, id, outlet_id, event, created_at)
         SELECT tenant_id, gen_random_uuid(), outlet_id,
                jsonb_set(jsonb_set(event, '{action}', to_jsonb($3::text)),
                          '{maskedChanges,after,providerCode}', to_jsonb($5::text)),
                now() - $6::interval
         FROM audit_logs
         WHERE tenant_id = $1 AND event->>'objectId' = $2 AND event->>'action' = $4
         LIMIT 1`,
        [tenantId, refundId, CONFLICT_ACTION, SETTLE_ACTION, code, age],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };

  it("a succeeded answer after a pending conflict alert is still reported; then the watch stops", async () => {
    const { refundId, intentId } = await settledWithRef();
    fake.setStatus(`refund:${refundId}`, {
      status: "pending",
      providerRef: "PR-PENDING-FIRST",
    });
    await ageRefund(refundId);
    await sweep();
    expect(await conflictCodes(refundId)).toEqual(["pending"]);

    fake.setStatus(`refund:${refundId}`, {
      status: "succeeded",
      providerRef: "PR-PAID-AFTER-PENDING",
    });
    const asked = lookupsOf(refundId);
    await ageRefund(refundId);
    await sweep();
    expect(lookupsOf(refundId)).toBe(asked + 1);
    expect(await conflictCodes(refundId)).toEqual(["pending", "succeeded"]);

    await ageRefund(refundId);
    await sweep();
    expect(lookupsOf(refundId)).toBe(asked + 1);
    expect(await conflictCodes(refundId)).toEqual(["pending", "succeeded"]);
    await expectStillPaidOnce(refundId, intentId);
  });

  it("a conflict alert older than the 14-day watch window does not hide a new one", async () => {
    const { refundId, intentId } = await settledWithRef();
    fake.setStatus(`refund:${refundId}`, {
      status: "succeeded",
      providerRef: "PR-PAID-OLD-ALERT",
    });
    await insertConflictAlert(refundId, "succeeded", "20 days");
    expect(await conflictCodes(refundId)).toEqual(["succeeded"]);

    await ageRefund(refundId);
    await sweep();

    expect(await conflictCodes(refundId)).toEqual(["succeeded", "succeeded"]);
    await expectStillPaidOnce(refundId, intentId);
  });

  // legend-980 L6: the dedupe is judged again under the row lock.
  it("two workers that looked up the same refund record one alert (dedupe re-checked under the row lock)", async () => {
    const { refundId, intentId } = await settledWithRef();
    fake.setStatus(`refund:${refundId}`, {
      status: "succeeded",
      providerRef: "PR-PAID-RACE",
    });
    await ageRefund(refundId);
    // The other worker records its alert while this one is inside its provider
    // lookup (it already passed the due query).
    let intruded = false;
    fake.onStatus = async () => {
      fake.onStatus = null;
      intruded = true;
      await insertConflictAlert(refundId, "succeeded");
    };

    await sweep();

    expect(intruded).toBe(true);
    expect(await conflictCodes(refundId)).toEqual(["succeeded"]);
    await expectStillPaidOnce(refundId, intentId);
  });

  // legend-980 M5: a refund settled without a provider reference that may still
  // have reached the provider (attempts or polls) is watched by its key.
  for (const answer of ["succeeded", "pending"] as const)
    it(`a refund settled without a provider reference (maybe sent) that the provider later answers ${answer}: conflict recorded, no payout`, async () => {
      const { refundId, intentId } = await seedRefund({
        attempts: 8,
        lastError: PAYOUT_NOT_FOUND_MAYBE_SENT,
      });
      expect((await settle(opsClient, refundId)).status).toBe(200);
      expect((await refundRow(refundId)).provider_ref).toBeNull();
      fake.setStatus(`refund:${refundId}`, {
        status: answer,
        providerRef: "PR-LATE-NO-REF",
      });
      const asked = lookupsOf(refundId);

      await ageRefund(refundId);
      await sweep();

      expect(lookupsOf(refundId)).toBe(asked + 1);
      expect(await audits(refundId, CONFLICT_ACTION)).toHaveLength(1);
      await ageRefund(refundId);
      await sweep();
      expect(await audits(refundId, CONFLICT_ACTION)).toHaveLength(1);
      await expectStillPaidOnce(refundId, intentId);
    });

  it("only a settled refund with a provider trace, within 14 days, is watched", async () => {
    const old = await settledWithRef();
    await owner.query(
      "UPDATE payment_refunds SET completed_at = now() - interval '15 days' WHERE tenant_id = $1 AND id = $2",
      [tenantId, old.refundId],
    );
    // Settled with no provider trace at all (no reference, no poll, no
    // attempt): nothing to watch.
    const polled = await seedRefund({ lastError: MANUAL_RECONCILIATION });
    expect((await settle(opsClient, polled.refundId)).status).toBe(200);
    for (const { refundId } of [old, polled])
      fake.setStatus(`refund:${refundId}`, {
        status: "succeeded",
        providerRef: "PR-NOT-WATCHED",
      });
    const askedOld = lookupsOf(old.refundId);
    const askedPolled = lookupsOf(polled.refundId);

    await ageRefund(old.refundId);
    await ageRefund(polled.refundId);
    await sweep();

    expect(lookupsOf(old.refundId)).toBe(askedOld);
    expect(lookupsOf(polled.refundId)).toBe(askedPolled);
    expect(await audits(old.refundId, CONFLICT_ACTION)).toHaveLength(0);
    expect(await audits(polled.refundId, CONFLICT_ACTION)).toHaveLength(0);
  });
});
