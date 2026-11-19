// Hardening of the breakfast refund re-file (brief 519 "Putaran 2", architect
// findings 1 and 2; founder rule "jangan sampai rugi"). Real Express app,
// Better Auth, the WS-05 payment service, the refund approval chain and
// PostgreSQL with RLS in one isolated tenant. Written from
// docs/briefs/519-breakfast-codex-fix.md and the existing breakfast refund
// tests, not from the implementation. Reuses facility-breakfast-helpers.ts and
// the approver setup of facility-breakfast-refund-refile.test.ts.
//
// Ids: BRK-REFILE-07 the system re-file keys (`fb-refile:cancel:` and
// `fb-refile:late:`) are reserved, so staff cannot pre-claim them and block the
// re-file (a failed admin refund must always be able to fail); BRK-REFILE-08 late
// payment: an admin refund R already approved takes part of the money, the late
// refund covers the rest, R's payout then fails -> the part R held is re-filed
// exactly once, the total never exceeds what was paid, replays add nothing and
// both refunds can be approved; BRK-REFILE-09 controls (R fails before the late
// refund exists -> one refund of the whole payment, no extra; the re-filed refund
// that fails at the provider is NOT re-filed: follow-up list + alarm).
//
// Hold rule (CTO 19 Nov, legend-w2td5 / 1139): a refund of ours that was sent
// and then failed at the provider files an `own_refund_failed_unverified` hold
// on its intent. While that hold is open, approving ANY refund of the intent is
// 409 PROVIDER_REFUNDED with no payout, until finance checks the provider and
// closes it (`not_this_intent`: the failed refund did not pay, so no fact is
// counted). BRK-REFILE-08/09/09b follow that rule.
//
// Assumptions:
// - The brief's "bayar 100.000" is the order total computed by the server
//   (`order.totalIdr`); the admin refund R is 10000, smaller than any total.
// - Late payment = the second of two codes opened on the pay link settles after
//   the order was cancelled (or fired), as facility-breakfast-late-refund-approve.test.ts.
//   The late refund is filed by `system:facility` when the late `payment.paid`
//   event is consumed. R is a `payment_refunds` row on the late intent seeded
//   as `approved` with a providerRef (payout in flight), approved_by the
//   finance + supervisor user. Seeded, not approved over HTTP: the HTTP approval
//   of R before the late event is consumed answered 409 (see approvedAdminRefund).
//   Because R is approved BEFORE the event is consumed, the late refund is the
//   rest: totalIdr - R.
// - R's payout failure comes from the provider (`applyRefundProviderUpdate`
//   status "failed"), which settles R to failed and must re-file the rest.
//   Replaying that update may be refused by the service; the replay call
//   therefore swallows an error but the state afterwards must be unchanged.
//   R was sent (providerRef, one attempt), so its failure files ONE hold; a
//   replay files none. Both system refunds are refused (409 PROVIDER_REFUNDED,
//   fake gateway not called) until finance closes that hold with
//   `not_this_intent` through the route; after that they approve (200).
// - The re-filed refund is requested by `system:facility`, is `pending`, and is a
//   different row from R and from the first late refund. Its approval is judged
//   like the late refund (the pending/approved siblings do not count against it).
// - The reserved-key check calls `idempotentPaymentAdminWrite` the way BRK-PAY-08
//   does, with the key shapes `fb-refile:<kind>:<intentId>:<failedRefundId>`
//   (<= 100 chars); a rejected pre-claim is 422 IDEMPOTENCY_KEY_RESERVED.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { idempotentPaymentAdminWrite } from "../services/payment-admin-idempotency.ts";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway.ts";
import {
  applyRefundProviderUpdate,
  settleRefundFromChain,
} from "../services/payment-refund.service.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import { FakeRefundGateway } from "./refund-fake-gateway.ts";
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
  owner,
  paidEvent,
  payLink,
  placeOrder,
  placePaidOrder,
  refundDetailsOf,
  removeGateway,
  seedTicket,
  settle,
  staffFire,
  type BreakfastWorld,
  type RefundDetail,
} from "./facility-breakfast-helpers.ts";
import {
  seededTenantId,
  staffOfIsolatedTenant,
  type Staff,
} from "./floor-test-helpers.ts";

const ADMIN = "/api/payments/admin";
const R_IDR = 10_000;
const SYSTEM = "system:facility";

