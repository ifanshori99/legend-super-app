// legend-wumm8: a recovery refund (`system:recovery`, ORD-09) that is rejected
// is final. If the guest still needs the money back, the kitchen reports the
// same line again and that creates a NEW issue (new refund, new approval).
// Written from the CTO decision before the implementation exists, so the
// "after rejection" cases start red.
//
// Cases:
// - RR-1 after rejection, reporting the same line again gives 201, a different
//   issue id, status open.
// - RR-2 the new issue resolves `manual_refund` with a new approval and yields
//   a new refund for the new issue; money is never refunded twice.
// - RR-3 guards that must stay green: replay before rejection (also after a
//   non-final failure), a second paid issue on one line is still refused when
//   the old refund is not rejected, and reporting twice after a rejection
//   does not make a third issue.
// - RR-4 the old issue is untouched and its `order_issue.refund_rejected`
//   audit stays.
//
// Assumptions where the brief is not exact:
// - A replay answers 200 or 201 (the status code is not fixed); only the issue
//   id is asserted for a replay.
// - A rejected refund is produced like order-recovery-refund-reject.test.ts:
//   the approval request of the refund chain is marked rejected, then
//   `settleRefundFromChain` ends the refund `failed` / `rejected`.
// - The new issue's refund is only checked for existence, amount and the
//   absence of a double refund; the refundable cap after the new refund is not
//   pinned beyond "never above the line's refundable amount".
// - "Forced second issue" (RR-3b): an open issue for the same line is inserted
//   by SQL (the reporting API would replay), then resolved through the API
//   with an approved approval. The expected answer is 409; the message
//   `Item ini sudah diselesaikan.` is asserted as text the user sees.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { paymentIntents } from "../db/schema/payment.ts";
import { paymentRefunds } from "../db/schema/payment-admin.ts";
import { withTenant } from "../db/tenant.ts";
import {
  deliverOrderRecoveryRefundEvent,
  refileRecoveryRefundAfterFailure,
} from "../services/order-recovery-refund.ts";
import { refundableBalance } from "../services/payment-admin.service.ts";
import { settleRefundFromChain } from "../services/payment-refund.service.ts";
import { PRICES, createWorld, type World } from "./order-recovery-helpers.ts";
import { owner } from "./floor-test-helpers.ts";

let w: World;

beforeAll(async () => {
  w = await createWorld();
  // The refund chain only opens when the tenant has a refund approval policy:
  // one level for every amount, decided by the supervisor role.
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'refund', 0, $2, 1)`,
    [w.tenant.tenantId, w.ids.supervisorRole],
  );
}, 120_000);

afterAll(async () => {
  await w.teardown();
});

const REASON = "Pelanggan menolak ganti menu dan voucher";
const ROTI_WANTED = 20_790;
const ALREADY_RESOLVED = "Item ini sudah diselesaikan.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toUuid = (id: string) => (UUID.test(id) ? id : ulidToUuid(id));

function tenantScope(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

async function deliverRecovery(event: EventEnvelope) {
  const context = tenantScope(w.tenant.tenantId);
  return withTenant(db, context, (tx) =>
    deliverOrderRecoveryRefundEvent(context, event, tx),
  );
}

/** Resolves an open issue `manual_refund` with a fresh approved approval. */
async function resolveRefund(issueId: string, amountIdr: number) {
  const approvalId = await w.insertApproval({
    actionType: "refund",
    objectType: "order_issue",
    objectId: issueId,
    amountIdr,
    status: "approved",
    requestedBy: w.floorStaff.userId,
  });
  return w.staffPost(w.supervisor, `/api/order-issues/${issueId}/resolve`, {
    resolution: "manual_refund",
    approvalRequestId: approvalId,
    reason: REASON,
  });
}

async function approvedEvent(issueId: string): Promise<EventEnvelope> {
  const rows = await w.outboxRows(
    "order_issue.manual_refund_approved",
    issueId,
  );
  expect(rows, "manual_refund_approved event in the outbox").toHaveLength(1);
  return rows[0]!.event;
}

type RefundRow = {
  id: string;
  amount_idr: number;
  status: string;
  failure_reason: string | null;
};

async function issueRefunds(issueId: string): Promise<RefundRow[]> {
  const { rows } = await owner.query<RefundRow>(
    `SELECT id, amount_idr::int AS amount_idr, status, failure_reason
     FROM payment_refunds WHERE tenant_id = $1 AND order_issue_id = $2
     ORDER BY created_at, id`,
    [w.tenant.tenantId, issueId],
  );
  return rows;
}

async function auditCount(issueId: string, action: string) {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*) AS n FROM audit_logs
     WHERE tenant_id = $1 AND event->>'action' = $2 AND event->>'objectId' = $3`,
    [w.tenant.tenantId, action, issueId],
  );
  return Number(rows[0]!.n);
}

async function issueRow(issueId: string) {
  const { rows } = await owner.query<{
    status: string;
    resolution: string | null;
  }>(
    "SELECT status, resolution FROM order_issues WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, issueId],
  );
  expect(rows, "issue row").toHaveLength(1);
  return rows[0]!;
}

