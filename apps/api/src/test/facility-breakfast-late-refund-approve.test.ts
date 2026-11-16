// Breakfast late-payment refund vs an admin refund still pending (bead 519
// butir 1, founder rule "jangan sampai rugi"). Real Express app, Better Auth,
// the WS-05 payment service, the refund approval chain and PostgreSQL with RLS
// in one isolated tenant. Written from docs/briefs/519-breakfast-codex-fix.md
// and the shared contract, not from the implementation. Reuses
// facility-breakfast-helpers.ts and the approver setup of
// qr-order-fire-refund-cap.test.ts.
//
// Id: BRK-LATE-REFUND-01 a guest pays a breakfast intent late (after the order
// was fired, or after the guest cancelled) while an admin refund of 10000 on
// that intent is still pending. The system refund for the late payment is the
// whole amount paid; approving it must SUCCEED (the pending admin refund must
// not count against it), and afterwards approving the admin refund must be
// refused (cap_exceeded), so refunds that are not failed never exceed what the
// guest paid.
//
// Assumptions:
// - The brief's "bayar 100.000" is the order total computed by the server (menu
//   price + service + tax), `order.totalIdr`; the amount is not forced to
//   100000. The admin refund stays 10000, smaller than any total here.
// - The pending admin refund is a raw `payment_refunds` row filed by the floor
//   staff (as pos-late-payment-pending-refund.test.ts and
//   qr-order-fire-refund-cap.test.ts do), inserted BEFORE the late
//   `payment.paid` event is consumed. It sits on the late intent.
// - The system refund is found by `requested_by = 'system:facility'` (as the
//   BRK-PAY-02 tests expect). A system refund opens its approval chain at
//   creation: one finance + outlet supervisor decides, via
//   `POST /api/payments/admin/refunds/:id/approve`.
// - The refund gateway answers "succeeded" by default (FakeRefundGateway), so
//   an approved late refund is `approved` or `completed`.
// - A refund the approval refuses ends `failed` with failure_reason
//   `cap_exceeded` and never reaches the gateway.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import { FakeRefundGateway } from "./refund-fake-gateway.ts";
import { seededTenantId } from "./floor-test-helpers.ts";
import {
  createBreakfastWorld,
  deliver,
  dropBreakfastWorld,
  endPools,
  installGateway,
  linkedOf,
  memberApi,
  newMember,
  openIntent,
  openSecondIntent,
  owner,
  paidEvent,
  payLink,
  placeOrder,
  refundedSum,
  seedTicket,
  settle,
  staffFire,
  type BreakfastWorld,
} from "./facility-breakfast-helpers.ts";

const ADMIN = "/api/payments/admin";
const ADMIN_PENDING_IDR = 10_000;

let app: Express;
let world: BreakfastWorld;
let approver: ReturnType<typeof agent>;

/** A finance + outlet supervisor approver of the isolated tenant. */
async function makeApprover() {
  const tenant = world.tenant;
  const copyRole = async (templateKey: string) =>
    (
      await owner.query<{ id: string }>(
        `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
         SELECT gen_random_uuid(), $1, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
           FROM roles WHERE tenant_id = $2 AND template_key = $3
         RETURNING id`,
        [tenant.tenantId, seededTenantId, templateKey],
      )
    ).rows[0]!.id;
  const financeRole = await copyRole("finance");
  const supervisorRole = await copyRole("supervisor");
  // One tier for every amount: Finance decides in a single level.
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'refund', NULL, $2, 1)`,
    [tenant.tenantId, financeRole],
  );
  const client = agent(app);
  const email = await signUp(client, "Breakfast Late Refund Finance");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await verifySessionMfa(email);
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by, assigned_at)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2, now() - interval '1 hour')`,
    [tenant.tenantId, userId, financeRole],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by, assigned_at)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2, now() - interval '1 hour')`,
    [tenant.tenantId, userId, supervisorRole, tenant.outletId],
  );
  return client;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  installGateway();
  world = await createBreakfastWorld(app);
  approver = await makeApprover();
});

afterAll(async () => {
  setPaymentRefundGateway(null);
  await dropBreakfastWorld(world);
  await endPools();
});

async function newTicket() {
  const member = await newMember(world);
  const ticketId = await seedTicket(world, member);
  return { member, ticketId, api: memberApi(world, member) };
}

/** An admin refund request already filed on the intent, still `pending`. */
async function pendingAdminRefund(
  intentId: string,
  amountIdr: number,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO payment_refunds (tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by)
     SELECT tenant_id, outlet_id, id, $3, 'Refund admin uji sarapan', 'pending', $4
       FROM payment_intents WHERE tenant_id = $1 AND id = $2
     RETURNING id`,
    [world.tenant.tenantId, intentId, amountIdr, world.staff.userId],
  );
  return rows[0]!.id;
}

