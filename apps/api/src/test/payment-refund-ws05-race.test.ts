// WS-05 payment admin, bead legend-7tc4 (C1, C2): a refund never pays out more
// than the customer paid, even under parallel requests, parallel approvals and
// gateway timeouts/retries (PRD v1.7 §3.7, §3.13; PAY-04). Money rule: no party
// is paid more, the outlet never loses.
//
// Real Express app, Better Auth, services and PostgreSQL; only the refund
// provider is a fake (src/test/refund-fake-gateway.ts) that dedupes on the
// idempotency key like a real provider.
//
// Status against the base branch (the first run decides): several of these
// pin behavior that may already hold (request-time cap, key `refund:<id>`,
// no second send). They are kept as regression proof; the engineer marks which
// ones passed on base. The approval-time parallel test is the likely gap.
//
// Assumptions where the brief is silent:
// - Fixture policy for `refund`: Finance at level 1 for every amount (seeded
//   here, original rows restored). Approvers are Finance users who also hold
//   the supervisor template at the outlet (`pos.refund.approve`); requesters
//   are Owners, so the requester is never an approver.
// - Approval-time race: two PENDING refunds of Rp60.000 on a Rp100.000 payment
//   are seeded directly (together they exceed the payment, like legacy or
//   inconsistent data). When both are approved in parallel the system may pay
//   one and fail the other, or fail both (cap_exceeded). The tests only assert
//   the money bound, not which of the two wins; each answer is 200 or 409.
// - A provider "timeout" is either a throw before the provider recorded the
//   refund (script "throw") or a throw AFTER it recorded it (response lost).
//   Whether a retry re-sends with the same key or only looks the refund up is
//   not asserted; only that every call uses `refund:<id>` and the provider
//   executes the refund at most once (the port contract in
//   payment-refund-gateway.ts also forbids a second send after an attempt).
// - A retry answers 200 (current view) or 409 (refused); only stored state and
//   provider calls are asserted.
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
import { createApp } from "../app";
import {
  setPaymentRefundGateway,
  type GatewayRefundRequest,
  type GatewayRefundResult,
} from "../services/payment-refund-gateway";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";
import { FakeRefundGateway } from "./refund-fake-gateway";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const ADMIN = "/api/payments/admin";
const PAID = 100_000;

type Client = ReturnType<typeof agent>;
let requester: Client; // Owner: files refunds
let requesterId: string;
let requesterB: Client; // a second Owner on a separate session/connection
let financeA: Client; // Finance + supervisor: approver
let financeB: Client; // a second, distinct approver

const userIds: string[] = [];
const linkIds: string[] = [];
const intentIds: string[] = [];
const refundIds: string[] = [];
let savedPolicies: Record<string, unknown>[] = [];
let fake: LostResponseGateway;

const key = (prefix = "k") => `${prefix}-${randomUUID()}`;

/** Fake provider that can record a refund and still lose the response (timeout after execution). */
class LostResponseGateway extends FakeRefundGateway {
  loseNextResponse = false;
  override async refund(
    input: GatewayRefundRequest,
  ): Promise<GatewayRefundResult> {
    const result = await super.refund(input);
    if (this.loseNextResponse) {
      this.loseNextResponse = false;
      throw new Error("response lost after the provider recorded the refund");
    }
    return result;
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
  alsoSupervisor = false,
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
  if (alsoSupervisor)
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
      [tenantId, userId, await roleIdOf("supervisor"), outletA],
    );
  return { client, userId };
}

/** A settled bill: link + paid intent + matching evidence. */
async function seedPaid(amountIdr = PAID) {
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
      `RACE-${linkId.slice(0, 8)}`,
      amountIdr,
      requesterId,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
    [intentId, tenantId, outletA, linkId, amountIdr, `race-${intentId}`],
  );
  await owner.query(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [tenantId, outletA, intentId, `evidence-${intentId}`, amountIdr],
  );
  return { intentId };
}

const requestWith = (client: Client, intentId: string, amountIdr: number) =>
  client
    .post(`${ADMIN}/refunds`)
    .set(originHeader)
    .send({
      idempotencyKey: key("req"),
      paymentIntentId: intentId,
      amountIdr,
      reason: "Pelanggan mengembalikan pesanan",
    });

