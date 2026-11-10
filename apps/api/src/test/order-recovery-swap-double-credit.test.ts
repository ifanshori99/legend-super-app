// Swap to a CHEAPER menu must credit the price difference exactly once.
//
// Worry (architect): if the open order's total were recomputed from its lines
// before payment, a cheaper swap would credit twice: the cheaper replacement
// line (replacement price billed) plus the voucher for the difference.
//
// Why it is not so (pinned here as a regression test):
// - A swap needs a PAID order (`assertRecoverable`): QR `pay_first` once sent,
//   or `open_bill` once an intent exists or the order is completed. POS orders
//   are `open_bill` and carry no `orders.payment_intent_id`, so a POS swap only
//   happens on a completed order (replacement at Rp0, old line kept).
// - Nothing re-totals a QR order from its lines: payment links and intents bill
//   `orders.total_idr`, frozen at checkout. The swap consumer states the same
//   ("order totals and payments are NOT recalculated"). Splitting part of an
//   order out compares the live line sum with `orders.subtotal_idr` and refuses
//   when they differ (table-session-operations `splitOrder`).
// So the guest paid the old total, and the voucher gives back the difference.

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
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import { PRICES, createWorld, type World } from "./order-recovery-helpers.ts";
import { owner } from "./floor-test-helpers.ts";

let w: World;

beforeAll(async () => {
  w = await createWorld();
}, 120_000);

afterAll(async () => {
  await w.teardown();
});

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

/** As the worker does: deliver the real outbox event in a tenant transaction. */
async function deliverResolved(issueId: string) {
  const rows = await w.outboxRows("order_issue.resolved", issueId);
  expect(rows).toHaveLength(1);
  const context = contextOf(w.tenant.tenantId);
  await withTenant(db, context, (tx) =>
    deliverSwapKitchenEvent(context, rows[0]!.event, tx),
  );
}

async function orderMoney(orderId: string) {
  const { rows } = await owner.query<{
    status: string;
    subtotal_idr: string;
    total_idr: string;
  }>(
    "SELECT status, subtotal_idr, total_idr FROM orders WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, ulidToUuid(orderId)],
  );
  return {
    status: rows[0]!.status,
    subtotal: Number(rows[0]!.subtotal_idr),
    total: Number(rows[0]!.total_idr),
  };
}

async function lines(orderId: string) {
  const { rows } = await owner.query<{
    menu_item_id: string;
    status: string;
    line_total_idr: string;
  }>(
    "SELECT menu_item_id, status, line_total_idr FROM order_items WHERE tenant_id = $1 AND order_id = $2",
    [w.tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows.map((row) => ({
    menuItemId: row.menu_item_id,
    status: row.status,
    lineTotal: Number(row.line_total_idr),
  }));
}

async function paidThroughIntent(orderId: string) {
  const { rows } = await owner.query<{ total_idr: string; paid_idr: string }>(
    `SELECT l.total_idr, l.paid_idr FROM payment_links l
     JOIN orders o ON o.tenant_id = l.tenant_id AND o.payment_link_id = l.id
     WHERE o.tenant_id = $1 AND o.id = $2`,
    [w.tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows[0]
    ? { total: Number(rows[0].total_idr), paid: Number(rows[0].paid_idr) }
    : null;
}

async function voucherValues(issueId: string) {
  const { rows } = await owner.query<{ value_idr: string }>(
    `SELECT v.value_idr FROM vouchers v
     JOIN apology_vouchers a ON a.voucher_id = v.id AND a.tenant_id = v.tenant_id
     WHERE a.tenant_id = $1 AND a.order_issue_id = $2`,
    [w.tenant.tenantId, issueId],
  );
  return rows.map((row) => Number(row.value_idr));
}

describe("swap ke menu lebih murah: kredit selisih tepat sekali", () => {
  it("pesanan QR terbuka (sent, sudah dibayar): total tagihan tetap, lini murah + voucher selisih = harga lama, tidak ganda", async () => {
    const paid = await w.paidOrder();
    const before = await orderMoney(paid.order.id);
    expect(before.status).toBe("sent");
    const credit = PRICES.roti - PRICES.teh;
    expect(credit).toBeGreaterThan(0);

    const issueId = (await w.report(paid.roti.id)).body.data.id as string;
    const chosen = await w.as(paid.guest).choose(issueId, {
      choice: "swap",
      replacementItemId: w.ids.teh,
    });
    expect(chosen.status).toBe(200);
    expect(chosen.body.data.priceDifferenceIdr).toBe(-credit);
    await deliverResolved(issueId);

    // Billing: the order total and the payment are what the guest paid, untouched.
    expect(await orderMoney(paid.order.id)).toEqual(before);
    const link = await paidThroughIntent(paid.order.id);
    if (link !== null)
      expect(link).toEqual({ total: before.total, paid: before.total });

    // Lines: the old roti is void, the teh line carries the replacement price.
    const all = await lines(paid.order.id);
    const oldRoti = all.find(
      (l) => l.menuItemId === w.ids.roti && l.status === "voided",
    );
    const teh = all.find((l) => l.menuItemId === w.ids.teh);
    expect(oldRoti?.lineTotal).toBe(PRICES.roti);
    expect(teh?.lineTotal).toBe(PRICES.teh);

    // Exactly one credit: voucher = old line - new line. Live lines plus the
    // voucher equal the subtotal the guest paid for. A second credit (a total
    // lowered by the difference as well) would break this equation.
    const vouchers = await voucherValues(issueId);
    expect(vouchers).toEqual([credit]);
    const liveSum = all
      .filter((l) => l.status !== "voided")
      .reduce((sum, l) => sum + l.lineTotal, 0);
    expect(liveSum + vouchers[0]!).toBe(before.subtotal);
  });

  it("pesanan selesai (completed): lini pengganti Rp0, lini lama tetap bernilai, voucher selisih sekali", async () => {
    const paid = await w.paidOrder();
    await owner.query(
      "UPDATE orders SET status = 'completed' WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, ulidToUuid(paid.order.id)],
    );
    const before = await orderMoney(paid.order.id);
    const credit = PRICES.roti - PRICES.teh;

    const issueId = (await w.report(paid.roti.id)).body.data.id as string;
    const chosen = await w.as(paid.guest).choose(issueId, {
      choice: "swap",
      replacementItemId: w.ids.teh,
    });
    expect(chosen.status).toBe(200);
    await deliverResolved(issueId);

    expect(await orderMoney(paid.order.id)).toEqual(before);
    const all = await lines(paid.order.id);
    expect(all.find((l) => l.menuItemId === w.ids.roti)?.status).not.toBe(
      "voided",
    );
    expect(all.find((l) => l.menuItemId === w.ids.teh)?.lineTotal).toBe(0);
    expect(await voucherValues(issueId)).toEqual([credit]);
  });

  it("pesanan open_bill belum dibayar: swap ditolak, tidak ada voucher", async () => {
    const open = await w.openBillOrder();
    const reported = await w.report(open.roti.id);
    // Whether the report is refused first or the resolve is, no credit exists.
    if (reported.status === 201 || reported.status === 200) {
      const issueId = reported.body.data.id as string;
      const chosen = await w.as(open.guest).choose(issueId, {
        choice: "swap",
        replacementItemId: w.ids.teh,
      });
      expect(chosen.status).toBeGreaterThanOrEqual(400);
      expect(await voucherValues(issueId)).toEqual([]);
    } else {
      expect(reported.status).toBeGreaterThanOrEqual(400);
    }
  });
});
