// legend-i83ls (gap 3): uniqueness under concurrency.
// - payment_links has no unique (tenant_id, reference); a charge link uses
//   reference `oic:<chargeId>`, opened lazily under the charge row lock. An
//   orphan link left by a crash is cancelled by the next attempt
//   (order-issue-charge-orphan-link.test.ts).
// - order_issues keeps unique (tenant_id, idempotency_key).
//
// Cases:
// - IU-1 two concurrent pay calls (different idempotency keys) for one charge:
//   one payment_links row `oic:<chargeId>`, one live intent, same code to both.
// - IU-3 two concurrent reports of the same item: one issue, no 500.
// - IU-4 same after a rejected refund (key `:n`): exactly one new issue.
//
// Assumptions:
// - IU-1 expects both calls to answer 200 or 201 (code not fixed).
// - IU-3/IU-4 expect both answers 200 or 201 and the same issue id (replay).
//   If an implementation answered one with 409, the test would flag it: the
//   brief says "one issue, not 500", and a replay is the documented behaviour.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema, ulidToUuid, type ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverIssueChargeEvent } from "../services/order-recovery-charge.ts";
import { deliverOrderRecoveryRefundEvent } from "../services/order-recovery-refund.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import { settleRefundFromChain } from "../services/payment-refund.service.ts";
import { agent, originHeader } from "./helpers.ts";
import {
  PRICES,
  createWorld,
  type Guest,
  type World,
} from "./order-recovery-helpers.ts";
import { owner } from "./floor-test-helpers.ts";

let w: World;

beforeAll(async () => {
  w = await createWorld();
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'refund', 0, $2, 1)`,
    [w.tenant.tenantId, w.ids.supervisorRole],
  );
}, 120_000);

afterAll(async () => {
  await w.teardown();
});

const DIFFERENCE = PRICES.kopi - PRICES.roti;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toUuid = (id: string) => (UUID.test(id) ? id : ulidToUuid(id));
const ok = (status: number) => status === 200 || status === 201;

function contextOf(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

/** A paid order whose roti was swapped for kopi, with its charge opened. */
async function openCharge() {
  const order = await w.paidOrder();
  const issueId = (await w.report(order.roti.id)).body.data.id as string;
  const approvalId = await w.insertApproval({
    actionType: "price_correction",
    objectType: "order_issue",
    objectId: issueId,
    amountIdr: DIFFERENCE,
    status: "approved",
    requestedBy: w.floorStaff.userId,
  });
  const resolved = await w.staffPost(
    w.supervisor,
    `/api/order-issues/${issueId}/resolve`,
    {
      resolution: "swap",
      replacementItemId: w.ids.kopi,
      approvalRequestId: approvalId,
    },
  );
  expect(resolved.status).toBe(200);
  const event = (await w.outboxRows("order_issue.resolved", issueId))[0]!.event;
  const context = contextOf(w.tenant.tenantId);
  await withTenant(db, context, async (tx) => {
    await deliverSwapKitchenEvent(context, event, tx);
    await deliverIssueChargeEvent(context, event, tx);
  });
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM order_issue_charges WHERE tenant_id = $1 AND order_issue_id = $2",
    [w.tenant.tenantId, issueId],
  );
  expect(rows).toHaveLength(1);
  return { ...order, issueId, chargeId: rows[0]!.id };
}

function pay(guest: Guest, chargeId: string) {
  const client = agent(w.app);
  return client
    .post(
      `/api/table-sessions/${guest.sessionId}/issue-charges/${chargeId}/payments`,
    )
    .set("Host", w.tenant.hostname)
    .set("Authorization", `Bearer ${guest.token}`)
    .set(originHeader)
    .send({ method: "qris", idempotencyKey: randomUUID() });
}

describe("legend-i83ls payment_links.reference is unique per tenant", () => {
  it("IU-1 two concurrent payers for one charge: one link oic:<chargeId>, one live intent", async () => {
    const { guest, chargeId } = await openCharge();

    const [a, b] = await Promise.all([
      pay(guest, chargeId),
      pay(guest, chargeId),
    ]);

    expect([a.status, b.status], "no 5xx for the second payer").toEqual([
      expect.toSatisfy(ok),
      expect.toSatisfy(ok),
    ]);
    const links = await owner.query<{ id: string }>(
      "SELECT id FROM payment_links WHERE tenant_id = $1 AND reference = $2",
      [w.tenant.tenantId, `oic:${chargeId}`],
    );
    expect(links.rows, "payment_links rows for the charge").toHaveLength(1);
    const live = await owner.query<{ id: string }>(
      `SELECT id FROM payment_intents
       WHERE tenant_id = $1 AND payment_link_id = $2 AND status = 'pending'`,
      [w.tenant.tenantId, links.rows[0]!.id],
    );
    expect(live.rows, "live intents").toHaveLength(1);
    expect(a.body.data.id).toBe(b.body.data.id);
  });
});

// ---- order_issues.idempotency_key ---------------------------------------------

async function issuesOfItem(itemId: string): Promise<string[]> {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM order_issues
     WHERE tenant_id = $1 AND order_item_id = $2 ORDER BY created_at, id`,
    [w.tenant.tenantId, toUuid(itemId)],
  );
  return rows.map((row) => row.id);
}