let app: Express;
let world: BreakfastWorld;
let finance: Staff;
let approver: ReturnType<typeof agent>;
let approverUserId: string;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  installGateway();
  world = await createBreakfastWorld(app);
  await owner.query(
    "UPDATE roles SET permissions = permissions || '[\"payment.reconcile\"]'::jsonb WHERE id = $1",
    [world.tenant.roleId],
  );
  finance = await staffOfIsolatedTenant(app, world.tenant);
  approver = await makeApprover();
});

afterAll(async () => {
  setPaymentRefundGateway(null);
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
  const email = await signUp(client, "Refile Hardening Finance");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  approverUserId = userId;
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

async function newTicket() {
  const member = await newMember(world);
  const ticketId = await seedTicket(world, member);
  return { member, ticketId, api: memberApi(world, member) };
}

const isLive = (row: RefundDetail) => row.status !== "failed";
const liveSum = (rows: RefundDetail[]) =>
  rows.filter(isLive).reduce((sum, row) => sum + row.amount, 0);

/** The money rule at one moment: nothing live above the paid amount. */
async function expectCapped(intentId: string, paidIdr: number) {
  const rows = await refundDetailsOf(world, intentId);
  expect(liveSum(rows), JSON.stringify(rows)).toBeLessThanOrEqual(paidIdr);
  return rows;
}

/** Audit rows `payment.refund_followup_required` of one refund (the alarm record). */
async function auditCount(refundId: string) {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM audit_logs
      WHERE tenant_id = $1 AND event->>'objectId' = $2
        AND event->>'action' = 'payment.refund_followup_required'`,
    [world.tenant.tenantId, refundId],
  );
  return rows.length;
}

/** Refund alarms (in-app notifications) the approver holds in this tenant, optionally of one title. */
async function alarmCount(title?: string) {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM notifications
      WHERE tenant_id = $1 AND user_id = $2
        AND (title || ' ' || body) ~* 'pengembalian|refund'
        AND ($3::text IS NULL OR title = $3)`,
    [world.tenant.tenantId, approverUserId, title ?? null],
  );
  return rows.length;
}

/** The follow-up alarm of a declined system refund (one per refund). */
const FOLLOWUP_ALARM = "Refund tamu perlu ditindaklanjuti";
/** The hold alarm of a failed refund of ours (legend-w2td5), a separate alert. */
const HOLD_ALARM = "Refund kami gagal setelah mungkin sampai ke penyedia";

const approve = (refundId: string) =>
  approver
    .post(`${ADMIN}/refunds/${refundId}/approve`)
    .set(world.headers)
    .set(originHeader)
    .send({ idempotencyKey: `apr-${randomUUID()}` });

/** Staff tries to pre-claim a system key through the admin write path. */
async function tryPreClaim(key: string) {
  let ran = false;
  const outcome = withTenant(db, world.context, (tx) =>
    idempotentPaymentAdminWrite(
      tx,
      world.context,
      world.staff.userId,
      key,
      "refund.create",
      { paymentIntentId: randomUUID(), reason: "Pre-claim kunci sistem" },
      async () => {
        ran = true;
        return null;
      },
    ),
  );
  return { outcome, ran: () => ran };
}

async function expectReserved(key: string) {
  expect(key.length).toBeLessThanOrEqual(100);
  const attempt = await tryPreClaim(key);
  await expect(attempt.outcome).rejects.toMatchObject({
    status: 422,
    code: "IDEMPOTENCY_KEY_RESERVED",
  });
  expect(attempt.ran()).toBe(false);
}

// ---- cancel flow (as facility-breakfast-refund-refile.test.ts) ---------------

async function paidTicket() {
  const { member, ticketId, api } = await newTicket();
  const paid = await placePaidOrder(world, member, ticketId);
  return { ...paid, ticketId, api };
}

async function adminRefund(intentId: string, amountIdr: number) {
  const response = await finance.client
    .post(`${ADMIN}/refunds`)
    .set(world.headers)
    .set(originHeader)
    .send({
      idempotencyKey: `brk-hard-${randomUUID()}`,
      paymentIntentId: intentId,
      amountIdr,
      reason: "Pengembalian sarapan uji",
    });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  expect(response.body.data.status).toBe("pending");
  return response.body.data.id as string;
}

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

// ---- late flow (as facility-breakfast-late-refund-approve.test.ts) -----------

/** Two codes on the paid link; the second settles late. The late event is NOT yet consumed. */
async function lateIntentWorld(scenario: "after_fired" | "after_cancel") {
  const { member, ticketId, api } = await newTicket();
  const order = await placeOrder(world, member, ticketId);
  const token = await payLink(world, member, ticketId, order.id);

  if (scenario === "after_fired") {
    const first = await openIntent(world, token);
    const late = await openIntent(world, token);
    await settle(world, first.id, order.totalIdr);
    await deliver(world, await paidEvent(world, first.id));
    expect((await staffFire(world, order.id)).status).toBe(200);
    expect((await linkedOf(world, order.id)).status).toBe("fired");
    await settle(world, late.id, order.totalIdr);
    return { order, lateIntentId: late.id };
  }

  const late = await openIntent(world, token);
  const cancelled = await api.cancel(ticketId, order.id);
  expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
  await settle(world, late.id, order.totalIdr);
  return { order, lateIntentId: late.id };
}

/**
 * An admin refund R of R_IDR on the intent that is already `approved` and sent
 * to the provider (providerRef set, one payout attempt), the payout not yet
 * finished. Seeded as a row (as payment-doit-refund-webhook.test.ts), approved
 * by the finance + supervisor user so it is not quarantined.
 * Why not approved over HTTP: approving R through the API BEFORE the late
 * payment is consumed answered 409 "Refund could not be approved." (the same
 * answer a cap_exceeded failure gives, see qr-order-late-refund-after-failed
 * P5) on this late intent; facility-breakfast-late-refund-approve.test.ts only
 * approves refunds AFTER the late event is consumed. The approval is not what
 * this file is about, so R starts at the state "approved, payout in flight".
 */
async function approvedAdminRefund(intentId: string) {
  const providerRef = `FAKE-RF-${randomUUID()}`;
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO payment_refunds (tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
                                  requested_by, approved_by, decided_at, provider_ref, payout_attempts)
     SELECT tenant_id, outlet_id, id, $3, 'Refund admin uji refile', 'approved', $4, $5, now(), $6, 1
       FROM payment_intents WHERE tenant_id = $1 AND id = $2
     RETURNING id`,
    [
      world.tenant.tenantId,
      intentId,
      R_IDR,
      world.staff.userId,
      approverUserId,
      providerRef,
    ],
  );
  return { refundId: rows[0]!.id, providerRef };
}

/** An owner of the isolated tenant: finance closes refund holds through the route. */
let holdResolver: ReturnType<typeof agent> | undefined;
async function makeHoldResolver() {
  if (holdResolver) return holdResolver;
  const { rows: roles } = await owner.query<{ id: string }>(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     SELECT gen_random_uuid(), $1, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
       FROM roles WHERE tenant_id = $2 AND template_key = 'owner'
     RETURNING id`,
    [world.tenant.tenantId, seededTenantId],
  );
  const client = agent(app);
  const email = await signUp(client, "Refile Hardening Hold Resolver");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await verifySessionMfa(email);
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by, assigned_at)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2, now() - interval '1 hour')`,
    [world.tenant.tenantId, userId, roles[0]!.id],
  );
  holdResolver = client;
  return client;
}

/** Open `own_refund_failed_unverified` holds of one intent. */
async function openOwnHoldIds(intentId: string) {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM refund_recon_holds
      WHERE tenant_id = $1 AND payment_intent_id = $2
        AND reason = 'own_refund_failed_unverified' AND resolved_at IS NULL`,
    [world.tenant.tenantId, intentId],
  );
  return rows.map((row) => row.id);
}

