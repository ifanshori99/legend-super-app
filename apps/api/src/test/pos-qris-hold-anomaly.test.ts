// legend-yhia9 QRIS hold acceptance tests, part QB: anomalies, backstops,
// concurrency, manager release and the I1-I6 invariants. Written from
// docs design qris.md §3 (D-01..D-09), §4 state machine, §7 case table and
// §8, plus the founder answers of 13 Nov 2026:
//   Q92: QR lifetime at the cashier is 5 minutes.
//   Q93: a manager may release a stuck hold through pos-overrides PIN approval,
//        only when now >= expires_at + 30 min, audited, close_reason
//        `force_released`; earlier it is refused.
//
// Fail-first: nothing of the hold exists on m1. Tests reach the hold through
// HTTP, raw SQL and run-time imports (see pos-qris-hold-test-helpers.ts), so a
// missing feature is a clear assertion, never an import crash.
//
// Assumptions (the design is silent on them):
// - Bill math: the fixture meal is Rp 30.000 plus PBJT 10% = Rp 33.000, no
//   service charge, no rounding. DP `D` is attached by the submit; R = T - D - C.
// - Closing a hold in a test = cashier cancel, provider answer, then the hold
//   check job at `expires_at + 61 s`. The default provider is DOIT, whose
//   evidence is a mapped `expired` status (no raw code).
// - Manager release uses an approved pos-overrides row of action "void"
//   (the only supervisor action in the contract that fits; there is no
//   release-specific action yet). If the engineer adds a dedicated action,
//   change RELEASE_OVERRIDE_ACTION below. Body of the route:
//   `{ approvedBy, overrideId, idempotencyKey }`; success is any 2xx.
// - "Audited" (QH-29) means a row in `audit_logs` whose event text mentions the
//   hold id (ULID or uuid form) or the order id.
// - "Manager alert" (QH-14) means a new `notification.created` outbox event;
//   the payload shape is not pinned.
// - QH-19 uses the guest split-payment route (`POST /table-sessions/:id/payments`
//   with target split), because POS tenders have no split target in the
//   contract. The first split QR must create the hold; the second must get
//   409 QRIS_HOLD_ACTIVE.
// - QH-17 forces the POS transaction to fail by a test-only trigger that
//   rejects the hold insert for this tenant (the link and intent commit
//   earlier in their own transactions).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
  uuidToUlid,
} from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { setStaffPin } from "../services/device-pin.service.ts";
import { pollPendingGatewayIntents } from "../services/payment.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { owner } from "./floor-test-helpers.ts";
import { withEdgeModeEnv } from "./edge-mode-env.ts";
import { agent, signUp } from "./helpers.ts";
import { secretFor } from "./payer-secret-helpers.ts";
import {
  HOLD_CLOSE_MARGIN_S,
  HOLD_RELEASE_AFTER_MIN,
  QR_LIFETIME_MIN,
  assertInvariants,
  attachDeposit,
  capturedIdr,
  expireNotice,
  getQris,
  holdFixture,
  issueQris,
  newSubmittedOrder,
  payNotice,
  postCancel,
  postRelease,
  rawSetDeposit,
  rawWrite,
  readBill,
  readHold,
  readHolds,
  refundsOfIntent,
  requestQris,
  resetHoldPorts,
  runHoldCheck,
  tenderStatuses,
  unallocatedFunds,
  type HoldFixture,
  type IssuedQris,
  type ManagerApproval,
  type RawWrite,
} from "./pos-qris-hold-test-helpers.ts";

// Bill of the fixture: Rp 30.000 meal + 10% PBJT.
const BILL_IDR = 33_000;
// Q93: manager release goes through a pos-overrides approval (see assumptions).
const RELEASE_OVERRIDE_ACTION = "void";
const SUPERVISOR_PIN = "582914";
const LONG = 180_000;
// Several tests create many bills; the suite default (20 s) is too short.
vi.setConfig({ testTimeout: LONG });

