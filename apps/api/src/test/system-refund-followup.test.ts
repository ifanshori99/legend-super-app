// legend-weuo2 (brief 850, card A): a refund requested by `system:facility`
// (breakfast cancel / late payment) that FAILS used to stay failed forever: no
// re-file, nobody told, money still owed to the guest. New rule (founder rule
// "jangan sampai rugi": when in doubt, limit payment):
//   1. A failed system refund is re-filed automatically, bounded at 3 failed
//      system refunds per payment intent (MAX_SYSTEM_REFUND_REFILE_ATTEMPTS).
//   2. A person's rejection is never re-filed.
//   3. When no re-file happens (cap reached or person rejection) the refund is
//      a FOLLOW-UP item: one alarm (in-app notification to the outlet's
//      supervisors, Indonesian text) and one audit row
//      `payment.refund_followup_required`, both once per refund id.
//   4. Ops read the derived follow-up list over HTTP.
// Real Express app, Better Auth, WS-05 payment service and PostgreSQL with RLS
// in isolated tenants. Written from the brief and the existing breakfast refund
// test conventions (facility-breakfast-refund-refile.test.ts), not from the
// implementation. Reuses facility-breakfast-helpers.ts.
//
// Ids: weuo2-A re-filed once after a non-person failure, replays and concurrent
// settles add nothing; weuo2-B three failures stop the loop, alarm + audit +
// list entry, once; weuo2-C person rejection, no re-file, in the list;
// weuo2-D money cap with a pending sibling; weuo2-F provider decline is not
// re-filed (failure_needs_person); weuo2-E follow-up list API (tenant
// isolation, permission, strict query, newest first, drops once a live refund
// exists).
//
// Assumptions (the spec is silent, the brief decides only the shape):
// - Failure without a person: the approval request of the system refund is set
//   `expired` and `settleRefundFromChain` settles it to failed/approval_expired
//   (as BRK-REFILE-03). Person rejection: the approver calls
//   `POST /api/payments/admin/refunds/:id/reject`.
// - MAX_SYSTEM_REFUND_REFILE_ATTEMPTS = 3 (literal in this test; the constant's
//   module is not imported on purpose). 3 failed system refunds on one intent
//   => the third one is NOT re-filed: 3 refunds in total, all failed.
// - Follow-up list route: `GET /api/payments/admin/refunds/follow-ups`
//   (`?limit=` 1..100, optional `?outletId=<uuid>`, strict: unknown keys and
//   limit=0 answer 422). Body `{ data: [{ refundId, paymentIntentId, ... }] }`,
//   newest first. An intent shows only its LAST failed system refund (earlier
//   failures were re-filed, so they are not follow-ups).
// - Readers: a finance user (copy of the seeded `finance` template) may read;
//   the floor owner without any payment permission gets 403; anonymous 401.
// - Alarm: rows of the `notifications` table for the outlet supervisor (the
//   approver also holds an outlet-scoped supervisor role). Text contains
//   "pengembalian" or "refund". Only the follow-up moment raises it, not a
//   failure that was re-filed.
// - Audit: `audit_logs` row, event->>'action' = 'payment.refund_followup_required',
//   event->>'objectId' = the failed refund id.
// - A manual re-request (admin refund over HTTP) is a live refund and removes
//   the intent from the list; approving it (provider succeeds) keeps it out.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway.ts";
import { settleRefundFromChain } from "../services/payment-refund.service.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import { FakeRefundGateway } from "./refund-fake-gateway.ts";
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
  createIsolatedTenant,
  seededTenantId,
  staffOfIsolatedTenant,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers.ts";

const ADMIN = "/api/payments/admin";
const FOLLOW_UPS = `${ADMIN}/refunds/follow-ups`;
const SYSTEM = "system:facility";
/** MAX_SYSTEM_REFUND_REFILE_ATTEMPTS (brief 850). */
const MAX_ATTEMPTS = 3;
const FOLLOWUP_ACTION = "payment.refund_followup_required";

