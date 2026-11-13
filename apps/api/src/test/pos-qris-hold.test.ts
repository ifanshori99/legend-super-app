// QRIS hold acceptance tests, part QA (design legend-yhia9, qris.md §3 D-01..D-06,
// §4 state machine, §7 case table, §8). FAIL-FIRST: the hold does not exist yet.
//
// Written from the design and the public contract only. Red is meant to be a
// behaviour assertion (409 QRIS_HOLD_ACTIVE expected, got 201 / ok:true; tender
// stays `authorized`; ...) or readHold's clear "pos_qris_holds does not exist"
// when the test is about the hold row itself.
//
// Ids: the design table has no QH-02 row (case 2 is QRIS-DP-MONEY-01 in
// pos-qris-deposit-money.test.ts). QH-02 here is the hold side of that case
// (hold amount and basis for a bill with a DP).
//
// Money: the cashier fixture bill is Nasi Goreng Rp30.000 + PBJT 10% =
// Rp33.000 with no service charge or rounding (QH-01 pins that number). DP
// values are explicit in each test; the remainder is `total - DP`.
//
// Founder answers (13 Nov): Q92 the QR lives 5 minutes at the cashier
// (QR_LIFETIME_MIN, QH-25); the hold closes only at or after expires_at + 60 s
// (HOLD_CLOSE_MARGIN_S). Times are driven by the controllable clock, never by
// sleeping: the job, the paid notice and the local expiry all take `now`.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema, ulidToUuid, userIdSchema } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { setStaffPin } from "../services/device-pin.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { owner } from "./floor-test-helpers.ts";
import { agent, signUp } from "./helpers.ts";
import {
  HOLD_CLOSE_MARGIN_S,
  QR_LIFETIME_MIN,
  assertInvariants,
  capturedIdr,
  expireNotice,
  getQris,
  holdFixture,
  issueQris,
  newSubmittedOrder,
  payNotice,
  postCancel,
  rawSetDeposit,
  rawWrite,
  readBill,
  readHold,
  refundsOfIntent,
  requestQris,
  resetHoldPorts,
  runHoldCheck,
  tenderStatuses,
  unallocatedFunds,
  type HoldFixture,
  type IssuedQris,
  type RawWrite,
} from "./pos-qris-hold-test-helpers.ts";

/** The cashier fixture bill: Rp30.000 meal + 10% PBJT. Asserted in QH-01. */
const BILL_IDR = 33_000;
const SUPERVISOR_PIN = "582914";

let fx: HoldFixture;
beforeAll(async () => {
  fx = await holdFixture("qris-hold");
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

// ---------------------------------------------------------------- local helpers

const errorCode = (body: { error?: { code?: string }; code?: string }) =>
  body?.error?.code ?? body?.code;

/** `seconds` after the QR's `expires_at` (negative = before it). */
const at = (qr: IssuedQris, seconds: number) =>
  new Date(qr.expiresAt.getTime() + seconds * 1000);

function expectHoldActive(response: {
  status: number;
  body: { error?: { code?: string }; code?: string };
}) {
  expect(response.status, JSON.stringify(response.body)).toBe(409);
  expect(errorCode(response.body), JSON.stringify(response.body)).toBe(
    "QRIS_HOLD_ACTIVE",
  );
}

function expectRawHoldActive(write: RawWrite, what: string) {
  expect(write, `${what} must be refused while the QR is collectible`).toEqual(
    expect.objectContaining({ ok: false }),
  );
  if (write.ok === false) expect(write.message).toContain("QRIS_HOLD_ACTIVE");
}

async function intentStatus(qr: IssuedQris) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM payment_intents WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, qr.intentId],
  );
  return rows[0]?.status;
}

/** Nobody is owed anything: no refund and no parked money for the intent. */
async function expectNothingOwed(qr: IssuedQris) {
  expect(await refundsOfIntent(fx, qr.intentId)).toEqual([]);
  expect(await unallocatedFunds(fx, qr.intentId)).toEqual([]);
}

/** The job asks the provider; a scripted provider error is the provider's
 * failure, not the job's, so only that one is tolerated here. */