/** Ends a delivered recovery refund `failed` / `rejected` as the approval chain does. */
async function rejectedRefund() {
  const paid = await w.paidOrder();
  const issueId = (await w.report(paid.roti.id)).body.data.id as string;
  const approvalId = await w.insertApproval({
    actionType: "refund",
    objectType: "order_issue",
    objectId: issueId,
    amountIdr: PRICES.roti,
    status: "approved",
    requestedBy: w.floorStaff.userId,
  });
  const resolved = await w.staffPost(
    w.supervisor,
    `/api/order-issues/${issueId}/resolve`,
    { resolution: "manual_refund", approvalRequestId: approvalId, reason: "Pelanggan menolak ganti menu" },
  );
  expect(resolved.status).toBe(200);
  const event = (await w.outboxRows("order_issue.manual_refund_approved", issueId))[0]!.event;
  const context = contextOf(w.tenant.tenantId);
  await withTenant(db, context, (tx) =>
    deliverOrderRecoveryRefundEvent(context, event, tx),
  );
  const refund = await owner.query<{ id: string }>(
    "SELECT id FROM payment_refunds WHERE tenant_id = $1 AND order_issue_id = $2",
    [w.tenant.tenantId, issueId],
  );
  expect(refund.rows).toHaveLength(1);
  const refundId = refund.rows[0]!.id;
  await owner.query(
    `UPDATE approval_requests
        SET status = 'rejected', decided_by = $3, decided_at = now(), reason = 'Ditolak'
      WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2`,
    [w.tenant.tenantId, refundId, w.approverUserId],
  );
  const settled = await settleRefundFromChain(contextOf(w.tenant.tenantId), refundId);
  expect(settled.status).toBe("failed");
  return { ...paid, issueId };
}

describe("legend-i83ls order_issues.idempotency_key under concurrency", () => {
  it("IU-3 two concurrent reports of the same item: one issue, same id, no 500", async () => {
    const { roti } = await w.paidOrder();

    const [a, b] = await Promise.all([w.report(roti.id), w.report(roti.id)]);

    expect([a.status, b.status]).toEqual([expect.toSatisfy(ok), expect.toSatisfy(ok)]);
    expect(a.body.data.id).toBe(b.body.data.id);
    expect(await issuesOfItem(roti.id)).toHaveLength(1);
  });

  it("IU-4 after a rejected refund, two concurrent re-reports make exactly one new issue, no 500", async () => {
    const { roti, issueId } = await rejectedRefund();

    const [a, b] = await Promise.all([w.report(roti.id), w.report(roti.id)]);

    expect([a.status, b.status]).toEqual([expect.toSatisfy(ok), expect.toSatisfy(ok)]);
    expect(a.body.data.id).toBe(b.body.data.id);
    expect(a.body.data.id).not.toBe(issueId);
    expect(await issuesOfItem(roti.id)).toHaveLength(2);
  });
});
