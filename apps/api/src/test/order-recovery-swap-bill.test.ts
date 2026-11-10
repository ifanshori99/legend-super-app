// pc51h: GET /api/table-sessions/:sessionId/bill must answer 200 after a staff swap
// of a failed item has been delivered (the `order_issue.resolved` consumer
// added a replacement line and voided the old one). Red test: the bill
// currently answers 422 after the swap.
//
// Assumptions where the brief is silent:
// - The sessionId in the path is the table session id of the seated guest
//   (`guest.sessionId` from `seat()`), the same id used by the guest cart/order
//   routes; the bearer token is `guest.token`.
// - "Pricier replacement" = kopi (25.000) for a failed roti (18.000), with an
//   approved `price_correction` approval as in order-recovery-swap-kitchen.
// - Bill totals mean `body.data.totals.subtotalIdr/totalIdr`; they must equal
//   the order's subtotal_idr/total_idr from before the swap (the swap adds no
//   extra charge and no refund to the bill).
// - Stations are wired like order-recovery-swap-kitchen.test.ts so the real
//   consumer runs the same path.

import { randomUUID } from "node:crypto";
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
import { withTenant } from "../db/tenant.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import { agent } from "./helpers.ts";
import { PRICES, createWorld, type World } from "./order-recovery-helpers.ts";
import { owner } from "./floor-test-helpers.ts";

let w: World;
const stations = { hot: randomUUID(), bar: randomUUID() };

beforeAll(async () => {
  w = await createWorld();
  for (const [id, name, type] of [
    [stations.hot, "Dapur Bill Uji", "hot_kitchen"],
    [stations.bar, "Bar Bill Uji", "beverage_bar"],
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

/** A paid order whose roti failed and was swapped by the supervisor. */
async function staffSwap(
  replacementItemId: string,
  options: { pricier?: boolean } = {},
) {
  const paid = await w.paidOrder();
  const issueId = (await w.report(paid.roti.id)).body.data.id as string;
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
  expect(resolved.status).toBe(200);
  return { ...paid, issueId, event: await resolvedEvent(issueId) };
}

function getBill(sessionId: string, token: string) {
  return agent(w.app)
    .get(`/api/table-sessions/${sessionId}/bill`)
    .set("Host", w.tenant.hostname)
    .set("Authorization", `Bearer ${token}`);
}

async function expectBillAfterSwap(replacementItemId: string, pricier = false) {
  const { order, guest, event } = await staffSwap(replacementItemId, {
    pricier,
  });
  const moneyBefore = await orderMoney(order.id);

  await deliver(event);

  const bill = await getBill(guest.sessionId, guest.token);
  // Print the exact body on failure (the 422 message is the point of this test).
  expect(bill.status, JSON.stringify(bill.body)).toBe(200);
  const totals = bill.body.data.totals;
  expect(totals.subtotalIdr).toBe(moneyBefore.subtotal_idr);
  expect(totals.totalIdr).toBe(moneyBefore.total_idr);
}

// ---- tests -----------------------------------------------------------------

describe("pc51h tagihan setelah swap staf", () => {
  it("pengganti lebih mahal: tagihan 200, subtotal dan total sama seperti sebelum swap", async () => {
    await expectBillAfterSwap(w.ids.kopi, true);
  });

  it("pengganti lebih murah: tagihan 200, subtotal dan total sama seperti sebelum swap", async () => {
    await expectBillAfterSwap(w.ids.teh);
  });

  it("pengganti harga sama: tagihan 200, subtotal dan total sama seperti sebelum swap", async () => {
    await expectBillAfterSwap(w.ids.rotiLain);
  });
});
