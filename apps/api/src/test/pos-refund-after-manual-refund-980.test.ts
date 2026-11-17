// legend-980 (brief 980, proof 1 "no double refund: provider + ours + manual"):
// round 2 (restrictive, "jangan sampai rugi", founder to review): the POS
// refund and the manual refund of an order's lines are mutually exclusive per
// order. A manual refund pays the line's net share (service charge and PBJT
// included), so subtracting its line total from the POS refund room let
// Rp15.500 extra out, and a line could be refunded once by POS items and once
// manually. Now:
// - a POS refund of an order with a live manual refund issue is refused (409),
// - a manual refund of an order with any POS refund is refused (409),
// - an issue whose refund was rejected, or that was cancelled, paid nothing and
//   blocks neither,
// round 3:
// - the cash void is refused too (a void is a refund),
// - only manual refunds of the approval route (`approval_request_id` NULL)
//   count: an ORD-09 failed-item manual issue (approval_request_id set) sends
//   the guest to the cashier, so it blocks neither the POS refund nor the void.
//
// Real PostgreSQL and the refund service; physical EDC tender avoids a fake
// cash drawer or provider. Seeding follows pos-refund-ceilings.test.ts (rows
// written as owner, FKs to user and menu skipped like the accounting refund
// tests do for order issues).
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/pos-refund-after-manual-refund-980.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { posOverrideIdSchema } from "@starter/shared/access/override";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { manualRefundAmountIdr } from "../services/order-issue-manual-refund";
import {
  refundPosOrder,
  voidPosOrderCorrection,
} from "../services/pos-order-corrections";
import { agent, signUp } from "./helpers";
import {
  owner,
  seededOutletA,
  seededTenantId,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers";
import { pinOverrideFixtureFingerprint } from "./pos-override-fixture";

type Sale = { orderId: string; paid: number; itemId: string };
type IssueState = "live" | "rejected" | "cancelled";
// route: made by the approval route (no approval_request_id); ord09: a
// failed-item manual issue, which stores the approval request it consumed.
type IssueOrigin = "route" | "ord09";

const app = createApp();
const users: string[] = [];
const orderUuids: string[] = [];
const overrideUuids: string[] = [];
let cashier: Staff;
let approverId: string;

const scope = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(seededTenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

async function asOwner<T>(
  run: (client: PoolClient) => Promise<T>,
  replica = false,
) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    if (replica)
      await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [seededTenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * A completed POS sale (exclusive prices): one line of `lineTotal`, `service`
 * charge and `tax` (PBJT) on top, fully paid by one EDC card tender.
 */
async function sale(lineTotal: number, service = 0, tax = 0): Promise<Sale> {
  const paid = lineTotal + service + tax;
  const orderId = createUlid();
  const orderUuid = ulidToUuid(orderId);
  const itemId = randomUUID();
  orderUuids.push(orderUuid);
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type,
         payment_mode, subtotal_idr, discount_idr, service_charge_idr, tax_idr,
         rounding_idr, total_idr, status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, 0, $6, $7, 0, $8,
         'completed', '2031-03-16', now())`,
      [
        orderUuid,
        seededTenantId,
        seededOutletA,
        `M980-${orderId.slice(-22)}`,
        lineTotal,
        service,
        tax,
        paid,
      ],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at, completed_at)
       VALUES ($1, $2, $3, 'pos', now(), now())`,
      [orderUuid, seededTenantId, seededOutletA],
    );
    await client.query(
      `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider,
         amount_idr, status, reference, requested_at, resolved_at)
       VALUES ($1, $2, $3, 'edc_card', 'edc', $4, 'captured', $5, now(), now())`,
      [seededTenantId, seededOutletA, orderUuid, paid, `BANK-${orderId}`],
    );
    // The line points at a random menu item: skip that FK (this write only).
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, variant_id, name,
         quantity, unit_price_idr, modifiers_total_idr, line_total_idr, modifiers,
         fire_status, status, reserved_business_date)
       VALUES ($1, $2, $3, $4, $5, NULL, 'Roti Bakar', 1, $6, 0, $6, '[]'::jsonb,
         'fired', 'served', '2031-03-16')`,
      [
        itemId,
        seededTenantId,
        seededOutletA,
        orderUuid,
        randomUUID(),
        lineTotal,
      ],
    );
  });
  return { orderId, paid, itemId };
}

/** A manual refund issue on the sale's line (resolution manual_refund). */
async function manualRefund(
  bill: Sale,
  state: IssueState = "live",
  origin: IssueOrigin = "route",
): Promise<void> {
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO order_issues (id, tenant_id, outlet_id, order_id, order_item_id, type, reason,
         reason_note, reported_by, resolution, approved_by, cost_idr, status,
         idempotency_key, resolved_at, refund_rejected_at, approval_request_id)
       VALUES ($1, $2, $3, $4, $5, 'unfulfillable', 'out_of_stock',
         'Roti habis, refund manual disetujui', $6, 'manual_refund', $7, 0, $8,
         $9, $10, $11, $12)`,
      [
        randomUUID(),
        seededTenantId,
        seededOutletA,
        ulidToUuid(bill.orderId),
        bill.itemId,
        randomUUID(),
        randomUUID(),
        state === "cancelled" ? "cancelled" : "resolved",
        randomUUID(),
        state === "cancelled" ? null : new Date(),
        state === "rejected" ? new Date() : null,
        origin === "ord09" ? randomUUID() : null,
      ],
    );
  }, true);
}