let app: Express;
let world: BreakfastWorld;
let finance: Staff;
let approver: ReturnType<typeof agent>;
let approverUserId: string;
let otherTenant: IsolatedTenant;
let otherReader: ReturnType<typeof agent>;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  installGateway();
  world = await createBreakfastWorld(app);
  // The seeded floor role also files refunds; `staff` itself keeps NO payment
  // permission (it is the 403 control), so `finance` is a separate account.
  await owner.query(
    "UPDATE roles SET permissions = permissions || '[\"payment.reconcile\"]'::jsonb WHERE id = $1",
    [world.tenant.roleId],
  );
  finance = await staffOfIsolatedTenant(app, world.tenant);
  const made = await makeFinanceReader(world.tenant, {
    outletSupervisor: true,
    policy: true,
  });
  approver = made.client;
  approverUserId = made.userId;

  otherTenant = await createIsolatedTenant(`fu${randomUUID().slice(0, 6)}`);
  otherReader = (
    await makeFinanceReader(otherTenant, {
      outletSupervisor: false,
      policy: false,
    })
  ).client;
});

afterAll(async () => {
  setPaymentRefundGateway(null);
  removeGateway();
  await dropBreakfastWorld(world);
  await endPools();
});

/** A finance user of a tenant; optionally also outlet supervisor + refund policy. */
async function makeFinanceReader(
  tenant: IsolatedTenant,
  options: { outletSupervisor: boolean; policy: boolean },
) {
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
  if (options.policy)
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
       VALUES ($1, 'refund', NULL, $2, 1)`,
      [tenant.tenantId, financeRole],
    );
  const client = agent(app);
  const email = await signUp(client, "Followup Finance");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await verifySessionMfa(email);
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by, assigned_at)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2, now() - interval '1 hour')`,
    [tenant.tenantId, userId, financeRole],
  );
  if (options.outletSupervisor) {
    const supervisorRole = await copyRole("supervisor");
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by, assigned_at)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2, now() - interval '1 hour')`,
      [tenant.tenantId, userId, supervisorRole, tenant.outletId],
    );
  }
  return { client, userId };
}

async function paidTicket() {
  const member = await newMember(world);
  const ticketId = await seedTicket(world, member);
  const paid = await placePaidOrder(world, member, ticketId);
  return { ...paid, ticketId, api: memberApi(world, member) };
}
type Paid = Awaited<ReturnType<typeof paidTicket>>;

async function adminRefund(intentId: string, amountIdr: number) {
  const response = await finance.client
    .post(`${ADMIN}/refunds`)
    .set(world.headers)
    .set(originHeader)
    .send({
      idempotencyKey: `fu-${randomUUID()}`,
      paymentIntentId: intentId,
      amountIdr,
      reason: "Pengembalian sarapan uji",
    });
  return response;
}

/** Guest cancels: the system files the cancel refund for the free amount. */
async function cancelOrder(paid: Paid) {
  const response = await paid.api.cancel(
    paid.ticketId,
    paid.order.id,
    randomUUID(),
  );
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  expect((await linkedOf(world, paid.order.id)).status).toBe("cancelled");
}

const isLive = (row: RefundDetail) => row.status !== "failed";
const liveSum = (rows: RefundDetail[]) =>
  rows.filter(isLive).reduce((sum, row) => sum + row.amount, 0);
const systemRows = (rows: RefundDetail[]) =>
  rows.filter((row) => row.requestedBy === SYSTEM);

async function expectCapped(intentId: string, paidIdr: number) {
  const rows = await refundDetailsOf(world, intentId);
  expect(liveSum(rows)).toBeLessThanOrEqual(paidIdr);
  return rows;
}

/** The live system refund of the intent (exactly one is expected). */
async function liveSystemRefund(intentId: string, paidIdr: number) {
  const rows = await expectCapped(intentId, paidIdr);
  const live = systemRows(rows).filter(isLive);
  expect(live, "no live system refund").toHaveLength(1);
  return live[0]!;
}

/** The refund fails without a person: its approval request expires. */
async function expireRefund(refundId: string) {
  await asOwnerTenant(world.tenant.tenantId, (client) =>
    client.query(
      "UPDATE approval_requests SET status = 'expired' WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2",
      [world.tenant.tenantId, refundId],
    ),
  );
  const failed = await settleRefundFromChain(world.context, refundId);
  expect(failed.status).toBe("failed");
}

/** A person (the approver) rejects the refund. */
async function rejectRefund(refundId: string) {
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

async function auditRows(refundId: string) {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM audit_logs
      WHERE tenant_id = $1 AND event->>'objectId' = $2 AND event->>'action' = $3`,
    [world.tenant.tenantId, refundId, FOLLOWUP_ACTION],
  );
  return rows;
}