type RefundState = {
  id: string;
  status: string;
  amount: number;
  requestedBy: string;
  failureReason: string | null;
};

async function refundStates(intentId: string): Promise<RefundState[]> {
  const { rows } = await owner.query<{
    id: string;
    status: string;
    amount: string;
    requested_by: string;
    failure_reason: string | null;
  }>(
    `SELECT id, status, amount_idr::text AS amount, requested_by, failure_reason
       FROM payment_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2
      ORDER BY created_at, id`,
    [world.tenant.tenantId, intentId],
  );
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    amount: Number(row.amount),
    requestedBy: row.requested_by,
    failureReason: row.failure_reason,
  }));
}

const approve = (refundId: string) =>
  approver
    .post(`${ADMIN}/refunds/${refundId}/approve`)
    .set(world.headers)
    .set(originHeader)
    .send({ idempotencyKey: `apr-${randomUUID()}` })
    .then((response) => response);

/**
 * Two codes are open on the paid link. The first pays the order; `scenario`
 * decides how the second one ends up a late payment. Returns the late intent,
 * its (not yet delivered) paid event and the order.
 */
async function lateIntentWorld(scenario: "after_fired" | "after_cancel") {
  const { member, ticketId, api } = await newTicket();
  const order = await placeOrder(world, member, ticketId);
  const token = await payLink(world, member, ticketId, order.id);

  if (scenario === "after_fired") {
    // Both codes exist before the link is paid (opening one afterwards is 409).
    const first = await openIntent(world, token);
    const late = await openSecondIntent(world, token);
    await settle(world, first.id, order.totalIdr);
    await deliver(world, await paidEvent(world, first.id));
    expect((await staffFire(world, order.id)).status).toBe(200);
    expect((await linkedOf(world, order.id)).status).toBe("fired");
    await settle(world, late.id, order.totalIdr);
    return { order, lateIntentId: late.id, ticketId };
  }

  const late = await openIntent(world, token);
  const cancelled = await api.cancel(ticketId, order.id);
  expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
  await settle(world, late.id, order.totalIdr);
  return { order, lateIntentId: late.id, ticketId };
}

describe("BRK-LATE-REFUND-01 a late breakfast payment is refunded in full even while an admin refund is pending", () => {
  for (const scenario of ["after_fired", "after_cancel"] as const) {
    it(`BRK-LATE-REFUND-01 ${scenario}: approving the late refund succeeds, the pending admin refund is then refused, and refunds never exceed what was paid`, async () => {
      const { order, lateIntentId } = await lateIntentWorld(scenario);
      const paid = order.totalIdr;
      expect(paid).toBeGreaterThan(ADMIN_PENDING_IDR);
      const adminRefundId = await pendingAdminRefund(
        lateIntentId,
        ADMIN_PENDING_IDR,
      );

      await deliver(world, await paidEvent(world, lateIntentId));

      // The system files a refund for the whole late payment; the pending
      // admin refund does not shrink it (it may still fail or be rejected).
      const filed = await refundStates(lateIntentId);
      const late = filed.find((row) => row.requestedBy === "system:facility");
      expect(late, JSON.stringify(filed)).toMatchObject({
        status: "pending",
        amount: paid,
      });
      expect(filed.find((row) => row.id === adminRefundId)).toMatchObject({
        status: "pending",
        amount: ADMIN_PENDING_IDR,
      });

      const fake = new FakeRefundGateway();
      setPaymentRefundGateway(fake);
      try {
        // The late refund is approved first: it must be accepted.
        const lateResponse = await approve(late!.id);
        expect(lateResponse.status, JSON.stringify(lateResponse.body)).toBe(
          200,
        );
        expect(["approved", "completed"]).toContain(
          lateResponse.body.data.status,
        );

        // The admin refund would now push the total over what was paid.
        const adminResponse = await approve(adminRefundId);
        expect(adminResponse.status).toBeGreaterThan(399);
        const after = await refundStates(lateIntentId);
        expect(after.find((row) => row.id === adminRefundId)).toMatchObject({
          status: "failed",
          failureReason: "cap_exceeded",
        });
        // Only the late refund reached the provider.
        expect(fake.calls).toHaveLength(1);

        // Money: what is not failed never exceeds what the guest paid, and the
        // guest gets everything back.
        const live = after.filter((row) => row.status !== "failed");
        expect(refundedSum(live)).toBeLessThanOrEqual(paid);
        expect(refundedSum(live)).toBe(paid);
      } finally {
        setPaymentRefundGateway(null);
      }
    });
  }
});