async function approval(
  bill: Sale,
  amountIdr: number,
  action: "refund" | "void" = "refund",
) {
  const overrideId = createUlid();
  overrideUuids.push(ulidToUuid(overrideId));
  const reason = "Pengembalian setelah refund manual";
  await asOwner((client) =>
    client.query(
      `INSERT INTO pos_overrides (id, tenant_id, outlet_id, action, method, status,
       requested_by, approved_by, reason, value_idr, object_type, object_id,
       request_fingerprint, created_at, resolved_at)
     VALUES ($1, $2, $3, $10, 'supervisor_pin', 'approved', $4, $5, $6,
       $7, 'order', $8, $9, now(), now())`,
      [
        ulidToUuid(overrideId),
        seededTenantId,
        seededOutletA,
        cashier.userId,
        approverId,
        reason,
        amountIdr,
        bill.orderId,
        pinOverrideFixtureFingerprint({
          requestedBy: cashier.userId,
          outletId: seededOutletA,
          action,
          valueIdr: amountIdr,
          reason,
          objectType: "order",
          objectId: bill.orderId,
          approverUserId: approverId,
        }),
        action,
      ],
    ),
  );
  return {
    overrideId: posOverrideIdSchema.parse(overrideId),
    approvedBy: userIdSchema.parse(approverId),
  };
}

async function refund(bill: Sale, amountIdr: number) {
  const verified = await approval(bill, amountIdr);
  return refundPosOrder(
    scope(),
    {
      userId: userIdSchema.parse(cashier.userId),
      deviceId: null,
      expectedVersion: null,
    },
    outletIdSchema.parse(seededOutletA),
    bill.orderId,
    {
      idempotencyKey: randomUUID(),
      amountIdr,
      reason: "quality_complaint",
      reasonNote: "Pengembalian setelah refund manual",
      ...verified,
    },
  );
}

/** A cash void of the sale, with an approval for its whole total. */
async function voidSale(bill: Sale) {
  const verified = await approval(bill, bill.paid, "void");
  return voidPosOrderCorrection(
    scope(),
    {
      userId: userIdSchema.parse(cashier.userId),
      deviceId: null,
      expectedVersion: null,
    },
    outletIdSchema.parse(seededOutletA),
    bill.orderId,
    {
      idempotencyKey: randomUUID(),
      reason: "customer_cancelled",
      reasonNote: "Void setelah refund manual",
      ...verified,
    },
  );
}

async function approvalUses(bill: Sale) {
  const result = await owner.query<{ total: string }>(
    "SELECT count(*)::text AS total FROM pos_order_approval_uses WHERE tenant_id = $1 AND order_id = $2",
    [seededTenantId, ulidToUuid(bill.orderId)],
  );
  return Number(result.rows[0]!.total);
}

/** What `manualRefundAmountIdr` allows for the sale's line; throws when refused. */
function manualRefundOf(bill: Sale, lineTotalIdr: number): Promise<number> {
  const context = scope();
  return withTenant(db, context, (tx) =>
    manualRefundAmountIdr(tx, context, bill.orderId, {
      lineTotalIdr,
      voided: false,
    }),
  );
}

async function nativeTotal(bill: Sale) {
  const result = await owner.query<{ total: string }>(
    "SELECT coalesce(sum(amount_idr), 0)::text AS total FROM pos_order_refunds WHERE tenant_id = $1 AND order_id = $2",
    [seededTenantId, ulidToUuid(bill.orderId)],
  );
  return Number(result.rows[0]!.total);
}

beforeAll(async () => {
  cashier = await staffWithRole(app, {
    template: "cashier",
    label: "M980 POS cashier",
  });
  users.push(cashier.userId);
  const client = agent(app);
  await signUp(client, "M980 POS owner");
  const session = await client.get("/api/auth/get-session");
  approverId = session.body.user.id as string;
  users.push(approverId);
  const roles = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'owner'",
    [seededTenantId],
  );
  if (!roles.rows[0]) throw new Error("Missing role owner");
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
    [seededTenantId, approverId, roles.rows[0].id],
  );
});