let fx: HoldFixture;
beforeAll(async () => {
  fx = await holdFixture("qris-hold-anomaly");
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

// ------------------------------------------------------------------ helpers

function expectHoldActive(res: { status: number; body: unknown }) {
  expect(res.status, JSON.stringify(res.body)).toBe(409);
  expect(JSON.stringify(res.body)).toContain("QRIS_HOLD_ACTIVE");
}

/**
 * `payNotice` for money that must be PARKED, not captured. Today (and by
 * design) `confirmPayment` parks a payment that does not match its intent or
 * arrives for a closed one and then throws 409 CONFLICT (AMOUNT_MISMATCH /
 * closed intent). That throw is not what these tests judge: the assertions
 * after the call (unallocated row, no capture, no refund) are. Any other
 * error still fails the test.
 */
async function payParkedNotice(...args: Parameters<typeof payNotice>) {
  try {
    return await payNotice(...args);
  } catch (error) {
    const e = error as { code?: unknown; status?: unknown };
    if (e?.code === "CONFLICT" && e?.status === 409) return null;
    throw error;
  }
}

/** Fire every held line so the bill is `sent` and `complete` is a valid
 * transition (copied from pos-qris-hold.test.ts). Returns the bill status. */
async function fireAllItems(orderId: string, status: string) {
  const read = await fx.get(`${fx.base}/${orderId}`);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  const held = (
    read.body.data.items as { id: string; fireStatus: string }[]
  ).filter((item) => item.fireStatus === "held");
  if (held.length === 0) return read.body.data.status as string;
  const fired = await fx.post(`${fx.base}/${orderId}/fire`, {
    itemIds: held.map((item) => item.id),
    expectedStatus: status,
    idempotencyKey: randomUUID(),
  });
  expect(fired.status, JSON.stringify(fired.body)).toBe(200);
  return fired.body.data.status as string;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits (bounded) for a condition on something that happens after commit. */
async function eventually(check: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await sleep(50);
}

async function ownerWrite(text: string, params: unknown[]): Promise<RawWrite> {
  try {
    await owner.query(text, params);
    return { ok: true };
  } catch (error) {
    const e = error as { message?: string; code?: string };
    return {
      ok: false,
      message: e.message ?? String(error),
      code: e.code ?? null,
    };
  }
}

const afterExpiry = (qr: IssuedQris, seconds: number) =>
  new Date(qr.expiresAt.getTime() + seconds * 1000);

/** Moves the intent's expiry into the past, so the server's own clock sees
 * `minutes` minutes since expiry (the release rule uses the server clock). */
async function backdateExpiry(qr: IssuedQris, minutesAgo: number) {
  await owner.query(
    `UPDATE payment_intents SET expires_at = now() - $3::int * interval '1 minute'
      WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, qr.intentId, minutesAgo],
  );
}

/** QR issued, cashier cancelled, provider answered `expired`, job ran at
 * expires_at + 61 s: the hold is closed by provider proof (D-03). */
async function issueAndCloseByProvider(orderId: string) {
  const qr = await issueQris(fx, orderId);
  const cancel = await postCancel(fx, orderId);
  expect(cancel.status, JSON.stringify(cancel.body)).toBe(202);
  fx.gateway.script(qr.intentId, { status: "expired" });
  const at = afterExpiry(qr, HOLD_CLOSE_MARGIN_S + 1);
  await runHoldCheck(fx, at);
  const hold = await readHold(fx, orderId);
  expect(hold?.state).toBe("closed");
  expect(hold?.closeReason).toMatch(/^provider_(expired|failed)$/);
  expect((await tenderStatuses(fx, orderId)).map((t) => t.status)).toEqual([
    "voided",
  ]);
  return { qr, at };
}

let supervisorUserId: string | null = null;
async function supervisor(): Promise<string> {
  if (supervisorUserId) return supervisorUserId;
  const client = agent(fx.app);
  await signUp(client, "Manajer Rilis QRIS");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Manajer QRIS Uji', true, 'supervisor', $3, false, '["tenant"]')`,
    [
      roleId,
      fx.tenant.tenantId,
      JSON.stringify(["order.view", "pos.void.approve"]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [fx.tenant.tenantId, userId, roleId],
  );
  const tenantContext = establishTenantContext({
    tenantId: tenantIdSchema.parse(fx.tenant.tenantId),
    brandId: null,
    source: "session",
  });
  await setStaffPin(
    tenantContext,
    userId,
    { outletId: fx.tenant.outletId, userId },
    { pin: SUPERVISOR_PIN },
  );
  supervisorUserId = userId;
  return userId;
}

/** Approved manager PIN override (pos-overrides flow), requested by the cashier. */
async function managerApproval(
  orderId: string,
  valueIdr: number,
): Promise<ManagerApproval> {
  const approver = await supervisor();
  const { override } = await createPosOverride(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(fx.tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    fx.staff.userId,
    {
      outletId: fx.tenant.outletId,
      action: RELEASE_OVERRIDE_ACTION,
      valueIdr,
      reason: "Penyedia QRIS tidak merespons",
      objectType: "order",
      objectId: orderId,
      approval: {
        method: "supervisor_pin",
        approverUserId: userIdSchema.parse(approver),
        pin: SUPERVISOR_PIN,
      },
    } as Parameters<typeof createPosOverride>[2],
    { idempotencyKey: randomUUID() },
  );
  expect(override.status).toBe("approved");
  return { approvedBy: approver, overrideId: override.id };
}

async function evidenceCount(intentId: string) {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM payment_evidence WHERE tenant_id=$1 AND payment_intent_id=$2`,
    [fx.tenant.tenantId, intentId],
  );
  return rows[0]!.n;
}

async function outboxCount(name: string, intentId?: string) {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM domain_event_outbox
      WHERE tenant_id=$1 AND event->>'name'=$2
        AND ($3::text IS NULL OR event->'payload'->>'intentId'=$3)`,
    [fx.tenant.tenantId, name, intentId ?? null],
  );
  return rows[0]!.n;
}

async function auditMentions(patterns: string[]) {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_logs
      WHERE tenant_id=$1 AND event::text LIKE ANY($2::text[])`,
    [fx.tenant.tenantId, patterns.map((p) => `%${p}%`)],
  );
  return rows[0]!.n;
}

const activeHolds = async (orderId: string) =>
  (await readHolds(fx, orderId)).filter(
    (h) => h.state === "open" || h.state === "cancelling",
  );

// ------------------------------------------------------------------- QH-12

describe("QH-12 duplicate webhook and poll race", () => {
  it("QH-12 duplicate webhook, replayed consumer and poll for one payment capture Rp 33.000 exactly once", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    expect(qr.amountIdr).toBe(BILL_IDR);
    expect(qr.providerRef).toBeTruthy();
    fx.gateway.script(qr.intentId, { rawStatus: "00" });

    // One provider payment: both webhooks and the poll carry the same
    // provider transaction reference.
    const settled = await Promise.allSettled([
      payNotice(fx, qr.intentId, BILL_IDR, new Date(), qr.providerRef!),
      payNotice(fx, qr.intentId, BILL_IDR, new Date(), qr.providerRef!),
      pollPendingGatewayIntents(fx.context, new Date(), 50),
    ]);
    for (const outcome of settled)
      expect(
        outcome.status,
        outcome.status === "rejected" ? String(outcome.reason) : "",
      ).toBe("fulfilled");
    // Deliver whatever the poll emitted, twice more (consumer replay).
    await payNotice(fx, qr.intentId, BILL_IDR, new Date(), qr.providerRef!, {
      deliveries: 2,
    });

    expect(await capturedIdr(fx, order.id)).toBe(33_000);
    expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual([
      "captured",
    ]);
    expect(await evidenceCount(qr.intentId)).toBe(1);
    expect(await outboxCount("payment.paid", qr.intentId)).toBe(1);
    const hold = await readHold(fx, order.id);
    expect(hold?.state).toBe("paid");
    expect(hold?.closeReason).toBe("provider_paid");
    expect(await refundsOfIntent(fx, qr.intentId)).toEqual([]);
    expect(await unallocatedFunds(fx, qr.intentId)).toEqual([]);
    await assertInvariants(fx, order.id);
  });
});

// ------------------------------------------------------------------- QH-13

describe("QH-13 amount mismatch", () => {
  it("QH-13 a payment of Rp 30.000 or Rp 36.000 for a Rp 33.000 QR is parked as unallocated, never captured", async () => {
    for (const paid of [30_000, 36_000]) {
      const order = await newSubmittedOrder(fx, 0);
      const qr = await issueQris(fx, order.id);
      expect(qr.amountIdr).toBe(33_000);
      await payParkedNotice(fx, qr.intentId, paid);

      expect(await capturedIdr(fx, order.id)).toBe(0);
      expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual(
        ["authorized"],
      );
      const parked = await unallocatedFunds(fx, qr.intentId);
      expect(parked.map((p) => p.amountIdr)).toEqual([paid]);
      expect(await refundsOfIntent(fx, qr.intentId)).toEqual([]);
      const hold = await readHold(fx, order.id);
      expect(hold, "hold of the QR must exist").not.toBeNull();
      expect(hold?.state).not.toBe("paid");
      // Never applied: the bill still owes the whole Rp 33.000.
      expect((await readBill(fx, order.id)).totalIdr).toBe(33_000);
      await assertInvariants(fx, order.id);
    }
  });
});

// ------------------------------------------------------------------- QH-14

describe("QH-14 closed hold, then the old QR is paid", () => {
  it("QH-14 parks exactly one unallocated Rp 33.000, no capture, no system:pos refund; the new QR for Rp 23.000 settles the bill", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const { qr, at } = await issueAndCloseByProvider(order.id);

    // Bill unlocked: a DP of Rp 10.000 is attached, remainder is Rp 23.000.
    await attachDeposit(fx, order.id, 10_000);
    const paidAt = new Date(at.getTime() + 60_000);
    await payParkedNotice(fx, qr.intentId, 33_000, paidAt, qr.providerRef!);

    const parked = await unallocatedFunds(fx, qr.intentId);
    expect(parked, "old QR payment must be parked once").toHaveLength(1);
    expect(parked[0]!.amountIdr).toBe(33_000);
    expect(await capturedIdr(fx, order.id)).toBe(0);
    expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual([
      "voided",
    ]);
    // This is where the old MONEY-04 expectation moved: no pending refund.
    expect(await refundsOfIntent(fx, qr.intentId)).toEqual([]);
    expect((await readHold(fx, order.id))?.state).toBe("closed");
    expect(await readBill(fx, order.id)).toMatchObject({
      totalIdr: 33_000,
      depositIdr: 10_000,
    });

    // SO-896: the parked money is owed back first; a new QR is refused.
    const refused = await requestQris(fx, order.id);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(JSON.stringify(refused.body)).toContain("FUNDS_UNRESOLVED");
    await owner.query(
      `UPDATE payment_unallocated_funds
          SET resolution='refund', resolved_by='test', resolved_at=now()
        WHERE tenant_id=$1 AND payment_intent_id=$2`,
      [fx.tenant.tenantId, qr.intentId],
    );

    // Once resolved, the bill is collectible for the new remainder, once.
    const second = await issueQris(fx, order.id);
    expect(second.amountIdr).toBe(23_000);
    await payNotice(fx, second.intentId, 23_000);
    expect(await capturedIdr(fx, order.id)).toBe(23_000);
    await assertInvariants(fx, order.id);
  });

  it("QH-14 alerts the outlet manager when the old QR is paid after the hold closed", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const { qr, at } = await issueAndCloseByProvider(order.id);
    await attachDeposit(fx, order.id, 10_000);
    const before = await outboxCount("notification.created");
    await payParkedNotice(
      fx,
      qr.intentId,
      33_000,
      new Date(at.getTime() + 60_000),
      qr.providerRef!,
    );
    expect(
      await outboxCount("notification.created"),
      "a manager alert (notification.created) is expected for parked QR money",
    ).toBeGreaterThan(before);
    expect(await capturedIdr(fx, order.id)).toBe(0);
    await assertInvariants(fx, order.id);
  });
});

// ------------------------------------------------------------------- QH-15

describe("QH-15 manager release, then the old QR is paid", () => {
  it("QH-15 behaves like QH-14: one unallocated Rp 33.000, no capture, no refund", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    expect((await postCancel(fx, order.id)).status).toBe(202);
    await backdateExpiry(qr, HOLD_RELEASE_AFTER_MIN + 1);
    const approval = await managerApproval(order.id, 33_000);
    const released = await postRelease(fx, order.id, approval);
    expect(released.status, JSON.stringify(released.body)).toBeLessThan(300);
    expect(released.status).toBeGreaterThanOrEqual(200);
    const hold = await readHold(fx, order.id);
    expect(hold?.state).toBe("closed");
    expect(hold?.closeReason).toBe("force_released");

    await attachDeposit(fx, order.id, 10_000);
    await payParkedNotice(fx, qr.intentId, 33_000, new Date(), qr.providerRef!);

    const parked = await unallocatedFunds(fx, qr.intentId);
    expect(parked).toHaveLength(1);
    expect(parked[0]!.amountIdr).toBe(33_000);
    expect(await capturedIdr(fx, order.id)).toBe(0);
    expect(await refundsOfIntent(fx, qr.intentId)).toEqual([]);
    expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual([
      "voided",
    ]);
    await assertInvariants(fx, order.id);
  });
});

// ------------------------------------------------------------------- QH-16

describe("QH-16 gateway create fails", () => {
  it("QH-16 leaves no tender, no hold and no QR; the bill stays editable and a retry with the same key works", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const before = await fx.counts();
    const requestsBefore = fx.gateway.requests.length;
    const key = randomUUID();
    const body = {
      method: "qris",
      expectedStatus: order.status,
      idempotencyKey: key,
    };
    fx.gateway.failNextCreate();
    const failed = await fx.post(`${fx.base}/${order.id}/tenders`, body);
    expect(failed.status, JSON.stringify(failed.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect([401, 403, 422]).not.toContain(failed.status);
    expect(JSON.stringify(failed.body)).not.toContain("HOLDQRIS");
    expect((await fx.counts()).tenders).toBe(before.tenders);
    expect(await readHolds(fx, order.id)).toEqual([]);
    expect(fx.gateway.requests).toHaveLength(requestsBefore);
    // Nothing is frozen: a DP can still be attached.
    await attachDeposit(fx, order.id, 5_000);

    const retry = await fx.post(`${fx.base}/${order.id}/tenders`, body);
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    expect(retry.body.data.tender.amountIdr).toBe(28_000);
    expect((await readHold(fx, order.id))?.state).toBe("open");
    expect((await activeHolds(order.id)).length).toBe(1);
    await assertInvariants(fx, order.id);
  });
});

// ------------------------------------------------------------------- QH-17

describe("QH-17 POS transaction rolls back after the provider made the intent", () => {
  it("QH-17 shows no QR, leaves no tender or hold, and a retry with the same key issues one visible QR", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const tenantId = fx.tenant.tenantId;
    expect(tenantId).toMatch(/^[0-9a-f-]{36}$/i);
    const fn = `qh17_fail_${tenantId.replaceAll("-", "")}`;
    const created = await ownerWrite(
      `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'qh17 forced POS rollback'; END $$`,
      [],
    );
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const key = randomUUID();
    const body = {
      method: "qris",
      expectedStatus: order.status,
      idempotencyKey: key,
    };
    const tendersBefore = (await fx.counts()).tenders;
    const requestsBefore = fx.gateway.requests.length;
    let failed: Awaited<ReturnType<typeof fx.post>>;
    try {
      const trigger = await ownerWrite(
        `CREATE TRIGGER ${fn} BEFORE INSERT ON pos_qris_holds FOR EACH ROW
           WHEN (NEW.tenant_id = '${tenantId}') EXECUTE FUNCTION ${fn}()`,
        [],
      );
      if (!trigger.ok && trigger.code === "42P01")
        throw new Error(
          "Table pos_qris_holds does not exist: migration 0368 (QRIS hold) is not applied.",
        );
      expect(trigger.ok, JSON.stringify(trigger)).toBe(true);
      failed = await fx.post(`${fx.base}/${order.id}/tenders`, body);
    } finally {
      await ownerWrite(`DROP TRIGGER IF EXISTS ${fn} ON pos_qris_holds`, []);
      await ownerWrite(`DROP FUNCTION IF EXISTS ${fn}()`, []);
    }
    expect(failed.status, JSON.stringify(failed.body)).toBeGreaterThanOrEqual(
      500,
    );
    // The provider made the intent, but nobody can see or pay its QR.
    expect(fx.gateway.requests.length).toBe(requestsBefore + 1);
    expect(JSON.stringify(failed.body)).not.toContain("HOLDQRIS");
    expect((await fx.counts()).tenders).toBe(tendersBefore);
    expect(await readHolds(fx, order.id)).toEqual([]);
    expect(await tenderStatuses(fx, order.id)).toEqual([]);

    const retry = await fx.post(`${fx.base}/${order.id}/tenders`, body);
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    expect(retry.body.data.tender.amountIdr).toBe(33_000);
    expect((await activeHolds(order.id)).length).toBe(1);
    expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual([
      "authorized",
    ]);
    await assertInvariants(fx, order.id);
  });
});

// ------------------------------------------------------------------- QH-18

describe("QH-18 edge offline", () => {
  it("QH-18 keeps the bill frozen with no provider proof, then applies the payment once when the link returns", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    expect((await postCancel(fx, order.id)).status).toBe(202);
    // Offline: every status read fails.
    fx.gateway.script(qr.intentId, { error: "timeout" });
    for (const seconds of [HOLD_CLOSE_MARGIN_S + 1, 10 * 60, 45 * 60, 6 * 3600])
      await withEdgeModeEnv(() => runHoldCheck(fx, afterExpiry(qr, seconds)));

    const frozen = await readHold(fx, order.id);
    expect(frozen?.state).toBe("cancelling");
    expect(frozen?.closedAt).toBeNull();
    expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual([
      "authorized",
    ]);
    // Frozen: DP and cash are refused, nothing moved.
    const dp = await rawSetDeposit(fx, order.id, 10_000);
    expect(dp.ok).toBe(false);
    expectHoldActive(await fx.tender(order.id, order.status, "cash", 33_000));
    expect(await readBill(fx, order.id)).toMatchObject({
      totalIdr: 33_000,
      depositIdr: 0,
    });

    // The link returns: the provider says the customer paid.
    fx.gateway.script(qr.intentId, { rawStatus: "00" });
    const polled = await withEdgeModeEnv(() =>
      pollPendingGatewayIntents(fx.context, new Date(), 50),
    );
    expect(polled.settled).toBe(1);
    await payNotice(fx, qr.intentId, 33_000, new Date(), qr.providerRef!);
    expect(await capturedIdr(fx, order.id)).toBe(33_000);
    expect((await readHold(fx, order.id))?.state).toBe("paid");
    expect(await refundsOfIntent(fx, qr.intentId)).toEqual([]);
    expect(await unallocatedFunds(fx, qr.intentId)).toEqual([]);
    await assertInvariants(fx, order.id);
  });
});

// ------------------------------------------------------------------- QH-19

describe("QH-19 split bill", () => {
  it("QH-19 a second split QR is refused with 409 QRIS_HOLD_ACTIVE while the first is collectible", async () => {
    const guest = await fx.newGuest();
    const order = await fx.qrOrder(guest);
    expect(order.totalIdr).toBe(33_000);
    const split = await fx.guestPost(guest, "/splits", {
      method: "equal",
      parts: 2,
      idempotencyKey: randomUUID(),
    });
    expect(split.status, JSON.stringify(split.body)).toBe(201);
    const parts = split.body.data.splits as { id: string; amountIdr: number }[];
    expect(parts.map((p) => p.amountIdr)).toEqual([16_500, 16_500]);
    const payPart = (part: { id: string }) =>
      fx.guestPost(guest, "/payments", {
        target: { kind: "split", billSplitId: part.id },
        method: "qris",
        payerSecret: secretFor(part.id),
        idempotencyKey: randomUUID(),
      });
    const before = await fx.counts();
    const first = await payPart(parts[0]!);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect((await activeHolds(order.id)).length).toBe(1);

    const second = await payPart(parts[1]!);
    expectHoldActive(second);
    const after = await fx.counts();
    expect(after.intents - before.intents).toBe(1);
    expect((await activeHolds(order.id)).length).toBe(1);
    await assertInvariants(fx, order.id);
  });
});

// ------------------------------------------------------------------- QH-20

describe("QH-20 trigger backstop (raw SQL)", () => {
  it("QH-20 orders: every money column, DP and a completed/voided status are refused while the hold is active", async () => {
    const order = await newSubmittedOrder(fx, 0);
    await issueQris(fx, order.id);
    const bill = await readBill(fx, order.id);
    const id = ulidToUuid(order.id);
    const updates = [
      "subtotal_idr = subtotal_idr + 1000",
      "discount_idr = discount_idr + 1000",
      "service_charge_idr = service_charge_idr + 1000",
      "tax_idr = tax_idr + 1000",
      "rounding_idr = rounding_idr + 1",
      "total_idr = total_idr - 1000",
      "deposit_applied_idr = 10000",
      "status = 'completed'",
      "status = 'voided'",
    ];
    for (const set of updates) {
      const result = await rawWrite(
        fx,
        `UPDATE orders SET ${set} WHERE tenant_id=$1 AND id=$2`,
        [fx.tenant.tenantId, id],
      );
      expect(result.ok, `${set} must be refused`).toBe(false);
      if (!result.ok) expect(result.message, set).toContain("QRIS_HOLD_ACTIVE");
    }
    expect(await readBill(fx, order.id)).toEqual(bill);
    expect(await capturedIdr(fx, order.id)).toBe(0);
    await assertInvariants(fx, order.id);
  });

  it("QH-20 tenders: insert, status change and amount change are refused while the hold is active", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    const cols = await owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='pos_order_tenders' AND table_schema='public'
          AND is_generated='NEVER' ORDER BY ordinal_position`,
    );
    const names = cols.rows.map((r) => r.column_name);
    expect(names).toContain("id");
    const insert = await rawWrite(
      fx,
      `INSERT INTO pos_order_tenders (${names.map((n) => `"${n}"`).join(",")})
       SELECT ${names.map((n) => (n === "id" ? "gen_random_uuid()" : `"${n}"`)).join(",")}
         FROM pos_order_tenders WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, qr.tenderId],
    );
    expect(insert.ok, "extra tender insert must be refused").toBe(false);
    if (!insert.ok) expect(insert.message).toContain("QRIS_HOLD_ACTIVE");
    for (const set of [
      "status = 'voided'",
      "status = 'captured'",
      "amount_idr = 1000",
    ]) {
      const result = await rawWrite(
        fx,
        `UPDATE pos_order_tenders SET ${set} WHERE tenant_id=$1 AND id=$2`,
        [fx.tenant.tenantId, qr.tenderId],
      );
      expect(result.ok, `${set} must be refused`).toBe(false);
      if (!result.ok) expect(result.message, set).toContain("QRIS_HOLD_ACTIVE");
    }
    expect(await tenderStatuses(fx, order.id)).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        status: "authorized",
        method: "qris",
        amount: 33_000,
      }),
    ]);
    await assertInvariants(fx, order.id);
  });

  it("QH-20 hold: DELETE, a backward transition and a changed amount are refused", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    expect((await postCancel(fx, order.id)).status).toBe(202);
    const hold = await readHold(fx, order.id);
    expect(hold?.state).toBe("cancelling");

    const del = await ownerWrite(
      `DELETE FROM pos_qris_holds WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, hold!.id],
    );
    expect(del.ok, "holds are never deleted").toBe(false);
    const back = await ownerWrite(
      `UPDATE pos_qris_holds SET state='open', cancel_requested_at=NULL, cancel_requested_by=NULL
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, hold!.id],
    );
    expect(back.ok, "cancelling -> open must be refused").toBe(false);
    const amount = await ownerWrite(
      `UPDATE pos_qris_holds SET amount_idr = amount_idr - 1000 WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, hold!.id],
    );
    expect(amount.ok, "amount is immutable").toBe(false);
    const again = await readHold(fx, order.id);
    expect(again).toMatchObject({
      id: hold!.id,
      state: "cancelling",
      amountIdr: 33_000,
    });

    // A closed hold cannot be reopened either.
    fx.gateway.script(qr.intentId, { status: "expired" });
    await runHoldCheck(fx, afterExpiry(qr, HOLD_CLOSE_MARGIN_S + 1));
    expect((await readHold(fx, order.id))?.state).toBe("closed");
    const reopen = await ownerWrite(
      `UPDATE pos_qris_holds SET state='cancelling', closed_at=NULL, close_reason=NULL
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, hold!.id],
    );
    expect(reopen.ok, "closed is final").toBe(false);
    expect((await readHold(fx, order.id))?.state).toBe("closed");
    await assertInvariants(fx, order.id);
  });
});

// ------------------------------------------------------------------- QH-21

describe("QH-21 cancel is idempotent", () => {
  it("QH-21 three cancels (same key twice, then a new key) change state once and read the provider once", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    expect(fx.gateway.readsOf(qr.intentId)).toHaveLength(0);
    const key = randomUUID();
    const first = await postCancel(fx, order.id, key);
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    const held = await readHold(fx, order.id);
    expect(held?.state).toBe("cancelling");
    expect(held?.cancelRequestedAt).not.toBeNull();
    expect(held?.cancelRequestedBy).not.toBeNull();

    const same = await postCancel(fx, order.id, key);
    const other = await postCancel(fx, order.id, randomUUID());
    for (const repeat of [same, other]) {
      expect(repeat.status, JSON.stringify(repeat.body)).toBeGreaterThanOrEqual(
        200,
      );
      expect(repeat.status).toBeLessThan(300);
    }
    await eventually(() => fx.gateway.readsOf(qr.intentId).length >= 1);
    await sleep(300);
    expect(
      fx.gateway.readsOf(qr.intentId),
      "exactly one immediate status read",
    ).toHaveLength(1);
    const after = await readHold(fx, order.id);
    expect(after?.state).toBe("cancelling");
    expect(after?.cancelRequestedAt?.getTime()).toBe(
      held?.cancelRequestedAt?.getTime(),
    );
    expect((await readHolds(fx, order.id)).length).toBe(1);
    const state = await getQris(fx, order.id);
    expect(state.status, JSON.stringify(state.body)).toBe(200);
    expect(JSON.stringify(state.body)).toContain("cancelling");
    await assertInvariants(fx, order.id);
  });
});

// ------------------------------------------------------------------- QH-22

describe("QH-22 webhook apply and cashier cancel at the same time", () => {
  it(
    "QH-22 ends in paid with one capture of Rp 33.000 and no deadlock, 20 times",
    async () => {
      for (let round = 0; round < 20; round += 1) {
        const order = await newSubmittedOrder(fx, 0);
        const qr = await issueQris(fx, order.id);
        const pay = () =>
          payNotice(fx, qr.intentId, 33_000, new Date(), qr.providerRef!);
        const cancel = () => postCancel(fx, order.id);
        // Alternate who starts first so both lock orders are exercised.
        const outcomes = await Promise.allSettled(
          round % 2 === 0 ? [pay(), cancel()] : [cancel(), pay()],
        );
        for (const outcome of outcomes)
          expect(
            outcome.status,
            `round ${round}: ${outcome.status === "rejected" ? String(outcome.reason) : ""}`,
          ).toBe("fulfilled");
        const cancelled = outcomes
          .map((o) => (o.status === "fulfilled" ? o.value : null))
          .find((v) => v && "status" in v && "body" in v) as
          { status: number; body: unknown } | undefined;
        if (cancelled)
          expect(
            cancelled.status,
            `round ${round}: ${JSON.stringify(cancelled.body)}`,
          ).toBeLessThan(300);
        const hold = await readHold(fx, order.id);
        expect(hold?.state, `round ${round}`).toBe("paid");
        expect(await capturedIdr(fx, order.id), `round ${round}`).toBe(33_000);
        expect(
          (await tenderStatuses(fx, order.id)).map((t) => t.status),
        ).toEqual(["captured"]);
        await assertInvariants(fx, order.id);
      }
    },
    LONG * 2,
  );
});

// --------------------------------------------------------- QH-26..QH-29 (Q93)

describe("QH-26..QH-29 manager release (Q93)", () => {
  it("QH-26 release without a manager PIN approval is refused and the hold stays", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    await backdateExpiry(qr, HOLD_RELEASE_AFTER_MIN + 1); // time is not the reason
    const refused = await fx.post(`${fx.base}/${order.id}/qris/release`, {
      idempotencyKey: randomUUID(),
    });
    expect([400, 403, 409, 422], JSON.stringify(refused.body)).toContain(
      refused.status,
    );
    expect((await readHold(fx, order.id))?.state).toBe("open");
    expect(await rawSetDeposit(fx, order.id, 10_000)).toMatchObject({
      ok: false,
    });
    expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual([
      "authorized",
    ]);
    await assertInvariants(fx, order.id);
  });

  it("QH-27 release is refused before expires_at + 30 min, even with a valid approval", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    expect(qr.expiresAt.getTime() - Date.now()).toBeGreaterThan(0);
    expect(qr.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
      QR_LIFETIME_MIN * 60_000,
    );
    // Still inside the QR lifetime.
    const early = await postRelease(
      fx,
      order.id,
      await managerApproval(order.id, 33_000),
    );
    expect(early.status, JSON.stringify(early.body)).toBe(409);
    // 29 minutes after expiry: still one minute short.
    await backdateExpiry(qr, HOLD_RELEASE_AFTER_MIN - 1);
    const short = await postRelease(
      fx,
      order.id,
      await managerApproval(order.id, 33_000),
    );
    expect(short.status, JSON.stringify(short.body)).toBe(409);
    expect((await readHold(fx, order.id))?.state).toBe("open");
    expect(await rawSetDeposit(fx, order.id, 10_000)).toMatchObject({
      ok: false,
    });
    await assertInvariants(fx, order.id);
  });

  it("QH-28 release is allowed from expires_at + 30 min: hold closed force_released, bill unlocked, new QR for Rp 23.000", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    await backdateExpiry(qr, HOLD_RELEASE_AFTER_MIN + 1);
    const released = await postRelease(
      fx,
      order.id,
      await managerApproval(order.id, 33_000),
    );
    expect(
      released.status,
      JSON.stringify(released.body),
    ).toBeGreaterThanOrEqual(200);
    expect(released.status).toBeLessThan(300);
    const hold = await readHold(fx, order.id);
    expect(hold?.state).toBe("closed");
    expect(hold?.closeReason).toBe("force_released");
    expect(hold?.closedAt).not.toBeNull();
    expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual([
      "voided",
    ]);
    // Unlocked: DP of Rp 10.000, then a fresh QR for the remainder.
    await attachDeposit(fx, order.id, 10_000);
    const next = await issueQris(fx, order.id);
    expect(next.amountIdr).toBe(23_000);
    expect(await capturedIdr(fx, order.id)).toBe(0);
    await assertInvariants(fx, order.id);
  });

  it("QH-29 release writes an audit row naming the hold or the bill, and no audit row exists before", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    const hold = await readHold(fx, order.id);
    const patterns = [
      hold!.id,
      uuidToUlid(hold!.id),
      ulidToUuid(order.id),
      order.id,
    ];
    await backdateExpiry(qr, HOLD_RELEASE_AFTER_MIN + 1);
    const approval = await managerApproval(order.id, 33_000);
    const auditBefore = await auditMentions(patterns);
    const released = await postRelease(fx, order.id, approval);
    expect(released.status, JSON.stringify(released.body)).toBeLessThan(300);
    expect(released.status).toBeGreaterThanOrEqual(200);
    expect(
      await auditMentions(patterns),
      "an audit_logs row for the release is expected",
    ).toBeGreaterThan(auditBefore);
    const closed = await readHold(fx, order.id);
    expect(closed?.closeReason).toBe("force_released");
    await assertInvariants(fx, order.id);
  });
});

// -------------------------------------------------------------------- I1-I6

describe("I1-I6 invariants", () => {
  it("I1 captured + DP never exceeds the total, and equals it when completed", async () => {
    const order = await newSubmittedOrder(fx, 10_000);
    // Lines fired first, so `complete` is a valid transition for this bill.
    const fired = await fireAllItems(order.id, order.status);
    const qr = await issueQris(fx, order.id);
    expect(qr.amountIdr).toBe(23_000);
    // Rp 10.000 DP + Rp 0 captured < Rp 33.000: completing is refused by the hold.
    expectHoldActive(
      await fx.post(`${fx.base}/${order.id}/complete`, {
        expectedStatus: fired,
        idempotencyKey: randomUUID(),
      }),
    );
    await payNotice(fx, qr.intentId, 23_000, new Date(), qr.providerRef!);
    // Cash for a bill that is already covered is refused.
    const status = (await readBill(fx, order.id)).status;
    const extra = await fx.tender(order.id, status, "cash", 5_000);
    expect(extra.status, JSON.stringify(extra.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect(await capturedIdr(fx, order.id)).toBe(23_000);
    const done = await fx.post(`${fx.base}/${order.id}/complete`, {
      expectedStatus: status,
      idempotencyKey: randomUUID(),
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const totals = await assertInvariants(fx, order.id);
    expect(totals).toMatchObject({
      totalIdr: 33_000,
      depositIdr: 10_000,
      capturedIdr: 23_000,
    });
    expect((await readBill(fx, order.id)).status).toBe("completed");
  });

  it("I2 at most one active hold per bill: concurrent QR requests and a unique partial index", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const results = await Promise.all([
      requestQris(fx, order.id),
      requestQris(fx, order.id),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const refused = results.find((r) => r.status === 409)!;
    expectHoldActive(refused);
    expect((await activeHolds(order.id)).length).toBe(1);

    const { rows } = await owner.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename='pos_qris_holds'`,
    );
    const guard = rows.find(
      (r) =>
        /UNIQUE/i.test(r.indexdef) &&
        /order_id/.test(r.indexdef) &&
        /cancelling/.test(r.indexdef),
    );
    expect(
      guard,
      "pos_qris_holds needs a unique partial index on (tenant_id, order_id) for open/cancelling",
    ).toBeDefined();
    await assertInvariants(fx, order.id);
  });

  it("I3 while a hold is active the bill money and its tenders do not change", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    const snapshot = async () => ({
      bill: await readBill(fx, order.id),
      tenders: await tenderStatuses(fx, order.id),
      captured: await capturedIdr(fx, order.id),
    });
    const before = await snapshot();
    expectHoldActive(await fx.tender(order.id, order.status, "cash", 33_000));
    expectHoldActive(await requestQris(fx, order.id));
    expect(await rawSetDeposit(fx, order.id, 10_000)).toMatchObject({
      ok: false,
    });
    expect(
      await rawWrite(
        fx,
        `UPDATE orders SET total_idr = total_idr + 1000 WHERE tenant_id=$1 AND id=$2`,
        [fx.tenant.tenantId, ulidToUuid(order.id)],
      ),
    ).toMatchObject({ ok: false });
    expect(
      await rawWrite(
        fx,
        `UPDATE pos_order_tenders SET status='voided' WHERE tenant_id=$1 AND id=$2`,
        [fx.tenant.tenantId, qr.tenderId],
      ),
    ).toMatchObject({ ok: false });
    expect(await snapshot()).toEqual(before);
    expect(before.bill.totalIdr).toBe(33_000);
    await assertInvariants(fx, order.id);
  });

  it("I4 a hold closes only with provider evidence: no timeout, no 01, no early 02, no local expiry", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    expect((await postCancel(fx, order.id)).status).toBe(202);
    const stillCancelling = async (why: string) => {
      const hold = await readHold(fx, order.id);
      expect(hold?.state, why).toBe("cancelling");
      expect(hold?.closeEvidence, why).toBeNull();
    };

    fx.gateway.script(qr.intentId, { error: "timeout" });
    await runHoldCheck(fx, afterExpiry(qr, 10 * 60));
    await stillCancelling("provider timeout");

    fx.gateway.script(qr.intentId, { rawStatus: "01" });
    await runHoldCheck(fx, afterExpiry(qr, 5 * 3600));
    await stillCancelling("provider still processing (01)");

    fx.gateway.script(qr.intentId, { status: "expired" });
    await runHoldCheck(fx, afterExpiry(qr, HOLD_CLOSE_MARGIN_S - 30));
    await stillCancelling("expired before expires_at + 60 s");

    await expireNotice(fx, qr.intentId, afterExpiry(qr, 5 * 3600));
    await stillCancelling("local payment.expired");
    expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual([
      "authorized",
    ]);

    await runHoldCheck(fx, afterExpiry(qr, HOLD_CLOSE_MARGIN_S + 1));
    const closed = await readHold(fx, order.id);
    expect(closed?.state).toBe("closed");
    expect(closed?.closeEvidence).not.toBeNull();
    expect(JSON.stringify(closed?.closeEvidence)).toContain(qr.providerRef!);
    await assertInvariants(fx, order.id);
  });

  it("I5 a paid notice is captured only for an active matching hold; closed hold and wrong amount are parked", async () => {
    // Active hold, matching amount: captured once.
    const ok = await newSubmittedOrder(fx, 10_000);
    const okQr = await issueQris(fx, ok.id);
    await payNotice(fx, okQr.intentId, 23_000);
    expect(await capturedIdr(fx, ok.id)).toBe(23_000);
    expect((await readHold(fx, ok.id))?.state).toBe("paid");
    await assertInvariants(fx, ok.id);

    // Wrong amount: parked, not captured.
    const wrong = await newSubmittedOrder(fx, 10_000);
    const wrongQr = await issueQris(fx, wrong.id);
    await payParkedNotice(fx, wrongQr.intentId, 20_000);
    expect(await capturedIdr(fx, wrong.id)).toBe(0);
    expect(
      (await unallocatedFunds(fx, wrongQr.intentId)).map((p) => p.amountIdr),
    ).toEqual([20_000]);
    await assertInvariants(fx, wrong.id);

    // Closed hold: parked, not captured, no refund.
    const closed = await newSubmittedOrder(fx, 0);
    const { qr, at } = await issueAndCloseByProvider(closed.id);
    await payParkedNotice(
      fx,
      qr.intentId,
      33_000,
      new Date(at.getTime() + 60_000),
      qr.providerRef!,
    );
    expect(await capturedIdr(fx, closed.id)).toBe(0);
    expect(
      (await unallocatedFunds(fx, qr.intentId)).map((p) => p.amountIdr),
    ).toEqual([33_000]);
    expect(await refundsOfIntent(fx, qr.intentId)).toEqual([]);
    await assertInvariants(fx, closed.id);
  });

  it("I6 each provider payment is captured at most once, however often it is delivered", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    for (let i = 0; i < 3; i += 1)
      await payNotice(fx, qr.intentId, 33_000, new Date(), qr.providerRef!, {
        deliveries: 3,
      });
    // A different provider transaction for the same QR (the customer paid
    // twice): never a second capture.
    await payParkedNotice(fx, qr.intentId, 33_000);
    const statuses = (await tenderStatuses(fx, order.id)).map((t) => t.status);
    expect(statuses).toEqual(["captured"]);
    expect(await capturedIdr(fx, order.id)).toBe(33_000);
    expect(await evidenceCount(qr.intentId)).toBeGreaterThanOrEqual(1);
    await assertInvariants(fx, order.id);
  });
});
