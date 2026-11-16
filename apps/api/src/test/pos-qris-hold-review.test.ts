// QRIS hold review tests (legend-yhia9, architect review of C2). Extra to
// pos-qris-hold.test.ts and pos-qris-hold-anomaly.test.ts: day close and shift
// close refuse while a hold is active, an edge without gateway credentials
// cannot issue QRIS, and parked QR money alerts once (a replay alerts nothing).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
} from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { setStaffPin } from "../services/device-pin.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { closePosDay } from "../services/pos-day.service.ts";
import { closePosShift } from "../services/pos-shift.service.ts";
import { withEdgeModeEnv } from "./edge-mode-env.ts";
import { owner } from "./floor-test-helpers.ts";
import { agent, signUp } from "./helpers.ts";
import {
  holdFixture,
  issueQris,
  newSubmittedOrder,
  payNotice,
  postRelease,
  readHold,
  requestQris,
  resetHoldPorts,
  tenderStatuses,
  unallocatedFunds,
  capturedIdr,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";

let fx: HoldFixture;
beforeAll(async () => {
  fx = await holdFixture("qris-hold-review");
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

async function notificationCount() {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM domain_event_outbox
      WHERE tenant_id=$1 AND event->>'name'='notification.created'`,
    [fx.tenant.tenantId],
  );
  return rows[0]!.n;
}

/** A user who may close the business day (pos.day.close). */
async function dayCloser() {
  const client = agent(fx.app);
  const email = await signUp(client, "Penutup Hari Uji");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Penutup Hari Uji', false, NULL, $3, false, '["tenant"]')`,
    [roleId, fx.tenant.tenantId, JSON.stringify(["pos.day.close"])],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [fx.tenant.tenantId, userId, roleId],
  );
  void email;
  return userId;
}

describe("QRIS hold review: closing the shift or the day", () => {
  it("shift close is refused with QRIS_HOLD_ACTIVE while the cashier's QR is collectible", async () => {
    const order = await newSubmittedOrder(fx, 0);
    await issueQris(fx, order.id);
    const { rows } = await owner.query<{ id: string }>(
      `SELECT id::text AS id FROM pos_shifts
        WHERE tenant_id=$1 AND status='open' ORDER BY opened_at DESC LIMIT 1`,
      [fx.tenant.tenantId],
    );
    expect(rows[0], "the fixture opens a shift").toBeDefined();
    await expect(
      closePosShift(
        fx.context,
        { userId: userIdSchema.parse(fx.staff.userId), deviceId: null },
        outletIdSchema.parse(fx.tenant.outletId),
        rows[0]!.id,
        {
          countId: randomUUID(),
          approvedBy: fx.staff.userId,
          approvalRequestId: randomUUID(),
          idempotencyKey: randomUUID(),
        } as unknown as Parameters<typeof closePosShift>[4],
      ),
    ).rejects.toMatchObject({ code: "QRIS_HOLD_ACTIVE" });
  });

  it("day close is refused with QRIS_HOLD_ACTIVE while a QR is collectible", async () => {
    const order = await newSubmittedOrder(fx, 0);
    await issueQris(fx, order.id);
    const { rows } = await owner.query<{ d: string }>(
      `SELECT business_date::text AS d FROM orders WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, ulidToUuid(order.id)],
    );
    const closer = await dayCloser();
    await expect(
      closePosDay(
        fx.context,
        { userId: userIdSchema.parse(closer) },
        outletIdSchema.parse(fx.tenant.outletId),
        {
          businessDate: rows[0]?.d ?? new Date().toISOString().slice(0, 10),
          inventoryDeduction: false,
          idempotencyKey: randomUUID(),
        } as Parameters<typeof closePosDay>[3],
      ),
    ).rejects.toMatchObject({ code: "QRIS_HOLD_ACTIVE" });
  });
});

describe("QRIS hold review: edge without gateway credentials", () => {
  it("QRIS_NEEDS_CLOUD: the edge cannot issue a QR, no tender and no hold are left", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const requests = fx.gateway.requests.length;
    const response = await withEdgeModeEnv(() => requestQris(fx, order.id));
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(JSON.stringify(response.body)).toContain("QRIS_NEEDS_CLOUD");
    expect(fx.gateway.requests).toHaveLength(requests);
    expect(await readHold(fx, order.id)).toBeNull();
    expect(await tenderStatuses(fx, order.id)).toEqual([]);
  });
});

describe("QRIS hold review: parked QR money alerts once", () => {
  it("a wrong-amount payment is parked with one alert; its replay alerts nothing and does not throw", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    const before = await notificationCount();
    const providerRef = `HOLD-REVIEW-${randomUUID()}`;
    // First delivery: parked, 409 as today.
    await expect(
      payNotice(fx, qr.intentId, 30_000, new Date(), providerRef),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const afterFirst = await notificationCount();
    expect(afterFirst - before, "one alert for the parked money").toBe(1);
    expect(await unallocatedFunds(fx, qr.intentId)).toHaveLength(1);
    expect(await capturedIdr(fx, order.id)).toBe(0);

    // Replay of the same provider transaction: no throw, no second alert, no
    // second unallocated row.
    await payNotice(fx, qr.intentId, 30_000, new Date(), providerRef);
    expect(await notificationCount()).toBe(afterFirst);
    expect(await unallocatedFunds(fx, qr.intentId)).toHaveLength(1);
    expect(await capturedIdr(fx, order.id)).toBe(0);
  });
});

const SUPERVISOR_PIN = "582914";

/** A supervisor with a PIN and an approved pos-overrides row for the order. */
async function managerApproval(orderId: string, valueIdr: number) {
  const client = agent(fx.app);
  await signUp(client, "Manajer Rilis Ulasan");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Manajer Rilis Ulasan', true, 'supervisor', $3, false, '["tenant"]')`,
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
  const context = establishTenantContext({
    tenantId: tenantIdSchema.parse(fx.tenant.tenantId),
    brandId: null,
    source: "session",
  });
  await setStaffPin(
    context,
    userId,
    { outletId: fx.tenant.outletId, userId },
    { pin: SUPERVISOR_PIN },
  );
  const { override } = await createPosOverride(
    context,
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
        approverUserId: userIdSchema.parse(userId),
        pin: SUPERVISOR_PIN,
      },
    } as Parameters<typeof createPosOverride>[2],
    { idempotencyKey: randomUUID() },
  );
  expect(override.status).toBe("approved");
  return { approvedBy: userId, overrideId: override.id };
}

describe("QRIS hold review: wrong amount keeps the hold; a release waits for the parked money", () => {
  it("the payment is parked once with one alert, the hold stays open, and a release is refused while that money is parked open", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    const before = await notificationCount();
    await expect(
      payNotice(fx, qr.intentId, 30_000, new Date(), qr.providerRef!),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await notificationCount()).toBe(before + 1);
    const held = await readHold(fx, order.id);
    expect(held?.state).toBe("open");
    expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual([
      "authorized",
    ]);
    expect(await unallocatedFunds(fx, qr.intentId)).toHaveLength(1);
    // No repeated provider reads: the next check is pushed far out.
    expect(held?.nextCheckAt?.getTime() ?? 0).toBeGreaterThan(
      Date.now() + 20 * 3_600_000,
    );

    // Past expires_at + 30 min the provider still says paid (30.000). SO-889
    // P2-1: that money is parked and still open, so the cashier must not take
    // the bill again: the release is refused and nothing is voided.
    await owner.query(
      `UPDATE payment_intents SET expires_at = now() - interval '31 minutes'
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, qr.intentId],
    );
    fx.gateway.script(qr.intentId, { rawStatus: "00", amountIdr: 30_000 });
    const approval = await managerApproval(order.id, 33_000);
    const released = await postRelease(fx, order.id, approval);
    expect(released.status, JSON.stringify(released.body)).toBe(409);
    expect(JSON.stringify(released.body)).toContain("FUNDS_UNRESOLVED");

    expect((await readHold(fx, order.id))?.state).toBe("open");
    expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual([
      "authorized",
    ]);
    const parked = await unallocatedFunds(fx, qr.intentId);
    expect(parked).toHaveLength(1);
    expect(parked[0]!.amountIdr).toBe(30_000);
    expect(await capturedIdr(fx, order.id)).toBe(0);
    expect(await notificationCount()).toBe(before + 1);
  });
});
