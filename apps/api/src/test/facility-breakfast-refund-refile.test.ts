// Breakfast cancel while an admin refund is pending, then that admin refund is
// rejected or expires (brief 519 butir 2; founder rule "jangan sampai rugi").
// Real Express app, Better Auth, the WS-05 payment service and PostgreSQL with
// RLS in one isolated tenant. Written from docs/briefs/519-breakfast-codex-fix.md
// and the existing refund test conventions, not from the implementation.
// Reuses facility-breakfast-helpers.ts.
//
// Ids: BRK-REFILE-01 cancel with a full admin refund pending, admin refund
// rejected -> the whole payment is re-filed; BRK-REFILE-02 partial admin refund
// pending, then rejected -> only the remaining part is re-filed; BRK-REFILE-03
// the admin refund expires (approval_expired) instead of being rejected;
// BRK-REFILE-04 replays are idempotent; BRK-REFILE-05 no loop (the re-filed
// breakfast refund that fails is not filed again); BRK-REFILE-06 controls.
//
// Assumptions:
// - Money invariant: refunds that are pending / approved / completed ("live")
//   never add up to more than the paid amount, at every step.
// - An admin refund is filed over HTTP by a user holding `payment.reconcile`
//   (`POST /api/payments/admin/refunds`, as facility-breakfast-refund-cap.test.ts).
//   A whole-payment request is accepted while the order is unfired (BRK-PAY-06).
// - Rejecting goes through `POST /api/payments/admin/refunds/:id/reject` by a
//   finance + outlet supervisor approver (as qr-order-late-refund-after-failed
//   and payment-refund-approval tests). The approval policy exists before the
//   admin refund is filed. After the decision the test also calls the existing
//   `settleRefundFromChain` (idempotent; "consumer, or right after a decision")
//   so the result does not depend on whether the consumer already ran.
// - Expiry: the approval request of the refund is set `expired` and
//   `settleRefundFromChain` settles it to failed/approval_expired (as
//   order-recovery-refund-four-eyes.test.ts FE-6).
// - The re-filed breakfast refund is `pending` and is a different row from the
//   failed admin refund; its amount is paid minus the refunds still live.
// - Cancelling while the admin refund holds the whole payment still cancels the
//   order and files no breakfast refund (nothing is free).

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { settleRefundFromChain } from "../services/payment-refund.service.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import {
  asOwnerTenant,
  createBreakfastWorld,
  dropBreakfastWorld,
  endPools,
  installGateway,
  linkedOf,
  memberApi,
  newMember,
  owner,
  placePaidOrder,
  refundDetailsOf,
  removeGateway,
  seedTicket,
  type BreakfastWorld,
  type RefundDetail,
} from "./facility-breakfast-helpers.ts";
import {
  seededTenantId,
  staffOfIsolatedTenant,
  type Staff,
} from "./floor-test-helpers.ts";

let app: Express;
let world: BreakfastWorld;
let finance: Staff;
let approver: ReturnType<typeof agent>;

const ADMIN = "/api/payments/admin";

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  installGateway();
  world = await createBreakfastWorld(app);
  // The seeded floor role also files refunds; the account is created after the
  // change so no cached grant is stale.
  await owner.query(
    "UPDATE roles SET permissions = permissions || '[\"payment.reconcile\"]'::jsonb WHERE id = $1",
    [world.tenant.roleId],
  );
  finance = await staffOfIsolatedTenant(app, world.tenant);
  approver = await makeApprover();
});

afterAll(async () => {
  removeGateway();
  await dropBreakfastWorld(world);
  await endPools();
});

