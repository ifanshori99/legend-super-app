// legend-980 round 3 (M4): a line that already has a live manual refund (any
// issue type) is paid back, so a new failed-item report or a swap on it would
// pay the guest a second time. A rejected or cancelled manual refund gave
// nothing back and does not block. Resolving a failed item by swap on a refunded
// line is refused and leaves the issue open.
//
// Real PostgreSQL through the recovery world (order-recovery-helpers.ts); the
// manual refund issue is written as owner, as the approval route leaves it
// (resolution manual_refund, approval_request_id NULL).
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/order-recovery-manual-refund-line-980.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import { originHeader } from "./helpers.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  asOwnerTenant,
  createWorld,
  type World,
} from "./order-recovery-helpers.ts";

let w: World;

beforeAll(async () => {
  w = await createWorld();
}, 120_000);

afterAll(async () => {
  await w.teardown();
});

type State = "live" | "rejected" | "cancelled";

/** A manual refund issue (type complaint) on the order line. */
async function manualRefund(
  orderUlid: string,
  itemUlid: string,
  state: State = "live",
  approvalRequestId: string | null = null,
) {
  await asOwnerTenant(w.tenant.tenantId, async (client) => {
    // reported_by and approved_by point at no real user: skip that FK here.
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO order_issues (id, tenant_id, outlet_id, order_id, order_item_id, type, reason,
       reason_note, reported_by, resolution, approved_by, cost_idr, status,
       idempotency_key, resolved_at, refund_rejected_at, approval_request_id)
     VALUES ($1, $2, $3, $4, $5, 'complaint', 'complaint',
       'Pelanggan kecewa, refund manual disetujui', $6, 'manual_refund', $7, 0, $8,
       $9, $10, $11, $12)`,
      [
        randomUUID(),
        w.tenant.tenantId,
        w.tenant.outletId,
        ulidToUuid(orderUlid),
        ulidToUuid(itemUlid),
        randomUUID(),
        randomUUID(),
        state === "cancelled" ? "cancelled" : "resolved",
        `m980-${randomUUID()}`,
        state === "cancelled" ? null : new Date(),
        state === "rejected" ? new Date() : null,
        approvalRequestId,
      ],
    );
  });
}

async function issuesOfItem(itemUlid: string) {
  const { rows } = await owner.query<{
    status: string;
    resolution: string | null;
  }>(
    "SELECT status, resolution FROM order_issues WHERE tenant_id = $1 AND order_item_id = $2",
    [w.tenant.tenantId, ulidToUuid(itemUlid)],
  );
  return rows;
}

describe("legend-980 a manually refunded line takes no second recovery", () => {
  it("refuses a failed-item report on a line with a live manual refund, whatever its origin; no issue written", async () => {
    for (const approvalRequestId of [null, randomUUID()]) {
      const paid = await w.paidOrder();
      await manualRefund(
        paid.order.id,
        paid.roti.id,
        "live",
        approvalRequestId,
      );
      const reported = await w.report(paid.roti.id);
      expect(reported.status).toBe(409);
      expect(await issuesOfItem(paid.roti.id)).toHaveLength(1);
    }
  });

  it("refuses a swap of a failed item whose line got a live manual refund meanwhile; the issue stays open", async () => {
    const paid = await w.paidOrder();
    const reported = await w.report(paid.roti.id);
    expect(reported.status).toBe(201);
    const issueId = reported.body.data.id as string;
    await manualRefund(paid.order.id, paid.roti.id);
    const swap = await w.staffPost(
      w.supervisor,
      `/api/order-issues/${issueId}/resolve`,
      { resolution: "swap", replacementItemId: w.ids.teh },
    );
    expect(swap.status).toBe(409);
    const { rows } = await owner.query<{ status: string }>(
      "SELECT status FROM order_issues WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, issueId],
    );
    expect(rows[0]!.status).toBe("open");
  });

  it("refuses a staff apology voucher on an open failed-item issue whose line got a live manual refund meanwhile; the issue stays open, no voucher", async () => {
    const paid = await w.paidOrder();
    const reported = await w.report(paid.roti.id);
    expect(reported.status).toBe(201);
    const issueId = reported.body.data.id as string;
    await manualRefund(paid.order.id, paid.roti.id);
    const voucher = await w.supervisor.client
      .post("/api/apology-vouchers")
      .set("Host", w.tenant.hostname)
      .set(originHeader)
      .send({
        valueIdr: 20_000,
        reason: "Roti habis, mohon maaf atas ketidaknyamanan",
        orderIssueId: issueId,
      });
    expect(voucher.status).toBe(409);
    const { rows } = await owner.query<{ status: string; vouchers: string }>(
      `SELECT i.status,
              (SELECT count(*) FROM apology_vouchers v
                WHERE v.tenant_id = i.tenant_id AND v.order_issue_id = i.id)::text AS vouchers
         FROM order_issues i WHERE i.tenant_id = $1 AND i.id = $2`,
      [w.tenant.tenantId, issueId],
    );
    expect(rows[0]).toEqual({ status: "open", vouchers: "0" });
  });

  it("control: a rejected or cancelled manual refund gave nothing back, so the line may be reported and swapped", async () => {
    for (const state of ["rejected", "cancelled"] as const) {
      const paid = await w.paidOrder();
      await manualRefund(paid.order.id, paid.roti.id, state);
      const reported = await w.report(paid.roti.id);
      expect(reported.status).toBe(201);
      const swap = await w.staffPost(
        w.supervisor,
        `/api/order-issues/${reported.body.data.id}/resolve`,
        { resolution: "swap", replacementItemId: w.ids.teh },
      );
      expect(swap.status).toBe(200);
    }
  });
});
