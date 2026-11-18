// legend-xb20o (brief 1085, card 3, money): a POS bill with TWO QRIS tenders,
// one whose hold is already `closed` (old QR) and one whose hold is `open`
// (new QR). Written from the bead text, the QRIS hold design (D-01..D-09, Q93)
// and the existing hold test helpers, never from voidPendingQrisTenders.
//
// Invariants proven:
//  - the paid webhook of the active QR must settle (no trigger refusal that
//    leaves the webhook failing and retrying), captures once, and the stale
//    tender ends voided;
//  - no tender is returned twice: per intent, refunds + parked rows <= 1 entry,
//    and money returned never exceeds money paid (captured + returned <= paid);
//  - a manager release of the hold voids every pending QRIS tender of the bill.
//
// Assumptions (bead and design are silent, also reported):
//  - The stale state (old tender still pending although its hold is closed) is
//    reached raw: issue QR A, cancel, close its hold by provider proof, issue
//    QR B through the API (the API refuses B while A is pending), then restore
//    tender A to the status it had when issued, written behind the triggers.
//  - Expected end state when B is paid: B captured Rp 33.000, A voided, no
//    refund, no active hold, bill money not above the total.
//  - A late payment of the OLD QR is either parked or refunded, but only once
//    in total; which one is not pinned.
//  - Manager release body/approval follow pos-qris-hold-anomaly.test.ts.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tenantIdSchema, userIdSchema } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { setStaffPin } from "../services/device-pin.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { owner } from "./floor-test-helpers.ts";
import { agent, signUp } from "./helpers.ts";
import {
  HOLD_CLOSE_MARGIN_S,
  HOLD_RELEASE_AFTER_MIN,
  assertInvariants,
  capturedIdr,
  holdFixture,
  issueQris,
  newSubmittedOrder,
  payNotice,
  postCancel,
  postRelease,
  readHold,
  readHolds,
  refundsOfIntent,
  resetHoldPorts,
  runHoldCheck,
  tenderStatuses,
  unallocatedFunds,
  type HoldFixture,
  type IssuedQris,
  type ManagerApproval,
} from "./pos-qris-hold-test-helpers.ts";

const BILL_IDR = 33_000; // Rp 30.000 meal + 10% PBJT, fixture bill
const SUPERVISOR_PIN = "582914";
vi.setConfig({ testTimeout: 180_000 });

