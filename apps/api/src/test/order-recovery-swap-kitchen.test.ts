// legend-zm1e6 / legend-v32bv, design decisions #3 and #4 of
// docs/briefs/sub-swap-kitchen.md: the `order_issue.resolved` consumer
// `deliverSwapKitchenEvent` (services/order-recovery-swap-kitchen.ts). Written
// before the service exists, so the whole file starts red (missing module).
//
// The resolve step (staff or guest) writes the outbox event; the worker is not
// running in tests, so each test delivers that real event by hand inside a
// tenant transaction, as worker-main.ts does.
//
// Assumptions where the brief is silent:
// - "Ignored" events (other tenant, other outlet, other resolution) make the
//   consumer resolve without throwing and change nothing.
// - Stations are wired in this file only: roti -> hot kitchen, kopi and teh ->
//   beverage bar, roti-lain -> no station. The paid order fires at payment, so
//   the old roti line already holds a ticket item before the swap (asserted).
// - A voided old kitchen item is a `kitchen_ticket_items` row with status
//   `voided` (the status enum has no other cancel state).
// - Audit row is found by the action name and the issue id in audit_logs.event.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
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
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import { PRICES, createWorld, type World } from "./order-recovery-helpers.ts";
import { createIsolatedTenant, owner } from "./floor-test-helpers.ts";

let w: World;
const stations = {
  hot: randomUUID(),
  bar: randomUUID(),
};