afterAll(async () => {
  await asOwner(async (client) => {
    for (const table of [
      "order_issues",
      "order_items",
      "pos_order_refunds",
      "pos_order_tenders",
      "pos_order_approval_uses",
      "order_events",
      "pos_orders",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])`,
        [seededTenantId, orderUuids],
      );
    await client.query("DELETE FROM pos_overrides WHERE id = ANY($1::uuid[])", [
      overrideUuids,
    ]);
    await client.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [
      orderUuids,
    ]);
    await client.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [seededTenantId, users],
    );
  }, true);
  await owner.end();
});

const LINE = 100_000;
const SERVICE = 5_000;
const PBJT = 10_500;

describe("legend-980 POS refund and manual refund are exclusive per order", () => {
  it("refuses a POS refund of a paid order with service and PBJT once a manual refund exists; the old cap let Rp15.500 out", async () => {
    const bill = await sale(LINE, SERVICE, PBJT);
    expect(bill.paid).toBe(115_500);
    await manualRefund(bill);
    // The manual refund of the line pays Rp115.500 (line + service + PBJT).
    // Every POS amount is refused, including the Rp15.500 the old line-total
    // cap would have let through.
    for (const amount of [15_500, 1, 115_500])
      await expect(refund(bill, amount)).rejects.toMatchObject({
        status: 409,
        code: "REFUND_MANUAL_REFUND_EXISTS",
      });
    expect(await nativeTotal(bill)).toBe(0);
  });

  it("refuses a manual refund of an order that already has a POS refund; nothing is approved", async () => {
    const bill = await sale(LINE, SERVICE, PBJT);
    const posRefund = await refund(bill, 10_000);
    expect(Number(posRefund.amountIdr)).toBe(10_000);
    await expect(manualRefundOf(bill, LINE)).rejects.toMatchObject({
      status: 409,
      code: "REFUND_CONFLICT",
    });
    expect(await nativeTotal(bill)).toBe(10_000);
  });

  it("control: the same order without a POS refund may be refunded manually, line + service + PBJT", async () => {
    const bill = await sale(LINE, SERVICE, PBJT);
    expect(await manualRefundOf(bill, LINE)).toBe(115_500);
  });

  it("a manual refund that was rejected paid nothing, so the POS refund may return the whole sale", async () => {
    const bill = await sale(LINE, SERVICE, PBJT);
    await manualRefund(bill, "rejected");
    const result = await refund(bill, 115_500);
    expect(Number(result.amountIdr)).toBe(115_500);
    expect(await nativeTotal(bill)).toBe(115_500);
  });

  it("a cancelled manual refund issue paid nothing and does not block the POS refund", async () => {
    const bill = await sale(LINE, SERVICE, PBJT);
    await manualRefund(bill, "cancelled");
    const result = await refund(bill, 115_500);
    expect(Number(result.amountIdr)).toBe(115_500);
    expect(await nativeTotal(bill)).toBe(115_500);
  });

  it("an ORD-09 failed-item manual issue (approval request set) does not block the POS refund; the cashier refunds it", async () => {
    const bill = await sale(LINE, SERVICE, PBJT);
    await manualRefund(bill, "live", "ord09");
    const result = await refund(bill, 115_500);
    expect(Number(result.amountIdr)).toBe(115_500);
    expect(await nativeTotal(bill)).toBe(115_500);
  });

  it("a manual refund of the approval route blocks the cash void; the approval stays unused", async () => {
    const bill = await sale(LINE, SERVICE, PBJT);
    await manualRefund(bill, "live", "route");
    await expect(voidSale(bill)).rejects.toMatchObject({
      status: 409,
      code: "REFUND_MANUAL_REFUND_EXISTS",
    });
    expect(await approvalUses(bill)).toBe(0);
  });

  it("an ORD-09 manual issue does not block the void guard (the void stops later, for its own reasons)", async () => {
    const bill = await sale(LINE, SERVICE, PBJT);
    await manualRefund(bill, "live", "ord09");
    const error = await voidSale(bill).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).not.toBeNull();
    expect(error).not.toMatchObject({ code: "REFUND_MANUAL_REFUND_EXISTS" });
  });

  it("an ORD-09 manual issue is not counted in the route refund base: the amount is the plain net share, line + service + PBJT", async () => {
    const bill = await sale(LINE, SERVICE, PBJT);
    await manualRefund(bill, "live", "ord09");
    expect(await manualRefundOf(bill, LINE)).toBe(115_500);
  });

  it("a manual refund of another sale does not block this sale's POS refund", async () => {
    const bill = await sale(LINE, SERVICE, PBJT);
    const other = await sale(LINE, SERVICE, PBJT);
    await manualRefund(other);
    const result = await refund(bill, 115_500);
    expect(Number(result.amountIdr)).toBe(115_500);
    expect(await nativeTotal(other)).toBe(0);
  });
});