/** All issues of one order line, oldest first. */
async function issuesOfItem(itemId: string): Promise<string[]> {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM order_issues
     WHERE tenant_id = $1 AND order_item_id = $2 ORDER BY created_at, id`,
    [w.tenant.tenantId, toUuid(itemId)],
  );
  return rows.map((row) => row.id);
}

async function intentIdOf(orderId: string): Promise<string> {
  const { rows } = await owner.query<{ payment_intent_id: string | null }>(
    "SELECT payment_intent_id FROM orders WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, toUuid(orderId)],
  );
  expect(rows[0]!.payment_intent_id, "order has an intent").not.toBeNull();
  return rows[0]!.payment_intent_id!;
}

async function holdOf(intentId: string) {
  const context = tenantScope(w.tenant.tenantId);
  return withTenant(db, context, async (tx) => {
    const [intent] = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.id, intentId),
        ),
      );
    const balance = await refundableBalance(tx, intent!, {
      lockDeposit: false,
    });
    return { cap: Number(balance.cap), reserved: Number(balance.reserved) };
  });
}

/** Ends the refund `failed` as an expired or rejected approval chain does. */
async function failChain(
  refundId: string,
  how: "approval_expired" | "rejected",
) {
  if (how === "approval_expired")
    await owner.query(
      "UPDATE approval_requests SET status = 'expired' WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2",
      [w.tenant.tenantId, refundId],
    );
  else
    await owner.query(
      `UPDATE approval_requests
          SET status = 'rejected', decided_by = $3, decided_at = now(), reason = 'Ditolak uji wumm8'
        WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2`,
      [w.tenant.tenantId, refundId, w.approverUserId],
    );
  const settled = await settleRefundFromChain(
    tenantScope(w.tenant.tenantId),
    refundId,
  );
  expect(settled.status).toBe("failed");
  expect(settled.failureReason).toBe(how);
}

/** Sets the refund `failed` for `reason` by SQL, then runs the failure hook. */
async function failOtherReason(refundId: string, reason: string) {
  await owner.query(
    `UPDATE payment_refunds SET status = 'failed', failure_reason = $3, decided_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, refundId, reason],
  );
  const context = tenantScope(w.tenant.tenantId);
  await withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.tenantId, context.tenant.tenantId),
          eq(paymentRefunds.id, refundId),
        ),
      );
    await refileRecoveryRefundAfterFailure(tx, context, row!, new Date());
  });
}

/** A paid order whose roti line failed and was resolved with a delivered, pending refund. */
async function deliveredRefund() {
  const paid = await w.paidOrder();
  const intentId = await intentIdOf(paid.order.id);
  const reported = await w.report(paid.roti.id);
  expect(reported.status).toBe(201);
  const issueId = reported.body.data.id as string;
  const resolved = await resolveRefund(issueId, PRICES.roti);
  expect(resolved.status).toBe(200);
  await deliverRecovery(await approvedEvent(issueId));
  const refunds = await issueRefunds(issueId);
  expect(refunds).toHaveLength(1);
  return { ...paid, intentId, issueId, first: refunds[0]! };
}

/** As `deliveredRefund`, then the refund is rejected. */
async function rejectedRefund() {
  const made = await deliveredRefund();
  await failChain(made.first.id, "rejected");
  return made;
}

const isReplay = (status: number) => status === 200 || status === 201;