/** In-app notifications the outlet supervisor holds in this tenant. */
async function supervisorNotifications() {
  const { rows } = await owner.query<{
    id: string;
    title: string;
    body: string;
  }>(
    `SELECT id, title, body FROM notifications
      WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at, id`,
    [world.tenant.tenantId, approverUserId],
  );
  return rows;
}

type FollowUp = {
  id: string;
  paymentIntentId: string;
  blockedReason?: string;
  /** Failed refunds of the payment by the same system requester. */
  attempts?: number;
  /** Still owed to the guest: paid less the live refunds. */
  remainingIdr?: number;
};
async function followUpOf(intentId: string): Promise<FollowUp[]> {
  const response = await followUps();
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return (response.body.data as FollowUp[]).filter(
    (item) => item.paymentIntentId === intentId,
  );
}
async function followUps(
  client: ReturnType<typeof agent> = approver,
  headers: { Host: string } = world.headers,
  query = "?limit=100",
) {
  const response = await client
    .get(`${FOLLOW_UPS}${query}`)
    .set(headers)
    .set(originHeader);
  return response;
}
async function followUpIds(): Promise<string[]> {
  const response = await followUps();
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return (response.body.data as FollowUp[]).map((item) => item.id);
}

describe("legend-weuo2 weuo2-A a failed system refund is re-filed once", () => {
  it("weuo2-A the cancel refund fails (approval expired): one new pending system refund for what is still owed, no alarm, no list entry, replays and concurrent settles add nothing", async () => {
    const paid = await paidTicket();
    const paidIdr = (await linkedOf(world, paid.order.id)).paid;
    await cancelOrder(paid);
    const first = await liveSystemRefund(paid.intentId, paidIdr);
    expect(first).toMatchObject({ status: "pending", amount: paidIdr });
    const alarmsBefore = (await supervisorNotifications()).length;

    await expireRefund(first.id);

    let rows = await expectCapped(paid.intentId, paidIdr);
    expect(rows.find((row) => row.id === first.id)?.status).toBe("failed");
    expect(rows, "the failed system refund was not re-filed").toHaveLength(2);
    const refiled = await liveSystemRefund(paid.intentId, paidIdr);
    expect(refiled.id).not.toBe(first.id);
    expect(refiled).toMatchObject({ status: "pending", amount: paidIdr });
    // It is being handled: no alarm, no audit, not a follow-up yet.
    expect(await auditRows(first.id)).toHaveLength(0);
    expect((await supervisorNotifications()).length).toBe(alarmsBefore);
    expect(await followUpIds()).not.toContain(first.id);

    // At-least-once delivery of the failure, sequential and concurrent.
    await settleRefundFromChain(world.context, first.id);
    await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        settleRefundFromChain(world.context, first.id),
      ),
    );
    rows = await expectCapped(paid.intentId, paidIdr);
    expect(rows.map((row) => row.id).sort()).toEqual(
      [first.id, refiled.id].sort(),
    );
    expect(liveSum(rows)).toBe(paidIdr);
  });
});

