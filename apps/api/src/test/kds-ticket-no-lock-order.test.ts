// KDS ticket number lock order (bead legend-tzyj2, architect finding F2 of
// docs/briefs/sub-kds-station-save.md).
//
// Rule: the ticket-number lock (`lockKitchenTicketNo`) is taken BEFORE any
// station-feed lock. A POS fire takes ticket-no then feed. The swap consumer
// (order-recovery-swap-kitchen.ts) used to void the old kitchen item first
// (feed lock of the old station) and route the replacement after (ticket-no
// lock), the opposite order: two concurrent transactions in one outlet could
// deadlock (Postgres 40P01).
//
// Tests (same World as order-recovery-swap-kitchen.test.ts):
// - LOCK-ORDER-01 is deterministic: a "fire" transaction holds the ticket-no
//   lock and then, after a pause, the feed (cursor) row of the old station;
//   the swap is delivered in between. Before the fix this is a deadlock.
// - LOCK-ORDER-02 races real swaps against real fires (a paid QR order fires
//   its tickets at payment) in the same outlet over several rounds.
// Both assert: nobody fails with 40P01, the swap still voids the old ticket
// item and creates exactly one replacement ticket item, and ticket numbers of
// the business day stay distinct.

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { lockKitchenTicketNo } from "../services/kds.service.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import { createWorld, type World } from "./order-recovery-helpers.ts";
import { owner } from "./floor-test-helpers.ts";

let w: World;
const stations = {
  hot: randomUUID(),
  bar: randomUUID(),
};

beforeAll(async () => {
  w = await createWorld();
  for (const [id, name, type] of [
    [stations.hot, "Dapur Kunci Uji", "hot_kitchen"],
    [stations.bar, "Bar Kunci Uji", "beverage_bar"],
  ] as const)
    await owner.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, $4, $5)`,
      [id, w.tenant.tenantId, w.tenant.outletId, name, type],
    );
  for (const [menuItemId, stationId, stationType] of [
    [w.ids.roti, stations.hot, "hot_kitchen"],
    [w.ids.kopi, stations.bar, "beverage_bar"],
    [w.ids.teh, stations.bar, "beverage_bar"],
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

/** As the worker does: inside the consumption (tenant) transaction. */
async function deliver(event: EventEnvelope) {
  const context = contextOf(w.tenant.tenantId);
  return withTenant(db, context, (tx) =>
    deliverSwapKitchenEvent(context, event, tx),
  );
}

/** A paid order whose roti failed and was swapped to teh by the supervisor. */
async function staffSwap() {
  const paid = await w.paidOrder();
  const issueId = (await w.report(paid.roti.id)).body.data.id as string;
  const resolved = await w.staffPost(
    w.supervisor,
    `/api/order-issues/${issueId}/resolve`,
    { resolution: "swap", replacementItemId: w.ids.teh },
  );
  expect(resolved.status).toBe(200);
  const rows = await w.outboxRows("order_issue.resolved", issueId);
  expect(rows, "order_issue.resolved event in the outbox").toHaveLength(1);
  return { ...paid, issueId, event: rows[0]!.event };
}

async function ticketItems(orderItemId: string) {
  const { rows } = await owner.query<{
    item_status: string;
    station_id: string;
  }>(
    `SELECT kti.status AS item_status, kt.station_id
     FROM kitchen_ticket_items kti
     JOIN kitchen_tickets kt ON kt.tenant_id = kti.tenant_id AND kt.id = kti.ticket_id
     WHERE kti.tenant_id = $1 AND kti.order_item_id = $2`,
    [w.tenant.tenantId, orderItemId],
  );
  return rows;
}

async function replacementLineOf(issueId: string): Promise<string | null> {
  const { rows } = await owner.query<{ id: string | null }>(
    `SELECT replacement_order_item_id AS id FROM order_issues
     WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, toUuid(issueId)],
  );
  return rows[0]?.id ?? null;
}

/** The swap voided the old roti ticket item and routed one teh ticket item. */
async function expectSwapApplied(roti: { id: string }, issueId: string) {
  expect(await ticketItems(toUuid(roti.id))).toEqual([
    { item_status: "voided", station_id: stations.hot },
  ]);
  const replacementId = await replacementLineOf(issueId);
  expect(replacementId).not.toBeNull();
  expect(await ticketItems(replacementId!)).toEqual([
    { item_status: "queued", station_id: stations.bar },
  ]);
}

/** Business-day ticket numbers of the outlet are distinct. */
async function expectTicketNumbersDistinct() {
  const perDay = await owner.query<{
    business_date: string;
    ticket_no: number;
  }>(
    `SELECT business_date::text AS business_date, ticket_no FROM kitchen_tickets
     WHERE tenant_id = $1 AND outlet_id = $2`,
    [w.tenant.tenantId, w.tenant.outletId],
  );
  expect(perDay.rows.length).toBeGreaterThan(0);
  const keys = perDay.rows.map(
    (row) => `${row.business_date}:${row.ticket_no}`,
  );
  expect(new Set(keys).size).toBe(keys.length);
}

// ---- tests -----------------------------------------------------------------

describe("KDS ticket number lock order: swap against fire", () => {
  it("LOCK-ORDER-01 a fire that holds ticket-no and then the feed row never deadlocks with a swap", async () => {
    const { roti, issueId, event } = await staffSwap();
    const outletId = outletIdSchema.parse(w.tenant.outletId);
    const context = contextOf(w.tenant.tenantId);

    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let fireHoldsTicketNo: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      fireHoldsTicketNo = resolve;
    });

    // The fire: ticket-no lock first, then (as routing does) the feed row of
    // the hot station, which the swap's void of the old roti also locks.
    const fire = withTenant(db, context, async (tx) => {
      await lockKitchenTicketNo(tx, context, outletId, new Date());
      fireHoldsTicketNo();
      await gate;
      await tx.execute(
        sql`UPDATE kitchen_station_cursors SET updated_at = now()
            WHERE tenant_id = ${w.tenant.tenantId} AND station_id = ${stations.hot}`,
      );
    });
    await held;
    const swap = deliver(event);
    // Give the swap time to run up to its first wait (before the fix: to the
    // void of the old line, holding the feed row), then let the fire go on.
    await new Promise((resolve) => setTimeout(resolve, 600));
    releaseGate();

    const [fired, swapped] = await Promise.allSettled([fire, swap]);
    expect(fired.status, String(fired)).toBe("fulfilled");
    expect(swapped.status, String(swapped)).toBe("fulfilled");
    await expectSwapApplied(roti, issueId);
    await expectTicketNumbersDistinct();
  });

  it("LOCK-ORDER-02 swaps and paid-order fires racing in one outlet all succeed", async () => {
    // Prepared one by one (each is a paid order with its swap event), then
    // delivered at the same time as fresh paid orders fire their tickets.
    const prepared = [await staffSwap(), await staffSwap(), await staffSwap()];

    const results = await Promise.allSettled([
      ...prepared.map(({ event }) => deliver(event)),
      w.paidOrder(),
      w.paidOrder(),
      w.paidOrder(),
    ]);
    for (const result of results)
      expect(
        result.status,
        result.status === "rejected" ? String(result.reason) : "",
      ).toBe("fulfilled");
    for (const { roti, issueId } of prepared)
      await expectSwapApplied(roti, issueId);
    await expectTicketNumbersDistinct();
  }, 60_000);
});