describe("legend-wumm8 a rejected recovery refund can be reported again", () => {
  it("RR-1 after the refund is rejected, reporting the same line again creates a new open issue (201, different id)", async () => {
    const { roti, issueId } = await rejectedRefund();

    const again = await w.report(roti.id);

    expect(again.status).toBe(201);
    expect(again.body.data.id).not.toBe(issueId);
    expect(again.body.data.status).toBe("open");
    expect(await issuesOfItem(roti.id)).toHaveLength(2);
  });

  it("RR-2 the new issue resolves manual_refund with a new approval and gets its own refund, never a double refund", async () => {
    const { roti, intentId, issueId } = await rejectedRefund();
    const again = await w.report(roti.id);
    expect(again.status).toBe(201);
    const newIssueId = again.body.data.id as string;
    expect(newIssueId).not.toBe(issueId);

    const resolved = await resolveRefund(newIssueId, PRICES.roti);

    expect(resolved.status).toBe(200);
    const event = await approvedEvent(newIssueId);
    expect(event.name).toBe("order_issue.manual_refund_approved");
    await deliverRecovery(event);
    const refunds = await issueRefunds(newIssueId);
    expect(refunds, "a refund for the new issue").toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      amount_idr: ROTI_WANTED,
      status: "pending",
    });
    // The old refund stays rejected: only one of the two can ever pay out.
    expect(await issueRefunds(issueId)).toEqual([
      expect.objectContaining({ status: "failed", failure_reason: "rejected" }),
    ]);
    const live = [
      ...(await issueRefunds(issueId)),
      ...(await issueRefunds(newIssueId)),
    ].filter((refund) => refund.status !== "failed");
    expect(live.reduce((sum, refund) => sum + refund.amount_idr, 0)).toBe(
      ROTI_WANTED,
    );
    expect((await holdOf(intentId)).reserved).toBeLessThanOrEqual(ROTI_WANTED);
  });

  it("RR-3a before any rejection, reporting the same line again returns the old issue (replay)", async () => {
    const { roti, issueId } = await deliveredRefund();

    const again = await w.report(roti.id);

    expect(isReplay(again.status)).toBe(true);
    expect(again.body.data.id).toBe(issueId);
    expect(await issuesOfItem(roti.id)).toEqual([issueId]);
  });

  it("RR-3a2 a non-final failure (approval expired: re-filed) is not a rejection: reporting again still replays the old issue", async () => {
    const { roti, issueId, first } = await deliveredRefund();
    await failChain(first.id, "approval_expired");

    const again = await w.report(roti.id);

    expect(isReplay(again.status)).toBe(true);
    expect(again.body.data.id).toBe(issueId);
    expect(await issuesOfItem(roti.id)).toEqual([issueId]);
  });

  it("RR-3a3 a refund the provider declined is final too (legend-iu91r): reporting again creates a new open issue, like a rejection", async () => {
    const { roti, issueId, first } = await deliveredRefund();
    await failOtherReason(first.id, "provider_declined");

    const again = await w.report(roti.id);

    expect(again.status).toBe(201);
    expect(again.body.data.id).not.toBe(issueId);
    expect(await issuesOfItem(roti.id)).toHaveLength(2);
  });

  /** Inserts a second, open issue for the line by SQL (the API would replay). */
  async function forceOpenIssue(orderId: string, itemId: string) {
    const issueId = randomUUID();
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [w.tenant.tenantId],
      );
      await client.query(
        `INSERT INTO order_issues (id, tenant_id, outlet_id, order_id, order_item_id, type, reason,
           reason_note, reported_by, cost_idr, status, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, 'unfulfillable', 'out_of_stock', 'Dipaksa lewat SQL',
           $6, 0, 'open', $7)`,
        [
          issueId,
          w.tenant.tenantId,
          w.tenant.outletId,
          toUuid(orderId),
          toUuid(itemId),
          w.supervisor.userId,
          `forced-${randomUUID()}`,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return issueId;
  }

  it("RR-3b the old refund is still pending: a second issue on the same line cannot be resolved (409, Item ini sudah diselesaikan.)", async () => {
    const { order, roti, issueId } = await deliveredRefund();
    const forcedId = await forceOpenIssue(order.id, roti.id);

    const resolved = await resolveRefund(forcedId, PRICES.roti);

    // 1131: the order budget may refuse first (the pending refund already
    // holds the line's room): 422 REFUND_OVER_ORDER_ROOM; either way nothing
    // resolves and no second refund is filed.
    expect([409, 422]).toContain(resolved.status);
    expect(JSON.stringify(resolved.body)).toMatch(
      new RegExp(`${ALREADY_RESOLVED}|REFUND_OVER_ORDER_ROOM`),
    );
    expect(await issueRow(forcedId)).toMatchObject({
      status: "open",
      resolution: null,
    });
    expect(await issueRow(issueId)).toMatchObject({
      status: "resolved",
      resolution: "manual_refund",
    });
  });

  it("RR-3b2 the old refund failed with a final reason (provider_declined): the new issue on the same line resolves (200), like after a rejection", async () => {
    const { order, roti, first } = await deliveredRefund();
    await failOtherReason(first.id, "provider_declined");
    const forcedId = await forceOpenIssue(order.id, roti.id);

    const resolved = await resolveRefund(forcedId, PRICES.roti);

    expect(resolved.status).toBe(200);
    expect(await issueRow(forcedId)).toMatchObject({
      status: "resolved",
      resolution: "manual_refund",
    });
  });

  it("RR-3c reporting twice after a rejection makes only one new issue (the second report replays the open one)", async () => {
    const { roti, issueId } = await rejectedRefund();

    const second = await w.report(roti.id);
    const third = await w.report(roti.id);

    expect(second.status).toBe(201);
    expect(isReplay(third.status)).toBe(true);
    expect(third.body.data.id).toBe(second.body.data.id);
    expect(second.body.data.id).not.toBe(issueId);
    expect(await issuesOfItem(roti.id)).toHaveLength(2);
  });

  it("RR-4 the old issue is unchanged (resolved, manual_refund) and its refund_rejected audit stays after a new report", async () => {
    const { roti, issueId, first } = await rejectedRefund();
    expect(await auditCount(issueId, "order_issue.refund_rejected")).toBe(1);

    const again = await w.report(roti.id);
    expect(again.status).toBe(201);

    expect(await issueRow(issueId)).toEqual({
      status: "resolved",
      resolution: "manual_refund",
    });
    expect(await auditCount(issueId, "order_issue.refund_rejected")).toBe(1);
    expect(await issueRefunds(issueId)).toEqual([
      expect.objectContaining({
        id: first.id,
        status: "failed",
        failure_reason: "rejected",
      }),
    ]);
  });
});