describe("legend-weuo2 weuo2-A the follow-up shows what is still owed after a re-file", () => {
  it("weuo2-A the re-filed cancel refund is then rejected by a person: the list says the whole paid amount is still owed after 2 attempts, with one alarm and one audit row, only for the last refund", async () => {
    const paid = await paidTicket();
    const paidIdr = (await linkedOf(world, paid.order.id)).paid;
    await cancelOrder(paid);
    const first = await liveSystemRefund(paid.intentId, paidIdr);
    await expireRefund(first.id);
    const refiled = await liveSystemRefund(paid.intentId, paidIdr);
    expect(refiled.id).not.toBe(first.id);
    const alarmsBefore = (await supervisorNotifications()).length;

    await rejectRefund(refiled.id);

    const rows = await expectCapped(paid.intentId, paidIdr);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "failed")).toBe(true);
    // The failed first refund (the one that was re-filed) never counts as
    // money held: the guest is still owed the whole payment.
    const items = await followUpOf(paid.intentId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: refiled.id,
      blockedReason: "person_rejection",
      attempts: 2,
      remainingIdr: paidIdr,
    });
    expect(await auditRows(first.id)).toHaveLength(0);
    expect(await auditRows(refiled.id)).toHaveLength(1);
    const alarms = (await supervisorNotifications()).slice(alarmsBefore);
    expect(
      alarms,
      "one alarm, for the refund nobody will re-file",
    ).toHaveLength(1);
  });
});

describe("legend-weuo2 weuo2-B the loop is bounded; then alarm, audit and follow-up", () => {
  it("weuo2-B three failed system refunds: no fourth refund; one alarm, one audit row and one list entry, replays add nothing", async () => {
    const paid = await paidTicket();
    const paidIdr = (await linkedOf(world, paid.order.id)).paid;
    await cancelOrder(paid);
    const failedIds: string[] = [];
    const alarmsBefore = (await supervisorNotifications()).length;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const live = await liveSystemRefund(paid.intentId, paidIdr);
      failedIds.push(live.id);
      await expireRefund(live.id);
      if (attempt < MAX_ATTEMPTS) {
        // Still within the bound: re-filed, so not an alarm yet.
        expect(await auditRows(live.id)).toHaveLength(0);
        expect((await supervisorNotifications()).length).toBe(alarmsBefore);
      }
    }

    const rows = await expectCapped(paid.intentId, paidIdr);
    expect(rows, "a refund beyond the bound was filed").toHaveLength(
      MAX_ATTEMPTS,
    );
    expect(rows.every((row) => row.status === "failed")).toBe(true);
    expect(liveSum(rows)).toBe(0);
    const last = failedIds[MAX_ATTEMPTS - 1]!;

    // Audit: exactly one row, for the refund that was not re-filed.
    expect(await auditRows(last)).toHaveLength(1);
    expect(await auditRows(failedIds[0]!)).toHaveLength(0);
    expect(await auditRows(failedIds[1]!)).toHaveLength(0);

    // Alarm: the outlet supervisor got one Indonesian notice.
    const alarms = (await supervisorNotifications()).slice(alarmsBefore);
    expect(alarms, "no alarm for a refund nobody will re-file").toHaveLength(1);
    expect(`${alarms[0]!.title} ${alarms[0]!.body}`).toMatch(
      /pengembalian|refund/i,
    );

    // Follow-up list: this intent once, with the last failed refund.
    const response = await followUps();
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const items = (response.body.data as FollowUp[]).filter(
      (item) => item.paymentIntentId === paid.intentId,
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(last);

    // Replays of the last failure: nothing new (dedupe per refund id).
    await settleRefundFromChain(world.context, last);
    await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        settleRefundFromChain(world.context, last),
      ),
    );
    expect(await auditRows(last)).toHaveLength(1);
    expect((await supervisorNotifications()).length).toBe(alarmsBefore + 1);
    expect(await expectCapped(paid.intentId, paidIdr)).toHaveLength(
      MAX_ATTEMPTS,
    );
  });
});

describe("legend-weuo2 weuo2-C a person's rejection is never re-filed", () => {
  it("weuo2-C the approver rejects the system refund: no new refund, one alarm, one audit row, listed", async () => {
    const paid = await paidTicket();
    const paidIdr = (await linkedOf(world, paid.order.id)).paid;
    await cancelOrder(paid);
    const first = await liveSystemRefund(paid.intentId, paidIdr);
    const alarmsBefore = (await supervisorNotifications()).length;

    await rejectRefund(first.id);

    const rows = await expectCapped(paid.intentId, paidIdr);
    expect(rows, "a rejected refund must not be re-filed").toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.id, status: "failed" });
    expect(await auditRows(first.id)).toHaveLength(1);
    const alarms = (await supervisorNotifications()).slice(alarmsBefore);
    expect(alarms).toHaveLength(1);
    expect(`${alarms[0]!.title} ${alarms[0]!.body}`).toMatch(
      /pengembalian|refund/i,
    );
    expect(await followUpIds()).toContain(first.id);

    // Replay of the decision: still one audit row, one alarm, one refund.
    await settleRefundFromChain(world.context, first.id);
    expect(await auditRows(first.id)).toHaveLength(1);
    expect((await supervisorNotifications()).length).toBe(alarmsBefore + 1);
    expect(await expectCapped(paid.intentId, paidIdr)).toHaveLength(1);
  });
});