async function checkAt(now: Date) {
  try {
    await runHoldCheck(fx, now);
  } catch (error) {
    if (!/scripted/.test(String(error))) throw error;
  }
}

/** Fire every held line so the bill is `sent` and `complete` is a valid
 * transition. Returns the bill status afterwards. */
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

/** Manager PIN approval for voiding one order (pos-overrides flow). */
let supervisorUserId: string | null = null;
async function voidApproval(orderId: string, valueIdr: number) {
  const context = establishTenantContext({
    tenantId: tenantIdSchema.parse(fx.tenant.tenantId),
    brandId: null,
    source: "session",
  });
  if (!supervisorUserId) {
    await owner.query(
      "UPDATE roles SET permissions = permissions || $2::jsonb WHERE id = $1",
      [fx.tenant.roleId, JSON.stringify(["pos.void.request"])],
    );
    const client = agent(fx.app);
    await signUp(client, "QRIS Hold Supervisor");
    const session = await client.get("/api/auth/get-session");
    supervisorUserId = session.body.user.id as string;
    const roleId = randomUUID();
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'Supervisor Hold Uji', false, NULL, $3, false, '["tenant"]')`,
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
      [fx.tenant.tenantId, supervisorUserId, roleId],
    );
    await setStaffPin(
      context,
      supervisorUserId,
      { outletId: fx.tenant.outletId, userId: supervisorUserId },
      { pin: SUPERVISOR_PIN },
    );
  }
  const { override } = await createPosOverride(
    context,
    fx.staff.userId,
    {
      outletId: fx.tenant.outletId,
      action: "void",
      valueIdr,
      reason: "Pelanggan salah pesan",
      objectType: "order",
      objectId: orderId,
      approval: {
        method: "supervisor_pin",
        approverUserId: userIdSchema.parse(supervisorUserId),
        pin: SUPERVISOR_PIN,
      },
    } as Parameters<typeof createPosOverride>[2],
    { idempotencyKey: randomUUID() },
  );
  expect(override.status).toBe("approved");
  return { approvedBy: supervisorUserId, overrideId: override.id as string };
}

// ----------------------------------------------------------------------- tests

describe("QRIS hold: apply and freeze (legend-yhia9)", () => {
  it("QH-01 no DP: the QR is for the whole bill, a hold opens with it, and the paid notice is captured once (Rp33.000)", async () => {
    const order = await newSubmittedOrder(fx, 0);
    expect(order.totalIdr).toBe(BILL_IDR);
    const qr = await issueQris(fx, order.id);
    expect(qr.amountIdr).toBe(33_000);
    expect(fx.gateway.requests.at(-1)?.amountIdr).toBe(33_000);

    const open = await readHold(fx, order.id);
    expect(open).toMatchObject({
      state: "open",
      amountIdr: 33_000,
      basisTotalIdr: 33_000,
      basisDepositIdr: 0,
      basisCapturedIdr: 0,
      tenderId: qr.tenderId,
      paymentIntentId: qr.intentId,
    });
    expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual([
      "authorized",
    ]);

    await payNotice(fx, qr.intentId, 33_000);

    expect(await capturedIdr(fx, order.id)).toBe(33_000);
    expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual([
      "captured",
    ]);
    const paid = await readHold(fx, order.id);
    expect(paid?.state).toBe("paid");
    expect(paid?.closeReason).toBe("provider_paid");
    expect(paid?.closedAt).not.toBeNull();
    await expectNothingOwed(qr);
    const sums = await assertInvariants(fx, order.id);
    expect(sums).toMatchObject({
      totalIdr: 33_000,
      depositIdr: 0,
      capturedIdr: 33_000,
      activeHolds: 0,
    });
  });

  it("QH-02 DP Rp10.000: the hold records the remainder Rp23.000 and its basis, and the paid notice settles the bill with the DP", async () => {
    const order = await newSubmittedOrder(fx, 10_000);
    expect(order.totalIdr).toBe(BILL_IDR);
    const qr = await issueQris(fx, order.id);
    expect(qr.amountIdr).toBe(23_000);
    expect(await readHold(fx, order.id)).toMatchObject({
      state: "open",
      amountIdr: 23_000,
      basisTotalIdr: 33_000,
      basisDepositIdr: 10_000,
      basisCapturedIdr: 0,
    });

    await payNotice(fx, qr.intentId, 23_000);

    expect(await capturedIdr(fx, order.id)).toBe(23_000);
    expect((await readHold(fx, order.id))?.state).toBe("paid");
    expect(await readBill(fx, order.id)).toMatchObject({
      totalIdr: 33_000,
      depositIdr: 10_000,
    });
    await expectNothingOwed(qr);
    const sums = await assertInvariants(fx, order.id);
    // Customer paid Rp10.000 (DP) + Rp23.000 (QR) = the bill, not a rupiah more.
    expect(sums.capturedIdr + sums.depositIdr).toBe(33_000);
  });

  it("QH-03 a DP cannot be attached or changed while the QR is open or cancelling (QRIS_HOLD_ACTIVE)", async () => {
    // No DP yet: attaching Rp10.000 under a Rp33.000 QR would make the QR wrong.
    const plain = await newSubmittedOrder(fx, 0);
    const plainQr = await issueQris(fx, plain.id);
    expectRawHoldActive(
      await rawSetDeposit(fx, plain.id, 10_000),
      "attaching a DP to a bill with an open QR",
    );
    expect(await readBill(fx, plain.id)).toMatchObject({ depositIdr: 0 });
    expect((await readHold(fx, plain.id))?.state).toBe("open");

    // Same refusal once the cashier cancelled and the hold is cancelling.
    const cancelled = await postCancel(fx, plain.id);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(202);
    expect((await readHold(fx, plain.id))?.state).toBe("cancelling");
    expectRawHoldActive(
      await rawSetDeposit(fx, plain.id, 10_000),
      "attaching a DP to a bill with a cancelling QR",
    );
    expect(await readBill(fx, plain.id)).toMatchObject({ depositIdr: 0 });
    expect((await readHold(fx, plain.id))?.amountIdr).toBe(33_000);
    expect(await refundsOfIntent(fx, plainQr.intentId)).toEqual([]);
    await assertInvariants(fx, plain.id);

    // A DP that already exists cannot grow or shrink under the QR either.
    const withDp = await newSubmittedOrder(fx, 10_000);
    const dpQr = await issueQris(fx, withDp.id);
    expect(dpQr.amountIdr).toBe(23_000);
    expectRawHoldActive(
      await rawSetDeposit(fx, withDp.id, 20_000),
      "growing the DP under an open QR",
    );
    expectRawHoldActive(
      await rawSetDeposit(fx, withDp.id, 0),
      "dropping the DP under an open QR",
    );
    expect(await readBill(fx, withDp.id)).toMatchObject({
      totalIdr: 33_000,
      depositIdr: 10_000,
    });
    expect((await readHold(fx, withDp.id))?.amountIdr).toBe(23_000);
    expect(await capturedIdr(fx, withDp.id)).toBe(0);
    await assertInvariants(fx, withDp.id);
  });

  it("QH-04 the bill's money columns cannot be changed in the database while the QR is collectible", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);

    // Raw writes first: today's code lets each of them through (ok: true),
    // so red is "must be refused with QRIS_HOLD_ACTIVE", not a legacy message.
    for (const column of [
      "subtotal_idr",
      "discount_idr",
      "service_charge_idr",
      "tax_idr",
      "rounding_idr",
      "total_idr",
    ])
      expectRawHoldActive(
        await rawWrite(
          fx,
          `UPDATE orders SET ${column} = ${column} + 1 WHERE tenant_id=$1 AND id=$2`,
          [fx.tenant.tenantId, ulidToUuid(order.id)],
        ),
        `raw change of ${column}`,
      );

    expect(await readBill(fx, order.id)).toEqual({
      totalIdr: 33_000,
      depositIdr: 0,
      status: order.status,
    });
    expect((await readHold(fx, order.id))?.amountIdr).toBe(33_000);
    expect(
      (await tenderStatuses(fx, order.id)).map((t) => [t.status, t.amount]),
    ).toEqual([["authorized", 33_000]]);
    await expectNothingOwed(qr);
    await assertInvariants(fx, order.id);
  });

  it("QH-04 a discount through the API is refused with 409 QRIS_HOLD_ACTIVE while the QR is collectible", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);

    // A 5% manual discount is below the approval threshold (10%). Today the
    // answer is the legacy CONFLICT ("total pesanan tidak dapat diubah"); the
    // contract of the hold is the code QRIS_HOLD_ACTIVE.
    const discount = await fx.post(`${fx.base}/${order.id}/discounts`, {
      source: "manual",
      kind: "percent",
      percentBp: 500,
      reason: "manager_goodwill",
      reasonNote: "Pelanggan tetap",
      idempotencyKey: randomUUID(),
    });
    expectHoldActive(discount);

    expect(await readBill(fx, order.id)).toEqual({
      totalIdr: 33_000,
      depositIdr: 0,
      status: order.status,
    });
    expect((await readHold(fx, order.id))?.amountIdr).toBe(33_000);
    await expectNothingOwed(qr);
    await assertInvariants(fx, order.id);
  });

  it("QH-05 cash is refused while the QR is open or cancelling, and the QR stays the only way to pay Rp33.000", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);

    const cashOpen = await fx.tender(order.id, order.status, "cash", 33_000);
    expectHoldActive(cashOpen);

    const cancelled = await postCancel(fx, order.id);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(202);
    const cashCancelling = await fx.tender(
      order.id,
      order.status,
      "cash",
      33_000,
    );
    expectHoldActive(cashCancelling);
    // A second QR is refused too (one active hold per bill).
    expectHoldActive(await requestQris(fx, order.id));

    expect(
      (await tenderStatuses(fx, order.id)).map((t) => [t.method, t.status]),
    ).toEqual([["qris", "authorized"]]);
    expect(await capturedIdr(fx, order.id)).toBe(0);
    expect((await readHold(fx, order.id))?.state).toBe("cancelling");

    // The customer can still pay that QR and is charged once.
    await payNotice(fx, qr.intentId, 33_000);
    expect(await capturedIdr(fx, order.id)).toBe(33_000);
    await expectNothingOwed(qr);
    await assertInvariants(fx, order.id);
  });

  it("QH-06 the bill cannot be completed while the QR is collectible", async () => {
    // Bring the bill to a status where `complete` is a valid transition (items
    // fired, status `sent`); with the captain fixture's held items the status
    // is not completable and today answers ORDER_TRANSITION_INVALID, which
    // would hide the missing behaviour. Today a completable bill with only an
    // authorized QR still fails the balance check (no 200 is possible), so red
    // here reads "expected QRIS_HOLD_ACTIVE, got TENDER_TOTAL_MISMATCH".
    const order = await newSubmittedOrder(fx, 0);
    const status = await fireAllItems(order.id, order.status);
    const qr = await issueQris(fx, order.id);

    const completed = await fx.post(`${fx.base}/${order.id}/complete`, {
      expectedStatus: status,
      idempotencyKey: randomUUID(),
    });
    // Assumption: the guard runs right after the order lock, before the
    // balance check, so the hold answer wins.
    expectHoldActive(completed);

    expect((await readBill(fx, order.id)).status).not.toBe("completed");
    expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual([
      "authorized",
    ]);
    expect((await readHold(fx, order.id))?.state).toBe("open");
    await expectNothingOwed(qr);
    await assertInvariants(fx, order.id);
  });

  it("QH-06 the bill cannot be voided while the QR is collectible", async () => {
    // Today a void with a valid manager approval is accepted (200) and voids
    // the QR tender locally: that is the money hole the hold closes.
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);

    const approval = await voidApproval(order.id, 33_000);
    const voided = await fx.post(`${fx.base}/${order.id}/void`, {
      reason: "customer_cancelled",
      reasonNote: "Pelanggan batal",
      expectedStatus: order.status,
      idempotencyKey: randomUUID(),
      ...approval,
    });
    expectHoldActive(voided);

    expect((await readBill(fx, order.id)).status).toBe(order.status);
    expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual([
      "authorized",
    ]);
    expect((await readHold(fx, order.id))?.state).toBe("open");
    await expectNothingOwed(qr);
    await assertInvariants(fx, order.id);
  });

  it("QH-06 the bill's status cannot be moved to completed or voided in the database while the QR is collectible", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);

    for (const status of ["voided", "completed"])
      expectRawHoldActive(
        await rawWrite(
          fx,
          "UPDATE orders SET status=$3 WHERE tenant_id=$1 AND id=$2",
          [fx.tenant.tenantId, ulidToUuid(order.id), status],
        ),
        `raw status ${status}`,
      );

    expect((await readBill(fx, order.id)).status).toBe(order.status);
    expect((await readHold(fx, order.id))?.state).toBe("open");
    await expectNothingOwed(qr);
    await assertInvariants(fx, order.id);
  });

  it("QH-07 cashier cancels, the customer had already paid: the notice during cancelling is captured once, no refund", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);

    const cancelled = await postCancel(fx, order.id);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(202);
    const hold = await readHold(fx, order.id);
    expect(hold?.state).toBe("cancelling");
    expect(hold?.cancelRequestedAt).not.toBeNull();
    expect(hold?.cancelRequestedBy).toBe(fx.staff.userId);
    // The tender stays authorized and the intent pending: cancel only hides
    // the QR, it never voids locally (D-04).
    expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual([
      "authorized",
    ]);
    expect(await intentStatus(qr)).toBe("pending");
    // Assumption on the read model: GET .../qris answers the hold state.
    const read = await getQris(fx, order.id);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.data.state).toBe("cancelling");
    expect(read.body.data.amountIdr).toBe(33_000);

    await payNotice(fx, qr.intentId, 33_000);

    expect(await capturedIdr(fx, order.id)).toBe(33_000);
    expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual([
      "captured",
    ]);
    expect((await readHold(fx, order.id))?.state).toBe("paid");
    // The consumer never completes the bill; the cashier does (D-05).
    expect((await readBill(fx, order.id)).status).not.toBe("completed");
    await expectNothingOwed(qr);
    const sums = await assertInvariants(fx, order.id);
    expect(sums.capturedIdr + sums.depositIdr).toBe(33_000);
  });

  it("QH-08 cancel, provider says 02 after expires_at + 60 s: the hold closes, a DP is attached, and the new QR for Rp23.000 is paid", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    fx.gateway.script(qr.intentId, { rawStatus: "02" });
    const cancelled = await postCancel(fx, order.id);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(202);

    await checkAt(at(qr, HOLD_CLOSE_MARGIN_S + 1));

    const closed = await readHold(fx, order.id);
    expect(closed?.state).toBe("closed");
    expect(["provider_expired", "provider_failed"]).toContain(
      closed?.closeReason,
    );
    // Evidence is stored: the provider's own code and the reference.
    expect(JSON.stringify(closed?.closeEvidence)).toContain("02");
    expect(JSON.stringify(closed?.closeEvidence)).toContain(
      qr.providerRef ?? "no-provider-ref",
    );
    expect(await tenderStatuses(fx, order.id)).toEqual([
      expect.objectContaining({ status: "voided", amount: 33_000 }),
    ]);
    expect(["expired", "failed"]).toContain(await intentStatus(qr));
    expect(await capturedIdr(fx, order.id)).toBe(0);

    // The bill is unlocked: a DP of Rp10.000 can now be attached.
    await attachDepositOrThrow(order.id, 10_000);
    const second = await issueQris(fx, order.id);
    expect(second.amountIdr).toBe(23_000);
    expect(second.intentId).not.toBe(qr.intentId);
    expect(await readHold(fx, order.id)).toMatchObject({
      state: "open",
      amountIdr: 23_000,
      basisTotalIdr: 33_000,
      basisDepositIdr: 10_000,
      basisCapturedIdr: 0,
    });

    await payNotice(fx, second.intentId, 23_000);

    expect(await capturedIdr(fx, order.id)).toBe(23_000);
    await expectNothingOwed(qr);
    await expectNothingOwed(second);
    const sums = await assertInvariants(fx, order.id);
    expect(sums.capturedIdr + sums.depositIdr).toBe(33_000);
    expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual([
      "voided",
      "captured",
    ]);
  });

  it("QH-09 provider 02 before expires_at (or inside the 60 s margin) never closes the hold and never lets a second QR in", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    const gatewayCalls = fx.gateway.requests.length;
    fx.gateway.script(qr.intentId, { rawStatus: "02" });
    try {
      // Open, not cancelled: a failed attempt may be retried on the same QR.
      await checkAt(at(qr, -120));
      expect(fx.gateway.readsOf(qr.intentId).length).toBeGreaterThanOrEqual(1);
      expect((await readHold(fx, order.id))?.state).toBe("open");

      const cancelled = await postCancel(fx, order.id);
      expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(202);
      await checkAt(at(qr, -1));
      expect((await readHold(fx, order.id))?.state).toBe("cancelling");
      // Clock skew margin: still 1 s short of expires_at + 60 s.
      await checkAt(at(qr, HOLD_CLOSE_MARGIN_S - 1));
      expect((await readHold(fx, order.id))?.state).toBe("cancelling");

      // Still frozen, tender still collectible, no new QR, no new gateway call.
      expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual(
        ["authorized"],
      );
      expectRawHoldActive(
        await rawSetDeposit(fx, order.id, 10_000),
        "DP under a hold the provider has not closed",
      );
      expectHoldActive(await requestQris(fx, order.id));
      expect(fx.gateway.requests).toHaveLength(gatewayCalls);
      expect(await capturedIdr(fx, order.id)).toBe(0);

      // The same answer after the margin is what closes it.
      await checkAt(at(qr, HOLD_CLOSE_MARGIN_S + 1));
      expect((await readHold(fx, order.id))?.state).toBe("closed");
    } finally {
      fx.gateway.script(qr.intentId, { rawStatus: "01" });
    }
    await expectNothingOwed(qr);
    await assertInvariants(fx, order.id);
  });

  it("QH-10 provider timeout, 5xx, answer about another reference or still pending never close the hold, even long after expiry", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    const cancelled = await postCancel(fx, order.id);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(202);

    const later = at(qr, HOLD_CLOSE_MARGIN_S + 5);
    try {
      for (const answer of [
        { error: "timeout" },
        { error: "5xx" },
        { otherReference: true },
        { rawStatus: "01" },
      ] as const) {
        fx.gateway.script(qr.intentId, answer);
        const readsBefore = fx.gateway.readsOf(qr.intentId).length;
        await checkAt(later);
        // The job really asked the provider, and stayed frozen.
        expect(
          fx.gateway.readsOf(qr.intentId).length,
          `job asked the provider for ${JSON.stringify(answer)}`,
        ).toBeGreaterThan(readsBefore);
        expect(
          (await readHold(fx, order.id))?.state,
          JSON.stringify(answer),
        ).toBe("cancelling");
        expect(
          (await tenderStatuses(fx, order.id)).map((t) => t.status),
        ).toEqual(["authorized"]);
        expectRawHoldActive(
          await rawSetDeposit(fx, order.id, 10_000),
          `DP while provider answered ${JSON.stringify(answer)}`,
        );
      }
      expect(await capturedIdr(fx, order.id)).toBe(0);

      // Control: the right answer from the provider does close it, so the
      // "stays" above is not a job that simply never works.
      fx.gateway.script(qr.intentId, { rawStatus: "02" });
      await checkAt(later);
      expect((await readHold(fx, order.id))?.state).toBe("closed");
    } finally {
      fx.gateway.script(qr.intentId, { rawStatus: "01" });
    }
    await expectNothingOwed(qr);
    await assertInvariants(fx, order.id);
  });

  it("QH-11 intent marked expired locally while the hold is active, then the provider says paid: applied once (Rp33.000), no refund", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);

    // The existing poll expires the intent on the local clock.
    await expireNotice(fx, qr.intentId, at(qr, 1));
    expect(await intentStatus(qr)).toBe("expired");
    expect((await readHold(fx, order.id))?.state).toBe("open");
    expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual([
      "authorized",
    ]);

    await payNotice(fx, qr.intentId, 33_000, at(qr, 30));

    expect(await capturedIdr(fx, order.id)).toBe(33_000);
    expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual([
      "captured",
    ]);
    const hold = await readHold(fx, order.id);
    expect(hold?.state).toBe("paid");
    expect(hold?.closeReason).toBe("provider_paid");
    await expectNothingOwed(qr);
    const sums = await assertInvariants(fx, order.id);
    expect(sums.capturedIdr + sums.depositIdr).toBe(33_000);
  });
});

describe("QRIS hold: payment.expired and the hold check job (legend-yhia9)", () => {
  it("QH-23 payment.expired at expires_at + 1 s changes nothing while the hold is active: tender stays authorized and the consumer does not fail", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);

    const expired = await expireNotice(fx, qr.intentId, at(qr, 1));
    expect(expired.events).toBe(1);

    // Tender first: today the consumer voids it (the behaviour to remove).
    expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual([
      "authorized",
    ]);
    expect((await readHold(fx, order.id))?.state).toBe("open");
    expectRawHoldActive(
      await rawSetDeposit(fx, order.id, 10_000),
      "DP after a local payment.expired",
    );
    expect(await capturedIdr(fx, order.id)).toBe(0);
    await expectNothingOwed(qr);
    await assertInvariants(fx, order.id);
  });

  it("QH-24 DOIT: only a provider expired or failed status at or after expires_at + 60 s closes the hold; pending and early answers do not", async () => {
    for (const status of ["expired", "failed"] as const) {
      const order = await newSubmittedOrder(fx, 0);
      const qr = await issueQris(fx, order.id);
      expect(qr.provider).toBe("doit");
      const cancelled = await postCancel(fx, order.id);
      expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(202);
      try {
        fx.gateway.script(qr.intentId, { status: "pending" });
        await checkAt(at(qr, HOLD_CLOSE_MARGIN_S + 5));
        expect((await readHold(fx, order.id))?.state).toBe("cancelling");

        fx.gateway.script(qr.intentId, { status });
        await checkAt(at(qr, HOLD_CLOSE_MARGIN_S - 1));
        expect(
          (await readHold(fx, order.id))?.state,
          `${status} before the margin`,
        ).toBe("cancelling");

        await checkAt(at(qr, HOLD_CLOSE_MARGIN_S + 1));
        const closed = await readHold(fx, order.id);
        expect(closed?.state, `${status} after the margin`).toBe("closed");
        expect(closed?.closeReason).toMatch(/^provider_(expired|failed)$/);
        expect(
          (await tenderStatuses(fx, order.id)).map((t) => t.status),
        ).toEqual(["voided"]);
      } finally {
        fx.gateway.script(qr.intentId, { rawStatus: "01" });
      }
      await expectNothingOwed(qr);
      await assertInvariants(fx, order.id);
    }
  });
});

describe("QRIS hold: Q92 five minute lifetime (legend-yhia9)", () => {
  it(`QH-25 the cashier QR expires exactly ${QR_LIFETIME_MIN} minutes after it is issued, per tender, and the provider gets that expiry`, async () => {
    // Two different bills, each with its own tender: both get the short life.
    for (const dp of [0, 10_000]) {
      const order = await newSubmittedOrder(fx, dp);
      const before = Date.now();
      const qr = await issueQris(fx, order.id);
      const after = Date.now();
      const lifetimeMs = QR_LIFETIME_MIN * 60_000;
      // 1 s slack for millisecond rounding of the stored timestamp.
      expect(qr.expiresAt.getTime()).toBeGreaterThanOrEqual(
        before + lifetimeMs - 1_000,
      );
      expect(qr.expiresAt.getTime()).toBeLessThanOrEqual(
        after + lifetimeMs + 1_000,
      );
      const asked = fx.gateway.requests.at(-1);
      expect(asked?.intentId).toBe(qr.intentId);
      expect(new Date(String(asked?.expiresAt)).getTime()).toBe(
        qr.expiresAt.getTime(),
      );
      await assertInvariants(fx, order.id);
    }
  });

  it("QH-25 a QR-table (guest) QRIS intent keeps the existing 10 minute lifetime", async () => {
    // The shorter life is a cashier decision per tender; the shared intent
    // lifetime (INTENT_LIFETIME_MIN.qris, not exported) stays 10 minutes.
    const guest = await fx.newGuest();
    const order = await fx.qrOrder(guest);
    const before = Date.now();
    const paid = await fx.guestPost(guest, "/payments", {
      target: { kind: "order", orderId: order.id },
      method: "qris",
      idempotencyKey: randomUUID(),
    });
    const after = Date.now();
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const { rows } = await owner.query<{ expires_at: Date }>(
      "SELECT expires_at FROM payment_intents WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, paid.body.data.id],
    );
    const tenMinutesMs = 10 * 60_000;
    expect(rows[0]!.expires_at.getTime()).toBeGreaterThanOrEqual(
      before + tenMinutesMs - 1_000,
    );
    expect(rows[0]!.expires_at.getTime()).toBeLessThanOrEqual(
      after + tenMinutesMs + 1_000,
    );
  });

  it("QH-25 after a cancel the bill unlocks within about 6 minutes of issuing the QR (5 min life + 60 s margin)", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    const issuedBy = Date.now();
    fx.gateway.script(qr.intentId, { rawStatus: "02" });
    const cancelled = await postCancel(fx, order.id);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(202);

    await checkAt(new Date(issuedBy + 6 * 60_000 + 5_000));

    expect((await readHold(fx, order.id))?.state).toBe("closed");
    // The cashier can take cash for the full Rp33.000 now.
    const cash = await fx.tender(order.id, order.status, "cash", 33_000);
    expect(cash.status, JSON.stringify(cash.body)).toBe(201);
    expect(await capturedIdr(fx, order.id)).toBe(33_000);
    await expectNothingOwed(qr);
    await assertInvariants(fx, order.id);
  });
});

describe("QRIS hold: Duitku evidence (legend-yhia9)", () => {
  let duitku: HoldFixture;
  beforeAll(async () => {
    // Installs a Duitku-named scripted gateway; earlier describes are done.
    duitku = await holdFixture("qris-hold-duitku", { provider: "duitku" });
  });

  it("QH-24 Duitku: a mapped expired without the raw code never closes the hold; raw 02 at or after expires_at + 60 s does", async () => {
    const order = await newSubmittedOrder(duitku, 0);
    const qr = await issueQris(duitku, order.id);
    expect(qr.provider).toBe("duitku");
    const cancelled = await postCancel(duitku, order.id);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(202);
    const closeCheck = async (now: Date) => {
      try {
        await runHoldCheck(duitku, now);
      } catch (error) {
        if (!/scripted/.test(String(error))) throw error;
      }
    };
    try {
      // Mapped status only (what the port returns today): not proof for Duitku.
      for (const status of ["expired", "failed"] as const) {
        duitku.gateway.script(qr.intentId, { status });
        const readsBefore = duitku.gateway.readsOf(qr.intentId).length;
        await closeCheck(at(qr, HOLD_CLOSE_MARGIN_S + 5));
        expect(duitku.gateway.readsOf(qr.intentId).length).toBeGreaterThan(
          readsBefore,
        );
        expect(
          (await readHold(duitku, order.id))?.state,
          `mapped ${status} without raw code`,
        ).toBe("cancelling");
      }
      // Raw 02 before the margin: not yet.
      duitku.gateway.script(qr.intentId, { rawStatus: "02" });
      await closeCheck(at(qr, HOLD_CLOSE_MARGIN_S - 1));
      expect((await readHold(duitku, order.id))?.state).toBe("cancelling");
      // Raw 02 after the margin: closed, with the raw code as evidence.
      await closeCheck(at(qr, HOLD_CLOSE_MARGIN_S + 1));
      const closed = await readHold(duitku, order.id);
      expect(closed?.state).toBe("closed");
      expect(JSON.stringify(closed?.closeEvidence)).toContain("02");
      expect(
        (await tenderStatuses(duitku, order.id)).map((t) => t.status),
      ).toEqual(["voided"]);
    } finally {
      duitku.gateway.script(qr.intentId, { rawStatus: "01" });
    }
    expect(await refundsOfIntent(duitku, qr.intentId)).toEqual([]);
    expect(await unallocatedFunds(duitku, qr.intentId)).toEqual([]);
    await assertInvariants(duitku, order.id);
  });
});

/** Attach a DP once the bill has no active hold; fails loudly when refused. */
async function attachDepositOrThrow(orderId: string, dpIdr: number) {
  const result = await rawSetDeposit(fx, orderId, dpIdr);
  expect(result, "after the hold closed the DP must be accepted again").toEqual(
    { ok: true },
  );
}
