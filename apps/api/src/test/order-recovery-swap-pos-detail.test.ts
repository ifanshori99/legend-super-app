// legend-kxoyf: GET /api/outlets/:outletId/pos/orders/:orderId must answer 200
// after a staff swap of a failed item on a POS order has been delivered (the
// `order_issue.resolved` consumer added a replacement line and, unless the order
// is completed, voided the old one, leaving orders.subtotal_idr/total_idr
// frozen). Red test: the detail currently answers 422 VALIDATION_ERROR because
// posOrderDetailSchema requires subtotalIdr == sum(non-voided lines).
//
// Assumptions where the brief is silent:
// - A POS order is made through the createPosOrder service (dine_in, so it is
//   priced from the world's dine_in price list) and made "paid" by SQL
//   (status 'sent' + payment_mode 'pay_first'), which is what isPaidOrder
//   accepts. The completed case sets status 'completed' by SQL instead.
// - "Pricier replacement" = kopi (25.000) for a failed roti (18.000), with an
//   approved `price_correction` approval as in order-recovery-swap-kitchen.
// - Detail money: subtotalIdr/totalIdr must equal the order's values from
//   before the swap (the swap adds no charge and no refund to the order).
// - Swap fields (design kxoyf): swapReplacementIdr = line_total of the counted
//   replacement line; swapReplacedIdr = line_total of the voided swapped-out
//   line. On a completed order the old line stays live, so swapReplacedIdr is 0.
//   Observed: the consumer writes the completed-order replacement line at price
//   0 (kept_final_order), so swapReplacementIdr is read back from the DB line
//   rather than assumed to equal the menu price.
// - A completed order needs a captured tender equal to total_idr and a receipt
//   (posOrderDetailSchema rules); the test inserts a cash tender by SQL and
//   stubs the receipt port so those rules are not what fails.
// - Invariant checked on the response: sum(non-voided lines) - swapReplacementIdr
//   + swapReplacedIdr == subtotalIdr.
// - Negative case: corrupting orders.subtotal_idr (+1, and total_idr +1 because
//   the DB check orders_total_check forbids subtotal alone) on a POS order
//   without a swap still answers 422.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { createPosOrder as createPosOrderContract } from "@starter/shared/pos";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { createPosOrder } from "../services/pos-order.service.ts";
import { PRICES, createWorld, type World } from "./order-recovery-helpers.ts";
import { owner } from "./floor-test-helpers.ts";

let w: World;
const stations = { hot: randomUUID(), bar: randomUUID() };

// The detail looks up the order's receipt. Only orders registered here (the
// completed ones) have one; a completed sale must carry a receipt number.
const receiptOrders = new Set<string>();
const receiptPort = {
  async issueForSale() {
    throw new Error("not used");
  },
  async findForOrder(
    _tx: unknown,
    context: ScopedTenantContext,
    orderId: string,
  ) {
    if (!receiptOrders.has(toUuid(String(orderId)))) return null;
    return {
      id: randomUUID(),
      tenantId: context.tenant.tenantId,
      outletId: w.tenant.outletId,
      orderId,
      deviceId: randomUUID(),
      number: "TRN-000001",
      sequenceNumber: 1,
      status: "issued",
      issuedAt: new Date().toISOString(),
      voidedAt: null,
      voidReason: null,
      voidedBy: null,
      reprintCount: 0,
    };
  },
  async voidForOrder() {
    return null;
  },
} as unknown as PosReceiptPort;

beforeAll(async () => {
  w = await createWorld();
  setAuditWriter(coreAuditWriter);
  setPosReceiptPort(receiptPort);
  for (const [id, name, type] of [
    [stations.hot, "Dapur POS Uji", "hot_kitchen"],
    [stations.bar, "Bar POS Uji", "beverage_bar"],
  ] as const)
    await owner.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, $4, $5)`,
      [id, w.tenant.tenantId, w.tenant.outletId, name, type],
    );
  for (const [menuItemId, stationId, stationType] of [
    [w.ids.roti, stations.hot, "hot_kitchen"],
    [w.ids.kopi, stations.bar, "beverage_bar"],
    [w.ids.teh, stations.bar, "beverage_bar"],
    // rotiLain: deliberately no station.
  ] as const)
    await owner.query(
      `UPDATE menu_items SET station_id = $3, station_type = $4
       WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, menuItemId, stationId, stationType],
    );
}, 120_000);

afterAll(async () => {
  setPosReceiptPort(null);
  setAuditWriter(null);
  await w.teardown();
});

// ---- helpers ---------------------------------------------------------------

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toUuid = (id: string) => (UUID.test(id) ? id : ulidToUuid(id));