describe("legend-weuo2 weuo2-F a provider decline is not re-filed (CTO 15 Nov)", () => {
  it("weuo2-F the provider declines the system refund: no new refund, one alarm, one audit row, listed as failure_needs_person, money capped", async () => {
    const paid = await paidTicket();
    const paidIdr = (await linkedOf(world, paid.order.id)).paid;
    await cancelOrder(paid);
    const first = await liveSystemRefund(paid.intentId, paidIdr);
    const alarmsBefore = (await supervisorNotifications()).length;

    const fake = new FakeRefundGateway();
    fake.enqueue("failed");
    setPaymentRefundGateway(fake);
    try {
      const response = await approver
        .post(`${ADMIN}/refunds/${first.id}/approve`)
        .set(world.headers)
        .set(originHeader)
        .send({ idempotencyKey: `apr-${randomUUID()}` });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.data.status).toBe("failed");
    } finally {
      setPaymentRefundGateway(null);
    }
    await settleRefundFromChain(world.context, first.id);

    // A new request could pay twice after a provider decline: not re-filed.
    const rows = await expectCapped(paid.intentId, paidIdr);
    expect(rows, "a provider-declined refund was re-filed").toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.id, status: "failed" });
    expect(liveSum(rows)).toBeLessThanOrEqual(paidIdr);

    expect(await auditRows(first.id)).toHaveLength(1);
    const alarms = (await supervisorNotifications()).slice(alarmsBefore);
    expect(alarms).toHaveLength(1);
    expect(`${alarms[0]!.title} ${alarms[0]!.body}`).toMatch(
      /pengembalian|refund/i,
    );
    const response = await followUps();
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const items = (response.body.data as FollowUp[]).filter(
      (item) => item.id === first.id,
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.blockedReason).toBe("failure_needs_person");

    // Replays add nothing.
    await settleRefundFromChain(world.context, first.id);
    expect(await auditRows(first.id)).toHaveLength(1);
    expect((await supervisorNotifications()).length).toBe(alarmsBefore + 1);
    expect(await expectCapped(paid.intentId, paidIdr)).toHaveLength(1);
  });
});

describe("legend-weuo2 weuo2-F a declined system refund leaves a pending sibling alone", () => {
  it("weuo2-F a pending admin refund of 10.000 stays pending and unchanged when the system refund for the rest is declined; the list says only the rest is still owed", async () => {
    const paid = await paidTicket();
    const paidIdr = (await linkedOf(world, paid.order.id)).paid;
    const held = 10_000;
    expect(paidIdr).toBeGreaterThan(held);
    const admin = await adminRefund(paid.intentId, held);
    expect(admin.status, JSON.stringify(admin.body)).toBe(201);
    const siblingId = admin.body.data.id as string;
    await cancelOrder(paid);
    const first = await liveSystemRefund(paid.intentId, paidIdr);
    expect(first.amount).toBe(paidIdr - held);
    const siblingBefore = (await refundDetailsOf(world, paid.intentId)).find(
      (row) => row.id === siblingId,
    );
    expect(siblingBefore).toMatchObject({ status: "pending", amount: held });
    const alarmsBefore = (await supervisorNotifications()).length;

    const fake = new FakeRefundGateway();
    fake.enqueue("failed");
    setPaymentRefundGateway(fake);
    try {
      const response = await approver
        .post(`${ADMIN}/refunds/${first.id}/approve`)
        .set(world.headers)
        .set(originHeader)
        .send({ idempotencyKey: `apr-${randomUUID()}` });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.data.status).toBe("failed");
    } finally {
      setPaymentRefundGateway(null);
    }
    await settleRefundFromChain(world.context, first.id);

    // The sibling is exactly as it was: nothing re-filed, nothing paid out.
    const rows = await expectCapped(paid.intentId, paidIdr);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === siblingId)).toEqual(siblingBefore);
    expect(rows.find((row) => row.id === first.id)?.status).toBe("failed");
    expect(liveSum(rows)).toBe(held);
    expect(fake.calls).toHaveLength(1);

    // One alarm and one audit row for the declined refund only.
    expect(await auditRows(first.id)).toHaveLength(1);
    expect(await auditRows(siblingId)).toHaveLength(0);
    expect((await supervisorNotifications()).length).toBe(alarmsBefore + 1);
    // The list owes the guest only the rest: paid less the live sibling.
    const items = await followUpOf(paid.intentId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: first.id,
      blockedReason: "failure_needs_person",
      attempts: 1,
      remainingIdr: paidIdr - held,
    });

    // Replays leave the sibling alone too.
    await settleRefundFromChain(world.context, first.id);
    const replayed = await expectCapped(paid.intentId, paidIdr);
    expect(replayed.find((row) => row.id === siblingId)).toEqual(siblingBefore);
    expect(replayed).toHaveLength(2);
  });
});