/**
 * legend-w2td5 (1139): R was sent and then failed, so the intent carries one
 * open hold. Approving each given refund is refused (409 PROVIDER_REFUNDED),
 * the gateway is not called and the refund rows stay as they were.
 */
async function expectHeldAndApproveRefused(
  intentId: string,
  refundIds: string[],
  paidIdr: number,
) {
  const holds = await openOwnHoldIds(intentId);
  expect(holds, "one open hold of the failed refund").toHaveLength(1);
  const rowsBefore = await expectCapped(intentId, paidIdr);
  const fake = new FakeRefundGateway();
  fake.enqueue("succeeded");
  setPaymentRefundGateway(fake);
  try {
    for (const refundId of refundIds) {
      const response = await approve(refundId);
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.error.code).toBe("PROVIDER_REFUNDED");
    }
    expect(fake.calls, "nothing is sent while the hold is open").toHaveLength(
      0,
    );
  } finally {
    setPaymentRefundGateway(null);
  }
  const rowsAfter = await expectCapped(intentId, paidIdr);
  expect(rowsAfter, "a refused approval changed the refunds").toEqual(
    rowsBefore,
  );
  return holds[0]!;
}

/** Finance checked the provider: R is not refunded elsewhere, money still ours. */
async function resolveHoldNotThisIntent(holdId: string, intentId: string) {
  const resolver = await makeHoldResolver();
  const response = await resolver
    .post(`${ADMIN}/refund-recon-holds/${holdId}/resolve`)
    .set(world.headers)
    .set(originHeader)
    .send({
      idempotencyKey: `hold-${randomUUID()}`,
      resolution: "not_this_intent",
      note: "Dicek di dashboard penyedia: refund gagal, dana masih di kami.",
    });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(await openOwnHoldIds(intentId)).toHaveLength(0);
}