async function requestRefund(intentId: string, amountIdr: number) {
  const response = await requestWith(requester, intentId, amountIdr);
  expect(response.status).toBe(201);
  const id = response.body.data.id as string;
  refundIds.push(id);
  return id;
}

/** A pending refund inserted directly (bypasses the request-time cap check). */
async function seedPendingRefund(intentId: string, amountIdr: number) {
  const id = randomUUID();
  refundIds.push(id);
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian uji paralel', 'pending', $6)`,
    [id, tenantId, outletA, intentId, amountIdr, requesterId],
  );
  return id;
}

const approve = (client: Client, id: string) =>
  client
    .post(`${ADMIN}/refunds/${id}/approve`)
    .set(originHeader)
    .send({ idempotencyKey: key("apr") });
const retry = (client: Client, id: string) =>
  client
    .post(`${ADMIN}/refunds/${id}/retry`)
    .set(originHeader)
    .send({ idempotencyKey: key("retry") });

/** Sum of refunds that still hold or have taken money (everything but failed). */
async function liveTotal(intentId: string): Promise<number> {
  const { rows } = await owner.query<{ total: string }>(
    `SELECT coalesce(sum(amount_idr), 0)::text AS total FROM payment_refunds
     WHERE tenant_id = $1 AND payment_intent_id = $2 AND status <> 'failed'`,
    [tenantId, intentId],
  );
  return Number(rows[0]!.total);
}

/** Sum of refunds approved or completed (money that may leave or has left). */
async function decidedTotal(intentId: string): Promise<number> {
  const { rows } = await owner.query<{ total: string }>(
    `SELECT coalesce(sum(amount_idr), 0)::text AS total FROM payment_refunds
     WHERE tenant_id = $1 AND payment_intent_id = $2 AND status IN ('approved', 'completed')`,
    [tenantId, intentId],
  );
  return Number(rows[0]!.total);
}

async function refundStatus(id: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM payment_refunds WHERE tenant_id = $1 AND id = $2",
    [tenantId, id],
  );
  return rows[0]!.status;
}

/** Money the provider really moved: one amount per idempotency key it executed. */
function providerPaidTotal(gateway: FakeRefundGateway): number {
  const firstCallOfKey = new Map<string, GatewayRefundRequest>();
  for (const call of gateway.calls)
    if (!firstCallOfKey.has(call.idempotencyKey))
      firstCallOfKey.set(call.idempotencyKey, call);
  let total = 0;
  for (const [idempotencyKey, call] of firstCallOfKey)
    if (gateway.executionsFor(idempotencyKey) === 1) total += call.amountIdr;
  return total;
}