let fx: HoldFixture;
beforeAll(async () => {
  fx = await holdFixture("xb20o-two-qris");
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

const afterExpiry = (qr: IssuedQris, seconds: number) =>
  new Date(qr.expiresAt.getTime() + seconds * 1000);

async function backdateExpiry(qr: IssuedQris, minutesAgo: number) {
  await owner.query(
    `UPDATE payment_intents SET expires_at = now() - $3::int * interval '1 minute'
      WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, qr.intentId, minutesAgo],
  );
}

let supervisorUserId: string | null = null;
async function supervisor(): Promise<string> {
  if (supervisorUserId) return supervisorUserId;
  const client = agent(fx.app);
  await signUp(client, "Manajer Dua QRIS");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Manajer Dua QRIS Uji', false, NULL, $3, false, '["tenant"]')`,
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
  await setStaffPin(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(fx.tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    userId,
    { outletId: fx.tenant.outletId, userId },
    { pin: SUPERVISOR_PIN },
  );
  supervisorUserId = userId;
  return userId;
}

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
      action: "void",
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

/**
 * Bill with two QRIS tenders: A (old, hold closed by provider proof, tender
 * restored to its pending status) and B (new QR, hold open).
 */
async function twoTenderBill() {
  const order = await newSubmittedOrder(fx, 0);
  const a = await issueQris(fx, order.id);
  const pendingStatus = (await tenderStatuses(fx, order.id))[0]!.status;
  expect((await postCancel(fx, order.id)).status).toBe(202);
  fx.gateway.script(a.intentId, { status: "expired" });
  await runHoldCheck(fx, afterExpiry(a, HOLD_CLOSE_MARGIN_S + 1));
  expect((await readHold(fx, order.id))?.state).toBe("closed");
  expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual([
    "voided",
  ]);
  const b = await issueQris(fx, order.id);
  // The API never lets a second QR be issued over a pending one, so the stale
  // state is written behind the freeze (replica role, as pos-order-qris-lifecycle
  // does for a bill changed behind the trigger): tender A back to pending.
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `UPDATE pos_order_tenders SET status=$3, resolved_at=NULL
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, a.tenderId, pendingStatus],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const holds = await readHolds(fx, order.id);
  expect(holds.map((h) => h.state)).toEqual(["closed", "open"]);
  expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual([
    pendingStatus,
    pendingStatus,
  ]);
  return { order, a, b };
}

/** Parked + refunded entries of one intent, whole Rupiah. */
async function returnedOf(intentId: string) {
  const refunds = await refundsOfIntent(fx, intentId);
  const parked = await unallocatedFunds(fx, intentId);
  return {
    entries: refunds.length + parked.length,
    idr:
      refunds.reduce((sum, r) => sum + r.amountIdr, 0) +
      parked.reduce((sum, p) => sum + p.amountIdr, 0),
  };
}

/** The late payment of a closed intent may be answered 409 CONFLICT (parked);
 * any other error fails the test. */
async function payLate(intentId: string, amountIdr: number, ref: string) {
  try {
    return await payNotice(fx, intentId, amountIdr, new Date(), ref);
  } catch (error) {
    const e = error as { code?: unknown; status?: unknown };
    if (e?.code === "CONFLICT" && e?.status === 409) return null;
    throw error;
  }
}

describe("legend-xb20o: two QRIS tenders, one hold closed and one open", () => {
  it("xb20o-1 the paid webhook of the active QR settles: B captured once, stale tender A voided, nothing refunded", async () => {
    const { order, a, b } = await twoTenderBill();
    expect(b.amountIdr).toBe(BILL_IDR);

    // The webhook must not be refused by the freeze trigger (23514
    // QRIS_HOLD_ACTIVE) because the old tender is voided while B's hold is open.
    await payNotice(fx, b.intentId, BILL_IDR, new Date(), b.providerRef!);

    const tenders = await tenderStatuses(fx, order.id);
    expect(tenders.find((t) => t.id === b.tenderId)?.status).toBe("captured");
    expect(tenders.find((t) => t.id === a.tenderId)?.status).toBe("voided");
    expect(await capturedIdr(fx, order.id)).toBe(BILL_IDR);
    expect(await refundsOfIntent(fx, a.intentId)).toEqual([]);
    expect(await refundsOfIntent(fx, b.intentId)).toEqual([]);
    expect((await readHolds(fx, order.id)).map((h) => h.state)).toEqual([
      "closed",
      "paid",
    ]);
    await assertInvariants(fx, order.id);
  });

  it("xb20o-2 replays of that webhook change nothing, and a late payment of the old QR returns its money at most once (returned <= paid)", async () => {
    const { order, a, b } = await twoTenderBill();
    await payNotice(fx, b.intentId, BILL_IDR, new Date(), b.providerRef!);
    // Consumer replay and a duplicate webhook of the same provider payment.
    await payNotice(fx, b.intentId, BILL_IDR, new Date(), b.providerRef!);
    expect(await capturedIdr(fx, order.id)).toBe(BILL_IDR);

    // The guest also paid the old, closed QR: that money is not the bill's.
    await payLate(a.intentId, BILL_IDR, a.providerRef!);
    await payLate(a.intentId, BILL_IDR, a.providerRef!);

    const returnedA = await returnedOf(a.intentId);
    const returnedB = await returnedOf(b.intentId);
    expect(returnedB.entries, "the captured QR is never returned").toBe(0);
    expect(
      returnedA.entries,
      "the old QR's money is returned or parked once, never twice",
    ).toBeLessThanOrEqual(1);
    expect(returnedA.idr).toBeLessThanOrEqual(BILL_IDR);
    const paidIdr = 2 * BILL_IDR;
    expect(
      (await capturedIdr(fx, order.id)) + returnedA.idr + returnedB.idr,
      "captured + returned must not exceed what the guest paid",
    ).toBeLessThanOrEqual(paidIdr);
    expect(await capturedIdr(fx, order.id)).toBe(BILL_IDR);
    await assertInvariants(fx, order.id);
  });

  it("xb20o-3 a manager release of the open hold closes it force_released and voids every pending QRIS tender, then nobody is returned twice", async () => {
    const { order, a, b } = await twoTenderBill();
    await backdateExpiry(b, HOLD_RELEASE_AFTER_MIN + 1);

    const released = await postRelease(
      fx,
      order.id,
      await managerApproval(order.id, BILL_IDR),
    );
    expect(
      released.status,
      JSON.stringify(released.body),
    ).toBeGreaterThanOrEqual(200);
    expect(released.status).toBeLessThan(300);

    const holds = await readHolds(fx, order.id);
    expect(holds.map((h) => h.state)).toEqual(["closed", "closed"]);
    expect(holds[1]?.closeReason).toBe("force_released");
    expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual([
      "voided",
      "voided",
    ]);
    expect(await capturedIdr(fx, order.id)).toBe(0);

    // The guest still pays the released QR: parked or refunded once, in total
    // never more than paid, and the old QR's money is not touched by it.
    await payLate(b.intentId, BILL_IDR, b.providerRef!);
    await payLate(b.intentId, BILL_IDR, b.providerRef!);
    const returnedB = await returnedOf(b.intentId);
    expect(returnedB.entries).toBe(1);
    expect(returnedB.idr).toBeLessThanOrEqual(BILL_IDR);
    expect((await returnedOf(a.intentId)).entries).toBe(0);
    expect(await capturedIdr(fx, order.id)).toBe(0);
    await assertInvariants(fx, order.id);
  });

  it("xb20o-4 two active backfilled holds: the release of the first succeeds and the other tender stays authorized (no trigger refusal)", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const a = await issueQris(fx, order.id);
    expect((await postCancel(fx, order.id)).status).toBe(202);
    fx.gateway.script(a.intentId, { status: "expired" });
    await runHoldCheck(fx, afterExpiry(a, HOLD_CLOSE_MARGIN_S + 1));
    const b = await issueQris(fx, order.id);
    const [holdA, holdB] = await readHolds(fx, order.id);
    // Migration 0401 shape: every provider code that may still be collectible
    // has its own active backfilled hold. H1 (old QR, its tender already
    // voided) sorts first; H2 (new QR) keeps its authorized tender.
    const h1 = "00000000-0000-4000-8000-0000000000a1";
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `UPDATE pos_qris_holds SET id=$3::uuid, backfilled=true, state='open',
                closed_at=NULL, close_reason=NULL, close_evidence=NULL,
                next_check_at=now()
          WHERE tenant_id=$1 AND id=$2`,
        [fx.tenant.tenantId, holdA!.id, h1],
      );
      await client.query(
        `UPDATE pos_qris_holds SET backfilled=true WHERE tenant_id=$1 AND id=$2`,
        [fx.tenant.tenantId, holdB!.id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const before = await tenderStatuses(fx, order.id);
    expect(before.find((t) => t.id === a.tenderId)?.status).toBe("voided");
    expect(before.find((t) => t.id === b.tenderId)?.status).toBe("authorized");
    await backdateExpiry(a, HOLD_RELEASE_AFTER_MIN + 1);
    await backdateExpiry(b, HOLD_RELEASE_AFTER_MIN + 1);

    const released = await postRelease(
      fx,
      order.id,
      await managerApproval(order.id, BILL_IDR),
    );
    expect(released.status, JSON.stringify(released.body)).toBeLessThan(300);

    const holds = await owner.query<{ id: string; state: string }>(
      `SELECT id::text AS id, state FROM pos_qris_holds
        WHERE tenant_id=$1 AND order_id=$2 ORDER BY id`,
      [fx.tenant.tenantId, holdB!.orderId],
    );
    expect(holds.rows.map((h) => [h.id, h.state])).toEqual([
      [h1, "closed"],
      [holdB!.id, "open"],
    ]);
    const tenders = await tenderStatuses(fx, order.id);
    expect(tenders.find((t) => t.id === a.tenderId)?.status).toBe("voided");
    expect(tenders.find((t) => t.id === b.tenderId)?.status).toBe("authorized");
    expect(await capturedIdr(fx, order.id)).toBe(0);
    await assertInvariants(fx, order.id);
  });

  it("xb20o-5 the old QR was paid before the release: its money is returned or parked once, never above what was paid", async () => {
    const { order, a, b } = await twoTenderBill();
    await payLate(a.intentId, BILL_IDR, a.providerRef!);
    await backdateExpiry(b, HOLD_RELEASE_AFTER_MIN + 1);

    const released = await postRelease(
      fx,
      order.id,
      await managerApproval(order.id, BILL_IDR),
    );
    expect(released.status, JSON.stringify(released.body)).toBeLessThan(300);
    await payLate(a.intentId, BILL_IDR, a.providerRef!);

    expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual([
      "voided",
      "voided",
    ]);
    const returnedA = await returnedOf(a.intentId);
    expect(returnedA.entries, "old QR money returned exactly once").toBe(1);
    expect(returnedA.idr).toBeLessThanOrEqual(BILL_IDR);
    expect((await returnedOf(b.intentId)).entries).toBe(0);
    const paidIdr = BILL_IDR; // only the old QR was paid
    expect(
      (await capturedIdr(fx, order.id)) + returnedA.idr,
      "captured + returned must not exceed what the guest paid",
    ).toBeLessThanOrEqual(paidIdr);
    expect(await capturedIdr(fx, order.id)).toBe(0);
    await assertInvariants(fx, order.id);
  });
});