/** The provider reports R's payout as failed. */
async function providerFails(providerRef: string) {
  await applyRefundProviderUpdate(world.context, {
    providerRef,
    status: "failed",
    code: "bank_rejected",
    amountIdr: R_IDR,
  });
}

describe("BRK-REFILE-07 the system re-file keys are reserved", () => {
  it("BRK-REFILE-07 staff cannot pre-claim fb-refile:cancel:* or fb-refile:late:* (422 IDEMPOTENCY_KEY_RESERVED)", async () => {
    for (const kind of ["cancel", "late"])
      await expectReserved(`fb-refile:${kind}:${randomUUID()}:${randomUUID()}`);
  });

  it("BRK-REFILE-07 the original system refund keys stay reserved too (control)", async () => {
    for (const kind of ["cancel", "late"])
      await expectReserved(`facility-breakfast-refund:${kind}:${randomUUID()}`);
  });

  it("BRK-REFILE-07 a pre-claim of the cancel re-file key for a real admin refund is refused, so when that refund is rejected the guest's money is still re-filed", async () => {
    const paid = await paidTicket();
    const paidIdr = (await linkedOf(world, paid.order.id)).paid;
    const adminId = await adminRefund(paid.intentId, paidIdr);
    const cancelled = await paid.api.cancel(paid.ticketId, paid.order.id);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBeLessThan(300);
    expect((await linkedOf(world, paid.order.id)).status).toBe("cancelled");

    // Staff knows the failing refund's id and tries to block the re-file.
    await expectReserved(`fb-refile:cancel:${paid.intentId}:${adminId}`);

    await rejectAdminRefund(adminId);

    const rows = await expectCapped(paid.intentId, paidIdr);
    expect(rows.find((row) => row.id === adminId)?.status).toBe("failed");
    const live = rows.filter(isLive);
    expect(live, "the guest's money was not re-filed").toHaveLength(1);
    expect(live[0]).toMatchObject({ status: "pending", amount: paidIdr });
  });
});