/** A finance + outlet supervisor approver (single-level refund policy). */
async function makeApprover() {
  const copyRole = async (templateKey: string) =>
    (
      await owner.query<{ id: string }>(
        `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
         SELECT gen_random_uuid(), $1, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
           FROM roles WHERE tenant_id = $2 AND template_key = $3
         RETURNING id`,
        [world.tenant.tenantId, seededTenantId, templateKey],
      )
    ).rows[0]!.id;
  const financeRole = await copyRole("finance");
  const supervisorRole = await copyRole("supervisor");
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'refund', NULL, $2, 1)`,
    [world.tenant.tenantId, financeRole],
  );
  const client = agent(app);
  const email = await signUp(client, "Refile Finance");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await verifySessionMfa(email);
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by, assigned_at)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2, now() - interval '1 hour')`,
    [world.tenant.tenantId, userId, financeRole],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by, assigned_at)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2, now() - interval '1 hour')`,
    [world.tenant.tenantId, userId, supervisorRole, world.tenant.outletId],
  );
  return client;
}

async function paidTicket() {
  const member = await newMember(world);
  const ticketId = await seedTicket(world, member);
  const paid = await placePaidOrder(world, member, ticketId);
  return { ...paid, ticketId, api: memberApi(world, member) };
}

async function adminRefund(intentId: string, amountIdr: number) {
  const response = await finance.client
    .post(`${ADMIN}/refunds`)
    .set(world.headers)
    .set(originHeader)
    .send({
      idempotencyKey: `brk-refile-${randomUUID()}`,
      paymentIntentId: intentId,
      amountIdr,
      reason: "Pengembalian sarapan uji",
    });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  expect(response.body.data.status).toBe("pending");
  return response.body.data.id as string;
}

async function cancelOrder(
  paid: Awaited<ReturnType<typeof paidTicket>>,
  key = randomUUID(),
) {
  const response = await paid.api.cancel(paid.ticketId, paid.order.id, key);
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  expect((await linkedOf(world, paid.order.id)).status).toBe("cancelled");
}

/** The approver rejects the admin refund; settle in case the consumer has not yet. */
async function rejectAdminRefund(refundId: string) {
  const response = await approver
    .post(`${ADMIN}/refunds/${refundId}/reject`)
    .set(world.headers)
    .set(originHeader)
    .send({
      idempotencyKey: `rej-${randomUUID()}`,
      reason: "Bukti pengembalian tidak sesuai",
    });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  await settleRefundFromChain(world.context, refundId);
}

/** The approval request of the refund runs out; the refund settles to failed. */
async function expireAdminRefund(refundId: string) {
  await asOwnerTenant(world.tenant.tenantId, (client) =>
    client.query(
      "UPDATE approval_requests SET status = 'expired' WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2",
      [world.tenant.tenantId, refundId],
    ),
  );
  const failed = await settleRefundFromChain(world.context, refundId);
  expect(failed.status).toBe("failed");
}

const isLive = (row: RefundDetail) => row.status !== "failed";
const liveSum = (rows: RefundDetail[]) =>
  rows.filter(isLive).reduce((sum, row) => sum + row.amount, 0);

/** The money rule at one moment: nothing live above the paid amount. */
async function expectCapped(
  intentId: string,
  orderId: string,
  paidIdr: number,
) {
  const rows = await refundDetailsOf(world, intentId);
  expect(liveSum(rows)).toBeLessThanOrEqual(paidIdr);
  const linked = await linkedOf(world, orderId);
  expect(linked.refunded).toBeLessThanOrEqual(linked.paid);
  return rows;
}

describe("BRK-REFILE-01 cancel while a full admin refund is pending, then the admin refund is rejected", () => {
  it("BRK-REFILE-01 the order stays cancelled and the whole payment is re-filed once, never above what was paid", async () => {
    const paid = await paidTicket();
    const paidIdr = (await linkedOf(world, paid.order.id)).paid;
    const adminId = await adminRefund(paid.intentId, paidIdr);

    await cancelOrder(paid);
    // Nothing was free, so no breakfast refund exists yet; the guest's money is
    // held only by the admin refund.
    let rows = await expectCapped(paid.intentId, paid.order.id, paidIdr);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: adminId, status: "pending" });

    await rejectAdminRefund(adminId);

    rows = await expectCapped(paid.intentId, paid.order.id, paidIdr);
    expect(rows.find((row) => row.id === adminId)?.status).toBe("failed");
    const live = rows.filter(isLive);
    expect(live, "the guest's money was not re-filed").toHaveLength(1);
    expect(live[0]!.id).not.toBe(adminId);
    expect(live[0]).toMatchObject({ status: "pending", amount: paidIdr });
    expect((await linkedOf(world, paid.order.id)).status).toBe("cancelled");
  });
});

describe("BRK-REFILE-02 a partial admin refund is pending when the guest cancels", () => {
  it("BRK-REFILE-02 the cancel refund takes the free part; after the admin refund is rejected only the rest is re-filed", async () => {
    const paid = await paidTicket();
    const paidIdr = (await linkedOf(world, paid.order.id)).paid;
    const partial = 10_000;
    expect(paidIdr).toBeGreaterThan(partial);
    const adminId = await adminRefund(paid.intentId, partial);

    await cancelOrder(paid);
    let rows = await expectCapped(paid.intentId, paid.order.id, paidIdr);
    // Cancel refund = the free balance; together they cover the payment exactly.
    expect(liveSum(rows)).toBe(paidIdr);
    expect(rows).toHaveLength(2);

    await rejectAdminRefund(adminId);

    rows = await expectCapped(paid.intentId, paid.order.id, paidIdr);
    expect(rows.find((row) => row.id === adminId)?.status).toBe("failed");
    // The guest is owed the whole payment: the cancel refund plus a re-filed
    // refund of exactly the part the rejected admin refund was holding.
    expect(liveSum(rows)).toBe(paidIdr);
    const refiled = rows.filter((row) => isLive(row) && row.amount === partial);
    expect(refiled, "the held part was not re-filed").toHaveLength(1);
    expect(refiled[0]!.id).not.toBe(adminId);
    expect(refiled[0]!.status).toBe("pending");
  });
});

describe("BRK-REFILE-03 the admin refund expires instead of being rejected", () => {
  it("BRK-REFILE-03 an expired admin refund (approval_expired) is replaced by a refund of the remaining amount", async () => {
    const paid = await paidTicket();
    const paidIdr = (await linkedOf(world, paid.order.id)).paid;
    const adminId = await adminRefund(paid.intentId, paidIdr);
    await cancelOrder(paid);

    await expireAdminRefund(adminId);

    const rows = await expectCapped(paid.intentId, paid.order.id, paidIdr);
    expect(rows.find((row) => row.id === adminId)?.status).toBe("failed");
    const live = rows.filter(isLive);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ status: "pending", amount: paidIdr });
  });
});

describe("BRK-REFILE-04 replays change nothing", () => {
  it("BRK-REFILE-04 settling the failed admin refund again, rejecting it again and cancelling again add no refund", async () => {
    const paid = await paidTicket();
    const paidIdr = (await linkedOf(world, paid.order.id)).paid;
    const adminId = await adminRefund(paid.intentId, paidIdr);
    const cancelKey = randomUUID();
    await cancelOrder(paid, cancelKey);
    await rejectAdminRefund(adminId);
    const first = await expectCapped(paid.intentId, paid.order.id, paidIdr);
    expect(first.filter(isLive)).toHaveLength(1);

    // At-least-once delivery of the failure and a second decision.
    await settleRefundFromChain(world.context, adminId);
    await settleRefundFromChain(world.context, adminId);
    await approver
      .post(`${ADMIN}/refunds/${adminId}/reject`)
      .set(world.headers)
      .set(originHeader)
      .send({
        idempotencyKey: `rej-${randomUUID()}`,
        reason: "Bukti pengembalian tidak sesuai",
      });
    await settleRefundFromChain(world.context, adminId);
    // The guest's cancel request is retried with the same key.
    await paid.api.cancel(paid.ticketId, paid.order.id, cancelKey);

    const again = await expectCapped(paid.intentId, paid.order.id, paidIdr);
    expect(again.map((row) => row.id).sort()).toEqual(
      first.map((row) => row.id).sort(),
    );
    expect(liveSum(again)).toBe(paidIdr);
  });
});

describe("BRK-REFILE-05 no loop", () => {
  it("BRK-REFILE-05 when the re-filed breakfast refund fails too, it is not filed a third time", async () => {
    const paid = await paidTicket();
    const paidIdr = (await linkedOf(world, paid.order.id)).paid;
    const adminId = await adminRefund(paid.intentId, paidIdr);
    await cancelOrder(paid);
    await rejectAdminRefund(adminId);
    const [refiled] = (
      await expectCapped(paid.intentId, paid.order.id, paidIdr)
    ).filter(isLive);
    expect(refiled, "no re-filed refund to fail").toBeDefined();

    await rejectAdminRefund(refiled!.id);
    await settleRefundFromChain(world.context, refiled!.id);

    const rows = await expectCapped(paid.intentId, paid.order.id, paidIdr);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "failed")).toBe(true);
    expect(liveSum(rows)).toBe(0);
  });
});

describe("BRK-REFILE-06 controls: nothing is re-filed when it should not be", () => {
  it("BRK-REFILE-06 an admin refund that fails on an order that was NOT cancelled files nothing new", async () => {
    const paid = await paidTicket();
    const paidIdr = (await linkedOf(world, paid.order.id)).paid;
    const adminId = await adminRefund(paid.intentId, paidIdr);

    await rejectAdminRefund(adminId);

    const rows = await expectCapped(paid.intentId, paid.order.id, paidIdr);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: adminId, status: "failed" });
    expect((await linkedOf(world, paid.order.id)).status).toBe("paid");
  });

  it("BRK-REFILE-06 cancel with no admin refund returns the full payment once and a second cancel changes nothing", async () => {
    const paid = await paidTicket();
    const paidIdr = (await linkedOf(world, paid.order.id)).paid;
    await cancelOrder(paid);

    const rows = await expectCapped(paid.intentId, paid.order.id, paidIdr);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: paidIdr });
    // A second cancel with the same intent changes nothing.
    const again = await paid.api.cancel(paid.ticketId, paid.order.id);
    expect(again.status).toBeLessThan(500);
    const after = await expectCapped(paid.intentId, paid.order.id, paidIdr);
    expect(after.map((row) => row.id)).toEqual(rows.map((row) => row.id));
  });
});