beforeAll(async () => {
  ({ client: requester, userId: requesterId } = await signedIn(
    "owner",
    "Race requester",
  ));
  ({ client: requesterB } = await signedIn("owner", "Race requester B"));
  ({ client: financeA } = await signedIn("finance", "Race finance A", true));
  ({ client: financeB } = await signedIn("finance", "Race finance B", true));

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
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'refund', NULL, $2, 1)`,
    [tenantId, await roleIdOf("finance")],
  );
});

afterAll(async () => {
  await owner.query(
    "DELETE FROM approval_requests WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = ANY($2::text[])",
    [tenantId, refundIds],
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
  fake = new LostResponseGateway();
  setPaymentRefundGateway(fake);
});
afterEach(() => {
  setPaymentRefundGateway(null);
});

describe("legend-7tc4 C1: parallel refunds never exceed the amount paid", () => {
  it("PAY-04 two users filing Rp60.000 at once on a Rp100.000 payment: one is accepted, one refused", async () => {
    const { intentId } = await seedPaid();

    const responses = await Promise.all([
      requestWith(requester, intentId, 60_000),
      requestWith(requesterB, intentId, 60_000),
    ]);
    for (const r of responses)
      if (r.status === 201) refundIds.push(r.body.data.id as string);

    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await liveTotal(intentId)).toBe(60_000);
    expect(fake.calls).toHaveLength(0); // requesting is not paying
  });

  it("PAY-04 three users racing Rp40.000 each: only what fits is reserved", async () => {
    const { intentId } = await seedPaid();

    const responses = await Promise.all([
      requestWith(requester, intentId, 40_000),
      requestWith(requesterB, intentId, 40_000),
      requestWith(requester, intentId, 40_000),
    ]);
    for (const r of responses)
      if (r.status === 201) refundIds.push(r.body.data.id as string);

    expect(responses.map((r) => r.status).sort()).toEqual([201, 201, 409]);
    expect(await liveTotal(intentId)).toBe(80_000);
    const view = await requester.get(
      `${ADMIN}/refunds/refundable?outletId=${outletA}`,
    );
    expect(
      view.body.data.payments.find(
        (p: { paymentIntentId: string }) => p.paymentIntentId === intentId,
      ),
    ).toMatchObject({ refundedAmountIdr: 80_000, refundableAmountIdr: 20_000 });
  });

  it("PAY-04 two refunds that together exceed the payment, approved in parallel by two approvers, never pay more than was paid", async () => {
    const { intentId } = await seedPaid();
    const first = await seedPendingRefund(intentId, 60_000);
    const second = await seedPendingRefund(intentId, 60_000);

    const responses = await Promise.all([
      approve(financeA, first),
      approve(financeB, second),
    ]);

    for (const r of responses) expect([200, 409]).toContain(r.status);
    // The money bound holds in the database and at the provider.
    expect(await decidedTotal(intentId)).toBeLessThanOrEqual(PAID);
    expect(providerPaidTotal(fake)).toBeLessThanOrEqual(PAID);
    expect(fake.executionCount).toBeLessThanOrEqual(1);
    // At most one of the two over-reserved refunds can have been completed.
    const statuses = [await refundStatus(first), await refundStatus(second)];
    expect(
      statuses.filter((s) => s === "completed").length,
    ).toBeLessThanOrEqual(1);
  });

  it("PAY-04 the same over-reserved pair with a slow provider (payouts overlap) still pays at most the payment", async () => {
    const { intentId } = await seedPaid();
    const first = await seedPendingRefund(intentId, 60_000);
    const second = await seedPendingRefund(intentId, 60_000);
    // Not an assertion on time: the delay only keeps both payouts in flight together.
    fake.delayMs = 300;

    const responses = await Promise.all([
      approve(financeA, first),
      approve(financeB, second),
    ]);

    for (const r of responses) expect([200, 409]).toContain(r.status);
    expect(await decidedTotal(intentId)).toBeLessThanOrEqual(PAID);
    expect(providerPaidTotal(fake)).toBeLessThanOrEqual(PAID);
    expect(fake.executionCount).toBeLessThanOrEqual(1);
  });

  it("PAY-04 the same refund approved by two approvers at once is paid once", async () => {
    const { intentId } = await seedPaid();
    const refundId = await requestRefund(intentId, 100_000);
    fake.delayMs = 200;

    const responses = await Promise.all([
      approve(financeA, refundId),
      approve(financeB, refundId),
    ]);

    for (const r of responses) expect([200, 409]).toContain(r.status);
    expect(responses.map((r) => r.status)).toContain(200);
    expect(fake.executionCount).toBe(1);
    expect(fake.executionsFor(`refund:${refundId}`)).toBe(1);
    expect(providerPaidTotal(fake)).toBe(100_000);
    expect(await decidedTotal(intentId)).toBe(100_000);
    expect(await refundStatus(refundId)).toBe("completed");
  });
});

describe("legend-7tc4 C2: a gateway timeout and retry never pay a refund twice", () => {
  it("PAY-04 the provider paid but the answer was lost: retrying finds the same refund by its key and completes it once", async () => {
    const { intentId } = await seedPaid();
    const refundId = await requestRefund(intentId, 60_000);
    const idempotencyKey = `refund:${refundId}`;
    fake.loseNextResponse = true;

    const first = await approve(financeA, refundId);
    expect(first.status).toBe(200);
    // Unknown outcome: not completed, and the amount stays reserved.
    expect(first.body.data.status).toBe("approved");
    expect(fake.executionsFor(idempotencyKey)).toBe(1);
    expect(await liveTotal(intentId)).toBe(60_000);

    const second = await retry(financeB, refundId);
    expect([200, 409]).toContain(second.status);

    // Every provider call used the one stable key; the provider executed once.
    for (const call of fake.calls)
      expect(call.idempotencyKey).toBe(idempotencyKey);
    for (const call of fake.statusCalls)
      expect(call.idempotencyKey).toBe(idempotencyKey);
    expect(fake.executionCount).toBe(1);
    expect(fake.executionsFor(idempotencyKey)).toBe(1);
    expect(providerPaidTotal(fake)).toBe(60_000);
    // The refund ends completed with the provider's own reference.
    expect(await refundStatus(refundId)).toBe("completed");
    expect(fake.storedResult(idempotencyKey)).toMatchObject({
      status: "succeeded",
    });
    expect(await decidedTotal(intentId)).toBe(60_000);

    // The balance is final: only the remaining Rp40.000 can still be refunded.
    const tooMuch = await requestWith(requester, intentId, 40_001);
    expect(tooMuch.status).toBe(409);
    const rest = await requestWith(requester, intentId, 40_000);
    expect(rest.status).toBe(201);
    refundIds.push(rest.body.data.id as string);
    expect(await liveTotal(intentId)).toBe(PAID);
  });

  it("PAY-04 two retries at once after a lost answer still leave a single provider execution", async () => {
    const { intentId } = await seedPaid();
    const refundId = await requestRefund(intentId, 60_000);
    fake.loseNextResponse = true;
    expect((await approve(financeA, refundId)).status).toBe(200);

    const retries = await Promise.all([
      retry(financeA, refundId),
      retry(financeB, refundId),
    ]);

    for (const r of retries) expect([200, 409]).toContain(r.status);
    expect(fake.executionCount).toBe(1);
    expect(providerPaidTotal(fake)).toBe(60_000);
    expect(new Set(fake.calls.map((c) => c.idempotencyKey))).toEqual(
      new Set([`refund:${refundId}`]),
    );
    expect(await decidedTotal(intentId)).toBe(60_000);
  });

  it("PAY-04 a timeout before the provider recorded anything: retries under the same key never pay twice and the amount stays reserved", async () => {
    const { intentId } = await seedPaid();
    const refundId = await requestRefund(intentId, 60_000);
    const idempotencyKey = `refund:${refundId}`;
    fake.enqueue("throw");

    const first = await approve(financeA, refundId);
    expect(first.status).toBe(200);
    expect(first.body.data.status).toBe("approved");
    expect(first.body.data.completedAt).toBeNull();

    const retries = await Promise.all([
      retry(financeB, refundId),
      retry(financeA, refundId),
    ]);
    for (const r of retries) expect([200, 409]).toContain(r.status);

    for (const call of fake.calls)
      expect(call.idempotencyKey).toBe(idempotencyKey);
    // At most one real payout, whatever the retry policy does.
    expect(fake.executionCount).toBeLessThanOrEqual(1);
    expect(fake.executionsFor(idempotencyKey)).toBeLessThanOrEqual(1);
    expect(providerPaidTotal(fake)).toBeLessThanOrEqual(60_000);
    // Unknown or unfinished: the Rp60.000 stays held, so no one can refund it again.
    expect(await refundStatus(refundId)).not.toBe("failed");
    expect(await liveTotal(intentId)).toBe(60_000);
    const tooMuch = await requestWith(requester, intentId, 40_001);
    expect(tooMuch.status).toBe(409);
  });

  it("PAY-04 replaying the approve call after a timeout is the same decision and does not add a second payout", async () => {
    const { intentId } = await seedPaid();
    const refundId = await requestRefund(intentId, 60_000);
    const idempotencyKey = key("same");
    fake.loseNextResponse = true;

    const send = () =>
      financeA
        .post(`${ADMIN}/refunds/${refundId}/approve`)
        .set(originHeader)
        .send({ idempotencyKey });
    const first = await send();
    const replay = await send();

    expect(first.status).toBe(200);
    expect([200, 409]).toContain(replay.status);
    expect(fake.executionCount).toBe(1);
    expect(providerPaidTotal(fake)).toBe(60_000);
    expect(await decidedTotal(intentId)).toBe(60_000);
    expect(new Set(fake.calls.map((c) => c.idempotencyKey))).toEqual(
      new Set([`refund:${refundId}`]),
    );
  });
});