describe("BRK-REFILE-08 late payment: an approved admin refund fails its payout", () => {
  // after_fired is not covered here on purpose: there the late money is a
  // double payment, refunded from its own fund (outside the intent cap), and an
  // admin refund R cannot exist on that intent (its cap is 0, so approving R
  // answers 409 cap_exceeded). A seeded R would fake a state that cannot happen.
  for (const scenario of ["after_cancel"] as const) {
    it(`BRK-REFILE-08 ${scenario}: the part the failed refund held is re-filed once, the total stays within what was paid, replays add nothing`, async () => {
      const { order, lateIntentId } = await lateIntentWorld(scenario);
      const paid = order.totalIdr;
      expect(paid).toBeGreaterThan(R_IDR);
      const r = await approvedAdminRefund(lateIntentId);

      await deliver(world, await paidEvent(world, lateIntentId));

      // The late refund is the rest: R already holds R_IDR of the payment.
      let rows = await expectCapped(lateIntentId, paid);
      const late = rows.find((row) => row.requestedBy === SYSTEM);
      expect(late, JSON.stringify(rows)).toMatchObject({
        status: "pending",
        amount: paid - R_IDR,
      });
      expect(rows.find((row) => row.id === r.refundId)?.status).toBe(
        "approved",
      );
      expect(liveSum(rows)).toBe(paid);

      // Staff cannot block the re-file by taking its key beforehand.
      await expectReserved(`fb-refile:late:${lateIntentId}:${r.refundId}`);

      await providerFails(r.providerRef);

      rows = await expectCapped(lateIntentId, paid);
      expect(rows.find((row) => row.id === r.refundId)?.status).toBe("failed");
      const refiled = rows.filter(
        (row) =>
          row.requestedBy === SYSTEM && row.id !== late!.id && isLive(row),
      );
      expect(refiled, "the guest's R_IDR was not re-filed").toHaveLength(1);
      expect(refiled[0]).toMatchObject({ status: "pending", amount: R_IDR });
      expect(liveSum(rows)).toBe(paid);
      const firstIds = rows.map((row) => row.id).sort();

      // At-least-once delivery of the failure: nothing is filed a second time.
      await settleRefundFromChain(world.context, r.refundId);
      await providerFails(r.providerRef).catch(() => undefined);
      await settleRefundFromChain(world.context, r.refundId);
      rows = await expectCapped(lateIntentId, paid);
      expect(rows.map((row) => row.id).sort()).toEqual(firstIds);
      expect(liveSum(rows)).toBe(paid);

      // While the hold of R is open, approving either system refund is refused
      // and no money leaves; the guest is not paid a second time.
      const holdId = await expectHeldAndApproveRefused(
        lateIntentId,
        [late!.id, refiled[0]!.id],
        paid,
      );
      rows = await expectCapped(lateIntentId, paid);
      expect(rows.map((row) => row.id).sort()).toEqual(firstIds);

      // Finance checked the provider and closed the hold: both system refunds
      // can be approved, neither is refused by the cap, and the guest gets
      // everything back, no more.
      await resolveHoldNotThisIntent(holdId, lateIntentId);
      const fake = new FakeRefundGateway();
      setPaymentRefundGateway(fake);
      try {
        for (const refund of [late!, refiled[0]!]) {
          const response = await approve(refund.id);
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          expect(["approved", "completed"]).toContain(
            response.body.data.status,
          );
        }
        expect(fake.calls).toHaveLength(2);
      } finally {
        setPaymentRefundGateway(null);
      }
      rows = await expectCapped(lateIntentId, paid);
      expect(liveSum(rows)).toBe(paid);
    });
  }
});