describe("legend-weuo2 weuo2-D money cap with a pending sibling", () => {
  it("weuo2-D an admin refund holds 10.000; the failed system refund is re-filed only for the free rest, concurrent settles never push live refunds above what was paid, and a new request over the cap is refused", async () => {
    const paid = await paidTicket();
    const paidIdr = (await linkedOf(world, paid.order.id)).paid;
    const held = 10_000;
    expect(paidIdr).toBeGreaterThan(held);
    const admin = await adminRefund(paid.intentId, held);
    expect(admin.status, JSON.stringify(admin.body)).toBe(201);
    await cancelOrder(paid);
    const first = await liveSystemRefund(paid.intentId, paidIdr);
    expect(first.amount).toBe(paidIdr - held);

    await expireRefund(first.id);
    await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        settleRefundFromChain(world.context, first.id),
      ),
    );

    const rows = await expectCapped(paid.intentId, paidIdr);
    expect(rows).toHaveLength(3);
    const refiled = await liveSystemRefund(paid.intentId, paidIdr);
    expect(refiled.id).not.toBe(first.id);
    expect(refiled.amount).toBe(paidIdr - held);
    expect(liveSum(rows)).toBe(paidIdr);

    // Everything is already owed to the guest: one more request is refused.
    const extra = await adminRefund(paid.intentId, 1_000);
    expect(extra.status).toBeGreaterThanOrEqual(400);
    expect(extra.status).toBeLessThan(500);
    const after = await expectCapped(paid.intentId, paidIdr);
    expect(after).toHaveLength(3);
    expect(liveSum(after)).toBe(paidIdr);
    const linked = await linkedOf(world, paid.order.id);
    expect(linked.refunded).toBeLessThanOrEqual(linked.paid);
  });
});