async function deliver(event: EventEnvelope) {
  const context = contextOf(w.tenant.tenantId);
  return withTenant(db, context, (tx) =>
    deliverSwapKitchenEvent(context, event, tx),
  );
}

async function resolvedEvent(issueId: string): Promise<EventEnvelope> {
  const rows = await w.outboxRows("order_issue.resolved", issueId);
  expect(rows, "order_issue.resolved event in the outbox").toHaveLength(1);
  return rows[0]!.event;
}

async function orderMoney(orderId: string) {
  const { rows } = await owner.query<{
    subtotal_idr: number;
    total_idr: number;
  }>(
    `SELECT subtotal_idr::int AS subtotal_idr, total_idr::int AS total_idr
     FROM orders WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, toUuid(orderId)],
  );
  return rows[0]!;
}

/** A POS dine-in order: roti x1 (18.000) + kopi x1 (25.000), made by the service. */
async function posOrder() {
  const input = createPosOrderContract.body.parse({
    idempotencyKey: randomUUID(),
    channel: "pos",
    serviceType: "dine_in",
    items: [
      { menuItemId: w.ids.roti, quantity: 1, modifierIds: [] },
      { menuItemId: w.ids.kopi, quantity: 1, modifierIds: [] },
    ],
  });
  const created = await createPosOrder(
    contextOf(w.tenant.tenantId),
    {
      userId: userIdSchema.parse(w.floorStaff.userId),
      deviceId: null,
      expectedVersion: null,
    },
    outletIdSchema.parse(w.tenant.outletId),
    input,
  );
  const orderId = created.id as string;
  const { rows } = await owner.query<{ id: string; menu_item_id: string }>(
    `SELECT id, menu_item_id FROM order_items
     WHERE tenant_id = $1 AND order_id = $2`,
    [w.tenant.tenantId, toUuid(orderId)],
  );
  const lineOf = (menuItemId: string) =>
    uuidToUlid(rows.find((row) => row.menu_item_id === menuItemId)!.id);
  return { orderId, rotiLineId: lineOf(w.ids.roti) };
}

/**
 * Marks the POS order paid (what isPaidOrder accepts) by SQL. Both states get a
 * captured cash tender for the full total (legend-eajpb: a swap credit is capped by
 * what the guest paid); a completed sale also gets a receipt, because the detail
 * schema requires both for a completed order.
 */
async function markPaid(orderId: string, status: "sent" | "completed") {
  await owner.query(
    `UPDATE orders SET status = $3, payment_mode = 'pay_first'
     WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, toUuid(orderId), status],
  );
  await owner.query(
    `INSERT INTO pos_order_tenders
       (tenant_id, outlet_id, order_id, method, provider, amount_idr, received_idr,
        change_idr, status, requested_at, resolved_at)
     SELECT tenant_id, outlet_id, id, 'cash', 'manual', total_idr, total_idr, 0,
            'captured', now(), now()
     FROM orders WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, toUuid(orderId)],
  );
  if (status !== "completed") return;
  receiptOrders.add(toUuid(orderId));
}

/** A paid POS order whose roti failed and was swapped by the supervisor. */
async function staffSwap(
  replacementItemId: string,
  options: { pricier?: boolean; status?: "sent" | "completed" } = {},
) {
  const order = await posOrder();
  await markPaid(order.orderId, options.status ?? "sent");
  const issueId = (await w.report(order.rotiLineId)).body.data.id as string;
  const approvalRequestId = options.pricier
    ? await w.insertApproval({
        actionType: "price_correction",
        objectType: "order_issue",
        objectId: issueId,
        amountIdr: PRICES.kopi - PRICES.roti,
        status: "approved",
        requestedBy: w.floorStaff.userId,
      })
    : undefined;
  const resolved = await w.staffPost(
    w.supervisor,
    `/api/order-issues/${issueId}/resolve`,
    {
      resolution: "swap",
      replacementItemId,
      ...(approvalRequestId === undefined ? {} : { approvalRequestId }),
    },
  );
  expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
  return { ...order, issueId, event: await resolvedEvent(issueId) };
}

async function lineTotalsOf(issueId: string) {
  const { rows } = await owner.query<{
    replacement: number;
    replaced: number;
    replacement_id: string;
    replaced_id: string;
  }>(
    `SELECT rep.line_total_idr::int AS replacement, old.line_total_idr::int AS replaced,
            rep.id AS replacement_id, old.id AS replaced_id
     FROM order_issues i
     JOIN order_items rep
       ON rep.tenant_id = i.tenant_id AND rep.id = i.replacement_order_item_id
     JOIN order_items old
       ON old.tenant_id = i.tenant_id AND old.id = i.order_item_id
     WHERE i.tenant_id = $1 AND i.id = $2`,
    [w.tenant.tenantId, toUuid(issueId)],
  );
  expect(rows, "replacement and old line of the swapped issue").toHaveLength(1);
  return rows[0]!;
}

function getDetail(orderId: string) {
  return w.staffGet(
    w.supervisor,
    `/api/outlets/${encodeURIComponent(w.tenant.outletId)}/pos/orders/${encodeURIComponent(orderId)}`,
  );
}

type DetailLine = {
  id: string;
  lineTotalIdr: number;
  unitPriceIdr: number;
  status: string;
  swapRole: string;
};

async function expectDetailAfterSwap(
  replacementItemId: string,
  options: { pricier?: boolean; status?: "sent" | "completed" } = {},
) {
  const { orderId, issueId, event } = await staffSwap(
    replacementItemId,
    options,
  );
  const moneyBefore = await orderMoney(orderId);

  await deliver(event);

  const detail = await getDetail(orderId);
  // Print the exact body on failure (the 422 message is the point of this test).
  expect(detail.status, JSON.stringify(detail.body)).toBe(200);
  const body = detail.body.data;
  expect(body.subtotalIdr).toBe(moneyBefore.subtotal_idr);
  expect(body.totalIdr).toBe(moneyBefore.total_idr);

  const totals = await lineTotalsOf(issueId);
  expect(body.swapReplacementIdr).toBe(totals.replacement);
  // A completed order keeps the old line live; an open one voids it.
  expect(body.swapReplacedIdr).toBe(
    options.status === "completed" ? 0 : totals.replaced,
  );
  // Per-item swapRole: the swapped-out line is "replaced" (voided on an open
  // order, still live on a completed one), the added line is "replacement",
  // every other line is "none".
  const items = body.items as DetailLine[];
  const roleOf = (id: string) =>
    items.find((item) => toUuid(item.id) === id)?.swapRole;
  expect(roleOf(totals.replacement_id)).toBe("replacement");
  expect(roleOf(totals.replaced_id)).toBe("replaced");
  expect(
    items.filter((item) => item.swapRole !== "none").map((i) => i.swapRole),
  ).toHaveLength(2);
  expect(
    items.find((item) => toUuid(item.id) === totals.replaced_id)!.status ===
      "voided",
  ).toBe(options.status !== "completed");
  if (options.status === "completed") {
    // Kept final order: the old line stays live and the replacement is free.
    expect(
      items.find((item) => toUuid(item.id) === totals.replacement_id)!
        .unitPriceIdr,
    ).toBe(0);
  }
  const counted = items
    .filter((item) => item.status !== "voided")
    .reduce((sum, item) => sum + item.lineTotalIdr, 0);
  expect(counted - body.swapReplacementIdr + body.swapReplacedIdr).toBe(
    body.subtotalIdr,
  );
}

// ---- tests -----------------------------------------------------------------

describe("legend-kxoyf detail pesanan POS setelah swap staf", () => {
  it("pengganti lebih mahal: detail 200, subtotal dan total sama seperti sebelum swap", async () => {
    await expectDetailAfterSwap(w.ids.kopi, { pricier: true });
  });

  it("pengganti lebih murah: detail 200, subtotal dan total sama seperti sebelum swap", async () => {
    await expectDetailAfterSwap(w.ids.teh);
  });

  it("pengganti harga sama: detail 200, subtotal dan total sama seperti sebelum swap", async () => {
    await expectDetailAfterSwap(w.ids.rotiLain);
  });

  it("pesanan completed, pengganti harga sama: lini lama tetap hidup, detail 200", async () => {
    await expectDetailAfterSwap(w.ids.rotiLain, { status: "completed" });
  });

  it("pesanan completed, pengganti lebih mahal: detail 200, subtotal dan total tidak berubah", async () => {
    await expectDetailAfterSwap(w.ids.kopi, {
      pricier: true,
      status: "completed",
    });
  });

  it("pesanan POS tanpa swap dengan subtotal salah (+1): detail tetap 422", async () => {
    const { orderId } = await posOrder();
    await markPaid(orderId, "sent");
    await owner.query(
      // total_idr moves with the subtotal only to satisfy the DB check
      // constraint orders_total_check; the line sum no longer matches.
      `UPDATE orders SET subtotal_idr = subtotal_idr + 1, total_idr = total_idr + 1
       WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, toUuid(orderId)],
    );

    const detail = await getDetail(orderId);
    expect(detail.status, JSON.stringify(detail.body)).not.toBe(200);
    expect(detail.status).toBe(422);
  });
});