describe("BRK-REFILE-09 controls", () => {
  it("BRK-REFILE-09 R fails BEFORE the late payment is consumed: one late refund of the whole payment, nothing extra", async () => {
    const { order, lateIntentId } = await lateIntentWorld("after_cancel");
    const paid = order.totalIdr;
    const r = await approvedAdminRefund(lateIntentId);

    await providerFails(r.providerRef);
    await deliver(world, await paidEvent(world, lateIntentId));

    const rows = await expectCapped(lateIntentId, paid);
    expect(rows.find((row) => row.id === r.refundId)?.status).toBe("failed");
    const system = rows.filter((row) => row.requestedBy === SYSTEM);
    expect(system).toHaveLength(1);
    expect(system[0]).toMatchObject({ status: "pending", amount: paid });
    expect(liveSum(rows)).toBe(paid);
  });

  it("BRK-REFILE-09 the re-filed late refund that fails at the provider is NOT re-filed: the money stays capped (CTO 15 Nov, legend-weuo2)", async () => {
    const { order, lateIntentId } = await lateIntentWorld("after_cancel");
    const paid = order.totalIdr;
    const r = await approvedAdminRefund(lateIntentId);
    await deliver(world, await paidEvent(world, lateIntentId));
    await providerFails(r.providerRef);
    const before = await expectCapped(lateIntentId, paid);
    const refiled = before.find(
      (row) =>
        row.requestedBy === SYSTEM && row.amount === R_IDR && isLive(row),
    );
    expect(refiled, "no re-filed refund to fail").toBeDefined();

    // Open hold of R: the re-filed refund cannot be approved yet.
    const holdId = await expectHeldAndApproveRefused(
      lateIntentId,
      [refiled!.id],
      paid,
    );
    await resolveHoldNotThisIntent(holdId, lateIntentId);

    // The provider declines the re-filed refund.
    const fake = new FakeRefundGateway();
    fake.enqueue("failed");
    setPaymentRefundGateway(fake);
    try {
      const response = await approve(refiled!.id);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.data.status).toBe("failed");
    } finally {
      setPaymentRefundGateway(null);
    }
    await settleRefundFromChain(world.context, refiled!.id);

    // CTO decision 15 Nov: a provider decline of a system refund is not
    // re-filed (a new request could pay twice). It waits for a person; the
    // list/alarm/audit part is BRK-REFILE-09b below.
    const after = await expectCapped(lateIntentId, paid);
    expect(
      after,
      "a provider-declined system refund was re-filed",
    ).toHaveLength(before.length);
    expect(after.find((row) => row.id === refiled!.id)?.status).toBe("failed");
    expect(liveSum(after)).toBeLessThanOrEqual(paid);
  });

  // Brief 850 v2: the declined refund must show in the follow-up list with one
  // alarm and one audit row. Here a sibling late refund (the rest of the
  // payment) is still pending, so a live refund exists; the part R held is
  // owed to the guest but nobody is told. Separate test: it fails only on the
  // follow-up, not on the money rule above.
  it("BRK-REFILE-09b the declined re-filed late refund is listed (failure_needs_person) with one alarm and one audit row even while a sibling refund is pending", async () => {
    const { order, lateIntentId } = await lateIntentWorld("after_cancel");
    const paid = order.totalIdr;
    const r = await approvedAdminRefund(lateIntentId);
    await deliver(world, await paidEvent(world, lateIntentId));
    await providerFails(r.providerRef);
    const before = await expectCapped(lateIntentId, paid);
    const refiled = before.find(
      (row) =>
        row.requestedBy === SYSTEM && row.amount === R_IDR && isLive(row),
    );
    expect(refiled, "no re-filed refund to fail").toBeDefined();
    // The sibling: the first late refund (the rest of the payment) is still
    // waiting for its approval and must not be touched by the other one's decline.
    const sibling = before.find(
      (row) =>
        row.requestedBy === SYSTEM && row.id !== refiled!.id && isLive(row),
    );
    expect(sibling, "no sibling late refund").toBeDefined();
    expect(sibling).toMatchObject({ status: "pending", amount: paid - R_IDR });
    // Open hold of R: neither the re-filed refund nor its sibling can be
    // approved yet; finance closes the hold.
    const holdId = await expectHeldAndApproveRefused(
      lateIntentId,
      [refiled!.id, sibling!.id],
      paid,
    );
    await resolveHoldNotThisIntent(holdId, lateIntentId);
    const alarmsBefore = await alarmCount(FOLLOWUP_ALARM);
    const holdAlarmsBefore = await alarmCount(HOLD_ALARM);

    const fake = new FakeRefundGateway();
    fake.enqueue("failed");
    setPaymentRefundGateway(fake);
    try {
      const response = await approve(refiled!.id);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    } finally {
      setPaymentRefundGateway(null);
    }
    await settleRefundFromChain(world.context, refiled!.id);

    const list = await approver
      .get(`${ADMIN}/refunds/follow-ups?limit=100`)
      .set(world.headers)
      .set(originHeader);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const items = (
      list.body.data as { id: string; blockedReason?: string }[]
    ).filter((item) => item.id === refiled!.id);
    expect(items).toHaveLength(1);
    expect(items[0]!.blockedReason).toBe("failure_needs_person");
    expect(await auditCount(refiled!.id)).toBe(1);
    expect(await alarmCount(FOLLOWUP_ALARM)).toBe(alarmsBefore + 1);
    // The decline of this refund (it was sent) files its own hold, told once.
    expect(await alarmCount(HOLD_ALARM)).toBe(holdAlarmsBefore + 1);

    // The sibling is exactly as before: still pending, same amount, no new
    // refund row, no alarm or audit row of its own, live total capped.
    const after = await expectCapped(lateIntentId, paid);
    expect(after).toHaveLength(before.length);
    expect(after.find((row) => row.id === sibling!.id)).toEqual(sibling);
    expect(await auditCount(sibling!.id)).toBe(0);
    expect(liveSum(after)).toBe(paid - R_IDR);
  });
});