describe("legend-weuo2 weuo2-E follow-up list API", () => {
  it("weuo2-E newest first; a manual re-request (live refund) and its approval remove the intent from the list", async () => {
    const olderPaid = await paidTicket();
    const olderIdr = (await linkedOf(world, olderPaid.order.id)).paid;
    await cancelOrder(olderPaid);
    const older = await liveSystemRefund(olderPaid.intentId, olderIdr);
    await rejectRefund(older.id);

    const newerPaid = await paidTicket();
    const newerIdr = (await linkedOf(world, newerPaid.order.id)).paid;
    await cancelOrder(newerPaid);
    const newer = await liveSystemRefund(newerPaid.intentId, newerIdr);
    await rejectRefund(newer.id);

    const ids = await followUpIds();
    expect(ids).toContain(older.id);
    expect(ids).toContain(newer.id);
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));

    // Outlet filter keeps this outlet's entries.
    const filtered = await followUps(
      approver,
      world.headers,
      `?limit=100&outletId=${world.tenant.outletId}`,
    );
    expect(filtered.status, JSON.stringify(filtered.body)).toBe(200);
    expect((filtered.body.data as FollowUp[]).map((item) => item.id)).toContain(
      newer.id,
    );

    // Ops file the refund again by hand: a live refund exists, so the intent is
    // no longer waiting for a follow-up.
    const manual = await adminRefund(olderPaid.intentId, olderIdr);
    expect(manual.status, JSON.stringify(manual.body)).toBe(201);
    expect(await followUpIds()).not.toContain(older.id);
    expect(await followUpIds()).toContain(newer.id);

    // The approver pays it (provider succeeds): still not a follow-up.
    const fake = new FakeRefundGateway();
    fake.enqueue("succeeded");
    setPaymentRefundGateway(fake);
    try {
      const approved = await approver
        .post(`${ADMIN}/refunds/${manual.body.data.id as string}/approve`)
        .set(world.headers)
        .set(originHeader)
        .send({ idempotencyKey: `apr-${randomUUID()}` });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    } finally {
      setPaymentRefundGateway(null);
    }
    expect(await followUpIds()).not.toContain(older.id);
    const rows = await expectCapped(olderPaid.intentId, olderIdr);
    expect(liveSum(rows)).toBe(olderIdr);
  });

  it("weuo2-E when the manual re-request is itself rejected, the failed system refund is a follow-up again, with no second audit row and no second alarm", async () => {
    const paid = await paidTicket();
    const paidIdr = (await linkedOf(world, paid.order.id)).paid;
    await cancelOrder(paid);
    const first = await liveSystemRefund(paid.intentId, paidIdr);
    await rejectRefund(first.id);
    expect(await followUpIds()).toContain(first.id);
    expect(await auditRows(first.id)).toHaveLength(1);

    // Ops file the refund again: a live refund covers it, the item leaves.
    const manual = await adminRefund(paid.intentId, paidIdr);
    expect(manual.status, JSON.stringify(manual.body)).toBe(201);
    const manualId = manual.body.data.id as string;
    expect(await followUpIds()).not.toContain(first.id);

    // The manual refund is rejected: nothing live covers the guest's money
    // again, so the same failed system refund shows up again. It was already
    // announced once (alarm and audit are once per refund id), so it is not
    // announced a second time.
    const alarmsBefore = (await supervisorNotifications()).length;
    await rejectRefund(manualId);
    const items = await followUpOf(paid.intentId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: first.id,
      attempts: 1,
      remainingIdr: paidIdr,
    });
    expect(await auditRows(first.id)).toHaveLength(1);
    expect(await auditRows(manualId)).toHaveLength(0);
    expect((await supervisorNotifications()).length).toBe(alarmsBefore);
    await settleRefundFromChain(world.context, first.id);
    await followUps();
    expect(await auditRows(first.id)).toHaveLength(1);
    expect((await supervisorNotifications()).length).toBe(alarmsBefore);
    const rows = await expectCapped(paid.intentId, paidIdr);
    expect(liveSum(rows)).toBe(0);
  });

  it("weuo2-E another tenant never sees these entries, and anonymous 401 / no payment permission 403", async () => {
    const paid = await paidTicket();
    const paidIdr = (await linkedOf(world, paid.order.id)).paid;
    await cancelOrder(paid);
    const first = await liveSystemRefund(paid.intentId, paidIdr);
    await rejectRefund(first.id);
    expect(await followUpIds()).toContain(first.id);

    const other = await followUps(otherReader, {
      Host: otherTenant.hostname,
    });
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    expect(other.body.data).toEqual([]);

    const anonymous = await agent(app)
      .get(`${FOLLOW_UPS}?limit=100`)
      .set(world.headers);
    expect(anonymous.status).toBe(401);

    const forbidden = await followUps(world.staff.client);
    expect(forbidden.status, JSON.stringify(forbidden.body)).toBe(403);
  });

  it("weuo2-E the query is strict: unknown keys, limit 0 and limit 101 are refused with 422", async () => {
    for (const query of ["?limit=0", "?limit=101", "?unknown=1"]) {
      const response = await followUps(approver, world.headers, query);
      expect(response.status, `${query} ${JSON.stringify(response.body)}`).toBe(
        422,
      );
    }
  });
});