beforeAll(async () => {
  w = await createWorld();
  for (const [id, name, type] of [
    [stations.hot, "Dapur Swap Uji", "hot_kitchen"],
    [stations.bar, "Bar Swap Uji", "beverage_bar"],
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
/** API ids may be ULIDs; the database stores uuids. */
const toUuid = (id: string) => (UUID.test(id) ? id : ulidToUuid(id));

/** As the worker does: inside the consumption (tenant) transaction. */
async function deliver(
  event: EventEnvelope,
  tenantId: string = w.tenant.tenantId,
) {
  const context = contextOf(tenantId);
  return withTenant(db, context, (tx) =>
    deliverSwapKitchenEvent(context, event, tx),
  );
}

async function resolvedEvent(issueId: string): Promise<EventEnvelope> {
  const rows = await w.outboxRows("order_issue.resolved", issueId);
  expect(rows, "order_issue.resolved event in the outbox").toHaveLength(1);
  return rows[0]!.event;
}

type LineRow = {
  id: string;
  menu_item_id: string;
  name: string;
  quantity: number;
  unit_price_idr: number;
  modifiers_total_idr: number;
  line_total_idr: number;
  modifiers: unknown;
  fire_status: string;
  status: string;
  void_reason: string | null;
  voided_by: string | null;
  reserved_business_date: string;
};

async function orderLines(orderId: string): Promise<LineRow[]> {
  const { rows } = await owner.query<LineRow>(
    `SELECT id, menu_item_id, name, quantity, unit_price_idr::int AS unit_price_idr,
            modifiers_total_idr::int AS modifiers_total_idr,
            line_total_idr::int AS line_total_idr, modifiers, fire_status, status, void_reason, voided_by,
            reserved_business_date::text AS reserved_business_date
     FROM order_items WHERE tenant_id = $1 AND order_id = $2
     ORDER BY created_at, id`,
    [w.tenant.tenantId, toUuid(orderId)],
  );
  return rows;
}

async function orderMoney(orderId: string) {
  const { rows } = await owner.query<Record<string, unknown>>(
    `SELECT status, subtotal_idr, discount_idr, service_charge_idr, tax_idr,
            rounding_idr, total_idr
     FROM orders WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, toUuid(orderId)],
  );
  return rows[0]!;
}

async function paymentIntentCount() {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*) AS n FROM payment_intents WHERE tenant_id = $1",
    [w.tenant.tenantId],
  );
  return Number(rows[0]!.n);
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

async function replacementOf(issueId: string) {
  const { rows } = await owner.query<{
    replacement_order_item_id: string | null;
  }>(
    "SELECT replacement_order_item_id FROM order_issues WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, issueId],
  );
  return rows[0]!.replacement_order_item_id;
}

async function auditCount(
  issueId: string,
  action: string = "order_issue.swap_kitchen_applied",
) {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*) AS n FROM audit_logs
     WHERE tenant_id = $1 AND event::text LIKE $2 AND event::text LIKE $3`,
    [w.tenant.tenantId, `%${action}%`, `%${issueId}%`],
  );
  return Number(rows[0]!.n);
}

const swapAuditCount = (issueId: string) => auditCount(issueId);

/** The audit event of one action for one issue, as text, to read its fields. */
async function auditText(issueId: string, action: string) {
  const { rows } = await owner.query<{ t: string }>(
    `SELECT event::text AS t FROM audit_logs
     WHERE tenant_id = $1 AND event::text LIKE $2 AND event::text LIKE $3`,
    [w.tenant.tenantId, `%${action}%`, `%${issueId}%`],
  );
  expect(rows, `${action} audit row`).toHaveLength(1);
  return rows[0]!.t;
}

/** Today's counter of one menu item on one business date (0 without a row). */
async function dailyUsage(menuItemId: string, businessDate: string) {
  const { rows } = await owner.query<{ quantity: number }>(
    `SELECT quantity FROM menu_item_daily_usage
     WHERE tenant_id = $1 AND outlet_id = $2 AND menu_item_id = $3
       AND business_date = $4`,
    [w.tenant.tenantId, w.tenant.outletId, menuItemId, businessDate],
  );
  return rows[0]?.quantity ?? 0;
}

async function setOrderStatus(orderId: string, status: "completed" | "voided") {
  await owner.query(
    status === "voided"
      ? `UPDATE orders SET status = 'voided', voided_at = now(), void_reason = 'Batal di kasir'
         WHERE tenant_id = $1 AND id = $2`
      : `UPDATE orders SET status = 'completed' WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, toUuid(orderId)],
  );
}

/** A paid order whose roti failed and was swapped by the supervisor. */
async function staffSwap(
  replacementItemId: string,
  approvalRequestId?: string,
) {
  const paid = await w.paidOrder();
  const issueId = (await w.report(paid.roti.id)).body.data.id as string;
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

// ---- tests -----------------------------------------------------------------

describe("legend-zm1e6 swap menu menjadi lini baru di dapur", () => {
  it("swap staf: lini pengganti dibuat, lini lama void, tiket KDS pengganti sekali di stasiunnya", async () => {
    const { order, roti, issueId, event } = await staffSwap(w.ids.teh);
    const before = await orderLines(order.id);
    expect(before).toHaveLength(2);
    // Baseline: the failed roti already sits on a hot-kitchen ticket.
    const oldTicket = await ticketItems(toUuid(roti.id));
    expect(oldTicket).toEqual([
      { item_status: "queued", station_id: stations.hot },
    ]);
    const oldLine = before.find((line) => line.id === toUuid(roti.id))!;

    await deliver(event);

    const lines = await orderLines(order.id);
    expect(lines).toHaveLength(3);
    const replacement = lines.find((line) => line.menu_item_id === w.ids.teh)!;
    expect(replacement).toMatchObject({
      name: "Teh Tarik",
      quantity: oldLine.quantity,
      unit_price_idr: PRICES.teh,
      modifiers_total_idr: 0,
      line_total_idr: PRICES.teh * oldLine.quantity,
      modifiers: [],
      fire_status: "fired",
      status: "queued",
      reserved_business_date: oldLine.reserved_business_date,
    });
    expect(await replacementOf(issueId)).toBe(replacement.id);

    // Old line is voided with the swap reason, attributed to the staff actor.
    const voided = lines.find((line) => line.id === oldLine.id)!;
    expect(voided).toMatchObject({
      status: "voided",
      void_reason: "item_failed_swap",
      voided_by: w.supervisor.userId,
    });
    // The untouched kopi line stays as it was.
    const kopi = lines.find((line) => line.menu_item_id === w.ids.kopi)!;
    expect(kopi.status).toBe("queued");

    // Kitchen: old ticket item cancelled, one new ticket item on the bar.
    expect(await ticketItems(oldLine.id)).toEqual([
      { item_status: "voided", station_id: stations.hot },
    ]);
    expect(await ticketItems(replacement.id)).toEqual([
      { item_status: "queued", station_id: stations.bar },
    ]);
    expect(await swapAuditCount(issueId)).toBe(1);
  });

  it("swap tamu ke menu lebih murah: lini baru dan tiket sama seperti swap staf", async () => {
    const { guest, order, roti } = await w.paidOrder();
    const issueId = (await w.report(roti.id)).body.data.id as string;
    const chosen = await w.as(guest).choose(issueId, {
      choice: "swap",
      replacementItemId: w.ids.teh,
    });
    expect(chosen.status).toBe(200);

    await deliver(await resolvedEvent(issueId));

    const lines = await orderLines(order.id);
    const replacement = lines.find((line) => line.menu_item_id === w.ids.teh)!;
    expect(replacement).toMatchObject({
      status: "queued",
      fire_status: "fired",
      unit_price_idr: PRICES.teh,
    });
    expect(lines.find((line) => line.id === toUuid(roti.id))).toMatchObject({
      status: "voided",
      void_reason: "item_failed_swap",
    });
    expect(await ticketItems(replacement.id)).toHaveLength(1);
    expect(await replacementOf(issueId)).toBe(replacement.id);
  });

  it("event dobel (berurutan) tidak menggandakan lini, tiket, atau audit", async () => {
    const { order, issueId, event } = await staffSwap(w.ids.teh);

    await deliver(event);
    const afterFirst = await orderLines(order.id);
    const replacementId = await replacementOf(issueId);
    expect(replacementId).not.toBeNull();

    await deliver(event);
    await deliver(event);

    const lines = await orderLines(order.id);
    expect(lines).toHaveLength(3);
    expect(lines).toEqual(afterFirst);
    expect(await replacementOf(issueId)).toBe(replacementId);
    expect(await ticketItems(replacementId!)).toHaveLength(1);
    expect(await swapAuditCount(issueId)).toBe(1);
  });

  it("event dobel serentak tetap menghasilkan satu lini pengganti dan satu tiket", async () => {
    const { order, issueId, event } = await staffSwap(w.ids.teh);

    await Promise.all([deliver(event), deliver(event)]);

    const lines = await orderLines(order.id);
    expect(
      lines.filter((line) => line.menu_item_id === w.ids.teh),
    ).toHaveLength(1);
    const replacementId = await replacementOf(issueId);
    expect(replacementId).not.toBeNull();
    expect(await ticketItems(replacementId!)).toHaveLength(1);
    expect(await swapAuditCount(issueId)).toBe(1);
  });

  it("swap staf ke menu lebih mahal: tidak ada tagihan tambahan, total order dan pembayaran tetap", async () => {
    const paid = await w.paidOrder();
    const issueId = (await w.report(paid.roti.id)).body.data.id as string;
    const approvalId = await w.insertApproval({
      actionType: "price_correction",
      objectType: "order_issue",
      objectId: issueId,
      amountIdr: PRICES.kopi - PRICES.roti,
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
    const event = await resolvedEvent(issueId);
    const moneyBefore = await orderMoney(paid.order.id);
    const intentsBefore = await paymentIntentCount();

    await deliver(event);

    // The replacement line is priced from the catalog, kopi without modifiers.
    const lines = await orderLines(paid.order.id);
    const replacement = lines.find(
      (line) =>
        line.status === "queued" &&
        line.menu_item_id === w.ids.kopi &&
        line.id !== toUuid(paid.kopi.id),
    )!;
    expect(replacement).toMatchObject({
      unit_price_idr: PRICES.kopi,
      modifiers_total_idr: 0,
      line_total_idr: PRICES.kopi,
    });
    expect(await replacementOf(issueId)).toBe(replacement.id);
    // No extra charge: totals and payments are not recalculated.
    expect(await orderMoney(paid.order.id)).toEqual(moneyBefore);
    expect(await paymentIntentCount()).toBe(intentsBefore);
  });

  it("menu pengganti tanpa stasiun: lini dibuat, tidak ada tiket, tidak error", async () => {
    const { order, roti, issueId, event } = await staffSwap(w.ids.rotiLain);

    await expect(deliver(event)).resolves.not.toThrow();

    const lines = await orderLines(order.id);
    const replacement = lines.find(
      (line) => line.menu_item_id === w.ids.rotiLain,
    )!;
    expect(replacement).toMatchObject({
      status: "queued",
      fire_status: "fired",
      unit_price_idr: PRICES.rotiLain,
    });
    expect(await replacementOf(issueId)).toBe(replacement.id);
    expect(await ticketItems(replacement.id)).toHaveLength(0);
    // The old line is still voided and its ticket item cancelled.
    expect(lines.find((line) => line.id === toUuid(roti.id))!.status).toBe(
      "voided",
    );
    expect(await ticketItems(toUuid(roti.id))).toEqual([
      { item_status: "voided", station_id: stations.hot },
    ]);
  });
});

describe("legend-v32bv swap: batas harian, order final, dan penolakan tanpa dead-letter", () => {
  it("swap menyesuaikan batas harian: pengganti dipesan, lini lama dilepas", async () => {
    const { order, roti, event } = await staffSwap(w.ids.teh);
    const oldLine = (await orderLines(order.id)).find(
      (line) => line.id === toUuid(roti.id),
    )!;
    const date = oldLine.reserved_business_date;
    const rotiBefore = await dailyUsage(w.ids.roti, date);
    const tehBefore = await dailyUsage(w.ids.teh, date);
    expect(rotiBefore).toBeGreaterThanOrEqual(oldLine.quantity);

    await deliver(event);

    expect(await dailyUsage(w.ids.teh, date)).toBe(
      tehBefore + oldLine.quantity,
    );
    expect(await dailyUsage(w.ids.roti, date)).toBe(
      rotiBefore - oldLine.quantity,
    );
  });

  it("order completed: lini pengganti dibuat, lini lama tetap (kept_final_order), batas lama tidak dilepas", async () => {
    const { order, roti, issueId, event } = await staffSwap(w.ids.teh);
    const oldLine = (await orderLines(order.id)).find(
      (line) => line.id === toUuid(roti.id),
    )!;
    const date = oldLine.reserved_business_date;
    await setOrderStatus(order.id, "completed");
    const rotiBefore = await dailyUsage(w.ids.roti, date);
    const tehBefore = await dailyUsage(w.ids.teh, date);

    await deliver(event);

    const lines = await orderLines(order.id);
    expect(lines).toHaveLength(3);
    const replacement = lines.find((line) => line.menu_item_id === w.ids.teh)!;
    expect(replacement.status).toBe("queued");
    expect(await replacementOf(issueId)).toBe(replacement.id);
    expect(lines.find((line) => line.id === oldLine.id)!.status).toBe(
      oldLine.status,
    );
    expect(await dailyUsage(w.ids.teh, date)).toBe(
      tehBefore + oldLine.quantity,
    );
    expect(await dailyUsage(w.ids.roti, date)).toBe(rotiBefore);
    expect(await ticketItems(replacement.id)).toEqual([
      { item_status: "queued", station_id: stations.bar },
    ]);
    expect(
      await auditText(issueId, "order_issue.swap_kitchen_applied"),
    ).toContain("kept_final_order");
  });

  it("order voided: tidak ada lini, tiket, atau batas harian baru; hanya audit swap_kitchen_skipped", async () => {
    const { order, roti, issueId, event } = await staffSwap(w.ids.teh);
    const oldLine = (await orderLines(order.id)).find(
      (line) => line.id === toUuid(roti.id),
    )!;
    const date = oldLine.reserved_business_date;
    await setOrderStatus(order.id, "voided");
    const linesBefore = await orderLines(order.id);
    const rotiBefore = await dailyUsage(w.ids.roti, date);
    const tehBefore = await dailyUsage(w.ids.teh, date);

    await expect(deliver(event)).resolves.not.toThrow();

    expect(await orderLines(order.id)).toEqual(linesBefore);
    expect(await replacementOf(issueId)).toBeNull();
    expect(await dailyUsage(w.ids.teh, date)).toBe(tehBefore);
    expect(await dailyUsage(w.ids.roti, date)).toBe(rotiBefore);
    expect(await ticketItems(toUuid(roti.id))).toEqual([
      { item_status: "queued", station_id: stations.hot },
    ]);
    expect(await auditCount(issueId, "order_issue.swap_kitchen_skipped")).toBe(
      1,
    );
    expect(await swapAuditCount(issueId)).toBe(0);
  });

  it("menu pengganti di-86 setelah resolve: tidak throw, lini lama tetap, audit swap_kitchen_blocked", async () => {
    const { order, roti, issueId, event } = await staffSwap(w.ids.teh);
    const oldLine = (await orderLines(order.id)).find(
      (line) => line.id === toUuid(roti.id),
    )!;
    await owner.query(
      `INSERT INTO item_availability (id, tenant_id, outlet_id, menu_item_id, schedule, daily_limit, status)
       VALUES ($1, $2, $3, $4, '[]', NULL, 'sold_out')`,
      [randomUUID(), w.tenant.tenantId, w.tenant.outletId, w.ids.teh],
    );
    const linesBefore = await orderLines(order.id);
    const rotiBefore = await dailyUsage(
      w.ids.roti,
      oldLine.reserved_business_date,
    );
    const tehBefore = await dailyUsage(
      w.ids.teh,
      oldLine.reserved_business_date,
    );

    try {
      await expect(deliver(event)).resolves.not.toThrow();

      expect(await orderLines(order.id)).toEqual(linesBefore);
      expect(await replacementOf(issueId)).toBeNull();
      expect(await dailyUsage(w.ids.teh, oldLine.reserved_business_date)).toBe(
        tehBefore,
      );
      expect(await dailyUsage(w.ids.roti, oldLine.reserved_business_date)).toBe(
        rotiBefore,
      );
      expect(await ticketItems(toUuid(roti.id))).toEqual([
        { item_status: "queued", station_id: stations.hot },
      ]);
      expect(
        await auditCount(issueId, "order_issue.swap_kitchen_blocked"),
      ).toBe(1);
      expect(
        await auditText(issueId, "order_issue.swap_kitchen_blocked"),
      ).toContain("blockedReason");
      expect(await swapAuditCount(issueId)).toBe(0);
    } finally {
      await owner.query(
        "DELETE FROM item_availability WHERE tenant_id = $1 AND menu_item_id = $2",
        [w.tenant.tenantId, w.ids.teh],
      );
    }
  });

  it("batas harian penuh saat reservasi: tidak throw, lini lama tetap, audit swap_kitchen_blocked", async () => {
    const { order, roti, issueId, event } = await staffSwap(w.ids.teh);
    const oldLine = (await orderLines(order.id)).find(
      (line) => line.id === toUuid(roti.id),
    )!;
    // Pricing looks at today's counter, the reservation at the order's own
    // business date. Fill only the order's date so pricing still passes and the
    // reservation is the step that refuses.
    const orderDate = "2000-01-01";
    await owner.query(
      "UPDATE orders SET business_date = $3 WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, toUuid(order.id), orderDate],
    );
    await owner.query(
      `INSERT INTO item_availability (id, tenant_id, outlet_id, menu_item_id, schedule, daily_limit, status)
       VALUES ($1, $2, $3, $4, '[]', 1000, 'available')`,
      [randomUUID(), w.tenant.tenantId, w.tenant.outletId, w.ids.teh],
    );
    await owner.query(
      `INSERT INTO menu_item_daily_usage (tenant_id, outlet_id, menu_item_id, business_date, quantity)
       VALUES ($1, $2, $3, $4, 1000)`,
      [w.tenant.tenantId, w.tenant.outletId, w.ids.teh, orderDate],
    );
    const linesBefore = await orderLines(order.id);
    const rotiBefore = await dailyUsage(
      w.ids.roti,
      oldLine.reserved_business_date,
    );

    try {
      await expect(deliver(event)).resolves.not.toThrow();

      expect(await orderLines(order.id)).toEqual(linesBefore);
      expect(await replacementOf(issueId)).toBeNull();
      // Nothing reserved, nothing released.
      expect(await dailyUsage(w.ids.teh, orderDate)).toBe(1000);
      expect(await dailyUsage(w.ids.roti, oldLine.reserved_business_date)).toBe(
        rotiBefore,
      );
      expect(await ticketItems(toUuid(roti.id))).toEqual([
        { item_status: "queued", station_id: stations.hot },
      ]);
      expect(
        await auditCount(issueId, "order_issue.swap_kitchen_blocked"),
      ).toBe(1);
      expect(
        await auditText(issueId, "order_issue.swap_kitchen_blocked"),
      ).toContain("daily_limit");
      expect(await swapAuditCount(issueId)).toBe(0);
    } finally {
      await owner.query(
        "DELETE FROM menu_item_daily_usage WHERE tenant_id = $1 AND menu_item_id = $2 AND business_date = $3",
        [w.tenant.tenantId, w.ids.teh, orderDate],
      );
      await owner.query(
        "DELETE FROM item_availability WHERE tenant_id = $1 AND menu_item_id = $2",
        [w.tenant.tenantId, w.ids.teh],
      );
    }
  });
});

describe("legend-zm1e6 event yang bukan miliknya diabaikan", () => {
  async function untouched(orderId: string, issueId: string, expected: number) {
    expect(await orderLines(orderId)).toHaveLength(expected);
    expect(await replacementOf(issueId)).toBeNull();
    expect(await swapAuditCount(issueId)).toBe(0);
  }

  it("event dengan tenant lain, outlet lain, atau resolusi bukan swap tidak mengubah apa pun", async () => {
    const { order, issueId, event } = await staffSwap(w.ids.teh);
    const lineCount = (await orderLines(order.id)).length;

    // Event stamped with a foreign tenant id, delivered in this tenant's context.
    await deliver({ ...event, tenantId: randomUUID() } as EventEnvelope);
    await untouched(order.id, issueId, lineCount);

    // Same tenant, but the event names another outlet than the issue's.
    await deliver({ ...event, outletId: w.ids.otherOutlet } as EventEnvelope);
    await untouched(order.id, issueId, lineCount);

    // A different resolution on the same event name.
    await deliver({
      ...event,
      payload: { ...(event.payload as object), resolution: "voucher" },
    } as EventEnvelope);
    await untouched(order.id, issueId, lineCount);

    // Other event names are not this consumer's.
    await deliver({ ...event, name: "order_issue.opened" } as EventEnvelope);
    await untouched(order.id, issueId, lineCount);

    // None of that poisoned the real event: it still applies exactly once.
    await deliver(event);
    expect(await orderLines(order.id)).toHaveLength(lineCount + 1);
    expect(await replacementOf(issueId)).not.toBeNull();
  });

  it("event tenant ini yang diantar dalam konteks tenant lain tidak menyentuh data", async () => {
    const { order, issueId, event } = await staffSwap(w.ids.teh);
    const lineCount = (await orderLines(order.id)).length;
    const foreign = await createIsolatedTenant(
      `swp-${randomUUID().slice(0, 6)}`,
    );

    await deliver(event, foreign.tenantId);

    await untouched(order.id, issueId, lineCount);
  });
});
